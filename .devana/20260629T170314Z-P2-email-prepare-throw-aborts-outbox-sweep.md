DEVANA-FINDING: v1
DEVANA-STATE: open | P2 | medium | security=no
DEVANA-KEY: src/api/email-outbox.ts:203 | email-prepare-throw-aborts-outbox-sweep

# A prepare/render throw on one email aborts the entire outbox sweep and never dead-letters the poison email

## Finding

`MikaEmailOutboxRunner.runOnce` loops over due emails and calls `deliverLeasedEmail` with **no per-iteration try/catch** (`src/api/email-outbox.ts:144-161`). Inside `deliverLeasedEmail`, the prepare/render phase runs **before** the only error handler:

```
const prepared = await prepareEmailDelivery(input, email);   // line 203 — OUTSIDE the try
...
try {                                                          // line 222 — try starts here
  const result = await input.sender(prepared.message);
  ...
} catch (error) {
  return failLeasedEmail(input, email, leaseKey, now, error); // only the send phase is isolated
}
```

`prepareEmailDelivery` (`src/api/email-outbox.ts:286`) calls `input.repositories.ledger.findOrderById(orderId)` (line 322) and `renderMikaEmail(...)` (lines 306/337). A **thrown** error from either — as opposed to the handled `return {status:"fail"}` cases for missing/not-found order — propagates out of `deliverLeasedEmail`, out of the `for` loop in `runOnce`, and rejects the whole sweep.

## Violated Invariant Or Contract

A failure preparing/rendering one email must be isolated to that email (transition it to `failed`/`skipped` and dead-letter after `maxAttempts`) and must not prevent the other leased/due emails in the batch from being processed. The send phase's per-email `try/catch` (`src/api/email-outbox.ts:222-255`) establishes that per-item isolation is the intended contract.

## Oracle

The asymmetry within `deliverLeasedEmail`: the send phase is wrapped in a per-email `try/catch` that routes to `failLeasedEmail`, but the prepare/render phase at line 203 is not — so prepare-phase throws bypass the isolation the rest of the function relies on.

## Counterexample

A batch of N due `order_confirmation` emails. For the first one, `input.repositories.ledger.findOrderById(orderId)` (line 322) throws a transient storage error (or a host `renderMikaEmail` override throws):
1. The throw escapes `prepareEmailDelivery` (no surrounding try at line 203) → escapes `deliverLeasedEmail` → escapes the `for` loop (line 144) → `runOnce` rejects.
2. The remaining N-1 emails in the batch are never processed this sweep.
3. The poison email is never transitioned to `failed`/`skipped` (no `failEmail`/`skipEmail` call ran), so it is never dead-lettered — yet its `attemptCount` was already burned by `tryLeaseEmail`. After the lease expires (~5 min) it re-leases and aborts the next sweep again, head-of-line-blocking the outbox.

## Why It Might Matter

A single email whose order read or render throws stalls the entire transactional-email backlog (order confirmations, magic links) and is never dead-lettered — an availability/correctness failure of the email subsystem that a maintenance-driven outbox is specifically meant to survive.

## Proof

Control-flow trace: the only exception handler in `deliverLeasedEmail` begins at line 222, after `prepareEmailDelivery` (line 203); the `runOnce` loop (lines 144-161) has no surrounding try/catch. Any throw from `prepareEmailDelivery` therefore surfaces as a whole-sweep rejection with no per-email failure transition.

## Counterevidence Checked

- "Per-email try/catch isolates failures" — true only for the send phase (lines 222-255); prepare/render at line 203 is outside it.
- The `order_confirmation` *data* problems (missing order id, order not found) are handled as `return {status:"fail"}` (lines 318-325) — but a *thrown* error (storage read error, host render throw, an unexpectedly-nullish field reaching `escapeHtml(value).replaceAll(...)` in `src/email.ts`) has no such handling.
- Strongest false-positive reason: if `findOrderById` and `renderMikaEmail` are assumed total (never throw). Storage reads provably can throw transiently, and host-supplied renderers/brand resolvers can throw, so the path is reachable; the well-known `Intl.NumberFormat` currency throw is mostly blocked because `createCurrencyCode` constrains currency to `/^[A-Z]{3}$/`.

## Suggested Next Step

Wrap the per-email body in `runOnce` (or the whole of `deliverLeasedEmail`, including `prepareEmailDelivery`) in a try/catch that routes any throw to `failLeasedEmail`, so one email's prepare/render failure is isolated and dead-lettered like a send failure.

## Agent Handoff

After working this report, preserve the original finding body. Update line 2 `DEVANA-STATE:` and the final `DEVANA-SUMMARY:` prefix. Keep `DEVANA-KEY:` stable unless the same finding moved.

## Status Notes

- 2026-06-29: open by Devana. Verified directly in `src/api/email-outbox.ts`: prepare at line 203 outside the try (222), loop (144-161) unguarded, and `prepareEmailDelivery` storage/render calls (286-355).

DEVANA-KEY: src/api/email-outbox.ts:203 | email-prepare-throw-aborts-outbox-sweep
DEVANA-SUMMARY: open | P2 | medium | A thrown error while preparing/rendering one outbox email (storage read or render) escapes the only try/catch and rejects the whole sweep, head-of-line-blocking all queued emails and never dead-lettering the poison email.
