DEVANA-FINDING: v1
DEVANA-STATE: open | P2 | medium | security=no
DEVANA-KEY: src/storage/repositories.ts:543-548 | currency-cart-orphan

# Default currency change orphans existing open carts

## Finding

Open carts are keyed by `(sessionId, currency)` via `findOpenCartBySession`. When the host default currency changes, routine `cart.get` / `cart.add` look up the new currency, find no cart, and create a fresh empty cart while the old-currency open cart remains unreachable.

## Violated Invariant Or Contract

A session's active cart lines must remain reachable across default-currency configuration changes unless explicitly migrated.

## Oracle

`findOpenCart` uses `defaultBackendCurrency(input)` (`backend.ts:5507-5518`). `findOpenCartBySession(sessionId, currency)` filters on exact currency (`repositories.ts:543-548`). No migration or fallback to other currency carts.

## Counterexample

1. Default currency `USD`; guest adds items → open cart `C_usd`.
2. Host changes default to `EUR`.
3. `cart.get` creates empty `C_eur`; `C_usd` stays `open` with lines but is never returned by session-scoped paths.

## Why It Might Matter

Customers lose visible cart contents after currency config changes; lines remain orphaned until manual `cartId` or merge with matching currency.

## Proof

**Dataflow trace:** config currency change → `findOpenCart(newCurrency)` miss → new cart created → old cart orphaned.

## Counterevidence Checked

Explicit `cartId` or `cart.merge` with matching currency can still reach the old cart; normal storefront flows do not pass `cartId`. Wishlists are not currency-keyed — cart-specific issue.

## Suggested Next Step

On currency change, migrate or surface the most recent open cart regardless of currency, or reject config changes while open carts exist.

## Agent Handoff

After working this report, preserve the original finding body. Update line 2 `DEVANA-STATE: ...` and the final `DEVANA-SUMMARY:` status/priority/confidence prefix. Use one of: `open`, `fixed`, `invalid`, `stale`, `duplicate`, `wontfix`. Keep `DEVANA-KEY:` stable unless the same finding moved. Add dated notes below with evidence checked.

## Status Notes

- 2026-06-27: open by Devana. Initial report written from static source inspection.

DEVANA-KEY: src/storage/repositories.ts:543-548 | currency-cart-orphan
DEVANA-SUMMARY: open | P2 | medium | Changing default currency leaves prior open carts keyed on the old currency unreachable while a new empty cart is created.