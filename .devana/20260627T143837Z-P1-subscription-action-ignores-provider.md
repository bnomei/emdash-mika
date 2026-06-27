DEVANA-FINDING: v1
DEVANA-STATE: open | P1 | high | security=no
DEVANA-KEY: src/api/backend.ts:1582-1587 | subscription-action-ignores-provider

# Subscription actions ignore non-throwing provider failures

## Finding

`runSubscriptionAction` awaits the provider method but discards its return value, then always runs `updateSubscriptionAfterAction` and returns `ok: true`. Stripe and other adapters can return `{ status: "failed" }` or `{ status: "unsupported" }` without throwing, leaving local subscription state updated as if the provider succeeded.

## Violated Invariant Or Contract

Local subscription documents must change only when the provider adapter reports a successful subscription mutation.

## Oracle

Provider admin methods return `AdminActionResultDTO` with `completed` | `failed` | `unsupported` without always throwing; `runSubscriptionAction` callback never inspects provider result (1582-1587). Tests cover thrown errors, not failed return status.

## Counterexample

1. Active subscription missing `providerSubscriptionId`.
2. User calls `subscription.cancel`.
3. Stripe adapter returns `unsupportedAction` (no throw).
4. `updateSubscriptionAfterAction` still writes cancelled/`cancel_at_period_end` locally; API returns success with updated account DTO.

## Why It Might Matter

Account UI and entitlements diverge from billing provider; cancelled subscriptions still bill or vice versa.

## Proof

**Caller/callee mismatch:** Provider returns `failed`/`unsupported` → callee ignores → `updateSubscriptionAfterAction` + `ok: true`.

## Counterevidence Checked

Thrown errors route through `runAdminProviderAction` catch. Distinct code path from `admin-refund-ignores-provider-failure` (order refund at 1757-1766) but same failure mode class.

## Suggested Next Step

Check provider return `status` before `updateSubscriptionAfterAction`; return provider failure to caller when status is not `completed`.

## Agent Handoff

After working this report, preserve the original finding body. Update line 2 `DEVANA-STATE: ...` and the final `DEVANA-SUMMARY:` status/priority/confidence prefix. Use one of: `open`, `fixed`, `invalid`, `stale`, `duplicate`, `wontfix`. Keep `DEVANA-KEY:` stable unless the same finding moved. Add dated notes below with evidence checked.

## Status Notes

- 2026-06-27: open by Devana. Initial report written from static source inspection.

DEVANA-KEY: src/api/backend.ts:1582-1587 | subscription-action-ignores-provider
DEVANA-SUMMARY: open | P1 | high | runSubscriptionAction ignores provider failed/unsupported returns and still updates local subscription state with ok:true.