DEVANA-FINDING: v1
DEVANA-STATE: fixed | P1 | high | security=no
DEVANA-KEY: src/acp.ts:663-708 | acp-update-cart-checkout-desync

# ACP update mutates cart while bound checkout still reflects old totals

## Finding

After `complete` binds a Mika `checkoutId` and leaves the ACP session in `ready_for_payment`, `handleAcpUpdate` can still reconcile cart line items. The ACP record keeps the old `checkoutId`, but `recordToAcpSession` builds line items and totals from a fresh `cart.quote` while checkout status still reflects the prior checkout amount.

## Violated Invariant Or Contract

Once a checkout session is bound for payment, cart mutations that change priced lines must either invalidate the bound checkout or be rejected.

## Oracle

`acpTerminalStatus` only blocks updates when ACP/Mika checkout is `completed` or `canceled` (`acp.ts:960-978`). `recordToAcpSession` mixes `cart.quote` totals with `checkout.status` (`acp.ts:1104-1107`, `acpCheckoutSessionFromState:1143-1151`).

## Counterexample

1. ACP `complete` succeeds: `record.checkoutId = chk_1`, Mika checkout pending for cart total $100.
2. Client calls `update` with different `items` totaling $150.
3. `reconcileAcpCart` rewrites the cart; `record.checkoutId` unchanged.
4. Response shows $150 line items/totals from quote while payment handoff still targets the $100 checkout.

## Why It Might Matter

Delegated payment authorization can be collected for the wrong amount, causing charge mismatches, fulfillment of the wrong cart, or payment failures after the buyer approved a different total.

## Proof

**Cross-entry mismatch:** `handleAcpUpdate` → `reconcileAcpCart` mutates cart → `recordToAcpSession` → `cart.quote` (new) + `checkout.status` (old `checkoutId`).

## Counterevidence Checked

`acp-complete-double-checkout` covers a second `complete` with a new idempotency key, not `update` after bind. `ready_for_payment` is not treated as terminal for updates. No checkout invalidation or `checkoutId` clear on item change.

## Suggested Next Step

Reject `update` when `record.checkoutId` is set and Mika checkout is not terminal, or cancel/recreate checkout and clear delegated-payment metadata when items change.

## Agent Handoff

After working this report, preserve the original finding body. Update line 2 `DEVANA-STATE: ...` and the final `DEVANA-SUMMARY:` status/priority/confidence prefix. Use one of: `open`, `fixed`, `invalid`, `stale`, `duplicate`, `wontfix`. Keep `DEVANA-KEY:` stable unless the same finding moved. Add dated notes below with evidence checked.

## Status Notes

- 2026-06-27: open by Devana. Initial report written from static source inspection.
- 2026-06-27: fixed. Confirmed `handleAcpUpdate` only blocked terminal (`completed`/`canceled`) sessions, so after `complete` bound a non-terminal Mika checkout (`record.checkoutId` set, status `ready_for_payment`) an `update` with new `items` reconciled the cart while the bound checkout kept the old amount — desyncing the delegated-payment total. Fix: after parsing the update body, if `record.checkoutId` is set and the request carries `items`, reject with 409 `invalid_request` ("Cart items cannot be changed after checkout has started.") before reconciling. Buyer/fulfillment-only updates (no `items`) still pass. Chose rejection over cancel/recreate to avoid silently invalidating an in-flight payment authorization. Added regression test `rejects ACP item changes after a checkout has been bound` (complete leaves checkout pending/bound → update with new items → 409). Typecheck + 330 tests pass.

DEVANA-KEY: src/acp.ts:663-708 | acp-update-cart-checkout-desync
DEVANA-SUMMARY: fixed | P1 | high | ACP update after complete reconciled the cart while leaving the bound Mika checkout on the old amount. Fixed by rejecting item-changing updates (409) once a non-terminal checkout is bound; buyer/fulfillment-only updates still pass. Regression test added.