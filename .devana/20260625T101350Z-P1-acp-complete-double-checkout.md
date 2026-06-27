DEVANA-FINDING: v1
Priority: P1 | Confidence: high | Security-sensitive: no | Status: fixed
Location: src/acp.ts:711-820 | Slug: acp-complete-double-checkout

# ACP complete can start a second Mika checkout for the same session

## Finding

`handleAcpComplete` always calls `checkout.start` after validation. Once an ACP record has `checkoutId` set and status `ready_for_payment`, a second `complete` request with a different `Idempotency-Key` bypasses idempotency replay and creates another provider checkout and stock reservations.

## Violated Invariant Or Contract

One ACP checkout session should bind to at most one in-flight Mika checkout. Payment completion should resume or replay that checkout, not create another.

## Oracle

After successful `complete` leaving status `ready_for_payment` with `checkoutId` set, a second `complete` with a different idempotency key must not call `checkout.start` again.

## Counterexample

1. `complete` succeeds; backend returns checkout not yet `completed` → record gets `checkoutId`, status `ready_for_payment` (808–816).
2. Client retries `complete` with a new `Idempotency-Key`.
3. `beginAcpIdempotency` treats it as a new request.
4. `handleAcpComplete` calls `checkout.start` (~790) without branching on existing `record.checkoutId`.
5. Second provider checkout and reservations created for the same cart.

## Why It Might Matter

Double stock reservations and duplicate provider checkout sessions for one ACP cart. Client-generated idempotency keys make different-key retries common.

## Proof

**Control-flow trace:** Idempotency replay is HTTP-key-scoped only. `terminalStatus === "completed"` early-return does not cover pending-checkout case. No `record.checkoutId` guard before `checkout.start`.

## Counterevidence Checked

Tests cover replay with the same idempotency key and in-progress conflict. No test for different key after `ready_for_payment` with existing `checkoutId`.

## Suggested Next Step

When `record.checkoutId` exists and payment is pending, replay or poll existing Mika checkout instead of calling `checkout.start` again.

## Agent Handoff

After working this report, preserve the original finding body. Update line 2 `Status: ...` and the final `DEVANA-SUMMARY:` status.

## Status Notes

- 2026-06-25: open by Devana. Initial report written from static source inspection.
- 2026-06-27: fixed. Confirmed `handleAcpComplete` only short-circuited on terminal `completed`/`canceled` status; a retry with a different `Idempotency-Key` while the Mika checkout was still pending fell through to a second `checkout.start`, creating duplicate reservations and provider sessions. Fix: after the terminal-status checks, if `record.checkoutId` is already set (checkout in flight, non-terminal), commit the idempotency lease and return the existing session via `recordToAcpSession` instead of starting a new checkout. Added regression test `does not start a second Mika checkout when completing a pending ACP session again` (extended the test API to support a pending checkout status). Typecheck + 309 tests pass.

DEVANA-KEY: src/acp.ts:711-820 | P1 | acp-complete-double-checkout
DEVANA-SUMMARY: Status=fixed | P1 high src/acp.ts:711-820 - ACP complete with a new idempotency key started a second Mika checkout while payment was pending. Fixed by resuming the existing checkout when record.checkoutId is set, with a regression test.