DEVANA-FINDING: v1
DEVANA-STATE: fixed | P1 | high | security=no
DEVANA-KEY: src/api/backend.ts:3991 | webhook-lease-loss-acks-success

# Payment webhook lease loss returns HTTP 200 without fulfillment

## Finding

When payment webhook workflow processing hits `WorkflowRunnerLeaseLostError` or cannot acquire a workflow lease (`startPaymentWebhookWorkflow` returns null), `processStoredWebhook` returns the unchanged webhook document. `receiveWebhook` still responds with `ok: true` and HTTP 200. No in-package maintenance sweeper resumes stuck `received` webhooks; recovery depends on provider redelivery or admin replay.

## Violated Invariant Or Contract

A paid provider webhook should not be acknowledged as successfully received until order fulfillment reaches a terminal processed state, or the failure should surface as a retryable error to the provider.

## Oracle

Tests document intentional no-op when another worker holds an active lease, and recovery on provider redelivery after lease expiry. `createMikaMaintenanceRunner` has no workflow resumption task.

## Counterexample

1. Paid Stripe webhook stored with `status: "received"`.
2. Worker A starts workflow; lease expires mid-step or `tryLeaseWorkflow` returns null under contention.
3. `processStoredWebhook` catch returns original webhook (~3991–3992) or `runPaymentWebhookWorkflow` returns early (~4146–4147).
4. `receiveWebhook` returns `{ ok: true, status: 200, data: { status: "received" } }`.
5. Ledger has no new order until provider redelivers.

## Why It Might Matter

Silent payment processing gaps; orders missing until manual intervention if provider does not retry.

## Proof

**Control-flow trace:** `receiveWebhook` → `processStoredWebhook` → lease loss / no lease → unchanged `received` webhook → `ok: true` 200 response.

Locations: `src/api/backend.ts` (`receiveWebhook` ~3442–3451, `processStoredWebhook` ~3989–3992, `runPaymentWebhookWorkflow` ~4146–4147), `src/api/maintenance.ts` (no workflow sweep).

## Counterevidence Checked

Duplicate webhooks with `status: "received"` are reprocessed on redelivery (~3401–3420). `webhookReplay` admin action exists. Lease acquisition is atomic in `OpsRepository.tryLeaseWorkflow`.

## Suggested Next Step

Return non-2xx or explicit failure status on lease loss so providers retry; add workflow resumption to maintenance.

## Agent Handoff

After working this report, preserve the original finding body. Update line 2 `DEVANA-STATE: ...` and the final `DEVANA-SUMMARY:` status/priority/confidence prefix.

## Status Notes

- 2026-06-29: open by Devana. Initial report written from static source inspection across contracts-errors and state-lifecycle trails.
- 2026-06-29: fixed. `receiveWebhook` no longer acknowledges a paid payment webhook with HTTP 200 when workflow lease loss left it unprocessed. Both response sites (fresh receipt and duplicate reprocessing) now route through a new `webhookReceiptResult(webhook, event)` helper: when `event.kind === "payment" && event.paymentStatus === "paid"` but the stored webhook is still `received` — the precise signature of the two lease-loss exits, `runPaymentWebhookWorkflow` returning the webhook unchanged when no lease can be acquired (~4179) and the `WorkflowRunnerLeaseLostError` catch (~4024) — it returns a retryable `409 CONFLICT` (`webhookProcessingDeferred`) instead. The provider redelivers; a later delivery after the lease frees or expires reprocesses the still-`received` webhook and fulfills idempotently. This implements the report's first suggested approach (surface a retryable error so providers retry) and satisfies the invariant's escape clause. The guard reads the *document* status, not the coarse DTO status field (which maps everything non-`failed` to "received"), so a late terminal order that is marked `processed` still returns 200 and is not falsely flagged retryable. Non-payment (`subscription`/`unknown`) and non-paid events are untouched, so we never ask the provider to retry an event we intentionally ignore. Scope: the HTTP acknowledgement only. Deliberately NOT added here: a maintenance sweeper that resumes stuck `received` webhooks without provider redelivery (the report's second suggestion) — that is a separate, larger feature (new `createMikaMaintenanceRunner` task) and is unnecessary for the contract fix since the retryable response already drives provider-side recovery. Evidence: the lease-contention test now asserts a 409 retryable response with no side effects (ledger empty, workflow lease untouched, admin replay still a no-op while held); the stuck-recovery test asserts first delivery returns 409 and a redelivery after lease expiry fulfills (ledger 1, webhook `processed`). Full suite (352) and both tsc configs pass.

DEVANA-KEY: src/api/backend.ts:3991 | webhook-lease-loss-acks-success
DEVANA-SUMMARY: fixed | P1 | high | receiveWebhook now returns a retryable 409 (not HTTP 200) when a paid payment webhook is left `received` by workflow lease loss, so the provider redelivers and fulfillment completes idempotently instead of silently never happening.