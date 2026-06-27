DEVANA-FINDING: v1
DEVANA-STATE: open | P1 | high | security=no
DEVANA-KEY: src/api/backend.ts:5538-5592 | checkout-preview-coupon-drift

# Checkout preview couponCode does not match checkout.start pricing

## Finding

`createCartQuote` can price a cart with an inline `couponCode` without persisting it to the cart. `checkout.start` has no `couponCode` field and always uses the cart's stored `aggregate.coupon` via `resolveCheckoutStart`.

## Violated Invariant Or Contract

The total shown in checkout preview must match the total used when starting checkout for the same cart and session.

## Oracle

Preview recomputes coupon inline when `quoteInput.couponCode` is set (`backend.ts:5538-5592`). `startCheckoutInputSchema` has no `couponCode` (`validation.ts:254-265`). `resolveCheckoutStart` sets `coupon: cartResult.cart?.aggregate.coupon` (`backend.ts:5874`).

## Counterexample

1. Cart stores coupon `SAVE10` (10% off).
2. `checkout.preview({ cartId, couponCode: "OTHER" })` quotes `OTHER` at 10% off and sets `inputHash` for that total.
3. `checkout.start({ cartId })` charges using stored `SAVE10`, not `OTHER`.
4. Buyer or agent authorizes the preview total but checkout uses a different discount.

## Why It Might Matter

Agent and storefront UIs can display one payable total while hosted checkout charges another, breaking confirmation and delegated-payment hash alignment.

## Proof

**Contract mismatch:** preview path (`couponCode` inline) vs start path (stored cart coupon only) for the same `cartId`.

## Counterevidence Checked

`applyCoupon` persists codes to the cart, but preview's inline `couponCode` is intentionally ephemeral in quote — there is no bridge to start. `checkoutIdempotencyInputHash` hashes client checkout input, not resolved coupon state, compounding replay drift after coupon changes.

## Suggested Next Step

Either persist preview `couponCode` to the cart before start, reject start when preview `inputHash` disagrees with resolved cart coupon, or add `couponCode` to `startCheckout` and resolve it the same way as preview.

## Agent Handoff

After working this report, preserve the original finding body. Update line 2 `DEVANA-STATE: ...` and the final `DEVANA-SUMMARY:` status/priority/confidence prefix. Use one of: `open`, `fixed`, `invalid`, `stale`, `duplicate`, `wontfix`. Keep `DEVANA-KEY:` stable unless the same finding moved. Add dated notes below with evidence checked.

## Status Notes

- 2026-06-27: open by Devana. Initial report written from static source inspection.

DEVANA-KEY: src/api/backend.ts:5538-5592 | checkout-preview-coupon-drift
DEVANA-SUMMARY: open | P1 | high | checkout.preview honors inline couponCode but checkout.start always uses the cart's stored coupon, so quoted and charged totals can diverge.