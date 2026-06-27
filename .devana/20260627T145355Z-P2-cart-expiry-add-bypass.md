DEVANA-FINDING: v1
DEVANA-STATE: open | P2 | medium | security=no
DEVANA-KEY: src/api/backend.ts:6638-6643 | cart-expiry-add-bypass

# Expired carts can still be mutated via cart.add

## Finding

`findQuoteCart` and `checkout.start` treat carts past `expiresAt` as expired, but `findOrCreateOpenCart` / `cart.add` use `findOpenCart` without an expiry check. At `now === expiresAt`, quote and checkout reject the cart while add still succeeds.

## Violated Invariant Or Contract

Cart expiry must apply consistently across read, mutate, quote, and checkout paths.

## Oracle

Expiry computed in `findQuoteCart` (`backend.ts:6638-6641`). `cart.add` uses `findOrCreateOpenCart` → `findOpenCart` with no TTL gate (`backend.ts:5493-5504`, `817-843`). Test documents quote expiry without mutating stored cart status.

## Counterexample

1. Cart created with `expiresAt = T`, `status: "open"`.
2. At `now = T`, `checkout.start` returns `CHECKOUT_EXPIRED`.
3. Same moment `cart.add` succeeds and extends the expired open cart.

## Why It Might Matter

Stale carts accumulate lines after checkout should be blocked, confusing quote/checkout expiry UX.

## Proof

**Cross-entry mismatch:** `findQuoteCart` expired true vs `findOrCreateOpenCart` allows mutation at the same timestamp.

## Counterevidence Checked

`cart.get` DTO also omits expired status on stored documents; this report focuses on the add/checkout inconsistency. Deliberate non-mutation on quote is not a guard on add.

## Suggested Next Step

Apply the same `expiresAt` check in `findOpenCart` / `findOrCreateOpenCart`, or persist `status: "expired"` when TTL elapses.

## Agent Handoff

After working this report, preserve the original finding body. Update line 2 `DEVANA-STATE: ...` and the final `DEVANA-SUMMARY:` status/priority/confidence prefix. Use one of: `open`, `fixed`, `invalid`, `stale`, `duplicate`, `wontfix`. Keep `DEVANA-KEY:` stable unless the same finding moved. Add dated notes below with evidence checked.

## Status Notes

- 2026-06-27: open by Devana. Initial report written from static source inspection.

DEVANA-KEY: src/api/backend.ts:6638-6643 | cart-expiry-add-bypass
DEVANA-SUMMARY: open | P2 | medium | cart.add ignores cart.expiresAt while checkout.start and quote treat the same cart as expired at the same timestamp.