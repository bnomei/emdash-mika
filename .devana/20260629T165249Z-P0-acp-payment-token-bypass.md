DEVANA-FINDING: v1
DEVANA-STATE: fixed | P0 | high | security=yes
DEVANA-KEY: src/api/backend.ts:5990 | acp-payment-token-bypass

# checkout.start accepts delegated payment token without authorization proof

## Finding

`checkout.start` passes raw `customFields` to the payment provider. The Stripe adapter switches to delegated payment when `acpPaymentToken` is present in metadata, without verifying that a matching `payment_authorization` proof or `acpPaymentAuthorizationInputHash` was produced by `checkout.preview`. Any caller that can invoke `checkout.start` with a leaked or intercepted Stripe shared payment token can trigger delegated payment for an attacker-chosen cart.

## Violated Invariant Or Contract

ACP checkout preview requires `payment_authorization` proof bound to a quote `inputHash` before payment (`checkout.preview` sets `requires_payment_authorization` until proof is present). `checkout.start` should not hand off to delegated payment unless that authorization chain was satisfied.

## Oracle

`src/acp.ts` `handleAcpComplete` only calls `checkout.start` after preview returns `requires_payment_authorization` and passes `acpPaymentAuthorizationInputHash` in `customFields`. Agent metadata documents `payment_authorization` as a required proof for checkout start.

## Counterexample

1. Attacker obtains a Stripe `shared_payment_granted_token` from an intercepted ACP session.
2. Attacker calls `cart.add` for arbitrary active sellables, then `checkout.start` with `customFields: { acpPaymentToken: "<token>" }` — no ACP API key, no preview, no proof.
3. `startCheckout` passes `metadata: checkoutInput.customFields` to the provider (`backend.ts:5990`).
4. `createStripeCheckoutSession` reads `acpPaymentToken` and calls `createStripeDelegatedPayment` (`stripe.ts:347-352`).

## Why It Might Matter

Delegated payment can be initiated outside the ACP authorization boundary, charging a token against cart lines the token holder did not authorize through the preview/proof flow.

## Proof

Cross-entry mismatch: ACP `handleAcpComplete` enforces preview readiness and proof hash; direct `checkout.start` skips both while sharing the same provider dispatch path.

## Counterevidence Checked

`checkoutCustomMetadata` filters internal keys for persisted checkout metadata only, not the provider call. `acpPaymentAuthorizationInputHash` is never read in `backend.ts`. Stripe token policy may limit final charge success, but Mika's dispatch gate is absent.

## Suggested Next Step

Reject `checkout.start` when delegated-payment metadata keys are present unless `proofRefs` or `acpPaymentAuthorizationInputHash` matches a fresh preview `inputHash`.

## Agent Handoff

After working this report, preserve the original finding body. Update line 2 `DEVANA-STATE: ...` and the final `DEVANA-SUMMARY:` status/priority/confidence prefix. Use one of: `open`, `fixed`, `invalid`, `stale`, `duplicate`, `wontfix`. Keep `DEVANA-KEY:` stable unless the same finding moved. Add dated notes below with evidence checked.

## Status Notes

- 2026-06-29: open by Devana. Initial report written from static source inspection.
- 2026-06-29: fixed. `startCheckout` now gates delegated-payment handoff: when the delegated payment token metadata key (`acpPaymentToken`) is present in `customFields`, it requires a cart-based checkout and a `acpPaymentAuthorizationInputHash` that matches the `payment_authorization` input hash a fresh `checkout.preview` of that exact cart produces (the same hash `checkout.preview` returns and `handleAcpComplete` forwards). The check runs before any stock reservation or provider call and returns `403 FORBIDDEN` on a missing/forged/stale proof. The quote inputHash is derived from the cart's stored `expiresAt` (not wall-clock), so the legitimate preview→start handoff hashes deterministically and is accepted. Evidence: added backend tests asserting (a) a token with no/forged hash is rejected with no provider call and no reservation, and (b) a token bound to a fresh preview inputHash is accepted and dispatches one provider session. Residual: the proof binds the payment to a current previewed cart/quote; Stripe still enforces the shared payment token's own amount/merchant binding at charge time.

DEVANA-KEY: src/api/backend.ts:5990 | acp-payment-token-bypass
DEVANA-SUMMARY: fixed | P0 | high | checkout.start now rejects delegated-payment metadata unless acpPaymentAuthorizationInputHash matches a fresh checkout.preview of the cart, so a leaked shared payment token can no longer trigger an unauthorized delegated charge.