/**
 * Wire DTOs, operation inputs, and the {@link MikaApiResult} envelope shared across clients and handlers.
 * DTOs are stable JSON shapes; inputs mirror Zod schemas in {@link ./validation}.
 */
import type {
  CurrencyCode,
  FulfillmentKind,
  ISODateTime,
  JsonObject,
  MikaId,
  OrderStatus,
  PaymentStatus,
  ProviderName,
  PurchaseMode,
  StockMovementReason,
  SubscriptionStatus,
} from "../types/primitives";
import type { MikaAgentProofKind, MikaAgentProofRef } from "./agent-types";

/** Stable machine-readable error codes returned in {@link MikaApiResult} failures. */
export const MIKA_ERROR_CODES = [
  "VALIDATION_FAILED",
  "METHOD_NOT_ALLOWED",
  "CSRF_INVALID",
  "RATE_LIMITED",
  "AUTH_REQUIRED",
  "FORBIDDEN",
  "SELLABLE_NOT_FOUND",
  "SELLABLE_INACTIVE",
  "PRICE_INACTIVE",
  "VARIANT_INVALID",
  "OUT_OF_STOCK",
  "MAX_PER_ORDER_EXCEEDED",
  "CHECKOUT_EMPTY",
  "CHECKOUT_EXPIRED",
  "CHECKOUT_BINDING_MISMATCH",
  "PAYMENT_PENDING",
  "PROVIDER_UNSUPPORTED",
  "PROVIDER_FAILED",
  "TOKEN_INVALID",
  "TOKEN_EXPIRED",
  "TOKEN_USED",
  "DOWNLOAD_REVOKED",
  "WEBHOOK_INVALID",
  "CONFLICT",
  "NOT_IMPLEMENTED",
] as const;

export type MikaErrorCode = (typeof MIKA_ERROR_CODES)[number];

/** Structured error payload on failed API responses. */
export interface MikaError {
  readonly code: MikaErrorCode;
  readonly message: string;
  readonly fieldErrors?: Record<string, string>;
  readonly retryAfter?: number;
  readonly correlationId?: string;
}

/** Discriminated success/failure envelope for every Mika API operation. */
export type MikaApiResult<TData> =
  | {
      readonly ok: true;
      readonly status: number;
      readonly data: TData;
      readonly warnings?: readonly string[];
      readonly effects?: readonly MikaClientEffect[];
    }
  | {
      readonly ok: false;
      readonly status: number;
      readonly error: MikaError;
      readonly effects?: readonly MikaClientEffect[];
    };

/** Optional UI hints (redirect, reload, toast) attached to API responses. */
export type MikaClientEffect =
  | { readonly type: "redirect"; readonly url: string }
  | { readonly type: "reload" }
  | {
      readonly type: "toast";
      readonly tone: "success" | "warning" | "error";
      readonly message: string;
    };

/** CMS content pointer used to resolve catalog sellables. */
export interface ContentRefDTO {
  readonly collection: string;
  readonly id: string;
  readonly locale?: string;
}

/** Minor-unit money amount with ISO currency code. */
export interface MoneyDTO {
  readonly amount: number;
  readonly currency: CurrencyCode;
}

export interface VariantOptionValueDTO {
  readonly option: string;
  readonly value: string;
  readonly label?: string;
}

export interface VariantOptionGroupDTO {
  readonly option: string;
  readonly label: string;
  readonly values: readonly VariantOptionValueDTO[];
}

export type AvailabilityStatus =
  | "available"
  | "low_stock"
  | "out_of_stock"
  | "backorder"
  | "untracked"
  | "manual";

/** Stock availability snapshot for a sellable at read time. */
export interface AvailabilityDTO {
  readonly sellableId: MikaId;
  readonly status: AvailabilityStatus;
  readonly availableQuantity?: number;
  readonly maxPerOrder?: number;
  readonly lowStock?: boolean;
  readonly reservedByCurrentCheckout?: boolean;
}

export interface PriceDTO {
  readonly id: MikaId;
  readonly sellableId: MikaId;
  readonly amount: number;
  readonly currency: CurrencyCode;
  readonly mode: PurchaseMode;
  readonly fulfillmentKind: FulfillmentKind;
  readonly interval?: "month" | "year";
  readonly intervalCount?: number;
  readonly active: boolean;
}

/** Purchasable variant with prices and optional live availability. */
export interface SellableDTO {
  readonly id: MikaId;
  readonly contentRef: ContentRefDTO;
  readonly sku?: string;
  readonly title: string;
  readonly active: boolean;
  readonly variantKey?: string;
  readonly variantOptions: readonly VariantOptionValueDTO[];
  readonly variantGroups?: readonly VariantOptionGroupDTO[];
  readonly imageRef?: string;
  readonly prices: readonly PriceDTO[];
  readonly availability?: AvailabilityDTO;
}

export interface CartLineDTO {
  readonly id: MikaId;
  readonly sellableId: MikaId;
  readonly priceId?: MikaId;
  readonly title: string;
  readonly sku?: string;
  readonly variantOptions: readonly VariantOptionValueDTO[];
  readonly quantity: number;
  readonly unitAmount: MoneyDTO;
  readonly subtotal: MoneyDTO;
  readonly total: MoneyDTO;
  readonly availability?: AvailabilityDTO;
}

/** Session- or customer-bound cart with priced lines and checkout linkage. */
export interface CartDTO {
  readonly id: MikaId;
  readonly status: "open" | "checkout_pending" | "converted" | "abandoned" | "expired";
  readonly currency: CurrencyCode;
  readonly items: readonly CartLineDTO[];
  readonly coupon?: AppliedCouponDTO;
  readonly subtotal: MoneyDTO;
  readonly discount?: MoneyDTO;
  readonly tax?: MoneyDTO;
  readonly shipping?: MoneyDTO;
  readonly total: MoneyDTO;
  readonly checkoutSessionId?: MikaId;
  readonly errors?: readonly MikaError[];
}

export interface AppliedCouponDTO {
  readonly code?: string;
  readonly label?: string;
  readonly discount?: MoneyDTO;
  readonly providerCouponId?: string;
}

export interface WishlistItemDTO {
  readonly id: MikaId;
  readonly sellableId: MikaId;
  readonly priceId?: MikaId;
  readonly title: string;
  readonly sku?: string;
  readonly variantOptions: readonly VariantOptionValueDTO[];
  readonly addedAt: ISODateTime;
  readonly availability?: AvailabilityDTO;
}

/** Saved sellables not yet in the active cart. */
export interface WishlistDTO {
  readonly id: MikaId;
  readonly items: readonly WishlistItemDTO[];
}

export type CheckoutStatusDTO =
  | "created"
  | "redirected"
  | "pending"
  | "completed"
  | "cancelled"
  | "expired"
  | "failed"
  | "binding_mismatch";

/** Provider checkout session created from cart handoff. */
export interface CheckoutSessionDTO {
  readonly id: MikaId;
  readonly status: CheckoutStatusDTO;
  readonly mode: PurchaseMode;
  readonly provider: ProviderName;
  readonly redirectUrl?: string;
  readonly statusToken?: string;
  readonly expiresAt?: ISODateTime;
  readonly paymentPending?: boolean;
  readonly orderId?: MikaId;
  readonly errors?: readonly MikaError[];
}

export interface CheckoutCustomerInput {
  readonly email?: string;
  readonly name?: string;
  readonly company?: string;
  readonly vatId?: string;
}

export type CartQuoteStatusDTO = "valid" | "changed" | "expired" | "unavailable";

export interface CartQuoteLineDTO {
  readonly lineId?: MikaId;
  readonly sellableId: MikaId;
  readonly priceId?: MikaId;
  readonly title?: string;
  readonly sku?: string;
  readonly variantOptions?: readonly VariantOptionValueDTO[];
  readonly quantity: number;
  readonly unitAmount?: MoneyDTO;
  readonly subtotal?: MoneyDTO;
  readonly total?: MoneyDTO;
  readonly availability?: AvailabilityDTO;
  readonly warnings?: readonly string[];
}

export interface CartQuoteAdjustmentDTO {
  readonly type: "discount" | "tax" | "shipping" | "fee";
  readonly label?: string;
  readonly code?: string;
  readonly amount: MoneyDTO;
}

/** Priced cart snapshot with validation status before checkout. */
export interface CartQuoteDTO {
  readonly id?: MikaId;
  readonly cartId?: MikaId;
  readonly status: CartQuoteStatusDTO;
  readonly currency: CurrencyCode;
  readonly items: readonly CartQuoteLineDTO[];
  readonly subtotal: MoneyDTO;
  readonly discount?: MoneyDTO;
  readonly tax?: MoneyDTO;
  readonly shipping?: MoneyDTO;
  readonly total: MoneyDTO;
  readonly adjustments?: readonly CartQuoteAdjustmentDTO[];
  readonly coupon?: AppliedCouponDTO;
  readonly expiresAt?: ISODateTime;
  readonly inputHash?: string;
  readonly checkoutIntentId?: MikaId;
  readonly warnings?: readonly string[];
  readonly errors?: readonly MikaError[];
}

export type CheckoutPreviewStatusDTO =
  | "ready"
  | "requires_confirmation"
  | "requires_payment_authorization"
  | "unavailable"
  | "expired";

export interface CheckoutPreviewProofRequirementDTO {
  readonly kind: MikaAgentProofKind;
  readonly required: boolean;
  readonly reason?: string;
  readonly inputHash?: string;
  readonly expiresAt?: ISODateTime;
}

/** Pre-checkout totals and proof requirements before payment handoff. */
export interface CheckoutPreviewDTO {
  readonly id?: MikaId;
  readonly quoteId?: MikaId;
  readonly status: CheckoutPreviewStatusDTO;
  readonly mode?: PurchaseMode;
  readonly provider?: ProviderName;
  readonly quote?: CartQuoteDTO;
  readonly requiredProofs: readonly CheckoutPreviewProofRequirementDTO[];
  readonly acceptedProofs?: readonly MikaAgentProofKind[];
  readonly proofRefs?: readonly MikaAgentProofRef[];
  readonly expiresAt?: ISODateTime;
  readonly inputHash?: string;
  readonly redirectUrl?: string;
  readonly warnings?: readonly string[];
  readonly errors?: readonly MikaError[];
}

export interface CustomerDTO {
  readonly id?: MikaId;
  readonly userId?: string;
  readonly email?: string;
  readonly name?: string;
}

export interface OrderSummaryDTO {
  readonly id: MikaId;
  readonly orderNumber: string;
  readonly status: OrderStatus;
  readonly paymentStatus: PaymentStatus;
  readonly total: MoneyDTO;
  readonly createdAt: ISODateTime;
  readonly invoiceHref?: string;
}

export interface SubscriptionDTO {
  readonly id: MikaId;
  readonly title: string;
  readonly status: SubscriptionStatus;
  readonly currentPeriodEnd?: ISODateTime;
  readonly cancelAtPeriodEnd: boolean;
  readonly providerActions?: readonly ("portal" | "cancel" | "renew" | "change")[];
}

export interface EntitlementDTO {
  readonly key: string;
  readonly status: "active" | "inactive" | "revoked" | "expired";
  readonly source: "order" | "subscription" | "manual";
  readonly expiresAt?: ISODateTime;
}

export interface DownloadDTO {
  readonly id: MikaId;
  readonly title: string;
  readonly href: string;
  readonly expiresAt?: ISODateTime;
}

export interface DownloadResolutionDTO {
  readonly title?: string;
  readonly redirectUrl?: string;
  readonly expiresAt?: ISODateTime;
}

export interface AccountExportDTO {
  readonly id: MikaId;
  readonly status: "queued" | "running" | "ready" | "expired" | "failed";
  readonly requestedAt: ISODateTime;
  readonly expiresAt: ISODateTime;
  readonly downloadHref?: string;
}

export interface AccountExportDownloadDTO {
  readonly id: MikaId;
  readonly href?: string;
  readonly expiresAt?: ISODateTime;
}

/** Customer account summary with orders, subscriptions, and entitlements. */
export interface AccountDTO {
  readonly customer?: CustomerDTO;
  readonly orders: readonly OrderSummaryDTO[];
  readonly subscriptions: readonly SubscriptionDTO[];
  readonly entitlements: readonly EntitlementDTO[];
  readonly downloads: readonly DownloadDTO[];
}

/** Input for `cart.add`. */
export interface AddCartItemInput {
  readonly sellableId: MikaId;
  readonly priceId?: MikaId;
  readonly quantity?: number;
  readonly variantKey?: string;
  readonly variantOptions?: Record<string, string>;
  readonly returnTo?: string;
}

/** Input for `cart.merge`. */
export interface MergeCartInput {
  readonly sourceSessionId?: string;
  readonly targetCartId?: MikaId;
  readonly returnTo?: string;
}

/** Input for `cart.update`. */
export interface UpdateCartItemInput {
  readonly lineId: MikaId;
  readonly quantity: number;
  readonly returnTo?: string;
}

/** Input for `cart.remove`. */
export interface RemoveCartItemInput {
  readonly lineId: MikaId;
  readonly returnTo?: string;
}

/** Input for `cart.applyCoupon`. */
export interface ApplyCouponInput {
  readonly code: string;
  readonly cartId?: MikaId;
  readonly returnTo?: string;
}

/** Input for `cart.removeCoupon`. */
export interface RemoveCouponInput {
  readonly cartId?: MikaId;
  readonly returnTo?: string;
}

/** Input for `cart.quote`. */
export interface CartQuoteInput {
  readonly cartId?: MikaId;
  readonly sellableId?: MikaId;
  readonly priceId?: MikaId;
  readonly quantity?: number;
  readonly couponCode?: string;
  readonly customer?: CheckoutCustomerInput;
  readonly customFields?: JsonObject;
  readonly returnTo?: string;
}

/** Input for `wishlist.add`. */
export interface WishlistItemInput {
  readonly sellableId: MikaId;
  readonly priceId?: MikaId;
  readonly returnTo?: string;
}

/** Input for `wishlist.remove`. */
export interface RemoveWishlistItemInput {
  readonly itemId: MikaId;
  readonly returnTo?: string;
}

/** Input for `wishlist.moveToCart`. */
export interface MoveWishlistItemToCartInput {
  readonly itemId: MikaId;
  readonly quantity?: number;
  readonly returnTo?: string;
}

/** Input for `wishlist.saveForLater`. */
export interface SaveCartLineForLaterInput {
  readonly lineId: MikaId;
  readonly returnTo?: string;
}

/** Input for `wishlist.merge`. */
export interface MergeWishlistInput {
  readonly sourceSessionId?: string;
  readonly targetWishlistId?: MikaId;
  readonly returnTo?: string;
}

/** Input for `checkout.start` and base fields for preview. */
export interface StartCheckoutInput {
  readonly cartId?: MikaId;
  readonly sellableId?: MikaId;
  readonly priceId?: MikaId;
  readonly quantity?: number;
  readonly provider?: ProviderName;
  readonly customer?: CheckoutCustomerInput;
  readonly customFields?: JsonObject;
  readonly successPath?: string;
  readonly cancelPath?: string;
  readonly returnTo?: string;
}

/** Input for `checkout.preview`. */
export interface CheckoutPreviewInput extends StartCheckoutInput {
  readonly quoteId?: MikaId;
  readonly proofRefs?: readonly MikaAgentProofRef[];
}

/** Input for `magicLink.request`. */
export interface MagicLinkRequestInput {
  readonly email: string;
  readonly returnTo?: string;
}

/** Input for `magicLink.verify`. */
export interface MagicLinkVerifyInput {
  readonly token: string;
  readonly returnTo?: string;
}

/** Input for `account.portal`. */
export interface AccountPortalInput {
  readonly returnTo?: string;
}

/** Input for subscription cancel, change, and renew operations. */
export interface SubscriptionActionInput {
  readonly subscriptionId: MikaId;
  readonly priceId?: MikaId;
  readonly returnTo?: string;
}

/** Input for `account.export`. */
export interface AccountExportInput {
  readonly returnTo?: string;
}

/** Input for `account.delete`. */
export interface AccountDeleteInput {
  readonly returnTo?: string;
}

/** Input for `account.exportStatus`. */
export interface AccountExportStatusInput {
  readonly exportId: MikaId;
}

/** Input for `account.exportDownload`. */
export interface AccountExportDownloadInput {
  readonly exportId: MikaId;
  readonly token?: string;
}

/** Input for `checkout.status`. */
export interface CheckoutStatusInput {
  readonly checkoutId: MikaId;
  readonly token?: string;
}

/** Input for `checkout.cancel`. */
export interface CheckoutCancelInput {
  readonly checkoutId: MikaId;
}

/** Input for `order.invoice`. */
export interface OrderInvoiceInput {
  readonly orderId: MikaId;
  readonly token?: string;
  readonly returnTo?: string;
}

export interface OrderInvoiceDTO {
  readonly orderId: MikaId;
  readonly href?: string;
  readonly expiresAt?: ISODateTime;
}

/** Provider adapter capability flags surfaced in health checks. */
export const MIKA_PROVIDER_CAPABILITIES = [
  "hosted_checkout",
  "payments",
  "subscriptions",
  "subscription_renew",
  "subscription_change",
  "subscription_cancel",
  "portal",
  "invoice_url",
  "refunds",
  "coupons",
  "product_sync",
  "variant_sync",
  "stock_sync",
  "webhook_signatures",
] as const;

export type MikaProviderCapability = (typeof MIKA_PROVIDER_CAPABILITIES)[number];

export interface ProviderHealthDTO {
  readonly provider: ProviderName;
  readonly ok: boolean;
  readonly capabilities: readonly MikaProviderCapability[];
  readonly warnings?: readonly string[];
  readonly checkedAt?: ISODateTime;
}

/** Raw provider webhook payload presented to `webhook.receive`. */
export interface WebhookReceiveInput {
  readonly provider: ProviderName;
  readonly eventType?: string;
  readonly payloadHash?: string;
  readonly providerEventId?: string;
}

export interface WebhookReceiveDTO {
  readonly id?: MikaId;
  readonly status: "received" | "duplicate" | "failed";
  readonly replayable?: boolean;
}

/** Async or immediate outcome envelope for admin mutations. */
export interface AdminActionResultDTO {
  readonly id?: MikaId;
  readonly status: "queued" | "running" | "completed" | "failed" | "unsupported";
  readonly message?: string;
  readonly redirectUrl?: string;
  readonly affected?: Record<string, number>;
}

/** Input for `admin.providerHealth`. */
export interface ProviderHealthInput {
  readonly provider?: ProviderName;
}

/** Input for `admin.providerSync`. */
export interface ProviderSyncInput {
  readonly provider?: ProviderName;
  readonly mode?: "dry_run" | "apply";
  readonly scope?: "all" | "entry";
  readonly contentRef?: ContentRefDTO;
}

/** Input for `admin.stockAdjust`. */
export interface StockAdjustInput {
  readonly stockItemId: MikaId;
  readonly quantityDelta: number;
  readonly reason?: StockMovementReason;
  readonly adminAuditId?: MikaId;
  readonly idempotencyKey?: string;
  readonly metadata?: JsonObject;
}

/** Input for `admin.releaseExpiredReservations`. */
export interface ReleaseExpiredReservationsInput {
  readonly now?: ISODateTime;
}

/** Input for `admin.webhookReplay`. */
export interface WebhookReplayInput {
  readonly webhookId: MikaId;
}

/** Input for `admin.orderRefund`. */
export interface OrderRefundInput {
  readonly orderId: MikaId;
  readonly amount?: number;
  readonly reason?: string;
  readonly idempotencyKey?: string;
}

/** Input for `admin.orderCancel`. */
export interface OrderCancelInput {
  readonly orderId: MikaId;
  readonly reason?: string;
  readonly idempotencyKey?: string;
}

/** Input for `admin.entitlementGrant`. */
export interface EntitlementGrantInput {
  readonly entitlementKey: string;
  readonly customerId?: MikaId;
  readonly userId?: string;
  readonly email?: string;
  readonly expiresAt?: ISODateTime;
  readonly idempotencyKey?: string;
}

/** Input for `admin.entitlementRevoke`. */
export interface EntitlementRevokeInput {
  readonly entitlementId?: MikaId;
  readonly entitlementKey?: string;
  readonly customerId?: MikaId;
  readonly reason?: string;
  readonly idempotencyKey?: string;
}

/** Input for `admin.emailResend`. */
export interface EmailResendInput {
  readonly emailId: MikaId;
  readonly idempotencyKey?: string;
}

/** Input for `admin.licenseRevoke`. */
export interface LicenseRevokeInput {
  readonly licenseId: MikaId;
  readonly reason?: string;
  readonly idempotencyKey?: string;
}

/** Input for `admin.downloadIssue`. */
export interface DownloadIssueInput {
  readonly entitlementId?: MikaId;
  readonly orderId?: MikaId;
  readonly orderLineId?: MikaId;
  readonly expiresAt?: ISODateTime;
  readonly idempotencyKey?: string;
}
