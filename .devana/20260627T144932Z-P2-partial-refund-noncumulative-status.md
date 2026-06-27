DEVANA-FINDING: v1
DEVANA-STATE: open | P2 | medium | security=no
DEVANA-KEY: src/api/lifecycle.ts:69-82 | partial-refund-noncumulative-status

# Partial refunds never cumulate: fully-refunded-via-partials order stays partially_refunded and refundAmount loses history

## Finding

`applyOrderRefund` decides full-vs-partial by comparing each refund against the original order total, and overwrites (never sums) the recorded refund amount:

```ts
// src/api/lifecycle.ts:64-86
const fullRefund = refundInput.amount === undefined || refundInput.amount >= order.totalAmount;
const status = fullRefund ? "refunded" : "partially_refunded";
return {
  ...order, status, paymentStatus: status, ...
  aggregate: { ...order.aggregate, metadata: {
    ...order.aggregate.metadata,
    ...(refundInput.amount !== undefined ? { refundAmount: refundInput.amount } : {}),
  }}};
```

`refundOrder` (`backend.ts:1719-1770`) never inspects `order.status` or prior refunds before the provider call + `ledger.put`.

## Violated Invariant Or Contract

Cumulative refunded amount and order status must reflect total refunds: an order fully refunded via successive partials must end in `refunded`, and `metadata.refundAmount` must reflect the cumulative refund, not the most recent one. A `fullRefund` decision should compare against the *remaining* refundable amount (`total - alreadyRefunded`), not the immutable original total.

## Oracle

The status enum distinguishes `partially_refunded` from `refunded`; a fully refunded order should reach `refunded`. The metadata field name `refundAmount` implies the refunded total, and downstream accounting/refund logic reads it.

## Counterexample

1. Order O, `totalAmount = 100`, `paid`.
2. Admin refunds 60 → `60 >= 100` false → status `partially_refunded`, `metadata.refundAmount = 60`.
3. Admin refunds the remaining 40 → `40 >= 100` false → status stays `partially_refunded`, `metadata.refundAmount` overwritten to `40` (the prior 60 is lost).

The order is fully refunded but is permanently labeled `partially_refunded`, and the recorded refund total (40) is less than the actual refund (100).

## Why It Might Matter

Order status and refund ledger become inconsistent with reality: fully refunded orders never reach `refunded`, and `refundAmount` understates the true refund. Accounting/reporting, refund-eligibility checks, and any logic keyed on `status === "refunded"` are corrupted.

## Proof

State-transition trace: `applyOrderRefund` compares each refund to the immutable original total and overwrites `refundAmount`; `refundOrder` adds no status/prior-refund guard. The three-step sequence reaches a fully-refunded order stuck in `partially_refunded` with lost history.

## Counterevidence Checked

- "Over-refund of money is blocked by the provider." True (the provider call at `backend.ts:1758` precedes the ledger write, and providers track remaining refundable), but that does not fix the local state: step 3 uses legitimate, provider-accepted amounts yet still mislabels status and loses refund history — a pure local-state invariant violation independent of the provider.
- Related (weaker, not separately reported): `applyOrderCancel` (`lifecycle.ts:89-107`) sets `status="cancelled"` with no source-status guard, so cancelling a `refunded`/fulfilled order overwrites its status without reversing fulfillment.

## Suggested Next Step

Track cumulative refunded amount (sum prior refunds + this one), compute `fullRefund` against the remaining refundable, and accumulate `refundAmount` rather than overwriting it.

## Agent Handoff

Preserve the original finding body. Update line 2 `DEVANA-STATE:` and the final `DEVANA-SUMMARY:` prefix. Keep `DEVANA-KEY:` stable unless the finding moved.

## Status Notes

- 2026-06-27: open by Devana. Verified lifecycle.ts:64-86 compares each refund to original total and overwrites refundAmount; refundOrder (backend.ts:1719-1770) has no status guard.

DEVANA-KEY: src/api/lifecycle.ts:69-82 | partial-refund-noncumulative-status
DEVANA-SUMMARY: open | P2 | medium | applyOrderRefund compares each refund to the original total and overwrites refundAmount, so an order fully refunded via partials stays partially_refunded forever and its recorded refund total loses prior amounts.
