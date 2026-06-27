DEVANA-FINDING: v1
DEVANA-STATE: open | P1 | high | security=no
DEVANA-KEY: src/api/route-handlers.ts:107-119 | admin-runner-idempotency-gap

# Admin action runner requires idempotency but only forwards it to stock adjust

## Finding

The EmDash admin action runner rejects `adminWrite` invocations without an idempotency key, storing it on `ctx.idempotencyKey`. `adminRunnerInputWithContext` injects that key into the operation input only for `admin.stockAdjust`. Other admin writes (refund, cancel, webhook replay, entitlement grant, etc.) never receive the key and perform duplicate side effects on retry.

## Violated Invariant Or Contract

Operations marked `idempotency: "required"` must consume the idempotency key to make retries safe.

## Oracle

`agentOperationMetadata.adminWrite.idempotency === "required"`; runner 409 without key (route-handlers.ts:82-90); only `admin.stockAdjust` gets key forwarded (107-119).

## Counterexample

1. Admin UI posts `mika.order.refund` with `invocationId: "inv-1"`.
2. Provider refund succeeds; ledger update fails before response.
3. Client retries same `invocationId`.
4. Runner passes idempotency gate again; `refundOrder` has no idempotency lookup → second provider refund attempt and duplicate ledger mutation.

## Why It Might Matter

Duplicate financial admin actions, double refunds/cancels, or repeated webhook replays under flaky networks or UI double-submit.

## Proof

**Cross-entry mismatch:** Runner boundary enforces idempotency presence vs backend sinks that ignore `ctx.idempotencyKey` except stock adjust (`backend.ts` stock path uses `findEventByIdempotencyKey`).

## Counterevidence Checked

`admin-action-runner.ts` may adapt failed provider status for UI; does not dedupe by invocation id. Distinct from `stock-idempotency-replay-after-release` (stock release replay semantics).

## Suggested Next Step

Forward `ctx.idempotencyKey` to all `adminWrite` operations and persist idempotency records before provider calls, matching stock adjust.

## Agent Handoff

After working this report, preserve the original finding body. Update line 2 `DEVANA-STATE: ...` and the final `DEVANA-SUMMARY:` status/priority/confidence prefix. Use one of: `open`, `fixed`, `invalid`, `stale`, `duplicate`, `wontfix`. Keep `DEVANA-KEY:` stable unless the same finding moved. Add dated notes below with evidence checked.

## Status Notes

- 2026-06-27: open by Devana. Initial report written from static source inspection.

DEVANA-KEY: src/api/route-handlers.ts:107-119 | admin-runner-idempotency-gap
DEVANA-SUMMARY: open | P1 | high | Admin runner requires idempotency keys for adminWrite but only stockAdjust receives them, so retries can duplicate refunds and other admin mutations.