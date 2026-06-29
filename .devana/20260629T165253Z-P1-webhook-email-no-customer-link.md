DEVANA-FINDING: v1
DEVANA-STATE: open | P1 | high | security=no
DEVANA-KEY: src/api/backend.ts:4974 | webhook-email-no-customer-link

# Payment webhook does not link payer email to existing customer

## Finding

`paymentCustomerSnapshot` sets `customerId` only from `checkout.customerId`. When guest checkout has no `customerId`, it hashes payer email for `emailHash` but never looks up an existing `CustomerDocument` by that hash to populate `customerId`. Paid orders and entitlements are written without `customerId` even when the payer email matches a registered customer.

## Violated Invariant Or Contract

Payment fulfillment should bind orders and entitlements to the registered customer when payer email matches an existing account. Distinct from listing gaps: this is write-time identity promotion at fulfillment.

## Oracle

`findCustomerByEmailHash` exists in repositories. `paymentCustomerSnapshot` uses `checkout.customerId` lookup only (`backend.ts:4979-4981`). `createPaymentOrderDocument` sets `customerId: checkout.customerId` (`backend.ts:4841` area).

## Counterexample

1. Customer registers via magic link (has `CustomerDocument` with `emailHash`).
2. Same person checks out as guest (`checkout.customerId` undefined).
3. Payment webhook arrives with `event.customer.email` matching the registered email.
4. Order persisted with `customerId: undefined`, `emailHash` set; entitlements lack `customerId`.

## Why It Might Matter

Paid purchases do not attach to the customer record at fulfillment time, breaking entitlement and order ownership for registered users who checkout as guests.

## Proof

Dataflow trace: `event.customer.email` → hash only → `order.customerId` stays undefined; missing `findCustomerByEmailHash` promotion check.

## Counterevidence Checked

`account-emailhash-orders-missing` covers read-side listing only. Session hydration at checkout is a separate path (`checkout-missing-customer-hydration`). Webhook path does not call hydration helpers.

## Suggested Next Step

In `paymentCustomerSnapshot`, when `checkout.customerId` is absent, resolve customer via `findCustomerByEmailHash` from normalized payer email.

## Agent Handoff

After working this report, preserve the original finding body. Update line 2 `DEVANA-STATE: ...` and the final `DEVANA-SUMMARY:` status/priority/confidence prefix. Use one of: `open`, `fixed`, `invalid`, `stale`, `duplicate`, `wontfix`. Keep `DEVANA-KEY:` stable unless the same finding moved. Add dated notes below with evidence checked.

## Status Notes

- 2026-06-29: open by Devana. Initial report written from static source inspection.

DEVANA-KEY: src/api/backend.ts:4974 | webhook-email-no-customer-link
DEVANA-SUMMARY: open | P1 | high | Guest checkout webhooks hash payer email but never promote customerId from an existing customer record.