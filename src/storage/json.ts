/**
 * JSON serialization helpers for aggregate payloads and document metadata in storage.
 */
import { isJsonObject, type JsonObject, type JsonValue } from "../types/primitives";

/** Serializes a value to a JSON text column. */
export function encodeJson(value: JsonValue): string {
  // JsonValue always stringifies to a string (JSON.stringify only returns undefined for undefined /
  // function / symbol, none of which are JsonValue), so the string return type is sound.
  return JSON.stringify(value);
}

/** Parses JSON text and requires a finite object envelope. */
export function decodeJsonObject(text: string, label = "JSON"): JsonObject {
  const parsed: unknown = JSON.parse(text);
  if (!isJsonObject(parsed)) {
    throw new Error(`${label} must be a JSON object`);
  }

  return parsed;
}
