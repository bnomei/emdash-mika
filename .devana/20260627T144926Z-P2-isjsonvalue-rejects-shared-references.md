DEVANA-FINDING: v1
DEVANA-STATE: open | P2 | high | security=no
DEVANA-KEY: src/types/primitives.ts:95-96 | isjsonvalue-rejects-shared-references

# isJsonValue rejects valid JSON that reuses an object reference (shared subtree / diamond)

## Finding

The hardened iterative `isJsonValue` uses one `seen: Set<object>` for the whole traversal and returns `false` on any object already in `seen`:

```ts
// src/types/primitives.ts:94-96
case "object": {
  if (seen.has(currentValue)) return false;
  seen.add(currentValue);
```

`seen` is never cleared on backtrack. That detects true cycles, but it also rejects a value where the **same object instance appears under two different keys/indices** — a shared, non-cyclic "diamond", which is perfectly valid JSON.

## Violated Invariant Or Contract

`isJsonValue`/`isJsonObject` is the type guard for `JsonValue`/`JsonObject`. Any value `JSON.stringify` can serialize losslessly must pass. A shared (non-cyclic) reference serializes fine but is rejected.

## Oracle

`JSON.stringify({ a: ref, b: ref })` succeeds and round-trips, so the value is a legitimate `JsonValue`; the guard nonetheless returns `false`. The pre-hardening recursive version (commit 9670dd3) had no `seen` set and accepted this value — the regression was introduced by the hardening change.

## Counterexample

```js
const ref = { v: 1 };
const value = { a: ref, b: ref };   // valid JSON: {"a":{"v":1},"b":{"v":1}}
isJsonObject(value); // => false (should be true)
```

Trace: pop `value` → add to `seen`, push `ref` (from `a`) and `ref` (from `b`); pop first `ref` → add to `seen`; later pop second `ref` → `seen.has(ref)` is true → `return false`.

## Why It Might Matter

`isJsonObject` backs `jsonObjectSchema`/`optionalJsonObjectSchema` (`src/api/validation.ts:103-109`), used for `metadata`/`customFields` on input schemas (e.g. `stockAdjustInputSchema.metadata`, `cartQuoteInputSchema.customFields`, `startCheckoutInputSchema.customFields`). For non-string inputs `parseJsonFormValue` returns the object unchanged (`validation.ts:455-457`), so a programmatic caller passing `metadata: { primary: tag, secondary: tag }` (a reused constant — a common pattern when building objects in code) receives a spurious `VALIDATION_FAILED` (422). JSON parsed from a string never contains shared refs, so the string/form path is unaffected; the bug bites object inputs handed in directly.

## Proof

Pure data-structure counterexample against the guard's own postcondition; no execution required. `seen` accumulates across the entire DFS and is never reduced, so any value with a duplicated object reference is rejected.

## Counterevidence Checked

- "Inputs always arrive as JSON strings (parsed → no shared refs)." Evidence against: `parseJsonFormValue` returns non-string values as-is (`validation.ts:455-457`) and the public typed API (`StockAdjustInput`, `CheckoutPreviewInput`, etc.) accepts `JsonObject` objects directly. Reused sub-objects are a supported, reachable input.
- Cycle detection is still desired and still works (a true cycle revisits a node on the same path); the bug is the over-rejection of non-cyclic shared references.

## Suggested Next Step

Track ancestry on the current path (e.g. a per-branch ancestor set or depth-tagged removal) instead of a monotonic global `seen`, or detect cycles via depth bound only; keep the node/depth caps for DoS protection.

## Agent Handoff

Preserve the original finding body. Update line 2 `DEVANA-STATE:` and the final `DEVANA-SUMMARY:` prefix. Keep `DEVANA-KEY:` stable unless the finding moved.

## Status Notes

- 2026-06-27: open by Devana. Verified primitives.ts:73-114; `seen` never cleared; reachable via validation.ts jsonObjectSchema.

DEVANA-KEY: src/types/primitives.ts:95-96 | isjsonvalue-rejects-shared-references
DEVANA-SUMMARY: open | P2 | high | isJsonValue uses a monotonic seen-set and rejects valid JSON containing a shared (non-cyclic) object reference, causing spurious VALIDATION_FAILED on metadata/customFields object inputs.
