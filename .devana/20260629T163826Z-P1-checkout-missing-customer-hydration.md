DEVANA-FINDING: v1
DEVANA-STATE: fixed | P1 | high | security=no
DEVANA-KEY: src/api/backend.ts:813 | checkout-missing-customer-hydration

# checkout.start omits session customerId hydration after magic-link login

## Finding

Cart and wishlist APIs wrap handlers with `withHydratedCustomerContext`, which reads `mika.customerId` from the session via `withEffectiveCustomer`. Checkout handlers are registered without this wrapper. `startCheckout` persists `customerId: ctx.customerId`, which Astro actions and route handlers never populate from session storage.

## Violated Invariant Or Contract

After `magicLink.verify` sets `mika.customerId` on the session, checkout and order attribution must bind to that customer the same way cart operations do.

## Oracle

`verifyMagicLink` writes session customer id. Cart backend uses `withHydratedCustomerContext` (~1057). Checkout namespace is wired directly (~813–822). `createPaymentOrderDocument` copies `checkout.customerId` (~4841). `listOrdersByCustomer` filters by `customerId`.

## Counterexample

1. User verifies magic link in browser session → `session.set("mika.customerId", ...)`.
2. User submits checkout form in same session (no explicit `customerId` on context).
3. `checkout.start` resolves cart and persists checkout/order with `customerId: undefined`.
4. `account.get` shows customer profile but not the new paid order.

## Why It Might Matter

Orders orphaned from account history; broken post-purchase account flows for magic-link shoppers.

## Proof

**Cross-entry mismatch:** cart ops hydrate session customer; checkout ops do not.

**Dataflow trace:** `verifyMagicLink` → session `mika.customerId` → `actionRequestContext` (no `customerId`) → `startCheckout` → order without `customerId`.

Locations: `src/api/backend.ts` (`withHydratedCustomerContext` ~6610–6623, checkout ~813–822, `startCheckout` ~6019–6021, `createPaymentOrderDocument` ~4841), `src/astro-actions.ts` (`actionRequestContext`).

## Counterevidence Checked

`checkoutBelongsToContext` uses `effectiveCustomerId` for status/cancel access only, not cart selection or persistence. Host middleware could inject `customerId` into context, but no in-package call site does.

## Suggested Next Step

Wrap checkout handlers with `withHydratedCustomerContext`, or call `withEffectiveCustomer` inside `startCheckout` before cart lookup and persistence.

## Agent Handoff

After working this report, preserve the original finding body. Update line 2 `DEVANA-STATE: ...` and the final `DEVANA-SUMMARY:` status/priority/confidence prefix.

## Status Notes

- 2026-06-29: open by Devana. Initial report written from static source inspection across dataflow-boundaries and outside-in-entrypoints trails.
- 2026-06-29: fixed. The `checkout` namespace is now wrapped with `withHydratedCustomerContext({ ... })` — identical to `cart` (~1085) and `wishlist` — so every checkout handler runs `withEffectiveCustomer` first, hydrating `ctx.customerId` from the session's `mika.customerId` before `startCheckout` resolves the cart and persists the checkout document. The persisted `CheckoutDocument.customerId` (backend.ts:6135) therefore binds to the magic-link customer, and `createPaymentOrderDocument` copies it onto the order, so paid orders show up in `account.get` history. Scope: only the wiring at the namespace boundary changed; handler internals are untouched. Evidence: a regression test logs in via `session.set("mika.customerId", ...)` on a session-bound cart, starts checkout with no explicit context customerId, and asserts the persisted checkout document carries that customerId; full suite (225) and both tsc configs pass.

DEVANA-KEY: src/api/backend.ts:813 | checkout-missing-customer-hydration
DEVANA-SUMMARY: fixed | P1 | high | Wrapped the checkout namespace in withHydratedCustomerContext so magic-link session customerId hydrates into the persisted checkout document and order, matching cart/wishlist and keeping paid orders in account history.