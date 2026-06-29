DEVANA-FINDING: v1
DEVANA-STATE: fixed | P0 | high | security=yes
DEVANA-KEY: src/api/backend.ts:1186 | wishlist-merge-cross-session-idor

# Wishlist merge lacks cross-session ownership check

## Finding

`wishlist.merge` loads a source wishlist by arbitrary `sourceSessionId` and merges its items into the caller's target wishlist without verifying that the caller owns the source session. `cart.merge` uses `callerOwnsMergeSource` to block the same cross-session pattern.

## Violated Invariant Or Contract

Session-scoped wishlists should only be readable or mutable by the owning session or matching customer, consistent with cart merge IDOR protections.

## Oracle

`cart.merge` explicitly refuses foreign session carts via `callerOwnsMergeSource` and the test `"refuses to merge a source cart the caller does not own (cross-session IDOR)"`. Wishlist merge has no equivalent guard but performs the same session-keyed lookup.

## Counterexample

Attacker context: `sessionId = "session_attacker"`. Victim context: `sessionId = "session_victim"` with wishlist items. Attacker calls `wishlist.merge({ sourceSessionId: "session_victim" })`. Mika copies victim items into the attacker's wishlist and marks the victim wishlist `merged`.

## Why It Might Matter

A guessable or leaked session id lets one shopper harvest another's saved items. Cart merge was hardened against this; wishlist merge was not.

## Proof

Cross-entry mismatch:

- `cart.merge` at `src/api/backend.ts:981` returns unchanged data when `!callerOwnsMergeSource(ctx, source)`.
- `wishlist.merge` at `src/api/backend.ts:1186-1207` loads `findWishlistBySession(sourceSessionId)` and merges without any ownership check.

Actor-to-resource trace: attacker session → `sourceSessionId` parameter → victim `WishlistDocument` → items copied to attacker target.

## Counterevidence Checked

`findOwnedActiveWishlistById` protects the target wishlist id, not the source session. Tests intentionally merge across different sessions (`test/backend.test.ts:11817-11818`), which documents behavior but does not provide a security boundary when `sourceSessionId` is attacker-controlled.

## Suggested Next Step

Apply the same `callerOwnsMergeSource` guard used by cart merge before merging wishlist sources, and add a regression test mirroring the cart cross-session IDOR case.

## Agent Handoff

After working this report, preserve the original finding body. Update line 2 `DEVANA-STATE: ...` and the final `DEVANA-SUMMARY:` status/priority/confidence prefix. Use one of: `open`, `fixed`, `invalid`, `stale`, `duplicate`, `wontfix`. Keep `DEVANA-KEY:` stable unless the same finding moved. Add dated notes below with evidence checked.

## Status Notes

- 2026-06-29: open by Devana. Initial report written from static source inspection.
- 2026-06-29: fixed. `wishlist.merge` now applies the same `callerOwnsMergeSource(ctx, source)` guard as `cart.merge` before merging a `sourceSessionId` wishlist: the caller must own the source (matching customer id, or matching session id for a guest source). A foreign source is ignored and the caller's target wishlist is returned unchanged. Evidence: the legitimate login-handoff path still works because the signing-in browser keeps its session id (and so owns the guest wishlist it created); the existing merge test was retargeted to that pattern (explicit `targetWishlistId`, source session owned via the caller's session). Added a cross-session IDOR regression test mirroring the cart-merge case asserting the attacker's wishlist is unchanged and the victim wishlist stays active and intact.

DEVANA-KEY: src/api/backend.ts:1186 | wishlist-merge-cross-session-idor
DEVANA-SUMMARY: fixed | P0 | high | wishlist.merge now enforces the same caller-ownership guard as cart.merge, so a guessed/leaked sourceSessionId can no longer harvest another session's saved items.