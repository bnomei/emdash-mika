DEVANA-FINDING: v1
DEVANA-STATE: fixed | P1 | high | security=no
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
- 2026-06-27: fixed. Confirmed `checkout.start` moves the cart to `checkout_pending` (`cartWithCheckoutReservations`) with no path back to `open` on abandonment/expiry/failure, so the cart and items became unreachable (`findOpenCart*` gate on `open`). Fix: `findOpenCart` now lazily reopens an abandoned cart — when no open cart exists it looks up the actor's `checkout_pending` cart (new repo finders `findCheckoutPendingCartBy{Session,Customer}`), loads the linked checkout via the cart's `checkoutSessionId` metadata, and reopens the cart (status→open, clears `checkoutSessionId` + stale line `reservationId`s) only when the checkout is non-convertible (missing, failed, cancelled, expired). A still-resumable checkout (created/redirected within expiry) or a completed one is left untouched so an in-flight/converted payment is never duplicated. This covers `cart.get`, `cart.add`, and `checkout.start` without `cartId`. Added regression test `reopens an abandoned checkout_pending cart so its items are not trapped`. Typecheck + 314 tests pass.

DEVANA-KEY: src/api/backend.ts:5890-5891 | cart-checkout-pending-stuck
DEVANA-SUMMARY: fixed | P1 | high | Abandoned checkout_pending carts were unreachable. Fixed by lazily reopening the actor's pending cart in findOpenCart when its checkout is non-convertible (not when resumable/completed), with a regression test.