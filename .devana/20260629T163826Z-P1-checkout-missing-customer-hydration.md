DEVANA-FINDING: v1
DEVANA-STATE: open | P1 | high | security=no
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

DEVANA-KEY: src/api/backend.ts:813 | checkout-missing-customer-hydration
DEVANA-SUMMARY: open | P1 | high | Magic-link session customerId is hydrated for cart but not checkout, orphaning paid orders from account history.