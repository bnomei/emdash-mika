DEVANA-FINDING: v1
DEVANA-STATE: open | P1 | high | security=no
DEVANA-KEY: src/api/backend.ts:1719-1760 | refund-cumulative-no-cap

# Repeated partial refunds are not capped by remaining balance

## Finding

`refundOrder` does not inspect current order refund status or cumulative refunded amount before applying another partial refund. Each call compares only the new `amount` to the full `order.totalAmount`, so multiple partial refunds can exceed the order total.

## Violated Invariant Or Contract

The sum of successful refunds for an order must not exceed `order.totalAmount`.

## Oracle

`applyOrderRefund` uses `refundInput.amount >= order.totalAmount` against the original total only (`lifecycle.ts:69-86`). `refundOrder` loads the order and proceeds without checking `status === "partially_refunded"` or prior `refundAmount` metadata (`backend.ts:1719-1760`).

## Counterexample

1. Paid order `totalAmount = 1000`.
2. `orderRefund({ amount: 600 })` → `partially_refunded`, metadata `refundAmount: 600`.
3. `orderRefund({ amount: 600 })` again → still `partially_refunded` because `600 < 1000`; provider can refund another 600 (1200 total).

## Why It Might Matter

Ledger shows a single partial refund while provider movements over-refund, causing revenue loss and inconsistent customer credit.

## Proof

**State transition mismatch:** two identical partial refunds each pass `amount < totalAmount` with no running total.

## Counterevidence Checked

After first partial refund, `status` is `partially_refunded` but there is no branch blocking further refunds. Metadata stores only the last `refundAmount`, not cumulative totals.

## Suggested Next Step

Track cumulative refunded amount on the order or reject partial refunds when `status` is already `partially_refunded` unless `amount <= remainingBalance`.

## Agent Handoff

After working this report, preserve the original finding body. Update line 2 `DEVANA-STATE: ...` and the final `DEVANA-SUMMARY:` status/priority/confidence prefix. Use one of: `open`, `fixed`, `invalid`, `stale`, `duplicate`, `wontfix`. Keep `DEVANA-KEY:` stable unless the same finding moved. Add dated notes below with evidence checked.

## Status Notes

- 2026-06-27: open by Devana. Initial report written from static source inspection.

DEVANA-KEY: src/api/backend.ts:1719-1760 | refund-cumulative-no-cap
DEVANA-SUMMARY: open | P1 | high | Multiple partial refunds each compare only to the original total, allowing cumulative provider refunds to exceed order.totalAmount.