import { expect } from "vite-plus/test";

import type { MikaProviderCapability } from "../../src/api/types";
import type { MikaProviderAdapter, MikaProviderWebhookEvent } from "../../src/provider";

type ProviderMethodName = keyof MikaProviderAdapter;

const METHOD_BACKED_CAPABILITIES = [
  {
    capability: "hosted_checkout",
    methods: ["createCheckoutSession", "retrieveCheckoutSession"],
  },
  { capability: "portal", methods: ["createPortalSession"] },
  { capability: "invoice_url", methods: ["getInvoiceUrl"] },
  { capability: "subscription_renew", methods: ["renewSubscription"] },
  { capability: "subscription_change", methods: ["changeSubscription"] },
  { capability: "subscription_cancel", methods: ["cancelSubscription"] },
  { capability: "refunds", methods: ["refundPayment"] },
  { capability: "product_sync", methods: ["syncCatalog"] },
  { capability: "variant_sync", methods: ["syncCatalog"] },
  { capability: "stock_sync", methods: ["syncCatalog"] },
  { capability: "webhook_signatures", methods: ["verifyWebhook", "parseWebhookEvent"] },
] satisfies readonly {
  readonly capability: MikaProviderCapability;
  readonly methods: readonly ProviderMethodName[];
}[];

export async function expectMethodBackedProviderCapabilities(
  provider: MikaProviderAdapter,
): Promise<void> {
  const capabilities = await Promise.resolve(provider.capabilities());

  for (const rule of METHOD_BACKED_CAPABILITIES) {
    if (!capabilities.includes(rule.capability)) continue;

    for (const method of rule.methods) {
      expect(typeof provider[method], `${provider.id}:${rule.capability}:${method}`).toBe(
        "function",
      );
    }
  }
}

export function expectPaidProviderPaymentEvent(event: MikaProviderWebhookEvent): void {
  expect(event).toMatchObject({
    kind: "payment",
    paymentStatus: "paid",
  });
}

export function expectNonFulfillingProviderEvent(event: MikaProviderWebhookEvent): void {
  expect(event).not.toMatchObject({
    kind: "payment",
    paymentStatus: "paid",
  });
}
