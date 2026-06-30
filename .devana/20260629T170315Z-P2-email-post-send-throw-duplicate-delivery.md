DEVANA-FINDING: v1
DEVANA-STATE: fixed | P2 | medium | security=no
DEVANA-KEY: src/api/email-outbox.ts:224 | email-post-send-throw-duplicate-delivery

# A post-send `completeEmail` throw re-queues an already-delivered email, and the bundled EmDash sender drops `idempotencyKey` so the provider cannot dedup

## Finding

In `deliverLeasedEmail` the provider send and the success-recording write share one `try` (`src/api/email-outbox.ts:222-255`):

```
const result = await input.sender(prepared.message);          // line 223 — provider has accepted/sent
const completed = await input.repositories.ops.completeEmail({ // line 224 — record "sent"
  emailId: email.id, leaseKey, now, providerMessageId: result?.providerMessageId,
});
if (completed) { return { status: "sent", ... }; }
const recovered = await input.repositories.ops.markEmailDelivered({ ... }); // only when completeEmail RETURNS falsy
...
} catch (error) {
  return failLeasedEmail(input, email, leaseKey, now, error);  // line 254
}
```

If `input.sender` **resolves** (provider accepted the message) but `completeEmail` **throws** (transient storage error in the document update), the throw is caught at line 253 and routed to `failLeasedEmail` → `failEmail`, which sets status `failed` with a `nextAttemptAt` (since `attemptCount < maxAttempts`). `listDueEmails` selects `status in [queued, failed]`, so the next sweep re-leases and **re-sends** the already-delivered email. The `markEmailDelivered` recovery (line 239) is only reached when `completeEmail` **returns** falsy (lease lost), never when it **throws**.

The one mitigation — provider-side idempotency — is broken on the shipped adapter: `MikaEmailDeliveryMessage.idempotencyKey` is populated by `deliveryMessageFromRendered` (line 369, from `email.record.idempotencyKey`, e.g. `order-confirmation:<orderId>`), but `createEmDashMikaEmailSender` forwards only `{to, subject, text, html}` to `email.send` (`src/api/email-outbox.ts:185-193`) and `MikaEmDashEmailMessage` has no `idempotencyKey` field, so the key is silently dropped.

## Violated Invariant Or Contract

If the provider accepted the message (`sender` resolved), the email must not be re-sent — or duplicates must be deduped provider-side via the `idempotencyKey` the message carries. The presence of `MikaEmailDeliveryMessage.idempotencyKey` documents the intent that provider-side dedup is available.

## Oracle

`MikaEmailDeliveryMessage.idempotencyKey` (populated at line 369) implies provider-side dedup is the intended safety net for the at-least-once outbox; the bundled sender defeats it by not forwarding the field.

## Counterexample

1. `result = await input.sender(prepared.message)` resolves — provider has sent the order-confirmation email (line 223).
2. `completeEmail(...)` throws (transient storage/network blip in the document `update`) — line 224.
3. Caught at line 253 → `failLeasedEmail` → `failEmail` sets `failed` + `nextAttemptAt` (attemptCount < maxAttempts).
4. Next maintenance sweep: `listDueEmails` returns it (status `failed`), it re-leases and **re-sends** → the customer receives a duplicate email.
5. No dedup masks it: the EmDash adapter dropped `message.idempotencyKey` (lines 185-193), so the provider cannot suppress the duplicate.

## Why It Might Matter

Duplicate customer-facing transactional emails (order confirmations, magic links) on a storage write blip. Magic-link duplicates are worse than cosmetic — two valid links can be minted/sent for one request depending on host wiring.

## Proof

State-interleaving + dataflow: `sender` success and `completeEmail` failure are indistinguishable to the single `catch`, which assumes the send did not happen and re-queues; the `idempotencyKey` that would dedup the resend never crosses the EmDash sender boundary (field absent in `MikaEmDashEmailMessage`, lines 110-121; not forwarded at lines 185-193).

## Counterevidence Checked

- "`markEmailDelivered` recovery is idempotent" — true but irrelevant: recovery runs only when `completeEmail` *returns false* (lease lost, line 239), not when it *throws*; the throw path goes straight to `failEmail`.
- The send is never recorded `sent` before provider confirmation (sender runs first), so this is a duplicate-send window, never a lost-send one — the failure mode is at-least-once duplicates, not silent loss.
- Strongest false-positive reason: a custom host `MikaEmailSender` that reads `message.idempotencyKey` would dedup the resend provider-side. True — so severity is sender-dependent; for the **shipped** `createEmDashMikaEmailSender` it is unmitigated.

## Suggested Next Step

Either (a) forward `message.idempotencyKey` through `createEmDashMikaEmailSender` to the EmDash pipeline so the provider can dedup, and/or (b) distinguish a post-send record failure from a pre-send failure (e.g. mark `sent` optimistically before the provider call, or use a two-phase `sending`→`sent` record) so a `completeEmail` throw does not re-send.

## Agent Handoff

After working this report, preserve the original finding body. Update line 2 `DEVANA-STATE:` and the final `DEVANA-SUMMARY:` prefix. Keep `DEVANA-KEY:` stable unless the same finding moved.

## Status Notes

- 2026-06-29: open by Devana. Verified the throw→`failLeasedEmail` path (lines 222-255), the recovery-only-on-falsy-return distinction (239), and the dropped `idempotencyKey` in `createEmDashMikaEmailSender` (185-193) / `MikaEmDashEmailMessage` (110-121).
- 2026-06-30: fixed (both parts). (1) The provider send and the success-recording write shared ONE try in `deliverLeasedEmail`, so if `completeEmail` THREW after the provider already accepted the send, the catch ran `failLeasedEmail`, re-queueing the email for a later sweep that RE-SENT it (duplicate). Separated the two phases: the send now runs in its OWN try (a send failure → `failLeasedEmail`, safe to retry — nothing was delivered), and after the provider accepts, the recording is BEST-EFFORT (`completeEmail` under the lease, else `markEmailDelivered`, each `.catch(() => false)`) and NEVER falls back to `failLeasedEmail` — so a recording throw records the delivery (or reports `lease_lost`) but does not re-queue/re-send. (2) Defense-in-depth for the inherent at-least-once window (a crash between send and record): added `idempotencyKey` to `MikaEmDashEmailMessage` and forwarded `message.idempotencyKey` in `createEmDashMikaEmailSender` (it was dropped, so a retry had no provider-side dedup key; `MikaEmailDeliveryMessage` already carried it from `email.record.idempotencyKey`). Evidence: a new test makes `completeEmail` throw after a successful send and asserts the sender ran once and the email ends `sent` (not re-queued) — mutation-verified (removing the `completeEmail` best-effort `.catch` lets the throw escape and the test fails); and the adapter test now asserts the `idempotencyKey` is forwarded to `email.send`. Full suite (403) and both tsc configs pass.

DEVANA-KEY: src/api/email-outbox.ts:224 | email-post-send-throw-duplicate-delivery
DEVANA-SUMMARY: fixed | P2 | medium | deliverLeasedEmail now separates the provider send (own try → fail-and-retry) from the success-recording (best-effort completeEmail/markEmailDelivered, never failLeasedEmail), so a recording throw after a successful send no longer re-queues and re-sends the email. Plus createEmDashMikaEmailSender now forwards idempotencyKey (added to MikaEmDashEmailMessage) so the host pipeline/provider can dedup the inherent at-least-once retry window. New test + adapter-forward test, mutation-verified.
