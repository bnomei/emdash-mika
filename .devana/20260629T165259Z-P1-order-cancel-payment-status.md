DEVANA-FINDING: v1
DEVANA-STATE: invalid | P1 | high | security=no
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
- 2026-06-30: invalid — `{ status: "cancelled", paymentStatus: "paid" }` is INTENTIONAL, tested, and coherent; `status` (order lifecycle) and `paymentStatus` (money lifecycle) are ORTHOGONAL dimensions, and the asymmetry the report flags is correct modeling. Evidence:
  (1) The exact state is explicitly ASSERTED by the maintainer's test: `test/backend.test.ts:6097-6099` checks that after `order.cancel` the persisted order is `{ status: "cancelled", paymentStatus: "paid" }`, while the SAME test (`:6088`) shows `order.refund` yields `{ status: "partially_refunded", paymentStatus: "partially_refunded" }`; and `:8370-8378` uses `{ status: "cancelled", paymentStatus: "paid" }` as a recognized terminal fixture. So the behavior is by-design, not an oversight.
  (2) The asymmetry (refund sets BOTH fields, cancel sets only `status`) is CORRECT: a refund MOVES MONEY, so it transitions `paymentStatus` to a refunded variant (`applyOrderRefund`, `lifecycle.ts:92-97`); a cancel ABORTS the order WITHOUT moving money, so `paymentStatus: "paid"` accurately records that the payment was made and NOT returned (`applyOrderCancel`, `:112-130`). The report's suggested remedies are wrong: setting `paymentStatus` to `"refunded"` would FALSELY claim a refund happened (the merchant still holds the funds); and `"cancelled"` is not a `PaymentStatus` at all (the enum is `unpaid|paid|refunded|partially_refunded|failed`, `primitives.ts:227`) — adding it would conflate the order-cancel action with a money event the cancel path deliberately does not perform. A paid+cancelled order can still be refunded afterwards (`applyOrderRefund` → `{ refunded, refunded }`), so `{ cancelled, paid }` is a valid, recoverable intermediate.
  (3) NO concrete misclassification exists, because the library keys order-state decisions on `status`, never on `paymentStatus` alone: `orderIsPaymentTerminal` (`lifecycle.ts:22`) tests `order.status` against `{ refunded, partially_refunded, cancelled }`, so a cancelled order is terminal and PROTECTED from late-webhook re-fulfillment (`backend.ts:4337`/`4369`; test `:8356` "does not regress refunded or cancelled orders to paid"); `download.resolve` requires `order.status === "paid" && order.paymentStatus === "paid"` (`backend.ts:3304`), so cancelled orders are blocked regardless of `paymentStatus` — which the report's own Counterevidence concedes ("Download resolve requires both fields paid, so cancelled orders lose downloads"). A grep of `paymentStatus` shows the only `"paid"` comparisons are a SETTER in `createPaymentOrderDocument` (`:5155`) and webhook EVENT checks (`:4252`, `:6048`), never an order-filter query. The report's "queries filtering paymentStatus: paid return cancelled orders" is a hypothetical host query, not a library code path — and a cancelled-but-unrefunded order's payment is in fact still retained revenue, so counting it as paid is defensible until an actual refund occurs.
  Conclusion: the report conflates the orthogonal order-lifecycle and payment-lifecycle dimensions; `{ cancelled, paid }` is the correct, tested representation of "a paid order cancelled without a refund." No code change; only the state is updated.

DEVANA-KEY: src/api/lifecycle.ts:117 | order-cancel-payment-status
DEVANA-SUMMARY: invalid | P1 | high | { cancelled, paid } is intentional and tested (backend.test.ts:6097-6099 asserts it; :8356 uses it as a terminal fixture). status (order lifecycle) and paymentStatus (money lifecycle) are orthogonal: refund moves money so it sets both fields, cancel aborts without moving money so it keeps paymentStatus paid (accurately — the payment was made and not returned; the order can still be refunded later). No misclassification path exists: the library keys terminal/access decisions on status (orderIsPaymentTerminal includes cancelled; download requires status===paid), never paymentStatus alone. The report's remedies (set refunded / add a cancelled PaymentStatus) would falsely claim a money event the cancel does not perform.