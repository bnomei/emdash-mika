DEVANA-FINDING: v1
DEVANA-STATE: fixed | P2 | medium | security=no
DEVANA-KEY: src/api/backend.ts:4368-4406 | subscription-webhook-status-nonmonotonic

# Subscription webhook applies event status unconditionally; a stale/out-of-order event re-activates a cancelled subscription and re-grants entitlement

## Finding

`updateSubscriptionFromEvent` overwrites the subscription status with the event status with no recency, sequence, or version guard:

```ts
// src/api/backend.ts:4374-4391
const updated: SubscriptionDocument = {
  ...subscription,
  status: event.status,            // line 4378
  ...
  aggregate: { ...subscription.aggregate, status: event.status, ... },  // line 4391
};
await input.repositories.account.put(updated);
```

`processSubscriptionWebhook` (`backend.ts:4257-4283`) then derives the entitlement from the new status via `updateSubscriptionEntitlement` (`cancelled`→`expired`, `active`→`active`, `entitlementStatusForSubscription`). Unlike `processPaymentWebhook` (wrapped in `runPaymentWebhookWorkflow` with a per-webhook lease), the subscription path has no lease and no per-subscription serialization, and `account.put` is a plain last-writer-wins.

## Violated Invariant Or Contract

Subscription state must move monotonically with provider event recency: a terminal/cancel state must not be overwritten by an older (or concurrently delivered) `active`/`trialing` event, and the derived entitlement must not be re-granted as a result.

## Oracle

After a `cancelled` event is applied, processing an event whose status is `active` but which describes an earlier period must not re-activate the subscription or its entitlement. The code compares no `currentPeriodStart/End`, sequence number, or timestamp before assignment.

## Counterexample

1. Subscription S is `active`.
2. Provider sends `customer.subscription.deleted` (status `cancelled`). `updateSubscriptionFromEvent` sets `status="cancelled"`; entitlement → `expired`.
3. A previously queued/redelivered `customer.subscription.updated` (status `active`, older period) arrives with a different `providerEventId` (so the `backend.ts:3253` dedup does not catch it). `updateSubscriptionFromEvent` sets `status="active"` and `updateSubscriptionEntitlement` re-grants entitlement `active`.

Result: a cancelled customer regains active entitlement. Concurrent delivery of `cancelled` + `active` races to the same outcome via last-writer-wins.

## Why It Might Matter

Cancelled/expired subscribers can silently regain paid access (downloads, license keys, gated content) due to provider event redelivery or out-of-order delivery, which providers like Stripe explicitly do not guarantee against.

## Proof

Event-order / state-transition trace to an invalid state: `updateSubscriptionFromEvent` is a read-modify-`put` with `status: event.status` and no ordering guard; no lease serializes concurrent deliveries.

## Counterevidence Checked

- "Providers deliver in order, so stale-`active` is rare." Evidence against: providers (e.g. Stripe) do not guarantee event ordering; redelivery of older events is common; and the missing lease means even simultaneous deliveries race. No code path compares event recency.
- `providerEventId` dedup (`backend.ts:3253`) only blocks exact replays of the *same* event, not a different older event.

## Suggested Next Step

Guard the status write by event recency (compare `event.currentPeriodStart`/a provider sequence/`created` timestamp against the stored subscription) and/or serialize subscription webhook processing per subscription with a lease, as the payment webhook path does.

## Agent Handoff

Preserve the original finding body. Update line 2 `DEVANA-STATE:` and the final `DEVANA-SUMMARY:` prefix. Keep `DEVANA-KEY:` stable unless the finding moved.

## Status Notes

- 2026-06-27: open by Devana. Verified backend.ts:4368-4406 unconditional status write; 4257-4283 no lease; entitlement derived from status.
- 2026-06-27: fixed. Confirmed `updateSubscriptionFromEvent` wrote `event.status` (and re-derived the entitlement) with no recency guard, so a redelivered/out-of-order `active` event for an older period could revert a `cancelled` subscription and re-grant access. Fix: new `subscriptionEventIsStale(subscription, event)` guard compares the event's `currentPeriodStart` against the applied `aggregate.currentPeriodStart` (the only recency signal the parsed event carries) and, when the event is strictly older, `updateSubscriptionFromEvent` returns the subscription unchanged (no write); the downstream entitlement derivation then runs on the non-regressed status, so no re-grant. When either side lacks `currentPeriodStart` the event is applied as before. Added regression test `ignores a stale out-of-order subscription event so a cancelled sub is not re-activated` (active@Feb → cancelled@Feb → stale active@Jan with a distinct providerEventId → subscription stays cancelled, entitlement stays expired). Typecheck + 327 tests pass.
  - Scope note: this guards the documented out-of-order/redelivery case (older period). It does NOT serialize truly concurrent same-period deliveries (cancel + active sharing one `currentPeriodStart`); a per-subscription lease like the payment workflow would be needed for that and is left as a follow-up since the parsed event carries no provider sequence/created timestamp.

DEVANA-KEY: src/api/backend.ts:4368-4406 | subscription-webhook-status-nonmonotonic
DEVANA-SUMMARY: fixed | P2 | medium | Subscription webhook wrote event.status with no recency guard, so a stale/redelivered active event reverted a cancelled subscription and re-granted entitlement. Fixed with a currentPeriodStart recency guard that drops older-period events, with a regression test. Same-period concurrency (needs a lease) noted as follow-up.
