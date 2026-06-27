DEVANA-FINDING: v1
DEVANA-STATE: fixed | P1 | high | security=no
DEVANA-KEY: src/acp.ts:837-868 | acp-cancel-orphan-checkout

# ACP cancel leaves Mika checkout and stock reservations active

## Finding

`handleAcpCancel` only sets the local ACP record to `canceled`. When `complete` has already called `checkout.start`, it does not cancel the Mika checkout, release stock reservations, or invalidate the provider payment handoff.

## Violated Invariant Or Contract

Canceling an ACP checkout session must invalidate any in-flight Mika checkout and reserved inventory tied to that session.

## Oracle

`acpTerminalStatus` treats a pending Mika checkout as non-terminal for cancel (`acp.ts:960-978`). `handleAcpCancel` performs a local `store.put` only (`acp.ts:860-868`) with no `api.checkout` or stock release calls.

## Counterexample

1. ACP `complete` calls `checkout.start` → Mika checkout `chk_1` pending, cart `checkout_pending`, stock reserved.
2. Client calls `cancel` on the ACP session.
3. ACP record becomes `canceled`; Mika checkout remains pending with active reservations.
4. Buyer can still complete provider payment against `chk_1` while ACP reports canceled.

## Why It Might Matter

Orphaned checkouts trap stock until reservation expiry, allow payment after the agent surface reports cancellation, and desync ACP state from Mika commerce state.

## Proof

**Control-flow trace:** `handleAcpCancel` → `acpTerminalStatus` (undefined for pending checkout) → `store.put({ status: "canceled" })` with no downstream checkout/stock cleanup.

## Counterevidence Checked

Browser checkout cancel pages are documented as UX-only. ACP `cancel` is an explicit mutation API and should terminate payment capability. No hidden cleanup in `recordToAcpSession` or maintenance tied to ACP cancel.

## Suggested Next Step

On cancel, fail or expire the bound Mika checkout, release reservations, and treat pending provider sessions as terminal for further ACP mutations.

## Agent Handoff

After working this report, preserve the original finding body. Update line 2 `DEVANA-STATE: ...` and the final `DEVANA-SUMMARY:` status/priority/confidence prefix. Use one of: `open`, `fixed`, `invalid`, `stale`, `duplicate`, `wontfix`. Keep `DEVANA-KEY:` stable unless the same finding moved. Add dated notes below with evidence checked.

## Status Notes

- 2026-06-27: open by Devana. Initial report written from static source inspection.
- 2026-06-27: fixed. Confirmed `handleAcpCancel` only did a local `store.put({status:"canceled"})` with no downstream checkout/stock cleanup. Added a routed `checkout.cancel` API capability (operation `checkoutCancel`, routed as `checkoutAbandon` POST `checkout/abandon` so the reserved `checkoutCancel` browser-redirect route name stays free). Backend `cancelCheckout` verifies the caller owns the checkout, is a no-op for already-terminal/converted checkouts, releases the cart's stock reservations, reopens the cart to `open`, and flips the checkout to `cancelled`. `handleAcpCancel` now calls `api.checkout.cancel` before flipping the ACP record whenever `record.checkoutId` is bound; a 404 (checkout already gone) tolerantly proceeds, any other failure surfaces as a 409/4xx ACP error so the session is NOT reported as canceled. Wired the facade (`createMikaOperationFacade`), `MikaApi.checkout.cancel`, and updated the 5 contract-pinning tables in test/index.test.ts. Regression tests in test/acp-stripe.test.ts: "cancels the bound Mika checkout when an ACP session is canceled" (asserts `checkout.cancel` invoked with the bound checkoutId) and "surfaces a failure to cancel the bound Mika checkout" (asserts a provider cancel failure leaves the ACP session non-canceled). Full suite: 332 passing; typecheck clean.

DEVANA-KEY: src/acp.ts:837-868 | acp-cancel-orphan-checkout
DEVANA-SUMMARY: fixed | P1 | high | ACP cancel now invokes a new routed checkout.cancel that releases reservations and reopens the cart before flipping the record; provider-cancel failures keep the ACP session non-canceled.