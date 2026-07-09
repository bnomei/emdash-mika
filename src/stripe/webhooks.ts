/**
 * Stripe webhook verification and event normalization into Mika payment events.
 */
import { createHash } from "node:crypto";
import { optionalProperty } from "../internal/object";
import type {
  MikaProviderWebhookEvent,
  MikaProviderWebhookVerificationInput,
  MikaVerifiedWebhookPayload,
} from "../provider";
import { isCurrencyCode, type JsonObject, type ProviderName } from "../types/primitives";
import type { CreateMikaStripeProviderOptions } from "./types";
import {
  booleanChild,
  firstSubscriptionPriceId,
  isJsonObjectLike,
  jsonObjectChild,
  moneyTotalsFromStripeAmount,
  numberChild,
  stringChild,
  stripeCheckoutSessionIsPaid,
  stripeCustomerInput,
  stripeInvoiceEventIsPaid,
  stripeObjectId,
  stripeSubscriptionStatus,
  stripeTimestamp,
} from "./helpers";

export async function verifyStripeWebhook(
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

export function parseStripeWebhookEvent(
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
      ...optionalProperty("providerEventId", providerEventId),
      type,
      ...optionalProperty("providerSubscriptionId", stringChild(object, "id")),
      ...optionalProperty("providerCustomerId", stripeObjectId(object["customer"])),
      ...optionalProperty("providerPriceId", firstSubscriptionPriceId(object)),
      status: stripeSubscriptionStatus(stringChild(object, "status")),
      ...optionalProperty(
        "currentPeriodStart",
        stripeTimestamp(numberChild(object, "current_period_start")),
      ),
      ...optionalProperty(
        "currentPeriodEnd",
        stripeTimestamp(numberChild(object, "current_period_end")),
      ),
      ...optionalProperty("cancelAtPeriodEnd", booleanChild(object, "cancel_at_period_end")),
      ...optionalProperty("raw", input.parsed),
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
      ...optionalProperty("providerEventId", providerEventId),
      type,
      ...optionalProperty(
        "providerPaymentId",
        stringChild(object, "payment_intent") ?? stringChild(object, "id"),
      ),
      ...optionalProperty("providerOrderId", stringChild(object, "id")),
      ...optionalProperty("providerSubscriptionId", stringChild(object, "subscription")),
      ...optionalProperty("customer", stripeCustomerInput(stringChild(object, "customer_email"))),
      lines: [],
      ...optionalProperty("totals", moneyTotalsFromStripeAmount(object)),
      ...optionalProperty("invoiceUrl", stringChild(object, "hosted_invoice_url")),
      ...optionalProperty("raw", input.parsed),
    };
  }

  if (type === "payment_intent.succeeded" && stringChild(object, "status") === "succeeded") {
    return {
      kind: "payment",
      paymentStatus: "paid",
      provider,
      ...optionalProperty("providerEventId", providerEventId),
      type,
      ...optionalProperty("providerCheckoutId", stringChild(object, "id")),
      ...optionalProperty("providerPaymentId", stringChild(object, "id")),
      ...optionalProperty("providerOrderId", stringChild(object, "id")),
      lines: [],
      ...optionalProperty("totals", moneyTotalsFromStripeAmount(object)),
      ...optionalProperty("raw", input.parsed),
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
      ...optionalProperty("providerEventId", providerEventId),
      type,
      ...optionalProperty("providerCheckoutId", stringChild(object, "id")),
      ...optionalProperty("providerPaymentId", stripeObjectId(object["payment_intent"])),
      ...optionalProperty(
        "providerOrderId",
        stripeObjectId(object["payment_intent"]) ?? stringChild(object, "id"),
      ),
      ...optionalProperty(
        "customer",
        stripeCustomerInput(
          stringChild(jsonObjectChild(object, "customer_details"), "email") ??
            stringChild(object, "customer_email"),
        ),
      ),
      lines: [],
      ...optionalProperty("totals", moneyTotalsFromStripeAmount(object)),
      ...optionalProperty("raw", input.parsed),
    };
  }

  return unknownStripeWebhookEvent(provider, providerEventId, type, input.parsed);
}

// Stripe event types normalized to paymentStatus: "failed" in Mika webhook handling.
export const STRIPE_PAYMENT_FAILURE_TYPES = new Set([
  "payment_intent.payment_failed",
  "checkout.session.async_payment_failed",
  "checkout.session.expired",
  "invoice.payment_failed",
]);

export function stripePaymentFailureEvent(
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
  const email =
    stringChild(jsonObjectChild(object, "customer_details"), "email") ??
    stringChild(object, "customer_email") ??
    stringChild(object, "receipt_email");

  return {
    kind: "payment",
    paymentStatus: "failed",
    provider,
    ...optionalProperty("providerEventId", providerEventId),
    type,
    ...(providerCheckoutId ? { providerCheckoutId } : {}),
    ...(providerPaymentId ? { providerPaymentId } : {}),
    ...(providerOrderId ? { providerOrderId } : {}),
    ...optionalProperty("customer", stripeCustomerInput(email)),
    lines: [],
    ...optionalProperty("totals", moneyTotalsFromStripeAmount(object)),
    ...optionalProperty("raw", raw),
  };
}

export const STRIPE_PAYMENT_REVERSAL_TYPES = new Set([
  "charge.refunded",
  "invoice.marked_uncollectible",
]);

export function stripePaymentReversalEvent(
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

  const linkedId = stripeObjectId(object["payment_intent"]) ?? stripeObjectId(object["charge"]);
  const objectId = stringChild(object, "id");
  const providerPaymentId = linkedId ?? objectId;
  const providerOrderId = linkedId ?? objectId;
  const email = stringChild(object, "customer_email") ?? stringChild(object, "receipt_email");

  const reversedAmount = type === "charge.refunded" ? amountRefunded : amount;
  const currency = stringChild(object, "currency")?.toUpperCase();
  const totals =
    reversedAmount !== undefined && isCurrencyCode(currency)
      ? { total: { amount: reversedAmount, currency } }
      : undefined;

  return {
    kind: "payment",
    paymentStatus,
    provider,
    ...optionalProperty("providerEventId", providerEventId),
    type,
    ...(providerPaymentId ? { providerPaymentId } : {}),
    ...(providerOrderId ? { providerOrderId } : {}),
    ...optionalProperty("customer", stripeCustomerInput(email)),
    lines: [],
    ...(totals ? { totals } : {}),
    ...optionalProperty("raw", raw),
  };
}

export function unknownStripeWebhookEvent(
  provider: ProviderName,
  providerEventId: string | undefined,
  type: string,
  raw: JsonObject | undefined,
): MikaProviderWebhookEvent {
  return {
    kind: "unknown",
    provider,
    ...optionalProperty("providerEventId", providerEventId),
    type,
    ...optionalProperty("raw", raw),
  };
}
