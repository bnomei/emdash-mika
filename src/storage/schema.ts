/**
 * Kysely schema types for operational SQLite tables backing stock and ephemeral records.
 * Maps snake_case columns to domain record shapes used by repositories.
 */
import type { ColumnType, Insertable, Selectable, Updateable } from "kysely";

import type { EphemeralRecord, StockEventRecord, StockItemRecord } from "../types/operational";

type OptionalColumn<T> = ColumnType<T, T | undefined, T>;
type NullableColumn<T> = ColumnType<T | null, T | null | undefined, T | null>;
type JsonText = string;
type SqlBool = 0 | 1;

/** SQLite table schema for atomic stock item quantity state. */
export interface MikaStockItemsTable {
  id: string;
  sellable_id: string;
  policy: StockItemRecord["policy"];
  quantity_on_hand: OptionalColumn<number>;
  quantity_reserved: OptionalColumn<number>;
  low_stock_threshold: NullableColumn<number>;
  allow_backorder: OptionalColumn<SqlBool>;
  available_override: NullableColumn<SqlBool>;
  metadata_json: NullableColumn<JsonText>;
  created_at: string;
  updated_at: string;
}

/** SQLite table schema for reservation and movement stock event records. */
export interface MikaStockEventsTable {
  id: string;
  stock_item_id: string;
  kind: StockEventRecord["kind"];
  status: StockEventRecord["status"];
  reason: NullableColumn<NonNullable<StockEventRecord["reason"]>>;
  reservation_event_id: NullableColumn<string>;
  cart_id: NullableColumn<string>;
  checkout_session_id: NullableColumn<string>;
  customer_id: NullableColumn<string>;
  session_id: NullableColumn<string>;
  order_id: NullableColumn<string>;
  order_line_id: NullableColumn<string>;
  admin_audit_id: NullableColumn<string>;
  idempotency_key: NullableColumn<string>;
  quantity_delta: number;
  expires_at: NullableColumn<string>;
  metadata_json: NullableColumn<JsonText>;
  created_at: string;
  updated_at: string;
}

/** SQLite table schema for TTL-bound ephemeral records. */
export interface MikaEphemeralRecordsTable {
  key: string;
  kind: EphemeralRecord["kind"];
  subject_hash: NullableColumn<string>;
  status: EphemeralRecord["status"];
  count: OptionalColumn<number>;
  expires_at: string;
  version: OptionalColumn<number>;
  data_json: NullableColumn<JsonText>;
  created_at: string;
  updated_at: string;
}

/** Kysely database schema for Mika operational SQLite tables. */
export interface MikaDatabase {
  mika_stock_items: MikaStockItemsTable;
  mika_stock_events: MikaStockEventsTable;
  mika_ephemeral_records: MikaEphemeralRecordsTable;
}

/** Operational table name within the Mika SQLite schema. */
export type MikaTableName = keyof MikaDatabase;
/** Row shape returned when selecting from an operational table. */
export type MikaSelectable<TTable extends MikaTableName> = Selectable<MikaDatabase[TTable]>;
/** Insertable row shape for an operational table. */
export type MikaInsertable<TTable extends MikaTableName> = Insertable<MikaDatabase[TTable]>;
/** Partial update shape for an operational table. */
export type MikaUpdateable<TTable extends MikaTableName> = Updateable<MikaDatabase[TTable]>;
