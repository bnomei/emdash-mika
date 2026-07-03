import type { ISODateTime } from "../../types/primitives";
import type { ExactPartial } from "../../internal/object";

/**
 * Applies a partial patch to a {@link RecordBackedDocument}'s nested `record`, then re-derives the
 * document's mirrored top-level fields from the patched record. Every `RecordBackedDocument` stores
 * a `Pick<TRecord, TIndexedKeys>` of its record at the top level (for indexed queries), so a naive
 * `record`-only patch would silently desync the two copies — this keeps them structurally in sync.
 * `mirroredKeys` must list exactly the fields the caller mirrors today; it is not inferred from
 * `TIndexedKeys` because a document's top level can carry additional fields (e.g.
 * `LicenseDocument.customerId`) that are not derived from `record` at all.
 */
export function mirrorRecordFields<
  TDocument extends { readonly record: object; readonly updatedAt: ISODateTime },
  TMirroredKeys extends keyof TDocument["record"] & keyof TDocument,
>(
  document: TDocument,
  now: ISODateTime,
  patch: ExactPartial<TDocument["record"]>,
  mirroredKeys: readonly TMirroredKeys[],
): TDocument {
  const record = { ...document.record, ...patch } as TDocument["record"];
  const mirrored = {} as Pick<TDocument, TMirroredKeys>;
  for (const key of mirroredKeys) {
    mirrored[key] = record[key] as TDocument[TMirroredKeys];
  }

  return {
    ...document,
    ...mirrored,
    record,
    updatedAt: now,
  } as TDocument;
}
