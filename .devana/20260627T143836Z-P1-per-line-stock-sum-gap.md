DEVANA-FINDING: v1
DEVANA-STATE: fixed | P1 | high | security=no
DEVANA-KEY: src/api/backend.ts:7211-7248 | per-line-stock-sum-gap

# Cart stock validation checks each line in isolation, not per-sellable total

## Finding

`validateQuantityLimit` validates a single line's quantity against `maxPerOrder` and `availableQuantity`. Multiple cart lines for the same sellable with different `priceId` values are not merged for stock checks, so summed quantity can exceed available stock while cart quote stays valid until checkout reservation.

## Violated Invariant Or Contract

Total units of a sellable in the cart must not exceed available stock or per-order limits.

## Oracle

`isEquivalentCartLine` keys on `sellableId` + `priceId`; `validateQuantityLimit` receives only the new line quantity, not aggregate demand per sellable.

## Counterexample

1. Sellable S with `availableQuantity = 5` and two active prices `price_a`, `price_b`.
2. `cart.add({ sellableId: S, priceId: price_a, quantity: 5 })` → OK.
3. `cart.add({ sellableId: S, priceId: price_b, quantity: 5 })` → OK (each line validated alone).
4. `cart.quote` → valid, no `OUT_OF_STOCK`.
5. `checkout.start` → second stock `reserve` fails with `insufficient_stock` after user believed cart was valid.

## Why It Might Matter

Broken checkout after a valid-looking cart; poor UX and support load; potential race with other buyers holding stock.

## Proof

**Control-flow trace:** `cart.add` → per-line `validateQuantityLimit` → separate lines stored → quote uses availability map per sellable but add path never sums line quantities → checkout `reserve` enforces stock atomically and fails.

## Counterevidence Checked

`mergeCartLine` aggregates only equivalent lines (same priceId). Checkout reservation is the first hard aggregate gate. Not the same as reservation expiry bugs already reported.

## Suggested Next Step

Sum quantities per `sellableId` across all cart lines before accepting add/update and in quote validation.

## Agent Handoff

After working this report, preserve the original finding body. Update line 2 `DEVANA-STATE: ...` and the final `DEVANA-SUMMARY:` status/priority/confidence prefix. Use one of: `open`, `fixed`, `invalid`, `stale`, `duplicate`, `wontfix`. Keep `DEVANA-KEY:` stable unless the same finding moved. Add dated notes below with evidence checked.

## Status Notes

- 2026-06-27: open by Devana. Initial report written from static source inspection.
- 2026-06-27: fixed. Confirmed cart mutation paths validated only the equivalent line's quantity (`sellableId`+`priceId`+`variantKey`) against `maxPerOrder`/`availableQuantity`, so two lines for the same sellable under different prices each passed while their sum exceeded stock, surfacing only at the checkout `reserve` gate. Stock is keyed per sellable (`findBySellableId`) and `maxPerOrder` is per sellable, so per-sellable summation is the correct invariant. Fix: new `siblingSellableQuantity(items, line)` helper sums quantity on all other cart lines with the same `sellableId` (excluding the equivalent line), and `cart.add`, `cart.update`, `mergeCartLines`, and `mergeCartLine` now validate `lineTotal + siblings` (the full per-sellable demand) — without inflating the stored line quantity. Added regression test `sums quantity across split price lines of the same sellable for stock checks` (availableQuantity 2: add 2@price_1 OK, then add 1@price_2 → 409 OUT_OF_STOCK). Quote/preview display still computes per-line availability (unchanged); the authoritative write gates now enforce the aggregate. Typecheck + 318 tests pass.

DEVANA-KEY: src/api/backend.ts:7211-7248 | per-line-stock-sum-gap
DEVANA-SUMMARY: fixed | P1 | high | Cart add/update/merge validated stock per line, so split-price lines for one sellable could exceed availableQuantity until checkout. Fixed by validating the summed per-sellable demand (siblingSellableQuantity) at every write gate, with a regression test.