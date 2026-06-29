DEVANA-FINDING: v1
DEVANA-STATE: open | P2 | medium | security=no
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

DEVANA-KEY: src/api/backend.ts:3082 | account-export-emailhash-forbidden
DEVANA-SUMMARY: open | P2 | medium | Magic-link emailHash sessions can create account exports but cannot poll exportStatus for them.