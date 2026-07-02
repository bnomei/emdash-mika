/**
 * Wire DTOs, operation inputs, and the {@link MikaApiResult} envelope shared across clients and handlers.
 * DTOs are stable JSON shapes; inputs mirror Zod schemas in {@link ./validation}.
 */
import type {
  CartStatus,
  CheckoutStatus,
  CurrencyCode,
  EntitlementStatus,
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
  "NOT_FOUND",
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
  "INTERNAL",
  "NOT_IMPLEMENTED",
] as const;

/** Union of stable API failure codes enumerated in {@link MIKA_ERROR_CODES}. */
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

/** One selectable value within a variant dimension such as size or color. */
export interface VariantOptionValueDTO {
  readonly option: string;
  readonly value: string;
  readonly label?: string;
}

/** Labeled variant axis and its values for purchase UI pickers. */
export interface VariantOptionGroupDTO {
  readonly option: string;
  readonly label: string;
  readonly values: readonly VariantOptionValueDTO[];
}

/** Stock fulfillment state for a sellable at read time. */
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

/** Active sellable price with currency, billing mode, and fulfillment kind. */
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

/** Priced cart row with sellable snapshot, quantity, and live availability. */
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
  readonly status: CartStatus;
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

/** Coupon metadata and discount applied to the cart total. */
export interface AppliedCouponDTO {
  readonly code?: string;
  readonly label?: string;
  readonly discount?: MoneyDTO;
  readonly providerCouponId?: string;
}

/** Saved sellable snapshot with add time and current availability. */
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

/**
 * Lifecycle state of a provider-hosted checkout session: the persisted {@link CheckoutStatus}
 * plus the transport-only `pending` (awaiting provider confirmation) and `binding_mismatch`
 * (delegated-payment proof failed verification) states.
 */
export type CheckoutStatusDTO = CheckoutStatus | "pending" | "binding_mismatch";

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

/** Optional buyer identity and tax fields collected during checkout. */
export interface CheckoutCustomerInput {
  readonly email?: string;
  readonly name?: string;
  readonly company?: string;
  readonly vatId?: string;
}

/** Whether a quoted cart snapshot is still valid for checkout handoff. */
export type CartQuoteStatusDTO = "valid" | "changed" | "expired" | "unavailable";

/** Quote row with pricing snapshot, quantity, and validation warnings. */
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

/** Tax, discount, shipping, or fee line in a quote total breakdown. */
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

/** Agent or buyer readiness gate before payment authorization. */
export type CheckoutPreviewStatusDTO =
  | "ready"
  | "requires_confirmation"
  | "requires_payment_authorization"
  | "unavailable"
  | "expired";

/** Required agent proof kind and binding constraints for checkout preview. */
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

/** Logged-in or checkout-linked buyer profile identifiers. */
export interface CustomerDTO {
  readonly id?: MikaId;
  readonly userId?: string;
  readonly email?: string;
  readonly name?: string;
}

/** Compact order row for account history and order lists. */
export interface OrderSummaryDTO {
  readonly id: MikaId;
  readonly orderNumber: string;
  readonly status: OrderStatus;
  readonly paymentStatus: PaymentStatus;
  readonly total: MoneyDTO;
  readonly createdAt: ISODateTime;
  readonly invoiceHref?: string;
}

/** Recurring purchase with billing period end and self-service actions. */
export interface SubscriptionDTO {
  readonly id: MikaId;
  readonly title: string;
  readonly status: SubscriptionStatus;
  readonly currentPeriodEnd?: ISODateTime;
  readonly cancelAtPeriodEnd: boolean;
  readonly providerActions?: readonly ("portal" | "cancel" | "renew" | "change")[];
}

/** Access grant from orders, subscriptions, or manual admin issuance. */
export interface EntitlementDTO {
  readonly key: string;
  readonly status: EntitlementStatus;
  readonly source: "order" | "subscription" | "manual";
  readonly expiresAt?: ISODateTime;
}

/** Customer-facing downloadable asset with time-limited access href. */
export interface DownloadDTO {
  readonly id: MikaId;
  readonly title: string;
  readonly href: string;
  readonly expiresAt?: ISODateTime;
}

/** Token resolution outcome with redirect URL and expiry. */
export interface DownloadResolutionDTO {
  readonly title?: string;
  readonly redirectUrl?: string;
  readonly expiresAt?: ISODateTime;
}

/** Async personal data export job status and download link when ready. */
export interface AccountExportDTO {
  readonly id: MikaId;
  readonly status: "queued" | "running" | "ready" | "expired" | "failed";
  readonly requestedAt: ISODateTime;
  readonly expiresAt: ISODateTime;
  readonly downloadHref?: string;
}

/** Secure export download link resolved from export job and access token. */
export interface AccountExportDownloadDTO {
  readonly id: MikaId;
  readonly href?: string;
  readonly expiresAt?: ISODateTime;
  readonly requiresConfirmation?: boolean;
  readonly confirmMethod?: "POST";
}

/** Customer account summary with orders, subscriptions, and entitlements. */
export interface AccountDTO {
  readonly customer?: CustomerDTO;
  readonly orders: readonly OrderSummaryDTO[];
  readonly subscriptions: readonly SubscriptionDTO[];
  readonly entitlements: readonly EntitlementDTO[];
  readonly downloads: readonly DownloadDTO[];
}

/** Sellable, price, quantity, and variant selection for a new cart line. */
export interface AddCartItemInput {
  readonly sellableId: MikaId;
  readonly priceId?: MikaId;
  readonly quantity?: number;
  readonly variantKey?: string;
  readonly variantOptions?: Record<string, string>;
  readonly returnTo?: string;
}

/** Source session or cart to fold into the shopper's active cart. */
export interface MergeCartInput {
  readonly sourceSessionId?: string;
  readonly targetCartId?: MikaId;
  readonly returnTo?: string;
}

/** Cart line identifier and target quantity for in-place line updates. */
export interface UpdateCartItemInput {
  readonly lineId: MikaId;
  readonly quantity: number;
  readonly returnTo?: string;
}

/** Cart line identifier to remove from the open cart. */
export interface RemoveCartItemInput {
  readonly lineId: MikaId;
  readonly returnTo?: string;
}

/** Discount code and optional cart scope for coupon application. */
export interface ApplyCouponInput {
  readonly code: string;
  readonly cartId?: MikaId;
  readonly returnTo?: string;
}

/** Optional cart scope when clearing an applied coupon. */
export interface RemoveCouponInput {
  readonly cartId?: MikaId;
  readonly returnTo?: string;
}

/** Cart or ad-hoc purchase details for a priced quote before checkout. */
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

/** Sellable and optional price to save for later purchase. */
export interface WishlistItemInput {
  readonly sellableId: MikaId;
  readonly priceId?: MikaId;
  readonly returnTo?: string;
}

/** Wishlist entry identifier to drop from the saved list. */
export interface RemoveWishlistItemInput {
  readonly itemId: MikaId;
  readonly returnTo?: string;
}

/** Wishlist entry and quantity to transfer into the cart. */
export interface MoveWishlistItemToCartInput {
  readonly itemId: MikaId;
  readonly quantity?: number;
  readonly returnTo?: string;
}

/** Cart line to move off the cart into the wishlist. */
export interface SaveCartLineForLaterInput {
  readonly lineId: MikaId;
  readonly returnTo?: string;
}

/** Source session or wishlist to merge into the active wishlist. */
export interface MergeWishlistInput {
  readonly sourceSessionId?: string;
  readonly targetWishlistId?: MikaId;
  readonly returnTo?: string;
}

/** Cart or direct purchase handoff fields plus provider and redirect paths. */
export interface StartCheckoutInput {
  readonly cartId?: MikaId;
  readonly sellableId?: MikaId;
  readonly priceId?: MikaId;
  readonly quantity?: number;
  readonly provider?: ProviderName;
  readonly couponCode?: string;
  readonly customer?: CheckoutCustomerInput;
  readonly customFields?: JsonObject;
  readonly successPath?: string;
  readonly cancelPath?: string;
  readonly returnTo?: string;
}

/** Checkout handoff fields plus quote binding and agent proof references. */
export interface CheckoutPreviewInput extends StartCheckoutInput {
  readonly quoteId?: MikaId;
  readonly proofRefs?: readonly MikaAgentProofRef[];
}

/** Email address and post-login return path for passwordless sign-in. */
export interface MagicLinkRequestInput {
  readonly email: string;
  readonly returnTo?: string;
}

/** One-time token and return path to complete magic-link authentication. */
export interface MagicLinkVerifyInput {
  readonly token: string;
  readonly returnTo?: string;
}

/** Post-provider-portal return path for billing self-service. */
export interface AccountPortalInput {
  readonly returnTo?: string;
}

/** Subscription identifier and optional plan change for lifecycle actions. */
export interface SubscriptionActionInput {
  readonly subscriptionId: MikaId;
  readonly priceId?: MikaId;
  readonly returnTo?: string;
}

/** Return path after requesting a personal data export. */
export interface AccountExportInput {
  readonly returnTo?: string;
}

/** Return path after initiating account deletion. */
export interface AccountDeleteInput {
  readonly returnTo?: string;
}

/** Export job identifier to poll async export readiness. */
export interface AccountExportStatusInput {
  readonly exportId: MikaId;
}

/** Export job and optional access token for secure download. */
export interface AccountExportDownloadInput {
  readonly exportId: MikaId;
  readonly token?: string;
  readonly consumeToken?: boolean;
}

/** Checkout session and optional status token for payment polling. */
export interface CheckoutStatusInput {
  readonly checkoutId: MikaId;
  readonly token?: string;
}

/** Checkout session to abandon before completion. */
export interface CheckoutCancelInput {
  readonly checkoutId: MikaId;
  readonly token?: string;
}

/** Order, optional invoice token, and return path for hosted invoice access. */
export interface OrderInvoiceInput {
  readonly orderId: MikaId;
  readonly token?: string;
  readonly returnTo?: string;
}

/** Hosted invoice URL and expiry for an order. */
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

/** Union of payment-provider feature flags in {@link MIKA_PROVIDER_CAPABILITIES}. */
export type MikaProviderCapability = (typeof MIKA_PROVIDER_CAPABILITIES)[number];

/** Provider adapter liveness with declared capabilities and probe warnings. */
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

/** Ingest outcome for an incoming provider webhook event. */
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

/** Optional provider filter for adapter capability health probes. */
export interface ProviderHealthInput {
  readonly provider?: ProviderName;
}

/** Provider, sync mode, scope, and optional catalog entry for reconciliation. */
export interface ProviderSyncInput {
  readonly provider?: ProviderName;
  readonly mode?: "dry_run" | "apply";
  readonly scope?: "all" | "entry";
  readonly contentRef?: ContentRefDTO;
  readonly idempotencyKey?: string;
}

/** Stock item delta, reason, and idempotency metadata for admin inventory changes. */
export interface StockAdjustInput {
  readonly stockItemId: MikaId;
  readonly quantityDelta: number;
  readonly reason?: StockMovementReason;
  readonly adminAuditId?: MikaId;
  readonly idempotencyKey?: string;
  readonly metadata?: JsonObject;
}

/** Optional clock override for expired reservation maintenance sweeps. */
export interface ReleaseExpiredReservationsInput {
  readonly now?: ISODateTime;
  readonly idempotencyKey?: string;
}

/** Stored webhook event identifier for admin replay. */
export interface WebhookReplayInput {
  readonly webhookId: MikaId;
  readonly idempotencyKey?: string;
}

/** Order, optional partial amount, reason, and idempotency key for refunds. */
export interface OrderRefundInput {
  readonly orderId: MikaId;
  readonly amount?: number;
  readonly reason?: string;
  readonly idempotencyKey?: string;
}

/** Order and optional reason with idempotency for cancellation. */
export interface OrderCancelInput {
  readonly orderId: MikaId;
  readonly reason?: string;
  readonly idempotencyKey?: string;
}

/** Entitlement key and customer identity for manual access grants. */
export interface EntitlementGrantInput {
  readonly entitlementKey: string;
  readonly customerId?: MikaId;
  readonly userId?: string;
  readonly email?: string;
  readonly expiresAt?: ISODateTime;
  readonly idempotencyKey?: string;
}

/** Entitlement or customer identifiers and reason for access revocation. */
export interface EntitlementRevokeInput {
  readonly entitlementId?: MikaId;
  readonly entitlementKey?: string;
  readonly customerId?: MikaId;
  readonly reason?: string;
  readonly idempotencyKey?: string;
}

/** Queued email and idempotency key for delivery retry. */
export interface EmailResendInput {
  readonly emailId: MikaId;
  readonly idempotencyKey?: string;
}

/** License identifier and reason for key revocation. */
export interface LicenseRevokeInput {
  readonly licenseId: MikaId;
  readonly reason?: string;
  readonly idempotencyKey?: string;
}

/** Order or entitlement anchors and expiry for issuing download tokens. */
export interface DownloadIssueInput {
  readonly entitlementId?: MikaId;
  readonly orderId?: MikaId;
  readonly orderLineId?: MikaId;
  readonly expiresAt?: ISODateTime;
  readonly idempotencyKey?: string;
}
