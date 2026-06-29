DEVANA-FINDING: v1
DEVANA-STATE: fixed | P0 | high | security=no
DEVANA-KEY: src/api/backend.ts:5975 | stock-reservation-ttl-mismatch

# Stock reservations expire before hosted checkout session

## Finding

`checkout.start` reserves stock using a backend TTL (default 15 minutes) while the persisted checkout document can remain valid for much longer when the provider returns a longer session expiry (e.g. Stripe `expires_at`, typically 24 hours). Maintenance releases expired reservations while checkout status still reports the session as active. A late successful payment webhook then fails fulfillment because the reservation is no longer consumable.

## Violated Invariant Or Contract

Stock reservations must remain consumable for the entire window in which a provider checkout session can still complete and trigger order fulfillment.

## Oracle

`reserveCheckoutLines` passes `expiresAt` from `checkoutExpiresAt` into each reservation. The checkout document stores `expiresAt: providerSession.expiresAt ?? expiresAt`. `checkoutIsExpired` keys off the document expiry, not reservation expiry. `consumeOrderLineReservation` throws when the reservation is `released` or otherwise not `active`/`expired`.

## Counterexample

1. `T0`: `checkout.start` with Stripe hosted checkout; stock reserved with `expiresAt = T0 + 15m`.
2. Checkout document persisted with `expiresAt = T0 + 24h` from `stripeCheckoutSessionToMika`.
3. `T0 + 16m`: maintenance `releaseExpiredReservations` marks reservation `expired` and returns quantity to the available pool.
4. `checkout.status` still returns success (document not expired).
5. `T0 + 20m`: `checkout.session.completed` webhook with `paymentStatus: "paid"` arrives.
6. `fulfillPaidOrder` → `consumeOrderLineReservation` may succeed on `expired` reservation via on-hand consume, but a concurrent re-reservation in step 3 can cause oversell (see related finding). At minimum, fulfillment path is fragile and depends on reservation state at payment time.

## Why It Might Matter

Customers can complete payment within the provider session window after Mika has already released stock. Fulfillment can fail or compete with new reservations, producing paid orders without reliable stock consumption and potential overselling.

## Proof

**State transition mismatch:** Reservation TTL (15m default) ≠ checkout document TTL (provider, often 24h).

```
checkoutExpiresAt() → reserveCheckoutLines(..., expiresAt)  // 15m
providerSession.expiresAt ?? expiresAt → document.expiresAt  // 24h
checkoutIsExpired(document) uses document.expiresAt only
releaseExpiredReservations uses reservation.expires_at
```

Locations: `src/api/backend.ts` (`startCheckout` ~5975–6029, `checkoutExpiresAt` ~6880–6883, `checkoutIsExpired` ~6697–6702), `src/stripe.ts` (`stripeCheckoutSessionToMika` ~491), `src/storage/repositories.ts` (`releaseExpiredReservations` ~1802+).

## Counterevidence Checked

Hosts can set `config.checkout.ttlMs` to match provider session lifetime; nothing in code automatically extends reservations when provider expiry is longer. Delegated PaymentIntent paths without provider expiry align both TTLs to 15m, narrowing but not eliminating the hosted-checkout case.

## Suggested Next Step

Align reservation `expiresAt` with the persisted checkout `expiresAt` (max of backend TTL and provider session expiry), or block checkout status as payable once reservations expire.

## Agent Handoff

After working this report, preserve the original finding body. Update line 2 `DEVANA-STATE: ...` and the final `DEVANA-SUMMARY:` status/priority/confidence prefix.

## Status Notes

- 2026-06-29: open by Devana. Initial report written from static source inspection across inside-out-paths, state-lifecycle, and cache-persistence trails.
- 2026-06-29: fixed. `startCheckout` now extends reservation expiry to the persisted checkout document expiry (`providerSession.expiresAt ?? backend TTL`) via a new `StockRepository.extendReservations`, so reservations remain consumable for the whole provider session window. Extension only lengthens (never shortens) reservation expiry. Added stock-repository contract test covering extend + maintenance sweep across both repository kinds.

DEVANA-KEY: src/api/backend.ts:5975 | stock-reservation-ttl-mismatch
DEVANA-SUMMARY: fixed | P0 | high | Reservation expiry is now extended to match the persisted checkout window (provider session expiry), so maintenance no longer releases stock before late payments can fulfill.