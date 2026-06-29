DEVANA-FINDING: v1
DEVANA-STATE: open | P1 | high | security=no
DEVANA-KEY: src/api/maintenance.ts:216 | account-delete-incomplete-cleanup

# Account delete maintenance does not remove customer commerce data

## Finding

`processQueuedAccountDeleteRequests` deletes ephemeral tokens, releases customer-scoped stock reservations, redacts queued/failed emails, then marks the delete request `completed`. It does not delete or redact `CustomerDocument`, orders, entitlements, licenses, subscriptions, or sent email records.

## Violated Invariant Or Contract

A completed account delete request should remove or irreversibly anonymize persisted commerce PII and access artifacts tied to the identity.

## Oracle

Maintenance steps at `maintenance.ts:200-226`. `completeAccountDeleteRequest` only updates the ops document status (`repositories.ts:924-942`).

## Counterexample

1. Customer calls `account.delete`.
2. Maintenance runs successfully → request `status: "completed"`.
3. `CustomerDocument`, paid orders, entitlements, and licenses remain queryable by `customerId` / `emailHash`.

## Why It Might Matter

Users receive a completed delete while orders, entitlements, and customer records persist in storage.

## Proof

Control-flow trace: delete queue → partial cleanup (tokens/reservations/emails only) → completed without ledger/account deletion.

## Counterevidence Checked

`deleteTokensBySubjectHashes` covers magic-link and export tokens. Expired reservation cron eventually releases guest session holds. Distinct from read-path gaps in existing reports.

## Suggested Next Step

Extend maintenance to redact/delete customer, order, entitlement, license, and subscription documents, or document that hosts must implement full erasure.

## Agent Handoff

After working this report, preserve the original finding body. Update line 2 `DEVANA-STATE: ...` and the final `DEVANA-SUMMARY:` status/priority/confidence prefix. Use one of: `open`, `fixed`, `invalid`, `stale`, `duplicate`, `wontfix`. Keep `DEVANA-KEY:` stable unless the same finding moved. Add dated notes below with evidence checked.

## Status Notes

- 2026-06-29: open by Devana. Initial report written from static source inspection.

DEVANA-KEY: src/api/maintenance.ts:216 | account-delete-incomplete-cleanup
DEVANA-SUMMARY: open | P1 | high | Account delete maintenance completes after token and reservation cleanup without deleting customer orders or entitlements.