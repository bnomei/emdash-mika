DEVANA-FINDING: v1
DEVANA-STATE: duplicate | P1 | high | security=no
DEVANA-KEY: src/api/backend.ts:1582-1587 | subscription-action-ignores-provider-result

# Subscription cancel/renew/change ignores provider result and re-grants entitlement even when the adapter did nothing

## Finding

`runSubscriptionAction` invokes the provider method and discards its return value, then mutates local state unconditionally:

```ts
// src/api/backend.ts:1582-1587
async () => {
  await providerFeature.method.call(providerFeature.provider, providerInput);
  await updateSubscriptionAfterAction(input, ctx, subscription, action, priceMatch);
  return accountDTOForCustomer(input, ctx, identity.customer);
},
```

`MikaProviderAdapter.cancel/renew/changeSubscription` return `Promise<AdminActionResultDTO>` whose `status` is `completed` | `unsupported` | `failed`. The return value is never bound, so `updateSubscriptionAfterAction` (`backend.ts:1592-1643`) always runs: it sets a new status via `subscriptionStatusAfterAction` (renew→`active`, `lifecycle.ts:113-117`), persists `account.put`, then `updateSubscriptionEntitlement` writes the entitlement (`status = entitlementStatusForSubscription("active")` → active, `backend.ts:4408-4458`) and emits a lifecycle notification.

## Violated Invariant Or Contract

A provider action that did not take effect (`status:"unsupported"`/`"failed"` returned without throwing) must not cause the backend to mutate subscription state or grant/keep entitlements as if it succeeded.

## Oracle

The adapter contract: `unsupportedAction(...)`/`completedAction(...)` in `src/stripe.ts` return a DTO `status` rather than throwing (`stripe.ts:510-515`, `535-537`). The runner `runAdminAction` (`backend.ts:2448-2477`) treats only a thrown error as failure. The subscription callback goes further and never reads the DTO at all.

## Counterexample

Provider `subscriptions` API not wired, or `providerSubscriptionId` absent:

1. Host configures Stripe but not `options.stripe.subscriptions` (optional). `requireProviderFeature` (`backend.ts:1534-1540`) checks only that the *method* exists on the adapter — the Stripe adapter always defines `renewSubscription`, so the guard passes.
2. Admin invokes subscription renew. `renewStripeSubscription` hits `if (!options.stripe.subscriptions || !input.providerSubscriptionId) return unsupportedAction(...)` (`stripe.ts:535-537`) and returns `unsupported` with **no Stripe call**.
3. Back in `backend.ts:1583`, the DTO is thrown away; `updateSubscriptionAfterAction` reactivates the subscription locally (`status:"active"`) and `updateSubscriptionEntitlement` re-grants the customer's entitlement.

Net: the subscription is reactivated and paid access is (re)granted with no provider renewal/charge. The same ignored-DTO path applies to `change` (`stripe.ts:510-515`, missing price id) and `cancel` (`stripe.ts:255-266`, missing sub id), and to any provider that returns `failed`/`unsupported` without throwing.

## Why It Might Matter

Customers can retain or regain active subscription entitlements (downloads, license keys, gated access) without a corresponding provider state change or payment. Admin UI reports HTTP 200 success.

## Proof

Producer/consumer contract mismatch with a concrete reachable failure branch: producer returns `status:"unsupported"` after doing nothing (`stripe.ts:535-537`); consumer (`backend.ts:1583`) discards it and applies success-only side effects (state change + entitlement grant + notification).

## Counterevidence Checked

- "`providerSubscriptionId` is always present, so the unsupported branch is unreachable." Evidence against: the consumer treats it as optional (`backend.ts:1559-1566`, `...(providerSubscriptionId ? {...} : {})`) and the adapter guards (`stripe.ts:256,535`) exist precisely for the absent case; `requireProviderFeature` never validates the id. The branch is reachable by design.
- This is distinct from the excluded `backend.ts:1757-1766` admin-refund finding: there the runner at least surfaces a thrown failure and the side effect is a ledger write; here the DTO is never inspected at all and the side effect is entitlement reactivation.

## Suggested Next Step

Capture the returned `AdminActionResultDTO`, and only run `updateSubscriptionAfterAction`/entitlement grant when `status === "completed"`; surface `unsupported`/`failed` to the caller.

## Agent Handoff

Preserve the original finding body. Update line 2 `DEVANA-STATE:` and the final `DEVANA-SUMMARY:` prefix. Keep `DEVANA-KEY:` stable unless the finding moved.

## Status Notes

- 2026-06-27: open by Devana. Verified backend.ts:1582-1587 discards provider DTO; stripe.ts:535-537 returns unsupported without calling Stripe; updateSubscriptionAfterAction grants entitlement unconditionally.
- 2026-06-27: marked duplicate. A concurrent Devana run wrote the canonical report `20260627T143837Z-P1-subscription-action-ignores-provider.md` (same DEVANA-KEY src/api/backend.ts:1582-1587) before this one landed. Track the fix there; this report adds the entitlement-regrant emphasis as supporting detail.

DEVANA-KEY: src/api/backend.ts:1582-1587 | subscription-action-ignores-provider-result
DEVANA-SUMMARY: duplicate | P1 | high | Subscription cancel/renew/change discards the provider AdminActionResultDTO and reactivates the subscription + re-grants entitlement even when the adapter returns unsupported/failed without calling the provider.
