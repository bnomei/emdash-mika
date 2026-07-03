/**
 * Typed-collection kit: wraps a generic {@link StorageCollection} with type-narrowed get/put/query
 * helpers so each document repository can work with its own document union member types instead of
 * the raw stored union, plus bounded-page sweep helpers for account-delete anonymization and
 * lease-candidate scans.
 */
import type {
  PaginatedStorageResult,
  StorageCollection,
  StorageQueryOptions,
  StorageWhereClause,
} from "../collections";
import { omitUndefined } from "../../internal/object";

export type TypedDocument = {
  readonly type: string;
};

export type DocumentType<TDocument extends TypedDocument> = TDocument["type"];
export type DocumentOfType<
  TDocument extends TypedDocument,
  TType extends DocumentType<TDocument>,
> = Extract<TDocument, { readonly type: TType }>;
export type TypeScopedWhere<TDocument extends TypedDocument> = Omit<
  StorageWhereClause<TDocument>,
  "type"
>;
export type TypeScopedQueryOptions<TDocument extends TypedDocument> = Omit<
  StorageQueryOptions<TDocument>,
  "where"
> & {
  readonly where?: TypeScopedWhere<TDocument>;
};
export type StorageResultItem<TDocument> = {
  id: string;
  data: TDocument;
};
export type DocumentList<TDocument> = PaginatedStorageResult<StorageResultItem<TDocument>>;
export type TypedCollectionFacade<TDocument extends TypedDocument & { readonly id: string }> =
  ReturnType<typeof typedCollection<TDocument>>;

async function putByDocumentId<TDocument extends { readonly id: string }>(
  collection: StorageCollection<TDocument>,
  document: TDocument,
): Promise<void> {
  await collection.put(document.id, document);
}

async function findOneByType<
  TDocument extends TypedDocument,
  TType extends DocumentType<TDocument>,
>(
  collection: StorageCollection<TDocument>,
  type: TType,
  where?: TypeScopedWhere<DocumentOfType<TDocument, TType>>,
): Promise<DocumentOfType<TDocument, TType> | null> {
  const result = await collection.query({
    where: withDocumentType<TDocument, TType>(
      type,
      where ?? ({} as TypeScopedWhere<DocumentOfType<TDocument, TType>>),
    ),
    limit: 1,
  });

  return documentOfType(result.items[0]?.data, type);
}

async function findByIdOfType<
  TDocument extends TypedDocument,
  TType extends DocumentType<TDocument>,
>(
  collection: StorageCollection<TDocument>,
  id: string,
  type: TType,
): Promise<DocumentOfType<TDocument, TType> | null> {
  return documentOfType(await collection.get(id), type);
}

async function listByType<TDocument extends TypedDocument, TType extends DocumentType<TDocument>>(
  collection: StorageCollection<TDocument>,
  type: TType,
  options?: TypeScopedQueryOptions<DocumentOfType<TDocument, TType>>,
): Promise<DocumentList<DocumentOfType<TDocument, TType>>> {
  const { where, ...rest } = options ?? {};
  const result = await collection.query({
    ...rest,
    where: withDocumentType<TDocument, TType>(
      type,
      where ?? ({} as TypeScopedWhere<DocumentOfType<TDocument, TType>>),
    ),
  } as unknown as StorageQueryOptions<TDocument>);

  // The where clause scopes the query to `type` at the adapter, but a misbehaving adapter could
  // still return a wrong-type row. Validate before the cast so silent corruption surfaces as a
  // diagnosable error instead — mirroring findOneByType's documentOfType guard.
  for (const item of result.items) {
    if (documentOfType(item.data, type) === null) {
      throw new Error(
        `Storage returned a '${item.data.type}' document where '${type}' was queried.`,
      );
    }
  }

  return result as DocumentList<DocumentOfType<TDocument, TType>>;
}

export async function findFirstByTypeCandidate<
  TDocument extends TypedDocument & { readonly id: string },
  TType extends DocumentType<TDocument>,
  TResult,
>(
  documents: TypedCollectionFacade<TDocument>,
  type: TType,
  match: (item: StorageResultItem<DocumentOfType<TDocument, TType>>) => TResult | null | undefined,
  options: TypeScopedQueryOptions<DocumentOfType<TDocument, TType>> = {},
): Promise<TResult | null> {
  let cursor = options.cursor;
  const limit = options.limit ?? 100;

  do {
    const page = await documents.listByType(type, omitUndefined({ ...options, cursor, limit }));

    for (const item of page.items) {
      const candidate = match(item);
      if (candidate !== null && candidate !== undefined) return candidate;
    }

    cursor = page.cursor;
  } while (cursor);

  return null;
}

/** Page size for {@link listAllByType} sweeps — bounded per request, not per sweep. */
const ACCOUNT_DELETE_SWEEP_PAGE_SIZE = 50;

/**
 * Collects every document matching `options.where`, fetched in bounded pages instead of one
 * `limit: Number.MAX_SAFE_INTEGER` request. Used by the account-delete anonymization sweeps below,
 * where a customer with an unusually large number of entitlements, licenses, or orders would
 * otherwise force a single query to materialize their entire history into memory at once.
 */
export async function listAllByType<
  TDocument extends TypedDocument & { readonly id: string },
  TType extends DocumentType<TDocument>,
>(
  documents: TypedCollectionFacade<TDocument>,
  type: TType,
  options: TypeScopedQueryOptions<DocumentOfType<TDocument, TType>>,
): Promise<StorageResultItem<DocumentOfType<TDocument, TType>>[]> {
  const items: StorageResultItem<DocumentOfType<TDocument, TType>>[] = [];
  let cursor = options.cursor;

  do {
    const page = await documents.listByType(
      type,
      omitUndefined({ ...options, cursor, limit: ACCOUNT_DELETE_SWEEP_PAGE_SIZE }),
    );

    items.push(...page.items);
    cursor = page.cursor;
  } while (cursor);

  return items;
}

/**
 * Collects every document matching `options.where` that also satisfies `isCandidate`, fetched in
 * bounded pages with no upper cap on matches. Used by the account-delete PII redaction sweeps, where
 * a customer with more than a page's worth of queued/failed emails or account exports must still be
 * redacted completely — unlike {@link listByTypeCandidates}, which stops once it has `target` matches
 * (correct for the maintenance listings, but a residual-PII gap for a compliance-driven sweep).
 */
export async function listAllByTypeCandidates<
  TDocument extends TypedDocument & { readonly id: string },
  TType extends DocumentType<TDocument>,
>(
  documents: TypedCollectionFacade<TDocument>,
  type: TType,
  options: TypeScopedQueryOptions<DocumentOfType<TDocument, TType>>,
  isCandidate: (document: DocumentOfType<TDocument, TType>) => boolean,
): Promise<StorageResultItem<DocumentOfType<TDocument, TType>>[]> {
  const items: StorageResultItem<DocumentOfType<TDocument, TType>>[] = [];
  let cursor = options.cursor;

  do {
    const page = await documents.listByType(
      type,
      omitUndefined({ ...options, cursor, limit: ACCOUNT_DELETE_SWEEP_PAGE_SIZE }),
    );

    for (const item of page.items) {
      if (isCandidate(item.data)) items.push(item);
    }

    cursor = page.cursor;
  } while (cursor);

  return items;
}

export async function listByTypeCandidates<
  TDocument extends TypedDocument & { readonly id: string },
  TType extends DocumentType<TDocument>,
>(
  documents: TypedCollectionFacade<TDocument>,
  type: TType,
  target: number,
  options: TypeScopedQueryOptions<DocumentOfType<TDocument, TType>>,
  isCandidate: (document: DocumentOfType<TDocument, TType>) => boolean,
): Promise<DocumentList<DocumentOfType<TDocument, TType>>> {
  if (target <= 0) return { items: [], hasMore: false };

  const items: Array<StorageResultItem<DocumentOfType<TDocument, TType>>> = [];
  let cursor = options.cursor;
  let hasMore = false;
  const pageLimit = Math.max(target, options.limit ?? 50);

  do {
    const page = await documents.listByType(
      type,
      omitUndefined({ ...options, cursor, limit: pageLimit }),
    );

    for (const item of page.items) {
      if (isCandidate(item.data)) items.push(item);
    }

    cursor = page.cursor;
    hasMore = page.hasMore;
  } while (items.length < target && cursor);

  return omitUndefined({
    items,
    cursor: hasMore ? cursor : undefined,
    hasMore,
  });
}

function withDocumentType<TDocument extends TypedDocument, TType extends DocumentType<TDocument>>(
  type: TType,
  where: TypeScopedWhere<DocumentOfType<TDocument, TType>>,
): StorageWhereClause<TDocument> {
  return { ...where, type } as StorageWhereClause<TDocument>;
}

export function documentOfType<
  TDocument extends TypedDocument,
  TType extends DocumentType<TDocument>,
>(document: TDocument | null | undefined, type: TType): DocumentOfType<TDocument, TType> | null {
  return document?.type === type ? (document as DocumentOfType<TDocument, TType>) : null;
}

export function typedCollection<TDocument extends TypedDocument & { readonly id: string }>(
  collection: StorageCollection<TDocument>,
) {
  return {
    get: (id: string) => collection.get(id),
    put: (document: TDocument) => putByDocumentId(collection, document),
    update: (id: string, updater: (current: TDocument | null) => TDocument | null) =>
      collection.update(id, updater),
    findOneByType: <TType extends DocumentType<TDocument>>(
      type: TType,
      where?: TypeScopedWhere<DocumentOfType<TDocument, TType>>,
    ) => findOneByType(collection, type, where),
    findByIdOfType: <TType extends DocumentType<TDocument>>(id: string, type: TType) =>
      findByIdOfType(collection, id, type),
    listByType: <TType extends DocumentType<TDocument>>(
      type: TType,
      options?: TypeScopedQueryOptions<DocumentOfType<TDocument, TType>>,
    ) => listByType(collection, type, options),
  };
}
