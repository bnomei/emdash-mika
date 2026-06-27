DEVANA-FINDING: v1
Priority: P1 | Confidence: high | Security-sensitive: no | Status: open
Location: src/api/backend.ts:1757-1766 | Slug: admin-refund-ignores-provider-failure

# Admin refund and cancel persist success when provider returns failure

## Finding

`refundOrder` and `cancelOrder` call the provider adapter and then unconditionally update the ledger and overwrite the response with `status: "completed"`, regardless of the adapter's returned status. `runAdminProviderAction` only catches thrown errors, not non-throwing `{ status: "failed" }` returns.

## Violated Invariant Or Contract

`AdminActionResultDTO.status` and ledger state must reflect provider outcome. A provider returning `{ status: "failed" }` without throwing must not commit local refund/cancel state.

## Oracle

Stripe refund with `refund.status === "failed"` → API `ok: false` or non-completed action; ledger order unchanged.

## Counterexample

1. `refundStripePayment` returns `{ status: "failed" }` when Stripe says failed (stripe.ts:562–565).
2. `refundOrder` still runs `updateOrderAfterRefund` and `ledger.put` (1759–1760).
3. Response forced to `{ status: "completed" }` (1762–1766).
4. Same pattern in `cancelOrder` (1808–1817).

## Why It Might Matter

Local order state shows refunded/cancelled while the payment provider still holds the charge. Financial reconciliation and customer support workflows break.

## Proof

**Control-flow trace:** Adapter return-value → unconditional ledger write → response overwrite. `cancelSubscription` similarly discards provider return at 1583 before `updateSubscriptionAfterAction`.

## Counterevidence Checked

Tests cover thrown provider errors and missing methods, not non-throwing `{ status: "failed" }` from an installed adapter.

## Suggested Next Step

Branch on `result.status` before ledger mutation; propagate failed/running/unsupported statuses to the API response.

## Agent Handoff

After working this report, preserve the original finding body. Update line 2 `Status: ...` and the final `DEVANA-SUMMARY:` status.

## Status Notes

- 2026-06-25: open by Devana. Initial report written from static source inspection.

DEVANA-KEY: src/api/backend.ts:1757-1766 | P1 | admin-refund-ignores-provider-failure
DEVANA-SUMMARY: Status=open | P1 high src/api/backend.ts:1757-1766 - Admin refund/cancel always marks completed and updates ledger even when the provider adapter returns failed without throwing.