DEVANA-FINDING: v1
Priority: P1 | Confidence: high | Security-sensitive: no | Status: fixed
Location: src/stripe.ts:434 | Slug: stripe-subscription-interval-month

# Stripe checkout price_data hardcodes subscription interval to month

## Finding

When building Stripe Checkout line items without `providerPriceId`, `stripeCheckoutLineItem` hardcodes `recurring: { interval: "month" }` for subscription mode. Catalog `PriceDefinition.interval` and `intervalCount` are not mapped onto provider line items.

## Violated Invariant Or Contract

Provider line items must preserve catalog price billing cadence when creating Stripe recurring `price_data`.

## Oracle

Subscription sellable with `interval: "year"` and no `providerPriceId` must produce Stripe recurring `{ interval: "year" }`, not monthly.

## Counterexample

1. Subscription line without `providerPriceId`.
2. Catalog price `{ interval: "year", intervalCount: 1, amount: 12000 }`.
3. Stripe payload gets `recurring: { interval: "month" }` (line 434).
4. Customer billed monthly instead of annually at Stripe.

## Why It Might Matter

Wrong billing period and amount semantics for unsynced subscription products. Affects any host using inline `price_data` instead of pre-synced Stripe prices.

## Proof

**Contract mismatch:** `PriceDefinition` carries `interval` / `intervalCount`; `checkoutLineToProviderLine` does not map them; adapter hardcodes `"month"`.

## Counterevidence Checked

When `providerPriceId` is set, Stripe uses pre-synced price with correct cadence. Bug limited to `price_data` fallback path.

## Suggested Next Step

Map `line.interval` and `line.intervalCount` from catalog onto `MikaProviderLineItem` and into `stripeCheckoutLineItem` recurring fields.

## Agent Handoff

After working this report, preserve the original finding body. Update line 2 `Status: ...` and the final `DEVANA-SUMMARY:` status.

## Status Notes

- 2026-06-25: open by Devana. Initial report written from static source inspection.
- 2026-06-27: fixed. Confirmed `stripeCheckoutLineItem` hardcoded `recurring: { interval: "month" }` and the catalog `interval`/`intervalCount` never reached the provider line. Threaded the cadence through the snapshot chain: added `interval`/`intervalCount` to `PurchasableSnapshot` (populated in `snapshotPrice` from `PriceDefinition`) and to `MikaProviderLineItem` (mapped in `checkoutLineToProviderLine`). `stripeCheckoutLineItem` now emits `recurring: { interval: line.interval ?? "month", interval_count: <n when >1> }`. Backward compatible (interval defaults to month when absent). Added regression test `maps catalog billing cadence onto inline subscription price_data`. Typecheck + 307 tests pass.

DEVANA-KEY: src/stripe.ts:434 | P1 | stripe-subscription-interval-month
DEVANA-SUMMARY: Status=fixed | P1 high src/stripe.ts:434 - Stripe inline price_data hardcoded a monthly interval. Fixed by threading catalog interval/intervalCount through the snapshot and provider line into Stripe recurring price_data, with a regression test.