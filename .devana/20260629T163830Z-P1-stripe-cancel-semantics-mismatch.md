DEVANA-FINDING: v1
DEVANA-STATE: open | P1 | medium | security=no
DEVANA-KEY: src/stripe.ts:274 | stripe-cancel-semantics-mismatch

# Stripe subscription cancel is immediate; Mika lifecycle expects cancel-at-period-end

## Finding

The Stripe provider adapter calls `subscriptions.cancel` (immediate termination). `subscriptionStatusAfterAction` maps the `cancel` action to `cancel_at_period_end`. `updateSubscriptionAfterAction` persists lifecycle status and refreshes entitlement without reading the provider response. Entitlements remain `active` for `cancel_at_period_end` per `entitlementStatusForSubscription`.

## Violated Invariant Or Contract

`subscription.cancel` should align local status, provider state, and entitlement access. Lifecycle rules treat `cancel_at_period_end` as still-active access until period end.

## Oracle

`subscriptionStatusAfterAction("cancel")` → `cancel_at_period_end` (`lifecycle.ts` ~137). Stripe adapter `cancelSubscription` uses immediate `subscriptions.cancel` (`stripe.ts` ~279). Entitlement refresh follows local status, not provider.

## Counterexample

1. Subscription `active`, entitlement `active`.
2. Customer `subscription.cancel` with Stripe provider.
3. Stripe subscription immediately `canceled`.
4. Mika persists `status: cancel_at_period_end`, entitlement stays `active`.
5. Provider billing/access already terminated; local records show pending-cancel with active entitlement until webhook reconciliation.

## Why It Might Matter

Customers lose provider access while Mika shows active entitlement; support and renewal flows diverge until a later webhook.

## Proof

**Contract mismatch:** provider adapter immediate cancel vs lifecycle `cancel_at_period_end` semantics.

Locations: `src/stripe.ts` (`cancelSubscription` ~274–284), `src/api/lifecycle.ts` (`subscriptionStatusAfterAction` ~133–140), `src/api/backend.ts` (`updateSubscriptionAfterAction`, `entitlementStatusForSubscription`).

## Counterevidence Checked

`updateSubscriptionFromEvent` eventually reconciles from `customer.subscription.*` webhooks. That limits the inconsistency window but does not fix adapter semantics at cancel time.

## Suggested Next Step

Use Stripe cancel-at-period-end API or map immediate cancel to `cancelled` status and revoked/reduced entitlement locally.

## Agent Handoff

After working this report, preserve the original finding body. Update line 2 `DEVANA-STATE: ...` and the final `DEVANA-SUMMARY:` status/priority/confidence prefix.

## Status Notes

- 2026-06-29: open by Devana. Initial report written from static source inspection across invariants-contracts and contracts-errors trails.

DEVANA-KEY: src/stripe.ts:274 | stripe-cancel-semantics-mismatch
DEVANA-SUMMARY: open | P1 | medium | Stripe immediate subscription cancel conflicts with Mika cancel_at_period_end status and active entitlement rules.