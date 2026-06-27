DEVANA-FINDING: v1
Priority: P0 | Confidence: high | Security-sensitive: no | Status: fixed
Location: src/api/backend.ts:5838-5859 | Slug: buy-now-duplicate-lines

# Buy-now checkout duplicates open session cart lines

## Finding

`checkout.start` with only `sellableId` (the Buy Now form shape) still loads the caller's open session cart and iterates every cart line before unconditionally appending the `sellableId` line. When the buy-now sellable is already in the cart, checkout charges for it twice.

## Violated Invariant Or Contract

Express checkout via `sellableId` must represent a single buy-now line, not silently append to every resolved session cart line without deduplication.

## Oracle

`checkout.start({ sellableId, priceId, quantity })` after `cart.add` for the same sellable must not produce two identical checkout lines or double the charge.

## Counterexample

1. Session S calls `cart.add({ sellableId: A, quantity: 1 })` — open cart contains A×1.
2. User submits Buy Now for sellable A (`BuyNowForm.astro` posts only `sellableId`, no `cartId`).
3. `findCheckoutStartCart` → `findQuoteCart(undefined)` → `findOpenCart` loads the session cart.
4. `resolveCheckoutStart` iterates cart lines (A×1), then appends `sellableId` A×1 again.
5. Provider receives two lines for the same sellable.

## Why It Might Matter

Customers can be overcharged on the default Buy Now path whenever they already have the same item in their cart. The template form is the primary browser checkout shortcut.

## Proof

**Dataflow trace:** `findQuoteCart` (no `cartId`) → open cart lines → unconditional `sellableId` append at 5851–5859. `BuyNowForm.astro` action is `checkout.start` with hidden `sellableId` only.

## Counterevidence Checked

`findCheckoutStartCart` does not skip cart load when `sellableId` is set. No merge/dedupe helper in this path. `cart.quote` mirrors the same additive pattern (5550–5562).

## Suggested Next Step

When `sellableId` is present without `cartId`, either skip loading the session cart for buy-now, or dedupe/merge against existing cart lines before building checkout lines.

## Agent Handoff

After working this report, preserve the original finding body. Update line 2 `Status: ...` and the final `DEVANA-SUMMARY:` status. Use one of: `open`, `fixed`, `invalid`, `stale`, `duplicate`, `wontfix`. Add dated notes below with the evidence checked.

## Status Notes

- 2026-06-25: open by Devana. Initial report written from static source inspection.
- 2026-06-27: fixed. Confirmed `BuyNowForm.astro` posts only `sellableId` (no `cartId`), and `resolveCheckoutStart` iterated the open session cart lines then unconditionally appended the `sellableId` line, double-charging items already in the cart. Fix: `resolveCheckoutStart` now detects express buy-now (`sellableId` set, `cartId` unset) and skips the session-cart load entirely, producing a single buy-now line. Typecheck + 184 backend tests pass.

DEVANA-KEY: src/api/backend.ts:5838-5859 | P0 | buy-now-duplicate-lines
DEVANA-SUMMARY: Status=fixed | P0 high src/api/backend.ts:5838-5859 - Buy-now checkout appended sellableId to all open cart lines, double-charging when the item is already in the cart. Fixed by skipping the session-cart load for express buy-now (sellableId without cartId).