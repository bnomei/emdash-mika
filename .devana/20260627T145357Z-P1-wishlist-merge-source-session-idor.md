DEVANA-FINDING: v1
DEVANA-STATE: open | P1 | high | security=yes
DEVANA-KEY: src/api/backend.ts:1115-1145 | wishlist-merge-source-session-idor

# Wishlist merge accepts arbitrary sourceSessionId without ownership check

## Finding

`wishlist.merge` ownership-checks the target wishlist via `findOwnedActiveWishlistById`, but loads the source wishlist using only `sourceSessionId` with no requirement that it matches `ctx.sessionId`. This mirrors the cart merge IDOR on a separate entry point.

## Violated Invariant Or Contract

Merging a source wishlist into a target wishlist must require the caller to own or cryptographically bind the source session.

## Oracle

Target path uses owned wishlist helpers; source path uses `findWishlistBySession(sourceSessionId)` with no ctx binding (`backend.ts:1124-1131`). Cart merge IDOR is filed separately at `916-949`.

## Counterexample

1. Victim session `S_v` has active wishlist with item `I1`.
2. Attacker calls `wishlist.merge({ sourceSessionId: "S_v" })`.
3. Attacker's wishlist receives `I1`; victim wishlist becomes `merged` and later lookups create a new empty active wishlist.

## Why It Might Matter

Cross-session wishlist item disclosure and destructive merge of victim wishlist state.

## Proof

**Dataflow trace:** untrusted `sourceSessionId` → `findWishlistBySession` → `mergeWishlistItems` → `put` target + `merged` source.

## Counterevidence Checked

Tests encode cross-session merge as reachable behavior for carts; no cryptographic merge token exists for wishlists either. Distinct API surface from cart.merge — hosts may patch one path and miss the other.

## Suggested Next Step

Require `sourceSessionId === ctx.sessionId` or a signed merge token, matching the cart merge remediation.

## Agent Handoff

After working this report, preserve the original finding body. Update line 2 `DEVANA-STATE: ...` and the final `DEVANA-SUMMARY:` status/priority/confidence prefix. Use one of: `open`, `fixed`, `invalid`, `stale`, `duplicate`, `wontfix`. Keep `DEVANA-KEY:` stable unless the same finding moved. Add dated notes below with evidence checked.

## Status Notes

- 2026-06-27: open by Devana. Initial report written from static source inspection.

DEVANA-KEY: src/api/backend.ts:1115-1145 | wishlist-merge-source-session-idor
DEVANA-SUMMARY: open | P1 | high | wishlist.merge loads any sourceSessionId without binding to the caller session, enabling cross-session wishlist merge and item disclosure.