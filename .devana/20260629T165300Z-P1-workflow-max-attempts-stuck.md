DEVANA-FINDING: v1
DEVANA-STATE: open | P1 | high | security=no
DEVANA-KEY: src/storage/repositories.ts:1448 | workflow-max-attempts-stuck

# Payment workflows can stall permanently after max lease attempts

## Finding

When a payment webhook workflow loses its lease mid-step, `runPaymentWebhookWorkflow` rethrows without calling `runner.fail()`. After `attemptCount` reaches `maxAttempts`, `workflowIsDueForLease` returns false and the workflow is never re-leased, leaving it in `running` with an expired lease and an unprocessed webhook.

## Violated Invariant Or Contract

Failed or exhausted workflows should transition to `failed` (or `queued` for manual replay), not remain `running` indefinitely.

## Oracle

`workflowIsDueForLease` blocks when `attemptCount >= maxAttempts` (`repositories.ts:1448`). Lease-loss path skips `runner.fail()` (`backend.ts:4171-4172`). Distinct from HTTP 200 ack on lease loss (`webhook-lease-loss-acks-success`).

## Counterexample

1. Payment webhook workflow leases and starts `fulfill_order`.
2. Lease expires mid-step → `WorkflowRunnerLeaseLostError`.
3. Handler rethrows; step stays `running`, `attemptCount` increments to 5.
4. `workflowIsDueForLease` returns false for further leases.
5. Webhook remains `received`; order unfulfilled until manual admin replay.

## Why It Might Matter

Paid webhooks can become permanently stuck without automatic recovery after repeated lease loss.

## Proof

State transition trace: `running` + expired lease + `attemptCount >= maxAttempts` → no further lease eligibility → terminal invalid state.

## Counterevidence Checked

`listDueWorkflows` includes expired `running` workflows but filters through `workflowIsDueForLease`. Admin `webhookReplay` can recover manually.

## Suggested Next Step

On lease loss at max attempts, call `runner.fail()` or move workflow to `failed` with replay hint.

## Agent Handoff

After working this report, preserve the original finding body. Update line 2 `DEVANA-STATE: ...` and the final `DEVANA-SUMMARY:` status/priority/confidence prefix. Use one of: `open`, `fixed`, `invalid`, `stale`, `duplicate`, `wontfix`. Keep `DEVANA-KEY:` stable unless the same finding moved. Add dated notes below with evidence checked.

## Status Notes

- 2026-06-29: open by Devana. Initial report written from static source inspection.

DEVANA-KEY: src/storage/repositories.ts:1448 | workflow-max-attempts-stuck
DEVANA-SUMMARY: open | P1 | high | Payment webhook workflows with exhausted lease attempts stay running and are never re-leased automatically.