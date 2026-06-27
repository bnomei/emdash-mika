DEVANA-FINDING: v1
DEVANA-STATE: duplicate | P1 | high | security=no
DEVANA-KEY: src/plugin.ts:103 | maintenance-cron-skips-three-tasks

# Mika maintenance cron only releases stock; email outbox, ephemeral purge, and account-delete never run

## Finding

The plugin's `mika_maintenance` cron handler constructs the maintenance runner with only `{ api }`:

```ts
// src/plugin.ts:103
const result = await createMikaMaintenanceRunner({ api }).runOnce({ ... });
```

`createMikaMaintenanceRunner` (`src/api/maintenance.ts:94-167`) gates three of its four tasks on inputs that are not supplied here:

- `emailOutbox` requires `input.emailOutboxRunner` (`maintenance.ts:101`) → else `status:"skipped"`.
- `ephemeralRecords` requires `input.repositories` (`maintenance.ts:134-138`) → else `skipped`.
- `accountDeleteRequests` requires `input.repositories` (`maintenance.ts:152-157`) → else `skipped`.

Only `stockReservations` runs, because it has an `api`-based fallback (`createApiStockReservationRelease(input.api)`, `maintenance.ts:116-118`). The plugin exposes no seam to inject `emailOutboxRunner`/`repositories` into this cron (the plugin takes `{ api, operationPolicy, maintenance }` only), and `MikaApi.admin` has no method to drain the outbox or process account-deletes. So under the plugin's own scheduler these three tasks are skipped on every tick, permanently.

## Violated Invariant Or Contract

The documented contract for the built-in cron task. `src/templates/astro/examples/backend-provider.md:156-158`:

> Mika registers the `mika_maintenance` cron task by default. The task drains the email outbox, releases expired stock reservations, purges expired ephemeral rows, and processes queued account-delete requests.

The shipped handler drains neither the outbox, nor ephemeral rows, nor account-delete requests.

## Oracle

- Documentation oracle: `backend-provider.md:156-158` and `release-slice.md:23-24` ("Maintenance runner coverage for email outbox delivery, expired stock reservations, expired ephemeral rows, and queued account-delete requests").
- Intent oracle: `summarizeMikaMaintenanceResult` / `logMikaMaintenanceResult` (`plugin.ts:133-162`) report all four task summaries, implying all four are expected to run.
- Test oracle: `test/backend.test.ts:691-694` shows the intended full wiring, passing `emailOutboxRunner` (and elsewhere `repositories`) into the runner.

## Counterexample

1. A user calls `magicLink.request`. The backend enqueues an `EmailDocument` with `status:"queued"`, `kind:"magic_link"`. Delivery happens only via `MikaEmailOutboxRunner.runOnce` → `deliverLeasedEmail` (`email-outbox.ts`).
2. Host fires the `cron` event with `name === "mika_maintenance"` (`plugin.ts:100-101`).
3. Handler runs `createMikaMaintenanceRunner({ api }).runOnce(...)`; the email task hits its guard and returns `skipped`. The magic-link email is never sent → the user can never log in.
4. Same trail for `account.delete`: `requestAccountDelete` only enqueues a `status:"queued"` request; the actual deletion (token deletion, reservation release, email redaction, completion) lives only in `processQueuedAccountDeleteRequests` (`maintenance.ts:180-252`), which is skipped → erasure requests are acknowledged (HTTP 202) but PII/tokens are never redacted. Expired ephemeral rows likewise accumulate forever.

## Why It Might Matter

Default deployments that rely on the plugin's own `mika_maintenance` cron silently lose: magic-link/account login email delivery, order-confirmation email delivery, GDPR/erasure execution, and ephemeral-record cleanup. The maintenance summary still logs "completed" (with three tasks marked `skipped`), so the failure is easy to miss.

## Proof

Static dataflow / contract mismatch: single production call site of `createMikaMaintenanceRunner` (`plugin.ts:103`, confirmed sole non-test usage) passes an input object missing the two fields three of four tasks hard-require; each task's guard provably returns `skipped`. Documented behavior (all four tasks) contradicts code (one task).

## Counterevidence Checked

- Could a host run its own `createMikaEmailOutboxRunner` + full `createMikaMaintenanceRunner({ api, emailOutboxRunner, repositories })` outside the plugin? Yes — both are re-exported from `src/server.ts:55,70`. But the plugin itself registers and owns the only handler for the `mika_maintenance` cron task, documents that task as doing all four, and provides no parameter to enrich it. The docs tell hosts to configure only the schedule (`backend-provider.md:160-169`), not to re-implement delivery. So any host following the documented path loses three tasks.
- Is `repositories` derivable from `api` inside the runner? No — the runner only derives stock release from `api`; there is no `api` method for outbox drain or account-delete processing.

## Suggested Next Step

Either wire `emailOutboxRunner` and `repositories` into the cron's `createMikaMaintenanceRunner(...)` call (deriving them the same way the backend api is built), or change the docs/log to state the built-in cron only releases stock and require hosts to run the full maintenance runner themselves.

## Agent Handoff

After working this report, preserve the original finding body. Update line 2 `DEVANA-STATE:` and the final `DEVANA-SUMMARY:` prefix. Keep `DEVANA-KEY:` stable unless the finding moved.

## Status Notes

- 2026-06-27: open by Devana. Verified plugin.ts:103 passes only `{ api }`; maintenance.ts guards confirmed; documentation oracle in backend-provider.md:156-158.
- 2026-06-27: marked duplicate. A concurrent Devana run wrote the canonical report `20260627T143838Z-P1-plugin-cron-skips-outbox.md` (DEVANA-KEY src/plugin.ts:103-105) for the same finding before this one landed. Track the fix there.

DEVANA-KEY: src/plugin.ts:103 | maintenance-cron-skips-three-tasks
DEVANA-SUMMARY: duplicate | P1 | high | Built-in mika_maintenance cron only releases stock; email outbox, ephemeral purge, and account-delete tasks are silently skipped, breaking magic-link login and GDPR erasure.
