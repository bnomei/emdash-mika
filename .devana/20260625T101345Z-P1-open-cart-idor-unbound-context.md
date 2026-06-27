DEVANA-FINDING: v1
Priority: P1 | Confidence: high | Security-sensitive: yes | Status: fixed
Location: src/api/backend.ts:6839-6858 | Slug: open-cart-idor-unbound-context

# Open cart operations skip ownership when request context is unbound

## Finding

`findOwnedOpenCartById` only rejects cross-ownership when `ctx.customerId` or `ctx.sessionId` is set. When both are absent, any known `cartId` is accepted. This is weaker than `findOwnedCartById`, which rejects session carts when `ctx.sessionId` is missing.

## Violated Invariant Or Contract

Open carts are only readable/writable by the owning `customerId` or `sessionId`. Unauthenticated or unbound-context requests must not access arbitrary carts by id.

## Oracle

`cart.applyCoupon` / `cart.merge` with a victim `cartId` and no `ctx.sessionId` / `ctx.customerId` must return not-found or forbidden, not the victim cart DTO.

## Counterexample

1. Victim has open session cart `cart_v` (`sessionId=S_v`, no `customerId`).
2. Attacker learns `cart_v` (cart `id` is exposed in every `CartDTO`).
3. Attacker calls `cart.applyCoupon` with `cartId=cart_v` and no bound session/customer in context.
4. `findOwnedOpenCartById` skips both ownership branches and returns the document.
5. Attacker reads and mutates victim cart state.

## Why It Might Matter

IDOR on cart coupon, merge, and remove-coupon operations when hosts expose plugin routes without binding session context. Quote/checkout paths use the stricter `findOwnedCartById`.

## Proof

**Contract mismatch:** Compare `findOwnedCartById` (6653–6655 rejects when `ctx.sessionId` absent but cart has `sessionId`) vs `findOwnedOpenCartById` (6850–6856 only checks in `else if` branches).

## Counterevidence Checked

`resolveAccountIdentity` reads session customer for account paths but cart helpers do not. No compensating check in `route-handlers.ts` or `operation-runner.ts`.

## Suggested Next Step

Align `findOwnedOpenCartById` / `findOwnedActiveWishlistById` with `findOwnedCartById` ownership rules; reject when context cannot prove ownership.

## Agent Handoff

After working this report, preserve the original finding body. Update line 2 `Status: ...` and the final `DEVANA-SUMMARY:` status.

## Status Notes

- 2026-06-25: open by Devana. Initial report written from static source inspection.
- 2026-06-27: fixed. Confirmed `findOwnedOpenCartById` and `findOwnedActiveWishlistById` proved ownership from the request context (`if (ctx.customerId) {...} else if (ctx.sessionId && ...)`), so an unbound context (no customerId and no sessionId) skipped both checks and returned any cart/wishlist by id — reachable via `cart.applyCoupon`/`removeCoupon`/`merge`. Fix: derive ownership from the document's owner instead (`if (document.customerId) {...} else if (document.sessionId && document.sessionId !== ctx.sessionId)`), mirroring `findOwnedCartById`. Now an unbound context cannot match an owned cart/wishlist. Added regression test `rejects open-cart coupon access from an unbound request context`. Typecheck + 302 tests pass.

DEVANA-KEY: src/api/backend.ts:6839-6858 | P1 | open-cart-idor-unbound-context
DEVANA-SUMMARY: Status=fixed | P1 high src/api/backend.ts:6839-6858 - Cart coupon/merge + wishlist helpers accepted any id when session and customer were unbound. Fixed by deriving ownership from the document (matching findOwnedCartById), with a regression test.