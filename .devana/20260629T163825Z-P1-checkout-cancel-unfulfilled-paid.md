DEVANA-FINDING: v1
DEVANA-STATE: open | P1 | high | security=no
DEVANA-KEY: src/api/backend.ts:6553 | checkout-cancel-unfulfilled-paid

# checkout.cancel can release reservations before paid-webhook fulfillment

## Finding

`cancelCheckout` releases active reservations without checking whether provider payment has already succeeded or is in flight. `consume` rejects `released` reservations. A payment webhook arriving after cancel fails fulfillment, leaving a paid order without entitlements, licenses, or stock consumption.

## Violated Invariant Or Contract

A paid order must reach fulfillment even if the local checkout document was cancelled after the shopper initiated payment at the provider.

## Oracle

`cancelCheckout` guards only local `completed`/`orderId` status (~6538–6539), not provider payment state. `consumeOrderLineReservation` throws when reservation is `released` (~5143–5146). `consume` accepts only `active` or `expired` (~1739–1745).

## Counterexample

1. Cart checkout started; reservation `active`.
2. User completes payment at Stripe.
3. `checkout.cancel` runs (user navigates to cancel URL, ACP cancel, or race) → reservations `released`.
4. `checkout.session.completed` webhook → `fulfillPaidOrder` → `consume` returns `not_active` with `event.status === "released"`.
5. Webhook workflow fails; order may be `paid` without fulfillment.

## Why It Might Matter

Paid customers without downloads, license keys, or entitlements; support burden and manual webhook replay.

## Proof

**Event-order trace:** cancel → `releaseCheckoutReservations` → payment webhook → `consumeOrderLineReservation` throw → `markWebhookFailed`.

Locations: `src/api/backend.ts` (`cancelCheckout` ~6523–6570, `consumeOrderLineReservation` ~5126–5147, `processStoredWebhook` ~3989–4000), `src/storage/repositories.ts` (`consume` ~1739–1745, `release` ~1712–1727).

## Counterevidence Checked

`expired` (not `released`) reservations can still be consumed via on-hand path. `orderIsPaymentTerminal` does not apply to in-flight checkout cancel. Workflow retry repeats the same failing consume.

## Suggested Next Step

Before releasing reservations, verify provider session/payment state is not paid or payable; or allow fulfillment to consume/re-reserve on paid webhook regardless of local cancel.

## Agent Handoff

After working this report, preserve the original finding body. Update line 2 `DEVANA-STATE: ...` and the final `DEVANA-SUMMARY:` status/priority/confidence prefix.

## Status Notes

- 2026-06-29: open by Devana. Initial report written from static source inspection across inside-out-paths and state-lifecycle trails.

DEVANA-KEY: src/api/backend.ts:6553 | checkout-cancel-unfulfilled-paid
DEVANA-SUMMARY: open | P1 | high | Local checkout.cancel releases stock reservations while provider payment can still succeed, blocking webhook fulfillment.