/**
 * Stripe implementation of MikaProviderAdapter: hosted checkout, delegated ACP payment intents,
 * subscription lifecycle, refunds, and webhook event normalization into Mika payment events.
 */
import { createHash } from "node:crypto";

import type {
  AdminActionResultDTO,
  CheckoutStatusDTO,
  MoneyDTO,
  MikaProviderCapability,
  OrderInvoiceDTO,
  ProviderHealthDTO,
} from "./api/types";
import {
  MIKA_DELEGATED_PAYMENT_AUTHORIZATION_METADATA_KEY,
  MIKA_DELEGATED_PAYMENT_PROVIDER_METADATA_KEY,
  MIKA_DELEGATED_PAYMENT_TOKEN_METADATA_KEY,
  defineMikaProvider,
  type MikaProviderAdapter,
  type MikaProviderCheckoutInput,
  type MikaProviderCheckoutSession,
  type MikaProviderLineItem,
  type MikaProviderOrderCancelInput,
  type MikaProviderRefundInput,
  type MikaProviderSubscriptionActionInput,
  type MikaProviderSyncInput,
  type MikaProviderWebhookEvent,
  type MikaProviderWebhookVerificationInput,
  type MikaVerifiedWebhookPayload,
} from "./provider";
import {
  createISODateTime,
  createMikaId,
  createProviderName,
  type JsonObject,
  type ProviderName,
  type SubscriptionStatus,
} from "./types/primitives";

/** Default provider id for the Stripe adapter. */
export const MIKA_STRIPE_PROVIDER_ID = createProviderName("stripe");

/** Checkout metadata key carrying an ACP delegated payment token for PaymentIntent creation. */
export const MIKA_STRIPE_DELEGATED_PAYMENT_TOKEN_METADATA_KEY =
  MIKA_DELEGATED_PAYMENT_TOKEN_METADATA_KEY;

/** Checkout metadata key naming the ACP payment provider (stripe, adyen, braintree). */
export const MIKA_STRIPE_DELEGATED_PAYMENT_PROVIDER_METADATA_KEY =
  MIKA_DELEGATED_PAYMENT_PROVIDER_METADATA_KEY;

/** Checkout metadata key storing the ACP payment authorization id after completion. */
export const MIKA_STRIPE_PAYMENT_AUTHORIZATION_METADATA_KEY =
  MIKA_DELEGATED_PAYMENT_AUTHORIZATION_METADATA_KEY;

/** Minimal Stripe SDK surface required by `createMikaStripeProvider`; inject a real or mock client. */
export interface MikaStripeClient {
  readonly checkout?: {
    readonly sessions: {
      create(
        params: MikaStripeCheckoutSessionCreateParams,
        options?: MikaStripeRequestOptions,
      ): Promise<MikaStripeCheckoutSession>;
      retrieve(
        id: string,
        params?: JsonObject,
        options?: MikaStripeRequestOptions,
      ): Promise<MikaStripeCheckoutSession>;
    };
  };
  readonly paymentIntents?: {
    create(
      params: MikaStripePaymentIntentCreateParams,
      options?: MikaStripeRequestOptions,
    ): Promise<MikaStripePaymentIntent>;
    retrieve?(
      id: string,
      params?: JsonObject,
      options?: MikaStripeRequestOptions,
    ): Promise<MikaStripePaymentIntent>;
    cancel?(
      id: string,
      params?: JsonObject,
      options?: MikaStripeRequestOptions,
    ): Promise<MikaStripePaymentIntent>;
  };
  readonly billingPortal?: {
    readonly sessions: {
      create(
        params: MikaStripePortalSessionCreateParams,
        options?: MikaStripeRequestOptions,
      ): Promise<MikaStripePortalSession>;
    };
  };
  readonly invoices?: {
    retrieve(
      id: string,
      params?: JsonObject,
      options?: MikaStripeRequestOptions,
    ): Promise<MikaStripeInvoice>;
  };
  readonly refunds?: {
    create(
      params: MikaStripeRefundCreateParams,
      options?: MikaStripeRequestOptions,
    ): Promise<{
      readonly id: string;
      readonly status?: string | null;
    }>;
  };
  readonly coupons?: {
    create(
      params: MikaStripeCouponCreateParams,
      options?: MikaStripeRequestOptions,
    ): Promise<{ readonly id: string }>;
  };
  readonly subscriptions?: {
    cancel(
      id: string,
      params?: JsonObject,
      options?: MikaStripeRequestOptions,
    ): Promise<MikaStripeSubscription>;
    update(
      id: string,
      params: JsonObject,
      options?: MikaStripeRequestOptions,
    ): Promise<MikaStripeSubscription>;
    resume?(
      id: string,
      params?: JsonObject,
      options?: MikaStripeRequestOptions,
    ): Promise<MikaStripeSubscription>;
  };
  readonly webhooks?: {
    constructEvent(payload: string, signature: string, secret: string): unknown;
  };
}

/** Configuration for the Stripe provider adapter including client, webhook secret, and optional catalog sync. */
export interface CreateMikaStripeProviderOptions {
  readonly stripe: MikaStripeClient;
  readonly id?: ProviderName;
  readonly webhookSecret?: string;
  readonly capabilities?: readonly MikaProviderCapability[];
  readonly catalogSync?: (input: MikaProviderSyncInput) => Promise<AdminActionResultDTO>;
  readonly now?: () => Date;
}

/** Per-request Stripe SDK options forwarded by the adapter, primarily for idempotency keys. */
export interface MikaStripeRequestOptions {
  readonly idempotencyKey?: string;
}

/** Parameters for creating a Stripe Checkout Session from Mika cart lines and redirect URLs. */
export interface MikaStripeCheckoutSessionCreateParams {
  readonly mode: string;
  readonly line_items: readonly MikaStripeJsonObject[];
  readonly success_url: string;
  readonly cancel_url: string;
  readonly customer_email?: string;
  readonly client_reference_id?: string;
  readonly metadata?: Record<string, string>;
  readonly discounts?: readonly { readonly coupon: string }[];
}

/** Parameters for creating a one-time Stripe coupon used to apply a checkout discount. */
export interface MikaStripeCouponCreateParams {
  readonly amount_off: number;
  readonly currency: string;
  readonly duration: "once";
  readonly name?: string;
  readonly max_redemptions?: number;
}

/** Stripe Checkout Session resource shape used by the adapter for status and redirect mapping. */
export interface MikaStripeCheckoutSession {
  readonly id: string;
  readonly object?: string;
  readonly status?: string | null;
  readonly payment_status?: string | null;
  readonly mode?: string | null;
  readonly url?: string | null;
  readonly expires_at?: number | null;
  readonly customer?: string | null | { readonly id?: string };
  readonly payment_intent?: string | null | { readonly id?: string };
  readonly subscription?: string | null | { readonly id?: string };
  readonly metadata?: Record<string, string> | null;
  readonly [key: string]: unknown;
}

/** Parameters for creating a confirmed delegated PaymentIntent from an ACP shared payment token. */
export interface MikaStripePaymentIntentCreateParams {
  readonly amount: number;
  readonly currency: string;
  readonly confirm: boolean;
  readonly payment_method_data: MikaStripeJsonObject;
  readonly metadata?: Record<string, string>;
}

/** Stripe PaymentIntent resource shape used for delegated checkout and webhook normalization. */
export interface MikaStripePaymentIntent {
  readonly id: string;
  readonly object?: string;
  readonly status?: string | null;
  readonly amount?: number | null;
  readonly currency?: string | null;
  readonly customer?: string | null | { readonly id?: string };
  readonly latest_charge?: string | null | { readonly id?: string };
  readonly next_action?: JsonObject | null;
  readonly metadata?: Record<string, string> | null;
  readonly [key: string]: unknown;
}

/** Parameters for creating a Stripe Billing Portal session for subscription self-service. */
export interface MikaStripePortalSessionCreateParams {
  readonly customer: string;
  readonly return_url: string;
}

/** Stripe Billing Portal session resource with redirect URL and expiry timestamp. */
export interface MikaStripePortalSession {
  readonly url?: string | null;
  readonly expires_at?: number | null;
  readonly [key: string]: unknown;
}

/** Stripe Invoice resource consulted when resolving hosted invoice URLs for orders. */
export interface MikaStripeInvoice {
  readonly id: string;
  readonly hosted_invoice_url?: string | null;
  readonly status?: string | null;
  readonly [key: string]: unknown;
}

/** Parameters for issuing a full or partial refund against a payment intent or charge. */
export interface MikaStripeRefundCreateParams {
  readonly payment_intent?: string;
  readonly charge?: string;
  readonly amount?: number;
  readonly reason?: string;
}

/** Stripe Subscription resource shape used for lifecycle actions and webhook reconciliation. */
export interface MikaStripeSubscription {
  readonly id: string;
  readonly status?: string | null;
  readonly customer?: string | null | { readonly id?: string };
  readonly current_period_start?: number | null;
  readonly current_period_end?: number | null;
  readonly cancel_at_period_end?: boolean | null;
  readonly items?: {
    readonly data?: readonly {
      readonly price?: { readonly id?: string | null };
    }[];
  };
  readonly [key: string]: unknown;
}

/** Loose JSON object type for Stripe SDK payloads not modeled as dedicated interfaces. */
export type MikaStripeJsonObject = JsonObject;

/** Creates a `MikaProviderAdapter` backed by Stripe checkout, billing portal, and webhooks. */
export function createMikaStripeProvider(
  options: CreateMikaStripeProviderOptions,
): MikaProviderAdapter {
  const id = options.id ?? MIKA_STRIPE_PROVIDER_ID;

  return defineMikaProvider({
    id,
    capabilities: () => stripeCapabilities(options),
    health: async () => stripeHealth(id, options),
    createCheckoutSession: async (input) => createStripeCheckoutSession(id, options, input),
    retrieveCheckoutSession: async (checkoutSessionId) =>
      retrieveStripeCheckoutSession(id, options, checkoutSessionId),
    createPortalSession: async (input) => {
      if (!options.stripe.billingPortal?.sessions) {
        throw new Error("Stripe billing portal sessions are not available.");
      }

      const session = await options.stripe.billingPortal.sessions.create({
        customer: input.providerCustomerId,
        return_url: input.returnUrl,
      });

      return {
        redirectUrl: requiredString(session.url, "Stripe portal session URL"),
        expiresAt: stripeTimestamp(session.expires_at),
      };
    },
    getInvoiceUrl: async (input): Promise<OrderInvoiceDTO> => {
      if (!options.stripe.invoices || !input.providerPaymentId) {
        return { orderId: input.orderId };
      }

      const invoiceId = await resolveStripeInvoiceId(options, input.providerPaymentId);
      if (!invoiceId) {
        return { orderId: input.orderId };
      }

      const invoice = await options.stripe.invoices.retrieve(invoiceId);

      return {
        orderId: input.orderId,
        ...(invoice.hosted_invoice_url ? { href: invoice.hosted_invoice_url } : {}),
      };
    },
    cancelSubscription: async (input) => {
      if (!options.stripe.subscriptions || !input.providerSubscriptionId) {
        return unsupportedAction("subscription_cancel", "Stripe subscription id is required.");
      }

      try {
        const subscription = await options.stripe.subscriptions.update(input.providerSubscriptionId, {
          cancel_at_period_end: true,
        });

        return completedAction(
          "subscription_cancel",
          `Stripe subscription ${subscription.id} set to cancel at period end.`,
        );
      } catch (error) {
        return failedAction("subscription_cancel", stripeActionErrorMessage(error));
      }
    },
    changeSubscription: async (input) => changeStripeSubscription(options, input),
    renewSubscription: async (input) => renewStripeSubscription(options, input),
    refundPayment: async (input) => refundStripePayment(options, input),
    cancelOrder: async (input) => cancelStripeOrder(options, input),
    syncCatalog: options.catalogSync
      ? async (input) => options.catalogSync?.(input) ?? unsupportedAction("catalog_sync")
      : async () => unsupportedAction("catalog_sync", "Stripe catalog sync is not configured."),
    verifyWebhook: async (input) => verifyStripeWebhook(id, options, input),
    parseWebhookEvent: async (input) => parseStripeWebhookEvent(id, input),
  });
}

function stripeCapabilities(
  options: CreateMikaStripeProviderOptions,
): readonly MikaProviderCapability[] {
  if (options.capabilities) return options.capabilities;

  const capabilities: MikaProviderCapability[] = [];
  if (options.stripe.checkout?.sessions) capabilities.push("hosted_checkout");
  if (options.stripe.paymentIntents?.create || options.stripe.checkout?.sessions) {
    capabilities.push("payments");
  }
  if (options.stripe.subscriptions) {
    capabilities.push(
      "subscriptions",
      "subscription_renew",
      "subscription_change",
      "subscription_cancel",
    );
  }
  if (options.stripe.billingPortal?.sessions) capabilities.push("portal");
  if (options.stripe.invoices) capabilities.push("invoice_url");
  if (options.stripe.refunds) capabilities.push("refunds");
  if (options.webhookSecret && options.stripe.webhooks?.constructEvent) {
    capabilities.push("webhook_signatures");
  }
  if (options.catalogSync) capabilities.push("product_sync", "variant_sync", "stock_sync");

  return capabilities;
}

async function stripeHealth(
  provider: ProviderName,
  options: CreateMikaStripeProviderOptions,
): Promise<ProviderHealthDTO> {
  const capabilities = stripeCapabilities(options);

  return {
    provider,
    ok: Boolean(options.stripe.checkout?.sessions || options.stripe.paymentIntents),
    capabilities,
    checkedAt: createISODateTime((options.now?.() ?? new Date()).toISOString()),
    warnings: options.webhookSecret ? undefined : ["Stripe webhook secret is not configured."],
  };
}

async function createStripeCheckoutSession(
  provider: ProviderName,
  options: CreateMikaStripeProviderOptions,
  input: MikaProviderCheckoutInput,
): Promise<MikaProviderCheckoutSession> {
  const delegatedToken = readMetadataString(
    input.metadata,
    MIKA_STRIPE_DELEGATED_PAYMENT_TOKEN_METADATA_KEY,
  );
  if (delegatedToken) {
    return createStripeDelegatedPayment(provider, options, input, delegatedToken);
  }

  if (!options.stripe.checkout?.sessions) {
    throw new Error("Stripe checkout sessions are not available.");
  }

  const discounts = await stripeCheckoutDiscounts(options, input);

  const session = await options.stripe.checkout.sessions.create(
    {
      mode: input.mode === "subscription" ? "subscription" : "payment",
      line_items: input.lines.map(stripeCheckoutLineItem),
      success_url: input.successUrl,
      cancel_url: input.cancelUrl,
      ...(input.customer?.email ? { customer_email: input.customer.email } : {}),
      ...(input.idempotencyKey ? { client_reference_id: input.idempotencyKey } : {}),
      ...(discounts ? { discounts } : {}),
      metadata: stripeMetadata({
        ...input.metadata,
        mikaProvider: provider,
        mikaMode: input.mode,
      }),
    },
    requestOptions(input.idempotencyKey),
  );

  return stripeCheckoutSessionToMika(provider, session);
}

async function stripeCheckoutDiscounts(
  options: CreateMikaStripeProviderOptions,
  input: MikaProviderCheckoutInput,
): Promise<readonly { readonly coupon: string }[] | undefined> {
  const amountOff = input.discount?.amount ?? 0;
  if (amountOff <= 0) return undefined;

  if (!options.stripe.coupons?.create) {
    throw new Error("Stripe coupons are required to apply a checkout discount.");
  }

  const currency = (input.discount?.currency ?? input.lines[0]?.currency)?.toLowerCase();
  if (!currency) {
    throw new Error("A checkout discount requires a currency.");
  }

  const coupon = await options.stripe.coupons.create(
    {
      amount_off: amountOff,
      currency,
      duration: "once",
      name: "Mika checkout discount",
      max_redemptions: 1,
    },
    requestOptions(input.idempotencyKey ? `${input.idempotencyKey}_coupon` : undefined),
  );

  return [{ coupon: coupon.id }];
}

async function createStripeDelegatedPayment(
  provider: ProviderName,
  options: CreateMikaStripeProviderOptions,
  input: MikaProviderCheckoutInput,
  delegatedToken: string,
): Promise<MikaProviderCheckoutSession> {
  if (!options.stripe.paymentIntents?.create) {
    throw new Error("Stripe payment intents are required for delegated payments.");
  }

  const subtotal = input.lines.reduce(
    (amount, line) => amount + line.unitAmount * line.quantity,
    0,
  );
  const discountAmount = input.discount && input.discount.amount > 0 ? input.discount.amount : 0;
  const total = Math.max(0, subtotal - discountAmount);
  const currency = input.lines[0]?.currency;
  if (!currency) {
    throw new Error("Delegated Stripe checkout requires at least one line item.");
  }

  const intent = await options.stripe.paymentIntents.create(
    {
      amount: total,
      currency: currency.toLowerCase(),
      confirm: true,
      payment_method_data: {
        shared_payment_granted_token: delegatedToken,
      },
      metadata: stripeMetadata({
        ...input.metadata,
        mikaProvider: provider,
        mikaMode: input.mode,
        mikaCheckoutKind: "delegated_payment",
      }),
    },
    requestOptions(input.idempotencyKey),
  );

  return stripePaymentIntentToMika(provider, input.mode, intent);
}

async function retrieveStripeCheckoutSession(
  provider: ProviderName,
  options: CreateMikaStripeProviderOptions,
  id: string,
): Promise<MikaProviderCheckoutSession> {
  if (id.startsWith("pi_") && options.stripe.paymentIntents?.retrieve) {
    const intent = await options.stripe.paymentIntents.retrieve(id);

    return stripePaymentIntentToMika(provider, "payment", intent);
  }

  if (!options.stripe.checkout?.sessions) {
    throw new Error("Stripe checkout sessions are not available.");
  }

  const session = await options.stripe.checkout.sessions.retrieve(id);

  return stripeCheckoutSessionToMika(provider, session);
}

async function resolveStripeInvoiceId(
  options: CreateMikaStripeProviderOptions,
  providerPaymentId: string,
): Promise<string | undefined> {
  if (providerPaymentId.startsWith("in_")) return providerPaymentId;

  if (providerPaymentId.startsWith("pi_") && options.stripe.paymentIntents?.retrieve) {
    const intent = await options.stripe.paymentIntents.retrieve(providerPaymentId);
    return stripeObjectId(intent["invoice"]);
  }

  return undefined;
}

function stripeCheckoutLineItem(line: MikaProviderLineItem): JsonObject {
  if (line.providerPriceId) {
    return {
      price: line.providerPriceId,
      quantity: line.quantity,
    };
  }

  return {
    quantity: line.quantity,
    price_data: {
      currency: line.currency.toLowerCase(),
      unit_amount: line.unitAmount,
      product_data: {
        name: line.title,
        ...(line.sku ? { metadata: { sku: line.sku } } : {}),
      },
      ...(line.mode === "subscription"
        ? {
            recurring: {
              interval: line.interval ?? "month",
              ...(line.intervalCount && line.intervalCount > 1
                ? { interval_count: line.intervalCount }
                : {}),
            },
          }
        : {}),
    },
  };
}

function stripeCheckoutSessionToMika(
  provider: ProviderName,
  session: MikaStripeCheckoutSession,
): MikaProviderCheckoutSession {
  return {
    id: createMikaId(session.id),
    status: stripeCheckoutStatus(session),
    mode: session.mode === "subscription" ? "subscription" : "payment",
    provider,
    ...(session.url ? { redirectUrl: session.url } : {}),
    expiresAt: stripeTimestamp(session.expires_at),
    providerCheckoutId: session.id,
    providerCustomerId: stripeObjectId(session.customer),
    raw: stripeRaw(session),
  };
}

function stripePaymentIntentToMika(
  provider: ProviderName,
  mode: MikaProviderCheckoutInput["mode"],
  intent: MikaStripePaymentIntent,
): MikaProviderCheckoutSession {
  return {
    id: createMikaId(intent.id),
    status: stripePaymentIntentStatus(intent.status),
    mode,
    provider,
    redirectUrl: stripeNextActionUrl(intent.next_action),
    providerCheckoutId: intent.id,
    providerCustomerId: stripeObjectId(intent.customer),
    raw: stripeRaw(intent),
  };
}

function stripeCheckoutStatus(session: MikaStripeCheckoutSession): CheckoutStatusDTO {
  if (session.payment_status === "paid" || session.status === "complete") return "completed";
  if (session.status === "expired") return "expired";
  if (session.status === "open" && session.url) return "redirected";
  if (session.status === "open") return "created";

  return "pending";
}

function stripePaymentIntentStatus(status: string | null | undefined): CheckoutStatusDTO {
  switch (status) {
    case "succeeded":
      return "completed";
    case "canceled":
      return "cancelled";
    case "requires_payment_method":
      return "failed";
    case "requires_action":
    case "processing":
    case "requires_confirmation":
    case "requires_capture":
      return "pending";
    default:
      return "pending";
  }
}

function stripeNextActionUrl(nextAction: JsonObject | null | undefined): string | undefined {
  const redirect = jsonObjectChild(nextAction, "redirect_to_url");

  return stringChild(redirect, "url");
}

async function changeStripeSubscription(
  options: CreateMikaStripeProviderOptions,
  input: MikaProviderSubscriptionActionInput,
): Promise<AdminActionResultDTO> {
  if (!options.stripe.subscriptions || !input.providerSubscriptionId || !input.providerPriceId) {
    return unsupportedAction(
      "subscription_change",
      "Stripe subscription id and price id are required.",
    );
  }

  try {
    const metadata = stripeMetadata(input.metadata);
    const subscription = await options.stripe.subscriptions.update(
      input.providerSubscriptionId,
      {
        cancel_at_period_end: false,
        items: [{ price: input.providerPriceId }],
        ...(metadata ? { metadata } : {}),
      },
      requestOptions(input.metadata ? stringChild(input.metadata, "idempotencyKey") : undefined),
    );

    return completedAction("subscription_change", `Stripe subscription ${subscription.id} updated.`);
  } catch (error) {
    return failedAction("subscription_change", stripeActionErrorMessage(error));
  }
}

async function renewStripeSubscription(
  options: CreateMikaStripeProviderOptions,
  input: MikaProviderSubscriptionActionInput,
): Promise<AdminActionResultDTO> {
  if (!options.stripe.subscriptions || !input.providerSubscriptionId) {
    return unsupportedAction("subscription_renew", "Stripe subscription id is required.");
  }

  try {
    const subscription = options.stripe.subscriptions.resume
      ? await options.stripe.subscriptions.resume(input.providerSubscriptionId)
      : await options.stripe.subscriptions.update(input.providerSubscriptionId, {
          cancel_at_period_end: false,
        });

    return completedAction("subscription_renew", `Stripe subscription ${subscription.id} renewed.`);
  } catch (error) {
    return failedAction("subscription_renew", stripeActionErrorMessage(error));
  }
}

async function refundStripePayment(
  options: CreateMikaStripeProviderOptions,
  input: MikaProviderRefundInput,
): Promise<AdminActionResultDTO> {
  if (!options.stripe.refunds || !input.providerPaymentId) {
    return unsupportedAction("refund", "Stripe payment intent id is required.");
  }

  const refund = await options.stripe.refunds.create(
    {
      payment_intent: input.providerPaymentId,
      ...(input.amount !== undefined ? { amount: input.amount } : {}),
      ...(input.reason ? { reason: input.reason } : {}),
    },
    requestOptions(input.idempotencyKey ? `${input.idempotencyKey}_refund` : undefined),
  );

  return {
    id: createMikaId(refund.id),
    status: stripeRefundActionStatus(refund.status),
  };
}

async function cancelStripeOrder(
  options: CreateMikaStripeProviderOptions,
  input: MikaProviderOrderCancelInput,
): Promise<AdminActionResultDTO> {
  const paymentIntentId = input.providerPaymentId ?? input.providerOrderId;
  if (!options.stripe.paymentIntents?.cancel || !paymentIntentId) {
    return unsupportedAction(
      "order_cancel",
      "Stripe payment intent cancellation is not available.",
    );
  }

  try {
    const intent = await options.stripe.paymentIntents.cancel(
      paymentIntentId,
      input.reason ? { cancellation_reason: input.reason } : {},
    );

    return {
      id: createMikaId(intent.id),
      status: intent.status === "canceled" ? "completed" : "running",
    };
  } catch (error) {
    return failedAction("order_cancel", stripeActionErrorMessage(error));
  }
}

async function verifyStripeWebhook(
  provider: ProviderName,
  options: CreateMikaStripeProviderOptions,
  input: MikaProviderWebhookVerificationInput,
): Promise<MikaVerifiedWebhookPayload> {
  const signature = input.request.headers.get("stripe-signature");
  if (!signature) {
    throw new Error("Missing Stripe webhook signature.");
  }
  if (!options.webhookSecret || !options.stripe.webhooks?.constructEvent) {
    throw new Error("Stripe webhook verification is not configured.");
  }

  const body = new TextDecoder().decode(input.rawBody);
  const event = options.stripe.webhooks.constructEvent(body, signature, options.webhookSecret);

  return {
    provider,
    rawBody: input.rawBody,
    payloadHash: `sha256:${createHash("sha256").update(input.rawBody).digest("hex")}`,
    headers: Object.fromEntries(input.request.headers.entries()),
    parsed: isJsonObjectLike(event) ? event : { event: JSON.stringify(event) },
  };
}

function parseStripeWebhookEvent(
  provider: ProviderName,
  input: MikaVerifiedWebhookPayload,
): MikaProviderWebhookEvent {
  const event = input.parsed;
  const type = stringChild(event, "type") ?? "stripe.unknown";
  const object = jsonObjectChild(jsonObjectChild(event, "data"), "object") ?? {};
  const providerEventId = stringChild(event, "id");

  if (type.startsWith("customer.subscription.")) {
    return {
      kind: "subscription",
      provider,
      providerEventId,
      type,
      providerSubscriptionId: stringChild(object, "id"),
      providerCustomerId: stripeObjectId(object["customer"]),
      providerPriceId: firstSubscriptionPriceId(object),
      status: stripeSubscriptionStatus(stringChild(object, "status")),
      currentPeriodStart: stripeTimestamp(numberChild(object, "current_period_start")),
      currentPeriodEnd: stripeTimestamp(numberChild(object, "current_period_end")),
      cancelAtPeriodEnd: booleanChild(object, "cancel_at_period_end"),
      raw: input.parsed,
    };
  }

  if (STRIPE_PAYMENT_FAILURE_TYPES.has(type)) {
    return stripePaymentFailureEvent(provider, providerEventId, type, object, input.parsed);
  }

  if (STRIPE_PAYMENT_REVERSAL_TYPES.has(type)) {
    return stripePaymentReversalEvent(provider, providerEventId, type, object, input.parsed);
  }

  if (type.startsWith("invoice.")) {
    if (!stripeInvoiceEventIsPaid(type, object)) {
      return unknownStripeWebhookEvent(provider, providerEventId, type, input.parsed);
    }

    return {
      kind: "payment",
      paymentStatus: "paid",
      provider,
      providerEventId,
      type,
      providerPaymentId: stringChild(object, "payment_intent") ?? stringChild(object, "id"),
      providerOrderId: stringChild(object, "id"),
      customer: {
        email: stringChild(object, "customer_email"),
      },
      lines: [],
      totals: moneyTotalsFromStripeAmount(object),
      invoiceUrl: stringChild(object, "hosted_invoice_url"),
      raw: input.parsed,
    };
  }

  if (type === "payment_intent.succeeded" && stringChild(object, "status") === "succeeded") {
    return {
      kind: "payment",
      paymentStatus: "paid",
      provider,
      providerEventId,
      type,
      providerCheckoutId: stringChild(object, "id"),
      providerPaymentId: stringChild(object, "id"),
      providerOrderId: stringChild(object, "id"),
      customer: undefined,
      lines: [],
      totals: moneyTotalsFromStripeAmount(object),
      raw: input.parsed,
    };
  }

  if (
    (type === "checkout.session.completed" && stripeCheckoutSessionIsPaid(object)) ||
    type === "checkout.session.async_payment_succeeded"
  ) {
    return {
      kind: "payment",
      paymentStatus: "paid",
      provider,
      providerEventId,
      type,
      providerCheckoutId: stringChild(object, "id"),
      providerPaymentId: stripeObjectId(object["payment_intent"]),
      providerOrderId: stripeObjectId(object["payment_intent"]) ?? stringChild(object, "id"),
      customer: {
        email: stringChild(object, "customer_email"),
      },
      lines: [],
      totals: moneyTotalsFromStripeAmount(object),
      raw: input.parsed,
    };
  }

  return unknownStripeWebhookEvent(provider, providerEventId, type, input.parsed);
}

const STRIPE_PAYMENT_FAILURE_TYPES = new Set([
  "payment_intent.payment_failed",
  "checkout.session.async_payment_failed",
  "checkout.session.expired",
  "invoice.payment_failed",
]);

function stripePaymentFailureEvent(
  provider: ProviderName,
  providerEventId: string | undefined,
  type: string,
  object: JsonObject,
  raw: JsonObject | undefined,
): MikaProviderWebhookEvent {
  const objectId = stringChild(object, "id");
  const paymentIntentId = stripeObjectId(object["payment_intent"]);
  const isCheckoutSession = type.startsWith("checkout.session.");
  const isInvoice = type.startsWith("invoice.");
  const providerCheckoutId = isCheckoutSession ? objectId : undefined;
  const providerPaymentId = isInvoice
    ? (paymentIntentId ?? objectId)
    : (paymentIntentId ?? (isCheckoutSession ? undefined : objectId));
  const providerOrderId = isInvoice ? objectId : (paymentIntentId ?? objectId);
  const email = stringChild(object, "customer_email") ?? stringChild(object, "receipt_email");

  return {
    kind: "payment",
    paymentStatus: "failed",
    provider,
    providerEventId,
    type,
    ...(providerCheckoutId ? { providerCheckoutId } : {}),
    ...(providerPaymentId ? { providerPaymentId } : {}),
    ...(providerOrderId ? { providerOrderId } : {}),
    ...(email ? { customer: { email } } : {}),
    lines: [],
    totals: moneyTotalsFromStripeAmount(object),
    raw,
  };
}

const STRIPE_PAYMENT_REVERSAL_TYPES = new Set([
  "charge.refunded",
  "invoice.marked_uncollectible",
]);

function stripePaymentReversalEvent(
  provider: ProviderName,
  providerEventId: string | undefined,
  type: string,
  object: JsonObject,
  raw: JsonObject | undefined,
): MikaProviderWebhookEvent {
  const amount = numberChild(object, "amount");
  const amountRefunded = numberChild(object, "amount_refunded");
  const fullyReversed =
    type !== "charge.refunded" ||
    booleanChild(object, "refunded") === true ||
    (amountRefunded !== undefined && amount !== undefined && amountRefunded >= amount);
  const paymentStatus = fullyReversed ? "refunded" : "partially_refunded";

  const linkedId =
    stripeObjectId(object["payment_intent"]) ?? stripeObjectId(object["charge"]);
  const objectId = stringChild(object, "id");
  const providerPaymentId = linkedId ?? objectId;
  const providerOrderId = linkedId ?? objectId;
  const email = stringChild(object, "customer_email") ?? stringChild(object, "receipt_email");

  const reversedAmount = type === "charge.refunded" ? amountRefunded : amount;
  const currency = stringChild(object, "currency")?.toUpperCase();
  const totals =
    reversedAmount !== undefined && currency
      ? { total: { amount: reversedAmount, currency: currency as MoneyDTO["currency"] } }
      : undefined;

  return {
    kind: "payment",
    paymentStatus,
    provider,
    providerEventId,
    type,
    ...(providerPaymentId ? { providerPaymentId } : {}),
    ...(providerOrderId ? { providerOrderId } : {}),
    ...(email ? { customer: { email } } : {}),
    lines: [],
    ...(totals ? { totals } : {}),
    raw,
  };
}

function unknownStripeWebhookEvent(
  provider: ProviderName,
  providerEventId: string | undefined,
  type: string,
  raw: JsonObject | undefined,
): MikaProviderWebhookEvent {
  return {
    kind: "unknown",
    provider,
    providerEventId,
    type,
    raw,
  };
}

function stripeInvoiceEventIsPaid(type: string, object: JsonObject): boolean {
  if (type !== "invoice.paid" && type !== "invoice.payment_succeeded") return false;
  return booleanChild(object, "paid") === true || stringChild(object, "status") === "paid";
}

function stripeCheckoutSessionIsPaid(object: JsonObject): boolean {
  const paymentStatus = stringChild(object, "payment_status");
  return paymentStatus === "paid" || paymentStatus === "no_payment_required";
}

function moneyTotalsFromStripeAmount(
  object: JsonObject,
): { readonly total?: MoneyDTO } | undefined {
  const amount =
    numberChild(object, "amount_total") ??
    numberChild(object, "amount_paid") ??
    numberChild(object, "amount_received") ??
    numberChild(object, "amount");
  const currency = stringChild(object, "currency")?.toUpperCase();
  if (amount === undefined || !currency) return undefined;

  return {
    total: {
      amount,
      currency: currency as MoneyDTO["currency"],
    },
  };
}

function stripeRefundActionStatus(
  status: string | null | undefined,
): AdminActionResultDTO["status"] {
  switch (status) {
    case "succeeded":
      return "completed";
    case "failed":
    case "canceled":
      return "failed";
    default:
      return "running";
  }
}

function stripeSubscriptionStatus(status: string | undefined): SubscriptionStatus {
  switch (status) {
    case "active":
      return "active";
    case "trialing":
      return "trialing";
    case "past_due":
      return "past_due";
    case "canceled":
    case "cancelled":
      return "cancelled";
    case "unpaid":
      return "past_due";
    default:
      return "incomplete";
  }
}

function firstSubscriptionPriceId(object: JsonObject): string | undefined {
  const items = jsonObjectChild(object, "items");
  const data = items?.["data"];
  if (!Array.isArray(data)) return undefined;
  const first = data.find(isJsonObjectLike);
  const price = jsonObjectChild(first, "price");

  return stringChild(price, "id");
}

function requestOptions(idempotencyKey: string | undefined): MikaStripeRequestOptions | undefined {
  return idempotencyKey ? { idempotencyKey } : undefined;
}

function stripeMetadata(input: JsonObject | undefined): Record<string, string> | undefined {
  const metadata = Object.fromEntries(
    Object.entries(input ?? {}).flatMap(([key, value]) => {
      if (value === undefined || value === null) return [];
      if (typeof value === "string") return [[key, value]];
      if (typeof value === "number" || typeof value === "boolean") return [[key, String(value)]];

      return [[key, JSON.stringify(value)]];
    }),
  );

  return Object.keys(metadata).length > 0 ? metadata : undefined;
}

function readMetadataString(metadata: JsonObject | undefined, key: string): string | undefined {
  const value = metadata?.[key];

  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function stripeTimestamp(
  value: number | null | undefined,
): ReturnType<typeof createISODateTime> | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;

  return createISODateTime(new Date(value * 1000).toISOString());
}

function stripeObjectId(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (isJsonObjectLike(value)) return stringChild(value, "id");

  return undefined;
}

function stripeRaw(input: Record<string, unknown>): JsonObject {
  return JSON.parse(JSON.stringify(input)) as JsonObject;
}

function requiredString(value: string | null | undefined, label: string): string {
  if (!value) throw new Error(`${label} is missing.`);

  return value;
}

function completedAction(id: string, message?: string): AdminActionResultDTO {
  return {
    id: createMikaId(id),
    status: "completed",
    ...(message ? { message } : {}),
  };
}

function unsupportedAction(
  id: string,
  message = "Stripe action is not supported.",
): AdminActionResultDTO {
  return {
    id: createMikaId(id),
    status: "unsupported",
    message,
  };
}

function failedAction(id: string, message: string): AdminActionResultDTO {
  return {
    id: createMikaId(id),
    status: "failed",
    message,
  };
}

function stripeActionErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Stripe action failed.";
}

function stringChild(input: JsonObject | undefined, key: string): string | undefined {
  const value = input?.[key];

  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberChild(input: JsonObject | undefined, key: string): number | undefined {
  const value = input?.[key];

  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function booleanChild(input: JsonObject | undefined, key: string): boolean | undefined {
  const value = input?.[key];

  return typeof value === "boolean" ? value : undefined;
}

function jsonObjectChild(
  input: JsonObject | undefined | null,
  key: string,
): JsonObject | undefined {
  const value = input?.[key];

  return isJsonObjectLike(value) ? value : undefined;
}

function isJsonObjectLike(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
