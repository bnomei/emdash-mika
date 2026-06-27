DEVANA-FINDING: v1
Priority: P1 | Confidence: high | Security-sensitive: no | Status: open
Location: src/api/backend.ts:3789-3798 | Slug: external-fulfillment-line-dropped-on-replay

# Stored webhook replay silently drops "external" fulfillment lines

## Finding

`isFulfillmentKind` (backend.ts:3789-3798) accepts `"none" | "download" | "license" | "entitlement" | "physical"`, but the real `FulfillmentKind` type (primitives.ts:155) is `"none" | "entitlement" | "download" | "license" | "external"`. The validator rejects the valid kind `"external"` and accepts `"physical"`, which is not a member of the type and has no case in the fulfillment switch (backend.ts:4872).

When a payment webhook event is stored and later reconstructed for replay, `providerLineToJson` (backend.ts:3504-3533) serializes each line's `fulfillmentKind` verbatim (line 3530), and `storedWebhookEvent` re-parses it via `providerLineChildren` (line 3587). For a line whose `fulfillmentKind` is `"external"`, `isFulfillmentKind("external")` returns `false`, so `providerLineChildren` returns `[]` for that line (backend.ts:3713-3715) and the line vanishes from the reconstructed event.

## Violated Invariant Or Contract

Serialize/deserialize of a `MikaProviderLineItem` must round-trip: every `fulfillmentKind` the producer can emit must be accepted by the consumer that re-parses it. `providerLineToJson` can write `"external"` (the live, typed path handles it at backend.ts:4873-4874), but `providerLineChildren`/`isFulfillmentKind` cannot read it back.

## Oracle

- `FulfillmentKind` definition: src/types/primitives.ts:155 includes `"external"`, excludes `"physical"`.
- Fulfillment switch handles `"external"` as a real case: src/api/backend.ts:4873-4874 (`case "external": return fulfilledLine;`).
- Serializer preserves the field: src/api/backend.ts:3530.

## Counterexample

1. A catalog sellable is configured with `fulfillmentKind: "external"` (e.g. drop-ship / externally fulfilled goods).
2. A successful payment for that item is processed live; the typed line (`fulfillmentKind: "external"`) is serialized into the webhook record via `providerLineToJson` (line 3530).
3. The webhook later needs replay (failed/received/processing status, or admin `webhook.replay`). `storedWebhookEvent` calls `providerLineChildren(eventPayload, "lines")` (line 3587).
4. `isFulfillmentKind("external")` → `false` (line 3789-3798), so the external line returns `[]` (line 3713-3715).
5. The replayed event's `lines` no longer contains the paid external item; any order/fulfillment derived from the replay is missing that line.

## Why It Might Matter

Webhook replay is a recovery path used precisely when first delivery failed. A paid order line for an externally fulfilled product can be silently omitted from the reconstructed order, so the customer is charged but the item is dropped from order/fulfillment processing — order/payment data loss with no error surfaced. Symmetrically, a hypothetical `"physical"` value would pass validation yet hit no switch case at backend.ts:4872, falling through `fulfillPaidOrderLine` with no `return`.

## Proof

- Contract mismatch: producer set `{ "none", "entitlement", "download", "license", "external" }` (primitives.ts:155) vs validator accept-set `{ "none", "download", "license", "entitlement", "physical" }` (backend.ts:3790-3798). `"external"` is in the producer set but not the validator set.
- Dataflow / round-trip trace: typed line → `providerLineToJson` writes `fulfillmentKind` (backend.ts:3530) → stored `rawPayloadJson` → `storedWebhookEvent` → `providerLineChildren` reads `fulfillmentKind` (backend.ts:3705) → `isFulfillmentKind` rejects `"external"` → `return []` drops the line (backend.ts:3713-3715).
- Consumer proof that `"external"` is legitimate downstream: `fulfillPaidOrderLine` switch has `case "external"` (backend.ts:4873-4874).

## Counterevidence Checked

- The live provider adapter path builds `MikaProviderLineItem` with typed `fulfillmentKind` directly (not via `providerLineChildren`), so first-time processing is unaffected — the loss is specific to the stored/replay reconstruction. This makes the bug latent and replay-only, not blocked.
- `jsonObject` (backend.ts:3543) drops only `undefined` fields; `"external"` is a defined string and is written, so serialization is not what drops it — the deserialization validator is.
- No upstream normalization rewrites `"external"` to another accepted kind before `providerLineToJson`; the switch at backend.ts:4872 confirms `"external"` is carried as-is.

## Suggested Next Step

Replace `value === "physical"` with `value === "external"` in `isFulfillmentKind` (backend.ts:3797) so the accept-set matches `FulfillmentKind` (primitives.ts:155). Optionally derive the guard from a single source of truth to prevent future drift.

## Agent Handoff

After working this report, preserve the original finding body. Update line 2 `Status: ...` and the final `DEVANA-SUMMARY:` status. Use one of: `open`, `fixed`, `invalid`, `stale`, `duplicate`, `wontfix`. Add dated notes below with the evidence checked.

## Status Notes

- 2026-06-25: open by Devana. Initial report written from static source inspection.

DEVANA-KEY: src/api/backend.ts:3789-3798 | P1 | external-fulfillment-line-dropped-on-replay
DEVANA-SUMMARY: Status=open | P1 high src/api/backend.ts:3789-3798 - isFulfillmentKind rejects valid "external" (and accepts non-type "physical"), so stored payment webhooks drop external-fulfillment lines on replay, losing paid order items.
