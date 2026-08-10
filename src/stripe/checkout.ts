/**
 * Stripe checkout session and delegated PaymentIntent adapter methods.
 */
import { optionalProperty } from "../internal/object";
import type { CheckoutStatusDTO } from "../api/types";
import type {
  MikaProviderCheckoutInput,
  MikaProviderCheckoutSession,
  MikaProviderDelegatedPaymentInput,
  MikaProviderLineItem,
} from "../provider";
import { createMikaId, type JsonObject, type ProviderName } from "../types/primitives";
import type {
  CreateMikaStripeProviderOptions,
  MikaStripeCheckoutSession,
  MikaStripePaymentIntent,
} from "./types";
import {
  jsonObjectChild,
  requestOptions,
  stringChild,
  stripeMetadata,
  stripeObjectId,
  stripeRaw,
  stripeTimestamp,
} from "./helpers";

export async function createStripeCheckoutSession(
  provider: ProviderName,
  options: CreateMikaStripeProviderOptions,
  input: MikaProviderCheckoutInput,
): Promise<MikaProviderCheckoutSession> {
  if (!options.stripe.checkout?.sessions) {
    throw new Error("Stripe checkout sessions are not available.");
  }

  assertStripeHostedTotalIsRepresentable(input);

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
      ...optionalProperty(
        "metadata",
        stripeMetadata({
          ...input.metadata,
          mikaProvider: provider,
          mikaMode: input.mode,
        }),
      ),
    },
    requestOptions(input.idempotencyKey),
  );

  return stripeCheckoutSessionToMika(provider, session);
}

/** Stripe-hosted checkout only represents Mika's catalog lines and coupon discount. */
export function assertStripeHostedTotalIsRepresentable(input: MikaProviderCheckoutInput): void {
  if (!input.total) return;

  const subtotal = input.lines.reduce(
    (amount, line) => amount + line.unitAmount * line.quantity,
    0,
  );
  const representedTotal = Math.max(0, subtotal - (input.discount?.amount ?? 0));
  if (input.total.amount !== representedTotal) {
    throw new Error(
      "Stripe hosted checkout cannot represent host-added tax, shipping, or fee amounts; use a host adapter that applies them or delegated payment.",
    );
  }
}

/**
 * Creates a one-time Stripe coupon for a checkout discount. Each discounted hosted checkout
 * creates a new Stripe Coupon resource (`max_redemptions: 1`); Stripe never deletes coupon
 * objects automatically, so a checkout the buyer abandons leaves an unredeemed coupon in the
 * account indefinitely. The coupon carries `mikaCheckoutIdempotencyKey` metadata so a host-side
 * cleanup job can list and prune coupons older than the checkout TTL by that tag.
 */
export async function stripeCheckoutDiscounts(
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
      ...(input.idempotencyKey
        ? { metadata: { mikaCheckoutIdempotencyKey: input.idempotencyKey } }
        : {}),
    },
    requestOptions(input.idempotencyKey ? `${input.idempotencyKey}_coupon` : undefined),
  );

  return [{ coupon: coupon.id }];
}

export async function createStripeDelegatedPayment(
  provider: ProviderName,
  options: CreateMikaStripeProviderOptions,
  input: MikaProviderDelegatedPaymentInput,
): Promise<MikaProviderCheckoutSession> {
  if (!options.stripe.paymentIntents?.create) {
    throw new Error("Stripe payment intents are required for delegated payments.");
  }
  if (input.lines.length === 0) {
    throw new Error("Delegated Stripe checkout requires at least one line item.");
  }

  const intent = await options.stripe.paymentIntents.create(
    {
      // input.total is the backend's authoritative charge amount (subtotal minus discount, plus
      // any host-added tax/shipping the lines cannot express) — never recomputed from lines here,
      // or the charge would drift from the total the buyer confirmed.
      amount: input.total.amount,
      currency: input.total.currency.toLowerCase(),
      confirm: true,
      payment_method_data: {
        shared_payment_granted_token: input.token,
      },
      ...optionalProperty(
        "metadata",
        stripeMetadata({
          ...input.metadata,
          mikaProvider: provider,
          mikaMode: input.mode,
          mikaCheckoutKind: "delegated_payment",
        }),
      ),
    },
    requestOptions(input.idempotencyKey),
  );

  return stripePaymentIntentToMika(provider, input.mode, intent);
}

export async function retrieveStripeCheckoutSession(
  provider: ProviderName,
  options: CreateMikaStripeProviderOptions,
  id: string,
): Promise<MikaProviderCheckoutSession> {
  // pi_* ids resolve via PaymentIntents API (delegated ACP checkout path).
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

export async function resolveStripeInvoiceId(
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

export function stripeCheckoutLineItem(line: MikaProviderLineItem): JsonObject {
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

export function stripeCheckoutSessionToMika(
  provider: ProviderName,
  session: MikaStripeCheckoutSession,
): MikaProviderCheckoutSession {
  return {
    id: createMikaId(session.id),
    status: stripeCheckoutStatus(session),
    mode: session.mode === "subscription" ? "subscription" : "payment",
    provider,
    ...optionalProperty("redirectUrl", session.url ?? undefined),
    ...optionalProperty("expiresAt", stripeTimestamp(session.expires_at)),
    providerCheckoutId: session.id,
    ...optionalProperty("providerCustomerId", stripeObjectId(session.customer)),
    raw: stripeRaw(session),
  };
}

export function stripePaymentIntentToMika(
  provider: ProviderName,
  mode: MikaProviderCheckoutInput["mode"],
  intent: MikaStripePaymentIntent,
): MikaProviderCheckoutSession {
  return {
    id: createMikaId(intent.id),
    status: stripePaymentIntentStatus(intent.status),
    mode,
    provider,
    ...optionalProperty("redirectUrl", stripeNextActionUrl(intent.next_action)),
    providerCheckoutId: intent.id,
    ...optionalProperty("providerCustomerId", stripeObjectId(intent.customer)),
    raw: stripeRaw(intent),
  };
}

export function stripeCheckoutStatus(session: MikaStripeCheckoutSession): CheckoutStatusDTO {
  if (session.payment_status === "paid" || session.status === "complete") return "completed";
  if (session.status === "expired") return "expired";
  if (session.status === "open" && session.url) return "redirected";
  if (session.status === "open") return "created";

  return "pending";
}

export function stripePaymentIntentStatus(status: string | null | undefined): CheckoutStatusDTO {
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

export function stripeNextActionUrl(nextAction: JsonObject | null | undefined): string | undefined {
  const redirect = jsonObjectChild(nextAction, "redirect_to_url");

  return stringChild(redirect, "url");
}
