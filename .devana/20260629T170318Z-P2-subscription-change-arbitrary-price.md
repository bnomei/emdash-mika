DEVANA-FINDING: v1
DEVANA-STATE: open | P2 | medium | security=no
DEVANA-KEY: src/api/backend.ts:1604 | subscription-change-arbitrary-price

# `subscription.change` repoints a subscription to any provider-mapped price (different product, cheaper amount, one-time, other currency) with no target validation

## Finding

`runSubscriptionAction` (`src/api/backend.ts:1569`), for `action === "change"`, validates the target price only by existence and provider mapping:

```
const priceMatch = action === "change" && actionInput.priceId
  ? await input.repositories.catalog.findPriceById(actionInput.priceId)   // line 1606
  : null;
if (action === "change" && actionInput.priceId && !priceMatch) {           // line 1608 — exists?
  return validationFailed("priceId", ...);
}
const providerPriceId = priceMatch?.price.providerRefs.find(
  (ref) => ref.provider === subscription.provider,                         // line 1612 — provider-mapped?
)?.priceId ?? ...;
if (action === "change" && actionInput.priceId && !providerPriceId) {      // line 1615
  return providerUnsupportedForAction(...);
}
```

There is **no** check that the target price's `mode === "subscription"` (vs a one-time `"payment"` price), no `interval` check, no currency-equality check, and no check that the price/sellable belongs to the subscription's current product/plan family. The input schema validates only `subscriptionId` + optional `priceId` (`src/api/validation.ts`). `updateSubscriptionAfterAction` then replaces `subscription.aggregate.sellable` **wholesale** with `snapshotPrice(priceMatch.sellable/price/content)` (`src/api/backend.ts:1671-1678`).

## Violated Invariant Or Contract

A subscription `change` target must belong to the same plan/product family and be a recurring (subscription) price. A customer must not be able to self-serve a repoint of their subscription to an unrelated or cheaper price.

## Oracle

The change branch resolves the target only by `findPriceById` + same-provider `providerRefs` mapping; `PurchaseMode = "payment" | "subscription"` and `interval` exist on the price aggregate but are never consulted, and there is no plan-family/ownership comparison against the current subscription's sellable.

## Counterexample

A customer owns a "Premium Plan" subscription (`mode: "subscription"`, `interval: "month"`, $50). They call `subscription.change({ subscriptionId, priceId: <basicCheaperPlan> })` where `basicCheaperPlan` is any catalog price mapped to the same provider — e.g. a different product's recurring price at $1:
1. `findPriceById` returns it (exists); it has a `providerRefs` entry for the subscription's provider (lines 1606-1619). Both gates pass.
2. Provider `changeSubscription` accepts the swap to that recurring price and returns `{status: "completed"}`.
3. `updateSubscriptionAfterAction` replaces the subscription's `sellable` with the $1 product (lines 1671-1678).
4. The customer is now subscribed to an unrelated, cheaper plan they were never offered as an upgrade/downgrade path.

## Why It Might Matter

Self-serve price/plan manipulation: a customer can move their subscription to any provider-mapped price in the catalog, including a much cheaper or unrelated product — a billing/revenue and authorization gap.

## Proof

Missing-target-validation / authorization gap: the only target checks are existence (line 1606) and same-provider mapping (line 1612); no mode/interval/currency/plan-family/ownership constraint before the sellable is replaced (lines 1671-1678).

## Counterevidence Checked

- The provider's `changeSubscription` might reject incompatible targets (e.g. a one-time `payment` price, or a different-currency price) and return non-`"completed"`, throwing before persistence (`backend.ts:1646-1651`). But Stripe-style providers accept switching a subscription item to any **recurring** price regardless of the merchant's intended plan family, so the cross-product cheaper-recurring-price case is reachable; the library itself enforces nothing.
- The target must be a catalog price the merchant mapped to that provider (so not arbitrary attacker data) — but that still includes every other plan/product the merchant sells, which is the abuse surface.
- Distinct from `coupon-provider-charge-mismatch` and `quote-coupon-checkout-mismatch` (coupon pricing) — this is the subscription `change` target-selection gap.

## Suggested Next Step

Validate the `change` target before dispatch: require `priceMatch.price.mode === "subscription"`, a matching `interval`/currency, and that the price/sellable belongs to the subscription's current plan family (or an explicitly allowed upgrade/downgrade set).

## Agent Handoff

After working this report, preserve the original finding body. Update line 2 `DEVANA-STATE:` and the final `DEVANA-SUMMARY:` prefix. Keep `DEVANA-KEY:` stable unless the same finding moved.

## Status Notes

- 2026-06-29: open by Devana. Verified target resolution (backend.ts:1604-1619) checks only existence + provider mapping, and `updateSubscriptionAfterAction` replaces the sellable wholesale (1671-1678).

DEVANA-KEY: src/api/backend.ts:1604 | subscription-change-arbitrary-price
DEVANA-SUMMARY: open | P2 | medium | `subscription.change` validates the target price only by existence and same-provider mapping, so an authenticated customer can repoint their subscription to any provider-mapped price — a different, cheaper, or one-time product — with no plan-family/mode/currency check.
