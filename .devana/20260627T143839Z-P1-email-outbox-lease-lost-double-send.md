DEVANA-FINDING: v1
DEVANA-STATE: fixed | P1 | high | security=no
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
- 2026-06-27: fixed. Confirmed `deliverLeasedEmail` sent via the provider, then on a null `completeEmail` (lost/expired lease) returned `lease_lost` without terminalizing — leaving the row due (`emailIsDueForLease` allows re-lease after expiry) so a later pass re-sent the same message. Fix: after a confirmed successful send, a null `completeEmail` now falls back to a new lease-agnostic `markEmailDelivered(emailId, now, providerMessageId)` repo method that sets the row `sent` (unless already terminal) regardless of who holds the lease, so the message can never be re-delivered. The run item reports `status: "sent"` with `recoveredLeaseLost: true` for observability. This closes the single-worker lease-expiry double-send; true two-worker concurrent sends (both calling the provider before either completes) still require provider-side idempotency, which is out of scope here. Added regression test `terminalizes a delivered email when the lease is lost so it is never re-sent` (completeEmail stubbed to null → row terminalized sent, second pass scans 0 / re-sends nothing). Typecheck + 321 tests pass.

DEVANA-KEY: src/api/email-outbox.ts:208-223 | email-outbox-lease-lost-double-send
DEVANA-SUMMARY: fixed | P1 | high | A successful send followed by a lost-lease completeEmail left the row due and re-deliverable. Fixed by terminalizing out-of-lease via markEmailDelivered after a confirmed send, with a regression test. Two-worker concurrent send still needs provider idempotency (noted).