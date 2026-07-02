/** Kysely handle types and scalar coercion helpers shared by the operational (SQL) repositories. */
import type { Kysely, Transaction } from "kysely";
import { decodeJsonObject } from "../json";
import type { MikaDatabase } from "../schema";
import type { JsonObject } from "../../types/primitives";

/** Kysely database handle for operational SQLite tables. */
export type MikaDb = Kysely<MikaDatabase>;
/** Transaction scope for atomic stock and ephemeral mutations. */
export type MikaTransaction = Transaction<MikaDatabase>;
/** Database or transaction executor accepted by operational repositories. */
export type MikaDbExecutor = MikaDb | MikaTransaction;

export function parseMetadata(text: string | null): JsonObject | undefined {
  if (!text) return undefined;
  return decodeJsonObject(text, "Mika metadata");
}

export function undef<T>(value: T | null): T | undefined {
  return value ?? undefined;
}

export function affected(count: bigint | number | undefined): boolean {
  if (typeof count === "bigint") return count > 0n;
  return (count ?? 0) > 0;
}
