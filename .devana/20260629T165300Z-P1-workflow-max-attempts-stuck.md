DEVANA-FINDING: v1
DEVANA-STATE: fixed | P1 | high | security=no
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
- 2026-06-30: fixed (chosen approach: a maintenance sweep that transitions stuck workflows to `failed`, because the worker that LOST its lease cannot transition the workflow itself). Confirmed the bug: `tryLeaseWorkflow` increments `attemptCount` on EVERY lease acquisition (`src/storage/repositories.ts:1051`); when a workflow repeatedly loses its lease mid-step — the lease expires while a slow step runs (or the worker crashes), the next repository op fails its `requireLease` check → `WorkflowRunnerLeaseLostError`, and `runPaymentWebhookWorkflow` correctly RETHROWS without `runner.fail()` (`backend.ts`, the `error instanceof WorkflowRunnerLeaseLostError` branch) because it no longer owns the lease — the sweep re-leases the expired-`running` workflow each cycle, bumping `attemptCount`. Once `attemptCount >= maxAttempts`, `workflowIsDueForLease` returns false (`repositories.ts:1471`), so it is never re-leased and stays `running` with an expired lease FOREVER: the paid webhook is unprocessed with no automatic recovery (only manual admin `webhookReplay`, which force-leases). Calling `runner.fail()` at the lease-loss site is not possible (the `failWorkflow` op also checks the lease key, which the worker has lost), so recovery must come from outside the worker. Fix: a new `OpsRepository.reclaimExhaustedWorkflows(now, limit, kind?)` (`repositories.ts`, beside `tryLeaseWorkflow`) finds workflows that are `running` with an EXPIRED lease AND `attemptCount >= maxAttempts` (the new `workflowIsExhausted` predicate — exactly the set `workflowIsDueForLease` strands) and transitions each to `status: "failed"`, clearing the lease/`nextAttemptAt` and recording a replay-hint `lastError`; the transition re-checks `workflowIsExhausted` under the document write-guard so a concurrent force-lease that revived the workflow wins (no clobber). It is wired as a `stuckWorkflows` task in `createMikaMaintenanceRunner` (`src/api/maintenance.ts`, the scheduled `mika_maintenance` cron), skipped when repositories are absent, with a `MikaMaintenanceStuckWorkflowsResult` ({scanned, reclaimed}) surfaced on `MikaMaintenanceRunResult`. A `failed` workflow is now both OBSERVABLE (operators can see failed workflows instead of a deceptively-`running` one) and RECOVERABLE: admin `webhookReplay` force-leases it (`force` bypasses the `attemptCount` cap, `workflowIsDueForLease:1470`). Deliberately NOT auto-retried (left with `nextAttemptAt` undefined), since exhausted attempts mean a transparent retry would just fail again. Evidence: a new test (`test/backend.test.ts`, "reclaims stuck workflows whose lease expired after exhausting attempts") builds a stuck workflow (`running`, lease expired, `attemptCount === maxAttempts === 5`), first asserts it is genuinely un-leasable (`tryLeaseWorkflow` → null), then `reclaimExhaustedWorkflows` → `{ scanned: 1, reclaimed: 1 }`, asserts it is now `failed` with a cleared `leaseKey` and a `lastError`, AND that a still-actively-leased exhausted workflow is left `running` (untouched). Mutation-verified (neutering `workflowIsExhausted` to `return false` — the predicate is referenced only by the reclaim path — makes the test fail `{ scanned: 0, reclaimed: 0 }`; restored via cp, no git). Full suite (393) and both tsc configs pass. This COMPLEMENTS the sibling fix `165257Z fulfill-partial-persist` (#29): that one persists forward progress so a CLEAN step failure never orphans committed goods; this one recovers a workflow stranded by repeated LEASE LOSS — the two failure modes the webhook workflow can stall on.

DEVANA-KEY: src/storage/repositories.ts:1448 | workflow-max-attempts-stuck
DEVANA-SUMMARY: fixed | P1 | high | A new maintenance sweep (OpsRepository.reclaimExhaustedWorkflows, wired as the stuckWorkflows task in createMikaMaintenanceRunner) transitions workflows that are running with an expired lease AND attemptCount >= maxAttempts to failed (cleared lease + replay-hint lastError), so a webhook workflow stranded by repeated lease loss is no longer stuck running forever. failed is observable and force-leasable via admin webhookReplay; the worker that lost its lease cannot fail the workflow itself (the fail op checks the lease key), so the sweep is the recovery path. The transition re-checks under the write guard so a concurrent force-lease wins.