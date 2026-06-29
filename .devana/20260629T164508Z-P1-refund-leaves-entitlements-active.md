DEVANA-FINDING: v1
DEVANA-STATE: open | P1 | high | security=no
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

DEVANA-KEY: src/api/backend.ts:1833 | refund-leaves-entitlements-active
DEVANA-SUMMARY: open | P1 | high | order.refund updates ledger status only and leaves fulfilled entitlements active after partial or full refunds.