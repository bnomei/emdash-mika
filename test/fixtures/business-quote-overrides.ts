/**
 * External-style compile fixture: only published package surfaces are imported.
 * A real host would source these values from its catalog, tax, and delivery glue.
 */
import type { MikaApiOverrides } from "@bnomei/emdash-mika/server";
import {
  createCurrencyCode,
  createProviderName,
  createSellableId,
  type CartQuoteDTO,
  type CartQuoteInput,
  type CheckoutPreviewInput,
  type MoneyDTO,
} from "@bnomei/emdash-mika/types";

const currency = createCurrencyCode("EUR");
const provider = createProviderName("host-payments");
const downloadId = createSellableId("guide-download");
const shippedId = createSellableId("printed-guide");

function money(amount: number): MoneyDTO {
  return { amount, currency };
}

/** One host-owned calculator shared by every operation that presents a total. */
export function createBusinessQuote(_input: CartQuoteInput | CheckoutPreviewInput): CartQuoteDTO {
  return {
    status: "valid",
    currency,
    items: [
      {
        sellableId: downloadId,
        fulfillmentKind: "download",
        title: "Field guide PDF",
        quantity: 1,
        unitAmount: money(2_000),
        subtotal: money(2_000),
        total: money(2_000),
        availability: { sellableId: downloadId, status: "available" },
      },
      {
        sellableId: shippedId,
        fulfillmentKind: "external",
        title: "Printed field guide",
        quantity: 1,
        unitAmount: money(5_000),
        subtotal: money(5_000),
        total: money(5_000),
        availability: { sellableId: shippedId, status: "low_stock", availableQuantity: 2 },
      },
    ],
    subtotal: money(7_000),
    tax: money(1_400),
    shipping: money(800),
    adjustments: [
      { type: "tax", label: "VAT", amount: money(1_400) },
      { type: "shipping", label: "Standard delivery", amount: money(800) },
      { type: "fee", label: "Recycled packaging", amount: money(300) },
    ],
    total: money(9_500),
  };
}

export const businessQuoteOverrides = {
  cart: {
    async quote(_ctx, input) {
      return { ok: true, status: 200, data: createBusinessQuote(input) };
    },
  },
  checkout: {
    async preview(_ctx, input) {
      const quote = createBusinessQuote(input);
      return {
        ok: true,
        status: 200,
        data: {
          status: "requires_confirmation",
          mode: "payment",
          provider,
          quote,
          requiredProofs: [],
        },
      };
    },
  },
} satisfies MikaApiOverrides;
