/**
 * JSON serialization helpers for aggregate payloads and document metadata in storage.
 */
import { isJsonObject, type JsonObject } from "../types/primitives";

/** Serializes a value to a JSON text column. */
export function encodeJson(value: unknown): string {
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
