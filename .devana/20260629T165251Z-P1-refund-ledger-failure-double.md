DEVANA-FINDING: v1
DEVANA-STATE: fixed | P1 | high | security=no
DEVANA-KEY: src/api/backend.ts:2596 | refund-ledger-failure-double

# Provider refund success with ledger failure allows duplicate refunds on retry

## Finding

When `order.refund` succeeds at the provider but `ledger.put` throws, the admin audit is marked `failed`. A retry with the same idempotency key does not replay the prior result because replay only applies when audit `status === "completed"`. A new provider refund call is made without a Stripe-side idempotency key.

## Violated Invariant Or Contract

Admin idempotency keys should make refund operations safe to retry without duplicating provider side effects once the provider has already accepted the refund.

## Oracle

`runAdminAction` replays only completed audits (`backend.ts:2571-2575`). `refundStripePayment` calls `refunds.create` without idempotency options (`stripe.ts:598-602`).

## Counterexample

1. Admin `order.refund` with `idempotencyKey: "refund-1"`.
2. Stripe refund succeeds (`status: "succeeded"`).
3. `ledger.put(updated)` throws (storage error).
4. Audit completes as `failed`.
5. Client retries with same `idempotencyKey: "refund-1"`.
6. Prior audit is not replayed; second `refunds.create` runs.

## Why It Might Matter

Duplicate Stripe refunds on retried admin calls after transient persistence failures.

## Proof

Control-flow trace: success path → ledger failure → failed audit → retry bypasses replay → second provider call.

## Counterevidence Checked

Failed-audit replay is intentionally skipped for in-progress detection. No compensating provider refund lookup by idempotency key before create.

## Suggested Next Step

Replay failed audits when provider refund id is already recorded in audit metadata, or pass admin idempotency key to Stripe `refunds.create`.

## Agent Handoff

After working this report, preserve the original finding body. Update line 2 `DEVANA-STATE: ...` and the final `DEVANA-SUMMARY:` status/priority/confidence prefix. Use one of: `open`, `fixed`, `invalid`, `stale`, `duplicate`, `wontfix`. Keep `DEVANA-KEY:` stable unless the same finding moved. Add dated notes below with evidence checked.

## Status Notes

- 2026-06-29: open by Devana. Initial report written from static source inspection.
- 2026-06-30: fixed (chosen approach = the report's Suggested Next Step option 2: pass the admin idempotency key to Stripe `refunds.create`). Root cause confirmed: when the provider refund SUCCEEDS but the subsequent `ledger.put(updated)` THROWS (storage error), the action throws → `failAdminAudit` marks the audit `failed`; `runAdminAction` replays only `completed` audits (and 409s on `started`), so a same-key retry does NOT replay and re-invokes the action → `refundStripePayment` calls `refunds.create` AGAIN, and since no Stripe-level idempotency key was passed, Stripe creates a SECOND refund. Fix (3 small parts): (1) `MikaProviderRefundInput` (`src/provider.ts`) gains an optional `idempotencyKey`; (2) `refundOrder` (`src/api/backend.ts`) forwards `refundInput.idempotencyKey` into the provider input; (3) `refundStripePayment` (`src/stripe.ts`) passes `requestOptions(\`${input.idempotencyKey}_refund\`)` as the `refunds.create` options. Now a retry under the same admin idempotency key produces the SAME (deterministic) Stripe idempotency key, so Stripe returns the ORIGINAL refund instead of creating a second one — and the retry then re-runs `ledger.put` with that `succeeded` result, so the ledger eventually persists (self-healing, no manual intervention). The key is namespaced `_refund` because Stripe idempotency keys are account-wide, so the same admin key must not collide with a different Stripe endpoint (mirrors the existing `_coupon` suffix at `stripe.ts:435`). Composes with the sibling fix `20260629T165250Z` (pending→running): a retry of a still-pending refund returns the same pending refund → `running`, which the admin audit caches and replays. No regression — two existing tests that asserted the PRE-fix `fake.getCalls().refundPayment` shape were updated to include the now-threaded `idempotencyKey` ("deduplicates a retried order refund …" — which also still proves exactly ONE provider call across the same-key retry, now confirming the key threads through — and "rejects a reused refund idempotency key carrying different input"). Evidence: (A) a unit test (`test/acp-stripe.test.ts`) captures the `refunds.create` options and asserts `provider.refundPayment({ …, idempotencyKey: "refund-1" })` passes `idempotencyKey: "refund-1_refund"`; (B) an e2e test (`test/backend.test.ts`) asserts `api.admin.orderRefund({ …, idempotencyKey: "refund-1" })` forwards `idempotencyKey: "refund-1"` into the provider `refundPayment` call. (C) a direct regression test for the report's EXACT scenario forces `ledger.put` to throw once: the refund's first attempt fails (audit `failed`), the same-key retry re-invokes the provider, and the test asserts BOTH provider calls carry the identical `idempotencyKey` (so Stripe dedupes the second `refunds.create` and returns the original — no second refund) before the retry succeeds. (A) and (B) are mutation-verified (cp-backup + restore, no git): dropping the `_refund` namespacing fails (A) (`"refund-1"` ≠ `"refund-1_refund"`), and removing the `refundOrder` threading fails (B) (provider call lacks `idempotencyKey`); restored via cp and re-confirmed green. Full suite (385) and both tsc configs pass. Out of scope (pre-existing, unchanged): if the admin supplies NO idempotency key, a retry still re-issues the refund — inherent to having no key to dedupe on, and a general property of all admin actions, not specific to refunds.

DEVANA-KEY: src/api/backend.ts:2596 | refund-ledger-failure-double
DEVANA-SUMMARY: fixed | P1 | high | refundOrder now forwards the admin idempotency key to the provider, and refundStripePayment passes it (namespaced `_refund`) to Stripe refunds.create, so a same-key retry after a provider-success/ledger-failure dedupes at Stripe (returns the original refund) instead of issuing a second one — and self-heals the ledger on retry. Three-part change (MikaProviderRefundInput type + refundOrder threading + Stripe request options); composes with the pending->running fix; no double refund.