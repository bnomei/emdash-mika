DEVANA-FINDING: v1
DEVANA-STATE: open | P1 | high | security=no
DEVANA-KEY: src/api/backend.ts:1233 | account-emailhash-orders-missing

# Magic-link emailHash sessions never list matching guest orders

## Finding

Paid guest orders store `aggregate.customer.emailHash`, and magic-link verification can authenticate sessions via `mika.emailHash`, but `account.get` only loads orders through `listOrdersByCustomer(customerId)`. There is no order lookup by email hash, so emailHash-only identities always receive `orders: []` even when paid orders exist for the same email hash.

## Violated Invariant Or Contract

README advertises magic-link account access including orders. `AccountDTO` always exposes an `orders` field, and guest checkout persists purchaser `emailHash` on the order aggregate.

## Oracle

`resolveAccountIdentity` treats `sessionEmailHash` as authenticated and loads entitlements via `listEntitlementsByEmailHash`. `paymentCustomerSnapshot` writes `emailHash` onto paid orders. Ledger queries expose `listOrdersByCustomer` only (`src/storage/repositories.ts:837`).

## Counterexample

Guest pays with `guest@example.com`; order is `{ customerId: undefined, aggregate.customer.emailHash: hash(guest@example.com), status: "paid" }`. User verifies magic link; session stores `mika.emailHash` with no `CustomerDocument`. `account.get` returns `{ orders: [], entitlements: [...] }` while the paid order remains in the ledger.

## Why It Might Matter

Shoppers who pay before account creation cannot see order history after magic-link sign-in, even though entitlements for the same email may appear. Support and self-service flows break for the common guest-checkout path.

## Proof

Dataflow trace:

1. `createPaymentOrderDocument` sets `customerId: checkout.customerId` (often undefined for guests) while `paymentCustomerSnapshot` fills `aggregate.customer.emailHash`.
2. `verifyMagicLink` sets `mika.emailHash` when no customer record exists.
3. `getAccount` for `{ customer: null, emailHash }` returns hard-coded `orders: []` (`src/api/backend.ts:1233-1241`).
4. `accountDTOForCustomer` calls `listOrdersByCustomer` only (`src/api/backend.ts:2871-2872`).

## Counterevidence Checked

Distinct from checkout customer hydration: even orders that correctly snapshot `emailHash` are never queried by that key. Tokenized invoice/checkout status paths exist but do not populate account order history. No `listOrdersByEmailHash` repository method exists.

## Suggested Next Step

Add ledger lookup by `aggregate.customer.emailHash` (or promote guest orders to `customerId` at payment) and include results in `getAccount` for emailHash identities.

## Agent Handoff

After working this report, preserve the original finding body. Update line 2 `DEVANA-STATE: ...` and the final `DEVANA-SUMMARY:` status/priority/confidence prefix. Use one of: `open`, `fixed`, `invalid`, `stale`, `duplicate`, `wontfix`. Keep `DEVANA-KEY:` stable unless the same finding moved. Add dated notes below with evidence checked.

## Status Notes

- 2026-06-29: open by Devana. Initial report written from static source inspection.

DEVANA-KEY: src/api/backend.ts:1233 | account-emailhash-orders-missing
DEVANA-SUMMARY: open | P1 | high | Guest-paid orders store emailHash but account.get only queries orders by customerId, so magic-link emailHash sessions see an empty order list.