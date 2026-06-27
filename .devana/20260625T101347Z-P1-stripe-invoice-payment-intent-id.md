DEVANA-FINDING: v1
Priority: P1 | Confidence: high | Security-sensitive: no | Status: open
Location: src/stripe.ts:243-253 | Slug: stripe-invoice-payment-intent-id

# Stripe getInvoiceUrl retrieves invoice API with payment intent id

## Finding

The Stripe adapter's `getInvoiceUrl` calls `invoices.retrieve(input.providerPaymentId)`, but `MikaProviderInvoiceInput.providerPaymentId` is populated from checkout webhooks with payment-intent ids (`pi_*`), not Stripe invoice ids (`in_*`).

## Violated Invariant Or Contract

Provider `getInvoiceUrl` must use an invoice identifier when calling Stripe's Invoice API. Payment-intent ids are a different identifier kind.

## Oracle

For a paid order whose `aggregate.invoiceUrl` is unset and `providerPaymentId` is `pi_*`, `order.invoice` must return a hosted invoice URL or a defined empty result — not call `invoices.retrieve` with a payment-intent id.

## Counterexample

1. Paid order from `checkout.session.completed`; `providerPaymentId = pi_123`, `aggregate.invoiceUrl` undefined.
2. `getOrderInvoice` passes `{ providerPaymentId: "pi_123" }`.
3. `getInvoiceUrl` runs `invoices.retrieve("pi_123")` → Stripe error / `providerFailed`, no `href`.

## Why It Might Matter

Invoice lookup fallback is broken for the common hosted-checkout flow where only payment-intent ids are stored on the order.

## Proof

**Contract mismatch:** Webhook sets `providerPaymentId` from `payment_intent`; `getInvoiceUrl` passes it to `invoices.retrieve`. Early return only when `aggregate.invoiceUrl` already present.

## Counterevidence Checked

Invoice webhook path can set `providerPaymentId` to invoice id when `payment_intent` is absent. `providerOrderId` is not used in `getInvoiceUrl`.

## Suggested Next Step

Resolve invoice id from payment intent via Stripe API, or store `providerInvoiceId` separately on orders and use that for retrieval.

## Agent Handoff

After working this report, preserve the original finding body. Update line 2 `Status: ...` and the final `DEVANA-SUMMARY:` status.

## Status Notes

- 2026-06-25: open by Devana. Initial report written from static source inspection.

DEVANA-KEY: src/stripe.ts:243-253 | P1 | stripe-invoice-payment-intent-id
DEVANA-SUMMARY: Status=open | P1 high src/stripe.ts:243-253 - Stripe invoice lookup passes payment-intent ids to invoices.retrieve, breaking order.invoice for typical checkout flows.