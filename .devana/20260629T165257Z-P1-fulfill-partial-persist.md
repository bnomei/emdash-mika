DEVANA-FINDING: v1
DEVANA-STATE: open | P1 | high | security=no
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

DEVANA-KEY: src/api/backend.ts:5049 | fulfill-partial-persist
DEVANA-SUMMARY: open | P1 | high | fulfillPaidOrder commits stock and entitlements before ledger.put with no rollback on ledger failure.