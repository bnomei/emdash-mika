DEVANA-FINDING: v1
DEVANA-STATE: open | P1 | high | security=no
DEVANA-KEY: src/stripe.ts:606 | stripe-refund-pending-completed

# Stripe pending refunds map to completed in Mika

## Finding

`refundStripePayment` maps any Stripe refund status other than `"failed"` to `"completed"`. Stripe refunds commonly return `"pending"` while processing. Mika then updates the local order ledger to `refunded` / `partially_refunded` before the refund is actually settled.

## Violated Invariant Or Contract

`order.refund` should only persist refunded payment state when the provider confirms the refund completed. `AdminActionResultDTO.status: "completed"` should not be emitted for pending provider operations.

## Oracle

`refundOrder` gates ledger mutation on `result.status === "completed"` (`backend.ts:1828-1834`). Stripe refund object `status` includes `pending`, `succeeded`, `failed`, and `canceled`.

## Counterexample

1. Admin calls `order.refund` on a paid order.
2. Stripe `refunds.create` returns `{ id: "re_1", status: "pending" }`.
3. `refundStripePayment` returns `{ status: "completed" }` (`stripe.ts:606`).
4. `updateOrderAfterRefund` runs and `ledger.put` sets `paymentStatus: "refunded"`.

## Why It Might Matter

Orders appear fully refunded in Mika while Stripe may still fail or require action; entitlements and support workflows can diverge from actual payment state.

## Proof

Contract mismatch: callee maps `pending` → `completed`; caller treats `completed` as postcondition for ledger write.

## Counterevidence Checked

Only `"failed"` is treated as failure. No async webhook reconciliation for refund status was found in scoped paths.

## Suggested Next Step

Map Stripe `pending` to `queued` or `running` and defer ledger mutation until `succeeded`, or poll/webhook before completing.

## Agent Handoff

After working this report, preserve the original finding body. Update line 2 `DEVANA-STATE: ...` and the final `DEVANA-SUMMARY:` status/priority/confidence prefix. Use one of: `open`, `fixed`, `invalid`, `stale`, `duplicate`, `wontfix`. Keep `DEVANA-KEY:` stable unless the same finding moved. Add dated notes below with evidence checked.

## Status Notes

- 2026-06-29: open by Devana. Initial report written from static source inspection.

DEVANA-KEY: src/stripe.ts:606 | stripe-refund-pending-completed
DEVANA-SUMMARY: open | P1 | high | Stripe refund status pending is mapped to completed, causing premature local order refunded state.