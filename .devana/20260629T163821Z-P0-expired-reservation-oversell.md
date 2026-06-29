DEVANA-FINDING: v1
DEVANA-STATE: fixed | P0 | high | security=no
DEVANA-KEY: src/storage/repositories.ts:1739 | expired-reservation-oversell

# Expired reservation release plus late consume can oversell stock

## Finding

`releaseExpiredReservations` moves expired reservations to `expired` status and returns reserved quantity to the available pool. `consume` still accepts `expired` reservations and decrements on-hand via `consumeOnHandStatement` without re-checking availability. Between release and late consume, new checkouts can reserve the same units, allowing total committed quantity to exceed original on-hand stock.

## Violated Invariant Or Contract

Finite stock must not commit more units than `quantity_on_hand` across overlapping reservations and consumptions.

## Oracle

`reserveStockStatement` atomically checks `quantity_on_hand - quantity_reserved >= qty`. `releaseExpiredReservations` decreases `quantity_reserved`. `consume` on `expired` events uses `consumeOnHandStatement` with only `MAX(0, quantity_on_hand - qty)` and no reserved-quantity guard.

## Counterexample

1. Item: `on_hand=5`, `reserved=0`.
2. Checkout A reserves 3 (`active`, `expires_at` passed).
3. `releaseExpiredReservations`: event → `expired`, `reserved` 3→0, on-hand unchanged.
4. Checkout B reserves 3 (`reserved=3`, available=2).
5. Payment webhook fulfills A: `consume` on `expired` event decrements on-hand by 3.
6. Final: `on_hand=2`, `reserved=3` → 5 units committed from 5 on-hand stock while B's reservation is still active.

## Why It Might Matter

Overselling physical or limited digital inventory; customers receive paid confirmations when stock cannot be fulfilled.

## Proof

**Dataflow trace:** maintenance release → available pool increases → new reserve succeeds → expired reservation consume decrements on-hand without availability gate.

Locations: `src/storage/repositories.ts` (`releaseExpiredReservations` ~1802+, `consume` ~1730–1783), `src/storage/statements.ts` (`consumeOnHandStatement`, `releaseStockStatement`).

## Counterevidence Checked

`consume` on `active` reservations uses `consumeReservedStockStatement` (reserved path). `reserveStockStatement` is atomic within a transaction. No code prevents re-reservation after expiry release or blocks expired consume when on-hand is insufficient for logical availability.

## Suggested Next Step

Either invalidate expired reservations for consume (reject `expired` after release sweep), or do not return quantity to the available pool until checkout is terminal.

## Agent Handoff

After working this report, preserve the original finding body. Update line 2 `DEVANA-STATE: ...` and the final `DEVANA-SUMMARY:` status/priority/confidence prefix.

## Status Notes

- 2026-06-29: open by Devana. Initial report written from static source inspection across cache-persistence and inside-out-paths trails.
- 2026-06-29: fixed. `consumeOnHandStatement` (the expired-reservation consume path) now carries the same atomic availability guard as `reserveStockStatement`: for finite, non-backorder items it only decrements on-hand when `quantity_on_hand - quantity_reserved >= quantity`, so it can never dip into units already committed to other active reservations. When the guard blocks, `consume` throws (rolling back the transaction so the expired event stays expired and the late fulfillment can be retried once stock frees up) instead of silently overselling. The legitimate late-fulfillment path (enough free on-hand) is unchanged. Added a contract test across both repository kinds reproducing the oversell counterexample and asserting it is refused with stock left intact.

DEVANA-KEY: src/storage/repositories.ts:1739 | expired-reservation-oversell
DEVANA-SUMMARY: fixed | P0 | high | The expired-reservation consume path is now reserved-aware (same guard as reserve), so a late payment can no longer consume units re-committed to another active reservation; an unfulfillable late consume rolls back instead of overselling.