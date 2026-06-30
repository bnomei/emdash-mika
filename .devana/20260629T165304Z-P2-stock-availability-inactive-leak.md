DEVANA-FINDING: v1
DEVANA-STATE: fixed | P2 | medium | security=no
DEVANA-KEY: src/api/backend.ts:704 | stock-availability-inactive-leak

# Public stock availability ignores sellable active flag

## Finding

`stock.availability` is a public route that loads stock by `sellableId` and projects availability with `active: true` hardcoded. It never checks catalog `sellable.active`, unlike `catalog.sellables` which filters inactive sellables.

## Violated Invariant Or Contract

Delisted or inactive sellables should not expose live inventory to anonymous callers when the public catalog hides them.

## Oracle

`catalog.sellables` filters `sellable.active` before DTO projection (`backend.ts:661-663`). `stock.availability` passes hardcoded `active: true` (`backend.ts:701-709`).

## Counterexample

1. Merchant sets `sellable.active: false` to hide a product from catalog.
2. Anonymous `GET /sellables/availability?sellableId=X` still returns quantity and stock status if a stock row exists.

## Why It Might Matter

Inventory state for delisted products remains enumerable via a public endpoint.

## Proof

Cross-entry mismatch: same `sellableId` hidden on catalog read but visible on availability read.

## Counterevidence Checked

Cart and checkout paths reject inactive sellables (`backend.ts:6209`). Only two plugin routes are public by default. No sensitive provider metadata in availability DTO.

## Suggested Next Step

Load catalog item and return 404 when sellable is inactive, matching `catalog.sellables` policy.

## Agent Handoff

After working this report, preserve the original finding body. Update line 2 `DEVANA-STATE: ...` and the final `DEVANA-SUMMARY:` status/priority/confidence prefix. Use one of: `open`, `fixed`, `invalid`, `stale`, `duplicate`, `wontfix`. Keep `DEVANA-KEY:` stable unless the same finding moved. Add dated notes below with evidence checked.

## Status Notes

- 2026-06-29: open by Devana. Initial report written from static source inspection.
- 2026-06-30: fixed (chosen approach exactly as the report's Suggested Next Step: load the catalog item and 404 when the sellable is inactive, matching catalog.sellables). Confirmed the bug: the public `stock.availability` handler (`src/api/backend.ts`) loaded the stock row by `sellableId` and projected a SYNTHETIC sellable with `active: true` HARDCODED into `stockAvailabilityToDTO`, never consulting the catalog — so an anonymous `GET /sellables/availability?sellableId=X` returned live quantity/stock-status for a DELISTED (inactive) sellable that `catalog.sellables` hides (`catalog.sellables` filters `sellable.active` before projection). Fix: the handler now resolves the REAL catalog sellable (`catalog.findItemBySellableId(id)` → `aggregate.sellables.find(item.id === id)`) and returns `404 SELLABLE_NOT_FOUND` unless `sellable.active` — identical to the `catalog.sellables` policy and to the cart/checkout active gates — before reading stock; it then builds the DTO from the REAL sellable (so the correct `maxPerOrder`, not a synthetic). The pre-existing no-stock 404 is preserved. Note `stockAvailabilityToDTO` itself never read `active` (the synthetic flag was inert), so the active enforcement had to be (and now is) an explicit guard in the handler. Evidence: a new test ("returns not found for an inactive (delisted) sellable on public availability") seeds a sellable that HAS a stock row but is `active: false` and asserts availability → `404 SELLABLE_NOT_FOUND`. Mutation-verified: dropping the active check (`!sellable?.active` → `!sellable`) leaks the inactive sellable as `200` and fails the test (cp-backup + restore, no git); restored and re-confirmed. The two existing availability tests now seed an ACTIVE catalog (the intended behavior change — public availability requires an active catalog sellable, no longer a hardcoded flag). Full suite (401) and both tsc configs pass.

DEVANA-KEY: src/api/backend.ts:704 | stock-availability-inactive-leak
DEVANA-SUMMARY: fixed | P2 | medium | Public stock.availability now resolves the real catalog sellable and returns 404 unless sellable.active (matching catalog.sellables), instead of projecting a hardcoded active:true from the stock row alone — so inventory for delisted/inactive sellables is no longer enumerable by anonymous callers. Builds the DTO from the real sellable; preserves the no-stock 404. New inactive→404 test + mutation-verified; the two existing availability tests now seed an active catalog (the intended behavior change).