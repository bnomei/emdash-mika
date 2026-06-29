DEVANA-FINDING: v1
DEVANA-STATE: open | P1 | high | security=no
DEVANA-KEY: src/api/backend.ts:5987 | coupon-provider-charge-mismatch

# Cart coupon discount applied to Mika totals but not provider charge

## Finding

When a cart has an applied coupon, `createCheckoutAggregate` computes discounted `totals.total` via `couponDiscountAmount`. `startCheckout` sends undiscounted line `unitAmount` values to the provider via `checkoutLineToProviderLine`. The persisted order uses the discounted `checkout.aggregate.totals.total.amount`, not the provider-charged amount.

## Violated Invariant Or Contract

Amount charged at the payment provider should match checkout/order `totalAmount` when a cart coupon is applied.

## Oracle

`calculateCheckoutTotals` applies coupon discount to Mika totals. `MikaProviderCheckoutInput` lines carry raw `unitAmount`; Stripe builds `line_items` from those amounts (`src/stripe.ts` ~460–462). `createPaymentOrderDocument` sets `totalAmount` from `checkout.aggregate.totals.total` (~4827–4853).

## Counterexample

1. Cart subtotal $100; `applyCoupon({ code: "SAVE10" })` → 10% discount.
2. `checkout.aggregate.totals.total.amount === 9000` (cents).
3. `checkout.start({ cartId })` → provider session line items sum to $100.
4. Payment succeeds → order `totalAmount === 9000` while Stripe charged $100.

## Why It Might Matter

Customers overcharged relative to displayed cart totals; accounting, refunds, and tax reporting diverge between Mika records and provider receipts.

## Proof

**Dataflow trace:** coupon → `calculateCheckoutTotals` → discounted document totals → `checkoutLineToProviderLine` (no discount field) → provider charge → `createPaymentOrderDocument` (discounted total).

Locations: `src/model/builders.ts` (`couponDiscountAmount`, `calculateCheckoutTotals`), `src/api/backend.ts` (`startCheckout` ~5987, `checkoutLineToProviderLine` ~6793–6818, `createPaymentOrderDocument` ~4820–4853), `src/provider.ts` (no discount on checkout input).

## Counterevidence Checked

`cart.quote` and preview show discounted totals consistently on the Mika side. No code passes coupon or discount to provider adapters. Deliberate "always charge catalog price" policy would not persist coupon snapshots into checkout aggregates.

## Suggested Next Step

Apply discount to provider line items or pass an explicit discount/adjustment to the provider session, and validate totals before handoff.

## Agent Handoff

After working this report, preserve the original finding body. Update line 2 `DEVANA-STATE: ...` and the final `DEVANA-SUMMARY:` status/priority/confidence prefix.

## Status Notes

- 2026-06-29: open by Devana. Initial report written from static source inspection across inside-out-paths and invariants-contracts trails.

DEVANA-KEY: src/api/backend.ts:5987 | coupon-provider-charge-mismatch
DEVANA-SUMMARY: open | P1 | high | Coupons reduce Mika checkout/order totals but provider sessions are created from undiscounted line prices.