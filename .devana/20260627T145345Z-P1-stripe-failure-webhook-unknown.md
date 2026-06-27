DEVANA-FINDING: v1
DEVANA-STATE: open | P1 | high | security=no
DEVANA-KEY: src/stripe.ts:642-700 | stripe-failure-webhook-unknown

# Stripe payment-failure webhooks are stored as unknown and never processed

## Finding

The Stripe adapter maps unpaid invoice events and all unhandled event types (including `payment_intent.payment_failed` and `checkout.session.async_payment_failed`) to `kind: "unknown"`. `processStoredWebhook` returns those webhooks unchanged with status `received`, so checkout failure notifications and checkout state updates never run.

## Violated Invariant Or Contract

Provider payment-failure events must update checkout/order failure state or emit `checkout.payment_failed`, not be silently accepted as inert unknown events.

## Oracle

Paid invoice events are parsed as `kind: "payment"`; unpaid invoice types fall through to `unknownStripeWebhookEvent` (`stripe.ts:642-645`). `processStoredWebhook` `case "unknown"` returns the webhook document unchanged (`backend.ts:3846-3847`). Contrast: explicit `payment` events with `paymentStatus !== "paid"` call `markWebhookFailed` and `emitCheckoutPaymentFailedNotification` (`backend.ts:3809-3819`).

## Counterexample

1. Stripe sends `payment_intent.payment_failed` for a delegated ACP checkout.
2. `parseStripeWebhookEvent` returns `{ kind: "unknown", type: "payment_intent.payment_failed" }`.
3. Webhook persists as `received`; `receiveWebhook` returns HTTP 200.
4. No `checkout.payment_failed` notification, no failed checkout transition, no ops alert path.

## Why It Might Matter

Failed payments look successful at the webhook boundary, leaving checkouts pending, stock reserved, and merchants without failure signals until manual investigation.

## Proof

**Dataflow trace:** Stripe failure payload → `unknownStripeWebhookEvent` → `processStoredWebhook` unknown branch (no-op) → HTTP 200 ingest.

## Counterevidence Checked

Tests treat some unknown events as intentional no-ops for unsupported types; failure event types are common in production Stripe flows and are not documented as ignorable. Unknown webhooks remain replayable but replay is also a no-op.

## Suggested Next Step

Parse Stripe failure event types into a payment-failure shape (or dedicated failure kind) and route them through `markWebhookFailed` plus `emitCheckoutPaymentFailedNotification`.

## Agent Handoff

After working this report, preserve the original finding body. Update line 2 `DEVANA-STATE: ...` and the final `DEVANA-SUMMARY:` status/priority/confidence prefix. Use one of: `open`, `fixed`, `invalid`, `stale`, `duplicate`, `wontfix`. Keep `DEVANA-KEY:` stable unless the same finding moved. Add dated notes below with evidence checked.

## Status Notes

- 2026-06-27: open by Devana. Initial report written from static source inspection.

DEVANA-KEY: src/stripe.ts:642-700 | stripe-failure-webhook-unknown
DEVANA-SUMMARY: open | P1 | high | Stripe payment-failure events parse as unknown and are stored as received without checkout failure handling or notifications.