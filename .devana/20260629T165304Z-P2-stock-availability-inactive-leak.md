DEVANA-FINDING: v1
DEVANA-STATE: open | P2 | medium | security=no
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

DEVANA-KEY: src/api/backend.ts:704 | stock-availability-inactive-leak
DEVANA-SUMMARY: open | P2 | medium | Public stock.availability returns inventory for inactive sellables delisted from catalog.sellables.