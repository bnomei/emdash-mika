DEVANA-FINDING: v1
DEVANA-STATE: open | P1 | high | security=no
DEVANA-KEY: src/stripe.ts:746 | stripe-async-payment-succeeded-unmapped

# Stripe `checkout.session.async_payment_succeeded` is unmapped, so genuinely-paid delayed-payment orders are never fulfilled

## Finding

`parseStripeWebhookEvent` (`src/stripe.ts:658`) classifies a Stripe webhook into `subscription` / `payment` / `unknown`. For Stripe delayed-notification payment methods (SEPA debit, ACH, bank transfer, BACS, boleto, etc.) used with Checkout, Stripe delivers:

1. `checkout.session.completed` with `payment_status: "unpaid"` (payment pending), then
2. later either `checkout.session.async_payment_succeeded` (funds confirmed) or `checkout.session.async_payment_failed` (failed).

The adapter handles the **failure** side (`checkout.session.async_payment_failed` is in `STRIPE_PAYMENT_FAILURE_TYPES`, `src/stripe.ts:751`) but has **no branch** for `checkout.session.async_payment_succeeded`. It matches none of: `customer.subscription.*` (667), the failure set (684), `invoice.*` (688), `payment_intent.succeeded` (711), or `checkout.session.completed && stripeCheckoutSessionIsPaid` (727 — false because `payment_status` is `"unpaid"`). It therefore falls through to `unknownStripeWebhookEvent` (`src/stripe.ts:746`).

A `kind: "unknown"` event reaches `processStoredWebhook` `case "unknown": return webhook;` (`src/api/backend.ts:4013-4014`) and `receiveWebhook` reports `{ ok: true, status: "received" }` (`src/api/backend.ts:3444-3452`). No order is created, no fulfillment runs, no notification fires — yet the customer has paid.

## Violated Invariant Or Contract

A verified provider webhook representing a **successful** payment must drive fulfillment (or at minimum be recorded as a payment to process), not be discarded as a benign `unknown` event reported `received`.

## Oracle

The adapter's own asymmetry: it deliberately added `checkout.session.async_payment_failed` to `STRIPE_PAYMENT_FAILURE_TYPES` (`src/stripe.ts:751`), proving the author knew the async (delayed-notification) Checkout flow is reachable — but omitted the success counterpart. Stripe's documented delayed-payment flow is the contract.

## Counterexample

Shopper checks out via Stripe Checkout with SEPA Direct Debit:
- `checkout.session.completed` arrives with `payment_status: "unpaid"` → fails the `stripeCheckoutSessionIsPaid` guard at `src/stripe.ts:727` → `unknown` → dropped.
- Days later the bank confirms → `checkout.session.async_payment_succeeded` → matches no branch → `unknown` → dropped.
- The order is never fulfilled (no entitlement/license/download, no confirmation email), and every webhook returns HTTP 200 `received`, so the failure is silent.

## Why It Might Matter

Customers who pay with any delayed-notification method receive nothing and get no error signal; the merchant has no order record. This is silent under-fulfillment of genuinely-paid orders — a billing/correctness and support-load problem that is invisible in webhook responses (all 200 `received`).

## Proof

Producer→consumer (contract) mismatch + control-flow trace:
- Producer: Stripe emits `checkout.session.async_payment_succeeded` for a paid delayed-payment Checkout.
- Consumer gap: `src/stripe.ts:746` returns `unknown`; `src/api/backend.ts:4013-4014` returns the webhook unchanged; `src/api/backend.ts:3444-3452` reports `received`. No fulfillment edge exists for this event.

## Counterevidence Checked

- **"`payment_intent.succeeded` (`src/stripe.ts:711`) covers it."** Refuted. That branch never sets `providerCheckoutId` (only `providerPaymentId`/`providerOrderId` = the `pi_` id). For a Checkout-created order, no order exists yet (the unpaid `completed` event was dropped), so `processPaymentWebhook` falls to `link_checkout` → `findPaymentEventCheckout`, which returns `null` whenever `event.providerCheckoutId` is falsy (`src/api/backend.ts:4812`). The result is `markWebhookFailed("Payment event could not be linked to a checkout.")` (`src/api/backend.ts:4070-4085`), not fulfillment. Neither event path fulfills the async order. (`rg async_payment` confirms only the failure type is referenced anywhere in `src/`.)
- **"Unknown-event drop is intentional."** The deliberate handling of `async_payment_failed` with no success counterpart is the tell that this is an omission, not a design choice.
- Strongest false-positive reason: a merchant that never enables any delayed-notification payment method on Stripe Checkout never reaches this. But the code's own `async_payment_failed` handling assumes that flow is live.

## Suggested Next Step

Add `checkout.session.async_payment_succeeded` (paid) to the payment-success mapping, emitting a `payment` event carrying `providerCheckoutId = session.id` (mirroring the `checkout.session.completed` paid branch at `src/stripe.ts:727-743`) so it links to its checkout and fulfills. Confirm `findPaymentEventCheckout` then resolves the order.

## Agent Handoff

After working this report, preserve the original finding body. Update line 2 `DEVANA-STATE:` and the final `DEVANA-SUMMARY:` prefix. Keep `DEVANA-KEY:` stable unless the same finding moved.

## Status Notes

- 2026-06-29: open by Devana. Static source inspection; mapping gap and both downstream sinks verified directly in `src/stripe.ts` and `src/api/backend.ts`.

DEVANA-KEY: src/stripe.ts:746 | stripe-async-payment-succeeded-unmapped
DEVANA-SUMMARY: open | P1 | high | Stripe `checkout.session.async_payment_succeeded` is treated as an unknown event, so delayed-payment (SEPA/ACH/etc.) orders that genuinely paid are silently never fulfilled.
