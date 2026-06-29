DEVANA-FINDING: v1
DEVANA-STATE: open | P2 | medium | security=no
DEVANA-KEY: src/api/backend.ts:2831 | magic-link-consume-before-session

# Magic link token is consumed before session is established

## Finding

`verifyMagicLink` consumes the ephemeral token before writing `mika.customerId` or `mika.emailHash` into the session. If session persistence fails or the client never receives the response, the one-time token is spent and retries return `TOKEN_USED` without authenticating the user.

## Violated Invariant Or Contract

Magic-link verification should authenticate the shopper or leave the token reusable until authentication succeeds. Token consumption is single-use (`consumeToken` requires `status: "pending"`).

## Oracle

Download and account-export tokens follow consume-then-validate ordering too, but magic links are the primary account entry path and email delivery already involved the user clicking once.

## Counterexample

1. User opens valid magic link.
2. `consumeToken` succeeds → token `consumed`.
3. `ctx.session.set("mika.customerId", ...)` fails (store outage) or HTTP response is lost.
4. User refreshes same link → `magicLinkTokenError` returns `TOKEN_USED`.
5. User must request a new email; first link is permanently dead.

## Why It Might Matter

Transient session store or network failures brick the magic-link flow and increase support load. The failure mode is user-visible and non-recoverable without re-issuing links.

## Proof

Control-flow trace at `src/api/backend.ts:2831-2847`: `consumeToken` precedes all `session.set` calls and the success response. `magicLinkTokenError` maps non-pending status to `TOKEN_USED` (`3313-3314`).

## Counterevidence Checked

Expired but unused tokens remain `pending` and return `TOKEN_EXPIRED`, not `TOKEN_USED`. A two-phase consume (set session first, then consume) or compensating token reissue on session failure would prevent the deadlock; none exists today.

## Suggested Next Step

Consume the token only after session writes succeed, or reissue automatically when consumption succeeded but session binding failed.

## Agent Handoff

After working this report, preserve the original finding body. Update line 2 `DEVANA-STATE: ...` and the final `DEVANA-SUMMARY:` status/priority/confidence prefix. Use one of: `open`, `fixed`, `invalid`, `stale`, `duplicate`, `wontfix`. Keep `DEVANA-KEY:` stable unless the same finding moved. Add dated notes below with evidence checked.

## Status Notes

- 2026-06-29: open by Devana. Initial report written from static source inspection.

DEVANA-KEY: src/api/backend.ts:2831 | magic-link-consume-before-session
DEVANA-SUMMARY: open | P2 | medium | verifyMagicLink consumes the one-time token before session writes, so session failures make the link unusable on retry.