DEVANA-FINDING: v1
DEVANA-STATE: fixed | P2 | medium | security=no
DEVANA-KEY: src/api/backend.ts:3082 | account-export-emailhash-forbidden

# account.exportStatus rejects emailHash-only session identity

## Finding

`verifyMagicLink` can authenticate a user with only `mika.emailHash` on the session (no `CustomerDocument`). `requestAccountExport` succeeds for that identity. `accountExportStatus` calls `accountExportBelongsToIdentity`, which matches only `customerId` or `userId`—not `emailHash`.

## Violated Invariant Or Contract

`resolveAccountIdentity` treats `emailHash` session state as authenticated identity; follow-up `account.exportStatus` for the same session must authorize access to exports created by `account.export`.

## Oracle

`verifyMagicLink` sets `mika.emailHash`. `requestAccountExport` uses `resolveAccountIdentity`. `accountExportBelongsToIdentity` (~3082–3087) checks customer and userId only. `accountExportSubjectHash` includes `emailHash` for export creation.

## Counterexample

1. Magic-link verify for email with no customer row → session has `emailHash` only.
2. `account.export` returns 202 with `exportId`.
3. `account.exportStatus({ exportId })` → 403 FORBIDDEN.

## Why It Might Matter

Email-only authenticated users cannot poll export status; broken account data export UX unless they retain a one-time download token.

## Proof

**Contract mismatch:** export creation accepts `emailHash` identity; status check does not.

Locations: `src/api/backend.ts` (`accountExportBelongsToIdentity` ~3082–3087, `requestAccountExport`, `accountExportStatus` ~1406–1421).

## Counterevidence Checked

Token-based `exportDownload` bypasses identity checks. Nothing documents that emailHash-only users must use token-only follow-up. `account.delete` includes `emailHash` on documents; export ownership omits it.

## Suggested Next Step

Add `emailHash` matching to `accountExportBelongsToIdentity` when consistent with export document fields.

## Agent Handoff

After working this report, preserve the original finding body. Update line 2 `DEVANA-STATE: ...` and the final `DEVANA-SUMMARY:` status/priority/confidence prefix.

## Status Notes

- 2026-06-29: open by Devana. Initial report written from static source inspection across dataflow-boundaries and invariants-contracts trails.
- 2026-06-29: fixed. `accountExportBelongsToIdentity` now also authorizes by `emailHash`, mirroring the `AccountDeleteRequestRecord` precedent (which already carries `emailHash`). Two coordinated changes: (1) `AccountExportRecord` gains an optional `emailHash` field and `requestAccountExport` persists `identity.customer?.emailHash ?? identity.emailHash` onto the export record; (2) the ownership check returns true when that persisted `document.record.emailHash` equals the requester's `identity.customer?.emailHash ?? identity.emailHash`. Previously an emailHash-only magic-link session (no customer/user row) could create an export — `resolveAccountIdentity` treats session `mika.emailHash` as authenticated and `account.export` accepts it — but the resulting document had no `customerId`/`userId` and no emailHash, so `accountExportStatus` always returned 403. Now the same session can poll status. Because the match uses `identity.customer?.emailHash` too, a customer row later created for that email keeps access to the earlier emailHash-only export. Migration-free: `emailHash` lives on the record JSON (read via `document.record.emailHash`, exactly like the existing `downloadTokenHash`), not added to the indexed top-level keys, so no storage migration is needed; and `accountExportDTO` selects fields explicitly so the hash is not exposed in responses. Scope: export ownership only; token-based `exportDownload` is unchanged. Evidence: a new test has an emailHash-only session (entitlement keyed by emailHash, `mika.emailHash` on session) create an export and then successfully poll `exportStatus` (200); it was confirmed to 403 before the belongs-check change. The existing unrelated-identity 403 test still passes. Full suite (358) and both tsc configs pass.

DEVANA-KEY: src/api/backend.ts:3082 | account-export-emailhash-forbidden
DEVANA-SUMMARY: fixed | P2 | medium | Account exports now persist emailHash and accountExportBelongsToIdentity matches it, so emailHash-only magic-link sessions can poll exportStatus for exports they created (was always 403).