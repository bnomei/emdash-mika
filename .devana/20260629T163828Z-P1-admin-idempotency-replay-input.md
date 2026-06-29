DEVANA-FINDING: v1
DEVANA-STATE: open | P1 | medium | security=no
DEVANA-KEY: src/api/backend.ts:2566 | admin-idempotency-replay-input

# Admin idempotency replay ignores differing input for same key

## Finding

`runAdminAction` replays prior completed audits when `action + idempotencyKey` matches, without comparing current input to the stored request. Agent metadata declares idempotency scope `actor_operation_resource_input` with replay rule `same_key_same_input`.

## Violated Invariant Or Contract

Idempotent admin replay must return the prior result only when the operation input (and target resource) matches; otherwise the new request must execute or conflict.

## Oracle

`operation-agent-metadata.ts` `hostOwnedIdempotencyKey.scope: "actor_operation_resource_input"`. `checkout.start` hashes input on replay (`checkoutIdempotencyInputHash`). Admin path uses `findAdminAuditByIdempotencyKey(action, key)` only.

## Counterexample

1. `admin.orderRefund` with `Idempotency-Key: K`, `orderId: A` → completes and stores audit.
2. Second call with same key `K`, `orderId: B` → returns replay snapshot from order A refund; order B never refunded.

## Why It Might Matter

Skipped refunds, cancels, stock adjustments, or entitlement changes when operators or automation reuse idempotency keys across different targets.

## Proof

**Contract mismatch:** declared `same_key_same_input` vs implementation `same_key` only.

Location: `src/api/backend.ts` (`runAdminAction` ~2566–2575, `adminAuditReplayResult` ~2472–2475), `src/storage/repositories.ts` (`findAdminAuditByIdempotencyKey`).

## Counterevidence Checked

`checkout.start` validates input hash on replay. Admin audit metadata records `targetId` but replay path never compares it. Host UIs may generate unique keys per operation, but nothing enforces that.

## Suggested Next Step

Include input hash or `targetId` in idempotency lookup, or return 409 on input mismatch for the same key.

## Agent Handoff

After working this report, preserve the original finding body. Update line 2 `DEVANA-STATE: ...` and the final `DEVANA-SUMMARY:` status/priority/confidence prefix.

## Status Notes

- 2026-06-29: open by Devana. Initial report written from static source inspection across invariants-contracts and dataflow-boundaries trails.

DEVANA-KEY: src/api/backend.ts:2566 | admin-idempotency-replay-input
DEVANA-SUMMARY: open | P1 | medium | Admin actions replay by idempotency key alone, ignoring different orderId or other input on retry.