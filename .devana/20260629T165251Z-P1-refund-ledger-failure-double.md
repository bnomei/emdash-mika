DEVANA-FINDING: v1
DEVANA-STATE: open | P1 | high | security=no
DEVANA-KEY: src/api/backend.ts:2596 | refund-ledger-failure-double

# Provider refund success with ledger failure allows duplicate refunds on retry

## Finding

When `order.refund` succeeds at the provider but `ledger.put` throws, the admin audit is marked `failed`. A retry with the same idempotency key does not replay the prior result because replay only applies when audit `status === "completed"`. A new provider refund call is made without a Stripe-side idempotency key.

## Violated Invariant Or Contract

Admin idempotency keys should make refund operations safe to retry without duplicating provider side effects once the provider has already accepted the refund.

## Oracle

`runAdminAction` replays only completed audits (`backend.ts:2571-2575`). `refundStripePayment` calls `refunds.create` without idempotency options (`stripe.ts:598-602`).

## Counterexample

1. Admin `order.refund` with `idempotencyKey: "refund-1"`.
2. Stripe refund succeeds (`status: "succeeded"`).
3. `ledger.put(updated)` throws (storage error).
4. Audit completes as `failed`.
5. Client retries with same `idempotencyKey: "refund-1"`.
6. Prior audit is not replayed; second `refunds.create` runs.

## Why It Might Matter

Duplicate Stripe refunds on retried admin calls after transient persistence failures.

## Proof

Control-flow trace: success path → ledger failure → failed audit → retry bypasses replay → second provider call.

## Counterevidence Checked

Failed-audit replay is intentionally skipped for in-progress detection. No compensating provider refund lookup by idempotency key before create.

## Suggested Next Step

Replay failed audits when provider refund id is already recorded in audit metadata, or pass admin idempotency key to Stripe `refunds.create`.

## Agent Handoff

After working this report, preserve the original finding body. Update line 2 `DEVANA-STATE: ...` and the final `DEVANA-SUMMARY:` status/priority/confidence prefix. Use one of: `open`, `fixed`, `invalid`, `stale`, `duplicate`, `wontfix`. Keep `DEVANA-KEY:` stable unless the same finding moved. Add dated notes below with evidence checked.

## Status Notes

- 2026-06-29: open by Devana. Initial report written from static source inspection.

DEVANA-KEY: src/api/backend.ts:2596 | refund-ledger-failure-double
DEVANA-SUMMARY: open | P1 | high | After provider refund succeeds but ledger.put fails, idempotency retry issues a second Stripe refund.