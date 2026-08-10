/**
 * Checkout start: hosted redirect and delegated payment handoff.
 */
import {
  MIKA_DELEGATED_PAYMENT_AUTHORIZATION_INPUT_HASH_METADATA_KEY,
  MIKA_DELEGATED_PAYMENT_TOKEN_METADATA_KEY,
  type MikaProviderAdapter,
} from "../../../provider";
import { omitUndefined } from "../../../internal/object";
import {
  cartWithCoupon,
  cartWithoutCoupon,
  couponDiscountAmount,
  createCheckoutAggregate,
  snapshotPrice,
} from "../../../model/builders";
import type { CheckoutLine, CouponSnapshot } from "../../../types/aggregates";
import type { CartDocument, CheckoutDocument } from "../../../types/documents";
import type { StockItemRecord } from "../../../types/operational";
import {
  createCheckoutSessionId,
  type CartId,
  type CheckoutSessionId,
  type CurrencyCode,
  type ISODateTime,
  type JsonObject,
  type MikaId,
  type ProviderName,
  type PurchaseMode,
} from "../../../types/primitives";
import type { MikaRequestContext } from "../../context";
import type {
  CartQuoteDTO,
  CartQuoteInput,
  CheckoutSessionDTO,
  MikaApiResult,
  StartCheckoutInput,
} from "../../types";
import { requireProviderFeature } from "../provider-dispatch";
import {
  apiFailure,
  checkoutEmpty,
  checkoutExpired,
  checkoutIdempotencyInProgress,
  checkoutIdempotencyInputMismatch,
  checkoutPersistenceFailed,
  emitBackendNotification,
  forbidden,
  invalidCart,
  observeBackendError,
  outOfStock,
  providerFailed,
  validationFailed,
} from "../errors";
import type { MikaApiFailure } from "../errors";
import { checkoutBelongsToContext } from "../identity";
import type { MikaBackendDependencies } from "../ports";
import {
  cartPriceUnavailable,
  couponRejectionMessage,
  couponSnapshotForSubtotal,
  createCartQuote,
  createDefaultCartQuote,
  findQuoteCart,
  selectCartPrice,
  siblingSellableQuantity,
  updateCartDocument,
  validateQuantityLimit,
} from "../quote";
import { defaultBackendCurrency, moneyDTO, safeRequestReturnPath } from "../shared";
import { createMikaStockLifecycleService } from "../stock-lifecycle";
import type { MikaStockLifecycleDependencies } from "../stock-lifecycle";
import { putCheckoutStatusToken } from "../tokens";
import {
  checkoutCancelTarget,
  checkoutCancelUrl,
  checkoutCustomMetadata,
  checkoutDocumentResult,
  checkoutDocumentStatus,
  checkoutExpiresAt,
  checkoutFailedMetadata,
  checkoutIdempotencyInputHash,
  checkoutIsExpired,
  checkoutLineToProviderLine,
  checkoutMetadata,
  checkoutPersistedCustomMetadata,
  checkoutStatusAllowsRedirect,
  checkoutStatusExpired,
  checkoutStoredIdempotencyInputHash,
  checkoutSuccessTarget,
  checkoutSuccessUrl,
} from "./helpers";
import { expireCheckoutDocument } from "./status";
import { delegatedPaymentProofHash, resolveCheckoutPreviewMode } from "./preview";

export type CheckoutStartLineResolution = {
  readonly line: CheckoutLine;
  readonly stock: StockItemRecord | null;
};

export type CheckoutStartResolution = {
  readonly cart: CartDocument | null;
  readonly cartVersion?: number;
  readonly currency: CurrencyCode;
  readonly mode: PurchaseMode;
  readonly coupon?: CouponSnapshot;
  readonly lines: readonly CheckoutStartLineResolution[];
};

function checkoutResolutionMatchesDefaultQuote(
  resolved: CheckoutStartResolution,
  quote: CartQuoteDTO,
): boolean {
  const subtotal = resolved.lines.reduce(
    (amount, resolution) => amount + resolution.line.item.unitAmount * resolution.line.quantity,
    0,
  );
  const discount = couponDiscountAmount(resolved.coupon, subtotal);
  if (
    quote.currency !== resolved.currency ||
    quote.subtotal.currency !== resolved.currency ||
    quote.subtotal.amount !== subtotal ||
    (quote.discount?.amount ?? 0) !== discount ||
    quote.total.currency !== resolved.currency ||
    quote.total.amount !== Math.max(0, subtotal - discount) ||
    quote.items.length !== resolved.lines.length
  ) {
    return false;
  }

  const quoteCoupon = quote.coupon;
  if (
    Boolean(quoteCoupon) !== Boolean(resolved.coupon) ||
    (resolved.coupon &&
      (quoteCoupon?.label !== resolved.coupon.label ||
        quoteCoupon?.providerCouponId !== resolved.coupon.providerRef?.priceId))
  ) {
    return false;
  }

  return quote.items.every((quoteLine, index) => {
    const line = resolved.lines[index]?.line;
    if (!line) return false;
    const subtotalAmount = line.item.unitAmount * line.quantity;

    return (
      quoteLine.lineId === line.cartLineId &&
      quoteLine.sellableId === line.item.sellableId &&
      quoteLine.priceId === line.item.priceId &&
      quoteLine.fulfillmentKind === line.item.fulfillmentKind &&
      quoteLine.title === line.item.titleSnapshot &&
      quoteLine.sku === line.item.sku &&
      JSON.stringify(quoteLine.variantOptions ?? []) ===
        JSON.stringify(line.item.variantOptions ?? []) &&
      quoteLine.quantity === line.quantity &&
      quoteLine.unitAmount?.currency === resolved.currency &&
      quoteLine.unitAmount.amount === line.item.unitAmount &&
      quoteLine.subtotal?.currency === resolved.currency &&
      quoteLine.subtotal.amount === subtotalAmount &&
      quoteLine.total?.currency === resolved.currency &&
      quoteLine.total.amount === subtotalAmount
    );
  });
}

/**
 * Gates delegated-payment handoff at checkout start.
 *
 * `checkout.start` dispatches to the provider's `createDelegatedPayment` method whenever the
 * shared payment token key is present in `customFields`. Without this gate any caller holding a
 * leaked/intercepted token could trigger a charge for an attacker-chosen cart, bypassing the
 * `checkout.preview` payment-authorization contract. We require the caller to present the
 * `payment_authorization` input hash that a fresh preview of this exact cart produces (the same
 * hash `checkout.preview` returns and the ACP complete handler forwards), binding the delegated
 * payment to a current, previewed quote.
 */
export async function requireDelegatedPaymentAuthorization(
  input: MikaBackendDependencies,
  ctx: MikaRequestContext,
  checkoutInput: StartCheckoutInput,
  providerName: ProviderName | undefined,
  resolvedQuote?: CartQuoteDTO,
): Promise<{ readonly ok: true } | MikaApiFailure> {
  const customFields = checkoutInput.customFields;
  const token = customFields?.[MIKA_DELEGATED_PAYMENT_TOKEN_METADATA_KEY];
  if (typeof token !== "string" || token.length === 0) return { ok: true };

  if (!providerName) {
    return validationFailed("provider", "A checkout provider is required.");
  }
  if (!checkoutInput.cartId) {
    return forbidden("Delegated payment requires a previewed cart checkout.");
  }
  const providedHash = customFields?.[MIKA_DELEGATED_PAYMENT_AUTHORIZATION_INPUT_HASH_METADATA_KEY];
  if (typeof providedHash !== "string" || providedHash.length === 0) {
    return forbidden("Delegated payment requires a checkout.preview payment authorization.");
  }

  const proofInput: StartCheckoutInput = { ...checkoutInput, provider: providerName };
  const quote = resolvedQuote ?? (await createCartQuote(input, ctx, proofInput));
  const mode = await resolveCheckoutPreviewMode(input, ctx, proofInput);
  const expectedHash = await delegatedPaymentProofHash(
    input,
    proofInput,
    quote,
    mode,
    providerName,
  );
  if (expectedHash !== providedHash) {
    return forbidden("Delegated payment authorization does not match the current checkout.");
  }

  return { ok: true };
}

export type CheckoutProviderDispatch =
  | {
      readonly ok: true;
      readonly kind: "hosted";
      readonly providerName: ProviderName;
      readonly provider: MikaProviderAdapter;
      readonly method: NonNullable<MikaProviderAdapter["createCheckoutSession"]>;
    }
  | {
      readonly ok: true;
      readonly kind: "delegated";
      readonly providerName: ProviderName;
      readonly provider: MikaProviderAdapter;
      readonly method: NonNullable<MikaProviderAdapter["createDelegatedPayment"]>;
      readonly token: string;
    }
  | MikaApiFailure;

/**
 * Resolves which provider method `checkout.start` calls: `createDelegatedPayment` when the caller
 * (already authorized by {@link requireDelegatedPaymentAuthorization}) presents a shared payment
 * token, or `createCheckoutSession` for the ordinary hosted-checkout redirect flow.
 */
export async function resolveCheckoutProviderDispatch(
  input: MikaBackendDependencies,
  providerName: ProviderName,
  checkoutInput: StartCheckoutInput,
): Promise<CheckoutProviderDispatch> {
  const token = checkoutInput.customFields?.[MIKA_DELEGATED_PAYMENT_TOKEN_METADATA_KEY];
  if (typeof token === "string" && token.length > 0) {
    const feature = await requireProviderFeature(input, {
      providerName,
      method: "createDelegatedPayment",
      capability: "delegated_payment",
      capabilityFailureMessage: "Checkout provider capabilities could not be verified.",
      unsupportedMessage: (provider) =>
        `Provider '${provider}' does not support delegated payments.`,
    });
    if (!feature.ok) return feature;

    return {
      ok: true,
      kind: "delegated",
      providerName: feature.providerName,
      provider: feature.provider,
      method: feature.method,
      token,
    };
  }

  const feature = await requireProviderFeature(input, {
    providerName,
    method: "createCheckoutSession",
    capability: "hosted_checkout",
    capabilityFailureMessage: "Checkout provider capabilities could not be verified.",
    unsupportedMessage: (provider) => `Provider '${provider}' does not support hosted checkout.`,
  });
  if (!feature.ok) return feature;

  return {
    ok: true,
    kind: "hosted",
    providerName: feature.providerName,
    provider: feature.provider,
    method: feature.method,
  };
}

export async function startCheckout(
  input: MikaBackendDependencies,
  ctx: MikaRequestContext,
  checkoutInput: StartCheckoutInput,
): Promise<MikaApiResult<CheckoutSessionDTO>> {
  const idempotencyInputHash = ctx.idempotencyKey
    ? await checkoutIdempotencyInputHash(input, ctx, checkoutInput)
    : undefined;
  const replayedCheckout = ctx.idempotencyKey
    ? await input.repositories.session.findCheckoutByIdempotencyKey(ctx.idempotencyKey)
    : null;
  if (replayedCheckout) {
    if (!(await checkoutBelongsToContext(input, replayedCheckout, ctx))) {
      return checkoutIdempotencyInputMismatch();
    }

    const replayedInputHash = checkoutStoredIdempotencyInputHash(replayedCheckout);
    if (replayedInputHash && idempotencyInputHash && replayedInputHash !== idempotencyInputHash) {
      return checkoutIdempotencyInputMismatch();
    }
    if (checkoutIsExpired(input, replayedCheckout)) {
      const expired = await expireCheckoutDocument(input, replayedCheckout, ctx.now);
      // See checkoutStatus: a concurrent completion makes expireCheckoutDocument return the settled
      // document, so report its real status rather than masking a paid order as expired.
      return expired.status === "expired"
        ? checkoutStatusExpired(expired)
        : checkoutDocumentResult(expired);
    }

    return checkoutDocumentResult(replayedCheckout);
  }

  const providerName = checkoutInput.provider ?? input.defaults?.provider;
  const resolved = await resolveCheckoutStart(input, ctx, checkoutInput);
  if (!resolved.ok) return resolved;

  const hostQuoteInput: CartQuoteInput = {
    ...checkoutInput,
    customFields: checkoutPersistedCustomMetadata(checkoutInput.customFields),
  };
  const defaultQuote = input.quoteResolver
    ? await createDefaultCartQuote(input, ctx, hostQuoteInput)
    : undefined;
  if (defaultQuote && !checkoutResolutionMatchesDefaultQuote(resolved, defaultQuote)) {
    return apiFailure(
      409,
      "CONFLICT",
      "Checkout inputs changed while the business quote was being resolved. Retry checkout.",
    );
  }
  const hostQuote =
    defaultQuote && input.quoteResolver
      ? await input.quoteResolver({
          ctx,
          input: hostQuoteInput,
          quote: defaultQuote,
        })
      : undefined;
  const delegatedPaymentAuth = await requireDelegatedPaymentAuthorization(
    input,
    ctx,
    checkoutInput,
    providerName,
    hostQuote,
  );
  if (!delegatedPaymentAuth.ok) return delegatedPaymentAuth;

  if (hostQuote?.status === "expired") return checkoutExpired();
  if (hostQuote?.status === "unavailable") {
    const error = hostQuote.errors?.[0];
    return apiFailure(
      error?.code === "VALIDATION_FAILED" ? 400 : 409,
      error?.code ?? "CONFLICT",
      error?.message ?? "The host quote is unavailable for checkout.",
      error?.fieldErrors,
    );
  }
  if (
    hostQuote &&
    (hostQuote.currency !== resolved.currency ||
      [
        hostQuote.subtotal,
        hostQuote.discount,
        hostQuote.tax,
        hostQuote.shipping,
        hostQuote.total,
        ...(hostQuote.adjustments?.map((adjustment) => adjustment.amount) ?? []),
      ].some((amount) => amount && amount.currency !== resolved.currency))
  ) {
    return validationFailed("quote", "Host quote currency must match the checkout currency.");
  }

  if (!providerName) {
    return validationFailed("provider", "A checkout provider is required.");
  }

  const providerDispatch = await resolveCheckoutProviderDispatch(
    input,
    providerName,
    checkoutInput,
  );
  if (!providerDispatch.ok) return providerDispatch;
  if (providerDispatch.kind === "hosted" && !ctx.url) {
    return validationFailed("url", "Checkout requires a request URL.");
  }

  const checkoutId = createCheckoutSessionId(input.createId("checkout"));
  const expiresAt = checkoutExpiresAt(input, ctx);
  const statusToken = input.createId("checkout_status_token");
  // Optimistic cart claim serializes concurrent checkout starts; release on any downstream failure.
  // expectedVersion may be undefined for a cart persisted before `version` existed — the
  // repository leniently allows the claim in that case rather than rejecting it outright.
  const claimedCart = resolved.cart
    ? await input.repositories.session.claimCartForCheckout({
        cartId: resolved.cart.id,
        checkoutId,
        expectedVersion: resolved.cartVersion,
        claimExpiresAt: expiresAt,
        now: ctx.now,
      })
    : null;
  if (resolved.cart && !claimedCart) {
    return apiFailure(409, "CONFLICT", "Cart is already being checked out.", {
      cartId: "Cart is already being checked out.",
    });
  }
  // A thrown reservation error (vs. a returned failure) must still release the cart claim, or the
  // cart stays locked in checkout_pending until the claim TTL. reserveCheckoutLines releases its own
  // reservations on throw; only the claim is left for us to release here.
  let reserved: Awaited<ReturnType<typeof reserveCheckoutLines>>;
  try {
    reserved = await reserveCheckoutLines(input, ctx, checkoutId, resolved, expiresAt);
  } catch (error) {
    if (claimedCart)
      await releaseCartCheckoutClaimQuietly(input, claimedCart.id, checkoutId, ctx.now);
    throw error;
  }
  if (!reserved.ok) {
    if (claimedCart)
      await releaseCartCheckoutClaimQuietly(input, claimedCart.id, checkoutId, ctx.now);
    return reserved;
  }

  const checkoutSubtotal = reserved.lines.reduce(
    (sum, line) => sum + line.item.unitAmount * line.quantity,
    0,
  );
  const checkoutDiscountAmount = couponDiscountAmount(resolved.coupon, checkoutSubtotal);

  const providerSession = await (async () => {
    try {
      const total =
        hostQuote?.total ??
        moneyDTO(Math.max(0, checkoutSubtotal - checkoutDiscountAmount), resolved.currency);
      const discount =
        hostQuote?.discount ??
        (checkoutDiscountAmount > 0
          ? moneyDTO(checkoutDiscountAmount, resolved.currency)
          : undefined);
      const lines = reserved.lines.map((line) => checkoutLineToProviderLine(providerName, line));

      if (providerDispatch.kind === "delegated") {
        return await providerDispatch.method.call(
          providerDispatch.provider,
          omitUndefined({
            idempotencyKey: ctx.idempotencyKey,
            mode: resolved.mode,
            token: providerDispatch.token,
            lines,
            ...(discount ? { discount } : {}),
            total,
            metadata: checkoutPersistedCustomMetadata(checkoutInput.customFields),
          }),
        );
      }

      return await providerDispatch.method.call(
        providerDispatch.provider,
        omitUndefined({
          idempotencyKey: ctx.idempotencyKey,
          mode: resolved.mode,
          provider: providerName,
          customer: checkoutInput.customer,
          lines,
          ...(discount ? { discount } : {}),
          total,
          successUrl: checkoutSuccessUrl(input, ctx, checkoutInput, checkoutId, statusToken),
          cancelUrl: checkoutCancelUrl(input, ctx, checkoutInput, checkoutId, statusToken),
          metadata: checkoutCustomMetadata(checkoutInput.customFields),
        }),
      );
    } catch (error) {
      observeBackendError(input, "checkout.providerSession", error, {
        checkoutId,
        provider: providerName,
      });
      await releaseCheckoutStartResources(
        input,
        reserved.reservationIds,
        claimedCart,
        checkoutId,
        ctx.now,
      );
      return null;
    }
  })();
  const checkoutTotalAmount =
    hostQuote?.total.amount ?? Math.max(0, checkoutSubtotal - checkoutDiscountAmount);
  if (!providerSession) {
    await emitCheckoutStartFailedNotification(
      input,
      ctx,
      checkoutInput,
      providerName,
      checkoutTotalAmount,
      resolved.currency,
      "Checkout provider failed to create a session.",
    );

    return providerFailed("Checkout provider failed to create a session.");
  }
  if (providerSession.status === "failed") {
    await releaseCheckoutStartResources(
      input,
      reserved.reservationIds,
      claimedCart,
      checkoutId,
      ctx.now,
    );
    await emitCheckoutStartFailedNotification(
      input,
      ctx,
      checkoutInput,
      providerName,
      checkoutTotalAmount,
      resolved.currency,
      "Checkout provider returned a failed session.",
    );

    return providerFailed("Checkout provider returned a failed session.");
  }

  const providerCheckoutId = providerSession.providerCheckoutId ?? providerSession.id;
  const documentExpiresAt = providerSession.expiresAt ?? expiresAt;
  try {
    if (new Date(documentExpiresAt).getTime() > new Date(expiresAt).getTime()) {
      await createMikaStockLifecycleService(input).extendReservations({
        reservationEventIds: reserved.reservationIds,
        expiresAt: documentExpiresAt,
        now: ctx.now,
      });
    }
  } catch (error) {
    observeBackendError(input, "checkout.extendReservations", error, { checkoutId });
    await releaseCheckoutStartResources(
      input,
      reserved.reservationIds,
      claimedCart,
      checkoutId,
      ctx.now,
    );

    return checkoutPersistenceFailed();
  }
  const checkoutDocument: CheckoutDocument = omitUndefined({
    id: checkoutId,
    type: "checkout",
    schemaVersion: 1,
    cartId: resolved.cart?.id,
    sessionId: ctx.sessionId,
    customerId: ctx.customerId,
    provider: providerName,
    providerCheckoutId,
    checkoutIdempotencyKey: ctx.idempotencyKey,
    checkoutIdempotencyInputHash: idempotencyInputHash,
    providerStatus: providerSession.status,
    redirectUrl: providerSession.redirectUrl,
    status: checkoutDocumentStatus(providerSession.status),
    expiresAt: documentExpiresAt,
    aggregate: createCheckoutAggregate(
      omitUndefined({
        mode: resolved.mode,
        currency: resolved.currency,
        lines: reserved.lines,
        coupon: resolved.coupon,
        totals: hostQuote
          ? omitUndefined({
              subtotal: hostQuote.subtotal,
              discount: hostQuote.discount,
              tax: hostQuote.tax,
              shipping: hostQuote.shipping,
              total: hostQuote.total,
            })
          : undefined,
        binding: omitUndefined({
          provider: providerName,
          providerCheckoutId,
          providerCustomerId: providerSession.providerCustomerId,
          returnPath: safeRequestReturnPath(ctx, checkoutInput.returnTo),
          cancelPath: checkoutCancelTarget(input, ctx, checkoutInput),
          successPath: checkoutSuccessTarget(input, ctx, checkoutInput),
          cartHash: await input.hash(
            JSON.stringify({
              cartId: resolved.cart?.id,
              currency: resolved.currency,
              lines: reserved.lines.map((line) => ({
                sellableId: line.item.sellableId,
                priceId: line.item.priceId,
                quantity: line.quantity,
                unitAmount: line.item.unitAmount,
                currency: line.item.currency,
                reservationId: line.reservationId,
              })),
              coupon: resolved.coupon,
            }),
          ),
        }),
        metadata: checkoutMetadata(
          omitUndefined({
            customFields: checkoutInput.customFields,
            customer: checkoutInput.customer,
            idempotencyInputHash,
            idempotencyKey: ctx.idempotencyKey,
            providerSession,
          }),
        ),
      }),
    ),
    createdAt: ctx.now,
    updatedAt: ctx.now,
  });

  const persisted = await persistCheckoutStart(
    input,
    ctx,
    checkoutDocument,
    statusToken,
    checkoutStartCartForPersistence(resolved.cart, claimedCart),
    checkoutId,
    reserved.lines,
    reserved.reservationIds,
  );
  if (!persisted.ok) return persisted;

  const checkoutRedirectUrl = checkoutStatusAllowsRedirect(
    checkoutDocument.status,
    providerSession.status,
  )
    ? providerSession.redirectUrl
    : undefined;

  return {
    ok: true,
    status: 200,
    data: omitUndefined({
      id: checkoutId,
      status: providerSession.status,
      mode: providerSession.mode,
      provider: providerSession.provider,
      redirectUrl: checkoutRedirectUrl,
      statusToken,
      expiresAt: providerSession.expiresAt ?? checkoutDocument.expiresAt,
      paymentPending: providerSession.status === "pending" ? true : undefined,
    }),
    ...(checkoutRedirectUrl
      ? { effects: [{ type: "redirect" as const, url: checkoutRedirectUrl }] }
      : {}),
  };
}

export async function resolveCheckoutStart(
  input: MikaBackendDependencies,
  ctx: MikaRequestContext,
  checkoutInput: StartCheckoutInput,
): Promise<({ readonly ok: true } & CheckoutStartResolution) | MikaApiFailure> {
  if (checkoutInput.cartId && checkoutInput.sellableId) {
    return validationFailed(
      "sellableId",
      "Provide either a cartId or a sellableId for checkout, not both.",
    );
  }

  const defaultCurrency = defaultBackendCurrency(input);
  const expressBuyNow =
    checkoutInput.sellableId !== undefined && checkoutInput.cartId === undefined;
  const cartResult = expressBuyNow
    ? { ok: true as const, cart: null, expired: false }
    : await findCheckoutStartCart(input, ctx, checkoutInput.cartId, defaultCurrency);
  if (!cartResult.ok) return cartResult;
  if (cartResult.expired) return checkoutExpired();

  const lines: CheckoutStartLineResolution[] = [];
  const currency = cartResult.cart?.aggregate.currency ?? defaultCurrency;

  const cartLines = cartResult.cart?.aggregate.items ?? [];
  for (const cartLine of cartLines) {
    const line = await resolveCheckoutStartLine(
      input,
      omitUndefined({
        sellableId: cartLine.item.sellableId,
        priceId: cartLine.item.priceId,
        quantity: cartLine.quantity,
        quantityForLimit: cartLine.quantity + siblingSellableQuantity(cartLines, cartLine),
        currency,
        cartLineId: cartLine.id,
        metadata: cartLine.metadata,
      }),
    );
    if (!line.ok) return line;
    lines.push(line);
  }

  if (checkoutInput.sellableId) {
    const line = await resolveCheckoutStartLine(
      input,
      omitUndefined({
        sellableId: checkoutInput.sellableId,
        priceId: checkoutInput.priceId,
        quantity: checkoutInput.quantity ?? 1,
        currency,
      }),
    );
    if (!line.ok) return line;
    lines.push(line);
  }

  if (lines.length === 0) return checkoutEmpty();

  const modes = [...new Set(lines.map((line) => line.line.item.mode))];
  if (modes.length !== 1 || modes[0] === undefined) {
    return validationFailed("cartId", "Checkout requires lines with one purchase mode.");
  }

  let resolvedCart = cartResult.cart;
  let coupon = resolvedCart?.aggregate.coupon;
  if (checkoutInput.couponCode !== undefined) {
    const code = checkoutInput.couponCode.trim();
    if (code) {
      const resolved = await couponSnapshotForSubtotal(
        input,
        code,
        lines.reduce((sum, line) => sum + line.line.item.unitAmount * line.line.quantity, 0),
        currency,
      );
      if (!resolved) {
        return validationFailed("couponCode", couponRejectionMessage(input, code.toUpperCase()));
      }
      coupon = resolved;
    } else {
      coupon = undefined;
    }
    if (resolvedCart) {
      resolvedCart = {
        ...resolvedCart,
        updatedAt: ctx.now,
        aggregate: coupon
          ? cartWithCoupon({ cart: resolvedCart.aggregate, coupon })
          : cartWithoutCoupon({ cart: resolvedCart.aggregate }),
      };
    }
  }

  return omitUndefined({
    ok: true,
    cart: resolvedCart,
    cartVersion: cartResult.cart?.version,
    currency,
    mode: modes[0],
    coupon,
    lines,
  });
}

export async function findCheckoutStartCart(
  input: MikaBackendDependencies,
  ctx: MikaRequestContext,
  cartId: MikaId | undefined,
  currency: CurrencyCode,
): Promise<
  | { readonly ok: true; readonly cart: CartDocument | null; readonly expired: boolean }
  | MikaApiFailure
> {
  const cartResult = await findQuoteCart(input, ctx, cartId, currency);
  if (!cartResult.cart) return { ok: true, cart: null, expired: false };
  if (cartResult.cart.status !== "open") {
    return invalidCart("cartId", cartResult.cart.id);
  }

  return { ok: true, cart: cartResult.cart, expired: cartResult.expired };
}

export async function resolveCheckoutStartLine(
  input: MikaBackendDependencies,
  lineInput: {
    readonly sellableId: MikaId;
    readonly priceId?: MikaId;
    readonly quantity: number;
    readonly quantityForLimit?: number;
    readonly currency: CurrencyCode;
    readonly cartLineId?: MikaId;
    readonly metadata?: JsonObject;
  },
): Promise<({ readonly ok: true } & CheckoutStartLineResolution) | MikaApiFailure> {
  if (!Number.isInteger(lineInput.quantity) || lineInput.quantity < 1) {
    return validationFailed("quantity", "Quantity must be a positive whole number.");
  }

  const catalog = await input.repositories.catalog.findItemBySellableId(lineInput.sellableId);
  if (!catalog) {
    return {
      ok: false,
      status: 404,
      error: {
        code: "SELLABLE_NOT_FOUND",
        message: `Sellable '${lineInput.sellableId}' was not found.`,
      },
    };
  }

  const sellable = catalog.aggregate.sellables.find((item) => item.id === lineInput.sellableId);
  if (!sellable?.active) {
    return {
      ok: false,
      status: 409,
      error: {
        code: "SELLABLE_INACTIVE",
        message: `Sellable '${lineInput.sellableId}' is inactive.`,
      },
    };
  }

  const price = selectCartPrice(sellable, lineInput.priceId, lineInput.currency);
  if (!price) {
    return cartPriceUnavailable(sellable, lineInput.priceId, lineInput.currency);
  }
  if (price.currency !== lineInput.currency) {
    return validationFailed("priceId", `Price '${price.id}' uses currency '${price.currency}'.`);
  }

  const stock = await input.repositories.stock.findBySellableId(sellable.id);
  const quantityError = validateQuantityLimit(
    sellable,
    stock,
    lineInput.quantityForLimit ?? lineInput.quantity,
  );
  if (quantityError) return quantityError;

  return {
    ok: true,
    line: omitUndefined({
      id: input.createId("checkout_line"),
      cartLineId: lineInput.cartLineId,
      item: snapshotPrice({
        content: catalog.aggregate.content,
        sellable,
        price,
        fallbackTitle: catalog.aggregate.titleSnapshot ?? sellable.id,
      }),
      quantity: lineInput.quantity,
      metadata: lineInput.metadata,
    }),
    stock,
  };
}

export async function reserveCheckoutLines(
  input: MikaBackendDependencies,
  ctx: MikaRequestContext,
  checkoutId: CheckoutSessionId,
  checkout: CheckoutStartResolution,
  expiresAt: ISODateTime,
): Promise<
  | {
      readonly ok: true;
      readonly lines: readonly CheckoutLine[];
      readonly reservationIds: readonly MikaId[];
    }
  | MikaApiFailure
> {
  const stock = createMikaStockLifecycleService(input);
  const lines: CheckoutLine[] = [];
  const reservationIds: MikaId[] = [];

  try {
    for (const resolution of checkout.lines) {
      if (!resolution.stock) {
        lines.push(resolution.line);
        continue;
      }

      const reservation = await stock.reserve(
        omitUndefined({
          stockItemId: resolution.stock.id,
          quantity: resolution.line.quantity,
          expiresAt,
          now: ctx.now,
          cartId: checkout.cart?.id,
          checkoutSessionId: checkoutId,
          customerId: ctx.customerId,
          sessionId: ctx.sessionId,
          idempotencyKey: checkoutReservationIdempotencyKey(ctx, resolution),
          metadata: { source: "checkout.start" },
        }),
      );

      if (reservation.status === "insufficient_stock") {
        await releaseCheckoutReservations(input, reservationIds, ctx.now);
        return outOfStock(resolution.line.item.sellableId);
      }
      if (reservation.status === "not_found") {
        await releaseCheckoutReservations(input, reservationIds, ctx.now);
        return outOfStock(resolution.line.item.sellableId);
      }
      if (reservation.status === "replayed") {
        await releaseCheckoutReservations(input, reservationIds, ctx.now);
        return checkoutIdempotencyInProgress();
      }
      if (reservation.status === "idempotency_conflict") {
        await releaseCheckoutReservations(input, reservationIds, ctx.now);
        return checkoutIdempotencyInputMismatch();
      }

      reservationIds.push(reservation.event.id);
      lines.push({ ...resolution.line, reservationId: reservation.event.id });
    }
  } catch (error) {
    await releaseCheckoutReservations(input, reservationIds, ctx.now);
    throw error;
  }

  return { ok: true, lines, reservationIds };
}

export async function persistCheckoutStart(
  input: MikaBackendDependencies,
  ctx: MikaRequestContext,
  checkoutDocument: CheckoutDocument,
  statusToken: string,
  cart: CartDocument | null,
  checkoutId: CheckoutSessionId,
  lines: readonly CheckoutLine[],
  reservationIds: readonly MikaId[],
): Promise<{ readonly ok: true } | MikaApiFailure> {
  let checkoutPersisted = false;

  try {
    await input.repositories.session.put(checkoutDocument);
    checkoutPersisted = true;
    await putCheckoutStatusToken(input, ctx, checkoutDocument, statusToken);
    if (cart) {
      await input.repositories.session.put(
        cartWithCheckoutReservations(cart, checkoutId, lines, ctx.now),
      );
    }
  } catch (error) {
    observeBackendError(input, "checkout.persist", error, { checkoutId });
    await releaseCheckoutReservations(input, reservationIds, ctx.now);
    if (cart) {
      await releaseCartCheckoutClaimQuietly(input, cart.id, checkoutId, ctx.now);
    }
    if (checkoutPersisted) {
      await markCheckoutPersistenceFailed(input, checkoutDocument, ctx.now);
    }

    return checkoutPersistenceFailed();
  }

  return { ok: true };
}

export function checkoutStartCartForPersistence(
  resolvedCart: CartDocument | null,
  claimedCart: CartDocument | null,
): CartDocument | null {
  if (!resolvedCart || !claimedCart) return claimedCart ?? resolvedCart;

  return {
    ...resolvedCart,
    status: claimedCart.status,
    aggregate: {
      ...resolvedCart.aggregate,
      metadata: {
        ...resolvedCart.aggregate.metadata,
        ...claimedCart.aggregate.metadata,
      },
    },
    updatedAt: claimedCart.updatedAt,
  };
}

export async function markCheckoutPersistenceFailed(
  input: MikaBackendDependencies,
  checkoutDocument: CheckoutDocument,
  now: ISODateTime,
): Promise<void> {
  try {
    await input.repositories.session.put(
      omitUndefined({
        ...checkoutDocument,
        status: "failed",
        providerStatus: "failed",
        failureReason: "Checkout could not be persisted after provider handoff.",
        updatedAt: now,
        aggregate: {
          ...checkoutDocument.aggregate,
          metadata: checkoutFailedMetadata(checkoutDocument.aggregate.metadata),
        },
      }),
    );
  } catch (error) {
    // Best effort: if the local store is unavailable, stock release already compensated inventory.
    observeBackendError(input, "checkout.markPersistenceFailed", error, {
      checkoutId: checkoutDocument.id,
    });
  }
}

export async function releaseCheckoutReservations(
  input: MikaStockLifecycleDependencies,
  reservationIds: readonly MikaId[],
  now: ISODateTime,
): Promise<void> {
  const stock = createMikaStockLifecycleService(input);

  for (const reservationEventId of reservationIds) {
    await stock.release({ reservationEventId, now });
  }
}

export async function releaseCartCheckoutClaimQuietly(
  input: MikaBackendDependencies,
  cartId: CartId,
  checkoutId: CheckoutSessionId,
  now: ISODateTime,
): Promise<void> {
  try {
    await input.repositories.session.releaseCartCheckoutClaim({ cartId, checkoutId, now });
  } catch (error) {
    // Best effort: unlock the cart so another checkout attempt can proceed.
    observeBackendError(input, "checkout.releaseCartClaim", error, { cartId, checkoutId });
  }
}

/** Releases the reservations and any claimed cart held during a failed checkout.start attempt. */
export async function releaseCheckoutStartResources(
  input: MikaBackendDependencies,
  reservationIds: readonly MikaId[],
  claimedCart: CartDocument | null,
  checkoutId: CheckoutSessionId,
  now: ISODateTime,
): Promise<void> {
  await releaseCheckoutReservations(input, reservationIds, now);
  if (claimedCart) {
    await releaseCartCheckoutClaimQuietly(input, claimedCart.id, checkoutId, now);
  }
}

/**
 * Emits the checkout.payment_failed notification for a failed checkout.start. `totalAmount` is the
 * amount that would have been charged (subtotal minus coupon discount) — the same figure passed to
 * the provider — so the notification never reports the pre-discount subtotal.
 */
export async function emitCheckoutStartFailedNotification(
  input: MikaBackendDependencies,
  ctx: MikaRequestContext,
  checkoutInput: StartCheckoutInput,
  providerName: ProviderName,
  totalAmount: number,
  currency: CurrencyCode,
  error: string,
): Promise<void> {
  await emitBackendNotification(input, "checkout.payment_failed", ctx.now, {
    ...(checkoutInput.customer?.email ? { toEmail: checkoutInput.customer.email } : {}),
    ...(ctx.customerId ? { customerId: ctx.customerId } : {}),
    ...(ctx.userId ? { userId: ctx.userId } : {}),
    provider: providerName,
    status: "failed",
    error,
    total: { amount: totalAmount, currency },
  });
}

export function checkoutReservationIdempotencyKey(
  ctx: MikaRequestContext,
  resolution: CheckoutStartLineResolution,
): string | undefined {
  if (!ctx.idempotencyKey || !resolution.stock) return undefined;

  return [
    "checkout",
    ctx.idempotencyKey,
    resolution.stock.id,
    resolution.line.item.sellableId,
    resolution.line.item.priceId ?? "",
  ].join(":");
}

export function cartWithCheckoutReservations(
  cart: CartDocument,
  checkoutId: MikaId,
  lines: readonly CheckoutLine[],
  updatedAt: ISODateTime,
): CartDocument {
  const reservationByCartLineId = new Map(
    lines.flatMap((line) =>
      line.cartLineId && line.reservationId ? [[line.cartLineId, line.reservationId] as const] : [],
    ),
  );

  const updated = updateCartDocument(
    cart,
    cart.aggregate.items.map((item) =>
      omitUndefined({
        ...item,
        reservationId: reservationByCartLineId.get(item.id) ?? item.reservationId,
      }),
    ),
    updatedAt,
  );
  const {
    checkoutStartClaimId: _checkoutStartClaimId,
    checkoutStartClaimExpiresAt: _checkoutStartClaimExpiresAt,
    ...metadata
  } = updated.aggregate.metadata ?? {};

  return {
    ...updated,
    status: "checkout_pending",
    aggregate: {
      ...updated.aggregate,
      metadata: {
        ...metadata,
        checkoutSessionId: checkoutId,
      },
    },
  };
}
