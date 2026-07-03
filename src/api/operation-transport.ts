/**
 * Maps operation transport metadata to HTTP request init and parses wire input via Zod schemas.
 */
import type { MikaRequestInit } from "./request";
import type { MikaApiOperation } from "./operations";
import { parseMikaInput, searchParamsObject, type z } from "./validation";

/** Builds fetch init (method, body, or search params) from an operation's transport mode. */
export function mikaOperationRequestInit(
  operation: Pick<MikaApiOperation, "httpMethod" | "transport">,
  input: unknown,
): MikaRequestInit {
  // Exhaustive over operation.transport (the registry-derived union of transports operations
  // actually use) with no default: an operation adopting a new transport becomes a noImplicitReturns
  // build error here instead of silently falling through to the body shape.
  switch (operation.transport) {
    case "none":
      return { method: operation.httpMethod };
    case "search":
      return { method: operation.httpMethod, search: input as MikaRequestInit["search"] };
    case "body":
      return { method: operation.httpMethod, body: input };
  }
}

/**
 * Extracts and validates operation input from body, search params, or empty transport.
 * Returns a {@link MikaValidationResult}; throws when the operation is missing a schema.
 */
export function parseMikaOperationInput(
  operation: MikaApiOperation,
  input: unknown,
  requestUrl: string | URL,
) {
  if (operation.transport === "none") {
    return { ok: true as const, data: undefined };
  }

  const schema = "schema" in operation ? operation.schema : undefined;
  if (!schema) {
    throw new Error(`Mika operation '${operation.name}' is missing an input schema.`);
  }

  // The "none" early return above narrows transport to "search" | "body"; switch exhaustively so a
  // future transport member is a noImplicitReturns build error rather than silently parsed as body.
  switch (operation.transport) {
    case "search":
      return parseMikaInput(
        schema as z.ZodType<unknown>,
        searchParamsObject(new URL(requestUrl), operation.searchKeys ?? []),
      );
    case "body":
      return parseMikaInput(schema as z.ZodType<unknown>, input ?? {});
  }
}
