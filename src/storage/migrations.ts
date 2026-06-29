/**
 * Kysely migrations for atomic stock and ephemeral operational tables in SQLite.
 * Creates reservation, movement, and ephemeral record storage used by repositories.
 */
import { sql, type Kysely, type Migration } from "kysely";

/** Named migration with stable id for operational SQLite schema evolution. */
export interface MikaMigration extends Migration {
  readonly id: string;
  readonly name: string;
}

/** Initial migration creating stock item, stock event, and ephemeral record tables. */
export const mikaInitialMigration: MikaMigration = {
  id: "0001",
  name: "initial_atomic_stock_and_ephemeral_state",
  async up(db: Kysely<unknown>): Promise<void> {
    await createStockItemsTable(db);
    await createStockEventsTable(db);
    await createEphemeralRecordsTable(db);
    await optimizeIfSupported(db);
  },
  async down(db: Kysely<unknown>): Promise<void> {
    await db.schema.dropTable("mika_ephemeral_records").ifExists().execute();
    await db.schema.dropTable("mika_stock_events").ifExists().execute();
    await db.schema.dropTable("mika_stock_items").ifExists().execute();
  },
};

/** Alias of the initial migration for atomic operational storage bootstrap. */
export const initialAtomicStorageMigration: Migration = mikaInitialMigration;

/** Ordered registry of all Mika SQLite migrations. */
export const mikaMigrations = [mikaInitialMigration] as const;

/** Kysely migration provider map keyed by migration name. */
export const mikaKyselyMigrations = {
  "0001_initial_atomic_stock_and_ephemeral_state": initialAtomicStorageMigration,
} satisfies Record<string, Migration>;

/** Runs a single migration against a Kysely database executor. */
export async function executeMikaMigration(
  db: Kysely<unknown>,
  migration: Migration = mikaInitialMigration,
): Promise<void> {
  await migration.up(db);
}

async function createStockItemsTable(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("mika_stock_items")
    .ifNotExists()
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("sellable_id", "text", (col) => col.notNull().unique())
    .addColumn("policy", "text", (col) => col.notNull())
    .addColumn("quantity_on_hand", "integer", (col) => col.notNull().defaultTo(0))
    .addColumn("quantity_reserved", "integer", (col) => col.notNull().defaultTo(0))
    .addColumn("low_stock_threshold", "integer")
    .addColumn("allow_backorder", "integer", (col) => col.notNull().defaultTo(0))
    .addColumn("available_override", "integer")
    .addColumn("metadata_json", "text")
    .addColumn("created_at", "text", (col) => col.notNull())
    .addColumn("updated_at", "text", (col) => col.notNull())
    .execute();

  await db.schema
    .createIndex("idx_mika_stock_items_policy_quantities")
    .ifNotExists()
    .on("mika_stock_items")
    .columns(["policy", "quantity_on_hand", "quantity_reserved"])
    .execute();
}

async function createStockEventsTable(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("mika_stock_events")
    .ifNotExists()
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("stock_item_id", "text", (col) => col.notNull())
    .addColumn("kind", "text", (col) => col.notNull())
    .addColumn("status", "text", (col) => col.notNull())
    .addColumn("reason", "text")
    .addColumn("reservation_event_id", "text")
    .addColumn("cart_id", "text")
    .addColumn("checkout_session_id", "text")
    .addColumn("customer_id", "text")
    .addColumn("session_id", "text")
    .addColumn("order_id", "text")
    .addColumn("order_line_id", "text")
    .addColumn("admin_audit_id", "text")
    .addColumn("idempotency_key", "text")
    .addColumn("quantity_delta", "integer", (col) => col.notNull())
    .addColumn("expires_at", "text")
    .addColumn("metadata_json", "text")
    .addColumn("created_at", "text", (col) => col.notNull())
    .addColumn("updated_at", "text", (col) => col.notNull())
    .execute();

  await db.schema
    .createIndex("idx_mika_stock_events_item_status_expires")
    .ifNotExists()
    .on("mika_stock_events")
    .columns(["stock_item_id", "status", "expires_at"])
    .execute();

  await db.schema
    .createIndex("idx_mika_stock_events_checkout_status")
    .ifNotExists()
    .on("mika_stock_events")
    .columns(["checkout_session_id", "status"])
    .execute();

  await db.schema
    .createIndex("idx_mika_stock_events_status_expires")
    .ifNotExists()
    .on("mika_stock_events")
    .columns(["status", "expires_at"])
    .execute();

  await db.schema
    .createIndex("idx_mika_stock_events_order_line")
    .ifNotExists()
    .on("mika_stock_events")
    .column("order_line_id")
    .execute();

  await db.schema
    .createIndex("idx_mika_stock_events_idempotency")
    .ifNotExists()
    .unique()
    .on("mika_stock_events")
    .column("idempotency_key")
    .execute();
}

async function createEphemeralRecordsTable(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("mika_ephemeral_records")
    .ifNotExists()
    .addColumn("key", "text", (col) => col.primaryKey())
    .addColumn("kind", "text", (col) => col.notNull())
    .addColumn("subject_hash", "text")
    .addColumn("status", "text", (col) => col.notNull())
    .addColumn("count", "integer", (col) => col.notNull().defaultTo(0))
    .addColumn("expires_at", "text", (col) => col.notNull())
    .addColumn("version", "integer", (col) => col.notNull().defaultTo(1))
    .addColumn("data_json", "text")
    .addColumn("created_at", "text", (col) => col.notNull())
    .addColumn("updated_at", "text", (col) => col.notNull())
    .execute();

  await db.schema
    .createIndex("idx_mika_ephemeral_kind_status_expires")
    .ifNotExists()
    .on("mika_ephemeral_records")
    .columns(["kind", "status", "expires_at"])
    .execute();

  await db.schema
    .createIndex("idx_mika_ephemeral_subject_kind_status")
    .ifNotExists()
    .on("mika_ephemeral_records")
    .columns(["subject_hash", "kind", "status"])
    .execute();

  await db.schema
    .createIndex("idx_mika_ephemeral_expires")
    .ifNotExists()
    .on("mika_ephemeral_records")
    .column("expires_at")
    .execute();
}

async function optimizeIfSupported(db: Kysely<unknown>): Promise<void> {
  try {
    await sql`PRAGMA optimize`.execute(db);
  } catch {
    // Postgres and some future dialects do not support SQLite PRAGMAs.
  }
}
