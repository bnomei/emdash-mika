DEVANA-FINDING: v1
Priority: P1 | Confidence: high | Security-sensitive: no | Status: open
Location: src/storage/repositories.ts:1838-1847 | Slug: stock-idempotency-replay-after-release

# Stock idempotency replay blocks checkout retry after reservation release

## Finding

`mutateStockWithEvent` replays any prior stock event matching `idempotencyKey` regardless of `event.status`. After checkout failure releases reservations (`released`), a retry with the same checkout idempotency key replays the terminal event without re-reserving. `reserveCheckoutLines` treats all `replayed` outcomes as in-progress conflict.

## Violated Invariant Or Contract

A client retry with the same checkout idempotency key after a failed attempt (reservations released, checkout not persisted) must either return the stored checkout or successfully start a new one with active reservations.

## Oracle

After provider failure plus `releaseCheckoutReservations`, retry with same `ctx.idempotencyKey` succeeds or returns persisted checkout document.

## Counterexample

1. `startCheckout` with key `K` reserves with key `checkout:K:<stockId>:...`.
2. Provider throws → `releaseCheckoutReservations` marks events `released`; checkout never persisted.
3. Retry with same `K`: `mutateStockWithEvent` finds released event, returns `{ status: "replayed", event: released }` without stock mutation.
4. `reserveCheckoutLines` (6018–6020) returns `checkoutIdempotencyInProgress()` (409).

## Why It Might Matter

Legitimate checkout retries after transient provider or persistence failures are permanently blocked for that idempotency key, forcing clients to mint new keys and breaking safe-retry semantics.

## Proof

**State transition mismatch:** Idempotency lookup ignores `active` vs `released`. `replayed` never re-applies `reserveStockStatement`. Top-level checkout replay only helps when checkout document was persisted.

## Counterevidence Checked

Successful persist path returns replayed checkout (5666–5675). Concurrent in-progress with active replay does not release prior reservations. No status-aware replay branch.

## Suggested Next Step

Replay only when prior event is `active`, or clear/rename idempotency keys on release, or treat `replayed`+`released` as a new reserve attempt.

## Agent Handoff

After working this report, preserve the original finding body. Update line 2 `Status: ...` and the final `DEVANA-SUMMARY:` status.

## Status Notes

- 2026-06-25: open by Devana. Initial report written from static source inspection.

DEVANA-KEY: src/storage/repositories.ts:1838-1847 | P1 | stock-idempotency-replay-after-release
DEVANA-SUMMARY: Status=open | P1 high src/storage/repositories.ts:1838-1847 - Released stock reservations replay on idempotency key without re-reserving, blocking checkout.start retries.