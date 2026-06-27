DEVANA-FINDING: v1
DEVANA-STATE: open | P1 | high | security=no
DEVANA-KEY: src/api/backend.ts:3887-3898 | cancelled-order-webhook-fulfill

# Payment webhooks still fulfill cancelled orders

## Finding

When a paid payment webhook matches an existing order, `processPaymentWebhook` always runs `fulfillPaidOrder` even if the order was previously admin-cancelled. `orderPaymentStatusAfterPaymentEvent` preserves `status: "cancelled"`, but fulfillment side effects still execute.

## Violated Invariant Or Contract

Cancelled orders must not receive new entitlements, license keys, download refs, or confirmation emails on later payment webhook delivery.

## Oracle

`PAYMENT_TERMINAL_ORDER_STATUSES` includes `cancelled` and blocks status promotion to `paid` (`lifecycle.ts:11-27`). `processPaymentWebhook` has no guard before `fulfillPaidOrder` (`backend.ts:3887-3898`). `fulfillPaidOrder` does not inspect `order.status` (`backend.ts:4822-4857`).

## Counterexample

1. Paid order `O` is admin-cancelled → `{ status: "cancelled", paymentStatus: "paid" }`.
2. Stripe retries `payment_intent.succeeded` for the same `providerPaymentId`.
3. `updatePaymentOrderFromEvent` keeps `status: "cancelled"`.
4. `fulfillPaidOrder` still creates entitlements/licenses/downloads and queues order confirmation email.

## Why It Might Matter

Cancelled commerce is re-entitled without returning the order to a paid lifecycle state, causing ghost access and customer confusion.

## Proof

**Control-flow trace:** existing order path → `updatePaymentOrderFromEvent` (cancelled preserved) → `fulfillPaidOrder` (unconditional) → entitlement/license/download sinks.

## Counterevidence Checked

`resolveDownload` blocks non-`paid` order status, but fulfillment may create new access artifacts before download resolution. Provider cancel does not prevent webhook retries. Terminal status set prevents status resurrection to `paid`, but not fulfillment — that is the gap.

## Suggested Next Step

Skip `fulfillPaidOrder` and checkout completion when `order.status` is `cancelled`, `refunded`, or `partially_refunded`.

## Agent Handoff

After working this report, preserve the original finding body. Update line 2 `DEVANA-STATE: ...` and the final `DEVANA-SUMMARY:` status/priority/confidence prefix. Use one of: `open`, `fixed`, `invalid`, `stale`, `duplicate`, `wontfix`. Keep `DEVANA-KEY:` stable unless the same finding moved. Add dated notes below with evidence checked.

## Status Notes

- 2026-06-27: open by Devana. Initial report written from static source inspection.

DEVANA-KEY: src/api/backend.ts:3887-3898 | cancelled-order-webhook-fulfill
DEVANA-SUMMARY: open | P1 | high | Payment webhook replay on admin-cancelled orders still runs fulfillPaidOrder, issuing entitlements and emails while status stays cancelled.