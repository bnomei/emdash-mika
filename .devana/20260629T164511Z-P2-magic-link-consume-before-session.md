DEVANA-FINDING: v1
DEVANA-STATE: fixed | P2 | medium | security=no
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
- 2026-06-30: fixed (chosen approach: keep consume-first, but REVERT the consume if the session writes fail — NOT the report's "set session first, then consume" reorder). Rationale for not reordering: `MikaSessionAccess.set` is `Promise<void> | void` and the calls were not in try/catch, so a store outage threw and left the token spent (`consumed`) with no session bound → retry hit `magicLinkTokenError` → `TOKEN_USED`, bricking the link. Reordering to set-session-then-consume would fix that but weakens single-use: under a shared-link concurrency race, two requests (different sessions) can both pass validation and both `session.set` before either `consume`; the consume loser returns TOKEN_USED yet its session was already authenticated — so one token could authenticate two sessions, and `MikaSessionAccess` has no per-key delete to cleanly compensate. Keeping `consumeToken` first preserves atomic single-use (only the consume winner ever writes a session). Changes: (1) new `MikaEphemeralRepositoryPort.restoreToken(key, now)` (`src/api/backend.ts`) — atomically flips a still-`consumed` token back to `pending` (the reverse of `consumeToken`); implemented on the SQLite `EphemeralRepository` (`src/storage/repositories.ts`, gated on `status = "consumed"`, no `expires_at` guard since restoring a since-expired token is harmless — the next verify returns `TOKEN_EXPIRED`) and on the in-memory test fake; (2) `verifyMagicLink` wraps the post-consume identity-resolve + `session.set` writes in a try/catch — on any throw it best-effort `restoreToken`s (so a failed restore is no worse than today) and rethrows, leaving the link usable on retry. The one case still unrecoverable here is a lost HTTP response AFTER a successful write (the session was bound server-side but the client never got the cookie) — no server-side ordering can fix that, and it is called out in the code comment. Evidence: a new test mints a pending token, verifies with a session whose `set` throws (expects the throw), asserts the token is back to `pending` (not `consumed`), then verifies again with a working session and gets `ok: true`. It was confirmed to FAIL without the revert (token stayed `consumed` → retry returned TOKEN_USED). Full suite (367) and both tsc configs pass. Out of scope (NOT changed): the sibling consume-then-validate flows the report mentions — account-export (`~src/api/backend.ts:1500`) and download issuance — share the consume-before-effect ordering, but their post-consume work is read/data-assembly rather than an external session-store write that can throw mid-way, so they are lower-risk; the report scopes to magic-link as the primary account-entry path. The same `restoreToken` primitive can be applied there as a follow-up if those effects prove failure-prone.

- 2026-06-30: reviewed (APPROVE_WITH_NITS, no blocking; the consume-first + revert design and the regression test were both verified — the test fails when the revert line is removed). Addressed the reviewer's main finding (nit 1): `accountDTOForCustomer` was assembled INSIDE the restore guard but AFTER the session writes, so a DTO-read failure would revert the token even though authentication had durably landed — re-opening the one-time token while a session was already authenticated (a narrow same-customer double-session window under a concurrent shared-link race). Fix: build the account view BEFORE the session writes, so a read failure reverts cleanly with nothing authenticated; the session writes are now the last awaited work. The code comment was corrected to drop the overstated "only the consume winner ever writes a session" and to record the two residual, accepted windows (a lost HTTP response after a successful write, and a partial multi-key `session.set` — both inherent to the per-key `MikaSessionAccess.set` port, worst case two sessions for the SAME customer, never cross-account). Added a second regression test (nit 2): it fails the account-view assembly (a customer-data read throws) after consume and asserts BOTH that the token is restored to `pending` AND that the session was left unwritten (`mika.customerId` undefined) — confirmed to FAIL if the DTO build is moved back after the session writes. (nit 3, version+2 on consume→restore: harmless, version is a monotonic counter no consumer reasons about by exact delta — left as-is.) Full suite and both tsc configs pass.

DEVANA-KEY: src/api/backend.ts:2831 | magic-link-consume-before-session
DEVANA-SUMMARY: fixed | P2 | medium | verifyMagicLink keeps consume-first (atomic single-use) but now reverts the consume via the new ephemeral restoreToken if the account-view assembly or session write throws (DTO built before the writes), so a session-store failure no longer bricks the one-time link on retry.