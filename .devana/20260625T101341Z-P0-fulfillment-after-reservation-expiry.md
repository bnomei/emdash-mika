DEVANA-FINDING: v1
Priority: P0 | Confidence: high | Security-sensitive: no | Status: fixed
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
- 2026-06-27: fixed. Confirmed `consumeOrderLineReservation` threw on `not_active`+`expired`, failing the payment webhook for a paid order whose reservation maintenance had already released. Fix moved into the stock repository `consume` primitive (the only consumer is paid-order fulfillment via the lifecycle service): it now consumes `expired` reservations in addition to `active` ones. For the expired case only `quantity_on_hand` is drawn down (new `consumeOnHandStatement`) because expiry already returned `quantity_reserved` to availability — drawing it down again would corrupt other active reservations on the same item. Idempotent replay still works: after consumption the event id equals the reservationId, caught by the existing `line.stockMovementId === reservationId` guard. Mirrored the change in the in-memory test stock repository. Added a contract regression test (`consumes an expired reservation for late paid fulfillment`) run against both fake and real repositories. Typecheck + 297 tests pass.

DEVANA-KEY: src/api/backend.ts:4914-4934 | P0 | fulfillment-after-reservation-expiry
DEVANA-SUMMARY: Status=fixed | P0 high src/api/backend.ts:4914-4934 - Late payment webhooks failed fulfillment when maintenance expired the checkout reservation. Fixed by making stock `consume` draw down on-hand for expired reservations (paid-order fulfillment path), with a regression test.