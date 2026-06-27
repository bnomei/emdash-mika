DEVANA-FINDING: v1
DEVANA-STATE: open | P2 | high | security=no
DEVANA-KEY: src/astro.ts:150 | money-format-zero-decimal-currency

# Money formatting hard-divides minor units by 100, understating zero-decimal currencies 100x

## Finding

Both money formatters divide the stored amount by 100 unconditionally:

```ts
// src/astro.ts:144-151 (formatMikaMoney)
return new Intl.NumberFormat(options.locales, {
  style: "currency", currency: value.currency,
}).format(value.amount / 100);

// src/email.ts:160-165 (formatMoney)
}).format(value.amount / 100);
```

Amounts are stored/transmitted in provider minor units. For a zero-decimal currency (JPY, KRW, …) the minor unit equals the major unit, so dividing by 100 displays 1/100 of the real price.

## Violated Invariant Or Contract

Display formatting must render the stored minor-unit amount at the correct scale for the currency's decimal places. A hard `/100` assumes every currency has exactly 2 decimal places.

## Oracle

- Amounts are minor units: `src/stripe.ts:430` passes `unit_amount: line.unitAmount` straight to Stripe (Stripe expects minor units, and for JPY the minor unit == the yen).
- ISO 4217 / Stripe: JPY has 0 decimal places; `¥1000` is stored as `amount = 1000`.
- `Intl.NumberFormat(undefined, { style:"currency", currency:"JPY" }).format(1000/100)` renders `¥10` — a 100× understatement.
- `createCurrencyCode` (`src/types/primitives.ts:34-41`/`isCurrencyCode` line 61-63) accepts any `^[A-Z]{3}$`, including `JPY`/`KRW`; there is no decimal-places table or guard anywhere.

## Counterexample

`{ amount: 1000, currency: "JPY" }` → `formatMikaMoney` / `formatMoney` render `¥10`, while Stripe is charged `1000` (`¥1000`). Displayed price diverges from charged price by 100×.

## Why It Might Matter

Any storefront configured with a zero-decimal currency shows prices at 1/100 of the true amount on product/cart pages (`astro.ts`) and in order-confirmation emails (`email.ts`), while the customer is charged the correct (100× larger) amount. Customer-facing price/charge mismatch.

## Proof

Counterexample value + oracle: `value.amount / 100 = 10` formatted as `¥10` for a stored `1000` minor-unit JPY amount that is charged as `¥1000`.

## Counterevidence Checked

- "Mika only supports 2-decimal currencies." Refuted: `isCurrencyCode` accepts any 3-letter uppercase code; nothing constrains currencies to 2 decimals, and no decimal table exists.
- `Intl.NumberFormat` itself applies the correct fraction digits per currency, so the only error is the upstream `/100`. Passing the raw minor-unit amount through a currency-aware minor-to-major conversion (or letting a helper select the divisor by currency) would fix both call sites.

## Suggested Next Step

Convert minor units to major units using the currency's decimal exponent (e.g. a small ISO-4217 exponent table, or derive from `Intl.NumberFormat(...).resolvedOptions().maximumFractionDigits`) instead of a fixed `/100`, in both `astro.ts:150` and `email.ts:164`.

## Agent Handoff

Preserve the original finding body. Update line 2 `DEVANA-STATE:` and the final `DEVANA-SUMMARY:` prefix. Keep `DEVANA-KEY:` stable unless the finding moved.

## Status Notes

- 2026-06-27: open by Devana. Verified astro.ts:150 and email.ts:164 hard /100; stripe.ts:430 passes minor units; isCurrencyCode accepts any 3-letter code.

DEVANA-KEY: src/astro.ts:150 | money-format-zero-decimal-currency
DEVANA-SUMMARY: open | P2 | high | formatMikaMoney/formatMoney hard-divide minor units by 100, so zero-decimal currencies (JPY/KRW) display 1/100 of the price actually charged, in storefront and confirmation emails.
