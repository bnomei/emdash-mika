/**
 * Provider adapter contract and registry for payment providers: checkout, portal, subscriptions,
 * refunds, catalog sync, and webhook verification that feed Mika order fulfillment workflows.
 *
 * Optional adapter methods must align with the capabilities returned by {@link capabilities};
 * hosts gate operations with {@link MIKA_PROVIDER_CAPABILITIES} from the wire type layer.
 */
import type {
  AdminActionResultDTO,
  CheckoutCustomerInput,
  CheckoutStatusDTO,
  ContentRefDTO,
  MikaProviderCapability,
  MoneyDTO,
  OrderInvoiceDTO,
  ProviderHealthDTO,
  VariantOptionValueDTO,
} from "./api/types";
import type {
  CurrencyCode,
  FulfillmentKind,
  ISODateTime,
  JsonObject,
  MikaId,
  PaymentStatus,
  ProviderName,
  PurchaseMode,
  SubscriptionStatus,
} from "./types/primitives";

/** Checkout metadata key carrying an ACP delegated payment token for provider handoff. */
export const MIKA_DELEGATED_PAYMENT_TOKEN_METADATA_KEY = "acpPaymentToken";

/** Checkout metadata key naming the ACP payment provider (stripe, adyen, braintree). */
export const MIKA_DELEGATED_PAYMENT_PROVIDER_METADATA_KEY = "acpPaymentProvider";

/** Checkout metadata key storing the ACP payment authorization id after completion. */
export const MIKA_DELEGATED_PAYMENT_AUTHORIZATION_METADATA_KEY = "acpPaymentAuthorizationId";

/** Checkout metadata key binding delegated checkout start to the preview payment authorization. */
export const MIKA_DELEGATED_PAYMENT_AUTHORIZATION_INPUT_HASH_METADATA_KEY =
  "acpPaymentAuthorizationInputHash";

/** Checkout metadata key linking a delegated provider charge back to the ACP checkout session. */
export const MIKA_DELEGATED_PAYMENT_CHECKOUT_SESSION_ID_METADATA_KEY = "acpCheckoutSessionId";

/** Contract implemented by payment providers (Stripe, etc.) for checkout and fulfillment hooks. */
export interface MikaProviderAdapter {
  readonly id: ProviderName;
  capabilities(): Promise<readonly MikaProviderCapability[]> | readonly MikaProviderCapability[];
  /** Optional liveness probe for admin provider.health. */
  health?(): Promise<ProviderHealthDTO>;
  createCheckoutSession(input: MikaProviderCheckoutInput): Promise<MikaProviderCheckoutSession>;
  retrieveCheckoutSession(id: string): Promise<MikaProviderCheckoutSession>;
  /** Required when the host exposes account.portal for billing self-service. */
  createPortalSession?(input: MikaProviderPortalInput): Promise<MikaProviderPortalSession>;
  /** Required when order.invoice requests a hosted provider invoice URL. */
  getInvoiceUrl?(input: MikaProviderInvoiceInput): Promise<OrderInvoiceDTO>;
  cancelSubscription?(input: MikaProviderSubscriptionActionInput): Promise<AdminActionResultDTO>;
  changeSubscription?(input: MikaProviderSubscriptionActionInput): Promise<AdminActionResultDTO>;
  renewSubscription?(input: MikaProviderSubscriptionActionInput): Promise<AdminActionResultDTO>;
  refundPayment?(input: MikaProviderRefundInput): Promise<AdminActionResultDTO>;
  cancelOrder?(input: MikaProviderOrderCancelInput): Promise<AdminActionResultDTO>;
  /** Optional catalog sync hook for admin provider.sync. */
  syncCatalog?(input: MikaProviderSyncInput): Promise<AdminActionResultDTO>;
  /** Required for webhook.receive signature verification. */
  verifyWebhook?(input: MikaProviderWebhookVerificationInput): Promise<MikaVerifiedWebhookPayload>;
  /** Required to normalize verified webhook payloads into Mika payment events. */
  parseWebhookEvent?(input: MikaVerifiedWebhookPayload): Promise<MikaProviderWebhookEvent>;
}

/** Lookup table of registered provider adapters keyed by provider name. */
export interface MikaProviderRegistry {
  get(provider: ProviderName): MikaProviderAdapter | undefined;
  list(): readonly MikaProviderAdapter[];
}

/** Input for creating a hosted or delegated provider checkout session from Mika cart lines. */
export interface MikaProviderCheckoutInput {
  readonly idempotencyKey?: string;
  readonly mode: PurchaseMode;
  readonly provider: ProviderName;
  readonly customer?: CheckoutCustomerInput;
  readonly lines: readonly MikaProviderLineItem[];
  /**
   * Order-level discount (e.g. an applied cart coupon) that the provider must subtract from the
   * amount it charges. `lines` always carry undiscounted catalog amounts; adapters apply this on
   * top so the provider charge matches the Mika checkout/order total.
   */
  readonly discount?: MoneyDTO;
  readonly successUrl: string;
  readonly cancelUrl: string;
  readonly metadata?: JsonObject;
}

/** Normalized checkout session returned by a provider adapter after create or retrieve. */
export interface MikaProviderCheckoutSession {
  readonly id: MikaId;
  readonly status: CheckoutStatusDTO;
  readonly mode: PurchaseMode;
  readonly provider: ProviderName;
  readonly redirectUrl?: string;
  readonly expiresAt?: ISODateTime;
  readonly providerCheckoutId?: string;
  readonly providerCustomerId?: string;
  readonly raw?: JsonObject;
}

/** Input for opening a provider-hosted customer billing portal from a stored customer id. */
export interface MikaProviderPortalInput {
  readonly providerCustomerId: string;
  readonly returnUrl: string;
}

/** Redirect URL and optional expiry returned after creating a billing portal session. */
export interface MikaProviderPortalSession {
  readonly redirectUrl: string;
  readonly expiresAt?: ISODateTime;
}

/** Lookup keys for resolving a hosted invoice URL from a Mika order and provider payment ids. */
export interface MikaProviderInvoiceInput {
  readonly orderId: MikaId;
  readonly providerPaymentId?: string;
  readonly providerOrderId?: string;
}

/** Target subscription and optional new price for cancel, change, or renew provider actions. */
export interface MikaProviderSubscriptionActionInput {
  readonly subscriptionId: MikaId;
  readonly providerSubscriptionId?: string;
  readonly priceId?: MikaId;
  readonly providerPriceId?: string;
  readonly metadata?: JsonObject;
}

/** Refund request scoped to a Mika order with optional partial amount and provider payment id. */
export interface MikaProviderRefundInput {
  readonly orderId: MikaId;
  readonly providerPaymentId?: string;
  readonly amount?: number;
  readonly reason?: string;
  /** Admin idempotency key, forwarded to the provider so a retried refund dedupes provider-side. */
  readonly idempotencyKey?: string;
}

/** Cancel request for a provider-side order or payment intent tied to a Mika order. */
export interface MikaProviderOrderCancelInput {
  readonly orderId: MikaId;
  readonly providerPaymentId?: string;
  readonly providerOrderId?: string;
  readonly reason?: string;
}

/** Catalog sync scope and dry-run mode for pushing Mika sellables to a provider catalog. */
export interface MikaProviderSyncInput {
  readonly mode?: "dry_run" | "apply";
  readonly scope?: "all" | "entry";
  readonly contentRef?: ContentRefDTO;
}

/** Sellable line passed to a provider when opening checkout or reconciling webhook payments. */
export interface MikaProviderLineItem {
  readonly sellableId: MikaId;
  readonly priceId?: MikaId;
  readonly contentRef: ContentRefDTO;
  readonly sku?: string;
  readonly title: string;
  readonly variantKey?: string;
  readonly variantOptions?: readonly VariantOptionValueDTO[];
  readonly providerProductId?: string;
  readonly providerPriceId?: string;
  readonly quantity: number;
  readonly unitAmount: number;
  readonly currency: CurrencyCode;
  readonly mode: PurchaseMode;
  readonly fulfillmentKind: FulfillmentKind;
  readonly entitlementKey?: string;
  readonly interval?: "month" | "year";
  readonly intervalCount?: number;
  readonly metadata?: JsonObject;
}

/** Raw HTTP webhook request handed to a provider adapter for signature verification. */
export interface MikaProviderWebhookVerificationInput {
  readonly provider: ProviderName;
  readonly request: Request;
  readonly rawBody: Uint8Array;
}

/** Verified webhook body and metadata produced after provider signature checks. */
export interface MikaVerifiedWebhookPayload {
  readonly provider: ProviderName;
  readonly rawBody: Uint8Array;
  readonly payloadHash: string;
  readonly headers?: Record<string, string>;
  readonly parsed?: JsonObject;
}

/** Discriminated provider webhook events normalized for Mika order and subscription workflows. */
export type MikaProviderWebhookEvent =
  | MikaProviderPaymentEvent
  | MikaProviderSubscriptionEvent
  | MikaProviderUnknownWebhookEvent;

/** Normalized payment webhook event driving Mika order confirmation and fulfillment. */
export interface MikaProviderPaymentEvent {
  readonly kind: "payment";
  readonly paymentStatus: PaymentStatus | (string & {});
  readonly provider: ProviderName;
  readonly providerEventId?: string;
  readonly type: string;
  readonly providerCheckoutId?: string;
  readonly providerPaymentId?: string;
  readonly providerOrderId?: string;
  readonly providerSubscriptionId?: string;
  readonly customer?: CheckoutCustomerInput;
  readonly lines: readonly MikaProviderLineItem[];
  readonly totals?: {
    readonly subtotal?: MoneyDTO;
    readonly discount?: MoneyDTO;
    readonly tax?: MoneyDTO;
    readonly total?: MoneyDTO;
  };
  readonly invoiceUrl?: string;
  readonly raw?: JsonObject;
}

/** Normalized subscription webhook event for Mika subscription state reconciliation. */
export interface MikaProviderSubscriptionEvent {
  readonly kind: "subscription";
  readonly provider: ProviderName;
  readonly providerEventId?: string;
  readonly type: string;
  readonly providerSubscriptionId?: string;
  readonly providerCustomerId?: string;
  readonly providerPriceId?: string;
  readonly status: SubscriptionStatus;
  readonly currentPeriodStart?: ISODateTime;
  readonly currentPeriodEnd?: ISODateTime;
  readonly cancelAtPeriodEnd?: boolean;
  readonly raw?: JsonObject;
}

/** Fallback webhook event when a provider event type is not mapped to payment or subscription. */
export interface MikaProviderUnknownWebhookEvent {
  readonly kind: "unknown";
  readonly provider: ProviderName;
  readonly providerEventId?: string;
  readonly type: string;
  readonly raw?: JsonObject;
}

/** Identity helper for authoring provider adapters with full type inference. */
export function defineMikaProvider(adapter: MikaProviderAdapter): MikaProviderAdapter {
  return adapter;
}

/** Builds a provider registry from one or more `MikaProviderAdapter` instances. */
export function createMikaProviderRegistry(
  providers: readonly MikaProviderAdapter[] = [],
): MikaProviderRegistry {
  const adapters = new Map(providers.map((provider) => [provider.id, provider]));

  return {
    get: (provider) => adapters.get(provider),
    list: () => [...adapters.values()],
  };
}
