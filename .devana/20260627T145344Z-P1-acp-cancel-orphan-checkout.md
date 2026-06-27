DEVANA-FINDING: v1
DEVANA-STATE: open | P1 | high | security=no
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

DEVANA-KEY: src/acp.ts:837-868 | acp-cancel-orphan-checkout
DEVANA-SUMMARY: open | P1 | high | ACP cancel flips only the local record, leaving bound Mika checkouts and stock reservations active after complete.