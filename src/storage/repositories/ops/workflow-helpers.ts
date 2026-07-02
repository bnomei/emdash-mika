import {
  listByTypeCandidates,
  type DocumentList,
  type TypedCollectionFacade,
  type TypeScopedQueryOptions,
} from "../kit";
import { mirrorRecordFields } from "../record-mirror";
import type { OpsDocument, WorkflowDocument } from "../../../types/documents";
import type { ISODateTime } from "../../../types/primitives";

export async function listLeaseableWorkflowCandidates(
  documents: TypedCollectionFacade<OpsDocument>,
  now: ISODateTime,
  target: number,
  options: TypeScopedQueryOptions<WorkflowDocument>,
): Promise<DocumentList<WorkflowDocument>> {
  return listByTypeCandidates(documents, "workflow", target, options, (workflow) =>
    workflowIsDueForLease(workflow, now),
  );
}

export function workflowIsDueForLease(
  workflow: WorkflowDocument,
  now: ISODateTime,
  force = false,
): boolean {
  if (workflow.record.leaseExpiresAt && workflow.record.leaseExpiresAt > now) return false;
  if (workflow.status === "running" && !workflow.record.leaseExpiresAt) return false;
  if (force) return workflow.status !== "completed";
  if (workflow.record.attemptCount >= workflow.record.maxAttempts) return false;

  return !workflow.nextAttemptAt || workflow.nextAttemptAt <= now;
}

export function workflowIsExhausted(workflow: WorkflowDocument, now: ISODateTime): boolean {
  return (
    workflow.status === "running" &&
    workflow.record.leaseExpiresAt !== undefined &&
    workflow.record.leaseExpiresAt <= now &&
    workflow.record.attemptCount >= workflow.record.maxAttempts
  );
}

export function workflowDueSortKey(workflow: WorkflowDocument): ISODateTime {
  return (
    workflow.nextAttemptAt ??
    workflow.record.leaseExpiresAt ??
    workflow.leaseExpiresAt ??
    workflow.updatedAt
  );
}

export function workflowHasActiveLease(
  workflow: WorkflowDocument,
  input: { readonly leaseKey: string; readonly now: ISODateTime },
): boolean {
  if (workflow.status !== "running") return false;
  if (workflow.record.leaseKey !== input.leaseKey) return false;
  if (!workflow.record.leaseExpiresAt || workflow.record.leaseExpiresAt <= input.now) return false;

  return true;
}

export function workflowDocumentWithRecord(
  workflow: WorkflowDocument,
  now: ISODateTime,
  patch: Partial<WorkflowDocument["record"]>,
): WorkflowDocument {
  return mirrorRecordFields(workflow, now, { ...patch, updatedAt: now }, [
    "kind",
    "status",
    "subjectType",
    "subjectId",
    "idempotencyKey",
    "nextAttemptAt",
    "leaseExpiresAt",
  ]);
}
