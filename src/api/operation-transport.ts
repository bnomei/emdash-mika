import type { MikaRequestInit } from "./request";
import type { MikaRouteOperation } from "./operations";
import { parseMikaInput, searchParamsObject, type z } from "./validation";

export function mikaOperationRequestInit(
  operation: Pick<MikaRouteOperation, "httpMethod" | "transport">,
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

export function parseMikaOperationInput(
  operation: MikaRouteOperation,
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
