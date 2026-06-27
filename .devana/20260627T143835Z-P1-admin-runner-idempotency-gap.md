DEVANA-FINDING: v1
DEVANA-STATE: fixed | P1 | high | security=no
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
- 2026-06-27: fixed. Confirmed `adminRunnerInputWithContext` forwarded the runner-enforced idempotency key only to `admin.stockAdjust`, so refund/cancel/entitlement/license/download/email retries re-ran their side effects. Fix is a central idempotency gate plus generalized forwarding:
  - Route handler now forwards the invocation idempotency key to every admin write that consumes it (`ADMIN_IDEMPOTENT_OPERATIONS`: stockAdjust, orderRefund, orderCancel, entitlementGrant, entitlementRevoke, emailResend, licenseRevoke, downloadIssue), kept in sync with the `idempotencyKey` fields added to those input schemas/types.
  - `runAdminAction` (shared by `runAdminProviderAction`/`runAdminRepositoryAction`) now dedupes by `(action, idempotencyKey)` via the admin audit store: a prior `completed` audit replays its stored result without re-running; a prior `started` audit returns 409 (in progress) so a concurrent/crashed attempt cannot double-execute; a `failed` audit allows retry. The result snapshot is persisted on completion in the audit metadata (`result`), and the audit document now projects/indexes `idempotencyKey` (new `findAdminAuditByIdempotencyKey` repo finder). No migration needed — `idempotencyKey` is already an indexed `ops` field and documents use the host store.
  - Each backend admin-write threads its input `idempotencyKey` into the audit record. Webhook replay was left as-is (already idempotent at the webhook layer by providerEventId/payloadHash); provider sync/health are unaffected (own run-lease/no side effect).
  - Regression test `deduplicates a retried order refund by idempotency key without refunding twice` (two refunds, same key → `refundPayment` called once, only one audit). Updated the download-issue runner test to expect the now-forwarded key. Typecheck + 317 tests pass.

DEVANA-KEY: src/api/route-handlers.ts:107-119 | admin-runner-idempotency-gap
DEVANA-SUMMARY: fixed | P1 | high | Admin runner only forwarded idempotency keys to stockAdjust. Fixed by forwarding to all idempotent admin writes and adding a central (action, idempotencyKey) dedup in runAdminAction that replays the prior result instead of repeating the side effect, with a refund regression test.