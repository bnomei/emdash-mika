DEVANA-FINDING: v1
DEVANA-STATE: open | P1 | high | security=no
DEVANA-KEY: src/api/backend.ts:2871 | account-export-truncation

# Account export silently truncates orders and entitlements

## Finding

`accountDTOForCustomer` loads orders, subscriptions, and entitlements via repository list methods with default pagination limits (50 orders/subscriptions, 100 entitlements). Account export uses this DTO as the full export artifact with no truncation marker or pagination.

## Violated Invariant Or Contract

`account.export` should produce a complete account data artifact or explicitly indicate truncation. Export status `ready` implies the full dataset.

## Oracle

`listOrdersByCustomer(customerId, limit = 50)` (`repositories.ts:837-842`). `accountDTOForCustomer` calls it without a limit override (`backend.ts:2871-2874`).

## Counterexample

1. Customer has 60 paid orders.
2. `account.export` → `accountDTOForCustomer` returns newest 50 orders only.
3. Export status becomes `ready` with `artifactRef` containing incomplete history.

## Why It Might Matter

GDPR-style exports and customer support deliver silently incomplete order and entitlement history.

## Proof

Dataflow trace: export request → `listOrdersByCustomer` default limit 50 → artifact marked ready without completeness signal.

## Counterevidence Checked

No higher limit or loop pagination in `accountDTOForCustomer`. Export artifact is inline JSON (`accountExportArtifactRef`), not paginated storage.

## Suggested Next Step

Paginate repository reads until exhausted or add `truncated: true` and explicit limits to export metadata.

## Agent Handoff

After working this report, preserve the original finding body. Update line 2 `DEVANA-STATE: ...` and the final `DEVANA-SUMMARY:` status/priority/confidence prefix. Use one of: `open`, `fixed`, `invalid`, `stale`, `duplicate`, `wontfix`. Keep `DEVANA-KEY:` stable unless the same finding moved. Add dated notes below with evidence checked.

## Status Notes

- 2026-06-29: open by Devana. Initial report written from static source inspection.

DEVANA-KEY: src/api/backend.ts:2871 | account-export-truncation
DEVANA-SUMMARY: open | P1 | high | account.export builds from paginated list calls with default limits and reports ready without truncation warning.