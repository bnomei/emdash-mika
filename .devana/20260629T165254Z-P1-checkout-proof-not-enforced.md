DEVANA-FINDING: v1
DEVANA-STATE: open | P1 | high | security=no
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

- 2026-06-29: open by Devana. Initial report written from static source inspection.

DEVANA-KEY: src/api/backend.ts:6914 | checkout-proof-not-enforced
DEVANA-SUMMARY: open | P1 | high | checkout.preview requires payment_authorization proof but checkout.start never validates proofRefs or inputHash.