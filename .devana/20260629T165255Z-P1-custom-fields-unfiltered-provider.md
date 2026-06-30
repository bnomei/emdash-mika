DEVANA-FINDING: v1
DEVANA-STATE: fixed | P1 | high | security=no
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
- 2026-06-30: fixed (chosen approach exactly as the report's Suggested Next Step: pass the shared sanitizer to the provider metadata). Confirmed the startCheckout provider `createCheckoutSession` call passed `metadata: checkoutInput.customFields` RAW (`src/api/backend.ts`), while the persisted checkout metadata strips `CHECKOUT_INTERNAL_METADATA_KEYS` via `checkoutCustomMetadata`. So a client could spoof the six reserved internal correlation keys (`checkoutIdempotencyKey`, `checkoutIdempotencyInputHash`, `checkoutProviderStatus`, `checkoutRedirectUrl`, `checkoutPersistenceFailed`, `checkoutOrderId`; `backend.ts:228-235`) into the provider's metadata — visible/spoofable in Stripe dashboards & webhooks, while local and provider metadata applied DIFFERENT sanitization policies. (Scope clarification, per review: this fix is anti-SPOOFING of the six RESERVED internal keys — it does NOT filter PII. Genuine custom fields, including any PII a client chooses to put in them, intentionally still forward to the provider, since forwarding `customFields` as provider metadata is the documented purpose; the original finding's "PII reaches the provider unfiltered" is by-design and out of scope. The fix simply unifies the RESERVED-key sanitization between the persisted and provider metadata.). Fix (one line): the provider call now passes `checkoutCustomMetadata(checkoutInput.customFields)`, the SAME filter used for local persistence, so provider and local metadata share one sanitization policy. Crucially this does NOT break the ACP delegated-payment flow: the ACP keys (`acpPaymentToken`, `acpPaymentAuthorizationInputHash`, `acpCheckoutSessionId`, the proof id) are NOT in `CHECKOUT_INTERNAL_METADATA_KEYS`, so they pass through, and the Stripe adapter still reads `acpPaymentToken` from `input.metadata` (`src/stripe.ts:371-376`) to begin the delegated charge. The delegated-payment authorization gate `requireDelegatedPaymentAuthorization` reads the RAW `checkoutInput.customFields` (not the provider metadata), so it is entirely unaffected. Evidence: a new test (`test/backend.test.ts`, "strips internal Mika metadata keys from the provider checkout metadata") drives `checkout.start` with `customFields: { checkoutOrderId: "spoofed", promo: "summer" }` and asserts the fake provider's `createCheckoutSession` metadata is exactly `{ promo: "summer" }` (the reserved key stripped, the genuine field forwarded). Mutation-verified: reverting to the raw `customFields` (cp-backup + restore, no git) leaks `checkoutOrderId: "spoofed"` into the provider metadata and fails the test; restored via cp and re-confirmed green. The existing delegated-payment tests (`backend.test.ts:12561`/`12619`) still pass — the filter keeps `acpPaymentToken`, so the adapter still charges. Full suite (389) and both tsc configs pass. (Only one provider call forwards `customFields` — verified by grep — so there is no other unfiltered sink.)

DEVANA-KEY: src/api/backend.ts:5990 | custom-fields-unfiltered-provider
DEVANA-SUMMARY: fixed | P1 | high | The provider createCheckoutSession call now passes checkoutCustomMetadata(customFields) instead of the raw object, so the six reserved internal Mika keys (checkoutOrderId, etc.) are stripped before reaching Stripe metadata — matching local persistence. The ACP delegated-payment keys are not internal keys so they pass through (delegated charge intact), and the auth gate reads the raw customFields so it is unaffected.