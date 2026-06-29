DEVANA-FINDING: v1
DEVANA-STATE: open | P1 | high | security=no
DEVANA-KEY: src/api/backend.ts:5814 | quote-coupon-checkout-mismatch

# Cart quote coupon overrides are not persisted for checkout

## Finding

`cart.quote` can apply a `couponCode` override that changes quoted totals and `inputHash` without writing the coupon to the cart document. `checkout.start` and `checkout.preview` read the persisted cart coupon only, so checkout can charge a different discount than the quote the shopper authorized.

## Violated Invariant Or Contract

Quote and checkout should use the same commercial terms for a given cart. `createCartQuote` treats `couponCode` as an ephemeral override, while `resolveCheckoutStart` binds checkout to `cartResult.cart?.aggregate.coupon`.

## Oracle

`cart.applyCoupon` persists coupon snapshots on the cart aggregate. `checkout.preview` builds proofs from `createCartQuote`, but `checkout.start` has no `couponCode` input and uses persisted cart state only.

## Counterexample

1. `cart.applyCoupon({ code: "SAVE10" })` persists SAVE10 on the cart.
2. `cart.quote({ cartId, couponCode: "SAVE20" })` returns totals with SAVE20 and `status: "changed"`.
3. `checkout.start({ cartId })` uses persisted SAVE10 for totals and provider line pricing.

Shopper authorizes SAVE20 pricing; checkout proceeds with SAVE10.

## Why It Might Matter

ACP and agent checkout flows rely on quote `inputHash` proofs while checkout start ignores quote-only coupon overrides. Shoppers see one price on quote/preview and pay another at checkout.

## Proof

Dataflow trace:

- `createCartQuote` lines 5814-5866 compute coupon from `quoteInput.couponCode` without `session.put`.
- `resolveCheckoutStart` line 6158 sets `coupon: cartResult.cart?.aggregate.coupon`.
- `createCheckoutPreview` uses quote `inputHash` for payment-authorization proofs (`src/api/backend.ts:6908-6927`) but checkout start does not accept the quote coupon field.

## Counterevidence Checked

When shoppers use `applyCoupon` and checkout without a quote override, cart and checkout stay aligned. This is not the same mechanism as `coupon-provider-charge-mismatch` (provider session lines vs local totals with a single persisted coupon).

## Suggested Next Step

Persist quote coupon overrides to the cart before checkout, or pass the quote `inputHash`/coupon into `checkout.start` and reject mismatches.

## Agent Handoff

After working this report, preserve the original finding body. Update line 2 `DEVANA-STATE: ...` and the final `DEVANA-SUMMARY:` status/priority/confidence prefix. Use one of: `open`, `fixed`, `invalid`, `stale`, `duplicate`, `wontfix`. Keep `DEVANA-KEY:` stable unless the same finding moved. Add dated notes below with evidence checked.

## Status Notes

- 2026-06-29: open by Devana. Initial report written from static source inspection.

DEVANA-KEY: src/api/backend.ts:5814 | quote-coupon-checkout-mismatch
DEVANA-SUMMARY: open | P1 | high | cart.quote can price a different coupon than checkout.start uses because quote couponCode overrides are never persisted on the cart.