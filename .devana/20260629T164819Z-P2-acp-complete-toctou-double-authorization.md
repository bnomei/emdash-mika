DEVANA-FINDING: v1
DEVANA-STATE: open | P2 | medium | security=no
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

DEVANA-KEY: src/acp.ts:775 | acp-complete-toctou-double-authorization
DEVANA-SUMMARY: open | P2 | medium | ACP `complete` reads its `checkoutId` re-entry guard before persisting it, so two concurrent completes with distinct idempotency keys both authorize payment for one session.
