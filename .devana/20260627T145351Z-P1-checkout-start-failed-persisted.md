DEVANA-FINDING: v1
DEVANA-STATE: open | P1 | high | security=no
DEVANA-KEY: src/api/backend.ts:5702-5804 | checkout-start-failed-persisted

# checkout.start persists failed provider sessions and holds stock

## Finding

`startCheckout` treats any non-throwing provider response as success. When Stripe delegated checkout returns `status: "failed"` (for example `requires_payment_method`), Mika still reserves stock, marks the cart `checkout_pending`, persists the checkout document, and returns `ok: true`.

## Violated Invariant Or Contract

A provider checkout session in a failed state must not commit stock reservations or move the cart into `checkout_pending`.

## Oracle

Provider catch path releases reservations only on thrown errors (`backend.ts:5714-5717`). Stripe maps `requires_payment_method` to `"failed"` without throwing (`stripe.ts:482-489`). `persistCheckoutStart` always runs after a returned session (`backend.ts:5794-5804`, `6396`).

## Counterexample

1. Delegated Stripe `payment_intent` returns `status: "requires_payment_method"`.
2. Adapter returns `{ status: "failed" }` (no throw).
3. `startCheckout` persists checkout + `checkout_pending` cart with reservations held.
4. API returns `ok: true` with `status: "failed"`; cart cannot be reopened for a new start (existing stuck-cart finding family).

## Why It Might Matter

Inventory is reserved and carts are trapped on provider failures that should be immediate, retryable errors without persistence.

## Proof

**Control-flow trace:** provider returns failed status → no catch → `persistCheckoutStart` → reservations + `checkout_pending`.

## Counterevidence Checked

Idempotent replay of the same key returns the stored failed checkout (`checkoutFailedReplay` on later reads), not a clean retry path. Distinct from abandonment-driven stuck carts but same trapped-inventory outcome.

## Suggested Next Step

Treat provider `status: "failed"` like a thrown error: release reservations, do not persist checkout, return `providerFailed`.

## Agent Handoff

After working this report, preserve the original finding body. Update line 2 `DEVANA-STATE: ...` and the final `DEVANA-SUMMARY:` status/priority/confidence prefix. Use one of: `open`, `fixed`, `invalid`, `stale`, `duplicate`, `wontfix`. Keep `DEVANA-KEY:` stable unless the same finding moved. Add dated notes below with evidence checked.

## Status Notes

- 2026-06-27: open by Devana. Initial report written from static source inspection.

DEVANA-KEY: src/api/backend.ts:5702-5804 | checkout-start-failed-persisted
DEVANA-SUMMARY: open | P1 | high | Non-throwing provider checkout sessions with status failed still reserve stock, persist checkout, and leave carts checkout_pending.