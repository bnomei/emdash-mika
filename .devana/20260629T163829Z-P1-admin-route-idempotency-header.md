DEVANA-FINDING: v1
DEVANA-STATE: fixed | P1 | medium | security=no
DEVANA-KEY: src/api/route-handlers.ts:164 | admin-route-idempotency-header

# Direct admin plugin routes drop Idempotency-Key header

## Finding

`handleRouteOperation` reads `Idempotency-Key` into `mikaContext.idempotencyKey` but admin operations are defined with `requiresRequestContext: false`. `createDefaultMikaOperationCall` invokes admin API methods with `input` only—the context idempotency key is never injected. `adminRunnerInputWithContext` (which copies the header into the body) runs only in `handleActionRunner`, not direct plugin routes.

## Violated Invariant Or Contract

Agent metadata documents host-owned idempotency via `MIKA_AGENT_IDEMPOTENCY_KEY_HEADER`. Admin mutations in `ADMIN_IDEMPOTENT_OPERATIONS` expect the header to reach backend `input.idempotencyKey` for replay-safe execution.

## Oracle

`handleActionRunner` test path injects header into input. Direct admin plugin routes register the same operations with `requiresRequestContext: false` (`operations.ts`). Backend `stockAdjust` and similar methods read `input.idempotencyKey`, not `ctx`.

## Counterexample

Two POSTs to direct admin plugin route `admin/stock/adjust` with identical body and same `Idempotency-Key` header execute twice; header is on `ctx` but never reaches `stockAdjust` input.

## Why It Might Matter

Duplicate stock adjustments, refunds, or entitlement changes when agents call plugin routes instead of the admin action runner.

## Proof

**Cross-entry mismatch:** admin action runner injects header → input; direct route does not.

Locations: `src/api/route-handlers.ts` (`handleRouteOperation` ~164–171 vs `handleActionRunner` ~106–110, `adminRunnerInputWithContext` ~128–145), `src/api/operations.ts` (`createDefaultMikaOperationCall` ~317–327, admin ops `requiresRequestContext: false`).

## Counterevidence Checked

Callers can place `idempotencyKey` in JSON body per input schemas. `operationPolicy` could copy the header (not default). Issue affects header-only agent contract on direct routes specifically.

## Suggested Next Step

Inject `ctx.idempotencyKey` into admin operation input in `handleRouteOperation`, mirroring `adminRunnerInputWithContext`.

## Agent Handoff

After working this report, preserve the original finding body. Update line 2 `DEVANA-STATE: ...` and the final `DEVANA-SUMMARY:` status/priority/confidence prefix.

## Status Notes

- 2026-06-29: open by Devana. Initial report written from static source inspection across outside-in-entrypoints and contracts-errors trails.
- 2026-06-29: fixed. `handleRouteOperation` now passes the operation input through `adminRunnerInputWithContext(operation, parsedInput.data, mikaContext.idempotencyKey)` before invoking `runMikaOperation`, exactly as `handleActionRunner` already did. Admin operations are registered with `requiresRequestContext: false`, so the backend reads `input.idempotencyKey` (not `ctx`); previously the `Idempotency-Key` header was hydrated onto `mikaContext` but dropped on direct plugin routes, so two header-only POSTs with identical bodies re-executed the mutation instead of replaying. `adminRunnerInputWithContext` only injects when the operation is in `ADMIN_IDEMPOTENT_OPERATIONS`, the input is a record, and no `idempotencyKey` is already present in the body — so non-admin and non-idempotent routes, and callers that put the key in the JSON body, are unaffected. Combined with the admin idempotency-replay fix, the header now reaches the same replay-safe path the action runner uses. Scope: direct admin plugin routes only. Evidence: a new test posts to `admin/stock/adjust` and asserts the admin method receives `idempotencyKey` from the header, and that omitting the header injects nothing; the test was confirmed to fail before the change. Full suite (356) and both tsc configs pass.

DEVANA-KEY: src/api/route-handlers.ts:164 | admin-route-idempotency-header
DEVANA-SUMMARY: fixed | P1 | medium | handleRouteOperation now forwards the Idempotency-Key header into admin operation input via adminRunnerInputWithContext (mirroring the action runner), so direct admin plugin-route retries replay instead of re-executing.