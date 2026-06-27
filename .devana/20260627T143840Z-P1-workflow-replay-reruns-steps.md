DEVANA-FINDING: v1
DEVANA-STATE: invalid | P1 | high | security=no
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
- 2026-06-27: invalid. The observation (runStep always invokes `fn()`, even for `completed` steps) is factually correct, but the stated invariant — "completed workflow steps must not re-run side effects; the step ledger should gate callback execution" — is NOT this workflow's design contract, and the suggested fix breaks correctness.
  - Re-running steps on replay is intentional and required. Steps re-evaluate external state that changes between runs: e.g. `link_checkout`/`persist_order` fail when the checkout is missing and must re-run after it is restored. The regression test `replays failed payment webhooks after missing checkout state is restored` proves this — it relies on `link_checkout` returning `null` on the first run and a real checkout on replay. I prototyped the report's exact fix (skip `fn()` for completed steps, returning a cached step-result snapshot); it broke that test (and `reprocesses a failed payment webhook on provider retry`) because `link_checkout`/`mark_webhook` are reused across branches and the cached `null`/failed snapshot reproduced the original failure forever. Reverted.
  - The real concern (duplicate side effects on re-run) is already addressed by per-side-effect idempotency, which is the actual design contract: `persist_order` finds the existing order first (unique-indexed) then updates; `complete_checkout` overwrites checkout→completed / cart→converted (terminal, no incremental effect, no notification); `fulfill_order`→`fulfillPaidOrderLine` is fully idempotent (deterministic entitlement/license ids with find-existing, download-ref dedup, idempotent stock `consume`); `queueOrderConfirmationEmail` guards with a notification marker (`order.confirmed:${orderId}`) plus a deterministic `defaultEmailId` existence check; `mark_webhook` sets the webhook to a terminal status. No harmful non-idempotent effect was found. `markWebhookProcessed` attempt-count bumps are benign counters.
  - Conclusion: short-circuiting completed steps would break replay recovery; the existing idempotent side effects already provide at-most-once semantics across replays. No code change. Typecheck + 321 tests pass on the reverted (unchanged) tree.

DEVANA-KEY: src/api/backend.ts:4044-4065 | workflow-replay-reruns-steps
DEVANA-SUMMARY: invalid | P1 | high | runStep re-runs completed steps by design — replay re-evaluates external state (proven by the checkout-restore replay test) and every step side effect is already idempotent (find-existing orders, notification marker + deterministic email/entitlement/license ids, idempotent stock consume). The proposed skip-completed-steps fix breaks replay recovery; no change made.