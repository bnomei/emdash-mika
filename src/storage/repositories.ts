/**
 * Repository layer over document collections and operational SQLite tables.
 * Encapsulates typed queries, stock mutations, workflow leases, and ephemeral record access.
 */
import type {
  AccountDeleteRequestDocument,
  AccountExportDocument,
  AdminAuditDocument,
  EmailDocument,
  OpsDocument,
  WebhookDocument,
  WorkflowDocument,
} from "../types/documents";
import type { ISODateTime, JsonObject, MikaId } from "../types/primitives";
import type { MikaStorageCollections, StorageCollection } from "./collections";
import {
  documentOfType,
  findFirstByTypeCandidate,
  listByTypeCandidates,
  typedCollection,
  type DocumentList,
  type TypedCollectionFacade,
} from "./repositories/kit";
import type { MikaDbExecutor } from "./repositories/db-shared";
import { EphemeralRepository } from "./repositories/ephemeral";
import { StockRepository } from "./repositories/stock";
import { CatalogRepository } from "./repositories/catalog";
import { LedgerRepository } from "./repositories/ledger";
import { SessionRepository } from "./repositories/session";
import { AccountRepository } from "./repositories/account";
import {
  listLeaseableWorkflowCandidates,
  workflowDocumentWithRecord,
  workflowDueSortKey,
  workflowHasActiveLease,
  workflowIsDueForLease,
  workflowIsExhausted,
} from "./repositories/ops/workflow-helpers";
import {
  webhookDocumentWithRecord,
  webhookRawPayloadIsPurgeable,
} from "./repositories/ops/webhook-helpers";
import {
  adminAuditHasTopLevelAction,
  adminAuditInputHashMatches,
  adminAuditWithId,
  type AdminAuditIdempotencyClaimResult,
} from "./repositories/ops/admin-audit-helpers";
import {
  accountDeleteMaintenanceStepMetadata,
  accountDeleteRequestDocumentWithRecord,
  accountExportMatchesAccountDeleteIdentity,
  type AccountDeleteEmailRedactionRepositoryInput,
  type AccountDeleteMaintenanceStepRepositoryInput,
  type AccountDeleteRequestCompletionRepositoryInput,
  type AccountDeleteRequestFailureRepositoryInput,
} from "./repositories/ops/account-delete-helpers";
import {
  emailDocumentWithRecord,
  emailHasActiveLease,
  emailIsDueForLease,
  emailIsExhaustedLeaseLoss,
  emailMatchesAccountDeleteIdentity,
  emailSentMetadata,
} from "./repositories/ops/email-helpers";

export type { MikaDb, MikaDbExecutor, MikaTransaction } from "./repositories/db-shared";
export { EphemeralRepository } from "./repositories/ephemeral";
export { CatalogRepository, type CatalogProviderPriceMatch } from "./repositories/catalog";
export type { AdminAuditIdempotencyClaimResult } from "./repositories/ops/admin-audit-helpers";
export type {
  AccountDeleteEmailRedactionRepositoryInput,
  AccountDeleteMaintenanceStepRepositoryInput,
  AccountDeleteRequestCompletionRepositoryInput,
  AccountDeleteRequestFailureRepositoryInput,
} from "./repositories/ops/account-delete-helpers";
export { LedgerRepository } from "./repositories/ledger";
export { AccountRepository } from "./repositories/account";
export {
  SessionRepository,
  findSessionRepositoryOpenCartBySessionAnyCurrency,
  nextCartVersion,
} from "./repositories/session";
export {
  StockRepository,
  type AdjustStockRepositoryInput,
  type AdjustStockRepositoryResult,
  type ConsumeReservedStockRepositoryInput,
  type ConsumeReservedStockRepositoryResult,
  type ExpireReservedStockRepositoryResult,
  type ExtendReservationsRepositoryInput,
  type ReleaseActiveReservationsByCustomerRepositoryInput,
  type ReleaseExpiredReservationsRepositoryInput,
  type ReleaseExpiredReservationsRepositoryResult,
  type ReleaseReservedStockRepositoryInput,
  type ReleaseReservedStockRepositoryResult,
  type ReserveStockRepositoryInput,
  type ReserveStockRepositoryResult,
} from "./repositories/stock";

/** Input for acquiring a workflow execution lease. */
export interface WorkflowLeaseRepositoryInput {
  readonly workflowId: MikaId;
  readonly leaseKey: string;
  readonly now: ISODateTime;
  readonly leaseExpiresAt: ISODateTime;
  readonly force?: boolean;
}

/** Input for advancing a leased workflow step. */
export interface WorkflowStepRepositoryInput {
  readonly workflowId: MikaId;
  readonly leaseKey: string;
  readonly stepName: string;
  readonly now: ISODateTime;
  readonly state?: JsonObject;
}

/** Input for failing a leased workflow or step with retry scheduling. */
export interface WorkflowFailureRepositoryInput {
  readonly workflowId: MikaId;
  readonly leaseKey: string;
  readonly now: ISODateTime;
  readonly lastError: string;
  readonly nextAttemptAt: ISODateTime;
  readonly stepName?: string;
}

/** Input for acquiring an email delivery lease. */
export interface EmailLeaseRepositoryInput {
  readonly emailId: MikaId;
  readonly leaseKey: string;
  readonly now: ISODateTime;
  readonly leaseExpiresAt: ISODateTime;
  readonly force?: boolean;
}

/** Input for marking a leased email as successfully sent. */
export interface EmailCompleteRepositoryInput {
  readonly emailId: MikaId;
  readonly leaseKey: string;
  readonly now: ISODateTime;
  readonly providerMessageId?: string;
}

/** Input for idempotently marking an email as delivered without an active lease. */
export interface EmailDeliveredRepositoryInput {
  readonly emailId: MikaId;
  readonly now: ISODateTime;
  readonly providerMessageId?: string;
}

/** Input for failing a leased email with optional retry scheduling. */
export interface EmailFailureRepositoryInput {
  readonly emailId: MikaId;
  readonly leaseKey: string;
  readonly now: ISODateTime;
  readonly lastError: string;
  readonly nextAttemptAt?: ISODateTime;
}

/** Input for skipping a leased email without retry. */
export interface EmailSkipRepositoryInput {
  readonly emailId: MikaId;
  readonly leaseKey: string;
  readonly now: ISODateTime;
  readonly lastError: string;
}

/** Document repository for webhooks, emails, workflows, audits, and account ops records. */
export class OpsRepository {
  private readonly documents: TypedCollectionFacade<OpsDocument>;

  constructor(collection: StorageCollection<OpsDocument>) {
    this.documents = typedCollection(collection);
  }

  async findWebhookDuplicate(input: {
    readonly provider: string;
    readonly providerEventId?: string;
    readonly eventType: string;
    readonly payloadHash: string;
  }): Promise<WebhookDocument | null> {
    if (input.providerEventId !== undefined) {
      const duplicate = await this.documents.findOneByType("webhook", {
        provider: input.provider,
        providerEventId: input.providerEventId,
      });
      if (duplicate) return duplicate;
    }

    return this.documents.findOneByType("webhook", {
      provider: input.provider,
      payloadHash: input.payloadHash,
    });
  }

  async findWebhookById(webhookId: MikaId): Promise<WebhookDocument | null> {
    return this.documents.findByIdOfType(webhookId, "webhook");
  }

  async findAccountExport(exportId: MikaId): Promise<AccountExportDocument | null> {
    return this.documents.findByIdOfType(exportId, "accountExport");
  }

  async findAccountDeleteRequest(requestId: MikaId): Promise<AccountDeleteRequestDocument | null> {
    return this.documents.findByIdOfType(requestId, "accountDeleteRequest");
  }

  async listAccountExportsByCustomer(
    customerId: MikaId,
    limit = 20,
  ): Promise<DocumentList<AccountExportDocument>> {
    return this.documents.listByType("accountExport", {
      where: { customerId },
      orderBy: { createdAt: "desc" },
      limit,
    });
  }

  async listAccountDeleteRequestsByCustomer(
    customerId: MikaId,
    limit = 20,
  ): Promise<DocumentList<AccountDeleteRequestDocument>> {
    return this.documents.listByType("accountDeleteRequest", {
      where: { customerId },
      orderBy: { createdAt: "desc" },
      limit,
    });
  }

  async listQueuedAccountDeleteRequests(
    limit = 25,
  ): Promise<DocumentList<AccountDeleteRequestDocument>> {
    return this.documents.listByType("accountDeleteRequest", {
      where: { status: "queued" },
      orderBy: { createdAt: "asc" },
      limit,
    });
  }

  async completeAccountDeleteRequest(
    input: AccountDeleteRequestCompletionRepositoryInput,
  ): Promise<AccountDeleteRequestDocument | null> {
    const updated = await this.documents.update(input.requestId, (current) => {
      const request = documentOfType(current, "accountDeleteRequest");
      if (!request || request.status !== "queued") return null;

      return accountDeleteRequestDocumentWithRecord(request, input.now, {
        status: "completed",
        completedAt: input.now,
        userId: undefined,
        emailHash: undefined,
        confirmTokenHash: undefined,
        lastError: undefined,
        metadata: {
          ...request.record.metadata,
          ...input.metadata,
        },
      });
    });

    return documentOfType(updated, "accountDeleteRequest");
  }

  async recordAccountDeleteMaintenanceStep(
    input: AccountDeleteMaintenanceStepRepositoryInput,
  ): Promise<AccountDeleteRequestDocument | null> {
    const updated = await this.documents.update(input.requestId, (current) => {
      const request = documentOfType(current, "accountDeleteRequest");
      if (!request || request.status !== "queued") return null;

      return accountDeleteRequestDocumentWithRecord(request, input.now, {
        lastError: undefined,
        metadata: accountDeleteMaintenanceStepMetadata(request.record.metadata, input),
      });
    });

    return documentOfType(updated, "accountDeleteRequest");
  }

  async recordAccountDeleteRequestError(
    input: AccountDeleteRequestFailureRepositoryInput,
  ): Promise<AccountDeleteRequestDocument | null> {
    const updated = await this.documents.update(input.requestId, (current) => {
      const request = documentOfType(current, "accountDeleteRequest");
      if (!request || request.status !== "queued") return null;

      return accountDeleteRequestDocumentWithRecord(request, input.now, {
        lastError: input.lastError,
      });
    });

    return documentOfType(updated, "accountDeleteRequest");
  }

  async failAccountDeleteRequest(
    input: AccountDeleteRequestFailureRepositoryInput,
  ): Promise<AccountDeleteRequestDocument | null> {
    const updated = await this.documents.update(input.requestId, (current) => {
      const request = documentOfType(current, "accountDeleteRequest");
      if (!request || request.status !== "queued") return null;

      return accountDeleteRequestDocumentWithRecord(request, input.now, {
        status: "failed",
        lastError: input.lastError,
      });
    });

    return documentOfType(updated, "accountDeleteRequest");
  }

  async findWorkflow(workflowId: MikaId): Promise<WorkflowDocument | null> {
    return this.documents.findByIdOfType(workflowId, "workflow");
  }

  async createWorkflow(document: WorkflowDocument): Promise<WorkflowDocument | null> {
    const created = await this.documents.update(document.id, (current) =>
      current === null ? document : null,
    );

    return documentOfType(created, "workflow");
  }

  async listDueWorkflows(
    now: ISODateTime,
    limit = 50,
    kind?: WorkflowDocument["kind"],
  ): Promise<DocumentList<WorkflowDocument>> {
    const target = limit + 1;
    const ready = await listLeaseableWorkflowCandidates(this.documents, now, target, {
      where: {
        ...(kind ? { kind } : {}),
        status: { in: ["queued", "failed"] },
        nextAttemptAt: { lte: now },
      },
      orderBy: { nextAttemptAt: "asc" },
    });
    const expiredRunning = await listLeaseableWorkflowCandidates(this.documents, now, target, {
      where: {
        ...(kind ? { kind } : {}),
        status: "running",
        leaseExpiresAt: { lte: now },
      },
      orderBy: { leaseExpiresAt: "asc" },
    });
    const workflows = Array.from(
      new Map(
        [...ready.items, ...expiredRunning.items].map((item) => [item.id, item] as const),
      ).values(),
    ).sort((left, right) =>
      workflowDueSortKey(left.data).localeCompare(workflowDueSortKey(right.data)),
    );
    const items = workflows.slice(0, limit);
    const hasMore = ready.hasMore || expiredRunning.hasMore || workflows.length > limit;

    // No real cursor exists for this page: it's a merge-sort of two independently-cursored
    // sub-queries (ready, expiredRunning) re-ordered by a third key, and listDueWorkflows's own
    // signature has no cursor parameter to resume with anyway. hasMore still tells the caller
    // there's more than `limit` due work; a due workflow stays due, so a later call (or a larger
    // limit) picks up what this page dropped rather than losing it.
    return {
      items,
      hasMore,
    };
  }

  async reclaimExhaustedWorkflows(
    now: ISODateTime,
    limit = 50,
    kind?: WorkflowDocument["kind"],
  ): Promise<{ readonly scanned: number; readonly reclaimed: number }> {
    const candidates = await listByTypeCandidates(
      this.documents,
      "workflow",
      limit + 1,
      {
        where: {
          ...(kind ? { kind } : {}),
          status: "running",
          leaseExpiresAt: { lte: now },
        },
        orderBy: { leaseExpiresAt: "asc" },
      },
      (workflow) => workflowIsExhausted(workflow, now),
    );

    const stuck = candidates.items.slice(0, limit);
    let reclaimed = 0;
    for (const candidate of stuck) {
      const updated = await this.documents.update(candidate.id, (current) => {
        const workflow = documentOfType(current, "workflow");
        if (!workflow || !workflowIsExhausted(workflow, now)) return null;

        return workflowDocumentWithRecord(workflow, now, {
          status: "failed",
          leaseKey: undefined,
          leaseExpiresAt: undefined,
          nextAttemptAt: undefined,
          lastError:
            workflow.record.lastError ??
            "Workflow exhausted its lease attempts without completing; marked failed for replay.",
        });
      });
      if (documentOfType(updated, "workflow")) reclaimed += 1;
    }

    return { scanned: stuck.length, reclaimed };
  }

  async purgeWebhookRawPayloads(
    cutoff: ISODateTime,
    now: ISODateTime,
    limit = 50,
  ): Promise<{ readonly scanned: number; readonly purged: number }> {
    const candidates = await listByTypeCandidates(
      this.documents,
      "webhook",
      limit + 1,
      {
        where: { receivedAt: { lte: cutoff } },
        orderBy: { receivedAt: "asc" },
      },
      (webhook) => webhookRawPayloadIsPurgeable(webhook, cutoff),
    );

    const stale = candidates.items.slice(0, limit);
    let purged = 0;
    for (const candidate of stale) {
      const updated = await this.documents.update(candidate.id, (current) => {
        const webhook = documentOfType(current, "webhook");
        if (!webhook || !webhookRawPayloadIsPurgeable(webhook, cutoff)) return null;

        return webhookDocumentWithRecord(webhook, now, {
          rawPayloadJson: undefined,
          rawPayloadPurgedAt: now,
        });
      });
      if (documentOfType(updated, "webhook")) purged += 1;
    }

    return { scanned: stale.length, purged };
  }

  async tryLeaseWorkflow(input: WorkflowLeaseRepositoryInput): Promise<WorkflowDocument | null> {
    const updated = await this.documents.update(input.workflowId, (current) => {
      const workflow = documentOfType(current, "workflow");
      if (!workflow) return null;
      if (workflow.status === "completed") return null;
      if (!workflowIsDueForLease(workflow, input.now, input.force)) return null;

      return workflowDocumentWithRecord(workflow, input.now, {
        status: "running",
        attemptCount: workflow.record.attemptCount + 1,
        nextAttemptAt: undefined,
        leaseKey: input.leaseKey,
        leasedAt: input.now,
        leaseExpiresAt: input.leaseExpiresAt,
        lastError: undefined,
      });
    });

    return documentOfType(updated, "workflow");
  }

  async startWorkflowStep(input: WorkflowStepRepositoryInput): Promise<WorkflowDocument | null> {
    const updated = await this.documents.update(input.workflowId, (current) => {
      const workflow = documentOfType(current, "workflow");
      if (!workflow) return null;
      if (!workflowHasActiveLease(workflow, input)) return null;

      const steps = workflow.record.steps.map((step) => {
        if (step.name !== input.stepName || step.status === "completed") return step;

        return {
          ...step,
          status: "running" as const,
          startedAt: input.now,
          failedAt: undefined,
          completedAt: undefined,
          attemptCount: step.attemptCount + 1,
          nextAttemptAt: undefined,
          lastError: undefined,
        };
      });

      return workflowDocumentWithRecord(workflow, input.now, {
        status: "running",
        steps,
        nextAttemptAt: undefined,
        lastError: undefined,
      });
    });

    return documentOfType(updated, "workflow");
  }

  async completeWorkflowStep(input: WorkflowStepRepositoryInput): Promise<WorkflowDocument | null> {
    const updated = await this.documents.update(input.workflowId, (current) => {
      const workflow = documentOfType(current, "workflow");
      if (!workflow) return null;
      if (!workflowHasActiveLease(workflow, input)) return null;

      const steps = workflow.record.steps.map((step) => {
        if (step.name !== input.stepName || step.status === "completed") return step;

        return {
          ...step,
          status: "completed" as const,
          startedAt: step.startedAt ?? input.now,
          completedAt: input.now,
          failedAt: undefined,
          nextAttemptAt: undefined,
          lastError: undefined,
          ...(input.state ? { state: { ...step.state, ...input.state } } : {}),
        };
      });

      return workflowDocumentWithRecord(workflow, input.now, {
        status: "running",
        steps,
        nextAttemptAt: undefined,
        lastError: undefined,
      });
    });

    return documentOfType(updated, "workflow");
  }

  async failWorkflowStep(
    input: WorkflowFailureRepositoryInput & { readonly stepName: string },
  ): Promise<WorkflowDocument | null> {
    const updated = await this.documents.update(input.workflowId, (current) => {
      const workflow = documentOfType(current, "workflow");
      if (!workflow) return null;
      if (!workflowHasActiveLease(workflow, input)) return null;

      const steps = workflow.record.steps.map((step) =>
        step.name === input.stepName && step.status !== "completed"
          ? {
              ...step,
              status: "failed" as const,
              failedAt: input.now,
              nextAttemptAt: input.nextAttemptAt,
              lastError: input.lastError,
            }
          : step,
      );

      return workflowDocumentWithRecord(workflow, input.now, {
        status: "failed",
        steps,
        nextAttemptAt: input.nextAttemptAt,
        lastError: input.lastError,
        leaseKey: undefined,
        leasedAt: undefined,
        leaseExpiresAt: undefined,
      });
    });

    return documentOfType(updated, "workflow");
  }

  async completeWorkflow(input: {
    readonly workflowId: MikaId;
    readonly leaseKey: string;
    readonly now: ISODateTime;
    readonly state?: JsonObject;
  }): Promise<WorkflowDocument | null> {
    const updated = await this.documents.update(input.workflowId, (current) => {
      const workflow = documentOfType(current, "workflow");
      if (!workflow) return null;
      if (!workflowHasActiveLease(workflow, input)) return null;

      return workflowDocumentWithRecord(workflow, input.now, {
        status: "completed",
        completedAt: input.now,
        nextAttemptAt: undefined,
        leaseKey: undefined,
        leasedAt: undefined,
        leaseExpiresAt: undefined,
        resumeState: { ...workflow.record.resumeState, ...input.state },
        steps: workflow.record.steps.map((step) =>
          step.status === "queued"
            ? {
                ...step,
                status: "skipped" as const,
              }
            : step,
        ),
      });
    });

    return documentOfType(updated, "workflow");
  }

  async failWorkflow(input: WorkflowFailureRepositoryInput): Promise<WorkflowDocument | null> {
    const updated = await this.documents.update(input.workflowId, (current) => {
      const workflow = documentOfType(current, "workflow");
      if (!workflow) return null;
      if (!workflowHasActiveLease(workflow, input)) return null;

      return workflowDocumentWithRecord(workflow, input.now, {
        status: "failed",
        nextAttemptAt: input.nextAttemptAt,
        lastError: input.lastError,
        leaseKey: undefined,
        leasedAt: undefined,
        leaseExpiresAt: undefined,
        steps: workflow.record.steps.map((step) =>
          step.status === "running"
            ? {
                ...step,
                status: "failed",
                failedAt: input.now,
                nextAttemptAt: input.nextAttemptAt,
                lastError: input.lastError,
              }
            : step,
        ),
      });
    });

    return documentOfType(updated, "workflow");
  }

  async findAdminAudit(auditId: MikaId): Promise<AdminAuditDocument | null> {
    return this.documents.findByIdOfType(auditId, "adminAudit");
  }

  async findAdminAuditByIdempotencyKey(
    action: string,
    idempotencyKey: string,
  ): Promise<AdminAuditDocument | null> {
    return findFirstByTypeCandidate(
      this.documents,
      "adminAudit",
      (item) => (item.data.record.action === action ? item.data : null),
      { where: { idempotencyKey } },
    );
  }

  async claimAdminAuditIdempotency(
    document: AdminAuditDocument,
  ): Promise<AdminAuditIdempotencyClaimResult> {
    if (!document.record.idempotencyKey) {
      await this.writeAudit(document);

      return { status: "claimed", audit: document };
    }

    const legacy = await this.findAdminAuditByIdempotencyKey(
      document.record.action,
      document.record.idempotencyKey,
    );
    if (legacy && !adminAuditHasTopLevelAction(legacy)) {
      const reclaimed = await this.reclaimFailedAdminAuditIdempotency(legacy, document);

      return reclaimed ?? { status: "existing", audit: legacy };
    }

    try {
      await this.writeAudit(document);

      return { status: "claimed", audit: document };
    } catch (error) {
      const existing = await this.findAdminAuditByIdempotencyKey(
        document.record.action,
        document.record.idempotencyKey,
      );
      if (existing) {
        const reclaimed = await this.reclaimFailedAdminAuditIdempotency(existing, document);
        if (reclaimed) return reclaimed;
        return { status: "existing", audit: existing };
      }

      throw error;
    }
  }

  private async reclaimFailedAdminAuditIdempotency(
    existing: AdminAuditDocument,
    document: AdminAuditDocument,
  ): Promise<AdminAuditIdempotencyClaimResult | undefined> {
    if (existing.record.status !== "failed" || !adminAuditInputHashMatches(existing, document)) {
      return undefined;
    }

    let reclaimedByThisCall = false;
    const reclaimed = await this.documents.update(existing.id, (current) => {
      // Reset on every invocation: adapters may retry the updater on write contention, and only
      // the last (committed) invocation's determination may survive — a stale `true` from an
      // earlier, uncommitted attempt must not outlive a later attempt that finds nothing to claim.
      reclaimedByThisCall = false;
      const currentAudit = documentOfType(current, "adminAudit");
      if (
        !currentAudit ||
        currentAudit.record.status !== "failed" ||
        !adminAuditInputHashMatches(currentAudit, document)
      ) {
        return current;
      }

      reclaimedByThisCall = true;

      return adminAuditWithId(document, currentAudit.id);
    });
    const audit = documentOfType(reclaimed, "adminAudit");
    if (reclaimedByThisCall && audit?.record.status === "started") {
      return { status: "claimed", audit };
    }
    if (audit) return { status: "existing", audit };

    return undefined;
  }

  async findEmail(emailId: MikaId): Promise<EmailDocument | null> {
    return this.documents.findByIdOfType(emailId, "email");
  }

  async listDueEmails(now: ISODateTime, limit = 50): Promise<DocumentList<EmailDocument>> {
    const target = limit + 1;
    const result = await listByTypeCandidates(
      this.documents,
      "email",
      target,
      {
        where: {
          status: { in: ["queued", "failed"] },
        },
        orderBy: { nextAttemptAt: "asc" },
      },
      (email) => emailIsDueForLease(email, now),
    );
    const items = result.items.slice(0, limit);
    const hasMore = result.hasMore || result.items.length > limit;

    // result.cursor (from listByTypeCandidates) resumes after the last raw page fetched, not
    // after the `limit`-th due candidate — when a single raw page yields more due candidates than
    // `limit`, it would skip the held-back ones. listDueEmails's own signature has no cursor
    // parameter to resume with anyway; hasMore tells the caller there's more than `limit` due
    // work, and a due email stays due, so a later call (or a larger limit) picks it up.
    return {
      items,
      hasMore,
    };
  }

  async reclaimExhaustedEmails(
    now: ISODateTime,
    limit = 50,
  ): Promise<{ readonly scanned: number; readonly reclaimed: number }> {
    const candidates = await listByTypeCandidates(
      this.documents,
      "email",
      limit + 1,
      {
        where: {
          status: "queued",
        },
        orderBy: { nextAttemptAt: "asc" },
      },
      (email) => emailIsExhaustedLeaseLoss(email, now),
    );

    const exhausted = candidates.items.slice(0, limit);
    let reclaimed = 0;
    for (const candidate of exhausted) {
      const updated = await this.documents.update(candidate.id, (current) => {
        const email = documentOfType(current, "email");
        if (!email || !emailIsExhaustedLeaseLoss(email, now)) return null;

        return emailDocumentWithRecord(email, now, {
          status: "failed",
          nextAttemptAt: undefined,
          leaseKey: undefined,
          leasedAt: undefined,
          leaseExpiresAt: undefined,
          lastError:
            email.record.lastError ??
            "Email exhausted its lease attempts without delivery; marked failed for review.",
        });
      });
      if (documentOfType(updated, "email")) reclaimed += 1;
    }

    return { scanned: exhausted.length, reclaimed };
  }

  async tryLeaseEmail(input: EmailLeaseRepositoryInput): Promise<EmailDocument | null> {
    const updated = await this.documents.update(input.emailId, (current) => {
      const email = documentOfType(current, "email");
      if (!email) return null;
      if (!emailIsDueForLease(email, input.now, input.force)) return null;

      return emailDocumentWithRecord(email, input.now, {
        attemptCount: email.record.attemptCount + 1,
        nextAttemptAt: input.leaseExpiresAt,
        lastError: undefined,
        leaseKey: input.leaseKey,
        leasedAt: input.now,
        leaseExpiresAt: input.leaseExpiresAt,
      });
    });

    return documentOfType(updated, "email");
  }

  async completeEmail(input: EmailCompleteRepositoryInput): Promise<EmailDocument | null> {
    const updated = await this.documents.update(input.emailId, (current) => {
      const email = documentOfType(current, "email");
      if (!email) return null;
      if (!emailHasActiveLease(email, input)) return null;

      return emailDocumentWithRecord(email, input.now, {
        status: "sent",
        providerMessageId: input.providerMessageId,
        nextAttemptAt: undefined,
        leaseKey: undefined,
        leasedAt: undefined,
        leaseExpiresAt: undefined,
        lastError: undefined,
        sentAt: input.now,
        metadata: emailSentMetadata(email, input.now),
      });
    });

    return documentOfType(updated, "email");
  }

  async markEmailDelivered(input: EmailDeliveredRepositoryInput): Promise<EmailDocument | null> {
    const updated = await this.documents.update(input.emailId, (current) => {
      const email = documentOfType(current, "email");
      if (!email) return null;
      if (email.record.status === "sent") return email;

      return emailDocumentWithRecord(email, input.now, {
        status: "sent",
        providerMessageId: input.providerMessageId,
        nextAttemptAt: undefined,
        leaseKey: undefined,
        leasedAt: undefined,
        leaseExpiresAt: undefined,
        lastError: undefined,
        sentAt: input.now,
        metadata: emailSentMetadata(email, input.now),
      });
    });

    return documentOfType(updated, "email");
  }

  async failEmail(input: EmailFailureRepositoryInput): Promise<EmailDocument | null> {
    const updated = await this.documents.update(input.emailId, (current) => {
      const email = documentOfType(current, "email");
      if (!email) return null;
      if (!emailHasActiveLease(email, input)) return null;

      return emailDocumentWithRecord(email, input.now, {
        status: "failed",
        nextAttemptAt: input.nextAttemptAt,
        leaseKey: undefined,
        leasedAt: undefined,
        leaseExpiresAt: undefined,
        lastError: input.lastError,
      });
    });

    return documentOfType(updated, "email");
  }

  async skipEmail(input: EmailSkipRepositoryInput): Promise<EmailDocument | null> {
    const updated = await this.documents.update(input.emailId, (current) => {
      const email = documentOfType(current, "email");
      if (!email) return null;
      if (!emailHasActiveLease(email, input)) return null;

      return emailDocumentWithRecord(email, input.now, {
        status: "skipped",
        nextAttemptAt: undefined,
        leaseKey: undefined,
        leasedAt: undefined,
        leaseExpiresAt: undefined,
        lastError: input.lastError,
      });
    });

    return documentOfType(updated, "email");
  }

  async redactQueuedFailedEmailsForAccountDelete(
    input: AccountDeleteEmailRedactionRepositoryInput,
  ): Promise<number> {
    const candidates = await listByTypeCandidates(
      this.documents,
      "email",
      1000,
      {
        where: { status: { in: ["queued", "failed"] } },
        orderBy: { createdAt: "asc" },
      },
      (email) => emailMatchesAccountDeleteIdentity(email, input),
    );
    let redacted = 0;

    for (const item of candidates.items) {
      const updated = await this.documents.update(item.id, (current) => {
        const email = documentOfType(current, "email");
        if (!email || !emailMatchesAccountDeleteIdentity(email, input)) return null;
        if (email.status !== "queued" && email.status !== "failed") return null;

        return emailDocumentWithRecord(email, input.now, {
          customerId: undefined,
          orderId: undefined,
          tokenId: undefined,
          toEmail: `redacted-${email.id}@redacted.invalid`,
          subject: "Redacted email",
          status: "skipped",
          nextAttemptAt: undefined,
          leaseKey: undefined,
          leasedAt: undefined,
          leaseExpiresAt: undefined,
          lastError: "Redacted after account deletion.",
          metadata: {
            redactedAt: input.now,
          },
        });
      });

      if (updated) redacted += 1;
    }

    return redacted;
  }

  async redactAccountExportsForAccountDelete(
    input: AccountDeleteEmailRedactionRepositoryInput,
  ): Promise<number> {
    const candidates = await listByTypeCandidates(
      this.documents,
      "accountExport",
      1000,
      {
        orderBy: { createdAt: "asc" },
      },
      (document) => accountExportMatchesAccountDeleteIdentity(document, input),
    );
    let redacted = 0;

    for (const item of candidates.items) {
      const updated = await this.documents.update(item.id, (current) => {
        const document = documentOfType(current, "accountExport");
        if (!document || !accountExportMatchesAccountDeleteIdentity(document, input)) return null;
        if (document.record.artifactRef === undefined && document.status === "expired") return null;

        return {
          ...document,
          status: "expired",
          expiresAt: input.now,
          updatedAt: input.now,
          record: {
            ...document.record,
            status: "expired",
            expiresAt: input.now,
            artifactRef: undefined,
            downloadTokenHash: undefined,
            lastError: "Redacted after account deletion.",
            metadata: {
              ...document.record.metadata,
              redactedAt: input.now,
            },
          },
        };
      });

      if (updated) redacted += 1;
    }

    return redacted;
  }

  async writeAudit(document: AdminAuditDocument): Promise<void> {
    await this.put(document);
  }

  async put(document: OpsDocument): Promise<void> {
    await this.documents.put(document);
  }
}

/** Facade wiring document and operational repositories for the commerce storage model. */
export class MikaRepositories {
  readonly catalog: CatalogRepository;
  readonly session: SessionRepository;
  readonly account: AccountRepository;
  readonly ledger: LedgerRepository;
  readonly ops: OpsRepository;
  readonly stock: StockRepository;
  readonly ephemeral: EphemeralRepository;

  constructor(storage: MikaStorageCollections, db: MikaDbExecutor) {
    this.catalog = new CatalogRepository(storage.catalog);
    this.session = new SessionRepository(storage.session);
    this.account = new AccountRepository(storage.account);
    this.ledger = new LedgerRepository(storage.ledger);
    this.ops = new OpsRepository(storage.ops);
    this.stock = new StockRepository(db);
    this.ephemeral = new EphemeralRepository(db);
  }
}

/** Constructs the full repository facade from storage collections and a db executor. */
export function createMikaRepositories(input: {
  readonly storage: MikaStorageCollections;
  readonly db: MikaDbExecutor;
}): MikaRepositories {
  return new MikaRepositories(input.storage, input.db);
}
