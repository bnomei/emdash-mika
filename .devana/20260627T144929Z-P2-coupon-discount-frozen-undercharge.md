DEVANA-FINDING: v1
DEVANA-STATE: duplicate | P2 | medium | security=no
DEVANA-KEY: src/api/backend.ts:6943-6958 | coupon-discount-frozen-undercharge

# Coupon discount frozen as an absolute amount at apply time; later cart changes undercharge (total can drop to 0)

## Finding

`createCouponSnapshot` computes the discount once, as an absolute amount captured from the subtotal at apply time:

```ts
// src/api/backend.ts:6943-6958
const subtotalAmount = cart.aggregate.items.reduce(
  (sum, line) => sum + line.item.unitAmount * line.quantity, 0);
return {
  codeHash: await input.hash(`coupon:${normalizedCode}`),
  label: normalizedCode,
  discountAmount: Math.floor(subtotalAmount * 0.1),
};
```

This snapshot is stored on the cart and reused verbatim by every other cart mutator. `cartWithItems` keeps `input.coupon ?? input.cart.coupon` (`src/model/builders.ts:137`), and `calculateTotals` subtracts the stored absolute `coupon.discountAmount` from the *current* subtotal (`builders.ts:466-468`). `createCouponSnapshot` is the only producer of `discountAmount` and is called only from `applyCoupon` (`backend.ts:969`); `cart.add/update/remove/merge` route through `updateCartDocument` with no coupon argument, so the discount is never recomputed when items change.

## Violated Invariant Or Contract

A coupon discount must stay consistent with the cart it applies to. A percentage discount ("10% off") must equal 10% of the *current* subtotal; the discount must never exceed the current subtotal.

## Oracle

`calculateTotals` (`builders.ts:466-468`) treats `discountAmount` as a current absolute to subtract from the live subtotal; the discount source value is frozen at apply time. The quote path `createCartQuote` (`backend.ts:5582-5593`) only recomputes a discount when a *new* `couponCode` is supplied; for an already-applied coupon it reuses `coupon?.discountAmount ?? 0`. Checkout start (`resolveCheckoutStart`, `backend.ts:5874`) carries the same stale coupon into the checkout aggregate, and the order copies the checkout totals.

## Counterexample

1. Cart subtotal 1000. `cart.applyCoupon(code)` → snapshot `discountAmount = floor(1000*0.1) = 100`; total 900 (correct).
2. `cart.remove(line)` / `cart.update` lowering quantity until subtotal = 100. `updateCartDocument` re-runs `calculateTotals` with the frozen `discountAmount = 100`: `total = max(0, 100 - 100) = 0`. The cart now reports total 0 for goods worth 100.
3. `checkout.start` carries the same coupon (`backend.ts:5874`); the checkout/order totals record subtotal 100, discount 100, total 0.

(Separately, `createCouponSnapshot` never looks up the coupon at all — it hardcodes `* 0.1` and ignores `CouponAggregate.discount`'s `{type:"amount"}`/`{type:"percent"}` union at `src/types/aggregates.ts:259-261` — so every applied code yields a flat 10% regardless of its real value.)

## Why It Might Matter

The internal cart/checkout/order ledger totals (used for display, accounting, and refund math) can be driven to 0 or otherwise diverge from the goods' value by ordinary cart edits after a coupon is applied — an undercharge on the recorded order. (Provider line charges are computed per-line from `unitAmount` and do not see the coupon, so the divergence is between the recorded order total and the line charges.)

## Proof

State-transition / control-flow mismatch: `applyCoupon` freezes an absolute discount; `update/remove/merge` recompute the subtotal but reuse the frozen discount; `checkout.start` copies it forward — with no recompute node anywhere. Concrete counterexample drives total to 0.

## Counterevidence Checked

- "The quote endpoint re-derives the coupon before checkout." Refuted: `createCartQuote` (`backend.ts:5586`) only recomputes when a new `couponCode` is passed; an already-applied coupon uses the stale `discountAmount`. Checkout start does not re-derive either.
- The hardcoded `* 0.1` reads like scaffolding, lowering confidence that 10% is the intended rate — but the *frozen-absolute, never-recomputed* behavior is a reachable correctness defect independent of the rate, so confidence in the undercharge mechanism is high; rate semantics are secondary.

## Suggested Next Step

Recompute the coupon discount from the current cart subtotal (and the real `CouponAggregate.discount`) on every cart mutation and at checkout start, and clamp it to the current subtotal.

## Agent Handoff

Preserve the original finding body. Update line 2 `DEVANA-STATE:` and the final `DEVANA-SUMMARY:` prefix. Keep `DEVANA-KEY:` stable unless the finding moved.

## Status Notes

- 2026-06-27: open by Devana. Verified createCouponSnapshot (backend.ts:6943-6958) is sole producer, called only at applyCoupon (969); builders.ts:137/466-468 reuse the frozen absolute; checkout/quote paths do not recompute.
- 2026-06-27: marked duplicate. A concurrent Devana run wrote the canonical report `20260627T143830Z-P0-stale-coupon-free-checkout.md` (DEVANA-KEY src/model/builders.ts:461-474) for the same frozen-coupon-discount mechanism before this one landed; it rates the impact P0. Track the fix there. This report adds the hardcoded-10%/no-lookup detail as supporting context.

DEVANA-KEY: src/api/backend.ts:6943-6958 | coupon-discount-frozen-undercharge
DEVANA-SUMMARY: duplicate | P2 | medium | Coupon discount is frozen as an absolute amount at apply time and never recomputed when cart items change, so cart/checkout/order totals can be driven to 0 (undercharge) by ordinary edits after applying a coupon.
