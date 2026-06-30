DEVANA-FINDING: v1
DEVANA-STATE: fixed | P1 | high | security=no
DEVANA-KEY: src/stripe.ts:606 | stripe-refund-pending-completed

# Stripe pending refunds map to completed in Mika

## Finding

`refundStripePayment` maps any Stripe refund status other than `"failed"` to `"completed"`. Stripe refunds commonly return `"pending"` while processing. Mika then updates the local order ledger to `refunded` / `partially_refunded` before the refund is actually settled.

## Violated Invariant Or Contract

`order.refund` should only persist refunded payment state when the provider confirms the refund completed. `AdminActionResultDTO.status: "completed"` should not be emitted for pending provider operations.

## Oracle

`refundOrder` gates ledger mutation on `result.status === "completed"` (`backend.ts:1828-1834`). Stripe refund object `status` includes `pending`, `succeeded`, `failed`, and `canceled`.

## Counterexample

1. Admin calls `order.refund` on a paid order.
2. Stripe `refunds.create` returns `{ id: "re_1", status: "pending" }`.
3. `refundStripePayment` returns `{ status: "completed" }` (`stripe.ts:606`).
4. `updateOrderAfterRefund` runs and `ledger.put` sets `paymentStatus: "refunded"`.

## Why It Might Matter

Orders appear fully refunded in Mika while Stripe may still fail or require action; entitlements and support workflows can diverge from actual payment state.

## Proof

Contract mismatch: callee maps `pending` → `completed`; caller treats `completed` as postcondition for ledger write.

## Counterevidence Checked

Only `"failed"` is treated as failure. No async webhook reconciliation for refund status was found in scoped paths.

## Suggested Next Step

Map Stripe `pending` to `queued` or `running` and defer ledger mutation until `succeeded`, or poll/webhook before completing.

## Agent Handoff

After working this report, preserve the original finding body. Update line 2 `DEVANA-STATE: ...` and the final `DEVANA-SUMMARY:` status/priority/confidence prefix. Use one of: `open`, `fixed`, `invalid`, `stale`, `duplicate`, `wontfix`. Keep `DEVANA-KEY:` stable unless the same finding moved. Add dated notes below with evidence checked.

## Status Notes

- 2026-06-29: open by Devana. Initial report written from static source inspection.
- 2026-06-30: fixed (chosen approach = the report's Suggested Next Step: map `pending` to an in-flight status and let the caller defer the ledger mutation). `refundStripePayment` (`src/stripe.ts`) previously mapped EVERY non-`"failed"` Stripe refund status to `"completed"` — including the very common `"pending"` (refunds settle asynchronously). `refundOrder` (`src/api/backend.ts:1890-1907`) writes the refunded ledger state (`updateOrderAfterRefund` + `ledger.put`) AND — for a FULL refund (`updated.status === "refunded"`, backend.ts:1899; partial refunds retain access) — revokes entitlement/license fulfillment access, both gated on `result.status === "completed"`, so a `pending` refund flipped the order to refunded (and, when full, revoked access) before the money actually moved. Fix: a new `stripeRefundActionStatus(status)` helper maps `succeeded` → `completed`, `failed`/`canceled` → `failed`, and everything else (`pending`, `requires_action`, null/unknown) → `running`; `refundStripePayment` now returns `status: stripeRefundActionStatus(refund.status)`. Only a Stripe-confirmed `succeeded` writes the refunded ledger. For a non-`completed` result `refundOrder` returns the action result as-is WITHOUT mutating the ledger (the admin sees `running`), so the order stays paid until the refund settles. No double-refund-on-retry is introduced: `runAdminAction` (`backend.ts:2788-2796`) calls `completeAdminAudit` on any non-throwing result and caches `data`, so a retry under the same `idempotencyKey` REPLAYS the cached `running` result (`2755-2758`) rather than re-issuing the Stripe refund (and `refundStripePayment` passes no Stripe idempotency key, so this caching is what prevents a duplicate). Evidence: a new test in `test/acp-stripe.test.ts` builds a fake `refunds.create` returning each Stripe status and asserts `provider.refundPayment` maps `succeeded`→`completed`, `pending`/`requires_action`→`running`, `failed`/`canceled`→`failed`, and `null`→`running`. Mutation-verified: reverting to the old `refund.status === "failed" ? "failed" : "completed"` ternary (cp-backup + restore, no git) makes `pending`→`completed` and the test fails (`expected "completed" to be "running"`); restored via cp and re-confirmed green. Full suite (383) and both tsc configs pass. Out of scope (complementary follow-up): there is still no async reconciliation that flips a `running` refund to refunded once Stripe later reports `succeeded` — a pending refund now correctly stays un-refunded locally but will only become refunded when the refund webhook is mapped, which is tracked by `20260629T170319Z-P2-provider-refund-chargeback-webhook-unmapped`. This is strictly safer than the prior premature `refunded`; the webhook reconciliation is the second half of the end-to-end flow.

DEVANA-KEY: src/stripe.ts:606 | stripe-refund-pending-completed
DEVANA-SUMMARY: fixed | P1 | high | refundStripePayment now maps only a confirmed Stripe `succeeded` to completed (failed/canceled -> failed; pending/requires_action -> running) via stripeRefundActionStatus, so refundOrder no longer writes the refunded ledger or revokes fulfillment for a still-pending refund. No double-refund on retry (the admin audit caches+replays the running result); eventual settlement of a pending refund is reconciled by the refund webhook (report 170319Z, out of scope here).