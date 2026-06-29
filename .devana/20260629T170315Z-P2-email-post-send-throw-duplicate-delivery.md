DEVANA-FINDING: v1
DEVANA-STATE: open | P2 | medium | security=no
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

DEVANA-KEY: src/api/email-outbox.ts:224 | email-post-send-throw-duplicate-delivery
DEVANA-SUMMARY: open | P2 | medium | If `completeEmail` throws after a successful provider send, the email is re-queued and re-sent, and the bundled EmDash sender drops `idempotencyKey`, so customers get duplicate transactional emails with no provider-side dedup.
