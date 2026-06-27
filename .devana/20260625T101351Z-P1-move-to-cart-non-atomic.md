DEVANA-FINDING: v1
Priority: P1 | Confidence: medium | Security-sensitive: no | Status: open
Location: src/api/backend.ts:1077-1078 | Slug: move-to-cart-non-atomic

# moveToCart removes wishlist item before cart write succeeds

## Finding

`moveToCart` persists the updated wishlist (item removed) before persisting the updated cart. If the second `put` fails, the item disappears from the wishlist but is not added to the cart.

## Violated Invariant Or Contract

Cart/wishlist moves must be atomic: an item must not vanish from both collections.

## Oracle

If the cart `put` fails after wishlist `put` succeeds, the wishlist must still contain the item.

## Counterexample

1. `put(updatedWishlist)` succeeds — item removed from wishlist.
2. `put(updatedCart)` throws (storage error, validation, etc.).
3. Item absent from wishlist and not present in cart.

## Why It Might Matter

Transient storage failures cause silent item loss on wishlist-to-cart moves, a common authenticated storefront flow.

## Proof

**Control-flow trace:** Two independent `session.put` calls with no transaction or compensating rollback. Wishlist updated first.

## Counterevidence Checked

`persistCheckoutStart` compensates stock on failure. `saveForLater` updates wishlist first but leaves item in cart on failure (duplicate, not loss). No rollback in `moveToCart`.

## Suggested Next Step

Use a storage transaction for both puts, or write cart first and wishlist second, or compensate wishlist on cart failure.

## Agent Handoff

After working this report, preserve the original finding body. Update line 2 `Status: ...` and the final `DEVANA-SUMMARY:` status.

## Status Notes

- 2026-06-25: open by Devana. Initial report written from static source inspection.

DEVANA-KEY: src/api/backend.ts:1077-1078 | P1 | move-to-cart-non-atomic
DEVANA-SUMMARY: Status=open | P1 medium src/api/backend.ts:1077-1078 - moveToCart writes wishlist before cart without rollback, so storage failure can lose the item from both.