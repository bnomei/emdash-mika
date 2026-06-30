DEVANA-FINDING: v1
DEVANA-STATE: fixed | P1 | medium | security=no
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
- 2026-06-30: fixed (chosen approach: a sticky-cancel guard inside `updateSubscriptionFromEvent`, NOT a change to `subscriptionEventIsStale`). Root cause confirmed: an admin `subscription.cancel` sets local status `cancel_at_period_end` WITHOUT advancing `currentPeriodStart`, so the period-based staleness check (`subscriptionEventIsStale`, only rejects a strictly-OLDER period) cannot protect it, and `updateSubscriptionFromEvent` assigned `status: event.status` directly — so any equal-period `active` event reactivated the sub. Confirmed the bug is BROADER than the report framing: besides (A) the report's replayed pre-cancel event `{ active, cancelAtPeriodEnd:false, same period }`, scenario (B) is the provider's OWN routine echo — Stripe represents a period-end cancel as `status:"active"` + `cancel_at_period_end:true` (`stripe.ts` maps the raw status and the flag as separate fields), so the normal `customer.subscription.updated` webhook is `{ active, cancelAtPeriodEnd:true, same period }` and ALSO regressed the top-level status to `active`. A single guard handles both. Fix: after the staleness early-return, derive `eventAdvancesPeriod` (event period strictly newer than the applied period) and `preserveLocalCancel = subscription.status === "cancel_at_period_end" && event.status === "active" && !eventAdvancesPeriod`; when set, force `status = "cancel_at_period_end"` and `cancelAtPeriodEnd = true` for both the top-level and aggregate fields (replacing the two `event.status` assignments and the `cancelAtPeriodEnd ??` fallback). Only a period-ADVANCING `active` event (a genuine renewal — un-cancels) or a non-`active`/terminal status (`cancelled`, `expired`, `past_due`, …) can now move a sub off `cancel_at_period_end`. ENTITLEMENT NEEDS NO FIX: `entitlementStatusForSubscription` already maps both `cancel_at_period_end` and `active` to entitlement status `"active"`, so the regression never actually changed entitlement access — it was a subscription-status/UI integrity (and notification) bug. (Precise notification effect: `emitSubscriptionLifecycleNotification` still fires a routine `subscription.updated` intent on every processed webhook; what the guard removes is the spurious status-CHANGE signal that intent would otherwise carry — the `previousStatus: cancel_at_period_end → active` reactivation — because `previous.status` now equals the preserved updated status.) Evidence: two new tests in `test/backend.test.ts` (next to the existing strictly-older "ignores a stale out-of-order subscription event" test, which covers a different case — a fully `cancelled` sub vs an OLDER-period active event): (1) seeds a `cancel_at_period_end` sub at period X and drives two equal-period `active` redeliveries — the `cancelAtPeriodEnd:false` replay AND the `cancelAtPeriodEnd:true` echo — asserting the stored sub stays `cancel_at_period_end` with `cancelAtPeriodEnd:true` after each; (2) guard-not-too-aggressive — a NEWER-period `active` event reactivates the sub to `active`/`cancelAtPeriodEnd:false`. Mutation-verified: with the guard neutered to `status: event.status` (cp-backup + restore, no git checkout), test (1) FAILS (status flips to `active`) while test (2) still PASSES; restored and re-confirmed green. Full suite (373) and both tsc configs pass. Out of scope (NOT changed, documented): the broader "fold" of an ADVANCING-period `active` + `cancelAtPeriodEnd:true` (renewed-but-cancel-pending-for-the-new-period) into `cancel_at_period_end` — that combination does not arise for a `cancel_at_period_end` sub in normal flows (it cancels, it does not renew), and folding it would change the status representation broadly and risk existing tests; and reactivation of a fully `cancelled`/`expired` LOCAL sub by an equal-period `active` event — the report and its counterexample are scoped to `cancel_at_period_end`, and the same guard pattern could be extended to other locally-terminal statuses as a follow-up if needed. Accepted trade-off (no content-based fix available, surfaced by review): an out-of-band provider-side un-cancel within the SAME period (e.g. via the Stripe dashboard or customer portal, while local status is still `cancel_at_period_end`) produces a payload byte-identical to scenario (A) `{ active, cancelAtPeriodEnd:false, same period }`, so the guard now also holds that subscription at `cancel_at_period_end` until the next period boundary. This is intentional and safe: `MikaProviderSubscriptionEvent` carries no event timestamp/sequence (only an opaque `providerEventId`), so a stale replay and a genuine same-period un-cancel are indistinguishable by content; entitlement access is preserved throughout (both statuses map to entitlement `active`); and it self-heals at the next renewal (newer period → `eventAdvancesPeriod` → reactivates). Possible follow-up: plumb a provider event timestamp/sequence number through `MikaProviderSubscriptionEvent` to disambiguate same-period un-cancels from stale replays.

DEVANA-KEY: src/api/backend.ts:4569 | subscription-webhook-reverts-admin-cancel
DEVANA-SUMMARY: fixed | P1 | medium | A sticky-cancel guard in updateSubscriptionFromEvent now keeps a locally-applied cancel_at_period_end against equal-/unknown-period active webhooks (both the stale pre-cancel replay and Stripe's own active+cancel_at_period_end echo); only a period-advancing renewal or a terminal status can reactivate it. Entitlement access was unaffected (both statuses map to entitlement active), so no entitlement change was needed.