DEVANA-FINDING: v1
DEVANA-STATE: open | P1 | medium | security=no
DEVANA-KEY: src/api/backend.ts:4569 | subscription-webhook-reverts-admin-cancel

# Stale subscription webhooks can overwrite admin cancel state

## Finding

After a successful admin `subscription.cancel`, local state becomes `cancel_at_period_end` via `updateSubscriptionAfterAction`. A later or replayed provider webhook with `status: "active"` and the same `currentPeriodStart` passes `subscriptionEventIsStale` and overwrites local status back to `active` in `updateSubscriptionFromEvent`.

## Violated Invariant Or Contract

Locally applied subscription actions should not be regressed by equal-period provider events. Admin cancel sets `cancel_at_period_end`; webhook sync should not restore `active` without a newer billing period.

## Oracle

`subscriptionEventIsStale` only rejects events with strictly older `currentPeriodStart` (`4544-4552`). Admin cancel does not advance `currentPeriodStart`. `updateSubscriptionFromEvent` assigns `status: event.status` directly (`4569`).

## Counterexample

1. Subscription active with `currentPeriodStart = 2025-01-01`.
2. Admin cancel completes; local record `{ status: "cancel_at_period_end", cancelAtPeriodEnd: true }`.
3. Provider redelivers `{ status: "active", currentPeriodStart: "2025-01-01" }`.
4. Webhook processing sets subscription and entitlement status back to active.

## Why It Might Matter

Shoppers see a canceled subscription return to active in account UI and entitlements. This is a distinct failure mode from Stripe immediate cancel vs Mika period-end semantics.

## Proof

State transition mismatch:

- Admin path: `subscriptionStatusAfterAction(..., "cancel")` → `cancel_at_period_end` (`lifecycle.ts:133-137`).
- Webhook path: `updateSubscriptionFromEvent` replaces `status` with `event.status` when not stale.
- `subscriptionEventIsStale` returns false when period starts are equal.

## Counterevidence Checked

Events with older `currentPeriodStart` are ignored. `stripe-cancel-semantics-mismatch` covers provider adapter calling immediate cancel while Mika expects period-end; this report covers webhook replay regressing already-written local cancel state.

## Suggested Next Step

Treat `cancel_at_period_end` as terminal against equal-period `active` events, or compare monotonic subscription revision metadata before applying webhook status downgrades.

## Agent Handoff

After working this report, preserve the original finding body. Update line 2 `DEVANA-STATE: ...` and the final `DEVANA-SUMMARY:` status/priority/confidence prefix. Use one of: `open`, `fixed`, `invalid`, `stale`, `duplicate`, `wontfix`. Keep `DEVANA-KEY:` stable unless the same finding moved. Add dated notes below with evidence checked.

## Status Notes

- 2026-06-29: open by Devana. Initial report written from static source inspection.

DEVANA-KEY: src/api/backend.ts:4569 | subscription-webhook-reverts-admin-cancel
DEVANA-SUMMARY: open | P1 | medium | Equal-period subscription webhooks can set status back to active after admin cancel_at_period_end was already persisted.