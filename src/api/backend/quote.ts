/**
 * Cart/wishlist quoting: resolving carts and their lines to priced, availability-checked DTOs,
 * coupon resolution, and the small pure helpers (price selection, quantity limits, line/item
 * equivalence) that both the quote path and the cart/wishlist mutation handlers share.
 */
import { omitUndefined } from "../../internal/object";
import {
  cartToDTO,
  cartWithItems,
  couponDiscountAmount,
  snapshotPrice,
  stockAvailabilityToDTO,
  wishlistToDTO,
} from "../../model/builders";
import { nextCartVersion } from "../../model/cart-version";
import type {
  CartLine,
  CouponSnapshot,
  PriceDefinition,
  SellableDefinition,
  WishlistItem,
} from "../../types/aggregates";
import type { CartDocument, CheckoutDocument, WishlistDocument } from "../../types/documents";
import type { StockItemRecord } from "../../types/operational";
import { createSellableId } from "../../types/primitives";
import type { CurrencyCode, ISODateTime, MikaId, SellableId } from "../../types/primitives";
import type { MikaRequestContext } from "../context";
import type {
  AddCartItemInput,
  CartDTO,
  CartQuoteDTO,
  CartQuoteInput,
  CartQuoteLineDTO,
  MikaError,
  WishlistDTO,
  WishlistItemInput,
} from "../types";
import { validationFailed } from "./errors";
import type { MikaApiFailure } from "./errors";
import {
  currentBackendISODateTime,
  defaultBackendCurrency,
  metadataMikaId,
  metadataString,
  moneyDTO,
} from "./shared";
import { expireCheckoutReservations } from "./stock-lifecycle";
import { checkoutStatusIsTerminal } from "../lifecycle";
import type { MikaBackendDependencies, MikaBackendRepositories, MikaCouponResolver } from "./ports";

export type MikaCartWishlistBackendRepositories = Pick<
  MikaBackendRepositories,
  "account" | "catalog" | "session" | "stock" | "ephemeral"
>;
export type MikaCartWishlistBackendInput = Omit<MikaBackendDependencies, "repositories"> & {
  readonly repositories: MikaCartWishlistBackendRepositories;
};

export async function findOpenCart(
  input: MikaCartWishlistBackendInput,
  ctx: MikaRequestContext,
  currency: CurrencyCode,
): Promise<CartDocument | null> {
  const open = ctx.customerId
    ? await input.repositories.session.findOpenCartByCustomer(ctx.customerId, currency)
    : ctx.sessionId
      ? await input.repositories.session.findOpenCartBySession(ctx.sessionId, currency)
      : null;
  if (open) return open;

  return reopenAbandonedCheckoutCart(input, ctx, currency);
}

async function reopenAbandonedCheckoutCart(
  input: MikaCartWishlistBackendInput,
  ctx: MikaRequestContext,
  currency: CurrencyCode,
): Promise<CartDocument | null> {
  const pending = ctx.customerId
    ? await input.repositories.session.findCheckoutPendingCartByCustomer(ctx.customerId, currency)
    : ctx.sessionId
      ? await input.repositories.session.findCheckoutPendingCartBySession(ctx.sessionId, currency)
      : null;
  if (!pending) return null;
  if (cartHasActiveCheckoutStartClaim(pending, ctx.now)) return pending;

  const checkoutId = metadataMikaId(pending.aggregate.metadata, "checkoutSessionId");
  const checkout = checkoutId
    ? await input.repositories.session.findCheckoutById(checkoutId)
    : null;
  if (checkout && checkout.status === "completed") {
    return null;
  }
  if (checkout && checkoutIsResumable(checkout, ctx.now)) return pending;

  const reservationIds = pending.aggregate.items
    .map((item) => item.reservationId)
    .filter((id): id is MikaId => Boolean(id));
  if (reservationIds.length > 0) {
    await expireCheckoutReservations(input, reservationIds, ctx.now);
  }

  const reopened = reopenCartDocument(pending, ctx.now);
  await input.repositories.session.put(reopened);

  return reopened;
}

function checkoutIsResumable(checkout: CheckoutDocument, now: ISODateTime): boolean {
  // Only the non-terminal statuses (created/redirected) are resumable.
  if (checkoutStatusIsTerminal(checkout.status)) return false;
  if (!checkout.expiresAt) return true;

  return new Date(checkout.expiresAt).getTime() > new Date(now).getTime();
}

function cartHasActiveCheckoutStartClaim(cart: CartDocument, now: ISODateTime): boolean {
  const claimId = metadataString(cart.aggregate.metadata, "checkoutStartClaimId");
  if (!claimId) return false;
  const claimExpiresAt = metadataString(cart.aggregate.metadata, "checkoutStartClaimExpiresAt");

  return !claimExpiresAt || new Date(claimExpiresAt).getTime() > new Date(now).getTime();
}

export function reopenCartDocument(cart: CartDocument, now: ISODateTime): CartDocument {
  const { checkoutSessionId: _checkoutSessionId, ...metadata } = cart.aggregate.metadata ?? {};

  return {
    ...cart,
    status: "open",
    updatedAt: now,
    version: nextCartVersion(cart.version),
    aggregate: {
      ...cart.aggregate,
      items: cart.aggregate.items.map((item) => {
        if (!item.reservationId) return item;
        const { reservationId: _reservationId, ...rest } = item;
        return rest;
      }),
      metadata,
    },
  };
}

export async function createCartQuote(
  input: MikaCartWishlistBackendInput,
  ctx: MikaRequestContext,
  quoteInput: CartQuoteInput,
): Promise<CartQuoteDTO> {
  const defaultCurrency = defaultBackendCurrency(input);
  const cartResult = await findQuoteCart(input, ctx, quoteInput.cartId, defaultCurrency);
  const currency = cartResult.cart?.aggregate.currency ?? defaultCurrency;
  const warnings: string[] = [];
  const errors: MikaError[] = [];
  const quoteLines: CartQuoteLineDTO[] = [];
  let changed = false;
  let unavailable = false;
  let coupon = cartResult.cart?.aggregate.coupon;
  let quotedCouponLabel: string | undefined;

  if (quoteInput.couponCode !== undefined) {
    const normalizedCode = quoteInput.couponCode.trim();
    if (normalizedCode) {
      quotedCouponLabel = normalizedCode.toUpperCase();
      // Compare by code hash: resolver labels are host-controlled display text, so a stored
      // snapshot's label may legitimately differ from the uppercased code.
      const quotedCouponCodeHash = await input.hash(`coupon:${quotedCouponLabel}`);
      changed =
        !coupon ||
        (coupon.codeHash !== undefined
          ? coupon.codeHash !== quotedCouponCodeHash
          : coupon.label !== quotedCouponLabel);
    } else if (coupon) {
      changed = true;
      coupon = undefined;
    }
  }

  const cartLines = cartResult.cart?.aggregate.items ?? [];
  for (const line of cartLines) {
    const quoted = await quoteCartLine(input, line, {
      quantityForLimit: line.quantity + siblingSellableQuantity(cartLines, line),
    });
    quoteLines.push(quoted.line);
    changed = changed || quoted.changed;
    unavailable = unavailable || quoted.unavailable;
  }

  if (quoteInput.cartId && quoteInput.sellableId) {
    unavailable = true;
    const message = "Provide either a cartId or a sellableId for checkout, not both.";
    warnings.push(message);
    errors.push({
      code: "VALIDATION_FAILED",
      message,
      fieldErrors: { sellableId: message },
    });
  } else if (quoteInput.sellableId) {
    const quoted = await quoteInputLine(input, quoteInput, currency);
    quoteLines.push(quoted.line);
    unavailable = unavailable || quoted.unavailable;
  }

  if (quoteLines.length === 0) {
    unavailable = true;
    warnings.push("Cart quote is empty.");
    errors.push({
      code: "CHECKOUT_EMPTY",
      message: "Cart quote is empty.",
    });
  }

  if (cartResult.expired) {
    warnings.push("Cart quote has expired.");
    errors.push({
      code: "CHECKOUT_EXPIRED",
      message: "Cart quote has expired.",
    });
  }

  const subtotalAmount = quoteLines.reduce((sum, line) => sum + (line.subtotal?.amount ?? 0), 0);
  if (quotedCouponLabel !== undefined) {
    const resolved = await couponSnapshotForSubtotal(
      input,
      quotedCouponLabel,
      subtotalAmount,
      currency,
    );
    if (resolved) {
      coupon = resolved;
    } else {
      // checkout.start deterministically rejects this coupon, so the quote must not advertise a
      // proceedable status either.
      unavailable = true;
      if (coupon) changed = true;
      coupon = undefined;
      const message = couponRejectionMessage(input, quotedCouponLabel);
      warnings.push(message);
      errors.push({
        code: "VALIDATION_FAILED",
        message,
        fieldErrors: { couponCode: message },
      });
    }
  }
  const discountAmount = couponDiscountAmount(coupon, subtotalAmount);
  const totalAmount = Math.max(0, subtotalAmount - discountAmount);
  const status = cartResult.expired
    ? "expired"
    : unavailable
      ? "unavailable"
      : changed
        ? "changed"
        : "valid";

  return omitUndefined({
    id: input.createId("cart_quote"),
    cartId: cartResult.cart?.id,
    status,
    currency,
    items: quoteLines,
    subtotal: moneyDTO(subtotalAmount, currency),
    discount: discountAmount > 0 ? moneyDTO(discountAmount, currency) : undefined,
    total: moneyDTO(totalAmount, currency),
    adjustments:
      discountAmount > 0
        ? [
            omitUndefined({
              type: "discount",
              label: coupon?.label,
              amount: moneyDTO(discountAmount, currency),
            }),
          ]
        : undefined,
    coupon: coupon
      ? omitUndefined({
          label: coupon.label,
          discount: discountAmount > 0 ? moneyDTO(discountAmount, currency) : undefined,
          providerCouponId: coupon.providerRef?.priceId,
        })
      : undefined,
    expiresAt: cartResult.cart?.expiresAt,
    inputHash: await input.hash(
      JSON.stringify({
        cartId: cartResult.cart?.id,
        sellableId: quoteInput.sellableId,
        priceId: quoteInput.priceId,
        quantity: quoteInput.quantity,
        couponCode: quoteInput.couponCode,
        currency,
      }),
    ),
    warnings: warnings.length > 0 ? warnings : undefined,
    errors: errors.length > 0 ? errors : undefined,
  });
}

export async function findQuoteCart(
  input: MikaCartWishlistBackendInput,
  ctx: MikaRequestContext,
  cartId: MikaId | undefined,
  currency: CurrencyCode,
): Promise<{ readonly cart: CartDocument | null; readonly expired: boolean }> {
  const cart = cartId
    ? await findOwnedCartById(input, ctx, cartId)
    : await findOpenCart(input, ctx, currency);
  if (!cart) return { cart: null, expired: false };

  const expired =
    cart.status === "expired" ||
    (cart.expiresAt !== undefined &&
      new Date(cart.expiresAt).getTime() <= new Date(ctx.now).getTime());

  return { cart, expired };
}

async function findOwnedCartById(
  input: MikaCartWishlistBackendInput,
  ctx: MikaRequestContext,
  cartId: MikaId,
): Promise<CartDocument | null> {
  const document = await input.repositories.session.findById(cartId);
  if (!document || document.type !== "cart") return null;
  if (!callerOwnsMergeSource(ctx, document)) return null;

  return document;
}

async function quoteCartLine(
  input: MikaCartWishlistBackendInput,
  line: CartLine,
  options: { readonly quantityForLimit?: number } = {},
): Promise<{
  readonly line: CartQuoteLineDTO;
  readonly changed: boolean;
  readonly unavailable: boolean;
}> {
  const catalog = await input.repositories.catalog.findItemBySellableId(line.item.sellableId);
  const sellable = catalog?.aggregate.sellables.find((item) => item.id === line.item.sellableId);
  const stock = await input.repositories.stock.findBySellableId(line.item.sellableId);
  const availability = sellable ? stockAvailabilityToDTO(sellable, stock ?? undefined) : undefined;
  const warnings: string[] = [];
  let changed = false;
  let unavailable = false;
  let unitAmount = line.item.unitAmount;
  let title = line.item.titleSnapshot;
  let sku = line.item.sku;
  let variantOptions = line.item.variantOptions;

  if (!sellable?.active) {
    unavailable = true;
    warnings.push(`Sellable '${line.item.sellableId}' is unavailable.`);
  } else {
    const price = selectCartPrice(sellable, line.item.priceId, line.item.currency);
    if (!price) {
      unavailable = true;
      warnings.push(`Price for sellable '${sellable.id}' is unavailable.`);
    } else {
      title = price.titleSnapshot ?? sellable.titleSnapshot ?? title;
      sku = price.sku ?? sellable.sku;
      variantOptions = sellable.variantOptions;
      if (
        price.amount !== line.item.unitAmount ||
        title !== line.item.titleSnapshot ||
        sku !== line.item.sku
      ) {
        changed = true;
        warnings.push("Line details changed since it was added to the cart.");
      }
      unitAmount = price.amount;
    }

    const quantityError = validateQuantityLimit(
      sellable,
      stock,
      options.quantityForLimit ?? line.quantity,
    );
    if (quantityError) {
      unavailable = true;
      warnings.push(quantityError.error.message);
    }
  }

  const subtotalAmount = unitAmount * line.quantity;

  return {
    line: omitUndefined({
      lineId: line.id,
      sellableId: line.item.sellableId,
      priceId: line.item.priceId,
      title,
      sku,
      variantOptions,
      quantity: line.quantity,
      unitAmount: moneyDTO(unitAmount, line.item.currency),
      subtotal: moneyDTO(subtotalAmount, line.item.currency),
      total: moneyDTO(subtotalAmount, line.item.currency),
      availability,
      warnings: warnings.length > 0 ? warnings : undefined,
    }),
    changed,
    unavailable,
  };
}

async function quoteInputLine(
  input: MikaCartWishlistBackendInput,
  quoteInput: CartQuoteInput,
  currency: CurrencyCode,
): Promise<{
  readonly line: CartQuoteLineDTO;
  readonly unavailable: boolean;
}> {
  const quantity = quoteInput.quantity ?? 1;
  const catalog = quoteInput.sellableId
    ? await input.repositories.catalog.findItemBySellableId(quoteInput.sellableId)
    : null;
  const sellable = catalog?.aggregate.sellables.find((item) => item.id === quoteInput.sellableId);
  const stock = quoteInput.sellableId
    ? await input.repositories.stock.findBySellableId(quoteInput.sellableId)
    : null;
  const availability = sellable ? stockAvailabilityToDTO(sellable, stock ?? undefined) : undefined;
  const warnings: string[] = [];
  let unavailable = false;
  let price: PriceDefinition | null = null;

  if (!sellable?.active) {
    unavailable = true;
    warnings.push(`Sellable '${quoteInput.sellableId}' is unavailable.`);
  } else {
    price = selectCartPrice(sellable, quoteInput.priceId, currency);
    if (!price) {
      unavailable = true;
      warnings.push(`Price for sellable '${sellable.id}' is unavailable.`);
    } else if (price.currency !== currency) {
      warnings.push(`Price '${price.id}' uses currency '${price.currency}'.`);
      price = null;
      unavailable = true;
    }
    const quantityError = validateQuantityLimit(sellable, stock, quantity);
    if (quantityError) {
      unavailable = true;
      warnings.push(quantityError.error.message);
    }
  }

  const unitAmount = price?.amount ?? 0;
  const subtotalAmount = unitAmount * quantity;

  return {
    line: omitUndefined({
      sellableId: quoteInput.sellableId ?? createSellableId("sellable_missing"),
      priceId: price?.id ?? quoteInput.priceId,
      title: sellable?.titleSnapshot,
      sku: price?.sku ?? sellable?.sku,
      variantOptions: sellable?.variantOptions,
      quantity,
      unitAmount: price ? moneyDTO(unitAmount, currency) : undefined,
      subtotal: price ? moneyDTO(subtotalAmount, currency) : undefined,
      total: price ? moneyDTO(subtotalAmount, currency) : undefined,
      availability,
      warnings: warnings.length > 0 ? warnings : undefined,
    }),
    unavailable,
  };
}

export function updateCartDocument(
  cart: CartDocument,
  items: readonly CartLine[],
  updatedAt: ISODateTime,
  coupon?: CouponSnapshot,
): CartDocument {
  return {
    ...cart,
    updatedAt,
    version: nextCartVersion(cart.version),
    aggregate: cartWithItems(omitUndefined({ cart: cart.aggregate, items, coupon })),
  };
}

export function callerOwnsMergeSource(
  ctx: MikaRequestContext,
  source: { readonly customerId?: MikaId; readonly sessionId?: string },
): boolean {
  if (source.customerId) {
    return Boolean(ctx.customerId) && source.customerId === ctx.customerId;
  }
  if (source.sessionId) {
    return Boolean(ctx.sessionId) && source.sessionId === ctx.sessionId;
  }
  return false;
}

/** Fixed-rate coupon resolver for demos and tests: accepts every code at the given rate. */
export function createMikaFixedRateCouponResolver(
  options: { readonly rate?: number; readonly label?: string } = {},
): MikaCouponResolver {
  const rate = options.rate ?? 0.1;

  return ({ code }) => ({ label: options.label ?? code, rate });
}

export async function couponSnapshotForSubtotal(
  input: Pick<MikaBackendDependencies, "hash" | "config">,
  code: string,
  subtotalAmount: number,
  currency: CurrencyCode,
): Promise<CouponSnapshot | null> {
  const resolver = input.config?.coupons?.resolver;
  if (!resolver) return null;

  const normalizedCode = code.toUpperCase();
  const resolution = await resolver({ code: normalizedCode, subtotalAmount, currency });
  if (!resolution) return null;
  if (!Number.isFinite(resolution.rate) || resolution.rate < 0 || resolution.rate > 1) {
    throw new RangeError(
      `Coupon resolver returned invalid rate '${resolution.rate}' for code '${normalizedCode}'.`,
    );
  }

  return {
    codeHash: await input.hash(`coupon:${normalizedCode}`),
    label: resolution.label || normalizedCode,
    rate: resolution.rate,
    discountAmount: Math.floor(subtotalAmount * resolution.rate),
    ...(resolution.metadata !== undefined ? { metadata: resolution.metadata } : {}),
  };
}

export function couponRejectionMessage(
  input: Pick<MikaBackendDependencies, "config">,
  label: string,
): string {
  return input.config?.coupons?.resolver
    ? `Coupon code '${label}' is not valid.`
    : "Coupon codes are not supported.";
}

export async function createCouponSnapshot(
  input: MikaCartWishlistBackendInput,
  cart: CartDocument,
  code: string,
): Promise<CouponSnapshot | null> {
  const subtotalAmount = cart.aggregate.items.reduce(
    (sum, line) => sum + line.item.unitAmount * line.quantity,
    0,
  );

  return couponSnapshotForSubtotal(input, code, subtotalAmount, cart.aggregate.currency);
}

export async function cartDocumentToDTO(
  input: MikaCartWishlistBackendInput,
  cart: CartDocument,
): Promise<CartDTO> {
  const availabilityBySellableId = await loadAvailabilityBySellableId(
    input,
    cart.aggregate.items.map((line) => line.item.sellableId),
  );

  return cartToDTO({
    id: cart.id,
    status: cart.status,
    cart: cart.aggregate,
    availabilityBySellableId,
  });
}

export async function wishlistDocumentToDTO(
  input: MikaCartWishlistBackendInput,
  wishlist: WishlistDocument,
): Promise<WishlistDTO> {
  const availabilityBySellableId = await loadAvailabilityBySellableId(
    input,
    wishlist.aggregate.items.map((item) => item.item.sellableId),
  );

  return wishlistToDTO({
    id: wishlist.id,
    wishlist: wishlist.aggregate,
    availabilityBySellableId,
  });
}

async function loadAvailabilityBySellableId(
  input: MikaCartWishlistBackendInput,
  sellableIds: readonly SellableId[],
) {
  const uniqueSellableIds = [...new Set(sellableIds)];
  const stockRecords = await Promise.all(
    uniqueSellableIds.map(async (sellableId) => ({
      sellableId,
      stock: await input.repositories.stock.findBySellableId(sellableId),
    })),
  );

  return new Map(
    stockRecords
      .flatMap((record) =>
        record.stock
          ? [
              [
                record.sellableId,
                stockAvailabilityToDTO(stockAvailabilitySellable(record.sellableId), record.stock),
              ] as const,
            ]
          : [],
      )
      .filter((entry): entry is readonly [SellableId, NonNullable<(typeof entry)[1]>] =>
        Boolean(entry[1]),
      ),
  );
}

function stockAvailabilitySellable(sellableId: SellableId): SellableDefinition {
  return {
    id: sellableId,
    active: true,
    sortOrder: 0,
    variantOptions: [],
    prices: [],
  };
}

export async function resolveCartLine(
  input: MikaCartWishlistBackendInput,
  itemInput: AddCartItemInput,
  cartCurrency: CurrencyCode,
): Promise<
  | {
      readonly ok: true;
      readonly line: CartLine;
      readonly sellable: SellableDefinition;
      readonly stock: StockItemRecord | null;
    }
  | MikaApiFailure
> {
  const quantity = itemInput.quantity ?? 1;
  if (!Number.isInteger(quantity) || quantity < 1) {
    return validationFailed("quantity", "Quantity must be a positive whole number.");
  }

  const catalog = await input.repositories.catalog.findItemBySellableId(itemInput.sellableId);
  if (!catalog) {
    return {
      ok: false,
      status: 404,
      error: {
        code: "SELLABLE_NOT_FOUND",
        message: `Sellable '${itemInput.sellableId}' was not found.`,
      },
    };
  }

  const sellable = catalog.aggregate.sellables.find((item) => item.id === itemInput.sellableId);
  if (!sellable?.active) {
    return {
      ok: false,
      status: 409,
      error: {
        code: "SELLABLE_INACTIVE",
        message: `Sellable '${itemInput.sellableId}' is inactive.`,
      },
    };
  }

  if (itemInput.variantKey && itemInput.variantKey !== sellable.variantKey) {
    return {
      ok: false,
      status: 422,
      error: {
        code: "VARIANT_INVALID",
        message: `Variant '${itemInput.variantKey}' is not valid for sellable '${sellable.id}'.`,
      },
    };
  }
  if (!variantOptionsMatch(sellable, itemInput.variantOptions)) {
    return {
      ok: false,
      status: 422,
      error: {
        code: "VARIANT_INVALID",
        message: `Variant options are not valid for sellable '${sellable.id}'.`,
      },
    };
  }

  const price = selectCartPrice(sellable, itemInput.priceId, cartCurrency);
  if (!price) {
    return cartPriceUnavailable(sellable, itemInput.priceId, cartCurrency);
  }
  if (price.currency !== cartCurrency) {
    return validationFailed("priceId", `Price '${price.id}' uses currency '${price.currency}'.`);
  }

  const stock = await input.repositories.stock.findBySellableId(sellable.id);
  const quantityError = validateQuantityLimit(sellable, stock, quantity);
  if (quantityError) return quantityError;

  return {
    ok: true,
    line: {
      id: input.createId("cart_line"),
      item: snapshotPrice({
        content: catalog.aggregate.content,
        sellable,
        price,
        fallbackTitle: catalog.aggregate.titleSnapshot ?? sellable.id,
      }),
      quantity,
      addedAt: currentBackendISODateTime(input),
    },
    sellable,
    stock,
  };
}

export async function resolveWishlistItem(
  input: MikaCartWishlistBackendInput,
  itemInput: WishlistItemInput,
): Promise<
  | {
      readonly ok: true;
      readonly item: WishlistItem;
    }
  | MikaApiFailure
> {
  const currency = defaultBackendCurrency(input);
  const catalog = await input.repositories.catalog.findItemBySellableId(itemInput.sellableId);
  if (!catalog) {
    return {
      ok: false,
      status: 404,
      error: {
        code: "SELLABLE_NOT_FOUND",
        message: `Sellable '${itemInput.sellableId}' was not found.`,
      },
    };
  }

  const sellable = catalog.aggregate.sellables.find((item) => item.id === itemInput.sellableId);
  if (!sellable?.active) {
    return {
      ok: false,
      status: 409,
      error: {
        code: "SELLABLE_INACTIVE",
        message: `Sellable '${itemInput.sellableId}' is inactive.`,
      },
    };
  }

  const price = selectCartPrice(sellable, itemInput.priceId, currency);
  if (!price) {
    return cartPriceUnavailable(sellable, itemInput.priceId, currency);
  }
  if (price.currency !== currency) {
    return validationFailed("priceId", `Price '${price.id}' uses currency '${price.currency}'.`);
  }

  return {
    ok: true,
    item: {
      id: input.createId("wishlist_item"),
      item: snapshotPrice({
        content: catalog.aggregate.content,
        sellable,
        price,
        fallbackTitle: catalog.aggregate.titleSnapshot ?? sellable.id,
      }),
      addedAt: currentBackendISODateTime(input),
    },
  };
}

export function selectCartPrice(
  sellable: SellableDefinition,
  priceId: MikaId | undefined,
  currency: CurrencyCode,
): PriceDefinition | null {
  if (!priceId) {
    const prices = activeCartPrices(sellable, currency);

    return prices.length === 1 ? prices[0]! : null;
  }

  const price = sellable.prices.find((item) => item.id === priceId);
  return price?.active ? price : null;
}

function activeCartPrices(
  sellable: SellableDefinition,
  currency: CurrencyCode,
): readonly PriceDefinition[] {
  return sellable.prices.filter((item) => item.active && item.currency === currency);
}

export function cartPriceUnavailable(
  sellable: SellableDefinition,
  priceId: MikaId | undefined,
  currency: CurrencyCode,
): MikaApiFailure {
  if (!priceId && activeCartPrices(sellable, currency).length > 1) {
    return validationFailed(
      "priceId",
      `Sellable '${sellable.id}' has multiple active prices for currency '${currency}'; provide priceId.`,
    );
  }

  return {
    ok: false,
    status: 409,
    error: {
      code: "PRICE_INACTIVE",
      message: `No active price is available for sellable '${sellable.id}'.`,
    },
  };
}

export function validateQuantityLimit(
  sellable: SellableDefinition,
  stock: StockItemRecord | null,
  quantity: number,
): MikaApiFailure | null {
  if (sellable.maxPerOrder !== undefined && quantity > sellable.maxPerOrder) {
    return {
      ok: false,
      status: 409,
      error: {
        code: "MAX_PER_ORDER_EXCEEDED",
        message: `Sellable '${sellable.id}' allows at most ${sellable.maxPerOrder} per order.`,
      },
    };
  }

  if (stock) {
    const availability = stockAvailabilityToDTO(sellable, stock);
    const availableQuantity =
      availability?.status === "available" || availability?.status === "low_stock"
        ? availability.availableQuantity
        : undefined;
    if (
      availability?.status === "out_of_stock" ||
      (availableQuantity !== undefined && quantity > availableQuantity)
    ) {
      return {
        ok: false,
        status: 409,
        error: {
          code: "OUT_OF_STOCK",
          message: `Sellable '${sellable.id}' does not have enough stock.`,
        },
      };
    }
  }

  return null;
}

export function isEquivalentCartLine(left: CartLine, right: CartLine): boolean {
  return (
    left.item.sellableId === right.item.sellableId &&
    left.item.priceId === right.item.priceId &&
    left.item.variantKey === right.item.variantKey
  );
}

export function siblingSellableQuantity(items: readonly CartLine[], line: CartLine): number {
  return items.reduce(
    (sum, other) =>
      other.item.sellableId === line.item.sellableId && !isEquivalentCartLine(other, line)
        ? sum + other.quantity
        : sum,
    0,
  );
}

export function isEquivalentWishlistItem(left: WishlistItem, right: WishlistItem): boolean {
  return (
    left.item.sellableId === right.item.sellableId &&
    left.item.priceId === right.item.priceId &&
    left.item.variantKey === right.item.variantKey
  );
}

function variantOptionsMatch(
  sellable: SellableDefinition,
  variantOptions: Record<string, string> | undefined,
): boolean {
  if (!variantOptions || Object.keys(variantOptions).length === 0) return true;

  return Object.entries(variantOptions).every(([option, value]) =>
    sellable.variantOptions.some((item) => item.option === option && item.value === value),
  );
}
