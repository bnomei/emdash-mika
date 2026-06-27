DEVANA-FINDING: v1
DEVANA-STATE: open | P1 | high | security=no
DEVANA-KEY: src/api/lifecycle.ts:69-70 | refund-zero-partial-status

# Refund amount zero marks paid orders partially refunded

## Finding

`orderRefund` accepts `amount: 0` via `optionalAmountSchema` (`nonnegative`). `applyOrderRefund` treats any defined amount less than `totalAmount` as a partial refund, so `amount: 0` transitions a paid order to `partially_refunded` with `refundAmount: 0`.

## Violated Invariant Or Contract

A zero-amount refund must be rejected or treated as a no-op; it must not change order refund status.

## Oracle

`optionalAmountSchema` allows `0` (`validation.ts:98-101`). `fullRefund` uses `amount >= order.totalAmount` (`lifecycle.ts:69`), so `0` is partial. Admin refund path always persists the updated order after provider call (`backend.ts:1757-1760`).

## Counterexample

1. Paid order `totalAmount = 1200`.
2. `admin.orderRefund({ orderId, amount: 0 })` passes validation.
3. Ledger order becomes `{ status: "partially_refunded", paymentStatus: "partially_refunded", metadata: { refundAmount: 0 } }`.

## Why It Might Matter

Support tooling can accidentally mark orders as partially refunded without moving money, breaking reconciliation, entitlement policy, and customer-facing order state.

## Proof

**Counterexample value:** `refundInput.amount = 0` on `totalAmount > 0` → `applyOrderRefund` partial branch.

## Counterevidence Checked

Omitting `amount` triggers full refund (`amount === undefined`), which is distinct. No backend guard rejects zero before `applyOrderRefund`.

## Suggested Next Step

Reject `amount === 0` in validation or treat it as a validation failure before calling the provider.

## Agent Handoff

After working this report, preserve the original finding body. Update line 2 `DEVANA-STATE: ...` and the final `DEVANA-SUMMARY:` status/priority/confidence prefix. Use one of: `open`, `fixed`, `invalid`, `stale`, `duplicate`, `wontfix`. Keep `DEVANA-KEY:` stable unless the same finding moved. Add dated notes below with evidence checked.

## Status Notes

- 2026-06-27: open by Devana. Initial report written from static source inspection.

DEVANA-KEY: src/api/lifecycle.ts:69-70 | refund-zero-partial-status
DEVANA-SUMMARY: open | P1 | high | orderRefund with amount 0 passes validation and sets partially_refunded with refundAmount 0 on paid orders.