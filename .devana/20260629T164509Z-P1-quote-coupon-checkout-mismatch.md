DEVANA-FINDING: v1
DEVANA-STATE: fixed | P1 | high | security=no
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
- 2026-06-29: fixed (report's second suggested approach: pass the coupon into `checkout.start` and apply it — chosen over "persist quote overrides" because `cart.quote` is intentionally non-mutating). Root cause: `CartQuoteInput` has `couponCode`, but `StartCheckoutInput` (the base `checkout.start` AND `checkout.preview` share) did not, so `resolveCheckoutStart` could only bind the persisted cart coupon (`cartResult.cart?.aggregate.coupon`) and silently ignored any quote-only override. Changes: (1) added `couponCode?: string` to `StartCheckoutInput` (`src/api/types.ts`) — it propagates to `CheckoutPreviewInput` (which `extends` it) and to `checkout.start`; (2) added `couponCode` to `startCheckoutInputSchema` and `checkoutStartFormInputSchema` (`src/api/validation.ts`) so Zod no longer strips it (the preview schema extends the start schema, inheriting it), and threaded it through `normalizeCheckoutStartActionInput` (`src/api/operations.ts`) for the HTML-form transport; (3) extracted `couponSnapshotForSubtotal(input, code, subtotal)` from `createCouponSnapshot` (pure refactor, both now share it) and, in `resolveCheckoutStart` after validation, when `couponCode` is supplied: compute the coupon from the resolved checkout-line subtotal (current prices, matching how checkout recomputes the discount via `couponDiscountAmount(coupon, checkoutSubtotal)`), and when a cart backs the checkout persist it to the cart exactly like `cart.applyCoupon` (`cartWithCoupon`/`cartWithoutCoupon` + `session.put`) so cart state, totals, and provider lines stay aligned; an empty code removes the coupon. Applied AFTER all validation so a failing checkout never mutates the cart. This handles BOTH cart and express buy-now (no cart): because `checkout.preview` now also accepts `couponCode` via the shared base, applying it in `checkout.start` for express too avoids leaving the identical preview/start mismatch for the express path. Note the library's coupon rate is a fixed `COUPON_DISCOUNT_RATE` (0.1), so distinct codes (SAVE10 vs SAVE20) differ only by label/codeHash at the same 10% — the observable bug is the wrong coupon identity (and, when no cart coupon was persisted, a missing discount), not a wrong percentage; a host with real per-code rates would also see wrong amounts. Evidence: two new tests — (a) `checkout.start({ cartId, couponCode: "SAVE10" })` with NO persisted coupon makes the provider receive a 240 discount (2400→2160) and persists `SAVE10` on the checkout; (b) `applyCoupon("SAVE10")` then `checkout.start({ cartId, couponCode: "SAVE20" })` yields a stored checkout coupon labelled `SAVE20`, proving the override beats the stale persisted `SAVE10`. Both were confirmed to FAIL with the apply block neutered (provider discount absent / checkout coupon stayed `SAVE10`). Full suite (364) and both tsc configs pass. Out of scope (NOT changed): `cart.quote` remains non-mutating (a quote-only `couponCode` is still ephemeral — the shopper/agent now carries it into `checkout.start`/`checkout.preview` to make it stick); the report's "reject quote/checkout mismatches via inputHash" alternative was not taken because applying the supplied coupon removes the mismatch outright.
- 2026-06-30: reviewed (APPROVE_WITH_NITS, no blocking; both new tests mutation-verified to fail when the apply block is neutered). Addressed/recorded the four nits: (1) corrected the misleading code comment — the "applied after validation" guarantee only covers the resolver's own rejections (empty cart / mixed modes); a later provider-session failure still rolls back reservations but leaves the just-applied coupon on the cart, which is acceptable (the shopper supplied the code; same outcome as `applyCoupon` then a failed checkout). (2) Added an assertion that the override propagates to the persisted `checkout_pending` cart, and confirmed the open-cart `session.put` in `resolveCheckoutStart` is load-bearing specifically for the delegated-payment authorization recompute (`requireDelegatedPaymentAuthorization` re-quotes from the persisted cart) and cart/quote alignment — but it is NOT isolated by a unit test because the natural isolating test (a delegated payment whose preview hash binds `couponCode`) currently fails for a separate, pre-existing reason: `checkout.preview` with a `couponCode` override on a coupon-less cart prices the quote with `status: "changed"`, while the start's authorization recompute (which strips `couponCode` and reads the now-persisted coupon) prices `status: "valid"`, and the proof projection binds `quote.status`, so the hashes diverge → 403. That delegated+`couponCode`-override interaction is out of scope for this coupon-persistence fix (and is NOT a regression — the existing no-coupon delegated-authorization flow still passes); recorded as a follow-up. (3) Clarified the empty-code semantics: "empty code removes the coupon" holds for the in-process resolver, but over the Zod transports (HTTP/forms) `optionalStringSchema`'s `emptyToUndefined` maps `couponCode: ""` → `undefined` (the coupon is left unchanged) and whitespace-only is a validation error — this matches `cart.quote` (same schema), so quote/checkout stay consistent. (4) `requireDelegatedPaymentAuthorization` deliberately keeps rebuilding the preview input as `{ cartId, provider }` (no `couponCode`) and relies on the verified ordering — `resolveCheckoutStart` persists the coupon (≈backend.ts:6481) before the delegated check (≈6235) — rather than forwarding `couponCode`; forwarding it would not fix the `status` divergence above and would alter a security-adjacent hash recompute, so it is left for the dedicated delegated+coupon follow-up. No code behavior changed in this review pass beyond the comment; the test gained one assertion. Full suite (364) and both tsc configs still pass.
- 2026-06-30: reopened and fixed. The previous status note recorded a still-failing delegated-payment coupon path: a preview proof created with `couponCode` on a coupon-less cart had `quote.status: "changed"`, but `checkout.start` persisted the coupon before recomputing authorization and then rebuilt the proof without `couponCode`, yielding `quote.status: "valid"` and a false 403. `requireDelegatedPaymentAuthorization` now preserves `couponCode` in the recompute and runs before `resolveCheckoutStart` mutates the cart, so it compares against the same quote projection the agent authorized. A new regression covers delegated checkout with `couponCode`, verifies the provider discount, and verifies the stored checkout coupon.

DEVANA-KEY: src/api/backend.ts:5814 | quote-coupon-checkout-mismatch
DEVANA-SUMMARY: fixed | P1 | high | checkout.start and checkout.preview now accept couponCode, and delegated payment authorization recomputes the proof before mutating the cart while preserving couponCode, so hosted and delegated checkout both charge the coupon the shopper was quoted.
