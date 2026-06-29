DEVANA-FINDING: v1
DEVANA-STATE: open | P1 | high | security=yes
DEVANA-KEY: src/api/backend.ts:2844 | magic-link-session-fixation

# Magic link verify does not rotate session after authentication

## Finding

`verifyMagicLink` consumes the token then writes `mika.customerId`, `mika.userId`, or `mika.emailHash` into the current session. `MikaSessionAccess.regenerate` exists in the context interface but is never called anywhere in the package.

## Violated Invariant Or Contract

Successful authentication should bind identity to a new session identifier to prevent session fixation attacks.

## Oracle

`MikaSessionAccess` documents optional `regenerate()` (`context.ts:36`). `grep` shows no `session.regenerate` usage in `src/`.

## Counterexample

1. Attacker sets victim browser session cookie to a known session ID.
2. Victim completes magic link verify via POST.
3. `ctx.session.set("mika.customerId", ...)` writes into the fixated session.
4. Attacker reuses the same session ID to call `account.get` / `account.export`.

## Why It Might Matter

Account takeover when an attacker can plant a session ID before the victim authenticates.

## Proof

Actor-to-resource trace: fixated session → verify writes identity → subsequent account operations use same session.

## Counterevidence Checked

Magic link page uses POST (token in URL alone does not auth). `returnTo` sanitized via `mikaSafeReturnPath`. Distinct from `magic-link-consume-before-session` (token ordering on failure).

## Suggested Next Step

Call `ctx.session?.regenerate?.()` before writing identity keys after successful verify.

## Agent Handoff

After working this report, preserve the original finding body. Update line 2 `DEVANA-STATE: ...` and the final `DEVANA-SUMMARY:` status/priority/confidence prefix. Use one of: `open`, `fixed`, `invalid`, `stale`, `duplicate`, `wontfix`. Keep `DEVANA-KEY:` stable unless the same finding moved. Add dated notes below with evidence checked.

## Status Notes

- 2026-06-29: open by Devana. Initial report written from static source inspection.

DEVANA-KEY: src/api/backend.ts:2844 | magic-link-session-fixation
DEVANA-SUMMARY: open | P1 | high | verifyMagicLink binds customer identity to the current session without calling session.regenerate.