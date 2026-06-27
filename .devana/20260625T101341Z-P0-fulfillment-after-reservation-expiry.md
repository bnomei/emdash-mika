DEVANA-FINDING: v1
Priority: P0 | Confidence: high | Security-sensitive: no | Status: open
Location: src/api/backend.ts:4914-4934 | Slug: fulfillment-after-reservation-expiry

# Paid order fulfillment fails when stock reservation expired

## Finding

After maintenance releases expired checkout reservations, a late payment webhook can still create a paid order, but `consumeOrderLineReservation` throws when the reservation event is `expired`. Fulfillment fails while the order remains paid and stock becomes sellable again.

## Violated Invariant Or Contract

A paid order must consume its checkout reservation (or equivalent stock movement) and complete fulfillment. Inventory must not remain sellable after payment without consumption.

## Oracle

After a successful payment webhook, every order line with `metadata.reservationId` must reach fulfilled state with stock consumed; webhook processing must not fail on expired reservations for paid orders.

## Counterexample

1. `startCheckout` reserves stock with `expiresAt` tied to checkout TTL (~15m default).
2. Maintenance `releaseExpiredReservations` marks reservations `expired` and releases quantity.
3. Payment webhook arrives after expiry → order persisted as `paid`.
4. `consumeOrderLineReservation` gets `not_active` with `event.status === "expired"`.
5. Only `consumed` replays are tolerated (4931–4932); `expired` throws → webhook fails, order stays paid without fulfillment.

## Why It Might Matter

Oversell risk: stock is released and can be sold again while a paid order exists. Orders can remain stuck in paid-but-unfulfilled state until manual intervention.

## Proof

**State transition mismatch:** `startCheckout` → reserve with TTL → maintenance expires → `processPaymentWebhook` → `fulfillPaidOrder` → `consume` throws on `expired`. No re-reserve or force-consume path for paid orders.

## Counterevidence Checked

`consume` idempotency handles `not_active` + `consumed` only. Payment webhooks gated on `paymentStatus === "paid"`. Cart blocks second checkout via `status !== "open"`. None extend reservation TTL at payment time.

## Suggested Next Step

Extend reservation TTL through payment completion, re-reserve on fulfillment for paid orders when reservation expired, or allow force-consume for paid-order fulfillment paths.

## Agent Handoff

After working this report, preserve the original finding body. Update line 2 `Status: ...` and the final `DEVANA-SUMMARY:` status.

## Status Notes

- 2026-06-25: open by Devana. Initial report written from static source inspection.

DEVANA-KEY: src/api/backend.ts:4914-4934 | P0 | fulfillment-after-reservation-expiry
DEVANA-SUMMARY: Status=open | P0 high src/api/backend.ts:4914-4934 - Late payment webhooks fail fulfillment when maintenance expired the checkout reservation, leaving paid orders unfulfilled and stock oversellable.