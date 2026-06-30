DEVANA-FINDING: v1
DEVANA-STATE: fixed | P2 | medium | security=no
DEVANA-KEY: src/api/lifecycle.ts:138 | subscription-renew-revives-terminal

# `subscription.renew` revives a terminal (cancelled/expired) subscription to `active` with a stale period and re-granted entitlement

## Finding

`runSubscriptionAction` (`src/api/backend.ts:1569`) handles `cancel`/`change`/`renew` with only two gates: an authenticated-owner check (lines 1575-1593) and a `requireProviderFeature` capability check (lines 1596-1602). There is **no `subscription.status` guard**. For `renew`, `subscriptionStatusAfterAction` returns `"active"` unconditionally:

```
if (action === "renew") return "active";   // src/api/lifecycle.ts:138
```

`updateSubscriptionAfterAction` (`src/api/backend.ts:1661`) then persists `status: "active"`, copies `currentPeriodEnd: subscription.currentPeriodEnd` **unchanged** (line 1687), clears `cancelAtPeriodEnd` to `false`, and calls `updateSubscriptionEntitlement` (line 1706) which re-grants the entitlement.

## Violated Invariant Or Contract

`"cancelled"` and `"expired"` are terminal `SubscriptionStatus` values (`src/types/primitives.ts`); they must not transition back to `"active"` without establishing a new billing period. Renew should only apply to a still-renewable subscription.

## Oracle

The state model: `subscriptionStatusAfterAction` encodes `cancel → cancel_at_period_end`, but `renew → active` with no source-state precondition, contradicting the terminal nature of `cancelled`/`expired`. `updateSubscriptionEntitlement` re-activates access off that status.

## Counterexample

A subscription with `status: "expired"`, `currentPeriodEnd` in the past (e.g. `2025-01-01`), `cancelAtPeriodEnd: true`. The authenticated owner calls `subscription.renew({ subscriptionId })` (`src/api/backend.ts:842`):
1. Ownership + provider-feature checks pass; no status check (lines 1575-1602).
2. Provider `renewSubscription` returns `{status: "completed"}`.
3. `updateSubscriptionAfterAction`: status → `"active"` (lifecycle.ts:138), `currentPeriodEnd` stays `2025-01-01` (line 1687), entitlement re-granted (line 1706).
4. Result: an `"active"` subscription whose period already ended, with the entitlement revived — a state the cancel/expire flow is meant to make terminal.

## Why It Might Matter

A customer (or stale client) can resurrect a dead subscription's entitlement without a valid billing period, granting digital access the cancel/expire lifecycle was supposed to terminate.

## Proof

State-transition mismatch: terminal `expired`/`cancelled` → `active` with an unchanged past `currentPeriodEnd` and a re-granted entitlement, performed with no source-state guard (`backend.ts:1569-1659` + `lifecycle.ts:138` + `backend.ts:1687/1706`).

## Counterevidence Checked

- The configured provider's `renewSubscription` may reject a fully-cancelled/deleted subscription and return a non-`"completed"` status, which throws at `backend.ts:1646-1651` before `updateSubscriptionAfterAction` runs — so local revival depends on provider behavior. But the library's own state model has zero guard, so a lenient/mock provider (or a provider that treats renew as "create a new period") triggers the bad local transition.
- Distinct from `subscription-webhook-reverts-admin-cancel` (a webhook path) and `stripe-cancel-semantics-mismatch` (the cancel action) — this is the user-facing `renew` account action with no status precondition.
- Strongest false-positive reason: if renew is only ever reachable for active subscriptions in practice. It is a public account action (`backend.ts:842`) callable with any owned `subscriptionId`, including terminal ones.

## Suggested Next Step

Guard `renew` (and `change`) on the current `subscription.status`: reject when the subscription is `expired`/`cancelled` (or require the provider result to supply a fresh `currentPeriodEnd` before marking `active`), so a terminal subscription cannot be revived with a stale period.

## Agent Handoff

After working this report, preserve the original finding body. Update line 2 `DEVANA-STATE:` and the final `DEVANA-SUMMARY:` prefix. Keep `DEVANA-KEY:` stable unless the same finding moved.

## Status Notes

- 2026-06-29: open by Devana. Verified no status guard in `runSubscriptionAction` (backend.ts:1569-1659), `renew → "active"` unconditional (lifecycle.ts:138), stale `currentPeriodEnd` copy (backend.ts:1687), entitlement re-grant (1706).
- 2026-06-30: fixed (chosen approach: source-status guard, the report's Suggested Next Step). `runSubscriptionAction` had only an owner check and a provider-capability check — no `subscription.status` precondition — so any owned terminal subscription could be acted on. Added a guard immediately after the found+owned check (before the provider-feature call and before any price validation): if `subscription.status` is `"cancelled"` or `"expired"`, return `409 VALIDATION_FAILED` (`Subscription '<id>' is <status> and cannot be modified.`) and do nothing else. This blocks the headline `renew → active` revival AND the symmetric `cancel` revival I confirmed while fixing: `subscriptionStatusAfterAction("cancelled"/"expired", "cancel")` returns `"cancel_at_period_end"`, which would resurrect a dead sub to active-until-period-end; `change` would mutate a dead record's price. The guard fires before the provider is contacted, so no provider call is made and the stored subscription is left byte-for-byte unchanged. Scope: only the terminal-state path is rejected; active/trialing/past_due/cancel_at_period_end renew/change/cancel are untouched. Evidence: a new test seeds cancelled+expired subscriptions with a provider that fully supports cancel/change/renew (so a 409 proves the TERMINAL guard fired, not PROVIDER_UNSUPPORTED) and asserts 409 + the message, that the provider method was never called, and that the persisted document is unchanged. Mutation-verified: replacing the guard condition with `if (false)` lets the action proceed and the test fails (cp-backup + restore, no git). Full suite (404) and both tsc configs pass.

DEVANA-KEY: src/api/lifecycle.ts:138 | subscription-renew-revives-terminal
DEVANA-SUMMARY: fixed | P2 | medium | `runSubscriptionAction` now guards on source status: a `cancelled`/`expired` subscription rejects cancel/change/renew with 409 before any provider call, so a terminal subscription can no longer be revived (renew → active, or cancel → cancel_at_period_end) or have its dead record's price changed. Active/trialing/past_due/cancel_at_period_end paths are untouched. New cancelled+expired test (provider supports the actions, so 409 proves the guard, not unsupported); mutation-verified; stored doc left unchanged.
