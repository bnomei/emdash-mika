DEVANA-FINDING: v1
DEVANA-STATE: open | P1 | high | security=no
DEVANA-KEY: src/api/backend.ts:1708-1716 | provider-sync-failed-as-success

# provider.syncCatalog marks audit completed when adapter returns failed

## Finding

`providerSync` passes the provider adapter return value through `runAdminProviderAction` without inspecting `status`. Adapters can return `{ status: "failed" }` or `{ status: "unsupported" }` without throwing, and `runAdminAction` still completes the audit and returns `ok: true`.

## Violated Invariant Or Contract

Admin provider actions must not record audit success when the provider adapter reports a failed or unsupported result.

## Oracle

Same swallow pattern as already-reported `order.refund` and `subscription` actions. `providerSync` action callback is a direct provider call with no status check (`backend.ts:1708-1716`). `runAdminAction` completes audit on any non-throwing return (`backend.ts:2462-2470`). Stripe `unsupportedAction` returns `{ status: "unsupported" }` without throw.

## Counterexample

1. Host calls `admin.providerSync` against a provider whose `syncCatalog` returns `{ status: "failed", message: "rate limited" }`.
2. `runAdminAction` writes audit `completed` and responds `ok: true`.
3. Operator sees a successful admin action while catalog sync did not run.

## Why It Might Matter

Catalog drift goes undetected, and automated admin runners may treat failed syncs as success.

## Proof

**Caller/callee mismatch:** provider adapter non-throwing `failed` → `runAdminAction` success envelope + completed audit.

## Counterevidence Checked

Thrown errors correctly fail the audit. UI DTO adapter may surface `data.status`, but API contract and audit trail still report success — same class as `admin-refund-ignores-provider-failure`, distinct operation surface.

## Suggested Next Step

Inspect provider `AdminActionResultDTO.status` in `runAdminProviderAction` and fail the audit when status is not `completed`.

## Agent Handoff

After working this report, preserve the original finding body. Update line 2 `DEVANA-STATE: ...` and the final `DEVANA-SUMMARY:` status/priority/confidence prefix. Use one of: `open`, `fixed`, `invalid`, `stale`, `duplicate`, `wontfix`. Keep `DEVANA-KEY:` stable unless the same finding moved. Add dated notes below with evidence checked.

## Status Notes

- 2026-06-27: open by Devana. Initial report written from static source inspection.

DEVANA-KEY: src/api/backend.ts:1708-1716 | provider-sync-failed-as-success
DEVANA-SUMMARY: open | P1 | high | provider.syncCatalog returns ok:true and completes audit when the provider adapter returns failed or unsupported without throwing.