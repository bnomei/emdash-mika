DEVANA-FINDING: v1
DEVANA-STATE: fixed | P2 | high | security=no
DEVANA-KEY: src/acp.ts:667 | acp-idempotent-create-retry-always-409

# ACP `POST /checkout_sessions` idempotent retry always returns 409 instead of replaying the original session

## Finding

`handleAcpCreate` (`src/acp.ts:652`) generates the session id **fresh-random on every call** before claiming the idempotency key:

```
id: options.createSessionId?.() ?? createDefaultAcpSessionId(),        // src/acp.ts:667
...
const idempotency = await beginAcpIdempotency(options, request, session.id, 201);  // src/acp.ts:677
```

`beginAcpIdempotency` → `claimIdempotencyKey(key, session.id)`. In the store, `claimIdempotencyKey` only returns `"replayed"` when `existing.id === id` (`src/acp.ts:565-574`). Because create passes a different random `session.id` on every invocation, a retry carrying the same `Idempotency-Key` finds the binding from the **first** call (a different id) → `existing.id !== id` → `{ status: "conflict" }` → `beginAcpIdempotency` returns `409 request_not_idempotent` (`src/acp.ts:965-975`). The `"replayed"` branch (`src/acp.ts:954-963`) is structurally unreachable for create. The non-claim store fallback has the identical defect: `replayed.id !== checkoutSessionId` (fresh) → 409 (`src/acp.ts:980-990`).

`verifyAcpRequest` **requires** the `Idempotency-Key` header for create (per the ACP contract), so this path is always taken.

## Violated Invariant Or Contract

A retry of `POST /checkout_sessions` with the same `Idempotency-Key` (and body) must replay the original `201` result, not error. ACP idempotency semantics require safe retries.

## Oracle

The store's own `"replayed"` branch (`src/acp.ts:571-572`, `src/acp.ts:954-963`) encodes the intended replay behavior; it is dead code for create because the compared id is regenerated each call.

## Counterexample

1. `POST /checkout_sessions` with `Idempotency-Key: K` → `201`, session id `acp_..._A`; binding `K → A` committed.
2. The `201` response is lost in transit. The agent retries the **identical** request with `Idempotency-Key: K`.
3. `handleAcpCreate` mints a new id `acp_..._B`, calls `claimIdempotencyKey(K, B)` → existing binding id `A` ≠ `B` → `conflict` → `409 "Idempotency-Key is already bound to another checkout session."`
4. The agent can never recover the created session. `CreateMikaAcpCheckoutHandlersOptions.createSessionId` is typed `() => string` with no arguments, so an integrator cannot derive a stable id from the key to work around it.

## Why It Might Matter

The core purpose of an idempotency key — safe retry after a lost/timed-out response — is defeated for session creation. Agentic clients that retry on transport failure get a hard 409 and a stranded (already-created) session, breaking the ACP checkout flow's reliability contract.

## Proof

Control-flow / contract mismatch: create passes a fresh-random id into `claimIdempotencyKey` (`src/acp.ts:667/677/950`), so the `existing.id === id` precondition of the `"replayed"` branch can never hold on a retry → the only reachable retry outcome is `conflict` → 409. Store-agnostic (both the claim path and the `getByIdempotencyKey` fallback share the id-mismatch).

## Counterevidence Checked

- It errors **closed** (never double-creates), so this is an availability/retry-contract bug, not corruption — hence P2, not P1.
- `update`/`complete`/`cancel` are unaffected: they pass the stable URL `checkoutSessionId` into the claim (`src/acp.ts:702/761/893`), so `existing.id === id` holds and their replay works correctly.
- Strongest false-positive reason: an integrator supplying a custom `createSessionId` that is deterministic per request could mask it — but the callback receives no arguments and cannot key off the `Idempotency-Key`, so no integrator can make create replay correctly.

## Suggested Next Step

For create, derive the candidate session id from (or claim before generating) the idempotency key, or change the create flow to look up an existing binding by key and replay its session before minting a new id. Re-test: same `Idempotency-Key` retry must return the original `201` body.

## Agent Handoff

After working this report, preserve the original finding body. Update line 2 `DEVANA-STATE:` and the final `DEVANA-SUMMARY:` prefix. Keep `DEVANA-KEY:` stable unless the same finding moved.

## Status Notes

- 2026-06-29: open by Devana. Verified directly in `src/acp.ts`: fresh id at `:667`, claim at `:677/:950`, conflict/replay logic at `:565-574` and `:954-990`.
- 2026-06-30: fixed (chosen approach as the report's Suggested Next Step: look up the existing binding for the key and replay its session, rather than minting a fresh candidate id that can never match). Root cause confirmed: `handleAcpCreate` mints a SERVER-side `session.id` before claiming the key, so a same-key retry passes a different fresh id into `claimIdempotencyKey(key, freshId)` → `existing.id !== freshId` → `conflict` (or, on the `getByIdempotencyKey` fallback, `replayed.id !== freshId`) → `409 request_not_idempotent`; the `replayed` branch was structurally dead for create. Fix: a create-only `replayExistingBinding` flag on `beginAcpIdempotency` (`handleAcpCreate` passes `true`; update/complete/cancel keep the default `false`). (a) Claim path: on `conflict`, resolve the bound session via `options.store.get(claim.id)` (the conflict result carries the bound id) and replay its response with the create's 201; if that session is not yet persisted, the original call is still in flight → `409 "Idempotency-Key replay is already in progress."`. (b) `getByIdempotencyKey` fallback: for create, drop the `replayed.id !== candidate` check (any existing binding for the key is the original session) and replay it. Why this is correct and safe: the create session id is SERVER-minted and never client-chosen, so an existing binding for a create key can only be the original create — replaying its 201 is the idempotency contract (`reconcileAcpCart` preserves `record.id`, so the bound id == the stored session id == the minted id, verified). update/complete/cancel are untouched: they pass the stable URL `checkoutSessionId`, so their id-match conflict detection (a key reused across different sessions → 409) is preserved. Race-safe: `claimIdempotencyKey` is atomic, so concurrent first-calls yield one `claimed` and the rest `conflict` → replay-if-persisted else 409-in-progress (errors-closed; never double-creates on the claim store). No store-interface or public-API change — `createSessionId` stays `() => string`. Evidence: a new test in `test/acp-stripe.test.ts` uses a COUNTER-based `createSessionId` (a distinct id per call, like production — the existing ACP tests pin a CONSTANT id, which silently masked this bug): create with `Idempotency-Key K` → 201 session `_1`; an identical retry with the same `K` → 201 replaying `_1` (NOT 409) even though the retry minted a fresh candidate `_2` (asserted via the counter) that was discarded; a different key → a brand-new session `_3`. Mutation-verified: with the create flag flipped to `false` (cp-backup + restore, no git), the retry returns 409 (`expected 409 to be 201`) — the exact reported defect; restored via cp and re-confirmed green. Full suite (380) and both tsc configs pass. Out of scope (NOT changed): request-body-hash conflict detection (this store tracks only key→id, so a key reused with a DIFFERENT body replays the original response rather than 422 — standard and pre-existing); and the non-atomic concurrency window of the `getByIdempotencyKey`-only store variant (two truly-simultaneous first-calls can still both proceed before either binds — pre-existing; this fix only adds correct replay of COMMITTED retries on that path).

DEVANA-KEY: src/acp.ts:667 | acp-idempotent-create-retry-always-409
DEVANA-SUMMARY: fixed | P2 | high | ACP create now replays the original session on a same-key retry instead of 409ing: beginAcpIdempotency gained a create-only replayExistingBinding path that resolves the bound session (claim conflict carries the bound id; getByIdempotencyKey drops the id-match) and replays its 201. Correct because the create id is server-minted (an existing binding can only be the original call); update/complete/cancel unchanged; race-safe and errors-closed; no store/public-API change.
