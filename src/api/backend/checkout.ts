/**
 * Checkout: starting a provider checkout session (hosted redirect or delegated payment),
 * resolving/reserving the cart or express-buy line(s) that back it, status/cancel lookups,
 * expiry, the checkout-preview payment-authorization proof used to gate delegated payment, and
 * the metadata helpers that round-trip customer/custom-field data through the checkout document.
 */
import {
  MIKA_DELEGATED_PAYMENT_AUTHORIZATION_INPUT_HASH_METADATA_KEY,
  MIKA_DELEGATED_PAYMENT_AUTHORIZATION_METADATA_KEY,
  MIKA_DELEGATED_PAYMENT_CHECKOUT_SESSION_ID_METADATA_KEY,
  MIKA_DELEGATED_PAYMENT_PROVIDER_METADATA_KEY,
  MIKA_DELEGATED_PAYMENT_TOKEN_METADATA_KEY,
  type MikaProviderAdapter,
  type MikaProviderLineItem,
} from "../../provider";
import {
  cartWithCoupon,
  cartWithoutCoupon,
  couponDiscountAmount,
  createCheckoutAggregate,
  snapshotPrice,
} from "../../model/builders";
import type { CheckoutLine, CouponSnapshot } from "../../types/aggregates";
import type { CartDocument, CheckoutDocument } from "../../types/documents";
import type { StockItemRecord } from "../../types/operational";
import { createISODateTime, createMikaId } from "../../types/primitives";
import type {
  CheckoutStatus,
  CurrencyCode,
  ISODateTime,
  JsonObject,
  JsonValue,
  MikaId,
  ProviderName,
  PurchaseMode,
} from "../../types/primitives";
import type { MikaRequestContext } from "../context";
import type {
  CartQuoteDTO,
  CheckoutCancelInput,
  CheckoutCustomerInput,
  CheckoutPreviewDTO,
  CheckoutPreviewInput,
  CheckoutSessionDTO,
  CheckoutStatusInput,
  MikaApiResult,
  StartCheckoutInput,
} from "../types";
import { safeRequestReturnPath } from "./account";
import { requireProviderFeature, stableJsonStringify } from "./admin-audit";
import {
  apiFailure,
  checkoutEmpty,
  checkoutExpired,
  checkoutFailedReplay,
  checkoutIdempotencyInProgress,
  checkoutIdempotencyInputMismatch,
  checkoutPersistenceFailed,
  emitBackendNotification,
  forbidden,
  invalidCart,
  invalidCheckout,
  observeBackendError,
  outOfStock,
  providerFailed,
  validationFailed,
} from "./errors";
import type { MikaApiFailure } from "./errors";
import { checkoutBelongsToContext } from "./identity";
import type { CreateMikaBackendApiInput } from "./ports";
import {
  cartPriceUnavailable,
  couponRejectionMessage,
  couponSnapshotForSubtotal,
  createCartQuote,
  findQuoteCart,
  reopenCartDocument,
  selectCartPrice,
  siblingSellableQuantity,
  updateCartDocument,
  validateQuantityLimit,
} from "./quote";
import { defaultBackendCurrency, metadataMikaId, metadataString, moneyDTO } from "./shared";
import { createMikaStockLifecycleService, expireCheckoutReservations } from "./stock-lifecycle";
import type { MikaStockLifecycleDependencies } from "./stock-lifecycle";
import {
  checkoutCancelAccessError,
  checkoutStatusAccessError,
  putCheckoutStatusToken,
} from "./tokens";

const CHECKOUT_IDEMPOTENCY_INPUT_HASH_METADATA_KEY = "checkoutIdempotencyInputHash";
const CHECKOUT_CUSTOMER_EMAIL_METADATA_KEY = "checkoutCustomerEmail";
const CHECKOUT_CUSTOMER_NAME_METADATA_KEY = "checkoutCustomerName";
const CHECKOUT_CUSTOMER_COMPANY_METADATA_KEY = "checkoutCustomerCompany";
const CHECKOUT_CUSTOMER_VAT_ID_METADATA_KEY = "checkoutCustomerVatId";
// Internal checkout keys: stripped from provider metadata and omitted from persisted custom fields.
const CHECKOUT_INTERNAL_METADATA_KEYS = new Set<string>([
  "checkoutIdempotencyKey",
  CHECKOUT_IDEMPOTENCY_INPUT_HASH_METADATA_KEY,
  "checkoutProviderStatus",
  "checkoutRedirectUrl",
  "checkoutPersistenceFailed",
  "checkoutOrderId",
  CHECKOUT_CUSTOMER_EMAIL_METADATA_KEY,
  CHECKOUT_CUSTOMER_NAME_METADATA_KEY,
  CHECKOUT_CUSTOMER_COMPANY_METADATA_KEY,
  CHECKOUT_CUSTOMER_VAT_ID_METADATA_KEY,
]);
// Delegated-payment proof keys: never persisted on checkout documents (token, authorization hash).
const DELEGATED_PAYMENT_PROOF_VOLATILE_METADATA_KEYS = new Set<string>([
  MIKA_DELEGATED_PAYMENT_TOKEN_METADATA_KEY,
  MIKA_DELEGATED_PAYMENT_AUTHORIZATION_INPUT_HASH_METADATA_KEY,
  MIKA_DELEGATED_PAYMENT_PROVIDER_METADATA_KEY,
  MIKA_DELEGATED_PAYMENT_AUTHORIZATION_METADATA_KEY,
  MIKA_DELEGATED_PAYMENT_CHECKOUT_SESSION_ID_METADATA_KEY,
]);
const CHECKOUT_PERSISTED_METADATA_OMIT_KEYS = new Set<string>([
  ...CHECKOUT_INTERNAL_METADATA_KEYS,
  ...DELEGATED_PAYMENT_PROOF_VOLATILE_METADATA_KEYS,
]);

type CheckoutStartLineResolution = {
  readonly line: CheckoutLine;
  readonly stock: StockItemRecord | null;
};

type CheckoutStartResolution = {
  readonly cart: CartDocument | null;
  readonly cartVersion?: number;
  readonly currency: CurrencyCode;
  readonly mode: PurchaseMode;
  readonly coupon?: CouponSnapshot;
  readonly lines: readonly CheckoutStartLineResolution[];
};

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
async function requireDelegatedPaymentAuthorization(
  input: CreateMikaBackendApiInput,
  ctx: MikaRequestContext,
  checkoutInput: StartCheckoutInput,
  providerName: ProviderName | undefined,
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
  const quote = await createCartQuote(input, ctx, proofInput);
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

type CheckoutProviderDispatch =
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
async function resolveCheckoutProviderDispatch(
  input: CreateMikaBackendApiInput,
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
  input: CreateMikaBackendApiInput,
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
      return checkoutStatusExpired(expired);
    }

    return checkoutDocumentResult(replayedCheckout);
  }

  const providerName = checkoutInput.provider ?? input.defaults?.provider;
  const delegatedPaymentAuth = await requireDelegatedPaymentAuthorization(
    input,
    ctx,
    checkoutInput,
    providerName,
  );
  if (!delegatedPaymentAuth.ok) return delegatedPaymentAuth;

  const resolved = await resolveCheckoutStart(input, ctx, checkoutInput);
  if (!resolved.ok) return resolved;

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

  const checkoutId = input.createId("checkout");
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
  const reserved = await reserveCheckoutLines(input, ctx, checkoutId, resolved, expiresAt);
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
      const total = moneyDTO(
        Math.max(0, checkoutSubtotal - checkoutDiscountAmount),
        resolved.currency,
      );
      const discount =
        checkoutDiscountAmount > 0
          ? moneyDTO(checkoutDiscountAmount, resolved.currency)
          : undefined;
      const lines = reserved.lines.map((line) => checkoutLineToProviderLine(providerName, line));

      if (providerDispatch.kind === "delegated") {
        return await providerDispatch.method.call(providerDispatch.provider, {
          idempotencyKey: ctx.idempotencyKey,
          mode: resolved.mode,
          token: providerDispatch.token,
          lines,
          ...(discount ? { discount } : {}),
          total,
          metadata: checkoutPersistedCustomMetadata(checkoutInput.customFields),
        });
      }

      return await providerDispatch.method.call(providerDispatch.provider, {
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
      });
    } catch {
      await releaseCheckoutReservations(input, reserved.reservationIds, ctx.now);
      if (claimedCart) {
        await releaseCartCheckoutClaimQuietly(input, claimedCart.id, checkoutId, ctx.now);
      }
      return null;
    }
  })();
  if (!providerSession) {
    await emitBackendNotification(input, "checkout.payment_failed", ctx.now, {
      ...(checkoutInput.customer?.email ? { toEmail: checkoutInput.customer.email } : {}),
      ...(ctx.customerId ? { customerId: ctx.customerId } : {}),
      ...(ctx.userId ? { userId: ctx.userId } : {}),
      provider: providerName,
      status: "failed",
      error: "Checkout provider failed to create a session.",
      total: {
        amount: reserved.lines.reduce((sum, line) => sum + line.item.unitAmount * line.quantity, 0),
        currency: resolved.currency,
      },
    });

    return providerFailed("Checkout provider failed to create a session.");
  }
  if (providerSession.status === "failed") {
    await releaseCheckoutReservations(input, reserved.reservationIds, ctx.now);
    if (claimedCart) {
      await releaseCartCheckoutClaimQuietly(input, claimedCart.id, checkoutId, ctx.now);
    }
    await emitBackendNotification(input, "checkout.payment_failed", ctx.now, {
      ...(checkoutInput.customer?.email ? { toEmail: checkoutInput.customer.email } : {}),
      ...(ctx.customerId ? { customerId: ctx.customerId } : {}),
      ...(ctx.userId ? { userId: ctx.userId } : {}),
      provider: providerName,
      status: "failed",
      error: "Checkout provider returned a failed session.",
      total: {
        amount: reserved.lines.reduce((sum, line) => sum + line.item.unitAmount * line.quantity, 0),
        currency: resolved.currency,
      },
    });

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
  } catch {
    await releaseCheckoutReservations(input, reserved.reservationIds, ctx.now);
    if (claimedCart) {
      await releaseCartCheckoutClaimQuietly(input, claimedCart.id, checkoutId, ctx.now);
    }

    return checkoutPersistenceFailed();
  }
  const checkoutDocument: CheckoutDocument = {
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
    aggregate: createCheckoutAggregate({
      mode: resolved.mode,
      currency: resolved.currency,
      lines: reserved.lines,
      coupon: resolved.coupon,
      binding: {
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
      },
      metadata: checkoutMetadata({
        customFields: checkoutInput.customFields,
        customer: checkoutInput.customer,
        idempotencyInputHash,
        idempotencyKey: ctx.idempotencyKey,
        providerSession,
      }),
    }),
    createdAt: ctx.now,
    updatedAt: ctx.now,
  };

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
    data: {
      id: checkoutId,
      status: providerSession.status,
      mode: providerSession.mode,
      provider: providerSession.provider,
      redirectUrl: checkoutRedirectUrl,
      statusToken,
      expiresAt: providerSession.expiresAt ?? checkoutDocument.expiresAt,
      paymentPending: providerSession.status === "pending" ? true : undefined,
    },
    effects: checkoutRedirectUrl ? [{ type: "redirect", url: checkoutRedirectUrl }] : undefined,
  };
}

async function resolveCheckoutStart(
  input: CreateMikaBackendApiInput,
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
    const line = await resolveCheckoutStartLine(input, {
      sellableId: cartLine.item.sellableId,
      priceId: cartLine.item.priceId,
      quantity: cartLine.quantity,
      quantityForLimit: cartLine.quantity + siblingSellableQuantity(cartLines, cartLine),
      currency,
      cartLineId: cartLine.id,
      metadata: cartLine.metadata,
    });
    if (!line.ok) return line;
    lines.push(line);
  }

  if (checkoutInput.sellableId) {
    const line = await resolveCheckoutStartLine(input, {
      sellableId: checkoutInput.sellableId,
      priceId: checkoutInput.priceId,
      quantity: checkoutInput.quantity ?? 1,
      currency,
    });
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

  return {
    ok: true,
    cart: resolvedCart,
    cartVersion: cartResult.cart?.version,
    currency,
    mode: modes[0],
    coupon,
    lines,
  };
}

async function findCheckoutStartCart(
  input: CreateMikaBackendApiInput,
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

async function resolveCheckoutStartLine(
  input: CreateMikaBackendApiInput,
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
    line: {
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
    },
    stock,
  };
}

async function reserveCheckoutLines(
  input: CreateMikaBackendApiInput,
  ctx: MikaRequestContext,
  checkoutId: MikaId,
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

      const reservation = await stock.reserve({
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
      });

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

async function persistCheckoutStart(
  input: CreateMikaBackendApiInput,
  ctx: MikaRequestContext,
  checkoutDocument: CheckoutDocument,
  statusToken: string,
  cart: CartDocument | null,
  checkoutId: MikaId,
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
  } catch {
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

function checkoutStartCartForPersistence(
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

async function markCheckoutPersistenceFailed(
  input: CreateMikaBackendApiInput,
  checkoutDocument: CheckoutDocument,
  now: ISODateTime,
): Promise<void> {
  try {
    await input.repositories.session.put({
      ...checkoutDocument,
      status: "failed",
      providerStatus: "failed",
      redirectUrl: undefined,
      failureReason: "Checkout could not be persisted after provider handoff.",
      updatedAt: now,
      aggregate: {
        ...checkoutDocument.aggregate,
        metadata: checkoutFailedMetadata(checkoutDocument.aggregate.metadata),
      },
    });
  } catch (error) {
    // Best effort: if the local store is unavailable, stock release already compensated inventory.
    observeBackendError(input, "checkout.markPersistenceFailed", error, {
      checkoutId: checkoutDocument.id,
    });
  }
}

async function releaseCheckoutReservations(
  input: MikaStockLifecycleDependencies,
  reservationIds: readonly MikaId[],
  now: ISODateTime,
): Promise<void> {
  const stock = createMikaStockLifecycleService(input);

  for (const reservationEventId of reservationIds) {
    await stock.release({ reservationEventId, now });
  }
}

async function releaseCartCheckoutClaimQuietly(
  input: CreateMikaBackendApiInput,
  cartId: MikaId,
  checkoutId: MikaId,
  now: ISODateTime,
): Promise<void> {
  try {
    await input.repositories.session.releaseCartCheckoutClaim({ cartId, checkoutId, now });
  } catch (error) {
    // Best effort: unlock the cart so another checkout attempt can proceed.
    observeBackendError(input, "checkout.releaseCartClaim", error, { cartId, checkoutId });
  }
}

function checkoutMetadata(input: {
  readonly customFields: JsonObject | undefined;
  readonly customer?: CheckoutCustomerInput;
  readonly idempotencyInputHash?: string;
  readonly idempotencyKey: string | undefined;
  readonly providerSession: {
    readonly status: CheckoutSessionDTO["status"];
    readonly redirectUrl?: string;
  };
}): JsonObject {
  return {
    ...checkoutPersistedCustomMetadata(input.customFields),
    ...checkoutCustomerToMetadata(input.customer),
    checkoutProviderStatus: input.providerSession.status,
    ...(input.idempotencyKey ? { checkoutIdempotencyKey: input.idempotencyKey } : {}),
    ...(input.idempotencyInputHash
      ? { [CHECKOUT_IDEMPOTENCY_INPUT_HASH_METADATA_KEY]: input.idempotencyInputHash }
      : {}),
    ...(input.providerSession.redirectUrl
      ? { checkoutRedirectUrl: input.providerSession.redirectUrl }
      : {}),
  };
}

function checkoutCustomerToMetadata(customer: CheckoutCustomerInput | undefined): JsonObject {
  return {
    ...(customer?.email?.trim()
      ? { [CHECKOUT_CUSTOMER_EMAIL_METADATA_KEY]: customer.email.trim() }
      : {}),
    ...(customer?.name?.trim()
      ? { [CHECKOUT_CUSTOMER_NAME_METADATA_KEY]: customer.name.trim() }
      : {}),
    ...(customer?.company?.trim()
      ? { [CHECKOUT_CUSTOMER_COMPANY_METADATA_KEY]: customer.company.trim() }
      : {}),
    ...(customer?.vatId?.trim()
      ? { [CHECKOUT_CUSTOMER_VAT_ID_METADATA_KEY]: customer.vatId.trim() }
      : {}),
  };
}

export function checkoutCustomerFromMetadata(
  metadata: JsonObject | undefined,
): CheckoutCustomerInput {
  const email = metadataString(metadata, CHECKOUT_CUSTOMER_EMAIL_METADATA_KEY);
  const name = metadataString(metadata, CHECKOUT_CUSTOMER_NAME_METADATA_KEY);
  const company = metadataString(metadata, CHECKOUT_CUSTOMER_COMPANY_METADATA_KEY);
  const vatId = metadataString(metadata, CHECKOUT_CUSTOMER_VAT_ID_METADATA_KEY);

  return {
    ...(email ? { email } : {}),
    ...(name ? { name } : {}),
    ...(company ? { company } : {}),
    ...(vatId ? { vatId } : {}),
  };
}

function checkoutCustomMetadata(customFields: JsonObject | undefined): JsonObject {
  return filterJsonObject(customFields, CHECKOUT_INTERNAL_METADATA_KEYS);
}

function checkoutPersistedCustomMetadata(customFields: JsonObject | undefined): JsonObject {
  return filterJsonObject(customFields, CHECKOUT_PERSISTED_METADATA_OMIT_KEYS);
}

function filterJsonObject(
  value: JsonObject | undefined,
  omittedKeys: ReadonlySet<string>,
): JsonObject {
  const filtered: Record<string, JsonValue> = {};
  for (const [key, child] of Object.entries(value ?? {})) {
    if (!omittedKeys.has(key)) {
      filtered[key] = child;
    }
  }

  return filtered;
}

export async function checkoutIdempotencyInputHash(
  input: CreateMikaBackendApiInput,
  ctx: MikaRequestContext,
  checkoutInput: StartCheckoutInput,
): Promise<string> {
  return input.hash(
    stableJsonStringify({
      context: {
        customerId: ctx.customerId,
        sessionId: ctx.sessionId,
        userId: ctx.userId,
      },
      input: checkoutInput,
    }),
  );
}

export function checkoutStoredIdempotencyInputHash(document: CheckoutDocument): string | undefined {
  return (
    document.checkoutIdempotencyInputHash ??
    metadataString(document.aggregate.metadata, CHECKOUT_IDEMPOTENCY_INPUT_HASH_METADATA_KEY)
  );
}

export function checkoutDocumentResult(
  document: CheckoutDocument,
): MikaApiResult<CheckoutSessionDTO> {
  if (document.status === "failed") {
    return checkoutFailedReplay(document.id);
  }

  return checkoutDocumentSuccessResult(document);
}

export async function checkoutStatus(
  input: CreateMikaBackendApiInput,
  ctx: MikaRequestContext,
  statusInput: CheckoutStatusInput,
): Promise<MikaApiResult<CheckoutSessionDTO>> {
  const checkoutId = createMikaId(statusInput.checkoutId);
  const document = await input.repositories.session.findCheckoutById(checkoutId);
  if (!document) return invalidCheckout("checkoutId", checkoutId);

  const accessError = await checkoutStatusAccessError(input, ctx, document, statusInput.token);
  if (accessError) return accessError;

  const bindingError = checkoutBindingError(document);
  if (bindingError) return bindingError;

  if (checkoutIsExpired(input, document)) {
    const expired = await expireCheckoutDocument(input, document, ctx.now);
    return checkoutStatusExpired(expired);
  }

  return checkoutDocumentSuccessResult(document);
}

export async function expireCheckoutDocument(
  input: CreateMikaBackendApiInput,
  document: CheckoutDocument,
  now: ISODateTime,
): Promise<CheckoutDocument> {
  if (
    document.status === "completed" ||
    document.orderId ||
    !checkoutStatusCanExpire(document.status)
  ) {
    return document;
  }

  const reservationIds = document.aggregate.lines
    .map((line) => line.reservationId)
    .filter((id): id is MikaId => Boolean(id));
  if (reservationIds.length > 0) {
    await expireCheckoutReservations(input, reservationIds, now);
  }

  if (document.status === "expired" && document.providerStatus === "expired") return document;

  const expired: CheckoutDocument = {
    ...document,
    status: "expired",
    providerStatus: "expired",
    updatedAt: now,
  };
  await input.repositories.session.put(expired);

  return expired;
}

export async function cancelCheckout(
  input: CreateMikaBackendApiInput,
  ctx: MikaRequestContext,
  cancelInput: CheckoutCancelInput,
): Promise<MikaApiResult<CheckoutSessionDTO>> {
  const checkoutId = createMikaId(cancelInput.checkoutId);
  const document = await input.repositories.session.findCheckoutById(checkoutId);
  if (!document) return invalidCheckout("checkoutId", checkoutId);

  const accessError = await checkoutCancelAccessError(input, ctx, document, cancelInput.token);
  if (accessError) return accessError;

  if (document.status === "completed" || document.orderId) {
    return checkoutDocumentSuccessResult(document);
  }
  if (
    document.status === "cancelled" ||
    document.status === "expired" ||
    document.status === "failed"
  ) {
    return checkoutDocumentSuccessResult(document);
  }

  const reservationIds = document.aggregate.lines
    .map((line) => line.reservationId)
    .filter((id): id is MikaId => Boolean(id));
  if (reservationIds.length > 0) {
    await expireCheckoutReservations(input, reservationIds, ctx.now);
  }

  const current = await input.repositories.session.findCheckoutById(checkoutId);
  if (!current) return invalidCheckout("checkoutId", checkoutId);
  if (current.status === "completed" || current.orderId) {
    return checkoutDocumentSuccessResult(current);
  }
  if (
    current.status === "cancelled" ||
    current.status === "expired" ||
    current.status === "failed"
  ) {
    return checkoutDocumentSuccessResult(current);
  }

  const cancelled: CheckoutDocument = {
    ...current,
    status: "cancelled",
    providerStatus: "cancelled",
    updatedAt: ctx.now,
  };
  await input.repositories.session.put(cancelled);

  const stored = await input.repositories.session.findCheckoutById(checkoutId);
  if (!stored) return invalidCheckout("checkoutId", checkoutId);
  if (stored.status === "completed" || stored.orderId) {
    return checkoutDocumentSuccessResult(stored);
  }

  const cartDocument = stored.cartId
    ? await input.repositories.session.findById(stored.cartId)
    : null;
  if (cartDocument && cartDocument.type === "cart" && cartDocument.status === "checkout_pending") {
    await input.repositories.session.put(reopenCartDocument(cartDocument, ctx.now));
  }

  return checkoutDocumentSuccessResult(cancelled);
}

export function checkoutDocumentSuccessResult(
  document: CheckoutDocument,
): MikaApiResult<CheckoutSessionDTO> {
  const rawRedirectUrl =
    document.redirectUrl ?? metadataString(document.aggregate.metadata, "checkoutRedirectUrl");
  const status =
    document.providerStatus ??
    metadataString(document.aggregate.metadata, "checkoutProviderStatus") ??
    checkoutSessionStatus(document.status);
  const sessionStatus = checkoutSessionStatus(status);
  const redirectUrl = checkoutStatusAllowsRedirect(document.status, sessionStatus)
    ? rawRedirectUrl
    : undefined;
  const orderId =
    document.orderId ?? metadataMikaId(document.aggregate.metadata, "checkoutOrderId");

  return {
    ok: true,
    status: 200,
    data: {
      id: document.id,
      status: sessionStatus,
      mode: document.aggregate.mode,
      provider: document.provider,
      redirectUrl,
      expiresAt: document.expiresAt,
      paymentPending: status === "pending" ? true : undefined,
      orderId,
    },
    effects: redirectUrl ? [{ type: "redirect", url: redirectUrl }] : undefined,
  };
}

function checkoutStatusAllowsRedirect(
  documentStatus: CheckoutStatus,
  sessionStatus: CheckoutSessionDTO["status"],
): boolean {
  if (
    documentStatus === "cancelled" ||
    documentStatus === "expired" ||
    documentStatus === "failed"
  ) {
    return false;
  }

  return (
    sessionStatus === "created" ||
    sessionStatus === "redirected" ||
    sessionStatus === "pending" ||
    sessionStatus === "completed"
  );
}

function checkoutBindingError(document: CheckoutDocument): MikaApiFailure | null {
  if (
    document.provider === document.aggregate.binding.provider &&
    document.providerCheckoutId === document.aggregate.binding.providerCheckoutId
  ) {
    return null;
  }

  return {
    ok: false,
    status: 409,
    error: {
      code: "CHECKOUT_BINDING_MISMATCH",
      message: `Checkout '${document.id}' binding does not match stored provider state.`,
    },
  };
}

export function checkoutIsExpired(
  input: CreateMikaBackendApiInput,
  document: CheckoutDocument,
): boolean {
  if (document.status === "expired") return true;
  if (!checkoutStatusCanExpire(document.status)) return false;
  if (!document.expiresAt) return false;

  return new Date(document.expiresAt).getTime() <= input.now().getTime();
}

function checkoutStatusCanExpire(status: CheckoutStatus): boolean {
  return status === "created" || status === "redirected";
}

export function checkoutStatusExpired(document: CheckoutDocument): MikaApiFailure {
  return {
    ok: false,
    status: 409,
    error: {
      code: "CHECKOUT_EXPIRED",
      message: `Checkout '${document.id}' has expired.`,
    },
  };
}

function checkoutFailedMetadata(metadata: JsonObject | undefined): JsonObject {
  return {
    ...Object.fromEntries(
      Object.entries(metadata ?? {}).filter(
        ([key]) => key !== "checkoutRedirectUrl" && key !== "checkoutProviderStatus",
      ),
    ),
    checkoutPersistenceFailed: true,
    checkoutProviderStatus: "failed",
  };
}

function checkoutReservationIdempotencyKey(
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

function cartWithCheckoutReservations(
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
    cart.aggregate.items.map((item) => ({
      ...item,
      reservationId: reservationByCartLineId.get(item.id) ?? item.reservationId,
    })),
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

function checkoutLineToProviderLine(
  provider: ProviderName,
  line: CheckoutLine,
): MikaProviderLineItem {
  const providerRef = line.item.providerRefs?.find((ref) => ref.provider === provider);

  return {
    sellableId: line.item.sellableId,
    priceId: line.item.priceId,
    contentRef: line.item.content,
    sku: line.item.sku,
    title: line.item.titleSnapshot,
    variantKey: line.item.variantKey,
    variantOptions: line.item.variantOptions,
    providerProductId: providerRef?.productId,
    providerPriceId: providerRef?.priceId,
    quantity: line.quantity,
    unitAmount: line.item.unitAmount,
    currency: line.item.currency,
    mode: line.item.mode,
    fulfillmentKind: line.item.fulfillmentKind,
    entitlementKey: line.item.entitlementKey,
    interval: line.item.interval,
    intervalCount: line.item.intervalCount,
    metadata: line.metadata ?? line.item.metadata,
  };
}

function checkoutSuccessUrl(
  input: CreateMikaBackendApiInput,
  ctx: MikaRequestContext,
  checkoutInput: StartCheckoutInput,
  checkoutId: MikaId,
  statusToken: string,
): string {
  const url = new URL(checkoutSuccessTarget(input, ctx, checkoutInput), ctx.url);
  url.searchParams.set("checkoutId", checkoutId);
  url.searchParams.set("token", statusToken);

  return url.toString();
}

function checkoutCancelUrl(
  input: CreateMikaBackendApiInput,
  ctx: MikaRequestContext,
  checkoutInput: StartCheckoutInput,
  checkoutId: MikaId,
  statusToken: string,
): string {
  const url = new URL(checkoutCancelTarget(input, ctx, checkoutInput), ctx.url);
  url.searchParams.set("checkoutId", checkoutId);
  url.searchParams.set("token", statusToken);

  return url.toString();
}

function checkoutSuccessTarget(
  input: CreateMikaBackendApiInput,
  ctx: MikaRequestContext,
  checkoutInput: StartCheckoutInput,
): string {
  return checkoutInput.successPath === undefined
    ? (input.config?.checkout?.successUrl ?? "/checkout/success")
    : safeRequestReturnPath(ctx, checkoutInput.successPath, "/checkout/success");
}

function checkoutCancelTarget(
  input: CreateMikaBackendApiInput,
  ctx: MikaRequestContext,
  checkoutInput: StartCheckoutInput,
): string {
  return checkoutInput.cancelPath === undefined
    ? (input.config?.checkout?.cancelUrl ?? "/checkout/cancel")
    : safeRequestReturnPath(ctx, checkoutInput.cancelPath, "/checkout/cancel");
}

export function checkoutExpiresAt(
  input: CreateMikaBackendApiInput,
  ctx: MikaRequestContext,
): ISODateTime {
  const ttlMs = input.config?.checkout?.ttlMs ?? 15 * 60_000;

  return createISODateTime(new Date(new Date(ctx.now).getTime() + ttlMs).toISOString());
}

export function checkoutDocumentStatus(status: CheckoutSessionDTO["status"]): CheckoutStatus {
  return status === "pending" ? "created" : status === "binding_mismatch" ? "failed" : status;
}

export function checkoutSessionStatus(status: string): CheckoutSessionDTO["status"] {
  return status === "created" ||
    status === "redirected" ||
    status === "pending" ||
    status === "completed" ||
    status === "cancelled" ||
    status === "expired" ||
    status === "failed" ||
    status === "binding_mismatch"
    ? status
    : "failed";
}

export async function createCheckoutPreview(
  input: CreateMikaBackendApiInput,
  ctx: MikaRequestContext,
  previewInput: CheckoutPreviewInput,
): Promise<CheckoutPreviewDTO> {
  const quote = await createCartQuote(input, ctx, previewInput);
  const mode = await resolveCheckoutPreviewMode(input, ctx, previewInput);
  const provider = previewInput.provider ?? input.defaults?.provider;
  const inputHash = await delegatedPaymentProofHash(input, previewInput, quote, mode, provider);
  const hasPaymentAuthorization =
    previewInput.proofRefs?.some(
      (proof) =>
        proof.kind === "payment_authorization" &&
        proof.inputHash !== undefined &&
        proof.inputHash === inputHash,
    ) ?? false;
  const requiredProofs = [
    {
      kind: "payment_authorization" as const,
      required: true,
      reason: "Checkout start requires payment confirmation before provider handoff.",
      inputHash,
      expiresAt: quote.expiresAt,
    },
  ];
  const status =
    quote.status === "expired"
      ? "expired"
      : quote.status === "unavailable"
        ? "unavailable"
        : hasPaymentAuthorization
          ? "ready"
          : "requires_payment_authorization";

  return {
    id: input.createId("checkout_preview"),
    quoteId: previewInput.quoteId ?? quote.id,
    status,
    mode,
    provider,
    quote,
    requiredProofs,
    acceptedProofs: ["consent", "mandate", "payment_authorization"],
    proofRefs: previewInput.proofRefs,
    expiresAt: quote.expiresAt,
    inputHash,
    warnings: quote.warnings,
    errors: quote.errors,
  };
}

async function delegatedPaymentProofHash(
  input: CreateMikaBackendApiInput,
  checkoutInput: StartCheckoutInput,
  quote: CartQuoteDTO,
  mode: PurchaseMode | undefined,
  provider: ProviderName | undefined,
): Promise<string> {
  return input.hash(
    stableJsonStringify(delegatedPaymentProofProjection(checkoutInput, quote, mode, provider)),
  );
}

function delegatedPaymentProofProjection(
  checkoutInput: StartCheckoutInput,
  quote: CartQuoteDTO,
  mode: PurchaseMode | undefined,
  provider: ProviderName | undefined,
): unknown {
  return {
    cartId: checkoutInput.cartId ?? quote.cartId,
    sellableId: checkoutInput.sellableId,
    priceId: checkoutInput.priceId,
    quantity: checkoutInput.quantity,
    provider,
    couponCode: checkoutInput.couponCode,
    mode,
    customer: checkoutInput.customer,
    customFields: delegatedPaymentProofCustomFields(checkoutInput.customFields),
    successPath: checkoutInput.successPath,
    cancelPath: checkoutInput.cancelPath,
    returnTo: checkoutInput.returnTo,
    quote: {
      cartId: quote.cartId,
      status: quote.status,
      currency: quote.currency,
      items: quote.items,
      subtotal: quote.subtotal,
      discount: quote.discount,
      tax: quote.tax,
      shipping: quote.shipping,
      total: quote.total,
      adjustments: quote.adjustments,
      coupon: quote.coupon,
      expiresAt: quote.expiresAt,
      warnings: quote.warnings,
      errors: quote.errors,
    },
  } satisfies Record<string, unknown>;
}

function delegatedPaymentProofCustomFields(
  customFields: JsonObject | undefined,
): JsonObject | undefined {
  const filtered = filterJsonObject(
    checkoutCustomMetadata(customFields),
    DELEGATED_PAYMENT_PROOF_VOLATILE_METADATA_KEYS,
  );

  return Object.keys(filtered).length > 0 ? filtered : undefined;
}

export async function resolveCheckoutPreviewMode(
  input: CreateMikaBackendApiInput,
  ctx: MikaRequestContext,
  previewInput: CheckoutPreviewInput,
): Promise<PurchaseMode | undefined> {
  if (previewInput.sellableId) {
    const catalog = await input.repositories.catalog.findItemBySellableId(previewInput.sellableId);
    const sellable = catalog?.aggregate.sellables.find(
      (item) => item.id === previewInput.sellableId,
    );
    return sellable
      ? selectCartPrice(sellable, previewInput.priceId, defaultBackendCurrency(input))?.mode
      : undefined;
  }

  const cartResult = await findQuoteCart(
    input,
    ctx,
    previewInput.cartId,
    defaultBackendCurrency(input),
  );
  const modes = new Set(cartResult.cart?.aggregate.items.map((line) => line.item.mode) ?? []);
  return modes.size === 1 ? modes.values().next().value : undefined;
}
