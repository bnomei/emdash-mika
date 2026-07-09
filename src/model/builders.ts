/**
 * Pure builders mapping aggregates to API DTOs and constructing versioned aggregate payloads.
 * Centralizes totals, purchasable snapshots, and stock availability derivation.
 */
import type { AvailabilityDTO, CartDTO, PriceDTO, SellableDTO, WishlistDTO } from "../api/types";
import type { StockItemRecord } from "../types/operational";
import type {
  CartAggregate,
  CartLine,
  CartTotals,
  CatalogCommerceAggregate,
  CheckoutAggregate,
  CheckoutBinding,
  CheckoutLine,
  CouponSnapshot,
  CustomerSnapshot,
  OrderAggregate,
  OrderLine,
  PriceDefinition,
  PurchasableSnapshot,
  SellableDefinition,
  SubscriptionAggregate,
  WishlistAggregate,
  WishlistItem,
} from "../types/aggregates";
import type {
  CartId,
  CheckoutSessionId,
  ContentRef,
  CurrencyCode,
  ISODateTime,
  JsonObject,
  MikaId,
  Money,
  ProviderName,
  PurchaseMode,
  SellableId,
} from "../types/primitives";
import { omitUndefined } from "../internal/object";

/** Input for projecting catalog sellables to API DTOs with optional stock context. */
export interface CatalogSellableDTOInput {
  readonly catalog: CatalogCommerceAggregate;
  readonly stockBySellableId?: ReadonlyMap<SellableId, StockItemRecord>;
  readonly includeInactive?: boolean;
}

/** Maps active catalog sellables to sellable DTOs with availability overlays. */
export function catalogSellablesToDTO(input: CatalogSellableDTOInput): readonly SellableDTO[] {
  return input.catalog.sellables
    .filter((sellable) => input.includeInactive || sellable.active)
    .map((sellable) =>
      sellableToDTO(input.catalog, sellable, input.stockBySellableId, input.includeInactive),
    );
}

/** Builds a cart aggregate with derived totals from lines and coupon. */
export function createCartAggregate(input: {
  readonly currency: CurrencyCode;
  readonly items?: readonly CartLine[];
  readonly coupon?: CouponSnapshot;
  readonly metadata?: JsonObject;
}): CartAggregate {
  return omitUndefined({
    schemaVersion: 1,
    currency: input.currency,
    items: input.items ?? [],
    coupon: input.coupon,
    totals: calculateTotals(input.currency, input.items ?? [], input.coupon),
    metadata: input.metadata,
  });
}

/** Projects a cart aggregate and document metadata to a cart DTO. */
export function cartToDTO(input: {
  readonly id: CartId;
  readonly status: CartDTO["status"];
  readonly cart: CartAggregate;
  readonly availabilityBySellableId?: ReadonlyMap<SellableId, AvailabilityDTO>;
  readonly checkoutSessionId?: CheckoutSessionId;
}): CartDTO {
  const totals =
    input.cart.totals ?? calculateTotals(input.cart.currency, input.cart.items, input.cart.coupon);

  return omitUndefined({
    id: input.id,
    status: input.status,
    currency: input.cart.currency,
    items: input.cart.items.map((line) => {
      const subtotalAmount = line.item.unitAmount * line.quantity;

      return omitUndefined({
        id: line.id,
        sellableId: line.item.sellableId,
        priceId: line.item.priceId,
        title: line.item.titleSnapshot,
        sku: line.item.sku,
        variantOptions: line.item.variantOptions,
        quantity: line.quantity,
        unitAmount: money(line.item.unitAmount, line.item.currency),
        subtotal: money(subtotalAmount, line.item.currency),
        total: money(subtotalAmount, line.item.currency),
        availability: input.availabilityBySellableId?.get(line.item.sellableId),
      });
    }),
    coupon: input.cart.coupon
      ? omitUndefined({
          label: input.cart.coupon.label,
          discount: totals.discount,
          providerCouponId: input.cart.coupon.providerRef?.priceId,
        })
      : undefined,
    subtotal: totals.subtotal,
    discount: totals.discount,
    tax: totals.tax,
    shipping: totals.shipping,
    total: totals.total,
    checkoutSessionId: input.checkoutSessionId,
  });
}

/** Rebuilds a cart aggregate with replaced line items and optional coupon. */
export function cartWithItems(input: {
  readonly cart: CartAggregate;
  readonly items: readonly CartLine[];
  readonly coupon?: CouponSnapshot;
}): CartAggregate {
  return createCartAggregate(
    omitUndefined({
      currency: input.cart.currency,
      items: input.items,
      coupon: input.coupon ?? input.cart.coupon,
      metadata: input.cart.metadata,
    }),
  );
}

/** Rebuilds a cart aggregate with coupon removed. */
export function cartWithoutCoupon(input: { readonly cart: CartAggregate }): CartAggregate {
  return createCartAggregate(
    omitUndefined({
      currency: input.cart.currency,
      items: input.cart.items,
      metadata: input.cart.metadata,
    }),
  );
}

/** Rebuilds a cart aggregate with an applied coupon snapshot. */
export function cartWithCoupon(input: {
  readonly cart: CartAggregate;
  readonly coupon: CouponSnapshot;
}): CartAggregate {
  return createCartAggregate(
    omitUndefined({
      currency: input.cart.currency,
      items: input.cart.items,
      coupon: input.coupon,
      metadata: input.cart.metadata,
    }),
  );
}

/** Builds a versioned wishlist aggregate payload. */
export function createWishlistAggregate(
  input: {
    readonly items?: readonly WishlistItem[];
    readonly metadata?: JsonObject;
  } = {},
): WishlistAggregate {
  return omitUndefined({
    schemaVersion: 1,
    items: input.items ?? [],
    metadata: input.metadata,
  });
}

/** Projects a wishlist aggregate to a wishlist DTO with optional availability. */
export function wishlistToDTO(input: {
  readonly id: MikaId;
  readonly wishlist: WishlistAggregate;
  readonly availabilityBySellableId?: ReadonlyMap<SellableId, AvailabilityDTO>;
}): WishlistDTO {
  return {
    id: input.id,
    items: input.wishlist.items.map((item) =>
      omitUndefined({
        id: item.id,
        sellableId: item.item.sellableId,
        priceId: item.item.priceId,
        title: item.item.titleSnapshot,
        sku: item.item.sku,
        variantOptions: item.item.variantOptions,
        addedAt: item.addedAt,
        availability: input.availabilityBySellableId?.get(item.item.sellableId),
      }),
    ),
  };
}

/** Freezes a sellable price into an immutable purchasable snapshot. */
export function snapshotPrice(input: {
  readonly content: ContentRef;
  readonly sellable: SellableDefinition;
  readonly price: PriceDefinition;
  readonly fallbackTitle: string;
}): PurchasableSnapshot {
  return omitUndefined({
    content: input.content,
    sellableId: input.sellable.id,
    priceId: input.price.id,
    sku: input.price.sku ?? input.sellable.sku,
    titleSnapshot: input.price.titleSnapshot ?? input.sellable.titleSnapshot ?? input.fallbackTitle,
    variantKey: input.sellable.variantKey,
    variantOptions: input.sellable.variantOptions,
    unitAmount: input.price.amount,
    currency: input.price.currency,
    mode: input.price.mode,
    fulfillmentKind: input.price.fulfillmentKind,
    entitlementKey: input.price.entitlementKey,
    interval: input.price.interval,
    intervalCount: input.price.intervalCount,
    providerRefs: input.price.providerRefs,
    metadata: input.price.metadata,
  });
}

/** Builds a checkout aggregate with binding and derived totals. */
export function createCheckoutAggregate(input: {
  readonly mode: PurchaseMode;
  readonly currency: CurrencyCode;
  readonly lines: readonly CheckoutLine[];
  readonly binding: CheckoutBinding;
  readonly coupon?: CouponSnapshot;
  readonly metadata?: JsonObject;
}): CheckoutAggregate {
  return omitUndefined({
    schemaVersion: 1,
    mode: input.mode,
    currency: input.currency,
    lines: input.lines,
    totals: calculateTotals(input.currency, input.lines, input.coupon),
    binding: input.binding,
    coupon: input.coupon,
    metadata: input.metadata,
  });
}

/** Builds an order aggregate from checkout context and fulfillment lines. */
export function createOrderAggregate(input: {
  readonly customer: CustomerSnapshot;
  readonly checkout: CheckoutAggregate;
  readonly lines: readonly OrderLine[];
  readonly providerPaymentId?: string;
  readonly providerOrderId?: string;
  readonly invoiceUrl?: string;
  readonly receiptUrl?: string;
  readonly metadata?: JsonObject;
}): OrderAggregate {
  return omitUndefined({
    schemaVersion: 1,
    customer: input.customer,
    lines: input.lines,
    totals: input.checkout.totals,
    coupon: input.checkout.coupon,
    providerRefs: [
      omitUndefined({
        provider: input.checkout.binding.provider,
        checkoutId: input.checkout.binding.providerCheckoutId,
        paymentId: input.providerPaymentId,
        orderId: input.providerOrderId,
        customerId: input.checkout.binding.providerCustomerId,
      }),
    ],
    invoiceUrl: input.invoiceUrl,
    receiptUrl: input.receiptUrl,
    metadata: input.metadata,
  });
}

/** Builds a subscription aggregate from customer and recurring sellable context. */
export function createSubscriptionAggregate(input: {
  readonly customer: CustomerSnapshot;
  readonly sellable: PurchasableSnapshot;
  readonly provider: ProviderName;
  readonly providerSubscriptionId?: string;
  readonly providerCustomerId?: string;
  readonly providerPriceId?: string;
  readonly status?: SubscriptionAggregate["status"];
  readonly currentPeriodStart?: ISODateTime;
  readonly currentPeriodEnd?: ISODateTime;
  readonly cancelAtPeriodEnd?: boolean;
  readonly metadata?: JsonObject;
}): SubscriptionAggregate {
  return omitUndefined({
    schemaVersion: 1,
    customer: input.customer,
    sellable: input.sellable,
    providerRef: omitUndefined({
      provider: input.provider,
      subscriptionId: input.providerSubscriptionId,
      customerId: input.providerCustomerId,
      priceId: input.providerPriceId,
    }),
    status: input.status ?? "incomplete",
    cancelAtPeriodEnd: input.cancelAtPeriodEnd ?? false,
    currentPeriodStart: input.currentPeriodStart,
    currentPeriodEnd: input.currentPeriodEnd,
    metadata: input.metadata,
  });
}

/** Maps a checkout line into a persisted order line with pricing breakdown. */
export function orderLineFromCheckoutLine(input: {
  readonly id: MikaId;
  readonly line: CheckoutLine;
  readonly discountAmount?: number;
  readonly taxAmount?: number;
  readonly entitlementId?: MikaId;
  readonly stockMovementId?: MikaId;
  readonly metadata?: JsonObject;
}): OrderLine {
  const subtotalAmount = input.line.item.unitAmount * input.line.quantity;
  const discountAmount = input.discountAmount ?? 0;
  const taxAmount = input.taxAmount ?? 0;

  return omitUndefined({
    id: input.id,
    item: input.line.item,
    quantity: input.line.quantity,
    subtotalAmount,
    discountAmount,
    taxAmount,
    totalAmount: subtotalAmount - discountAmount + taxAmount,
    entitlementId: input.entitlementId,
    stockMovementId: input.stockMovementId,
    metadata: input.metadata,
  });
}

function sellableToDTO(
  catalog: CatalogCommerceAggregate,
  sellable: SellableDefinition,
  stockBySellableId?: ReadonlyMap<SellableId, StockItemRecord>,
  includeInactive = false,
): SellableDTO {
  const fallbackTitle = catalog.titleSnapshot ?? sellable.id;

  return omitUndefined({
    id: sellable.id,
    contentRef: catalog.content,
    sku: sellable.sku,
    title: sellable.titleSnapshot ?? fallbackTitle,
    active: sellable.active,
    variantKey: sellable.variantKey,
    variantOptions: sellable.variantOptions,
    variantGroups: sellable.variantGroups,
    imageRef: sellable.imageRef,
    prices: sellable.prices
      .filter((price) => includeInactive || price.active)
      .map((price) => priceToDTO(sellable.id, price)),
    availability: stockAvailabilityToDTO(sellable, stockBySellableId?.get(sellable.id)),
  });
}

function priceToDTO(sellableId: SellableId, price: PriceDefinition): PriceDTO {
  return omitUndefined({
    id: price.id,
    sellableId,
    amount: price.amount,
    currency: price.currency,
    mode: price.mode,
    fulfillmentKind: price.fulfillmentKind,
    interval: price.interval,
    intervalCount: price.intervalCount,
    active: price.active,
  });
}

/** Derives availability DTO from sellable limits and stock item record state. */
export function stockAvailabilityToDTO(
  sellable: SellableDefinition,
  stock?: StockItemRecord,
): AvailabilityDTO | undefined {
  if (!stock) {
    return sellable.maxPerOrder
      ? {
          sellableId: sellable.id,
          status: "untracked",
          maxPerOrder: sellable.maxPerOrder,
        }
      : undefined;
  }

  const availableQuantity = Math.max(0, stock.quantityOnHand - stock.quantityReserved);
  const lowStock =
    stock.lowStockThreshold !== undefined &&
    availableQuantity > 0 &&
    availableQuantity <= stock.lowStockThreshold;

  if (stock.availableOverride === false) {
    return omitUndefined({
      sellableId: sellable.id,
      status: "out_of_stock",
      availableQuantity,
      maxPerOrder: sellable.maxPerOrder,
      lowStock,
    });
  }

  if (stock.availableOverride === true) {
    return omitUndefined({
      sellableId: sellable.id,
      status: lowStock ? "low_stock" : "available",
      availableQuantity,
      maxPerOrder: sellable.maxPerOrder,
      lowStock,
    });
  }

  if (stock.policy === "manual") {
    return omitUndefined({
      sellableId: sellable.id,
      status: "manual",
      availableQuantity,
      maxPerOrder: sellable.maxPerOrder,
      lowStock,
    });
  }

  if (stock.policy === "backorder" || (availableQuantity <= 0 && stock.allowBackorder)) {
    return omitUndefined({
      sellableId: sellable.id,
      status: "backorder",
      availableQuantity,
      maxPerOrder: sellable.maxPerOrder,
      lowStock,
    });
  }

  if (stock.policy === "untracked") {
    return omitUndefined({
      sellableId: sellable.id,
      status: "untracked",
      maxPerOrder: sellable.maxPerOrder,
    });
  }

  // The branch order above is load-bearing (a backorder-allowed, sold-out untracked item is
  // reported as backorder, not untracked), so this stays an if-chain rather than a switch on
  // policy. By here policy is narrowed to "finite"; the assertion turns any future StockPolicy
  // member into a compile error demanding an explicit branch instead of silently landing here.
  stock.policy satisfies "finite";
  return omitUndefined({
    sellableId: sellable.id,
    status: availableQuantity <= 0 ? "out_of_stock" : lowStock ? "low_stock" : "available",
    availableQuantity,
    maxPerOrder: sellable.maxPerOrder,
    lowStock,
  });
}

/**
 * Computes coupon discount amount clamped to `[0, subtotalAmount]`. A negative, `NaN`, or
 * infinite `rate` or `discountAmount` (e.g. from a `CouponSnapshot` a host's own storage layer
 * round-trips with a corrupted value, bypassing the resolver's own validation) must never pass
 * through and poison the checkout total with `NaN` or inflate it above what the buyer confirmed —
 * this is now the sole guard, since delegated-payment adapters trust the backend's computed total
 * verbatim rather than recomputing it themselves.
 */
export function couponDiscountAmount(
  coupon: CouponSnapshot | undefined,
  subtotalAmount: number,
): number {
  if (!coupon) return 0;
  const cap = Math.max(0, subtotalAmount);
  if (coupon.rate !== undefined) {
    if (!Number.isFinite(coupon.rate)) return 0;
    return Math.max(0, Math.min(Math.floor(cap * coupon.rate), cap));
  }

  const discountAmount = coupon.discountAmount ?? 0;
  if (!Number.isFinite(discountAmount)) return 0;
  return Math.max(0, Math.min(discountAmount, cap));
}

// Second param is the structural minimum both cart lines and checkout lines share, so the
// checkout path can pass its lines directly rather than fabricating throwaway CartLines.
function calculateTotals(
  currency: CurrencyCode,
  lines: readonly Pick<CartLine, "item" | "quantity">[],
  coupon?: CouponSnapshot,
): CartTotals {
  const subtotalAmount = lines.reduce((sum, line) => sum + line.item.unitAmount * line.quantity, 0);
  const discountAmount = couponDiscountAmount(coupon, subtotalAmount);
  const totalAmount = Math.max(0, subtotalAmount - discountAmount);

  return omitUndefined({
    subtotal: money(subtotalAmount, currency),
    discount: discountAmount > 0 ? money(discountAmount, currency) : undefined,
    total: money(totalAmount, currency),
  });
}

function money(amount: number, currency: CurrencyCode): Money {
  return { amount, currency };
}
