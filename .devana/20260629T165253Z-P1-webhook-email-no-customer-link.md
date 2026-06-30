DEVANA-FINDING: v1
DEVANA-STATE: fixed | P1 | high | security=no
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
- 2026-06-30: fixed (chosen approach = the report's Suggested Next Step, plus a required second edit the report's Oracle pointed at). Root cause confirmed in TWO places: `paymentCustomerSnapshot` (`src/api/backend.ts:5207`) resolved `customer` only from `checkout.customerId`, AND `createPaymentOrderDocument` (`:5048`) set the order's TOP-LEVEL `customerId` DIRECTLY from `checkout.customerId` (`:5073`) — so a guest checkout (`checkout.customerId` undefined) whose payer email matched a registered account got both the order and (via `order.customerId ?? aggregate.customer.customerId`, `createOrderLineEntitlementDocument:5378`) the entitlement written with an undefined `customerId`. Fix (2 edits): (1) `paymentCustomerSnapshot` now, when there is no checkout customer, looks up `findCustomerByEmailHash(payerEmailHash)` from the normalized payer email and promotes `customerId`/`userId`/canonical `email`/`emailHash` from the matched account; (2) `createPaymentOrderDocument` now sets the order's top-level `customerId` from the snapshot (`customer.customerId`) rather than `checkout.customerId`, so the promotion actually reaches the persisted order (and thus the entitlement). The lookup is sound because the email-hash formula is IDENTICAL across the codebase — `hash("email:" + email.trim().toLowerCase())` at `:2119`, the magic-link customer match at `:2911`, and the snapshot at `:5225` — so a magic-link-registered customer's stored `emailHash` equals the payer-email hash. Behavior preserved: a LOGGED-IN checkout is unchanged (`checkoutCustomer` is found, so `customer.customerId === checkout.customerId`); a guest with NO matching account keeps `customerId` undefined and is still found later by the top-level `emailHash` (the `account-emailhash-orders-missing` read-side design stays intact — `emailHash` is still written). One extra `findCustomerByEmailHash` only on the guest path. Evidence: a new test (`test/backend.test.ts`, "promotes a guest checkout to the matching registered customer at payment fulfillment") registers a customer, drives a GUEST checkout (`customerId:false`) + paid webhook whose `event.customer.email` is mixed-case `"Subscriber@Example.test"` (matching the registered normalized `emailHash`), and asserts the paid order's top-level `customerId`, `aggregate.customer.customerId`, AND the fulfilled entitlement's `customerId` are all the registered `"customer_1"`. Both edits are mutation-verified (cp-backup + restore, no git): reverting the order's `customerId` to `checkout.customerId` OR neutering the snapshot's `findCustomerByEmailHash` lookup each makes the order `customerId` undefined and fails the test; restored via cp and re-confirmed green. Full suite (388) and both tsc configs pass. Out of scope: a guest who later registers AFTER paying is still only linked by `emailHash` (no retroactive promotion of historical orders) — that read-side linkage is covered by `account-emailhash-orders-missing`; this fix is the write-time promotion at fulfillment. Addressing a review nit, the email lookup is gated on `!checkout.customerId`, so a logged-in checkout whose customer was DELETED between checkout and the webhook keeps its dangling `customerId` rather than being re-bound to a different account by an email match. Security/privacy note (`security=no`, consistent with the pre-existing emailHash linkage): the promotion keys on the provider event's payer email, which a guest can set, so an attacker could attach a GENUINELY-PAID order/entitlement to a victim's account by paying with the victim's registered email — a pollution/griefing vector (the attacker spends their OWN money), NOT a data-exposure one (no victim data flows to the attacker). The same email→account linkage already existed at READ time via the order's `emailHash` (a victim authenticating by emailHash would already surface it); promoting `customerId` at write time is the explicitly-suggested remedy of `account-emailhash-orders-missing` and matches the system's email-control = access model.

DEVANA-KEY: src/api/backend.ts:4974 | webhook-email-no-customer-link
DEVANA-SUMMARY: fixed | P1 | high | paymentCustomerSnapshot now promotes a guest checkout to the registered customer via findCustomerByEmailHash(payer-email hash), and createPaymentOrderDocument sets the order's top-level customerId from that snapshot (not checkout.customerId) — so guest paid orders and their entitlements attach to the matching account. Email-hash formula is identical across registration and the snapshot; logged-in and no-match-guest behavior unchanged.