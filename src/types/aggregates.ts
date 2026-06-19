import type {
  AggregatePayload,
  CartStatus,
  CheckoutStatus,
  ContentRef,
  CurrencyCode,
  FulfillmentKind,
  ISODateTime,
  JsonObject,
  MikaId,
  Money,
  OrderStatus,
  PaymentStatus,
  ProviderName,
  PurchaseMode,
  StockPolicy,
  SubscriptionStatus,
  Timestamped,
  WishlistStatus,
} from "./primitives";

export interface VariantOptionValue {
  readonly option: string;
  readonly value: string;
  readonly label?: string;
}

export interface VariantOptionGroup {
  readonly option: string;
  readonly label: string;
  readonly values: readonly VariantOptionValue[];
}

export interface ProviderProductRef {
  readonly provider: ProviderName;
  readonly productId?: string;
  readonly priceId?: string;
  readonly checkoutId?: string;
  readonly paymentId?: string;
  readonly orderId?: string;
  readonly subscriptionId?: string;
  readonly customerId?: string;
}

export interface PriceDefinition {
  readonly id: MikaId;
  readonly sku?: string;
  readonly titleSnapshot?: string;
  readonly providerRefs: readonly ProviderProductRef[];
  readonly amount: number;
  readonly currency: CurrencyCode;
  readonly mode: PurchaseMode;
  readonly fulfillmentKind: FulfillmentKind;
  readonly entitlementKey?: string;
  readonly interval?: "month" | "year";
  readonly intervalCount?: number;
  readonly active: boolean;
  readonly metadata?: JsonObject;
}

export interface SellableDefinition {
  readonly id: MikaId;
  readonly sku?: string;
  readonly titleSnapshot?: string;
  readonly variantKey?: string;
  readonly variantOptions: readonly VariantOptionValue[];
  readonly variantGroups?: readonly VariantOptionGroup[];
  readonly imageRef?: string;
  readonly active: boolean;
  readonly sortOrder: number;
  readonly maxPerOrder?: number;
  readonly stockItemId?: MikaId;
  readonly stockPolicySnapshot?: StockPolicy;
  readonly prices: readonly PriceDefinition[];
  readonly metadata?: JsonObject;
}

export interface CatalogCommerceAggregate extends AggregatePayload {
  readonly content: ContentRef;
  readonly titleSnapshot?: string;
  readonly sellables: readonly SellableDefinition[];
  readonly providerRefs?: readonly ProviderProductRef[];
  readonly metadata?: JsonObject;
}

export interface PurchasableSnapshot {
  readonly content: ContentRef;
  readonly sellableId: MikaId;
  readonly priceId?: MikaId;
  readonly sku?: string;
  readonly titleSnapshot: string;
  readonly variantKey?: string;
  readonly variantOptions: readonly VariantOptionValue[];
  readonly unitAmount: number;
  readonly currency: CurrencyCode;
  readonly mode: PurchaseMode;
  readonly fulfillmentKind: FulfillmentKind;
  readonly entitlementKey?: string;
  readonly providerRefs?: readonly ProviderProductRef[];
  readonly metadata?: JsonObject;
}

export interface CartLine {
  readonly id: MikaId;
  readonly item: PurchasableSnapshot;
  readonly quantity: number;
  readonly reservationId?: MikaId;
  readonly addedAt: ISODateTime;
  readonly metadata?: JsonObject;
}

export interface CouponSnapshot {
  readonly codeHash?: string;
  readonly label?: string;
  readonly providerRef?: ProviderProductRef;
  readonly discountAmount?: number;
  readonly metadata?: JsonObject;
}

export interface CartTotals {
  readonly subtotal: Money;
  readonly discount?: Money;
  readonly tax?: Money;
  readonly shipping?: Money;
  readonly total: Money;
}

export interface CartValidationIssue {
  readonly code:
    | "inactive_sellable"
    | "inactive_price"
    | "out_of_stock"
    | "quantity_limit"
    | "currency_mismatch"
    | "provider_unsupported";
  readonly lineId?: MikaId;
  readonly message?: string;
}

export interface CartAggregate extends AggregatePayload {
  readonly currency: CurrencyCode;
  readonly items: readonly CartLine[];
  readonly coupon?: CouponSnapshot;
  readonly totals?: CartTotals;
  readonly validationIssues?: readonly CartValidationIssue[];
  readonly metadata?: JsonObject;
}

export interface WishlistItem {
  readonly id: MikaId;
  readonly item: PurchasableSnapshot;
  readonly addedAt: ISODateTime;
  readonly metadata?: JsonObject;
}

export interface WishlistAggregate extends AggregatePayload {
  readonly items: readonly WishlistItem[];
  readonly metadata?: JsonObject;
}

export interface CheckoutLine {
  readonly id: MikaId;
  readonly cartLineId?: MikaId;
  readonly item: PurchasableSnapshot;
  readonly quantity: number;
  readonly reservationId?: MikaId;
  readonly metadata?: JsonObject;
}

export interface CheckoutBinding {
  readonly provider: ProviderName;
  readonly providerCheckoutId?: string;
  readonly providerCustomerId?: string;
  readonly returnPath: string;
  readonly cancelPath: string;
  readonly successPath: string;
  readonly cartHash?: string;
}

export interface CheckoutAggregate extends AggregatePayload {
  readonly mode: PurchaseMode;
  readonly currency: CurrencyCode;
  readonly lines: readonly CheckoutLine[];
  readonly totals: CartTotals;
  readonly binding: CheckoutBinding;
  readonly coupon?: CouponSnapshot;
  readonly metadata?: JsonObject;
}

export interface CustomerSnapshot {
  readonly customerId?: MikaId;
  readonly userId?: string;
  readonly email?: string;
  readonly emailHash?: string;
  readonly name?: string;
  readonly company?: string;
  readonly vatId?: string;
}

export interface OrderLine {
  readonly id: MikaId;
  readonly item: PurchasableSnapshot;
  readonly quantity: number;
  readonly subtotalAmount: number;
  readonly discountAmount?: number;
  readonly taxAmount?: number;
  readonly totalAmount: number;
  readonly downloadRefs?: readonly string[];
  readonly licenseKeySuffix?: string;
  readonly entitlementId?: MikaId;
  readonly stockMovementId?: MikaId;
  readonly metadata?: JsonObject;
}

export interface OrderAggregate extends AggregatePayload {
  readonly customer: CustomerSnapshot;
  readonly lines: readonly OrderLine[];
  readonly totals: CartTotals;
  readonly coupon?: CouponSnapshot;
  readonly providerRefs: readonly ProviderProductRef[];
  readonly invoiceUrl?: string;
  readonly receiptUrl?: string;
  readonly metadata?: JsonObject;
}

export interface SubscriptionAggregate extends AggregatePayload {
  readonly customer: CustomerSnapshot;
  readonly sellable: PurchasableSnapshot;
  readonly providerRef: ProviderProductRef;
  readonly status: SubscriptionStatus;
  readonly cancelAtPeriodEnd: boolean;
  readonly currentPeriodStart?: ISODateTime;
  readonly currentPeriodEnd?: ISODateTime;
  readonly entitlementId?: MikaId;
  readonly metadata?: JsonObject;
}

export interface ProviderAccountSummary {
  readonly provider: ProviderName;
  readonly providerCustomerId: string;
  readonly emailSnapshot?: string;
  readonly createdAt?: ISODateTime;
}

export interface CustomerAggregate extends AggregatePayload {
  readonly email?: string;
  readonly emailHash?: string;
  readonly name?: string;
  readonly company?: string;
  readonly vatId?: string;
  readonly providerAccounts?: readonly ProviderAccountSummary[];
  readonly metadata?: JsonObject;
}

export interface CouponAggregate extends AggregatePayload {
  readonly label: string;
  readonly codeHash: string;
  readonly active: boolean;
  readonly discount:
    | { readonly type: "amount"; readonly amount: Money }
    | { readonly type: "percent"; readonly percent: number };
  readonly startsAt?: ISODateTime;
  readonly endsAt?: ISODateTime;
  readonly maxRedemptions?: number;
  readonly metadata?: JsonObject;
}

export interface AggregateRecord<TPayload extends AggregatePayload> extends Timestamped {
  readonly id: MikaId;
  readonly version: number;
  readonly payload: TPayload;
}

export interface CatalogItemRecord extends AggregateRecord<CatalogCommerceAggregate> {
  readonly contentCollection: string;
  readonly contentId: string;
  readonly active: boolean;
  readonly titleSnapshot?: string;
}

export interface CartRecord extends AggregateRecord<CartAggregate> {
  readonly sessionId?: string;
  readonly customerId?: MikaId;
  readonly userId?: string;
  readonly status: CartStatus;
  readonly currency: CurrencyCode;
  readonly expiresAt?: ISODateTime;
}

export interface WishlistRecord extends AggregateRecord<WishlistAggregate> {
  readonly sessionId?: string;
  readonly customerId?: MikaId;
  readonly userId?: string;
  readonly status: WishlistStatus;
  readonly expiresAt?: ISODateTime;
}

export interface CheckoutSessionRecord extends AggregateRecord<CheckoutAggregate> {
  readonly cartId?: MikaId;
  readonly customerId?: MikaId;
  readonly provider: ProviderName;
  readonly providerCheckoutId?: string;
  readonly status: CheckoutStatus;
  readonly expiresAt?: ISODateTime;
}

export interface OrderRecord extends AggregateRecord<OrderAggregate> {
  readonly orderNumber: string;
  readonly customerId?: MikaId;
  readonly provider: ProviderName;
  readonly providerCheckoutId?: string;
  readonly providerPaymentId?: string;
  readonly providerOrderId?: string;
  readonly checkoutSessionId?: MikaId;
  readonly status: OrderStatus;
  readonly paymentStatus: PaymentStatus;
  readonly currency: CurrencyCode;
  readonly totalAmount: number;
  readonly paidAt?: ISODateTime;
}

export interface SubscriptionRecord extends AggregateRecord<SubscriptionAggregate> {
  readonly customerId?: MikaId;
  readonly provider: ProviderName;
  readonly providerSubscriptionId?: string;
  readonly providerCustomerId?: string;
  readonly status: SubscriptionStatus;
  readonly currentPeriodEnd?: ISODateTime;
}

export interface CustomerRecord extends AggregateRecord<CustomerAggregate> {
  readonly userId?: string;
  readonly email?: string;
  readonly emailHash?: string;
  readonly lastLoginAt?: ISODateTime;
}

export interface CouponRecord extends AggregateRecord<CouponAggregate> {
  readonly codeHash: string;
  readonly active: boolean;
  readonly startsAt?: ISODateTime;
  readonly endsAt?: ISODateTime;
}
