DEVANA-FINDING: v1
DEVANA-STATE: fixed | P1 | high | security=no
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
- 2026-06-30: fixed (report's second suggested approach: clear the idempotency key on expiry/release). Root cause confirmed: the single-event `StockRepository.release` and `expire` already clear the key (`mutateActiveReservationEvent` with `eventPatch: { idempotency_key: null }`), but the BULK maintenance paths did not — `releaseExpiredReservations` set only `status: "expired"` + `updated_at`, and `releaseActiveReservationsByCustomer` set only `status: "released"` + `updated_at`, leaving `idempotency_key` bound to the now-dead reservation. Because `mutateStockWithEvent` replays purely by `findStockEventByIdempotencyKey` (no status filter), a retry with the original key kept matching the expired event → `reserve` returns `replayed` → `reserveCheckoutLines` returns `checkoutIdempotencyInProgress` (409) forever. Fix: add `idempotency_key: null` to both bulk `.set()` clauses (`src/storage/repositories.ts`), so once maintenance expires/releases a reservation the key is freed and the next `reserve` with that key creates a fresh active reservation instead of replaying a dead one. No change to the API replay path or `mutateStockWithEvent` was needed — clearing the key is the root cause, and the replay-by-key then simply stops matching. The in-memory test stock repository (`createTestStockRepository`) had the identical omission (its bulk methods kept and re-indexed the key in `eventsByIdempotencyKey`); it now mirrors its own single-event `release`/`expire` (`idempotencyKey: undefined` + `eventsByIdempotencyKey.delete(...)`). Scope: fixed BOTH bulk paths — the reported expiry path AND the account-delete `releaseActiveReservationsByCustomer` sibling (same latent inconsistency; makes the bulk paths symmetric with the single-event ones). Evidence: a new parameterized contract test (`${repositoryKind} ... frees the idempotency key when a reservation expires`) runs against BOTH the real (Kysely/SQLite) and fake (in-memory) repositories: it reserves with key K (asserts the active event replays by K), runs `releaseExpiredReservations`, asserts `findEventByIdempotencyKey(K)` is now null, and asserts a fresh `reserve` with K returns `reserved` (a brand-new event id) rather than `replayed`. The production fix was confirmed load-bearing by reverting the `repositories.ts` key-clearing and observing exactly the `real ...` variant fail (the `fake` variant stayed green on its in-memory fix). Full suite (366) and both tsc configs pass. Out of scope (NOT changed): the API-layer `reserveCheckoutLines` still treats any `replayed` as in-progress (correct once stale keys are freed — an active replay is a genuine concurrent attempt); the report's alternative "allow checkout start to proceed when replayed events are non-active" was not taken because clearing the key on expiry/release is the narrower root-cause fix and avoids re-reserving against a key still bound to a dead event.
- 2026-06-30: reviewed (APPROVE_WITH_NITS, no blocking; production fix mutation-verified — reverting only the `releaseExpiredReservations` key-null fails exactly the `real` contract variant while `fake` stays green). Strengthened evidence from review: there is a UNIQUE index on `mika_stock_events.idempotency_key` (`migrations.ts`, `idx_mika_stock_events_idempotency`), and `findStockEventByIdempotencyKey` relies on it (`executeTakeFirst()`, no `orderBy`). This makes clearing the key on expiry/release REQUIRED, not merely tidy: the report's rejected alternative (let `reserve` proceed while the dead event still holds the key) would `INSERT` a fresh event with the same key and hit a UNIQUE-constraint violation. So nulling the key is the only internally-consistent fix and confirms leaving the API replay path untouched is correct. Late-paid-fulfillment `consume` is unaffected (it looks up by reservation-event id and still accepts `status: "expired"`; it never reads the key). Tweaked the expiry-branch comment ("released" → "the held stock has already been returned to availability") for precision. Noted invariant (nit, no change): both this fix and the lookup hinge on that pre-existing UNIQUE index — any future change relaxing key uniqueness must revisit both.

DEVANA-KEY: src/api/backend.ts:6302 | checkout-idempotency-stuck-replay
DEVANA-SUMMARY: fixed | P1 | high | Bulk releaseExpiredReservations/releaseActiveReservationsByCustomer now clear idempotency_key (like the single-event expire/release), so an expired/released stock reservation no longer keeps replaying and blocking checkout retries with 409.