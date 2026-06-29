DEVANA-FINDING: v1
DEVANA-STATE: fixed | P1 | medium | security=no
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
- 2026-06-29: fixed. `runAdminAction` now enforces the declared `same_key_same_input` scope, mirroring the checkout idempotency-hash pattern. When an action carries an idempotency key it computes `input.hash(stableJsonStringify(idempotencyInput))` over the **client-supplied request input** — each keyed call site (refund, cancel, entitlement grant/revoke, email resend, license revoke, download issue) passes its raw input object via a new `idempotencyInput` field on the audit start record — stores that hash on the created audit under a dedicated `idempotencyInputHash` metadata key, and on a subsequent call with a matching prior audit compares the stored hash to the new request's hash. A mismatch returns `409 CONFLICT` (`adminIdempotencyInputMismatch`) instead of replaying the earlier snapshot or blocking as in-progress; matching input keeps the prior behavior (replay completed snapshot, or 409 while still `started`).
  - Important correction (caught in review of the first attempt): the hash must be computed over the **client input, not the assembled audit record**. Two admin actions put non-deterministic, server-derived values into the record — `entitlement.grant` sets `targetId` to a freshly minted `createId("entitlement")`, and `download.issue` defaults `metadata.expiresAt` to a wall-clock value when the client omits it — so hashing the record made identical retries hash differently and would have returned a false `409` on a legitimate retry (a regression vs. the prior replay-by-key behavior). Hashing only the client input (`idempotencyInput`) is deterministic across retries and still distinguishes genuinely different requests. `idempotencyInput` is stripped before the audit is persisted, so it neither bloats nor leaks into the stored record. A safe fallback to the record identity remains for any future call site that supplies no explicit input.
  - The mismatch check runs before audit creation and before the provider/repository action, so the divergent operation never executes. The stored hash is a sibling of the `result` snapshot, so `adminAuditReplayResult` is unaffected. Subscription and provider-sync admin actions set no idempotency key, so they never reach the gate. Backward-compatible: audits written before this change have no stored hash, so the comparison is skipped and they fall back to legacy replay-by-key (no spurious 409s on in-flight pre-deploy keys).
  - Evidence: (1) a test refunds order A under key K, then under the same K refunds order B and re-refunds A with a different amount — both 409, no second provider refund, order B untouched; (2) a new test grants the same entitlement twice under one key (the retry mints a different internal id) and asserts the second **replays** at 200 with no second entitlement or audit; (3) a new test issues the same download twice under one key with the **clock advanced** between calls and asserts the second replays at 200. Both new tests were confirmed to FAIL (false 409) against the record-based hash and pass against the client-input hash. The same-input refund dedupe test still replays at 200. Full suite (355) and both tsc configs pass.

DEVANA-KEY: src/api/backend.ts:2566 | admin-idempotency-replay-input
DEVANA-SUMMARY: fixed | P1 | medium | runAdminAction now hashes the client-supplied request input on the audit and returns 409 when an idempotency key is reused with different input, instead of replaying the prior snapshot; matching input still replays (hashing client input, not the server-augmented record, avoids false 409s for grant/download whose records carry non-deterministic server values).