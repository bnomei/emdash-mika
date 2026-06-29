DEVANA-FINDING: v1
DEVANA-STATE: open | P1 | high | security=no
DEVANA-KEY: src/api/lifecycle.ts:117 | order-cancel-payment-status

# Order cancel leaves paymentStatus paid

## Finding

`applyOrderCancel` sets `status: "cancelled"` but does not update `paymentStatus`. After a successful provider cancel on a paid order, the ledger can hold `{ status: "cancelled", paymentStatus: "paid" }`. Refund path updates both fields; cancel path does not.

## Violated Invariant Or Contract

Order `status` and `paymentStatus` should describe a coherent payment lifecycle. Cancelled paid orders should not retain `paymentStatus: "paid"`.

## Oracle

`applyOrderRefund` sets both `status` and `paymentStatus` to refunded variants (`lifecycle.ts`). Tests assert cancelled orders keep `paymentStatus: "paid"` (`backend.test.ts` ~5650-5658). `PaymentStatus` enum has no `"cancelled"` case (`primitives.ts`).

## Counterexample

1. Paid order `{ status: "paid", paymentStatus: "paid" }`.
2. Admin `order.cancel` succeeds at provider.
3. Persisted `{ status: "cancelled", paymentStatus: "paid" }`.
4. Queries filtering `paymentStatus: "paid"` still return the cancelled order; download access checks requiring both `paid` values behave inconsistently.

## Why It Might Matter

Reporting, admin filters, and access rules keyed on `paymentStatus` misclassify cancelled orders as paid.

## Proof

Contract mismatch: refund updates both dimensions; cancel updates only `status`.

## Counterevidence Checked

`orderIsPaymentTerminal()` keys on `status` only for webhook replay. Download resolve requires both fields `paid`, so cancelled orders lose downloads despite `paymentStatus: "paid"`.

## Suggested Next Step

Set `paymentStatus` to a terminal cancelled/refunded value on admin cancel, or add explicit `cancelled` payment status.

## Agent Handoff

After working this report, preserve the original finding body. Update line 2 `DEVANA-STATE: ...` and the final `DEVANA-SUMMARY:` status/priority/confidence prefix. Use one of: `open`, `fixed`, `invalid`, `stale`, `duplicate`, `wontfix`. Keep `DEVANA-KEY:` stable unless the same finding moved. Add dated notes below with evidence checked.

## Status Notes

- 2026-06-29: open by Devana. Initial report written from static source inspection.

DEVANA-KEY: src/api/lifecycle.ts:117 | order-cancel-payment-status
DEVANA-SUMMARY: open | P1 | high | applyOrderCancel sets status cancelled but leaves paymentStatus paid on formerly paid orders.