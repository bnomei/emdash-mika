DEVANA-FINDING: v1
Priority: P1 | Confidence: medium | Security-sensitive: no | Status: invalid
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
- 2026-06-27: invalid. The finding's premise is incorrect for the actual code: `moveToCart` (backend.ts:1077-1078) writes `updatedCart` FIRST, then `updatedWishlist` — the reverse of the report's claim ("persists the updated wishlist ... before persisting the updated cart"). Git history (`27d381e`) shows it was always cart-first. With cart-first ordering the reported loss cannot occur: if the cart `put` fails, the wishlist is untouched and still holds the item; if the cart `put` succeeds but the wishlist `put` fails, the item exists in both collections (a benign duplicate, not a loss). The report's own "Suggested Next Step" ("write cart first and wishlist second") is already implemented, so the invariant "an item must not vanish from both collections" already holds. No code change made.

DEVANA-KEY: src/api/backend.ts:1077-1078 | P1 | move-to-cart-non-atomic
DEVANA-SUMMARY: Status=invalid | P1 medium src/api/backend.ts:1077-1078 - Finding premise is wrong: moveToCart already writes cart before wishlist (the report's own recommended fix), so the item can never vanish from both; worst case is a benign duplicate. No loss path exists.