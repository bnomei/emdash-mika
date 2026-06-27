DEVANA-FINDING: v1
Priority: P1 | Confidence: high | Security-sensitive: yes | Status: fixed
Location: src/api/backend.ts:5666-5675 | Slug: checkout-idempotency-cross-session

# Global checkout idempotency replay leaks another session's checkout

## Finding

`startCheckout` replays any checkout document matching `ctx.idempotencyKey` globally, without verifying the checkout belongs to the requesting session or customer. A different actor reusing the same idempotency key receives the original checkout handoff data.

## Violated Invariant Or Contract

Idempotency replay must return only checkouts owned by the same actor (session/customer) that created them. Checkout handoff data must not cross identity boundaries.

## Oracle

Two `checkout.start` calls with the same idempotency key but different `sessionId` must not return identical checkout payloads unless they belong to the replaying caller.

## Counterexample

1. Session A calls `checkout.start` with idempotency key `K` → creates checkout `C1` bound to session A.
2. Session B calls `checkout.start` with the same key `K`.
3. `findCheckoutByIdempotencyKey` returns `C1` (global lookup, repositories.ts:583–596).
4. B receives `checkoutDocumentResult(C1)` including A's `redirectUrl` and checkout id — no ownership check on replay path.

## Why It Might Matter

Cross-session checkout handoff leakage when idempotency keys are predictable, shared, or client-generated. `checkoutBelongsToContext` is used for status polling but not idempotent start replay.

## Proof

**Cross-entry mismatch:** Replay branch at 5666–5675 has no `checkoutBelongsToContext` guard. Lookup is not scoped to `ctx.sessionId` / `ctx.customerId`.

## Counterevidence Checked

Tests cover same-context replay and input-hash mismatch. Metadata-key injection cannot forge indexed keys. Empty keys rejected. Input-hash mismatch only when both hashes present.

## Suggested Next Step

Apply `checkoutBelongsToContext` (or equivalent) before returning replayed checkout; scope idempotency lookup to actor dimensions.

## Agent Handoff

After working this report, preserve the original finding body. Update line 2 `Status: ...` and the final `DEVANA-SUMMARY:` status.

## Status Notes

- 2026-06-25: open by Devana. Initial report written from static source inspection.
- 2026-06-27: fixed. Confirmed the `startCheckout` replay branch returned `checkoutDocumentResult(replayedCheckout)` from a global `findCheckoutByIdempotencyKey` lookup with no owner check, while `checkoutBelongsToContext` was only used for status polling. Fix: gate the replay on `checkoutBelongsToContext(replayedCheckout, ctx)`; a cross-actor key collision now returns a 409 CONFLICT (`checkoutIdempotencyInputMismatch`) instead of leaking the owner's checkout id/redirect URL. Added regression test `does not replay a checkout idempotency key across a different session`. Typecheck + 301 tests pass.

DEVANA-KEY: src/api/backend.ts:5666-5675 | P1 | checkout-idempotency-cross-session
DEVANA-SUMMARY: Status=fixed | P1 high src/api/backend.ts:5666-5675 - Checkout idempotency replay was globally keyed and returned another session's checkout handoff. Fixed by gating replay on checkoutBelongsToContext (cross-actor collision -> 409), with a regression test.