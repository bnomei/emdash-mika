import type { AdminAuditDocument } from "../../../types/documents";
import type { MikaId } from "../../../types/primitives";

const ADMIN_AUDIT_IDEMPOTENCY_INPUT_HASH_METADATA_KEY = "idempotencyInputHash";

export function adminAuditInputHashMatches(
  current: AdminAuditDocument,
  next: AdminAuditDocument,
): boolean {
  const currentHash = current.record.metadata?.[ADMIN_AUDIT_IDEMPOTENCY_INPUT_HASH_METADATA_KEY];
  const nextHash = next.record.metadata?.[ADMIN_AUDIT_IDEMPOTENCY_INPUT_HASH_METADATA_KEY];

  return typeof currentHash === "string" && currentHash === nextHash;
}

export function adminAuditHasTopLevelAction(document: AdminAuditDocument): boolean {
  return typeof (document as { readonly action?: unknown }).action === "string";
}

export function adminAuditWithId(document: AdminAuditDocument, id: MikaId): AdminAuditDocument {
  return {
    ...document,
    id,
    record: {
      ...document.record,
      id,
    },
  };
}
