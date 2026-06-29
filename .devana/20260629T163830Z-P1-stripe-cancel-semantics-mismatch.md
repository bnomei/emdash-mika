DEVANA-FINDING: v1
DEVANA-STATE: fixed | P1 | medium | security=no
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
- 2026-06-29: fixed (report's first suggested approach). The Stripe adapter's `cancelSubscription` now calls `subscriptions.update(providerSubscriptionId, { cancel_at_period_end: true })` instead of the immediate `subscriptions.cancel(...)`, mirroring how `changeStripeSubscription`/`renewStripeSubscription` already use `subscriptions.update`. This aligns the provider with Mika's lifecycle: `subscriptionStatusAfterAction("cancel")` → `cancel_at_period_end`, which `entitlementStatusForSubscription` treats as still-active until period end. The subscription remains active at Stripe (now flagged to cancel at period end), so provider access and local entitlement stay consistent; when the period ends Stripe emits `customer.subscription.deleted`, which `updateSubscriptionFromEvent` reconciles to the terminal cancelled state and revokes the entitlement. The existing `if (!options.stripe.subscriptions || !input.providerSubscriptionId)` guard and the `completedAction` return are unchanged (message reworded to "set to cancel at period end"). No lifecycle/entitlement code changed — only the adapter call. Scope: Stripe provider subscription cancel. Evidence: a new Stripe-adapter test asserts cancel calls `subscriptions.update(id, { cancel_at_period_end: true })` and does NOT call `subscriptions.cancel`; it was confirmed to fail before the change. Full suite (357) and both tsc configs pass.

DEVANA-KEY: src/stripe.ts:274 | stripe-cancel-semantics-mismatch
DEVANA-SUMMARY: fixed | P1 | medium | Stripe cancelSubscription now schedules cancel-at-period-end via subscriptions.update instead of immediate subscriptions.cancel, matching Mika's cancel_at_period_end lifecycle so provider access and entitlement stay consistent until period end.