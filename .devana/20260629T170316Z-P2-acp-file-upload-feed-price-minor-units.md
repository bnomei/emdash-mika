DEVANA-FINDING: v1
DEVANA-STATE: open | P2 | high | security=no
DEVANA-KEY: src/acp.ts:474 | acp-file-upload-feed-price-minor-units

# ACP file-upload feed emits the `price` string from raw minor units, overstating prices ~100×

## Finding

`createMikaAcpFileUploadRows` builds the merchant file-upload catalog row's `price` string directly from the integer minor-unit amount with no conversion:

```
price: `${price.amount} ${price.currency}`,   // src/acp.ts:474
```

`price.amount` is an integer in **minor units** (cents). Every other place in the package that renders an amount as a human/agent-readable string divides by the minor-unit factor first:
- `src/astro.ts:167`: `formatter.format(value.amount / 10 ** fractionDigits)` (doc comment at `src/astro.ts:157` explicitly: "minor-unit amounts").
- `src/email.ts:181`: `formatter.format(value.amount / 10 ** fractionDigits)`.
- Shipped JSON-LD `src/templates/astro/components/ProductStructuredData.astro:408`: `(price.amount / 100).toFixed(2)` → `"12.00"`.

The *structured* ACP feed keeps `amount` numeric (`{ amount: price.amount, currency }`, `src/acp.ts:438-441`), which is consistent with ACP checkout totals also being integer minor units (`src/acp.ts:1431-1485`) — that is fine. Only the file-upload **string** field at line 474 emits the raw integer where a decimal major-unit string is expected.

## Violated Invariant Or Contract

A merchant product-feed `price` string (`"<amount> <currency>"`, the Google-Merchant / file-upload catalog convention) must be the decimal major-unit value (e.g. `"12.00 EUR"`), not the integer minor-unit value.

## Oracle

Cross-serializer divergence within the same package: the JSON-LD serializer divides by 100 (`ProductStructuredData.astro:408`) and the UI/email formatters divide by `10 ** fractionDigits`, but the file-upload row does not — the identical price renders as `"12.00"` in JSON-LD and `"1200 EUR"` in the file-upload feed. `validateMikaAcpProductFeed` (`src/acp.ts:525-528`) requires `Number.isInteger(amount)`, confirming `amount` is integer cents, not a `12.00`-style decimal.

## Counterexample

A €12.00 product has `price.amount = 1200`, `price.currency = "EUR"` (cf. test fixture `test/acp-stripe.test.ts:87` setting `amount: 1200`). The file-upload row emits `price: "1200 EUR"`. An agent/crawler ingesting the merchant feed reads €1200 — a 100× overstatement — while the same product's JSON-LD correctly advertises `"12.00"`.

## Why It Might Matter

The file-upload catalog is the agent-/crawler-facing price surface. A 100× price overstatement (for 2-decimal currencies) makes agents quote wildly wrong prices to buyers and is internally inconsistent with every other rendered price for the same item.

## Proof

Dataflow + contract mismatch: minor-unit `price.amount` → flat string sink in a public agent-readable feed (`src/acp.ts:474`), diverging from the package's own canonical money→string formatters (`astro.ts:167`, `email.ts:181`, `ProductStructuredData.astro:408`) which all divide first.

## Counterevidence Checked

- The library uses integer minor units consistently for *structured* ACP surfaces (numeric feed `amount`, checkout totals), so the numeric fields are correct — only the human-readable string field is affected.
- Strongest false-positive reason: the file-upload spec could theoretically define `price` as minor units, making line 474 internally intended. Ruled against: no price-string feed convention uses minor units, and the repo's own JSON-LD/UI/email formatters all divide — so the feed string is provably inconsistent with every other rendering of the same value. (Note: the in-repo test `test/acp-stripe.test.ts:114` asserts other file-upload fields but never the `price` string, so the format is unverified by tests.)

## Suggested Next Step

Format the file-upload `price` string as a decimal major-unit value using the currency's fraction digits (the same `amount / 10 ** fractionDigits` logic the package already uses), e.g. `"12.00 EUR"`. Consider centralizing money→string formatting so feed/JSON-LD/email/UI cannot drift.

## Agent Handoff

After working this report, preserve the original finding body. Update line 2 `DEVANA-STATE:` and the final `DEVANA-SUMMARY:` prefix. Keep `DEVANA-KEY:` stable unless the same finding moved.

## Status Notes

- 2026-06-29: open by Devana. Confirmed by two independent reviews; verified line 474 vs the dividing formatters at `astro.ts:167`, `email.ts:181`, `ProductStructuredData.astro:408`, and the integer-amount validator at `acp.ts:525-528`.

DEVANA-KEY: src/acp.ts:474 | acp-file-upload-feed-price-minor-units
DEVANA-SUMMARY: open | P2 | high | The ACP file-upload feed serializes the `price` string from raw minor units (`"1200 EUR"` for a €12.00 item), a ~100× overstatement inconsistent with the package's JSON-LD/email/UI formatters that all divide by the minor-unit factor.
