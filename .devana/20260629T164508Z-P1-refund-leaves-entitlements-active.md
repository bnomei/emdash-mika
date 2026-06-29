DEVANA-FINDING: v1
DEVANA-STATE: fixed | P1 | high | security=no
DEVANA-KEY: src/api/backend.ts:1833 | refund-leaves-entitlements-active

# Order refund does not revoke fulfilled entitlements

## Finding

`admin.orderRefund` updates the order document via `applyOrderRefund` but never revokes entitlements or licenses created during `fulfillPaidOrderLine`. After a partial or full refund, entitlement documents can remain `active` while the order status becomes `partially_refunded` or `refunded`.

## Violated Invariant Or Contract

Refunding a fulfilled order should withdraw access granted by that order. Fulfillment creates active entitlements tied to `orderId`, but refund is ledger-only.

## Oracle

`fulfillPaidOrderLine` creates and persists entitlements for `fulfillmentKind: "entitlement"`. `applyOrderRefund` only mutates order status, payment status, and refund metadata (`src/api/lifecycle.ts:83-108`). `entitlement.revoke` exists as a separate admin action.

## Counterexample

Order total 1200, entitlement granted on payment. Admin calls `order.refund` with `amount: 500`. Order becomes `{ status: "partially_refunded", paymentStatus: "partially_refunded" }`. Related entitlement stays `{ status: "active", orderId }`. `account.get` can show refunded payment state alongside an active entitlement.

## Why It Might Matter

Customers retain content access after refunds. Partial refunds especially leave full entitlements while payment status shows a refund, creating billing and access-control inconsistency.

## Proof

Control-flow trace:

- `refundOrder` provider success branch → `updateOrderAfterRefund` → `ledger.put` (`src/api/backend.ts:1833-1834`).
- No call to `revokeEntitlement`, `revokeLicense`, or order-line fulfillment cleanup.
- `resolveDownload` blocks when order is not paid, but entitlement rows and account DTOs still report `active`.

## Counterevidence Checked

Full refund blocks download resolution because `resolveDownload` requires `order.status === "paid"`. That does not update entitlement documents. Host apps checking entitlement status directly would still grant access.

## Suggested Next Step

Cascade refund (full and optionally partial) to revoke order-linked entitlements and licenses, or mark them inactive with refund metadata.

## Agent Handoff

After working this report, preserve the original finding body. Update line 2 `DEVANA-STATE: ...` and the final `DEVANA-SUMMARY:` status/priority/confidence prefix. Use one of: `open`, `fixed`, `invalid`, `stale`, `duplicate`, `wontfix`. Keep `DEVANA-KEY:` stable unless the same finding moved. Add dated notes below with evidence checked.

## Status Notes

- 2026-06-29: open by Devana. Initial report written from static source inspection.
- 2026-06-29: fixed (report's first suggested approach: cascade refund to revoke order-linked entitlements and licenses). `order.refund` now revokes fulfillment-granted access on a FULL refund. Changes: (1) a new `revokeOrderFulfillmentAccess(input, order, now)` helper iterates `order.aggregate.lines` and, for each `entitlement`/`license` fulfillment kind, recomputes the deterministic fulfillment-document id (`fulfillmentDocumentId("entitlement"|"license", order.id, line.id)` — the same id `createOrderLineEntitlementDocument`/`createOrderLineLicenseDocument` mint at fulfillment), loads it via `findEntitlementById`/`findLicenseById`, and if it is still `active` sets top-level + record `status: "revoked"` with `record.revokedAt` and `record.metadata.revokeReason: "order_refunded"` (mirrors the existing `entitlement.revoke`/`license.revoke` update shape), then `account.put`s it; (2) `refundOrder`'s provider-success branch captures one `now`, and after `ledger.put(updated)` calls the helper only when `updated.status === "refunded"` (full refund). Design decision — cascade on FULL refund ONLY: `applyOrderRefund` marks a refund full when `amount` is omitted or cumulative refunds cover `totalAmount`; a PARTIAL refund retains net payment, and auto-revoking ALL access on a partial refund is worse than leaving it (the admin can selectively revoke via `entitlement.revoke`/`license.revoke`), so partial refunds intentionally keep access. `download`/`external`/`none` fulfillment kinds create no revocable document, so they are skipped; already-revoked or missing documents are no-ops (idempotent). Because ids are deterministic, no new index or query is needed. Evidence: two new tests build a paid order with an entitlement-kind line and a license-kind line plus their active fulfillment documents (ids `entitlement_order_1_order_line_1` / `license_order_1_order_line_2`) — a full refund (`amount` omitted) flips both to `revoked` with the refund metadata, and a partial refund (`amount: 500` of 1200) leaves both `active`. The full-refund test was confirmed to FAIL before the cascade (entitlement/license stayed `active`). Full suite (362) and both tsc configs pass. Out of scope (NOT changed): partial-refund cascade (deliberately omitted, see above); license `record.entitlementId` chains (a pure license line carries no linked entitlement); host apps that read their own access state rather than these documents. Review caveats recorded (non-blocking): (1) the cascaded revokes run inline within the audited `order.refund` action, so there are no per-document `entitlement.revoke`/`license.revoke` audit records — traceability rests on the `record.revokedAt` + `record.metadata.revokeReason: "order_refunded"` breadcrumb (intentional: cascade as a side effect of the parent audited action); (2) the cascade is not atomic with the ledger write — `ledger.put` persists `refunded` before the revoke loop, so a mid-loop `account.put` failure could leave some access active, but a retried `order.refund` re-runs the cascade and already-revoked documents are no-ops (consistent with the codebase's existing provider-call/ledger-put non-atomicity).

DEVANA-KEY: src/api/backend.ts:1833 | refund-leaves-entitlements-active
DEVANA-SUMMARY: fixed | P1 | high | order.refund now cascades a FULL refund to revoke order-linked entitlements and licenses (deterministic fulfillment ids) with refund metadata; partial refunds intentionally retain access.