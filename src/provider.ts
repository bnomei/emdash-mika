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
  ProviderName,
  PurchaseMode,
  SubscriptionStatus,
} from "./types/primitives";

export interface MikaProviderAdapter {
  readonly id: ProviderName;
  capabilities(): Promise<readonly MikaProviderCapability[]> | readonly MikaProviderCapability[];
  health?(): Promise<ProviderHealthDTO>;
  createCheckoutSession(input: MikaProviderCheckoutInput): Promise<MikaProviderCheckoutSession>;
  retrieveCheckoutSession(id: string): Promise<MikaProviderCheckoutSession>;
  createPortalSession?(input: MikaProviderPortalInput): Promise<MikaProviderPortalSession>;
  getInvoiceUrl?(input: MikaProviderInvoiceInput): Promise<OrderInvoiceDTO>;
  cancelSubscription?(input: MikaProviderSubscriptionActionInput): Promise<AdminActionResultDTO>;
  changeSubscription?(input: MikaProviderSubscriptionActionInput): Promise<AdminActionResultDTO>;
  renewSubscription?(input: MikaProviderSubscriptionActionInput): Promise<AdminActionResultDTO>;
  refundPayment?(input: MikaProviderRefundInput): Promise<AdminActionResultDTO>;
  cancelOrder?(input: MikaProviderOrderCancelInput): Promise<AdminActionResultDTO>;
  syncCatalog?(input: MikaProviderSyncInput): Promise<AdminActionResultDTO>;
  verifyWebhook?(input: MikaProviderWebhookVerificationInput): Promise<MikaVerifiedWebhookPayload>;
  parseWebhookEvent?(input: MikaVerifiedWebhookPayload): Promise<MikaProviderWebhookEvent>;
}

export interface MikaProviderRegistry {
  get(provider: ProviderName): MikaProviderAdapter | undefined;
  list(): readonly MikaProviderAdapter[];
}

export interface MikaProviderCheckoutInput {
  readonly idempotencyKey?: string;
  readonly mode: PurchaseMode;
  readonly provider: ProviderName;
  readonly customer?: CheckoutCustomerInput;
  readonly lines: readonly MikaProviderLineItem[];
  readonly successUrl: string;
  readonly cancelUrl: string;
  readonly metadata?: JsonObject;
}

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

export interface MikaProviderPortalInput {
  readonly providerCustomerId: string;
  readonly returnUrl: string;
}

export interface MikaProviderPortalSession {
  readonly redirectUrl: string;
  readonly expiresAt?: ISODateTime;
}

export interface MikaProviderInvoiceInput {
  readonly orderId: MikaId;
  readonly providerPaymentId?: string;
  readonly providerOrderId?: string;
}

export interface MikaProviderSubscriptionActionInput {
  readonly subscriptionId: MikaId;
  readonly providerSubscriptionId?: string;
  readonly priceId?: MikaId;
  readonly providerPriceId?: string;
  readonly metadata?: JsonObject;
}

export interface MikaProviderRefundInput {
  readonly orderId: MikaId;
  readonly providerPaymentId?: string;
  readonly amount?: number;
  readonly reason?: string;
}

export interface MikaProviderOrderCancelInput {
  readonly orderId: MikaId;
  readonly providerOrderId?: string;
  readonly reason?: string;
}

export interface MikaProviderSyncInput {
  readonly mode?: "dry_run" | "apply";
  readonly scope?: "all" | "entry";
  readonly contentRef?: ContentRefDTO;
}

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
  readonly metadata?: JsonObject;
}

export interface MikaProviderWebhookVerificationInput {
  readonly provider: ProviderName;
  readonly request: Request;
  readonly rawBody: Uint8Array;
}

export interface MikaVerifiedWebhookPayload {
  readonly provider: ProviderName;
  readonly rawBody: Uint8Array;
  readonly payloadHash: string;
  readonly headers?: Record<string, string>;
  readonly parsed?: JsonObject;
}

export type MikaProviderWebhookEvent =
  | MikaProviderPaymentEvent
  | MikaProviderSubscriptionEvent
  | MikaProviderUnknownWebhookEvent;

export interface MikaProviderPaymentEvent {
  readonly kind: "payment";
  readonly paymentStatus: "paid";
  readonly provider: ProviderName;
  readonly providerEventId?: string;
  readonly type: string;
  readonly providerCheckoutId?: string;
  readonly providerPaymentId?: string;
  readonly providerOrderId?: string;
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

export interface MikaProviderUnknownWebhookEvent {
  readonly kind: "unknown";
  readonly provider: ProviderName;
  readonly providerEventId?: string;
  readonly type: string;
  readonly raw?: JsonObject;
}

export function defineMikaProvider(adapter: MikaProviderAdapter): MikaProviderAdapter {
  return adapter;
}

export function createMikaProviderRegistry(
  providers: readonly MikaProviderAdapter[] = [],
): MikaProviderRegistry {
  const adapters = new Map(providers.map((provider) => [provider.id, provider]));

  return {
    get: (provider) => adapters.get(provider),
    list: () => [...adapters.values()],
  };
}
