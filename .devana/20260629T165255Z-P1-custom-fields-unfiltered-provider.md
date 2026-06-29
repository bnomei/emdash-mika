DEVANA-FINDING: v1
DEVANA-STATE: open | P1 | high | security=no
DEVANA-KEY: src/api/backend.ts:5990 | custom-fields-unfiltered-provider

# checkout customFields filtered locally but sent raw to provider

## Finding

`checkoutCustomMetadata` strips `CHECKOUT_INTERNAL_METADATA_KEYS` before persisting checkout metadata. The provider session call passes `metadata: checkoutInput.customFields` unchanged. Internal key names and arbitrary client fields reach Stripe (or other providers) even when excluded from the local checkout document.

## Violated Invariant Or Contract

Checkout internal metadata keys reserved for Mika (`checkoutOrderId`, `checkoutIdempotencyKey`, etc.) should not be client-writable in provider metadata. Local and provider metadata should share the same sanitization policy.

## Oracle

`checkoutMetadata` uses `checkoutCustomMetadata` for persistence (`backend.ts:6432-6448`). Provider call at `backend.ts:5990` uses raw `customFields`.

## Counterexample

1. Client calls `checkout.start` with `customFields: { checkoutOrderId: "spoofed", promo: "x" }`.
2. Persisted checkout metadata omits `checkoutOrderId` (filtered).
3. Stripe session `metadata` includes `checkoutOrderId: "spoofed"` via `stripeMetadata({...input.metadata})`.

## Why It Might Matter

Provider-side metadata diverges from Mika records; internal correlation keys can be spoofed in Stripe dashboards and webhooks; PII in customFields reaches third-party metadata unfiltered.

## Proof

Dataflow trace: `customFields` → local filter → persisted metadata; same input → no filter → provider metadata sink.

## Counterevidence Checked

`CHECKOUT_INTERNAL_METADATA_KEYS` set is defined at `backend.ts:218-225`. Filtering applies only in `checkoutCustomMetadata`, not provider path. Distinct from ACP token bypass (separate mechanism) but same call site.

## Suggested Next Step

Pass `checkoutCustomMetadata(checkoutInput.customFields)` (or a shared sanitizer) to the provider `metadata` argument.

## Agent Handoff

After working this report, preserve the original finding body. Update line 2 `DEVANA-STATE: ...` and the final `DEVANA-SUMMARY:` status/priority/confidence prefix. Use one of: `open`, `fixed`, `invalid`, `stale`, `duplicate`, `wontfix`. Keep `DEVANA-KEY:` stable unless the same finding moved. Add dated notes below with evidence checked.

## Status Notes

- 2026-06-29: open by Devana. Initial report written from static source inspection.

DEVANA-KEY: src/api/backend.ts:5990 | custom-fields-unfiltered-provider
DEVANA-SUMMARY: open | P1 | high | checkout.start filters customFields for local metadata but passes the raw object to the payment provider.