DEVANA-FINDING: v1
DEVANA-STATE: fixed | P2 | medium | security=no
DEVANA-KEY: src/acp.ts:775 | acp-complete-toctou-double-authorization

# ACP `complete` re-entry guard is read before it is persisted, so concurrent completes with distinct idempotency keys can double-authorize payment

## Finding

`handleAcpComplete` (`src/acp.ts:751`) guards against re-completion with an **in-memory read** of the session record:

```
if (record.checkoutId) {                      // src/acp.ts:775  (read)
  await commitAcpIdempotency(options, idempotency.lease);
  return acpJson(...);                          // already completed → replay
}
...
const checkout = await options.api.checkout.start(ctx, { ... });   // src/acp.ts:836 (side effect: payment authorization)
...
const completed = { ...record, checkoutId: checkout.data.id, ... };
await options.store.put(completed);            // src/acp.ts:863  (checkoutId persisted — AFTER the side effect)
```

`record.checkoutId` is only written at `src/acp.ts:863`, after `checkout.start` has already created the checkout and authorized the delegated payment token. Between the read at `:775` and the write at `:863` there is a read-modify-write window. The only thing that serializes concurrent completes for one session is the ACP idempotency claim, which is keyed by the **request Idempotency-Key**: `${method}:${pathname}:${Idempotency-Key}` (`src/acp.ts:1016`). Two completes with **different** keys both get `"claimed"` and proceed. The backend's own `startCheckout` dedup keys on `ctx.idempotencyKey` (the same per-request header, via `acpContext`), which also differs, so it does not collapse them either.

## Violated Invariant Or Contract

A single ACP checkout session must yield at most one checkout / order / payment authorization, regardless of concurrent `complete` calls.

## Oracle

The `if (record.checkoutId)` short-circuit (`src/acp.ts:775-779`) is the intended once-only guard; its correctness depends on `checkoutId` being durably set before a second request reads it, which the ordering at `:836` vs `:863` violates.

## Counterexample

Two `POST /checkout_sessions/{sid}/complete` requests are issued concurrently for the same session `sid`, with identical `payment_data` but `Idempotency-Key: K1` and `Idempotency-Key: K2`:

1. Both `store.get(sid)` (`:759`) return the same record with `checkoutId === undefined`.
2. Both `beginAcpIdempotency` claims succeed — distinct store keys (`...:K1`, `...:K2`) → both `"claimed"` (`:761`).
3. Both pass `terminalStatus` checks and the `record.checkoutId` guard at `:775` (still undefined).
4. Both call `options.api.checkout.start` (`:836`) with distinct `ctx.idempotencyKey` → two checkout documents, two stock reservations, two delegated-payment authorizations against one cart/token.
5. Both `store.put` (`:863`); last write wins, masking that two authorizations occurred.

## Why It Might Matter

Potential double authorization/charge against a single ACP checkout session — a payment-integrity defect. Even when the backend later reconciles, it can leave duplicate orders/reservations and a customer-visible double charge.

## Proof

Interleaving / TOCTOU trace: the once-only guard (`record.checkoutId`, `:775`) is read before it is persisted (`:863`), and the only serializing mechanism (idempotency claim, `:1016`) is per-key, so two distinct-key concurrent completes both pass the guard and both reach the payment side effect at `:836`. Store-agnostic — the persist-after-side-effect window exists for any store implementation.

## Counterevidence Checked

- Same-**key** concurrency is correctly blocked: the second claim sees `pending: true` → `"in_progress"` → 409 (`src/acp.ts:571-573`).
- Sequential retries are safe: by the time the second request runs, `record.checkoutId` is set (`:775` short-circuits to replay).
- Strongest false-positive reason: this requires genuine concurrency **and** two **distinct** idempotency keys for the same session — abnormal client behavior (a well-behaved agent reuses one key per logical complete). That lowers likelihood, hence P2 rather than P1; but the financial impact (double authorization) warrants review, and a retrying agent generating a new key while the first is still in-flight during slow payment auth is plausible.

## Suggested Next Step

Serialize completion on the session id, not the request key: persist a `checkoutId`/`completing` marker via an atomic compare-and-set (claim-by-session-id) before calling `checkout.start`, or have `checkout.start` dedup on a session-derived idempotency key (e.g. `record.id`) instead of the per-request header.

## Agent Handoff

After working this report, preserve the original finding body. Update line 2 `DEVANA-STATE:` and the final `DEVANA-SUMMARY:` prefix. Keep `DEVANA-KEY:` stable unless the same finding moved.

## Status Notes

- 2026-06-29: open by Devana. Verified the read-before-persist ordering directly in `src/acp.ts` (`:775` read, `:836` side effect, `:863` persist) and the per-key idempotency store key at `:1016`.
- 2026-06-30: fixed (chosen approach = the report's Suggested Next Step option 1: serialize completion on the session id via an atomic claim BEFORE `checkout.start`). Root cause confirmed: the `if (record.checkoutId)` re-entry guard is read before `checkoutId` is persisted (after the `checkout.start` delegated-payment side effect), and the only serializer is the idempotency claim keyed `${method}:${pathname}:${Idempotency-Key}` — so two concurrent completes with DISTINCT keys both `claim`, both pass the guard, and both authorize. IMPORTANT — the report's option 2 (have `checkout.start` dedup on a session-derived key) was investigated and found INSUFFICIENT: the backend `startCheckout` (`src/api/backend.ts:6240`) dedups by READING `findCheckoutByIdempotencyKey` (`:6248`) and creates the provider authorization (`:6305`) BEFORE persisting — the same read-then-write TOCTOU class — so delegating serialization to the backend would not atomically collapse true concurrency. Fix (option 1): the ACP store's `claimIdempotencyKey` IS atomic, so make `complete` serialize on a SESSION-scoped claim key instead of the per-request key. Added an optional `storeKeyOverride` parameter to `beginAcpIdempotency` (`const key = storeKeyOverride ?? acpIdempotencyStoreKey(request)`); `handleAcpComplete` passes `acp_complete:${checkoutSessionId}`. Now two concurrent completes for one session claim the SAME key: the first → `claimed` and proceeds (one `checkout.start`); the second, while the first is still pending, → `in_progress` → `409 "replay is already in progress"` BEFORE reaching `checkout.start` — no double authorization; after the first commits, a later retry → `replayed` → replays the completed session (200). The `Idempotency-Key` header is still REQUIRED by `verifyAcpRequest` (only the STORE KEY changes), and the lease lifecycle is unchanged (every existing `commit`/`release` path still applies — only the key string differs). No regression: sequential completes (same OR different key) still replay (via the claim `replayed` branch, or the retained `record.checkoutId`/terminalStatus guards as defense-in-depth) — existing tests pass. Out of scope (NOT changed): `update`/`cancel` keep the per-request key (default) — `cancel` has a structurally similar read-before-persist window but its side effect (`checkout.cancel`, which tolerates a 404) is idempotent/benign, with no payment authorization, so it is not a double-charge risk; and the `getByIdempotencyKey`-only store variant retains its PRE-EXISTING non-atomic first-call window (two truly-simultaneous first completes can still race on a store with no atomic claim) — this fix serializes on claim-capable stores (the in-memory store and any real store). Accepted trade-off (surfaced by review): `handleAcpComplete` releases the claim on every *returned* error path but is not wrapped in `try/finally`, so an out-of-contract THROW after the claim (e.g. a `store.put`/`recordToAcpSession` failure) leaves the claim `pending` until its lease TTL expires — and because the key is now session-scoped, that briefly wedges ALL completes for that session (whereas the pre-fix per-request key only blocked retries reusing that one header). It is self-healing via the claim lease TTL, requires an infra-level throw (not a normal validation/business error, which are returned and released), and is a pre-existing no-`finally` pattern shared by create/update/cancel; a `try/finally` release of the claim (or a documented requirement that claim-capable stores expire stale `pending` claims) would harden it and is left as a follow-up. Evidence: a new BARRIER-based concurrency test in `test/acp-stripe.test.ts` — `onCheckoutStart` holds the FIRST complete inside `checkout.start` (after it claimed the session, before it persists `checkoutId`) on a gate Promise; a SECOND complete with a DISTINCT key races in and returns `409` with the authorization counter still at `1`; releasing the gate lets the first finish `200` with the counter still `1` (exactly one delegated-payment authorization for the session). Mutation-verified: with the session-scoped key neutered to fall back to the per-request key (cp-backup + restore, no git), the racing second complete returns `200` and the counter reaches `2` (the double authorization) — the exact reported defect; restored via cp and re-confirmed green. Full suite (381) and both tsc configs pass.

DEVANA-KEY: src/acp.ts:775 | acp-complete-toctou-double-authorization
DEVANA-SUMMARY: fixed | P2 | medium | ACP complete now serializes on a session-scoped atomic idempotency claim (acp_complete:${sessionId}) instead of the per-request key, so a second concurrent complete returns 409 before checkout.start — closing the read-before-persist TOCTOU that let two distinct-key completes both authorize. The report's backend-dedup option was insufficient (backend startCheckout is also read-then-write before authorizing). update/cancel unchanged (cancel's repeat side effect is benign); getByIdempotencyKey-only stores keep a pre-existing non-atomic window.
