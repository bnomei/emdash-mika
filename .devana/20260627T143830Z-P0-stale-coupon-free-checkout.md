DEVANA-FINDING: v1
DEVANA-STATE: fixed | P0 | high | security=no
DEVANA-KEY: src/model/builders.ts:461-474 | stale-coupon-free-checkout

# Stale coupon discount can zero out checkout after line changes

## Finding

Cart and checkout totals reuse a frozen `coupon.discountAmount` snapshot from apply time. When line quantities or items shrink afterward, the discount is not recomputed and can exceed the new subtotal, yielding a $0 (or near-$0) total at quote and checkout.

## Violated Invariant Or Contract

A percentage coupon applied to the cart must discount the current subtotal at quote and checkout time, not a stale subtotal from when the coupon was applied.

## Oracle

`createCouponSnapshot` computes `discountAmount` from subtotal at apply time; `cartWithItems` / `calculateTotals` always subtract that fixed amount with `Math.max(0, subtotal - discountAmount)`.

## Counterexample

1. Cart: one line at unit 1000 × qty 2 → subtotal 2000.
2. `cart.applyCoupon({ code: "SAVE10" })` → `discountAmount = 200` (10%).
3. `cart.update({ lineId, quantity: 1 })` → subtotal 1000.
4. `cart.get` / `checkout.start` still use `discountAmount = 200`.
5. Total = `max(0, 1000 - 200) = 800`; correct 10% total is 900. With a larger discount snapshot (e.g. after removing a cheap line while discount stays high), total can reach 0 while subtotal remains positive.

## Why It Might Matter

Customers can checkout at an incorrect (including zero) price. Merchant revenue loss and accounting mismatch between charged provider amount and cart total.

## Proof

**Dataflow trace:** `applyCoupon` → `createCouponSnapshot` (fixed `discountAmount`) → `updateCartDocument`/`cartWithItems` (preserves coupon unchanged on `remove`/`update`/`merge`) → `calculateTotals` → `resolveCheckoutStart` copies cart coupon into checkout aggregate.

## Counterevidence Checked

`cart.quote` only recomputes coupon when `couponCode` is passed inline, not for persisted cart coupons. `Math.max(0, …)` clamps negative totals but does not restore correct discount semantics. No transaction or idempotency guard prevents the wrong total from reaching checkout.

## Suggested Next Step

Recompute or invalidate `CouponSnapshot` on any cart line mutation, or derive discount from code + current subtotal at quote/checkout boundaries.

## Agent Handoff

After working this report, preserve the original finding body. Update line 2 `DEVANA-STATE: ...` and the final `DEVANA-SUMMARY:` status/priority/confidence prefix. Use one of: `open`, `fixed`, `invalid`, `stale`, `duplicate`, `wontfix`. Keep `DEVANA-KEY:` stable unless the same finding moved. Add dated notes below with evidence checked.

## Status Notes

- 2026-06-27: open by Devana. Initial report written from static source inspection.
- 2026-06-27: fixed. Confirmed `calculateTotals` and `createCartQuote` subtracted a frozen `coupon.discountAmount` from the recomputed subtotal, so shrinking the cart left an oversized discount (down to a $0 total). Fix: added a `rate` field to `CouponSnapshot` and a single `couponDiscountAmount(coupon, subtotal)` helper that recomputes a rate-based coupon against the current subtotal (capped at it) and clamps legacy amount-only coupons. Wired it through `calculateTotals` (covers cart + checkout via `calculateCheckoutTotals`), the persisted-coupon branch of `createCartQuote`, and the `cartToDTO` coupon display; `createCouponSnapshot` and the inline-quote coupon now store `rate` (`COUPON_DISCOUNT_RATE = 0.1`). Carts persist as generic JSON so the new field round-trips. Added regression test `recomputes a percentage coupon against the current subtotal after line changes`. Typecheck + 312 tests pass.

DEVANA-KEY: src/model/builders.ts:461-474 | stale-coupon-free-checkout
DEVANA-SUMMARY: fixed | P0 | high | Frozen coupon.discountAmount could exceed the subtotal after line changes and zero out the total. Fixed by storing a coupon rate and recomputing the discount from the current subtotal (couponDiscountAmount) at cart/quote/checkout, with a regression test.