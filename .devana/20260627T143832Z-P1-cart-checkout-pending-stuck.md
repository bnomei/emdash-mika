DEVANA-FINDING: v1
DEVANA-STATE: open | P1 | high | security=no
DEVANA-KEY: src/api/backend.ts:5890-5891 | cart-checkout-pending-stuck

# Abandoned checkout leaves cart stuck in checkout_pending

## Finding

`checkout.start` moves the cart to `checkout_pending`, but no path returns it to `open` when checkout expires, fails, or is abandoned. `findOpenCart` and `findCheckoutStartCart` only accept `status === "open"`, so the original cart and its lines become unreachable while a new empty cart may be created on subsequent adds.

## Violated Invariant Or Contract

A cart that never converted to an order must remain checkoutable, or abandonment must restore `open` status.

## Oracle

`CartStatus` includes `checkout_pending` as pre-conversion; `findOpenCartBySession` / `findOpenCartByCustomer` filter `status: "open"`; `findCheckoutStartCart` rejects non-open carts.

## Counterexample

1. User adds items to open cart `cart_1`.
2. `checkout.start({ cartId: cart_1 })` → `cartWithCheckoutReservations` sets `status: "checkout_pending"`.
3. Checkout session expires or user abandons payment; maintenance may release stock but cart status is unchanged.
4. `checkout.start({ cartId: cart_1 })` → `invalidCart` (5890-5891).
5. `cart.add` without `cartId` → `findOpenCart` skips `cart_1` → new empty cart; items remain trapped on `cart_1`.

## Why It Might Matter

Shoppers lose cart contents after an abandoned checkout and may unknowingly start a fresh empty cart, hurting conversion and support.

## Proof

**State transition mismatch:** One-way transition into `checkout_pending` (6373-6396); no compensating reopen on checkout `expired`/`failed`/`cancelled`. Reads gate on `open` only (repositories.ts:543-556, backend.ts:5890-5891, 5507-5518).

## Counterevidence Checked

Successful payment sets cart `converted` (4739-4741). Persist failure before cart write can leave cart `open` (test path). No maintenance task reopens `checkout_pending` carts.

## Suggested Next Step

On checkout expiry/failure/cancel, set cart back to `open` and clear checkout metadata, or allow `checkout.start` to resume from `checkout_pending` when checkout is still valid.

## Agent Handoff

After working this report, preserve the original finding body. Update line 2 `DEVANA-STATE: ...` and the final `DEVANA-SUMMARY:` status/priority/confidence prefix. Use one of: `open`, `fixed`, `invalid`, `stale`, `duplicate`, `wontfix`. Keep `DEVANA-KEY:` stable unless the same finding moved. Add dated notes below with evidence checked.

## Status Notes

- 2026-06-27: open by Devana. Initial report written from static source inspection.

DEVANA-KEY: src/api/backend.ts:5890-5891 | cart-checkout-pending-stuck
DEVANA-SUMMARY: open | P1 | high | Carts left in checkout_pending after abandoned checkout cannot be reopened or checkout-started, trapping line items.