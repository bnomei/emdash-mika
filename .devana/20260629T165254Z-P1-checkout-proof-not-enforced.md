DEVANA-FINDING: v1
DEVANA-STATE: invalid | P1 | high | security=no
DEVANA-KEY: src/api/backend.ts:6914 | checkout-proof-not-enforced

# checkout.start does not enforce payment_authorization proof from preview

## Finding

`checkout.preview` returns `requires_payment_authorization` until `proofRefs` contains a `payment_authorization` proof matching the quote `inputHash`. `checkout.start` / `startCheckout` never reads `proofRefs`, `inputHash`, or `acpPaymentAuthorizationInputHash`, and proceeds directly to stock reservation and provider session creation.

## Violated Invariant Or Contract

Agent checkout flow documents that checkout start requires payment confirmation before provider handoff. Preview `requiredProofs` with `required: true` should gate `checkout.start`.

## Oracle

`previewCheckout` computes `inputHash` and sets status to `requires_payment_authorization` without matching proof (`backend.ts:6914-6937`). `StartCheckoutInput` / `startCheckout` have no proof fields in validation or handler logic.

## Counterexample

1. Agent calls `checkout.preview` → `status: "requires_payment_authorization"`, `inputHash: "abc"`.
2. Catalog price changes before start (quote would be `changed`).
3. Caller invokes `checkout.start` with same cart, no `proofRefs`.
4. Provider session is created with freshly resolved prices, bypassing authorization proof.

## Why It Might Matter

Checkout can proceed without the payment-authorization step the preview contract requires; quote/catalog drift between preview and start is unenforced.

## Proof

Dataflow trace: preview proof requirement → dropped at start boundary → provider handoff proceeds.

## Counterevidence Checked

ACP `handleAcpComplete` enforces preview readiness at the ACP entry only, not inside `startCheckout`. No shared proof validator in backend.

## Suggested Next Step

Require `proofRefs` or signed `inputHash` on `checkout.start` matching a recent preview, or reject start when preview status is not `ready`.

## Agent Handoff

After working this report, preserve the original finding body. Update line 2 `DEVANA-STATE: ...` and the final `DEVANA-SUMMARY:` status/priority/confidence prefix. Use one of: `open`, `fixed`, `invalid`, `stale`, `duplicate`, `wontfix`. Keep `DEVANA-KEY:` stable unless the same finding moved. Add dated notes below with evidence checked.

## Status Notes

- 2026-06-29: open by Devana. Initial source inspection.
- 2026-06-30: invalid — the core factual claim ("`checkout.start` / `startCheckout` never reads `proofRefs`, `inputHash`, or `acpPaymentAuthorizationInputHash`") is FALSE, and the report's own Counterevidence ("No shared proof validator in backend") missed the validator. `startCheckout` (`src/api/backend.ts:6313`) calls `requireDelegatedPaymentAuthorization` (`:6355`) BEFORE stock reservation and provider-session creation. That gate (`:6279-6311`): when a delegated payment token is present in `customFields[acpPaymentToken]` — the SAME key the Stripe adapter uses to begin a delegated charge (`MIKA_STRIPE_DELEGATED_PAYMENT_TOKEN_METADATA_KEY = "acpPaymentToken"`, `src/stripe.ts:42`, equal to `DELEGATED_PAYMENT_TOKEN_METADATA_KEY` at `backend.ts:6265`) — it REQUIRES `customFields.acpPaymentAuthorizationInputHash` (`:6292-6295`) and recomputes the expected hash from a FRESH preview of the exact cart (`createCartQuote` + `checkoutPreviewProofProjection`, `:6301-6305`); any mismatch → `403 forbidden` (`:6306-6308`). Because the adapter triggers a delegated charge ONLY on that same token key, NO delegated/provider charge can occur without passing this gate — so a leaked/intercepted token, a forged hash, or a STALE hash from a pre-price-change preview is all rejected (the fresh preview's `inputHash`, via `checkoutPreviewProofProjection`, reflects the new prices, so the report's drift counterexample is caught). Hosted (non-delegated) checkout has no token → the gate is a no-op, which is CORRECT: payment authorization happens interactively at the provider's hosted page AFTER start, and `resolveCheckoutStart` re-resolves prices fresh so the shopper pays the current price — there is no pre-start proof to enforce (the shopper has not paid yet). `createCheckoutPreview` (`:7376`) marking `payment_authorization` `required: true` for all previews is the agent/delegated contract; it binds the proof to the CURRENT quote's `inputHash` (`:7387-7393`), which is exactly what the delegated gate re-checks. This is already COMPREHENSIVELY tested (no code change needed): `test/backend.test.ts:12561` ("rejects checkout start with a delegated payment token but no preview authorization") asserts a leaked token alone → 403, a token + forged/stale hash → 403, and that the provider was never called with 0 stock reserved; `:12619` ("allows checkout start with a delegated payment token authorized by a fresh preview") asserts a token bound to a fresh preview `inputHash` → ok with one provider session; `:11420` ("requires current bound payment authorization when checkout preview quote changes") drives the report's exact price-drift scenario and shows a stale-`inputHash` proof keeps the preview at `requires_payment_authorization` while only a proof bound to the CURRENT `inputHash` reaches `ready`. Full suite (388) and both tsc configs pass on the unchanged code. (No fix committed — the only change is this report's state.) Adversarial-review caveats (separate from this finding, NOT bypasses): (a) the `inputHash` is an UNKEYED hash of the quote projection that `checkout.preview` returns directly, so it is an anti-drift/anti-substitution binding rather than an unforgeable customer-authorization attestation — the actual authorization is Stripe's amount/merchant-bound `shared_payment_granted_token`; (b) the gate re-previews with only `{ cartId, provider }`, so a start-time `couponCode`/`customer` is not bound by the validated hash — a start-time coupon can only LOWER the charge below the authorized quote (an under-charge that fails safe / harms the merchant, not the shopper) or fail closed, never produce an unauthorized over-charge. Both are minor binding-completeness observations, not the reported "proof not enforced" defect.

DEVANA-KEY: src/api/backend.ts:6914 | checkout-proof-not-enforced
DEVANA-SUMMARY: invalid | P1 | high | checkout.start DOES enforce the payment-authorization proof: requireDelegatedPaymentAuthorization (called in startCheckout before reservation/provider handoff) validates acpPaymentAuthorizationInputHash against a fresh preview whenever the delegated charge token is present — and the Stripe adapter charges only on that same token, so no delegated charge bypasses it (leaked/forged/stale hashes are 403'd). Hosted checkout authorizes at the provider. Already covered by tests 12561/12619/11420; the report's "no proof validator" counterevidence missed requireDelegatedPaymentAuthorization.