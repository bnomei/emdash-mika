DEVANA-FINDING: v1
Priority: P1 | Confidence: high | Security-sensitive: no | Status: open
Location: src/api/backend.ts:5507-5517 | Slug: session-customer-cart-mismatch

# Session-stored customer identity not applied to cart and wishlist resolution

## Finding

After magic-link verification sets `mika.customerId` on the session, cart and wishlist helpers use only `ctx.customerId` (not hydrated from session). Account and checkout-status paths read session customer via `resolveAccountIdentity` / `checkoutBelongsToContext`, creating inconsistent identity resolution.

## Violated Invariant Or Contract

Cart/wishlist/checkout ownership should use the same effective customer identity as account and checkout-status (`ctx.customerId ?? session["mika.customerId"]`).

## Oracle

After `verifyMagicLink` sets session customer, `cart.get` should resolve the customer-bound cart/wishlist, and `cart.get({ cartId })` for that cart should succeed.

## Counterexample

1. `verifyMagicLink` sets `mika.customerId` on session (~2711).
2. Subsequent `cart.get` with session but without explicit `ctx.customerId`.
3. `findOpenCart` uses only `ctx.customerId` (~5512–5517), not session value.
4. Opens/creates session cart with `customerId: undefined` instead of customer-bound cart.
5. `findOwnedCartById` rejects customer cart when `ctx.customerId` unset (~6653–6654).
6. Meanwhile `checkoutBelongsToContext` accepts session customer (~6257–6258).

## Why It Might Matter

Post-login storefront flows see empty carts, fail cart-by-id lookups, and fork identity between session-authenticated and customer-bound resources.

## Proof

**Cross-entry mismatch:** `resolveAccountIdentity` reads session customer; `findOpenCart` / `findActiveWishlist` / `findOwnedCartById` do not. `createMikaRequestContext` does not hydrate `customerId` from session.

## Counterevidence Checked

Explicit `ctx.customerId` injection works. Checkout idempotency hashing uses identity helpers that may differ from cart paths. No session hydration in `context.ts`.

## Suggested Next Step

Centralize effective customer resolution and use it consistently in cart, wishlist, checkout binding, and ownership checks.

## Agent Handoff

After working this report, preserve the original finding body. Update line 2 `Status: ...` and the final `DEVANA-SUMMARY:` status.

## Status Notes

- 2026-06-25: open by Devana. Initial report written from static source inspection.

DEVANA-KEY: src/api/backend.ts:5507-5517 | P1 | session-customer-cart-mismatch
DEVANA-SUMMARY: Status=open | P1 high src/api/backend.ts:5507-5517 - Cart and wishlist ignore session-stored customerId after magic-link login, diverging from account and checkout identity paths.