/**
 * JSON serialization helpers for aggregate payloads and document metadata in storage.
 * Decoding validates schema version and branded primitive fields.
 */
import {
  createCurrencyCode,
  createISODateTime,
  createMikaId,
  createProviderName,
  isJsonObject,
  type AggregatePayload,
  type JsonObject,
} from "../types/primitives";

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

/** Decodes and validates a versioned aggregate payload from JSON text. */
export function decodeAggregate<TPayload extends AggregatePayload>(
  text: string,
  expectedSchemaVersion = 1,
): TPayload {
  const parsed = decodeJsonObject(text, "Aggregate");
  if (!isRecord(parsed)) {
    throw new Error("Expected aggregate JSON object");
  }

  if (parsed["schemaVersion"] !== expectedSchemaVersion) {
    throw new Error(
      `Unsupported aggregate schema version: ${formatJsonDiagnosticValue(parsed["schemaVersion"])}`,
    );
  }

  validatePrimitiveFields(parsed);

  return parsed as unknown as TPayload;
}

/** Type guard for plain object records during JSON validation. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function formatJsonDiagnosticValue(value: unknown): string {
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean" ||
    value === null
  ) {
    return String(value);
  }

  return JSON.stringify(value) ?? "undefined";
}

function validatePrimitiveFields(value: unknown): void {
  if (Array.isArray(value)) {
    for (const item of value) validatePrimitiveFields(item);
    return;
  }

  if (!isRecord(value)) return;

  for (const [key, child] of Object.entries(value)) {
    validatePrimitiveField(key, child);
    validatePrimitiveFields(child);
  }
}

function validatePrimitiveField(key: string, value: unknown): void {
  if (typeof value !== "string") return;

  try {
    if (key === "currency") createCurrencyCode(value);
    if (key === "provider") createProviderName(value);
    if (key === "id" || key.endsWith("Id")) createMikaId(value);
    if (key.endsWith("At")) createISODateTime(value);
  } catch (error) {
    const message = error instanceof Error ? error.message : "invalid primitive value";
    throw new Error(`Invalid aggregate field '${key}': ${message}`);
  }
}
