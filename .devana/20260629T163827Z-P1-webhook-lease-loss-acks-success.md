DEVANA-FINDING: v1
DEVANA-STATE: open | P1 | high | security=no
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

DEVANA-KEY: src/api/backend.ts:3991 | webhook-lease-loss-acks-success
DEVANA-SUMMARY: open | P1 | high | Paid webhooks can return HTTP 200 while workflow lease loss leaves them unfulfilled until provider redelivery.