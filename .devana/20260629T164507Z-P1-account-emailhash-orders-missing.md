DEVANA-FINDING: v1
DEVANA-STATE: fixed | P1 | high | security=no
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
- 2026-06-29: fixed (report's first suggested approach: ledger lookup by emailHash). Orders are now indexed and queryable by `emailHash`, and `account.get` returns matching guest orders for an emailHash-only identity. Changes: (1) `OrderRecord` and the `OrderDocument` indexed fields gain an optional `emailHash`; (2) the `ledger` storage config indexes `emailHash` (and a composite `["emailHash","createdAt"]`), mirroring the existing `customerId` indexes — no library migration is needed because order documents live in the host-provided document collection (the library's SQLite migrations cover only stock/ephemeral); the new index entry is what production indexed hosts use to resolve the query, while the in-memory test collection brute-force-filters by the top-level `emailHash` field (it honors only `uniqueIndexes` and ignores the `indexes` list), so the regression test passes on the top-level field rather than the index entry; (3) `createPaymentOrderDocument` snapshots the purchaser once and sets the order's top-level `emailHash` from `paymentCustomerSnapshot(...).emailHash`, so it mirrors `aggregate.customer.emailHash`; (4) a new `LedgerRepository.listOrdersByEmailHash` (+ `MikaLedgerRepositoryPort` declaration) queries `listByType("order", { where: { emailHash } })` like `listOrdersByCustomer`; (5) `getAccount`, for a `{ customer: null, emailHash }` identity, fetches those orders and maps them with the same `orderSummaryDTO`/`orderDownloadDTOs` helpers used for customer accounts. A userId-only identity (no emailHash) still returns an empty order list (no `listOrdersByUserId` lookup exists; out of scope). Limitation: only orders created after this change carry the top-level `emailHash`; pre-existing guest orders won't be returned until the host backfills that field (the host owns order storage, so a backfill is host-specific). Related (NOT changed here): the account-export snapshot for emailHash identities (`requestAccountExport`, the `{ customer: null }` branch) and `verifyMagicLink`'s immediate AccountDTO response for an emailHash identity still return `orders: []` (the client picks orders up on the subsequent `account.get`, so this is harmless but asymmetric with the customer branch); the report scopes to `account.get`, so those remain a follow-up. Evidence: a new test persists a guest order (top-level + aggregate `emailHash`, no customerId) and an emailHash entitlement, signs in via session `mika.emailHash`, and asserts `account.get` returns that order; it was confirmed to return `orders: []` before the `getAccount` change. Full suite (360) and both tsc configs pass.

DEVANA-KEY: src/api/backend.ts:1233 | account-emailhash-orders-missing
DEVANA-SUMMARY: fixed | P1 | high | Orders are now indexed by emailHash and account.get lists guest orders for emailHash-only magic-link identities via the new listOrdersByEmailHash; new orders persist a top-level emailHash (pre-existing orders need a host backfill).