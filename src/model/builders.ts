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
  ContentRef,
  CurrencyCode,
  ISODateTime,
  JsonObject,
  MikaId,
  Money,
  ProviderName,
  PurchaseMode,
} from "../types/primitives";
import { createISODateTime } from "../types/primitives";

/** Input for constructing a catalog commerce aggregate from content and sellables. */
export interface CatalogAggregateInput {
  readonly content: ContentRef;
  readonly titleSnapshot?: string;
  readonly sellables?: readonly SellableDefinition[];
  readonly metadata?: JsonObject;
}

/** Builds a versioned catalog commerce aggregate payload. */
export function createCatalogAggregate(input: CatalogAggregateInput): CatalogCommerceAggregate {
  return {
    schemaVersion: 1,
    content: input.content,
    titleSnapshot: input.titleSnapshot,
    sellables: input.sellables ?? [],
    metadata: input.metadata,
  };
}

/** Input for projecting catalog sellables to API DTOs with optional stock context. */
export interface CatalogSellableDTOInput {
  readonly catalog: CatalogCommerceAggregate;
  readonly stockBySellableId?: ReadonlyMap<MikaId, StockItemRecord>;
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
  return {
    schemaVersion: 1,
    currency: input.currency,
    items: input.items ?? [],
    coupon: input.coupon,
    totals: calculateTotals(input.currency, input.items ?? [], input.coupon),
    metadata: input.metadata,
  };
}

/** Projects a cart aggregate and document metadata to a cart DTO. */
export function cartToDTO(input: {
  readonly id: MikaId;
  readonly status: CartDTO["status"];
  readonly cart: CartAggregate;
  readonly availabilityBySellableId?: ReadonlyMap<MikaId, AvailabilityDTO>;
  readonly checkoutSessionId?: MikaId;
}): CartDTO {
  const totals =
    input.cart.totals ??
    calculateTotals(input.cart.currency, input.cart.items, input.cart.coupon);

  return {
    id: input.id,
    status: input.status,
    currency: input.cart.currency,
    items: input.cart.items.map((line) => {
      const subtotalAmount = line.item.unitAmount * line.quantity;

      return {
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
      };
    }),
    coupon: input.cart.coupon
      ? {
          label: input.cart.coupon.label,
          discount: totals.discount,
          providerCouponId: input.cart.coupon.providerRef?.priceId,
        }
      : undefined,
    subtotal: totals.subtotal,
    discount: totals.discount,
    tax: totals.tax,
    shipping: totals.shipping,
    total: totals.total,
    checkoutSessionId: input.checkoutSessionId,
  };
}

/** Rebuilds a cart aggregate with replaced line items and optional coupon. */
export function cartWithItems(input: {
  readonly cart: CartAggregate;
  readonly items: readonly CartLine[];
  readonly coupon?: CouponSnapshot;
}): CartAggregate {
  return createCartAggregate({
    currency: input.cart.currency,
    items: input.items,
    coupon: input.coupon ?? input.cart.coupon,
    metadata: input.cart.metadata,
  });
}

/** Rebuilds a cart aggregate with coupon removed. */
export function cartWithoutCoupon(input: { readonly cart: CartAggregate }): CartAggregate {
  return createCartAggregate({
    currency: input.cart.currency,
    items: input.cart.items,
    metadata: input.cart.metadata,
  });
}

/** Rebuilds a cart aggregate with an applied coupon snapshot. */
export function cartWithCoupon(input: {
  readonly cart: CartAggregate;
  readonly coupon: CouponSnapshot;
}): CartAggregate {
  return createCartAggregate({
    currency: input.cart.currency,
    items: input.cart.items,
    coupon: input.coupon,
    metadata: input.cart.metadata,
  });
}

/** Builds a versioned wishlist aggregate payload. */
export function createWishlistAggregate(
  input: {
    readonly items?: readonly WishlistItem[];
    readonly metadata?: JsonObject;
  } = {},
): WishlistAggregate {
  return {
    schemaVersion: 1,
    items: input.items ?? [],
    metadata: input.metadata,
  };
}

/** Projects a wishlist aggregate to a wishlist DTO with optional availability. */
export function wishlistToDTO(input: {
  readonly id: MikaId;
  readonly wishlist: WishlistAggregate;
  readonly availabilityBySellableId?: ReadonlyMap<MikaId, AvailabilityDTO>;
}): WishlistDTO {
  return {
    id: input.id,
    items: input.wishlist.items.map((item) => ({
      id: item.id,
      sellableId: item.item.sellableId,
      priceId: item.item.priceId,
      title: item.item.titleSnapshot,
      sku: item.item.sku,
      variantOptions: item.item.variantOptions,
      addedAt: item.addedAt,
      availability: input.availabilityBySellableId?.get(item.item.sellableId),
    })),
  };
}

/** Freezes a sellable price into an immutable purchasable snapshot. */
export function snapshotPrice(input: {
  readonly content: ContentRef;
  readonly sellable: SellableDefinition;
  readonly price: PriceDefinition;
  readonly fallbackTitle: string;
}): PurchasableSnapshot {
  return {
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
  };
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
  return {
    schemaVersion: 1,
    mode: input.mode,
    currency: input.currency,
    lines: input.lines,
    totals: calculateCheckoutTotals(input.currency, input.lines, input.coupon),
    binding: input.binding,
    coupon: input.coupon,
    metadata: input.metadata,
  };
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
  return {
    schemaVersion: 1,
    customer: input.customer,
    lines: input.lines,
    totals: input.checkout.totals,
    coupon: input.checkout.coupon,
    providerRefs: [
      {
        provider: input.checkout.binding.provider,
        checkoutId: input.checkout.binding.providerCheckoutId,
        paymentId: input.providerPaymentId,
        orderId: input.providerOrderId,
        customerId: input.checkout.binding.providerCustomerId,
      },
    ],
    invoiceUrl: input.invoiceUrl,
    receiptUrl: input.receiptUrl,
    metadata: input.metadata,
  };
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
  return {
    schemaVersion: 1,
    customer: input.customer,
    sellable: input.sellable,
    providerRef: {
      provider: input.provider,
      subscriptionId: input.providerSubscriptionId,
      customerId: input.providerCustomerId,
      priceId: input.providerPriceId,
    },
    status: input.status ?? "incomplete",
    cancelAtPeriodEnd: input.cancelAtPeriodEnd ?? false,
    currentPeriodStart: input.currentPeriodStart,
    currentPeriodEnd: input.currentPeriodEnd,
    metadata: input.metadata,
  };
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

  return {
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
  };
}

function sellableToDTO(
  catalog: CatalogCommerceAggregate,
  sellable: SellableDefinition,
  stockBySellableId?: ReadonlyMap<MikaId, StockItemRecord>,
  includeInactive = false,
): SellableDTO {
  const fallbackTitle = catalog.titleSnapshot ?? sellable.id;

  return {
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
  };
}

function priceToDTO(sellableId: MikaId, price: PriceDefinition): PriceDTO {
  return {
    id: price.id,
    sellableId,
    amount: price.amount,
    currency: price.currency,
    mode: price.mode,
    fulfillmentKind: price.fulfillmentKind,
    interval: price.interval,
    intervalCount: price.intervalCount,
    active: price.active,
  };
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
    return {
      sellableId: sellable.id,
      status: "out_of_stock",
      availableQuantity,
      maxPerOrder: sellable.maxPerOrder,
      lowStock,
    };
  }

  if (stock.availableOverride === true) {
    return {
      sellableId: sellable.id,
      status: lowStock ? "low_stock" : "available",
      availableQuantity,
      maxPerOrder: sellable.maxPerOrder,
      lowStock,
    };
  }

  if (stock.policy === "manual") {
    return {
      sellableId: sellable.id,
      status: "manual",
      availableQuantity,
      maxPerOrder: sellable.maxPerOrder,
      lowStock,
    };
  }

  if (stock.policy === "backorder" || (availableQuantity <= 0 && stock.allowBackorder)) {
    return {
      sellableId: sellable.id,
      status: "backorder",
      availableQuantity,
      maxPerOrder: sellable.maxPerOrder,
      lowStock,
    };
  }

  if (stock.policy === "untracked") {
    return {
      sellableId: sellable.id,
      status: "untracked",
      maxPerOrder: sellable.maxPerOrder,
    };
  }

  return {
    sellableId: sellable.id,
    status: availableQuantity <= 0 ? "out_of_stock" : lowStock ? "low_stock" : "available",
    availableQuantity,
    maxPerOrder: sellable.maxPerOrder,
    lowStock,
  };
}

function calculateCheckoutTotals(
  currency: CurrencyCode,
  lines: readonly CheckoutLine[],
  coupon?: CouponSnapshot,
): CartTotals {
  const cartLines = lines.map<CartLine>((line) => ({
    id: line.id,
    item: line.item,
    quantity: line.quantity,
    reservationId: line.reservationId,
    addedAt: createISODateTime(new Date(0).toISOString()),
    metadata: line.metadata,
  }));

  return calculateTotals(currency, cartLines, coupon);
}

/** Computes coupon discount amount capped by subtotal. */
export function couponDiscountAmount(
  coupon: CouponSnapshot | undefined,
  subtotalAmount: number,
): number {
  if (!coupon) return 0;
  const cap = Math.max(0, subtotalAmount);
  if (coupon.rate !== undefined) {
    return Math.min(Math.floor(cap * coupon.rate), cap);
  }

  return Math.min(coupon.discountAmount ?? 0, cap);
}

function calculateTotals(
  currency: CurrencyCode,
  lines: readonly CartLine[],
  coupon?: CouponSnapshot,
): CartTotals {
  const subtotalAmount = lines.reduce((sum, line) => sum + line.item.unitAmount * line.quantity, 0);
  const discountAmount = couponDiscountAmount(coupon, subtotalAmount);
  const totalAmount = Math.max(0, subtotalAmount - discountAmount);

  return {
    subtotal: money(subtotalAmount, currency),
    discount: discountAmount > 0 ? money(discountAmount, currency) : undefined,
    total: money(totalAmount, currency),
  };
}

function money(amount: number, currency: CurrencyCode): Money {
  return { amount, currency };
}
