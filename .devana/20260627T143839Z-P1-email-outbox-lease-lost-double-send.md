DEVANA-FINDING: v1
DEVANA-STATE: open | P1 | high | security=no
DEVANA-KEY: src/api/email-outbox.ts:208-223 | email-outbox-lease-lost-double-send

# Email outbox can double-send after successful delivery when lease is lost

## Finding

`deliverLeasedEmail` calls the provider `sender` before `completeEmail`. If sending succeeds but `completeEmail` returns null (lease lost or race), the runner reports `lease_lost` without marking the email `sent`. The email becomes due again and can be delivered a second time to the same recipient with the same idempotency key.

## Violated Invariant Or Contract

At-most-once delivery per email document attempt sequence; successful provider send must terminalize the email record.

## Oracle

`deliverLeasedEmail` order: `sender()` then conditional `completeEmail`; `lease_lost` path leaves prior `queued`/`failed` state (email-outbox.ts:208-223). `emailIsDueForLease` allows re-lease after expiry.

## Counterexample

1. Worker leases email E with `attemptCount` incremented.
2. `sender()` succeeds (message delivered).
3. Concurrent maintenance or lease expiry causes `completeEmail` to return null.
4. Runner returns `{ status: "lease_lost" }`; email remains deliverable.
5. Next outbox pass sends duplicate to same `toEmail`.

## Why It Might Matter

Duplicate transactional emails (order confirmations, magic links) confuse customers and may have security implications for link-bearing messages.

## Proof

**State transition mismatch:** Send side effect committed → DB state not `sent` → retry path re-enters `sender`.

## Counterevidence Checked

Lease key guards on complete/fail/skip; `maxAttempts` caps retries but does not prevent duplicate after successful send. Distinct from `list-candidates-pagination-skip`.

## Suggested Next Step

Treat post-send `completeEmail` failure as `sent` with audit flag, or use provider idempotency keys and outbox "sent_pending_ack" state before calling sender.

## Agent Handoff

After working this report, preserve the original finding body. Update line 2 `DEVANA-STATE: ...` and the final `DEVANA-SUMMARY:` status/priority/confidence prefix. Use one of: `open`, `fixed`, `invalid`, `stale`, `duplicate`, `wontfix`. Keep `DEVANA-KEY:` stable unless the same finding moved. Add dated notes below with evidence checked.

## Status Notes

- 2026-06-27: open by Devana. Initial report written from static source inspection.

DEVANA-KEY: src/api/email-outbox.ts:208-223 | email-outbox-lease-lost-double-send
DEVANA-SUMMARY: open | P1 | high | Successful email sender calls followed by completeEmail lease miss leave the row deliverable and allow duplicate sends.