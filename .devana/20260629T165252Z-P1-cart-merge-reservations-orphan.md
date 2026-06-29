DEVANA-FINDING: v1
DEVANA-STATE: open | P1 | high | security=no
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

DEVANA-KEY: src/api/backend.ts:995 | cart-merge-reservations-orphan
DEVANA-SUMMARY: open | P1 | high | cart.merge copies reservationId onto a new cart while abandoning the checkout_pending source without releasing holds.