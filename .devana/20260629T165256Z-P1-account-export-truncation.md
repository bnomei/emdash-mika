DEVANA-FINDING: v1
DEVANA-STATE: fixed | P1 | high | security=no
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

- 2026-06-29: open by Devana. Initial source inspection.
- 2026-06-30: fixed (chosen approach: the report's "paginate until exhausted" goal, realized as an export-specific unbounded limit because the ports cannot cursor-paginate). Confirmed `accountDTOForCustomer` (`src/api/backend.ts:3082`) loads orders/subscriptions/entitlements via `listOrdersByCustomer`/`listSubscriptionsByCustomer`/`listEntitlementsByCustomer` with NO limit → the repository defaults (50/50/100). `requestAccountExport` (`:1398`) uses that DTO verbatim as the export artifact (`accountExportArtifactRef`, `:1405`) and reports `ready`, so a customer with more than a default page is SILENTLY truncated. Crucially the SAME DTO builder is the account VIEW (`:1279`/`:1717`/verifyMagicLink `:3055`), where default pagination is correct — so the fix must be export-specific. Port constraint: the list ports take `(customerId, limit?)` with NO cursor parameter (`:301-350`), so true cursor-pagination-until-exhausted is not available without a port + all-impls change; the result type exposes `hasMore`/`cursor` but the port can't accept a cursor back. Fix: `accountDTOForCustomer` gains an optional `limit` (default `undefined` → the VIEW keeps its 50/50/100 pagination, byte-identical) passed to all three list calls, and a new `ACCOUNT_EXPORT_LIMIT = Number.MAX_SAFE_INTEGER` (an effectively-unbounded `LIMIT` that returns EVERY matching row — no realistic account hits it) which `requestAccountExport` passes, so the export artifact is the COMPLETE history and is never silently truncated. Evidence: a new test (`test/backend.test.ts`, "requests the complete order history for an account export, not the default page") wraps `listOrdersByCustomer` to capture the limit during `account.export` (only `accountDTOForCustomer` lists orders, so the capture is unambiguous) and asserts it equals `Number.MAX_SAFE_INTEGER`. Mutation-verified: reverting the export call to omit the limit (cp-backup + restore, no git) makes the captured limit `undefined` and fails the test (`expected undefined to be 9007199254740991`); restored via cp and re-confirmed green. Subscriptions and entitlements receive the same unbounded limit by the same `limit` argument. Full suite (390) and both tsc configs pass. Out of scope (noted follow-up, narrow edge): the emailHash-only export branch (`:1399-1404`, an authenticated identity with NO registered customer) carries only guest entitlements (no orders/subscriptions) sourced from `resolveAccountIdentity`'s default-limited `listEntitlementsByEmailHash`; the report's counterexample is a registered CUSTOMER (the `identity.customer` path, now complete), and completing the emailHash-only branch would require threading an export-limit override through the shared `resolveAccountIdentity` — left as a lower-priority follow-up since it only affects a guest identity holding more than a default page of entitlements.

DEVANA-KEY: src/api/backend.ts:2871 | account-export-truncation
DEVANA-SUMMARY: fixed | P1 | high | accountDTOForCustomer gained an optional limit (default keeps the account view paginated); the account export now passes ACCOUNT_EXPORT_LIMIT (Number.MAX_SAFE_INTEGER) to fetch the COMPLETE orders/subscriptions/entitlements history instead of the default 50/50/100 first page, so exports are no longer silently truncated. Ports have no cursor so an unbounded limit is the available "fetch all"; the emailHash-only-guest branch's entitlement page is a noted narrow follow-up.