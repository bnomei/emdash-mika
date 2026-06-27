/**
 * In-memory {@link StorageCollection} implementation for repository and query tests.
 */
import type {
  MikaIndex,
  PaginatedStorageResult,
  StorageCollection,
  StorageQueryOptions,
  StorageWhereClause,
  StorageWhereValue,
} from "../../src/storage/collections";

type StorageItem<TDocument> = {
  readonly id: string;
  readonly data: TDocument;
};

/** Map-backed storage collection with query, pagination, and unique index checks. */
export function createMemoryStorageCollection<TDocument>(): StorageCollection<TDocument> {
  return createMemoryStorageCollectionWithConfig<TDocument>();
}

/** Memory collection with optional unique index enforcement on write. */
export function createMemoryStorageCollectionWithConfig<TDocument>(
  config: {
    readonly uniqueIndexes?: readonly MikaIndex<TDocument>[];
  } = {},
): StorageCollection<TDocument> {
  const records = new Map<string, TDocument>();

  return {
    async get(id) {
      return records.get(id) ?? null;
    },
    async put(id, data) {
      assertUniqueIndexes(records, id, data, config.uniqueIndexes ?? []);
      records.set(id, data);
    },
    async update(id, updater) {
      const updated = updater(records.get(id) ?? null);
      if (!updated) return null;

      assertUniqueIndexes(records, id, updated, config.uniqueIndexes ?? []);
      records.set(id, updated);

      return updated;
    },
    async delete(id) {
      return records.delete(id);
    },
    async exists(id) {
      return records.has(id);
    },
    async getMany(ids) {
      const found = new Map<string, TDocument>();

      for (const id of ids) {
        const data = records.get(id);
        if (data !== undefined) {
          found.set(id, data);
        }
      }

      return found;
    },
    async putMany(items) {
      for (const item of items) {
        assertUniqueIndexes(records, item.id, item.data, config.uniqueIndexes ?? []);
        records.set(item.id, item.data);
      }
    },
    async deleteMany(ids) {
      let deleted = 0;

      for (const id of ids) {
        if (records.delete(id)) {
          deleted += 1;
        }
      }

      return deleted;
    },
    async query(options = {}) {
      return queryRecords(records, options);
    },
    async count(where) {
      return Array.from(records.values()).filter((data) => matchesWhere(data, where)).length;
    },
  };
}

function assertUniqueIndexes<TDocument>(
  records: Map<string, TDocument>,
  id: string,
  data: TDocument,
  uniqueIndexes: readonly MikaIndex<TDocument>[],
): void {
  for (const index of uniqueIndexes) {
    const fields = indexFields(index);
    const values = fields.map((field) => getDocumentField(data, field));
    if (values.some((value) => value === undefined || value === null)) continue;

    for (const [existingId, existing] of records) {
      if (existingId === id) continue;
      const matches = fields.every(
        (field, fieldIndex) => getDocumentField(existing, field) === values[fieldIndex],
      );
      if (matches) {
        throw new Error(`Unique storage index violation for ${fields.join(", ")}.`);
      }
    }
  }
}

function indexFields<TDocument>(index: MikaIndex<TDocument>): readonly string[] {
  return typeof index === "string" ? [index] : [...index];
}

function queryRecords<TDocument>(
  records: Map<string, TDocument>,
  options: StorageQueryOptions<TDocument>,
): PaginatedStorageResult<StorageItem<TDocument>> {
  const offset = parseCursor(options.cursor);
  const limit = options.limit ?? Number.POSITIVE_INFINITY;
  const items = Array.from(records.entries())
    .map(([id, data]) => ({ id, data }))
    .filter((item) => matchesWhere(item.data, options.where))
    .sort((left, right) => compareItems(left, right, options.orderBy));
  const page = items.slice(offset, offset + limit);
  const nextOffset = offset + page.length;
  const hasMore = nextOffset < items.length;

  return {
    items: page,
    cursor: hasMore ? String(nextOffset) : undefined,
    hasMore,
  };
}

function parseCursor(cursor: string | undefined): number {
  if (cursor === undefined) return 0;

  const offset = Number.parseInt(cursor, 10);
  return Number.isSafeInteger(offset) && offset >= 0 ? offset : 0;
}

function compareItems<TDocument>(
  left: StorageItem<TDocument>,
  right: StorageItem<TDocument>,
  orderBy: StorageQueryOptions<TDocument>["orderBy"],
): number {
  for (const [field, direction] of Object.entries(orderBy ?? {})) {
    const result = compareValues(
      getDocumentField(left.data, field),
      getDocumentField(right.data, field),
    );
    if (result !== 0) {
      return direction === "desc" ? -result : result;
    }
  }

  return left.id.localeCompare(right.id);
}

function compareValues(left: unknown, right: unknown): number {
  if (left === right) return 0;
  if (left === undefined || left === null) return -1;
  if (right === undefined || right === null) return 1;
  if (typeof left === "number" && typeof right === "number") return left - right;

  return comparableString(left).localeCompare(comparableString(right));
}

function comparableString(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return value.toString();
  }

  return "";
}

function matchesWhere<TDocument>(
  data: TDocument,
  where: StorageWhereClause<TDocument> | undefined,
): boolean {
  for (const [field, filter] of Object.entries(where ?? {})) {
    if (!matchesFilter(getDocumentField(data, field), filter as StorageWhereValue)) {
      return false;
    }
  }

  return true;
}

function getDocumentField(data: unknown, field: string): unknown {
  return typeof data === "object" && data !== null ? Reflect.get(data, field) : undefined;
}

function matchesFilter(value: unknown, filter: StorageWhereValue): boolean {
  if (isStorageInFilter(filter)) {
    return filter.in.includes(value as string | number);
  }

  if (isStorageStartsWithFilter(filter)) {
    return typeof value === "string" && value.startsWith(filter.startsWith);
  }

  if (isStorageRangeFilter(filter)) {
    return matchesRangeFilter(value, filter);
  }

  return value === filter;
}

function isStorageInFilter(
  filter: StorageWhereValue,
): filter is { readonly in: readonly (string | number)[] } {
  return typeof filter === "object" && filter !== null && "in" in filter;
}

function isStorageStartsWithFilter(
  filter: StorageWhereValue,
): filter is { readonly startsWith: string } {
  return typeof filter === "object" && filter !== null && "startsWith" in filter;
}

function isStorageRangeFilter(filter: StorageWhereValue): filter is {
  readonly gt?: number | string;
  readonly gte?: number | string;
  readonly lt?: number | string;
  readonly lte?: number | string;
} {
  return (
    typeof filter === "object" &&
    filter !== null &&
    ("gt" in filter || "gte" in filter || "lt" in filter || "lte" in filter)
  );
}

function matchesRangeFilter(
  value: unknown,
  filter: {
    readonly gt?: number | string;
    readonly gte?: number | string;
    readonly lt?: number | string;
    readonly lte?: number | string;
  },
): boolean {
  if (typeof value !== "number" && typeof value !== "string") return false;
  if (filter.gt !== undefined && !(value > filter.gt)) return false;
  if (filter.gte !== undefined && !(value >= filter.gte)) return false;
  if (filter.lt !== undefined && !(value < filter.lt)) return false;
  if (filter.lte !== undefined && !(value <= filter.lte)) return false;

  return true;
}
