DEVANA-FINDING: v1
DEVANA-STATE: open | P1 | high | security=no
DEVANA-KEY: src/api/lifecycle.ts:69 | refund-over-total-uncapped

# Refund amount above order total is treated as full refund and forwarded uncapped

## Finding

`applyOrderRefund` classifies `refundInput.amount >= order.totalAmount` as a full refund. Amounts strictly greater than `totalAmount` still set ledger status to `refunded` and pass the raw `amount` through to the provider adapter without capping at the order total.

## Violated Invariant Or Contract

Refund amounts above the order total must be rejected; full-refund classification must use equality or cap at `totalAmount` before provider calls.

## Oracle

`fullRefund = refundInput.amount === undefined || refundInput.amount >= order.totalAmount` (`lifecycle.ts:69`). Provider input spreads `refundInput.amount` when defined (`backend.ts:1736-1740`). No clamp before `refundPayment`.

## Counterexample

1. Order `totalAmount = 1000`.
2. `admin.orderRefund({ orderId, amount: 1001 })`.
3. Ledger → `refunded`; provider receives `amount: 1001`.

## Why It Might Matter

Ledger and provider refunds can diverge, and merchants may over-refund relative to the recorded order total.

## Proof

**Counterexample value:** `amount = totalAmount + 1` → full refund branch + uncapped provider payload.

## Counterevidence Checked

`amount === totalAmount` is correct for intentional full refunds. Provider adapters may reject over-cap amounts at runtime, but Mika still marks the order refunded locally first (separate from provider-failure finding).

## Suggested Next Step

Validate `amount <= totalAmount` (and `amount > 0`) before provider calls; use `amount === totalAmount` or `undefined` for full refunds only.

## Agent Handoff

After working this report, preserve the original finding body. Update line 2 `DEVANA-STATE: ...` and the final `DEVANA-SUMMARY:` status/priority/confidence prefix. Use one of: `open`, `fixed`, `invalid`, `stale`, `duplicate`, `wontfix`. Keep `DEVANA-KEY:` stable unless the same finding moved. Add dated notes below with evidence checked.

## Status Notes

- 2026-06-27: open by Devana. Initial report written from static source inspection.

DEVANA-KEY: src/api/lifecycle.ts:69 | refund-over-total-uncapped
DEVANA-SUMMARY: open | P1 | high | Refund amounts greater than order.totalAmount mark the order refunded locally and forward the excess amount to the provider uncapped.