DEVANA-FINDING: v1
DEVANA-STATE: fixed | P3 | medium | security=no
DEVANA-KEY: src/api/backend.ts:5107 | duplicate-fulfillment-notifications-lease-expiry

# `license.issued` / `download.ready` notifications can double-fire on workflow lease expiry because they have no idempotency guard

## Finding

The payment-fulfillment workflow runs `fulfillPaidOrder` inside a single leased step. `WorkflowRunner.runStep` brackets the step `fn()` with lease checks at `startWorkflowStep` and `completeWorkflowStep` only — it never revalidates the lease **during** `fn()` (`src/api/backend.ts:4220-4257`). Meanwhile `listDueWorkflows` deliberately re-leases workflows whose lease has expired (`status="running"` AND `leaseExpiresAt <= now`, `src/storage/repositories.ts:994-998, 1440-1451`), and a duplicate payment webhook in `received`/`failed` status re-enters `processStoredWebhook` (`src/api/backend.ts:3401-3411`).

Inside `fulfillPaidOrderLine`, the license and download notifications are emitted with a non-atomic check-then-act and **no idempotency key**:

- license: `findLicenseById` → `put` → `emitBackendNotification("license.issued", ...)` (`src/api/backend.ts:5102-5118`).
- download: `emitOrderDownloadReadyNotifications` → `emitBackendNotification("download.ready", ...)` (`src/api/backend.ts:5067, 5373-5397`).
- `emitBackendNotification` calls the host hook directly with no dedup/idempotency/persistence (`src/api/backend.ts:2668-2679`).

By contrast, the order-confirmation **email** is protected by `acquireNotificationMarker` (a marker workflow + `findEmail` short-circuit, `src/api/backend.ts:5243-5266, 5416-5484`). The license/download notifications have no equivalent guard.

## Violated Invariant Or Contract

A leased fulfillment step must produce its customer-facing side effects at-most-once per order line; lease holding must gate the actual work, not just the bookkeeping. `license.issued` and `download.ready` must fire exactly once per line.

## Oracle

The asymmetry within the same fulfillment path: the order-confirmation email is explicitly deduped via a notification marker, demonstrating the intended exactly-once contract that the `license.issued`/`download.ready` emissions do not meet.

## Counterexample

1. T0: payment webhook delivered. Worker A leases the workflow (`leaseExpiresAt = T0+300_000`, `src/api/backend.ts:4395`) and enters the single `fulfill_order` step, which loops all lines doing `consume` + `put` + `emitBackendNotification` + an awaited `input.hash(...)` per license + the awaited host notification hook.
2. A stalls (slow/hanging host hook or DB contention) and is still inside `fulfillPaidOrder` at T0+300s; its lease has expired, but `runStep` does not revalidate the lease around `fn()`.
3. T0+301s: the provider re-delivers the same webhook (at-least-once), or a `listDueWorkflows` sweep runs. `workflowIsDueForLease` now returns true (`leaseExpiresAt <= now`), so worker B acquires the lease.
4. B re-runs `fulfillPaidOrderLine`; for a license line `findLicenseById` returns null (or the doc exists but the notification is unguarded) → `put` + `emitBackendNotification("license.issued")`. A then resumes and emits the same notification for the same line.
5. Result: two `license.issued` and two `download.ready` notifications fire to the host hook, which has no dedup — e.g. duplicate license-delivery emails. A keeps committing side effects on the dead lease until it finally hits `completeWorkflowStep`, which throws `WorkflowRunnerLeaseLostError` — too late.

## Why It Might Matter

Duplicate customer-facing fulfillment notifications (license keys, download-ready emails). The license/entitlement **documents** dedup via deterministic id (last-write-wins), but the unguarded host notifications do not.

## Proof

State-transition / interleaving: the lease guard is structurally bypassed because `runStep` performs no lease check during `fn()` (`src/api/backend.ts:4220-4257`), the re-lease path is an intended mechanism (`src/storage/repositories.ts:994-998, 1440-1451`), and the notification emissions carry no idempotency key (`src/api/backend.ts:2668-2679, 5107, 5388`).

## Counterevidence Checked

- `tryLeaseWorkflow` is a correct compare-and-set and blocks a second worker while the lease is valid (even `force=true` respects an unexpired lease) — so the bug requires lease **expiry**, which is exactly the in-scope scenario.
- Deterministic ids prevent duplicate license/entitlement **records**, and the order-confirmation **email** is marker-protected — but neither covers `license.issued`/`download.ready` notifications.
- Strongest false-positive reason: requires a worker to stall > 300s inside one step while a duplicate delivery or `listDueWorkflows` sweep arrives. The 300s lease is generous, lowering (not eliminating) likelihood — hence P3. A hanging host notification hook makes a > 300s stall realistic.

## Suggested Next Step

Give `license.issued` and `download.ready` the same exactly-once protection as the confirmation email (notification markers / idempotency keys), and/or revalidate the lease before each side-effecting emission inside `fulfillPaidOrderLine`.

## Agent Handoff

After working this report, preserve the original finding body. Update line 2 `DEVANA-STATE:` and the final `DEVANA-SUMMARY:` prefix. Keep `DEVANA-KEY:` stable unless the same finding moved.

## Status Notes

- 2026-06-29: open by Devana. Static interleaving analysis; lease-bracket gap (`src/api/backend.ts:4220-4257`), re-lease selection (`src/storage/repositories.ts:994-998`), and unguarded emissions (`src/api/backend.ts:5107, 5388, 2668`) verified.
- 2026-06-30: fixed (chosen approach = the report's primary Suggested Next Step: give `license.issued`/`download.ready` the same exactly-once protection the confirmation email already has). Root cause confirmed: both notifications were emitted with a bare `emitBackendNotification` (host hook, no idempotency/persistence), while the order-confirmation email is gated by `acquireNotificationMarker`. The license emission lived inside `if (!existing)` and the download emission inside the `addedRefs` diff — both dedup SEQUENTIAL re-runs but not the CONCURRENT re-lease case (two workers both observe the line not-yet-persisted before either writes, then both emit). Fix: a shared helper `emitFulfillmentNotificationOnce(input, ctx, marker, context)` that mirrors `queueOrderConfirmationEmail` exactly — `acquireNotificationMarker` → if not `"acquired"` return → `emitBackendNotification` → `runner.complete` (on throw `runner.fail` + rethrow). Applied at both sites: `license.issued` with marker id `fulfillmentDocumentId("workflow", order.id, line.id, "notification_license_issued")` / key `license.issued:${order.id}:${line.id}` (and moved OUT of `if (!existing)` so the MARKER, not the document-existence check, is the dedup authority — the license document keeps its own deterministic-id dedup), and `download.ready` with marker id `fulfillmentDocumentId("workflow", downloadRef, "notification_download_ready")` / key `download.ready:${downloadRef}`. Now the first worker acquires the marker, emits, and completes it; a re-leased worker re-entering `fulfillPaidOrderLine` gets `acquireNotificationMarker` → `"completed"` (or `"active"` if the first is still mid-flight) and skips — so each fires at most once per line/ref. Guarantee parity with the email: a crash between emit and `complete` leaves the marker leased, so after the lease TTL a retry may re-emit — identical at-least-once-with-a-window behavior to the existing email marker (an acceptable, much-narrower window than the unbounded duplication before). No fulfillment regression: the existing "creates fulfillment side effects once from replayed payment webhook events" test (entitlement+license+download lines) still passes — the markers add `notification.*` workflow documents to the ops store but no test asserts a conflicting workflow count. Evidence: a new test (`test/backend.test.ts`) drives a paid order with a license line and a download line to fulfillment and asserts `license.issued` fired exactly once AND that the `notification.license.issued` marker workflow now exists `status:"completed"` with `idempotencyKey:"license.issued:order_1:order_line_1"` — i.e. the emission is routed through the exactly-once marker (before the fix it was a bare hook call, so no such workflow document existed). Mutation-verified: with `runner.complete` neutered (cp-backup + restore, no git), the marker workflow is left `"running"` and the test fails (`expected "completed", received "running"`); restored via cp and re-confirmed green. The same test asserts `download.ready` symmetrically — its own per-`downloadRef` marker `notification.download.ready` is `completed` with `idempotencyKey:"download.ready:download:order_1:order_line_2"` (closing a review nit). Full suite (382) and both tsc configs pass.

DEVANA-KEY: src/api/backend.ts:5107 | duplicate-fulfillment-notifications-lease-expiry
DEVANA-SUMMARY: fixed | P3 | medium | license.issued/download.ready now emit through a shared emitFulfillmentNotificationOnce helper that wraps them in acquireNotificationMarker (the same exactly-once guard as the order-confirmation email), so a re-leased fulfillment worker re-entering gets a completed/active marker and skips instead of double-firing the host notification. The license emission is now gated by the marker rather than the document-existence check; download.ready is gated per downloadRef.
