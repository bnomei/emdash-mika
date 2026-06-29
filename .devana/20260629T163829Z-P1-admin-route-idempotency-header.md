DEVANA-FINDING: v1
DEVANA-STATE: open | P1 | medium | security=no
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

DEVANA-KEY: src/api/route-handlers.ts:164 | admin-route-idempotency-header
DEVANA-SUMMARY: open | P1 | medium | Idempotency-Key header is read on direct admin plugin routes but not forwarded into admin API input.