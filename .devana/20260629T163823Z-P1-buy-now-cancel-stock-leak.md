DEVANA-FINDING: v1
DEVANA-STATE: fixed | P1 | high | security=no
DEVANA-KEY: src/api/backend.ts:6523 | buy-now-cancel-stock-leak

# Buy-now checkout.cancel does not release checkout-line reservations

## Finding

`cancelCheckout` releases stock only from `cartDocument.aggregate.items[].reservationId`. Buy-now checkouts (`sellableId` without `cartId`) store reservations on `document.aggregate.lines` only; `document.cartId` is undefined. API cancel marks the checkout cancelled but leaves reservation events active and `quantity_reserved` elevated until TTL expiry.

## Violated Invariant Or Contract

Cancelling a checkout must release all reservations created by `reserveCheckoutLines` for that checkout session.

## Oracle

Cart-based cancel tests expect `quantityReserved` to return to pre-checkout level immediately after cancel. `reserveCheckoutLines` writes `reservationId` onto checkout lines (~6307–6308) and mirrors to cart items only when a cart exists (~6330–6333).

## Counterexample

1. `checkout.start({ sellableId, quantity: 1 })` — no `cartId`.
2. Reservation active on `document.aggregate.lines[0].reservationId`; `quantityReserved === 1`.
3. `checkout.cancel({ checkoutId })`.
4. Checkout `status === "cancelled"` but reservation remains `active` and `quantityReserved === 1`.

## Why It Might Matter

Stock appears unavailable until reservation TTL or maintenance sweep; blocks other shoppers and can combine with oversell scenarios when reservations eventually expire and are re-reserved.

## Proof

**Control-flow trace:** `cancelCheckout` → loads cart by `document.cartId` → skips release when null → never reads `document.aggregate.lines`.

Location: `src/api/backend.ts` (`cancelCheckout` ~6523–6570, `reserveCheckoutLines` ~6257–6312, `persistCheckoutStart` ~6330–6333).

## Counterevidence Checked

`releaseExpiredReservations` eventually frees stock at `expiresAt` (default 15m). Cart-based cancel releases via cart items. Template cancel page may use Stripe cancel URL only, but ACP and API consumers call `checkout.cancel` directly.

## Suggested Next Step

Release reservations from `document.aggregate.lines` when no cart is present, or always use checkout lines as the authoritative reservation list.

## Agent Handoff

After working this report, preserve the original finding body. Update line 2 `DEVANA-STATE: ...` and the final `DEVANA-SUMMARY:` status/priority/confidence prefix.

## Status Notes

- 2026-06-29: open by Devana. Initial report written from static source inspection across inside-out-paths and state-lifecycle trails.
- 2026-06-29: fixed. `cancelCheckout` now releases reservations from the checkout document's own `aggregate.lines[].reservationId` — the authoritative source for both cart-based and buy-now checkouts — instead of only the cart's items. Buy-now checkouts (`sellableId` with no `cartId`) previously left their reservations active and `quantity_reserved` elevated until TTL/maintenance. The cart reopen still runs when a cart exists. Added a regression test asserting a buy-now checkout returns `quantityReserved` to 0 immediately on cancel.

DEVANA-KEY: src/api/backend.ts:6523 | buy-now-cancel-stock-leak
DEVANA-SUMMARY: fixed | P1 | high | checkout.cancel now releases reservations from the checkout document's own lines, so buy-now checkouts free stock immediately instead of waiting for TTL expiry.