DEVANA-FINDING: v1
DEVANA-STATE: open | P1 | high | security=no
DEVANA-KEY: src/api/backend.ts:2033-2048 | email-resend-max-attempts-noop

# Admin email resend no-ops when attemptCount already exhausted

## Finding

`email.resend` sets status back to `queued` and `nextAttemptAt` to now but does not reset `attemptCount`. The outbox lease gate `emailIsDueForLease` returns false when `attemptCount >= maxAttempts`, so re-queued terminal-failure emails are never leased or sent while the API reports success.

## Violated Invariant Or Contract

Admin resend of a failed email must make the email eligible for outbox delivery again.

## Oracle

`resendEmail` producer writes `status: "queued"` without touching `attemptCount`; consumer `emailIsDueForLease` requires `attemptCount < maxAttempts` (repositories.ts:1416).

## Counterexample

1. Order-confirmation email fails until `attemptCount === maxAttempts` → terminal `failed`.
2. Admin `email.resend({ emailId })` → `status: "queued"`, `nextAttemptAt: now`, `attemptCount` unchanged.
3. `listDueEmails` may include the row, but `tryLeaseEmail` never acquires because `emailIsDueForLease` is false.
4. API returns `{ status: "completed" }`.

## Why It Might Matter

Operators believe resend succeeded; customers never receive order confirmations or other critical emails after transient provider outages.

## Proof

**Contract mismatch:** Producer (`resendEmail`, backend.ts:2033-2048) vs consumer (`emailIsDueForLease`, repositories.ts:1411-1418).

## Counterevidence Checked

Normal retries increment `attemptCount` on lease. Fresh emails start at `attemptCount: 0`. No `force` flag on admin resend.

## Suggested Next Step

Reset `attemptCount` to 0 (or decrement toward cap) on admin resend, or add a forced lease path for operator-triggered redelivery.

## Agent Handoff

After working this report, preserve the original finding body. Update line 2 `DEVANA-STATE: ...` and the final `DEVANA-SUMMARY:` status/priority/confidence prefix. Use one of: `open`, `fixed`, `invalid`, `stale`, `duplicate`, `wontfix`. Keep `DEVANA-KEY:` stable unless the same finding moved. Add dated notes below with evidence checked.

## Status Notes

- 2026-06-27: open by Devana. Initial report written from static source inspection.

DEVANA-KEY: src/api/backend.ts:2033-2048 | email-resend-max-attempts-noop
DEVANA-SUMMARY: open | P1 | high | Admin email.resend re-queues failed emails without resetting attemptCount, so the outbox never leases them again.