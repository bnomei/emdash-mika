/**
 * External-style compile fixture: only published package surfaces are imported.
 * A real host would source these values from its tax and delivery integrations.
 */
import type { MikaQuoteResolver } from "@bnomei/emdash-mika/server";
import type { MoneyDTO } from "@bnomei/emdash-mika/types";

function money(amount: number, like: MoneyDTO): MoneyDTO {
  return { amount, currency: like.currency };
}

/**
 * One host-owned calculator shared automatically by cart quote, checkout preview,
 * delegated-payment proof, provider handoff, and persisted checkout totals.
 */
export const businessQuoteResolver: MikaQuoteResolver = ({ quote }) => {
  const discountedSubtotal = quote.subtotal.amount - (quote.discount?.amount ?? 0);
  const tax = money(Math.round(discountedSubtotal * 0.2), quote.subtotal);
  const hasExternalFulfillment = quote.items.some((line) => line.fulfillmentKind === "external");
  const shipping = hasExternalFulfillment ? money(800, quote.subtotal) : undefined;
  const packagingFee = hasExternalFulfillment ? money(300, quote.subtotal) : undefined;
  const total = money(
    discountedSubtotal + tax.amount + (shipping?.amount ?? 0) + (packagingFee?.amount ?? 0),
    quote.subtotal,
  );

  return {
    ...quote,
    tax,
    ...(shipping ? { shipping } : {}),
    adjustments: [
      ...(quote.adjustments ?? []),
      { type: "tax", label: "VAT", amount: tax },
      ...(shipping
        ? [{ type: "shipping" as const, label: "Standard delivery", amount: shipping }]
        : []),
      ...(packagingFee
        ? [{ type: "fee" as const, label: "Recycled packaging", amount: packagingFee }]
        : []),
    ],
    total,
  };
};
