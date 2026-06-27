DEVANA-FINDING: v1
DEVANA-STATE: fixed | P1 | high | security=no
DEVANA-KEY: src/plugin.ts:103-105 | plugin-cron-skips-outbox

# Default plugin cron maintenance skips email outbox and account-delete work

## Finding

The shipped `createPlugin` cron hook calls `createMikaMaintenanceRunner({ api })` with only the API handle. Without `emailOutboxRunner` and `repositories`, maintenance skips email delivery, ephemeral purge, and account-delete batch processing while only stock reservation release runs.

## Violated Invariant Or Contract

Scheduled plugin maintenance should run the maintenance tasks the README documents (email outbox, expired reservations, ephemeral purge, account-delete cleanup) when cron is enabled.

## Oracle

`createMikaMaintenanceRunner` returns `skipped` for email outbox (101-103), ephemeral purge (139-143), and account delete (152-156) when dependencies are unset; plugin cron passes only `{ api }` (plugin.ts:103-105).

## Counterexample

1. Host installs default Mika plugin with maintenance cron enabled.
2. Magic-link and order emails sit `queued` with elapsed `nextAttemptAt`.
3. Cron fires → `emailOutbox.status: "skipped"`, `accountDeleteRequests.status: "skipped"`.
4. Only expired stock reservations release runs.

## Why It Might Matter

Queued emails never send, account-delete requests never complete, and expired tokens accumulate in hosts relying on default plugin cron alone.

## Proof

**Control-flow trace:** `plugin cron` → `createMikaMaintenanceRunner({ api })` → conditional skips → only `releaseExpiredReservations` via `api.admin`.

## Counterevidence Checked

Hosts can wire full runner with repositories and email outbox separately; README implies lifecycle maintenance via plugin but does not document the partial wiring gap explicitly.

## Suggested Next Step

Pass repositories and email outbox runner from plugin storage context into `createMikaMaintenanceRunner`, or document that cron only releases stock unless extended.

## Agent Handoff

After working this report, preserve the original finding body. Update line 2 `DEVANA-STATE: ...` and the final `DEVANA-SUMMARY:` status/priority/confidence prefix. Use one of: `open`, `fixed`, `invalid`, `stale`, `duplicate`, `wontfix`. Keep `DEVANA-KEY:` stable unless the same finding moved. Add dated notes below with evidence checked.

## Status Notes

- 2026-06-27: open by Devana. Initial report written from static source inspection.
- 2026-06-27: fixed. Confirmed the cron hook called `createMikaMaintenanceRunner({ api })` with only the API handle, so `createMikaMaintenanceRunner` returned `skipped` for the email outbox, ephemeral purge, and account-delete tasks (each needs `emailOutboxRunner`/`repositories`), leaving only stock reservation release running. Architectural note: the default plugin builds its API from host-provided `options.api` overrides and has no repositories of its own, and the serializable plugin descriptor cannot carry live objects. Fix: added a runtime-only `MikaMaintenanceRuntimeOptions` (extends `MikaMaintenancePluginOptions` with `repositories` and `emailOutboxRunner`) used by `MikaCreatePluginOptions.maintenance`; the cron now forwards those deps into `createMikaMaintenanceRunner`, so a host calling `createPlugin` directly gets the full maintenance sweep, while the descriptor path degrades to stock-only as before. Documented the wiring requirement in the README. Added regression test `runs the email outbox, ephemeral purge, and account-delete tasks when the host wires them` (cron with wired emailOutboxRunner + repositories → emailOutbox/ephemeralRecords/accountDeleteRequests all `completed`). The existing stock-only test still asserts `skipped` without the deps. Typecheck + 320 tests pass.

DEVANA-KEY: src/plugin.ts:103-105 | plugin-cron-skips-outbox
DEVANA-SUMMARY: fixed | P1 | high | Default plugin cron passed only { api } so email outbox, ephemeral purge, and account-delete were skipped. Fixed by threading host-provided maintenance.repositories + emailOutboxRunner into the cron runner (runtime options), documented in the README, with a regression test.