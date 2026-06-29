DEVANA-FINDING: v1
DEVANA-STATE: fixed | P2 | medium | security=no
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
- 2026-06-29: fixed (report's first suggested approach: reject). `resolveCheckoutStart` now returns a `422 VALIDATION_FAILED` when both `cartId` and `sellableId` are supplied, before loading the cart or resolving any line. `cartId` (checkout an existing cart) and `sellableId` (express buy-now) are mutually exclusive line sources: with both set, `expressBuyNow` was false (it requires `cartId === undefined`), so the resolver added every cart line and then unconditionally appended a separate line for the sellable, double-counting a sellable already in the cart. Rejecting early — rather than silently skipping — was chosen because this is a mutating, charging operation, so an ambiguous request should surface as a client error rather than guess intent. Scope: `checkout.start`. Note on a sibling path: `createCartQuote` (backend.ts ~5921, used by `cart.quote` and `checkout.preview`) has the same loop-then-append-`sellableId` shape, so a both-fields quote/preview is similarly doubled; it is intentionally NOT changed here because (a) it is non-mutating (no reservation/charge — outside this report's double-charge/double-reservation harm), and (b) `createCartQuote` returns a `CartQuoteDTO` with no failure channel, so a clean rejection there is a separate change. Flagging it as a related follow-up. Evidence: a new test puts sellable A (qty 1) in a cart, calls `checkout.start({ cartId, sellableId: A, quantity: 1 })`, and asserts `422 VALIDATION_FAILED` with zero stock reserved and no provider checkout session created; without the guard the same call does not cleanly succeed (it reaches a 409 reservation conflict after partial work), so the early 422 is the clean, correct outcome. Full suite (359) and both tsc configs pass.

DEVANA-KEY: src/api/backend.ts:6135 | checkout-duplicate-cart-sellable
DEVANA-SUMMARY: fixed | P2 | medium | checkout.start now returns 422 when both cartId and sellableId are supplied (mutually exclusive line sources), before any reservation or provider handoff, instead of double-counting the sellable; the non-mutating createCartQuote sibling is noted as a separate follow-up.