import { describe, expect, it } from "vite-plus/test";

import {
  createCurrencyCode,
  createISODateTime,
  createSellableId,
  type CartQuoteDTO,
} from "@bnomei/emdash-mika/types";

import { businessQuoteResolver } from "./fixtures/business-quote-resolver";

describe("external business quote fixture", () => {
  it("adds host amounts to a mixed fulfillment quote using public contracts", async () => {
    const currency = createCurrencyCode("EUR");
    const quote: CartQuoteDTO = {
      status: "valid",
      currency,
      items: [
        {
          sellableId: createSellableId("guide-download"),
          fulfillmentKind: "download",
          quantity: 1,
          subtotal: { amount: 2_000, currency },
          total: { amount: 2_000, currency },
        },
        {
          sellableId: createSellableId("printed-guide"),
          fulfillmentKind: "external",
          quantity: 1,
          subtotal: { amount: 5_000, currency },
          total: { amount: 5_000, currency },
        },
      ],
      subtotal: { amount: 7_000, currency },
      total: { amount: 7_000, currency },
    };

    await expect(
      Promise.resolve(
        businessQuoteResolver({
          ctx: { now: createISODateTime("2026-01-01T00:00:00.000Z") },
          input: {},
          quote,
        }),
      ),
    ).resolves.toMatchObject({
      items: [{ fulfillmentKind: "download" }, { fulfillmentKind: "external" }],
      tax: { amount: 1_400, currency },
      shipping: { amount: 800, currency },
      adjustments: [
        { type: "tax", amount: { amount: 1_400, currency } },
        { type: "shipping", amount: { amount: 800, currency } },
        { type: "fee", amount: { amount: 300, currency } },
      ],
      total: { amount: 9_500, currency },
    });
  });
});
