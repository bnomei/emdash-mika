DEVANA-FINDING: v1
DEVANA-STATE: fixed | P1 | high | security=yes
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
- 2026-06-27: fixed. Confirmed `cart.merge` loaded the source via `findOpenCartBySession(sourceSessionId)` (+ any-currency fallback) with no binding to the caller, so any actor could merge another session's open cart into their own and read its lines. Fix: new `callerOwnsMergeSource(ctx, source)` gate (ownership mirrors `findOwnedOpenCartById` — a customer-owned source must match `ctx.customerId`, otherwise a session-owned source must match `ctx.sessionId`; an unbound source is never valid). An unowned/missing source now follows the existing silent no-op path (returns the caller's unchanged cart, 200) so the response never discloses whether another session's cart exists. The legitimate guest→login handoff still works because the browser session cookie is preserved across login, so the now-authenticated caller still holds the guest `sessionId`. Updated the existing merge test to model that secure handoff (shared session id) and the currency-mismatch test to use a same-customer foreign-currency source; added regression test `refuses to merge a source cart the caller does not own (cross-session IDOR)`. The wishlist merge has the identical pattern and is tracked separately in `wishlist-merge-source-session-idor`; `callerOwnsMergeSource` is shared and ready for that fix. Typecheck + 316 tests pass.

DEVANA-KEY: src/api/backend.ts:916-949 | merge-source-session-idor
DEVANA-SUMMARY: fixed | P1 | high | cart.merge loaded any sourceSessionId without caller binding (cross-session IDOR). Fixed with a callerOwnsMergeSource ownership gate that silently no-ops unowned sources; legitimate login handoff preserved. Regression test added.