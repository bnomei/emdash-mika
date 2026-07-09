/**
 * Stripe MikaProviderAdapter factory wiring checkout, portal, subscriptions, and webhooks.
 */
import { optionalProperty } from "../internal/object";
import type { MikaProviderCapability, OrderInvoiceDTO, ProviderHealthDTO } from "../api/types";
import { defineMikaProvider, type MikaProviderAdapter } from "../provider";
import { createISODateTime, type ProviderName } from "../types/primitives";
import type { CreateMikaStripeProviderOptions } from "./types";
import { MIKA_STRIPE_PROVIDER_ID } from "./types";
import {
  createStripeCheckoutSession,
  createStripeDelegatedPayment,
  resolveStripeInvoiceId,
  retrieveStripeCheckoutSession,
} from "./checkout";
import {
  cancelStripeOrder,
  changeStripeSubscription,
  refundStripePayment,
  renewStripeSubscription,
} from "./actions";
import { parseStripeWebhookEvent, verifyStripeWebhook } from "./webhooks";
import {
  completedAction,
  failedAction,
  requiredString,
  stripeActionErrorMessage,
  stripeTimestamp,
  unsupportedAction,
} from "./helpers";

export function createMikaStripeProvider(
  options: CreateMikaStripeProviderOptions,
): MikaProviderAdapter {
  const id = options.id ?? MIKA_STRIPE_PROVIDER_ID;

  return defineMikaProvider({
    id,
    capabilities: () => stripeCapabilities(options),
    health: async () => stripeHealth(id, options),
    createCheckoutSession: async (input) => createStripeCheckoutSession(id, options, input),
    createDelegatedPayment: async (input) => createStripeDelegatedPayment(id, options, input),
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
        ...optionalProperty("expiresAt", stripeTimestamp(session.expires_at)),
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
        const subscription = await options.stripe.subscriptions.update(
          input.providerSubscriptionId,
          {
            cancel_at_period_end: true,
          },
        );

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

export function stripeCapabilities(
  options: CreateMikaStripeProviderOptions,
): readonly MikaProviderCapability[] {
  if (options.capabilities) return options.capabilities;

  const capabilities: MikaProviderCapability[] = [];
  if (options.stripe.checkout?.sessions) capabilities.push("hosted_checkout");
  if (options.stripe.paymentIntents?.create) capabilities.push("delegated_payment");
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

export async function stripeHealth(
  provider: ProviderName,
  options: CreateMikaStripeProviderOptions,
): Promise<ProviderHealthDTO> {
  const capabilities = stripeCapabilities(options);

  return {
    provider,
    ok: Boolean(options.stripe.checkout?.sessions || options.stripe.paymentIntents),
    capabilities,
    checkedAt: createISODateTime((options.now?.() ?? new Date()).toISOString()),
    ...optionalProperty(
      "warnings",
      options.webhookSecret ? undefined : ["Stripe webhook secret is not configured."],
    ),
  };
}
