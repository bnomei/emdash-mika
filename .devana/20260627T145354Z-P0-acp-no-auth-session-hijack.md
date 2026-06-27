DEVANA-FINDING: v1
DEVANA-STATE: fixed | P0 | high | security=yes
DEVANA-KEY: src/acp.ts:1247-1256 | acp-no-auth-session-hijack

# ACP checkout sessions are mutable without auth when apiKey and signature are unset

## Finding

`verifyAcpRequest` skips authorization entirely when `apiKey` is unset and returns early when `signatureSecret` is unset. Any caller who knows an ACP `checkoutSessionId` can read, update, complete, or cancel that session and drive cart/checkout mutations on the bound Mika `sessionId`.

## Violated Invariant Or Contract

ACP checkout session endpoints must require authenticated access before exposing or mutating another session's cart and checkout state.

## Oracle

Optional `apiKey` and `signatureSecret` (`acp.ts:1247-1256`). Session ids use `cryptoSafeId()` with only 16 hex chars derived from `Date.now()` and `Math.random()` (`acp.ts:1541-1547`). Handlers load records by URL `checkoutSessionId` alone.

## Counterexample

1. Host deploys ACP handlers without `apiKey` or `signatureSecret` (allowed by options shape).
2. Attacker learns or guesses `acp_checkout_<16-hex>`.
3. `GET` exposes cart quote; `update` mutates items; `complete` starts delegated checkout on victim `record.sessionId`.

## Why It Might Matter

Unauthorized cart disclosure, checkout manipulation, and delegated payment initiation on victim sessions.

## Proof

**Actor-to-resource trace:** unauthenticated request + known `checkoutSessionId` → `store.get` → `acpContext(record.sessionId)` → `api.cart` / `api.checkout.start`.

## Counterevidence Checked

Hosts can configure `apiKey`/`signatureSecret`, but defaults permit fully open handlers and README presents ACP as host-wired without mandating auth. Weak id entropy increases guessability when auth is omitted.

## Suggested Next Step

Require `apiKey` or `signatureSecret` for mutating routes, bind sessions to caller credentials, and use cryptographically strong session ids.

## Agent Handoff

After working this report, preserve the original finding body. Update line 2 `DEVANA-STATE: ...` and the final `DEVANA-SUMMARY:` status/priority/confidence prefix. Use one of: `open`, `fixed`, `invalid`, `stale`, `duplicate`, `wontfix`. Keep `DEVANA-KEY:` stable unless the same finding moved. Add dated notes below with evidence checked.

## Status Notes

- 2026-06-27: open by Devana. Initial report written from static source inspection.
- 2026-06-27: fixed. Confirmed `verifyAcpRequest` returned `undefined` (authorized) for every request when both `apiKey` and `signatureSecret` were unset, and `cryptoSafeId()` produced only 64 bits of low-entropy, non-cryptographic id material (`sha256(Date.now():Math.random()).slice(0,16)`). Two-part fix: (1) `createMikaAcpCheckoutHandlers` now fails closed — it throws if neither `apiKey` nor `signatureSecret` is configured, so open handlers cannot be deployed at all; (2) `cryptoSafeId()` now uses `randomBytes(16).toString("hex")` (128 bits CSPRNG, 32 hex chars) for session ids and payment-authorization proof ids, removing guessability. README updated to document the credential requirement. Regression test "refuses to build ACP handlers without an apiKey or signatureSecret" asserts the throw and that either credential alone suffices. Did NOT add per-caller session→credential binding beyond requiring auth; with a configured apiKey/signature the existing checks gate every mutating and read route, which closes the unauthenticated-hijack path. Full suite: 333 passing; typecheck clean.

DEVANA-KEY: src/acp.ts:1247-1256 | acp-no-auth-session-hijack
DEVANA-SUMMARY: fixed | P0 | high | ACP handlers now fail closed without an apiKey/signatureSecret and session ids use 128-bit CSPRNG entropy, so knowing a checkoutSessionId is no longer enough to read or mutate a victim session.