DEVANA-FINDING: v1
DEVANA-STATE: invalid | P1 | high | security=no
DEVANA-KEY: src/api/backend.ts:995 | cart-merge-reservations-orphan

# cart.merge orphans checkout_pending reservations

## Finding

`cart.merge` copies source cart lines including `reservationId` values onto the target open cart, then marks the source cart `abandoned`. It does not release checkout stock reservations or cancel the linked checkout. The abandoned source cart still holds the checkout linkage while the target cart mirrors the same reservation IDs.

## Violated Invariant Or Contract

Merging carts should not leave active stock reservations pinned to an abandoned cart while duplicate reservation references exist on another cart. `reopenAbandonedCheckoutCart` releases reservations before reopening; merge has no equivalent.

## Oracle

`reopenAbandonedCheckoutCart` explicitly calls `releaseCheckoutReservations` before reopening (`backend.ts:5760-5767`). `cart.merge` only updates cart documents (`backend.ts:995-1011`).

## Counterexample

1. `checkout.start` on cart A → cart A `checkout_pending`, lines carry `reservationId`, checkout doc references cart A.
2. `cart.merge({ sourceSessionId: A's session })` into cart B.
3. Target cart B receives lines with same `reservationId`; source cart A becomes `abandoned`.
4. Stock reservations remain active; `checkout.cancel` reopens abandoned cart A, not B.

## Why It Might Matter

Stock stays reserved for an abandoned cart; shoppers see merged cart state that does not match checkout/reservation ownership; cancel path targets the wrong cart.

## Proof

State transition mismatch: merge copies reservation-bearing lines without reservation lifecycle cleanup that reopen/cancel paths perform.

## Counterevidence Checked

`mergeCartLines` does not strip `reservationId`. No checkout document update on merge. Stock double-reserve blocked only when on-hand insufficient, not when reservations are orphaned.

## Suggested Next Step

Release reservations and cancel or rebind linked checkout before merging a `checkout_pending` source cart.

## Agent Handoff

After working this report, preserve the original finding body. Update line 2 `DEVANA-STATE: ...` and the final `DEVANA-SUMMARY:` status/priority/confidence prefix. Use one of: `open`, `fixed`, `invalid`, `stale`, `duplicate`, `wontfix`. Keep `DEVANA-KEY:` stable unless the same finding moved. Add dated notes below with evidence checked.

## Status Notes

- 2026-06-29: open by Devana. Initial report written from static source inspection.
- 2026-06-30: invalid — the described orphaning CANNOT occur. The counterexample requires `cart.merge` to find and abandon a `checkout_pending` source cart and copy its `reservationId`-bearing lines, but two independent invariants make that impossible: (1) `cart.merge` (`src/api/backend.ts:1002`) resolves its source ONLY via `findOpenCartBySession(sourceSessionId)` / `findOpenCartBySessionAnyCurrency` (`:1024-1026`), and BOTH filter `status: "open"` (`src/storage/repositories.ts:586-592`, `570-573`) — a `checkout_pending` cart is never returned. If the named session's cart is `checkout_pending`, `source` is `null`, so the early return at `:1027-1033` yields the target unchanged: the `checkout_pending` cart is NOT found, NOT abandoned, and its reservation is NOT touched. (2) An `open` cart NEVER carries a `reservationId`: the only two `status: "open"` cart constructions are `reopenCartDocument` (which STRIPS `reservationId` → `undefined`, `:6108-6110`) and `createCartDocument` (a fresh EMPTY aggregate, `:7670`); the ONLY write of `reservationId` onto a cart document's items is `updateCartDocument` at `:7237`, which is paired with `status: "checkout_pending"` at `:7244` (the writes at `:6453`/`:6752` are onto checkout/quote `lines`, not cart documents). So even though `mergeCartLines` (`:7731-7752`) copies a source line verbatim, an `open` source has no `reservationId` to copy. The report's Oracle (`reopenAbandonedCheckoutCart` releases reservations) is about a DIFFERENT path that intentionally operates on `checkout_pending` carts (`findCheckoutPendingCartBy*`); `cart.merge` never reaches a `checkout_pending` cart, so it needs no such release. (The second `merge:` at `:1217` is WISHLIST merge; the `cart/merge` operation in `operations.ts:564` is a thin wrapper over this same backend `cart.merge`.) Empirical confirmation: a new regression-guard test (`test/backend.test.ts`, "does not orphan a checkout_pending cart's reservation when its owner triggers a cart.merge") drives a CUSTOMER-owned cart to `checkout_pending` with an active stock reservation (`quantityReserved: 2`), then has the SAME customer (in a different session) call `cart.merge({ sourceSessionId: <the source session> })` — so `callerOwnsMergeSource` PASSES and the ONLY thing preventing the merge from touching the source is the `status:"open"` filter in `findOpenCartBySession` — and asserts the `checkout_pending` cart is STILL `checkout_pending` (not abandoned) and the reservation STILL held (`quantityReserved: 2`). The test is LOAD-BEARING (a review caught that an earlier cross-session version was over-determined — the ownership check would have bailed regardless): mutation-verified by neutering `findOpenCartBySession`'s `status:"open"` filter (cp-backup + restore, no git) so it returns the `checkout_pending` cart — the merge then proceeds and the source flips to `abandoned`, failing the test (`expected "checkout_pending", received "abandoned"`); restored and re-confirmed green. Full suite (387) and both tsc configs pass. Kept as a guard so a future change that let `findOpenCartBySession` return `checkout_pending` carts (which would make this report valid) is caught.

DEVANA-KEY: src/api/backend.ts:995 | cart-merge-reservations-orphan
DEVANA-SUMMARY: invalid | P1 | high | cart.merge cannot orphan checkout_pending reservations: it resolves its source only via findOpenCartBySession* (status:"open"), so a checkout_pending cart is never found/abandoned; and an open cart never carries a reservationId (only checkout_pending carts do — set together at backend.ts:7237/7244; stripped on reopen at 6109). Verified by a passing regression-guard test that merges against a checkout_pending session and shows the cart + reservation are untouched.