import { sql } from "kysely";
import { optionalProperty } from "../../internal/object";
import { encodeJson } from "../json";
import type { MikaSelectable } from "../schema";
import type { EphemeralRecord } from "../../types/operational";
import type { ISODateTime, JsonObject } from "../../types/primitives";
import { createISODateTime } from "../../types/primitives";
import { affected, parseMetadata, undef, type MikaDbExecutor } from "./db-shared";

/**
 * Kind-specific lifecycle statuses written to the ephemeral `status` column (typed `string` in the
 * schema, so these magic strings are otherwise unchecked). Routing every literal through these
 * constants turns a typo into a compile error.
 */
type EphemeralLifecycleStatus = "active" | "held" | "released" | "pending" | "consumed";
const EPHEMERAL_STATUS = {
  active: "active",
  held: "held",
  released: "released",
  pending: "pending",
  consumed: "consumed",
} as const satisfies Record<EphemeralLifecycleStatus, EphemeralLifecycleStatus>;

/** Operational repository for TTL-bound ephemeral records and token consumption. */
export class EphemeralRepository {
  private readonly db: MikaDbExecutor;

  constructor(db: MikaDbExecutor) {
    this.db = db;
  }

  async get(key: string): Promise<EphemeralRecord | null> {
    const row = await this.db
      .selectFrom("mika_ephemeral_records")
      .selectAll()
      .where("key", "=", key)
      .executeTakeFirst();

    return row ? mapEphemeral(row) : null;
  }

  async put(record: EphemeralRecord): Promise<void> {
    await this.db
      .insertInto("mika_ephemeral_records")
      .values({
        key: record.key,
        kind: record.kind,
        subject_hash: record.subjectHash ?? null,
        status: record.status,
        count: record.count,
        expires_at: record.expiresAt,
        version: record.version,
        data_json: record.data ? encodeJson(record.data) : null,
        created_at: record.createdAt,
        updated_at: record.updatedAt,
      })
      .onConflict((oc) =>
        oc.column("key").doUpdateSet({
          kind: record.kind,
          subject_hash: record.subjectHash ?? null,
          status: record.status,
          count: record.count,
          expires_at: record.expiresAt,
          version: record.version,
          data_json: record.data ? encodeJson(record.data) : null,
          updated_at: record.updatedAt,
        }),
      )
      .execute();
  }

  async incrementCounter(input: {
    readonly key: string;
    readonly kind: EphemeralRecord["kind"];
    readonly subjectHash?: string;
    readonly status?: string;
    readonly expiresAt: ISODateTime;
    readonly now: ISODateTime;
    readonly data?: JsonObject;
  }): Promise<EphemeralRecord> {
    await this.db
      .insertInto("mika_ephemeral_records")
      .values({
        key: input.key,
        kind: input.kind,
        subject_hash: input.subjectHash ?? null,
        status: input.status ?? EPHEMERAL_STATUS.active,
        count: 1,
        expires_at: input.expiresAt,
        version: 1,
        data_json: input.data ? encodeJson(input.data) : null,
        created_at: input.now,
        updated_at: input.now,
      })
      .onConflict((oc) =>
        oc.column("key").doUpdateSet({
          kind: input.kind,
          subject_hash: input.subjectHash ?? null,
          status: input.status ?? EPHEMERAL_STATUS.active,
          count: sql<number>`count + 1`,
          version: sql<number>`version + 1`,
          expires_at: input.expiresAt,
          data_json: input.data ? encodeJson(input.data) : null,
          updated_at: input.now,
        }),
      )
      .execute();

    const record = await this.get(input.key);
    if (!record) {
      throw new Error(`Failed to increment ephemeral record '${input.key}'.`);
    }

    return record;
  }

  async tryAcquireLock(input: {
    readonly key: string;
    readonly owner: string;
    readonly subjectHash?: string;
    readonly expiresAt: ISODateTime;
    readonly now: ISODateTime;
  }): Promise<EphemeralRecord | null> {
    const ownerData = ephemeralLockOwnerData(input.owner);
    const updated = await this.db
      .updateTable("mika_ephemeral_records")
      .set((eb) => ({
        subject_hash: input.subjectHash ?? null,
        status: EPHEMERAL_STATUS.held,
        count: eb("count", "+", 1),
        expires_at: input.expiresAt,
        version: eb("version", "+", 1),
        data_json: ownerData,
        updated_at: input.now,
      }))
      .where("key", "=", input.key)
      .where("kind", "=", "lock")
      .where((eb) =>
        eb.or([
          eb("status", "!=", EPHEMERAL_STATUS.held),
          eb("expires_at", "<=", input.now),
          eb("data_json", "=", ownerData),
        ]),
      )
      .executeTakeFirst();
    if (affected(updated.numUpdatedRows)) return this.get(input.key);

    const inserted = await this.db
      .insertInto("mika_ephemeral_records")
      .values({
        key: input.key,
        kind: "lock",
        subject_hash: input.subjectHash ?? null,
        status: EPHEMERAL_STATUS.held,
        count: 1,
        expires_at: input.expiresAt,
        version: 1,
        data_json: ownerData,
        created_at: input.now,
        updated_at: input.now,
      })
      .onConflict((oc) => oc.column("key").doNothing())
      .executeTakeFirst();

    return affected(inserted.numInsertedOrUpdatedRows) ? this.get(input.key) : null;
  }

  async releaseLock(input: {
    readonly key: string;
    readonly owner: string;
    readonly now: ISODateTime;
  }): Promise<boolean> {
    const result = await this.db
      .updateTable("mika_ephemeral_records")
      .set((eb) => ({
        status: EPHEMERAL_STATUS.released,
        expires_at: input.now,
        version: eb("version", "+", 1),
        updated_at: input.now,
      }))
      .where("key", "=", input.key)
      .where("kind", "=", "lock")
      .where("status", "=", EPHEMERAL_STATUS.held)
      .where("data_json", "=", ephemeralLockOwnerData(input.owner))
      .executeTakeFirst();

    return affected(result.numUpdatedRows);
  }

  async consumeToken(key: string, now: ISODateTime): Promise<boolean> {
    const result = await this.db
      .updateTable("mika_ephemeral_records")
      .set((eb) => ({
        status: EPHEMERAL_STATUS.consumed,
        version: eb("version", "+", 1),
        updated_at: now,
      }))
      .where("key", "=", key)
      .where("kind", "=", "token")
      .where("status", "=", EPHEMERAL_STATUS.pending)
      .where("expires_at", ">", now)
      .executeTakeFirst();

    return affected(result.numUpdatedRows);
  }

  async restoreToken(key: string, now: ISODateTime): Promise<boolean> {
    const result = await this.db
      .updateTable("mika_ephemeral_records")
      .set((eb) => ({
        status: EPHEMERAL_STATUS.pending,
        version: eb("version", "+", 1),
        updated_at: now,
      }))
      .where("key", "=", key)
      .where("kind", "=", "token")
      .where("status", "=", EPHEMERAL_STATUS.consumed)
      .executeTakeFirst();

    return affected(result.numUpdatedRows);
  }

  async purgeExpired(now: ISODateTime): Promise<number> {
    const result = await this.db
      .deleteFrom("mika_ephemeral_records")
      .where("expires_at", "<=", now)
      .executeTakeFirst();

    return Number(result.numDeletedRows ?? 0);
  }

  async deleteTokensBySubjectHashes(subjectHashes: readonly string[]): Promise<number> {
    if (subjectHashes.length === 0) return 0;

    const result = await this.db
      .deleteFrom("mika_ephemeral_records")
      // "cache_marker" covers the download-token reuse pointer (createOrderLineDownloadToken):
      // it carries the same subjectHash as the "token" record it points to, and must be purged
      // alongside it — otherwise account-delete erasure leaves a subject-linked pointer behind.
      .where("kind", "in", ["token", "cache_marker"])
      .where("subject_hash", "in", [...new Set(subjectHashes)])
      .executeTakeFirst();

    return Number(result.numDeletedRows ?? 0);
  }
}

function mapEphemeral(row: MikaSelectable<"mika_ephemeral_records">): EphemeralRecord {
  return {
    key: row.key,
    kind: row.kind,
    ...optionalProperty("subjectHash", undef(row.subject_hash)),
    status: row.status,
    count: row.count,
    expiresAt: createISODateTime(row.expires_at),
    version: row.version,
    createdAt: createISODateTime(row.created_at),
    updatedAt: createISODateTime(row.updated_at),
    ...optionalProperty("data", parseMetadata(row.data_json)),
  };
}

function ephemeralLockOwnerData(owner: string): string {
  return encodeJson({ owner });
}
