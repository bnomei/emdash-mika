DEVANA-FINDING: v1
DEVANA-STATE: fixed | P1 | high | security=yes
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
- 2026-06-30: fixed (chosen approach exactly as the report's Suggested Next Step: rotate the session id before binding identity). Confirmed the defect: `verifyMagicLink` (`src/api/backend.ts`) wrote the authenticated identity into the CURRENT session via `ctx.session?.set("mika.customerId" | "mika.userId" | "mika.emailHash", …)` without ever rotating the session id, and `MikaSessionAccess.regenerate` (`src/api/context.ts:36`) existed but had ZERO callers in `src/` (grep). So a session-fixation attack was viable: an attacker plants a known session-cookie id in the victim's browser, the victim completes the POST magic-link verify, the identity is bound to that FIXATED session, and the attacker replays the same id to call `account.get`/`account.export` — account takeover. (Verified this is the SOLE identity-binding sink: `ctx.session?.set` with `mika.*` keys appears only inside `verifyMagicLink`.) Fix: call `await ctx.session?.regenerate?.()` BEFORE the identity `set` calls in BOTH success branches — the customer branch (placed right after `accountDTOForCustomer` builds the view, as the FIRST of the final session writes, so the function's existing "assemble the account view before any session write" invariant is preserved and a view/read failure still reverts the one-time token via the surrounding catch) and the emailHash-only branch (inside the `if (record?.subjectHash)` guard, so rotation happens only when an identity is actually bound — a no-`subjectHash` token authenticates no one and must not rotate). Because both `regenerate()` calls run inside the same try-guard as the token consume and the sets, a `regenerate` failure also restores the token to pending and rethrows, leaving the link usable (no regression to the carefully-built single-use/restore semantics). `regenerate` is an OPTIONAL `MikaSessionAccess` port method (`regenerate?()`), so the library now REQUESTS rotation at the auth boundary and the host's session implementation performs the actual id rotation; a host that omits `regenerate` gets a no-op and remains responsible for providing it (the library can only request rotation through the port). Evidence: a new test (`test/backend.test.ts`, "rotates the session before binding identity on magic-link verify") drives `magicLink.verify` with a session mock that records the operation order and asserts `regenerate` is the FIRST session op and precedes `set("mika.customerId")`, while the identity is still bound (`store["mika.customerId"] === "customer_1"`). Mutation-verified: removing the `regenerate()` calls (cp-backup + restore, no git) makes the recorded order start with `set:mika.customerId` and fails the test (`expected ['set:mika.customerId'] to include 'regenerate'`); restored via cp and re-confirmed. Full suite (394) and both tsc configs pass. The existing token-restore tests (session-write-fails / account-view-fails) still pass — rotation slots into the same guarded sequence.

DEVANA-KEY: src/api/backend.ts:2844 | magic-link-session-fixation
DEVANA-SUMMARY: fixed | P1 | high | verifyMagicLink now calls await ctx.session?.regenerate?.() before binding identity in both success branches (customer + emailHash-only), so the authenticated identity is bound to a freshly-rotated session id and a pre-auth fixated session cannot be replayed for account takeover. regenerate runs inside the existing try-guard (a failure restores the one-time token) and after the account-view build (preserving the assemble-before-write invariant). regenerate is an optional MikaSessionAccess port; the library now requests rotation at the auth boundary and the host implementation performs it. This is the only identity-binding sink in the package.