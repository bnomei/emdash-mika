DEVANA-FINDING: v1
Priority: P1 | Confidence: high | Security-sensitive: no | Status: open
Location: src/api/backend.ts:3970-3971 | Slug: payment-webhook-lease-noop

# Payment webhook workflow lease miss leaves webhook stuck in received

## Finding

`runPaymentWebhookWorkflow` returns the original webhook unchanged when `startPaymentWebhookWorkflow` cannot acquire a lease (`leasedWorkflow` is null). The webhook stays `received` while the API may have already returned HTTP 200 to the provider. No background workflow runner picks up the stuck webhook.

## Violated Invariant Or Contract

A received payment webhook must either process fulfillment or transition to a retriable/failed state. Lease failure must not be a silent no-op with success response to the provider.

## Oracle

`processPaymentWebhook` must not return without status update while webhook remains `received` and provider got 200.

## Counterexample

1. Payment webhook accepted and stored as `received`.
2. `tryLeaseWorkflow` returns null (workflow already `running` with valid lease, or `nextAttemptAt` in future).
3. `if (!leasedWorkflow) return webhook` (3971) — no status update.
4. Provider treats 200 as success and stops retrying.

## Why It Might Matter

Paid orders may never fulfill when concurrent webhook delivery or overlapping processing prevents lease acquisition. Maintenance cron does not list due workflows for automatic retry.

## Proof

**Control-flow trace:** Lease miss → early return → webhook unchanged. `WorkflowRunnerLeaseLostError` similarly returns webhook at 3825 without failure marking.

## Counterevidence Checked

Admin `replayWebhook` can process when lease frees. Step failures that throw non-lease errors reach `markWebhookFailed`. No maintenance workflow runner in `plugin.ts` / `maintenance.ts`.

## Suggested Next Step

On lease miss, schedule retry via `nextAttemptAt`, mark failed for provider retry, or enqueue background workflow processing.

## Agent Handoff

After working this report, preserve the original finding body. Update line 2 `Status: ...` and the final `DEVANA-SUMMARY:` status.

## Status Notes

- 2026-06-25: open by Devana. Initial report written from static source inspection.

DEVANA-KEY: src/api/backend.ts:3970-3971 | P1 | payment-webhook-lease-noop
DEVANA-SUMMARY: Status=open | P1 high src/api/backend.ts:3970-3971 - Payment webhook workflow silently no-ops on lease miss, leaving webhooks stuck in received with HTTP 200 to provider.