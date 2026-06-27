DEVANA-FINDING: v1
DEVANA-STATE: open | P1 | high | security=yes
DEVANA-KEY: src/api/backend.ts:916-949 | merge-source-session-idor

# Cart merge accepts arbitrary sourceSessionId without ownership check

## Finding

`cart.merge` ownership-checks the target cart via `findOwnedOpenCartById`, but loads the source cart using only `sourceSessionId` with no requirement that it matches `ctx.sessionId`. An attacker who knows or guesses another session id can merge the victim's open cart into their own, copying line items and abandoning the victim cart.

## Violated Invariant Or Contract

Merging a source cart into a target cart must require the caller to own or cryptographically bind the source session.

## Oracle

Target path uses `findOwnedOpenCartById` (customerId or sessionId match); source path uses `findOpenCartBySession(sourceSessionId, currency)` with no ctx binding (backend.ts:916-918).

## Counterexample

1. Victim session `sess_victim` has open cart with items.
2. Attacker session `sess_attacker` calls `cart.merge({ sourceSessionId: "sess_victim" })` with attacker-owned target cart.
3. Source cart lines copy to attacker cart; victim cart set `abandoned`.
4. Response returns merged cart DTO exposing victim line items.

## Why It Might Matter

Cross-user cart tampering and item disclosure when session identifiers are guessable or leaked (cookie scope, logs, referrer).

## Proof

**Dataflow trace:** Untrusted `sourceSessionId` → `findOpenCartBySession` (no auth) → `mergeCartLines` → `session.put` target + abandoned source.

## Counterevidence Checked

Target ownership is enforced. Currency mismatch is validated. Wishlist merge has the same pattern (1109-1147). Guest→logged-in merge is an intended use case but lacks proof-of-source-session binding.

## Suggested Next Step

Require `sourceSessionId === ctx.sessionId`, or a signed merge token issued when the guest session initiated login handoff.

## Agent Handoff

After working this report, preserve the original finding body. Update line 2 `DEVANA-STATE: ...` and the final `DEVANA-SUMMARY:` status/priority/confidence prefix. Use one of: `open`, `fixed`, `invalid`, `stale`, `duplicate`, `wontfix`. Keep `DEVANA-KEY:` stable unless the same finding moved. Add dated notes below with evidence checked.

## Status Notes

- 2026-06-27: open by Devana. Initial report written from static source inspection.

DEVANA-KEY: src/api/backend.ts:916-949 | merge-source-session-idor
DEVANA-SUMMARY: open | P1 | high | cart.merge loads any sourceSessionId without binding to the caller session, enabling cross-session cart merge and item disclosure.