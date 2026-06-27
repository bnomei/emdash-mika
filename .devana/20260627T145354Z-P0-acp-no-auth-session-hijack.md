DEVANA-FINDING: v1
DEVANA-STATE: open | P0 | high | security=yes
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

DEVANA-KEY: src/acp.ts:1247-1256 | acp-no-auth-session-hijack
DEVANA-SUMMARY: open | P0 | high | When ACP apiKey and signatureSecret are unset, knowing checkoutSessionId is enough to read or mutate the victim session's cart and checkout.