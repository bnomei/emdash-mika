DEVANA-FINDING: v1
DEVANA-STATE: open | P1 | high | security=no
DEVANA-KEY: src/api/backend.ts:6302 | checkout-idempotency-stuck-replay

# Checkout idempotency key can stay blocked after failed start

## Finding

If `checkout.start` reserves stock then fails before persisting the checkout document, retries with the same idempotency key hit stock `replayed` and return `checkoutIdempotencyInProgress` (409) even after maintenance marks the reservation `expired`. Expired-reservation release does not clear `idempotency_key`, so the key remains bound to a dead reservation event.

## Violated Invariant Or Contract

Idempotent checkout start should eventually succeed or fail cleanly after partial failure. A consumed idempotency key should either replay a stored checkout or allow a fresh attempt once reservations are released.

## Oracle

`release` clears `idempotency_key` on manual release (`src/storage/repositories.ts:1720`), but `releaseExpiredReservations` only sets `status: "expired"` and leaves the key intact (`1820-1825`). `mutateStockWithEvent` replays solely by `idempotency_key` without checking reservation status (`1978-1987`).

## Counterexample

1. `checkout.start` with `Idempotency-Key: K` reserves stock; crash before `session.put(checkout)`.
2. Retry with `K`: no checkout doc; `reserve` returns `replayed`; API returns 409 in progress.
3. Maintenance expires reservation (`status: expired`, stock released, `idempotency_key` still `K`).
4. Retry with `K`: still `replayed` → still 409; shopper cannot complete checkout without a new key.

## Why It Might Matter

Clients correctly retry with the same idempotency key after transient failures and get permanently stuck. Inventory is free but checkout cannot proceed on the original key.

## Proof

State transition trace:

- `reserveCheckoutLines` treats any `replayed` as in progress (`src/api/backend.ts:6302-6304`).
- `releaseExpiredReservations` does not null `idempotency_key`.
- `findStockEventByIdempotencyKey` matches expired events the same as active ones.

## Counterevidence Checked

Happy-path replay works when the checkout document exists (`5940-5953`). Provider failure after reserve releases reservations and clears active holds, but does not clear idempotency keys on those released events either; manual `release` does clear keys when cancel paths run.

## Suggested Next Step

Treat `replayed` reservations that are `expired` or `released` without a matching checkout document as stale, clear their idempotency keys on expiry/release, or allow checkout start to proceed when replayed events are non-active.

## Agent Handoff

After working this report, preserve the original finding body. Update line 2 `DEVANA-STATE: ...` and the final `DEVANA-SUMMARY:` status/priority/confidence prefix. Use one of: `open`, `fixed`, `invalid`, `stale`, `duplicate`, `wontfix`. Keep `DEVANA-KEY:` stable unless the same finding moved. Add dated notes below with evidence checked.

## Status Notes

- 2026-06-29: open by Devana. Initial report written from static source inspection.

DEVANA-KEY: src/api/backend.ts:6302 | checkout-idempotency-stuck-replay
DEVANA-SUMMARY: open | P1 | high | Failed checkout.start can leave an idempotency key bound to an expired stock reservation and block all retries with 409.