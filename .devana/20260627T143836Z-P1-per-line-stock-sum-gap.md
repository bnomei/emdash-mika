DEVANA-FINDING: v1
DEVANA-STATE: open | P1 | high | security=no
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

DEVANA-KEY: src/api/backend.ts:7211-7248 | per-line-stock-sum-gap
DEVANA-SUMMARY: open | P1 | high | Cart add validates stock per line not per sellable, so split price lines can exceed availableQuantity until checkout.start fails.