DEVANA-FINDING: v1
DEVANA-STATE: open | P1 | high | security=no
DEVANA-KEY: src/api/backend.ts:4044-4065 | workflow-replay-reruns-steps

# Payment webhook workflow replay re-executes completed step callbacks

## Finding

`WorkflowRunner.runStep` always invokes the step callback after `startWorkflowStep`, even when the step metadata is already `completed`. `startWorkflowStep` leaves completed steps unchanged but does not skip `fn()`. Webhook replay therefore re-runs persist, checkout completion, and fulfillment callbacks, relying on partial idempotency rather than step ledger short-circuit.

## Violated Invariant Or Contract

Completed workflow steps must not re-run side effects on replay; the step ledger should gate callback execution.

## Oracle

`startWorkflowStep` maps completed steps unchanged (repositories.ts:990-991); `runStep` unconditionally `await fn()` (4044-4055). Payment workflow chains `persist_order`, `complete_checkout`, `fulfill_order`, `mark_webhook` (3887-3958).

## Counterexample

1. Payment webhook workflow completes `fulfill_order` then `mark_webhook` fails → workflow `failed`.
2. Admin `webhookReplay` re-enters `processPaymentWebhook`.
3. Each `runWorkflowStep` calls `fn()` again for all steps including already-completed ones.
4. Side effects such as `queueOrderConfirmationEmail`, ledger writes, and `markWebhookProcessed` attempt count bumps run again unless individually idempotent.

## Why It Might Matter

Duplicate notifications, spurious ledger writes, and harder-to-reason replay behavior; compounds `failed-webhook-retry-dropped` when replays are the recovery path.

## Proof

**Control-flow trace:** `webhookReplay` → `runPaymentWebhookWorkflow` → `runStep` → `startWorkflowStep` (no skip) → `fn()` for completed steps.

## Counterevidence Checked

Some handlers are partially idempotent (`findEntitlementById`, consumed reservation replay, existing default email check). `complete_checkout` and notification marker paths are not fully idempotent under all lease states. Distinct mechanism from dedupe-at-ingress bug.

## Suggested Next Step

Skip `fn()` when step status is already `completed`, or return cached step result from workflow metadata on replay.

## Agent Handoff

After working this report, preserve the original finding body. Update line 2 `DEVANA-STATE: ...` and the final `DEVANA-SUMMARY:` status/priority/confidence prefix. Use one of: `open`, `fixed`, `invalid`, `stale`, `duplicate`, `wontfix`. Keep `DEVANA-KEY:` stable unless the same finding moved. Add dated notes below with evidence checked.

## Status Notes

- 2026-06-27: open by Devana. Initial report written from static source inspection.

DEVANA-KEY: src/api/backend.ts:4044-4065 | workflow-replay-reruns-steps
DEVANA-SUMMARY: open | P1 | high | Webhook workflow replay always runs step callbacks even when the step ledger already marks them completed.