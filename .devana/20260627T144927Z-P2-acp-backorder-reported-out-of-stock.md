DEVANA-FINDING: v1
DEVANA-STATE: fixed | P2 | high | security=no
DEVANA-KEY: src/acp.ts:1194-1206 | acp-backorder-reported-out-of-stock

# ACP feed reports a sold-out backorder item as out_of_stock, hiding a purchasable product

## Finding

`acpAvailability` marks any item with `availableQuantity === 0` as unavailable:

```ts
// src/acp.ts:1194-1206
const available =
  sellable.active &&
  status !== "out_of_stock" &&
  status !== "manual" &&
  sellable.availability?.availableQuantity !== 0;
return { available, status: available ? "in_stock" : "out_of_stock" };
```

For a `backorder` sellable that is sold out, `status === "backorder"` (passes the first checks) but `availableQuantity === 0` makes the final term false → `out_of_stock`. Backorder items are purchasable regardless of on-hand quantity, so this hides a sellable product.

## Violated Invariant Or Contract

A sellable whose stock policy is `backorder` is purchasable even at zero on-hand. Its ACP feed availability must not be `out_of_stock`.

## Oracle

- `stockAvailabilityToDTO` (`src/model/builders.ts:417-425`) emits `{ status: "backorder", availableQuantity: Math.max(0, onHand - reserved) }` — a sold-out backorder item has `status:"backorder"` AND `availableQuantity:0`.
- `reserveStockStatement` (`src/storage/statements.ts:28-32`) allows the reserve to succeed when `policy != 'finite' OR allow_backorder` — i.e. the cart/checkout will accept the purchase that the feed reports as `out_of_stock`.
- `acpFileAvailability` (`acp.ts:1208-1218`) contains explicit `"backorder"` / `"pre_order"` branches that are **dead code**, because `acpAvailability` only ever returns `"in_stock"|"out_of_stock"`. The intent was clearly to surface backorder/pre-order states.

## Counterexample

`sellable.active = true`, `sellable.availability = { status: "backorder", availableQuantity: 0 }`.

Evaluate: `true && ("backorder" !== "out_of_stock") && ("backorder" !== "manual") && (0 !== 0)` → last term `false` → `available = false` → feed emits `out_of_stock`. The reserve path for the same sellable succeeds.

## Why It Might Matter

Backorderable, sold-out products are advertised to ACP agents/feeds as out of stock and suppressed from purchase, even though checkout would happily accept them. Lost sales and feed/checkout inconsistency.

## Proof

Counterexample value + control-flow trace through the boolean at `acp.ts:1196-1200`, contradicted by the reserve SQL (`statements.ts:28-32`) and the unreachable backorder branch in `acpFileAvailability`.

## Counterevidence Checked

- "Backorder items have `availableQuantity` undefined, so `!== 0` is true." Refuted: `builders.ts:381,421` always sets `availableQuantity = Math.max(0, onHand - reserved)`, which is exactly `0` for a sold-out backorder item — never undefined.
- Pre-order (`status:"preorder"`) would hit the same `availableQuantity !== 0` gate when zero.

## Suggested Next Step

Treat `backorder`/`preorder` (and `untracked`) statuses as available regardless of `availableQuantity`, and map them through `acpFileAvailability`'s existing `backorder`/`pre_order` cases.

## Agent Handoff

Preserve the original finding body. Update line 2 `DEVANA-STATE:` and the final `DEVANA-SUMMARY:` prefix. Keep `DEVANA-KEY:` stable unless the finding moved.

## Status Notes

- 2026-06-27: open by Devana. Verified acp.ts:1194-1218; builders.ts:417-425; statements.ts:28-32.
- 2026-06-27: fixed. Confirmed `acpAvailability`'s `availableQuantity !== 0` term flipped a sold-out `backorder` sellable to `out_of_stock`, even though the reserve path (`policy != finite OR allow_backorder`) still sells it, and `acpFileAvailability`'s `backorder` branch was dead because `acpAvailability` only ever returned `in_stock`/`out_of_stock`. Fix: `acpAvailability` now returns early — `out_of_stock` for inactive/`out_of_stock`/`manual`; `{ available: true, status: "backorder" }` for `backorder` (purchasable at zero on-hand); `{ available: true, status: "in_stock" }` for `untracked` (unbounded); and only applies the `availableQuantity !== 0` gate to the remaining tracked statuses (`available`/`low_stock`). This makes `acpFileAvailability`'s `backorder` branch live. Note: the actual `AvailabilityStatus` enum has no `preorder` value, so that branch stays inert (harmless). Added regression test `advertises a sold-out backorder sellable as available/backorder, not out_of_stock` (feed variant availability `{ available: true, status: "backorder" }`; file row availability `"backorder"`). Typecheck + 325 tests pass.

DEVANA-KEY: src/acp.ts:1194-1206 | acp-backorder-reported-out-of-stock
DEVANA-SUMMARY: fixed | P2 | high | acpAvailability marked any availableQuantity===0 item out_of_stock, hiding sold-out backorder sellables that checkout still sells. Fixed by returning available/backorder for backorder (and in_stock for untracked) regardless of quantity, making the feed's backorder branch live, with a regression test.
