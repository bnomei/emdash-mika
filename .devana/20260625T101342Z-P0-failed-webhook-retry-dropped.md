DEVANA-FINDING: v1
Priority: P0 | Confidence: high | Security-sensitive: no | Status: open
Location: src/api/backend.ts:3253-3259 | Slug: failed-webhook-retry-dropped

# Failed payment webhook retries are deduped without reprocessing

## Finding

`receiveWebhook` treats any existing webhook row matching `providerEventId` as a duplicate and returns immediately via `webhookDuplicateResult`. When the stored webhook is `failed`, provider retries with the same event id are not reprocessed — only marked `replayable` in the response.

## Violated Invariant Or Contract

At-least-once webhook delivery must eventually drive fulfillment when a prior attempt failed. Duplicate delivery of the same `providerEventId` must re-enter processing for failed webhooks.

## Oracle

After a failed first delivery, a provider retry with the same `providerEventId` must reach `webhook.status === "processed"` and fulfill the paid order without requiring manual admin replay.

## Counterexample

1. Payment webhook stored; `processStoredWebhook` fails → `webhook.status === "failed"`.
2. Provider retries same `providerEventId`.
3. `findWebhookDuplicate` returns the failed row (810–815, keyed only on `provider` + `providerEventId`).
4. Handler returns `{ status: "duplicate", replayable: true }` (5396–5405) without calling `processStoredWebhook` or `replayWebhook`.

## Why It Might Matter

Paid orders may never fulfill after transient processing failures unless an operator manually replays webhooks. Providers that stop retrying after HTTP 200 will leave commerce state permanently inconsistent.

## Proof

**Control-flow trace:** `receiveWebhook` duplicate branch → `webhookDuplicateResult` → early return. `replayWebhook` exists for admin replay but is not invoked on provider retry.

## Counterevidence Checked

`replayWebhook` can reprocess failed webhooks manually. Race-path catch re-queries with the same duplicate helper. `payloadHash` is passed but ignored when `providerEventId` matches (804–816).

## Suggested Next Step

On duplicate match where stored webhook is `failed` or `received` with incomplete workflow, automatically invoke `processStoredWebhook` / `replayWebhook` instead of returning duplicate-only.

## Agent Handoff

After working this report, preserve the original finding body. Update line 2 `Status: ...` and the final `DEVANA-SUMMARY:` status.

## Status Notes

- 2026-06-25: open by Devana. Initial report written from static source inspection.

DEVANA-KEY: src/api/backend.ts:3253-3259 | P0 | failed-webhook-retry-dropped
DEVANA-SUMMARY: Status=open | P0 high src/api/backend.ts:3253-3259 - Provider retries of failed payment webhooks are deduped and dropped, so orders may never fulfill without manual replay.