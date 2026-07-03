/**
 * Idempotency-key injection for operation inputs. A pure leaf so consumers such as
 * astro-actions.ts can use it without pulling in the full plugin route-handler table.
 */
import type { MikaRouteOperation } from "./operations";

/**
 * Injects `idempotencyKey` from {@link MikaRequestContext} when the operation requires agent
 * idempotency, the input schema accepts the field, and the caller did not supply a non-empty key.
 */
export function mikaOperationInputWithIdempotencyContext(
  operation: MikaRouteOperation,
  input: unknown,
  idempotencyKey: string | undefined,
): unknown {
  if (
    !idempotencyKey ||
    operation.agent.idempotency !== "required" ||
    !operation.agent.idempotencyKey ||
    !operation.acceptsIdempotencyKey ||
    !isRecord(input) ||
    hasNonEmptyIdempotencyKey(input)
  ) {
    return input;
  }

  return {
    ...input,
    idempotencyKey,
  };
}

// Caller-supplied idempotency keys take precedence over the request-context header value.
function hasNonEmptyIdempotencyKey(input: Record<string, unknown>): boolean {
  const value = input["idempotencyKey"];

  return typeof value === "string" && value.trim().length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
