DEVANA-FINDING: v1
DEVANA-STATE: open | P2 | medium | security=no
DEVANA-KEY: src/api/backend.ts:6135 | checkout-duplicate-cart-sellable

# checkout.start with cartId and sellableId duplicates lines

## Finding

`resolveCheckoutStart` adds all cart lines, then unconditionally appends a line for `checkoutInput.sellableId` when present. Validation allows both `cartId` and `sellableId`. No deduplication occurs if the sellable is already in the cart.

## Violated Invariant Or Contract

Checkout lines should not double-count the same sellable when both cart and explicit `sellableId` are supplied.

## Oracle

`startCheckoutInputSchema` allows both fields. `expressBuyNow` is false when `cartId` is set (~6111–6112). Default storefront forms send only one field; API clients can send both.

## Counterexample

1. Cart contains 1× sellable A.
2. `checkout.start({ cartId, sellableId: A, quantity: 1 })`.
3. Two checkout lines for A; two stock reservations; provider charged for 2× quantity.

## Why It Might Matter

Double charging and double stock reservation for API or custom clients sending both identifiers.

## Proof

**Control-flow trace:** cart line loop (~6122–6133) → unconditional `sellableId` block (~6135–6144).

Location: `src/api/backend.ts` (`resolveCheckoutStart` ~6105–6160), `src/api/validation.ts` (`startCheckoutInputSchema`).

## Counterevidence Checked

Template `CheckoutForm.astro` sends only `cartId`; `BuyNowForm.astro` sends only `sellableId`. Convention may treat fields as mutually exclusive, but code does not enforce it.

## Suggested Next Step

Reject requests with both `cartId` and `sellableId`, or skip `sellableId` when the sellable is already represented in the cart.

## Agent Handoff

After working this report, preserve the original finding body. Update line 2 `DEVANA-STATE: ...` and the final `DEVANA-SUMMARY:` status/priority/confidence prefix.

## Status Notes

- 2026-06-29: open by Devana. Initial report written from static source inspection across boundaries-oracles and inside-out-paths trails.

DEVANA-KEY: src/api/backend.ts:6135 | checkout-duplicate-cart-sellable
DEVANA-SUMMARY: open | P2 | medium | Supplying both cartId and sellableId on checkout.start duplicates cart lines and reservations.