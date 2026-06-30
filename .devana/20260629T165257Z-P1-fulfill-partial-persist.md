DEVANA-FINDING: v1
DEVANA-STATE: fixed | P1 | high | security=no
DEVANA-KEY: src/api/backend.ts:5049 | fulfill-partial-persist

# Paid order fulfillment lacks cross-store rollback

## Finding

`fulfillPaidOrder` runs per-line side effects (stock consume, entitlement/license writes) in separate repository operations, queues confirmation email, then writes the fulfilled order to the ledger. There is no shared transaction or compensating rollback if `ledger.put` fails after stock and entitlements are committed.

## Violated Invariant Or Contract

Fulfillment should be atomic across stock events, account documents, email queue, and order ledger, or failed ledger writes should roll back prior side effects.

## Oracle

`fulfillPaidOrder` sequence: line loop → `queueOrderConfirmationEmail` → `ledger.put` (`backend.ts:5043-5066`). Stock `consume` uses per-operation `withTransaction` only within stock tables.

## Counterexample

1. Payment webhook workflow runs `fulfill_order`.
2. Stock consumed and entitlement written successfully.
3. `queueOrderConfirmationEmail` completes.
4. `ledger.put(fulfilledOrder)` throws.
5. Order document lacks `fulfilledAt`; stock shows consumed; confirmation email may send.
6. Workflow retries; idempotent guards absorb most duplicates but intermediate state is inconsistent.

## Why It Might Matter

Transient ledger failures leave consumed stock and active entitlements without a matching fulfilled order record until retry succeeds.

## Proof

Read/write sequence: stock write → entitlement write → email queue → ledger failure → inconsistent reads.

## Counterevidence Checked

Per-line stock consume and entitlement `findById` guards make retries mostly idempotent. No compensating stock release or email cancel on ledger failure.

## Suggested Next Step

Write order ledger first with `fulfilling` state, or use outbox/saga with compensating actions on ledger failure.

## Agent Handoff

After working this report, preserve the original finding body. Update line 2 `DEVANA-STATE: ...` and the final `DEVANA-SUMMARY:` status/priority/confidence prefix. Use one of: `open`, `fixed`, `invalid`, `stale`, `duplicate`, `wontfix`. Keep `DEVANA-KEY:` stable unless the same finding moved. Add dated notes below with evidence checked.

## Status Notes

- 2026-06-29: open by Devana. Initial report written from static source inspection.
- 2026-06-30 (FIRST assessed `invalid`, then CORRECTED to `fixed` after an adversarial review). My first pass marked this `invalid`, reasoning that fulfillment is a fully-idempotent forward-recovery saga whose bounded worker-retry self-heals, and that a compensating rollback of a PAID order would be wrong. That reasoning holds ONLY for the report's narrowest illustration — a SINGLE-line order whose only failure is a transient `ledger.put` that recovers within the retry budget: the order stays `paid`, the retry re-runs against it, and goods (stock/entitlement/license) are committed BEFORE the `fulfilledAt` marker (`:5298-5321`) so the paying customer is never left without their goods, while a compensating rollback would wrongly REVOKE those paid goods. All of that remains true and is why this fix is forward-progress, not rollback. (Idempotency is real: stock `consume` dedups by reservation event id `:5409-5410`/`:5400`; entitlements `findEntitlementById`-guarded `:5345-5346`; licenses `findLicenseById`-guarded `:5359-5360` + `license.issued` marker `:5364`; order-confirmation email marker-gated exactly-once `:5511-5532`; deterministic-id `ledger.put`.)
- 2026-06-30: the adversarial review REFUTED `invalid` for the GENERAL case, and it is correct — idempotency (safe re-runs) is NOT atomicity (safe partial failure), and the loop has MANY independent commit points. Concrete PERMANENT harm, a MULTI-LINE order with a "poison" line: line L1 (`entitlement`) commits its stock + entitlement in iteration 1 (`:5333`/`:5346`); then L2's `consume` throws DETERMINISTICALLY — e.g. L2's reservation expired past TTL and the freed units were re-sold, so the stock fail-safe throws at `src/storage/repositories.ts:1839-1842` (the intended behavior of the already-fixed `expired-reservation-oversell` P0), or a `released` reservation → `:5412`. The throw exits the loop BEFORE `ledger.put` (`:5321`), so L1's committed goods are recorded NOWHERE at the order level. The payment-webhook workflow's retries are BOUNDED (`workflowIsDueForLease` stops at `maxAttempts`, `repositories.ts:1471`); since L2 fails identically every attempt, retries exhaust and the state is PERMANENT: L1 = consumed stock + active entitlement with NO matching fulfilled order; L2 = charged-but-undelivered. That permanently violates the report's stated invariant — so `invalid` was wrong, and the finding is a real defect.
- 2026-06-30: fixed via FORWARD-PROGRESS PERSISTENCE (chosen over compensating rollback — which would wrongly revoke a paid customer's goods — and over a single cross-store ACID transaction, which is unavailable). `fulfillPaidOrder` (`src/api/backend.ts:5289`) now wraps the per-line loop in try/catch: if a line throws mid-loop, the lines ALREADY fulfilled (carrying their `stockMovementId`/`entitlementId`), merged with the lines not yet reached, are written to the order ledger via a new `orderWithFulfilledLines` helper WITHOUT a `fulfilledAt` marker, then the error is rethrown so the workflow still records the failure and retries. So committed per-line goods are ALWAYS reflected in a durable, reconcilable order record (the order stays `paid`; the fulfilled lines carry their fulfillment ids) and are never orphaned, even when a later line fails permanently. The fully-fulfilled happy path is behaviorally unchanged (the helper builds the same document; `fulfilledAt` is set only when every line succeeds) — the whole suite stays green. Evidence: a new test (`test/backend.test.ts`, "persists forward progress when a later line fails mid-fulfillment") drives a 2-line entitlement order through the payment webhook with line 2's entitlement write forced to throw, and asserts the persisted `order_1` carries line 1's `entitlementId` with NO `fulfilledAt` (and the line-1 entitlement document is `active`) — i.e. line 1's committed goods are recorded on the order. Mutation-verified: disabling the partial persist (cp-backup + restore, no git) leaves `order_1` as the un-fulfilled `paid` order and fails the test (`expected undefined to be 'entitlement_order_1_order_line_1'`); restored via cp and re-confirmed green. Full suite (391) and both tsc configs pass.
- Residual (scoped follow-up, broader than this finding): a line that is PERMANENTLY unfulfillable (e.g. stock genuinely gone) is, after retry exhaustion, still charged-but-undelivered with no auto-refund and only the failed workflow as an operator signal. The proper remedy is a dead-letter / `fulfillment_blocked` disposition or a per-line auto-refund, which needs a transient-vs-permanent failure policy the current throw does not express; left as a follow-up (and possibly its own finding). This fix removes the SILENT ORPHANING of committed goods (the report's core invariant); it does not by itself resolve the charged-but-undelivered economics of a genuinely unfulfillable line.
- 2026-06-30: reopened and fixed for the report's original final-write counterexample. The previous fix persisted progress only from the mid-loop catch; a `ledger.put(fulfilledOrder)` failure after all lines succeeded still left committed goods absent from the order, and confirmation email was queued before that final write. `fulfillPaidOrder` now persists forward progress after each changed line, writes the final fulfilled marker before queuing the confirmation email, and treats a missing `fulfilledAt` as a final write that must be retried even when all line ids are already present. Download-ready notification emission now includes existing refs when adding the missing fulfilled marker, relying on its existing notification marker for idempotency. A new regression simulates a final fulfilled-order ledger write failure and asserts the line entitlement is durable, `fulfilledAt` is absent, no confirmation email is queued, and the entitlement exists.

DEVANA-KEY: src/api/backend.ts:5049 | fulfill-partial-persist
DEVANA-SUMMARY: fixed | P1 | high | fulfillPaidOrder now persists forward progress after each changed line and writes the final fulfilled marker before queuing confirmation email. Mid-loop and final ledger failures leave committed goods recorded on the order without fulfilledAt, making retries/reconciliation durable without compensating rollback.
