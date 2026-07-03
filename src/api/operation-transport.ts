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
  if (operation.transport === "none") {
    return { method: operation.httpMethod };
  }

  if (operation.transport === "search") {
    return {
      method: operation.httpMethod,
      search: input as MikaRequestInit["search"],
    };
  }

  return {
    method: operation.httpMethod,
    body: input,
  };
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

  const rawInput =
    operation.transport === "search"
      ? searchParamsObject(new URL(requestUrl), operation.searchKeys ?? [])
      : (input ?? {});

  return parseMikaInput(schema as z.ZodType<unknown>, rawInput);
}
