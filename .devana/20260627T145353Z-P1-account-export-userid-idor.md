DEVANA-FINDING: v1
DEVANA-STATE: open | P1 | high | security=yes
DEVANA-KEY: src/api/backend.ts:2949-2954 | account-export-userid-idor

# Account export download allows access via shared userId across customers

## Finding

`accountExportBelongsToIdentity` grants access when `identity.userId === document.userId` even if the authenticated customer id does not match `document.customerId`. Two customer records that share a `userId` can cross-read export artifacts.

## Violated Invariant Or Contract

Account export status and session-based download must require the same customer identity that created the export, not merely a matching `userId` on a different customer record.

## Oracle

First branch matches `customerId` only when equal (`backend.ts:2953`). Second branch matches any shared `userId` (`backend.ts:2954`). `findCustomerByUserId` is `findOne` with no uniqueness enforcement (`repositories.ts:614-616`).

## Counterexample

1. Customer A export document: `{ customerId: cust_a, userId: user_1 }`.
2. Actor B authenticates as customer B (`cust_b`) with the same `userId: user_1`.
3. `account.exportStatus` / session `exportDownload` pass `accountExportBelongsToIdentity` via the userId branch and return Customer A's export payload.

## Why It Might Matter

Cross-customer disclosure of orders, subscriptions, and PII embedded in export artifacts.

## Proof

**Dataflow trace:** Actor B `customerId` → `resolveAccountIdentity` → `accountExportBelongsToIdentity` userId match → export DTO for Customer A document.

## Counterevidence Checked

Token-based download still requires the secret token. Session path is the leak. `customerId` match is checked first but fails when customers differ while `userId` collides.

## Suggested Next Step

Require `document.customerId === identity.customer?.customerId` when both are present; use userId-only match only when the export was created without a customer id.

## Agent Handoff

After working this report, preserve the original finding body. Update line 2 `DEVANA-STATE: ...` and the final `DEVANA-SUMMARY:` status/priority/confidence prefix. Use one of: `open`, `fixed`, `invalid`, `stale`, `duplicate`, `wontfix`. Keep `DEVANA-KEY:` stable unless the same finding moved. Add dated notes below with evidence checked.

## Status Notes

- 2026-06-27: open by Devana. Initial report written from static source inspection.

DEVANA-KEY: src/api/backend.ts:2949-2954 | account-export-userid-idor
DEVANA-SUMMARY: open | P1 | high | accountExportBelongsToIdentity matches shared userId across different customer records, exposing another customer's export.