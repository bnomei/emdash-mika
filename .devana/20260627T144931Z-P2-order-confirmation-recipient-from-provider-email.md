DEVANA-FINDING: v1
DEVANA-STATE: open | P2 | medium | security=no
DEVANA-KEY: src/api/backend.ts:4770-4785 | order-confirmation-recipient-from-provider-email

# Order-confirmation recipient/email-hash taken from the provider event while the identity label is the canonical checkout customer

## Finding

`paymentCustomerSnapshot` builds the order customer with the canonical checkout `customerId` but the recipient email (and `emailHash`) straight from the payment-provider event, with no reconciliation:

```ts
// src/api/backend.ts:4770-4785
return {
  customerId: checkout.customerId,            // canonical authenticated customer
  email: event.customer?.email,               // untrusted provider event
  emailHash: normalizedEmail ? await input.hash(`email:${normalizedEmail}`) : undefined,
  ...
};
```

This snapshot flows into `createPaymentOrderDocument` (order `customerId = checkout.customerId`, `aggregate.customer.email = event email`), then `orderNotificationRecipient` (`backend.ts:2548-2558`) produces `{ toEmail: customer.email, customerId: order.customerId }`, persisted as the `order.confirmed` notification context and queued `order_confirmation` `EmailDocument`, delivered to `email.record.toEmail` (`email-outbox.ts:287-321`). The `emailHash` also propagates into entitlements and `download.ready`/`license.issued` recipients.

## Violated Invariant Or Contract

For an authenticated checkout (`checkout.customerId` set), the order-confirmation recipient and the identity label asserted on the notification/email must refer to the same customer.

## Oracle

The sibling subscription path does it the canonical way: `findOrCreateSubscriptionFromEvent` loads `findCustomerById(providerAccount.customerId)` and prefers `customer?.aggregate.email ?? providerAccount.record.emailSnapshot` (`backend.ts:4319-4324`) — canonical record first, provider snapshot only as fallback. The payment-order path never loads the customer record for `checkout.customerId`; it uses `event.customer.email` unconditionally.

## Counterexample

1. Customer A is logged in and starts a hosted checkout → `checkout.customerId = A`.
2. At the provider's hosted page the buyer enters a different email B (providers echo the typed email, which need not equal A's verified account email). The signed webhook arrives with `event.customer.email = B`.
3. `createPaymentOrderDocument` builds the order with `customerId = A` but `aggregate.customer.email = B`, `emailHash = hash(B)`. `queueOrderConfirmationEmail` → `orderNotificationRecipient` → `{ toEmail: B, customerId: A }`.

The order-confirmation (order number, line items, totals, and the account link from `resolveAccountUrl`) is addressed to B while attributed to account A; a hook trusting `intent.context.customerId` believes A was notified, but the email and account link went to B, and A may never receive it.

## Why It Might Matter

Order details and an account-access link for a verified account can be delivered to a non-account email address, while the system records the verified account as notified. Misdelivery of order data/account links and a silent notification gap for the real account holder.

## Proof

Dataflow trace source→sink: `event.customer.email` → `paymentCustomerSnapshot.email` → `order.aggregate.customer.email` → `orderNotificationRecipient.toEmail` → notification context / `EmailDocument.record.toEmail` → `sender({ to })`, in parallel with `checkout.customerId` → `order.customerId` → context `customerId`. The two fields originate from different trust domains and are never cross-checked, unlike the subscription path.

## Counterevidence Checked

- The webhook is signature-verified, so `event.customer.email` is not arbitrarily forgeable, and in many integrations the provider customer equals the account customer (fields agree). But nothing in the order path requires that equality; the canonical email for `checkout.customerId` is available and never loaded; and the subscription path deliberately prefers the canonical record — so a legitimate divergence (different email typed at hosted checkout) yields a confirmation/account-link sent to a non-account address. Confidence is medium because some flows may intend to honor the buyer-typed email.

## Suggested Next Step

For authenticated checkouts, resolve the confirmation recipient from the canonical customer record (load `findCustomerById(checkout.customerId)` and prefer its email), mirroring the subscription path; reconcile or flag a mismatch with the provider-event email rather than trusting it for identity-bound notifications.

## Agent Handoff

Preserve the original finding body. Update line 2 `DEVANA-STATE:` and the final `DEVANA-SUMMARY:` prefix. Keep `DEVANA-KEY:` stable unless the finding moved.

## Status Notes

- 2026-06-27: open by Devana. Verified backend.ts:4770-4785 mixes checkout.customerId with event email; subscription path (4319-4324) loads canonical record as oracle.

DEVANA-KEY: src/api/backend.ts:4770-4785 | order-confirmation-recipient-from-provider-email
DEVANA-SUMMARY: open | P2 | medium | Paid-order confirmation recipient/emailHash come from the provider event while the customerId is the canonical checkout customer, so order details + account link can be delivered to a non-account email while attributed to the verified account.
