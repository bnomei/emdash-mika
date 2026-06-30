/**
 * Typed notification intents emitted by the backend after commerce lifecycle events.
 * Hosts may intercept via {@link MikaNotificationHook} or rely on default email outbox behavior.
 */
import type {
  CheckoutStatus,
  FulfillmentKind,
  ISODateTime,
  JsonObject,
  MikaId,
  Money,
  ProviderName,
  SubscriptionStatus,
} from "../types/primitives";

/** Discriminant for notification intents raised by backend workflows. */
export type MikaNotificationKind =
  | "magic_link.requested"
  | "order.confirmed"
  | "checkout.payment_failed"
  | "download.ready"
  | "license.issued"
  | "subscription.started"
  | "subscription.updated"
  | "subscription.renewal_failed"
  | "account.export_ready"
  | "account.delete_requested"
  | "ops.webhook_failed";

/** Recipient identity fields shared across notification contexts. */
export interface MikaNotificationRecipientContext {
  readonly toEmail?: string;
  readonly customerId?: MikaId;
  readonly userId?: string;
  readonly emailHash?: string;
}

/** Magic-link flow that triggered the notification (sign-in, checkout, account delete, or host extension). */
export type MikaMagicLinkNotificationPurpose =
  | "sign_in"
  | "checkout"
  | "account_delete"
  | (string & {});

/** Context for magic-link delivery after token issuance. */
export interface MikaMagicLinkRequestedNotificationContext extends MikaNotificationRecipientContext {
  readonly toEmail: string;
  readonly link: string;
  readonly purpose: MikaMagicLinkNotificationPurpose;
  readonly expiresAt: ISODateTime;
  readonly returnTo?: string;
  readonly tokenId: MikaId;
}

/** Single fulfilled line item included in an order-confirmed notification. */
export interface MikaOrderConfirmedNotificationLine {
  readonly lineId: MikaId;
  readonly sellableId: MikaId;
  readonly priceId?: MikaId;
  readonly sku?: string;
  readonly title: string;
  readonly quantity: number;
  readonly total: Money;
  readonly fulfillmentKind: FulfillmentKind;
  readonly entitlementId?: MikaId;
  readonly downloadRefs?: readonly string[];
  readonly licenseKeySuffix?: string;
  readonly stockMovementId?: MikaId;
  readonly metadata?: JsonObject;
}

/** Context for post-checkout order confirmation email or host handler. */
export interface MikaOrderConfirmedNotificationContext extends MikaNotificationRecipientContext {
  readonly toEmail: string;
  readonly orderId: MikaId;
  readonly orderNumber: string;
  readonly provider?: ProviderName;
  readonly providerPaymentId?: string;
  readonly providerOrderId?: string;
  readonly checkoutSessionId?: MikaId;
  readonly total: Money;
  readonly fulfilledLines: readonly MikaOrderConfirmedNotificationLine[];
  readonly fulfillmentKinds: readonly FulfillmentKind[];
}

/** Context when checkout payment fails or a provider webhook reports failure. */
export interface MikaCheckoutPaymentFailedNotificationContext extends MikaNotificationRecipientContext {
  readonly checkoutId?: MikaId;
  readonly orderId?: MikaId;
  readonly provider: ProviderName;
  readonly providerCheckoutId?: string;
  readonly providerPaymentId?: string;
  readonly providerOrderId?: string;
  readonly status?: CheckoutStatus | string;
  readonly paymentStatus?: string;
  readonly eventType?: string;
  readonly webhookId?: MikaId;
  readonly error?: string;
  readonly total?: Money;
}

/** Context when a download token or entitlement link is ready for delivery. */
export interface MikaDownloadReadyNotificationContext extends MikaNotificationRecipientContext {
  readonly downloadRef: string;
  readonly orderId?: MikaId;
  readonly orderLineId?: MikaId;
  readonly title?: string;
  readonly tokenId?: MikaId;
  readonly expiresAt?: ISODateTime;
  readonly entitlementId?: MikaId;
  readonly licenseId?: MikaId;
}

/** Context when a license key is issued for a fulfilled order line. */
export interface MikaLicenseIssuedNotificationContext extends MikaNotificationRecipientContext {
  readonly licenseId: MikaId;
  readonly orderId?: MikaId;
  readonly orderLineId?: MikaId;
  readonly entitlementId?: MikaId;
  readonly displayKeySuffix: string;
  readonly sellableId?: MikaId;
  readonly fulfillmentKind?: FulfillmentKind;
}

/** Context for subscription lifecycle events (start, update, renewal failure). */
export interface MikaSubscriptionNotificationContext extends MikaNotificationRecipientContext {
  readonly subscriptionId: MikaId;
  readonly status: SubscriptionStatus;
  readonly previousStatus?: SubscriptionStatus;
  readonly provider: ProviderName;
  readonly providerCustomerId?: string;
  readonly providerSubscriptionId?: string;
  readonly providerPriceId?: string;
  readonly currentPeriodEnd?: ISODateTime;
  readonly cancelAtPeriodEnd?: boolean;
  readonly sellableId?: MikaId;
  readonly title?: string;
  readonly entitlementId?: MikaId;
  readonly eventType?: string;
}

/** Context when a customer data export is ready to download. */
export interface MikaAccountExportReadyNotificationContext extends MikaNotificationRecipientContext {
  readonly exportId: MikaId;
  readonly expiresAt: ISODateTime;
  readonly downloadHref?: string;
  readonly tokenId?: MikaId;
}

/** Context when a customer requests account deletion. */
export interface MikaAccountDeleteRequestedNotificationContext extends MikaNotificationRecipientContext {
  readonly requestId: MikaId;
}

/** Ops-facing context when inbound provider webhook processing fails persistently. */
export interface MikaOpsWebhookFailedNotificationContext {
  readonly webhookId: MikaId;
  readonly provider: ProviderName;
  readonly eventType: string;
  readonly providerEventId?: string;
  readonly payloadHash: string;
  readonly lastError: string;
  readonly relatedCustomerId?: MikaId;
  readonly relatedOrderId?: MikaId;
  readonly relatedSubscriptionId?: MikaId;
}

/** Fallback notification context for kinds without a dedicated payload shape. */
export interface MikaGenericNotificationContext extends MikaNotificationRecipientContext {
  readonly metadata?: JsonObject;
}

/** Maps each notification kind to its structured context payload. */
export interface MikaNotificationContextMap {
  readonly "magic_link.requested": MikaMagicLinkRequestedNotificationContext;
  readonly "order.confirmed": MikaOrderConfirmedNotificationContext;
  readonly "checkout.payment_failed": MikaCheckoutPaymentFailedNotificationContext;
  readonly "download.ready": MikaDownloadReadyNotificationContext;
  readonly "license.issued": MikaLicenseIssuedNotificationContext;
  readonly "subscription.started": MikaSubscriptionNotificationContext;
  readonly "subscription.updated": MikaSubscriptionNotificationContext;
  readonly "subscription.renewal_failed": MikaSubscriptionNotificationContext;
  readonly "account.export_ready": MikaAccountExportReadyNotificationContext;
  readonly "account.delete_requested": MikaAccountDeleteRequestedNotificationContext;
  readonly "ops.webhook_failed": MikaOpsWebhookFailedNotificationContext;
}

/** Tagged notification event with occurrence time and kind-specific context. */
export type MikaNotificationIntent<TKind extends MikaNotificationKind = MikaNotificationKind> = {
  readonly [Kind in TKind]: {
    readonly kind: Kind;
    readonly occurredAt: ISODateTime;
    readonly context: MikaNotificationContextMap[Kind];
  };
}[TKind];

/** Outcome returned by a notification hook indicating whether default delivery was suppressed. */
export interface MikaNotificationHookResult {
  readonly handled: boolean;
}

/** Host hook that may fully handle a notification and suppress the default handler. */
export type MikaNotificationHook = (
  intent: MikaNotificationIntent,
) => MikaNotificationHookResult | void | Promise<MikaNotificationHookResult | void>;

/** Invokes the host hook; runs the default handler when the hook does not mark `handled`. */
export async function emitMikaNotification(
  hook: MikaNotificationHook | undefined,
  intent: MikaNotificationIntent,
  defaultHandler?: () => Promise<void> | void,
): Promise<void> {
  const result = await hook?.(intent);
  if (result?.handled === true) return;

  await defaultHandler?.();
}
