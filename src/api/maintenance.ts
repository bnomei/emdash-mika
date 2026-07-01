/**
 * Scheduled maintenance orchestrator for background commerce hygiene.
 *
 * `runOnce` sweeps eight optional tasks — each skips when its dependency is unconfigured:
 * email outbox delivery, stuck email lease reclaim, raw webhook payload purge, ACP session
 * cleanup, expired stock reservation release, ephemeral record purge, queued account-delete
 * completion, and stuck workflow lease reclaim.
 */
import type { MikaBackendNow, MikaBackendRepositories } from "./backend";
import type { AdminActionResultDTO, MikaApiResult, ReleaseExpiredReservationsInput } from "./types";
import type { MikaApi } from "./server";
import type {
  MikaEmailOutboxRunner,
  MikaEmailOutboxRunOptions,
  MikaEmailOutboxRunResult,
} from "./email-outbox";
import type {
  MikaAcpSessionCleanupInput,
  MikaAcpSessionCleanupResult,
  MikaAcpSessionStore,
} from "../acp";
import { subjectHashCandidates } from "./subject-ref";
import { createISODateTime, type ISODateTime, type MikaId } from "../types/primitives";

/** Per-run limits and clock override for maintenance sweeps. */
export interface MikaMaintenanceRunOptions {
  readonly now?: ISODateTime;
  readonly emailLimit?: number;
  readonly stuckEmailLimit?: number;
  readonly rawProviderPayloadLimit?: number;
  readonly rawProviderPayloadRetentionDays?: number;
  readonly acpSessionLimit?: number;
  readonly accountDeleteLimit?: number;
  readonly stuckWorkflowLimit?: number;
}

type MikaMaintenanceTaskResult<TResult> =
  | {
      readonly status: "completed";
      readonly result: TResult;
    }
  | {
      readonly status: "failed";
      readonly error: string;
    }
  | {
      readonly status: "skipped";
      readonly reason: string;
    };

/** Counts from releasing expired stock reservations during maintenance. */
export interface MikaMaintenanceStockReservationsResult {
  readonly reservationsScanned: number;
  readonly reservationsReleased: number;
  readonly stockItems: number;
}

/** Count of expired ephemeral records purged in one maintenance sweep. */
export interface MikaMaintenanceEphemeralRecordsResult {
  readonly purged: number;
}

/** Aggregated outcome of processing queued account-delete requests. */
export interface MikaMaintenanceAccountDeleteRequestsResult {
  readonly scanned: number;
  readonly completed: number;
  readonly failed: number;
  readonly hasMore: boolean;
  readonly items: readonly MikaMaintenanceAccountDeleteRequestItem[];
}

/** Per-request completion or failure details from account-delete processing. */
export type MikaMaintenanceAccountDeleteRequestItem =
  | {
      readonly requestId: MikaId;
      readonly status: "completed";
      readonly tokensDeleted: number;
      readonly reservationsReleased: number;
      readonly emailsRedacted: number;
      readonly customerAnonymized: boolean;
      readonly ordersAnonymized: number;
      readonly entitlementsAnonymized: number;
      readonly licensesAnonymized: number;
    }
  | {
      readonly requestId: MikaId;
      readonly status: "failed";
      readonly error: string;
    };

/** Counts from reclaiming exhausted workflow leases during maintenance. */
export interface MikaMaintenanceStuckWorkflowsResult {
  readonly scanned: number;
  readonly reclaimed: number;
}

/** Counts from reclaiming exhausted email outbox leases during maintenance. */
export interface MikaMaintenanceStuckEmailsResult {
  readonly scanned: number;
  readonly reclaimed: number;
}

/** Counts from purging age-expired raw webhook provider payloads. */
export interface MikaMaintenanceRawProviderPayloadsResult {
  readonly scanned: number;
  readonly purged: number;
}

/** Outcome of a single maintenance sweep across all configured tasks. */
export interface MikaMaintenanceRunResult {
  readonly now: ISODateTime;
  readonly emailOutbox: MikaMaintenanceTaskResult<MikaEmailOutboxRunResult>;
  readonly stuckEmails: MikaMaintenanceTaskResult<MikaMaintenanceStuckEmailsResult>;
  readonly rawProviderPayloads: MikaMaintenanceTaskResult<MikaMaintenanceRawProviderPayloadsResult>;
  readonly acpSessions: MikaMaintenanceTaskResult<MikaAcpSessionCleanupResult>;
  readonly stockReservations: MikaMaintenanceTaskResult<MikaMaintenanceStockReservationsResult>;
  readonly ephemeralRecords: MikaMaintenanceTaskResult<MikaMaintenanceEphemeralRecordsResult>;
  readonly accountDeleteRequests: MikaMaintenanceTaskResult<MikaMaintenanceAccountDeleteRequestsResult>;
  readonly stuckWorkflows: MikaMaintenanceTaskResult<MikaMaintenanceStuckWorkflowsResult>;
}

/** Runs background hygiene tasks; skips tasks when dependencies are not configured. */
export interface MikaMaintenanceRunner {
  runOnce(options?: MikaMaintenanceRunOptions): Promise<MikaMaintenanceRunResult>;
}

type MikaMaintenanceReleaseExpiredReservations = (
  input: Required<ReleaseExpiredReservationsInput>,
) => Promise<MikaMaintenanceStockReservationsResult>;

type MikaMaintenancePurgeExpiredEphemeralRecords = (input: {
  readonly now: ISODateTime;
}) => Promise<MikaMaintenanceEphemeralRecordsResult>;

type MikaMaintenanceRepositories = Pick<
  MikaBackendRepositories,
  "account" | "ephemeral" | "ledger" | "ops" | "session" | "stock"
>;

interface MikaMaintenanceRunnerInput {
  readonly api?: Pick<MikaApi, "admin">;
  readonly acpSessionStore?: MikaAcpSessionStore;
  readonly cleanupExpiredAcpSessions?: (
    input: MikaAcpSessionCleanupInput,
  ) => Promise<MikaAcpSessionCleanupResult>;
  readonly emailOutboxRunner?: MikaEmailOutboxRunner;
  readonly repositories?: MikaMaintenanceRepositories;
  readonly now?: MikaBackendNow;
  readonly releaseExpiredReservations?: MikaMaintenanceReleaseExpiredReservations;
  readonly purgeExpiredEphemeralRecords?: MikaMaintenancePurgeExpiredEphemeralRecords;
}

const DEFAULT_ACCOUNT_DELETE_BATCH_SIZE = 25;
const DEFAULT_STUCK_EMAIL_BATCH_SIZE = 50;
const DEFAULT_RAW_PROVIDER_PAYLOAD_BATCH_SIZE = 50;
const DEFAULT_RAW_PROVIDER_PAYLOAD_RETENTION_DAYS = 14;
const DEFAULT_ACP_SESSION_BATCH_SIZE = 50;
const DEFAULT_STUCK_WORKFLOW_BATCH_SIZE = 50;

/** Composes optional outbox, stock, ephemeral, and account-delete processors. */
export function createMikaMaintenanceRunner(
  input: MikaMaintenanceRunnerInput = {},
): MikaMaintenanceRunner {
  return {
    async runOnce(options = {}) {
      const now = options.now ?? currentISODateTime(input.now);
      const emailOutbox = await runMaintenanceTask(async () => {
        if (!input.emailOutboxRunner) {
          return { status: "skipped" as const, reason: "Email outbox runner is not configured." };
        }

        const emailOptions: MikaEmailOutboxRunOptions = {
          now,
          ...(options.emailLimit === undefined ? {} : { limit: options.emailLimit }),
        };

        return {
          status: "completed" as const,
          result: await input.emailOutboxRunner.runOnce(emailOptions),
        };
      });
      const stuckEmails = await runMaintenanceTask(async () => {
        if (!input.repositories) {
          return { status: "skipped" as const, reason: "Email repositories are not configured." };
        }

        return {
          status: "completed" as const,
          result: await input.repositories.ops.reclaimExhaustedEmails(
            now,
            options.stuckEmailLimit ?? DEFAULT_STUCK_EMAIL_BATCH_SIZE,
          ),
        };
      });
      const rawProviderPayloads = await runMaintenanceTask(async () => {
        if (!input.repositories) {
          return {
            status: "skipped" as const,
            reason: "Raw provider payload repositories are not configured.",
          };
        }

        return {
          status: "completed" as const,
          result: await input.repositories.ops.purgeWebhookRawPayloads(
            rawProviderPayloadCutoff(
              now,
              options.rawProviderPayloadRetentionDays ??
                DEFAULT_RAW_PROVIDER_PAYLOAD_RETENTION_DAYS,
            ),
            now,
            options.rawProviderPayloadLimit ?? DEFAULT_RAW_PROVIDER_PAYLOAD_BATCH_SIZE,
          ),
        };
      });
      const acpSessions = await runMaintenanceTask(async () => {
        const cleanup = input.cleanupExpiredAcpSessions ?? input.acpSessionStore?.cleanupExpired;
        if (!cleanup) {
          return {
            status: "skipped" as const,
            reason: "ACP session cleanup service is not configured.",
          };
        }

        return {
          status: "completed" as const,
          result: await cleanup({
            now,
            limit: options.acpSessionLimit ?? DEFAULT_ACP_SESSION_BATCH_SIZE,
          }),
        };
      });
      const stockReservations = await runMaintenanceTask(async () => {
        const release =
          input.releaseExpiredReservations ??
          (input.api ? createApiStockReservationRelease(input.api) : undefined);
        if (!release) {
          return {
            status: "skipped" as const,
            reason: "Stock reservation release service is not configured.",
          };
        }

        return {
          status: "completed" as const,
          result: await release({ now }),
        };
      });
      const ephemeralRecords = await runMaintenanceTask(async () => {
        const purge =
          input.purgeExpiredEphemeralRecords ??
          (input.repositories
            ? async (purgeInput: { readonly now: ISODateTime }) => ({
                purged: await input.repositories!.ephemeral.purgeExpired(purgeInput.now),
              })
            : undefined);
        if (!purge) {
          return {
            status: "skipped" as const,
            reason: "Ephemeral record purge service is not configured.",
          };
        }

        return {
          status: "completed" as const,
          result: await purge({ now }),
        };
      });
      const accountDeleteRequests = await runMaintenanceTask(async () => {
        if (!input.repositories) {
          return {
            status: "skipped" as const,
            reason: "Account-delete repositories are not configured.",
          };
        }

        return {
          status: "completed" as const,
          result: await processQueuedAccountDeleteRequests({
            repositories: input.repositories,
            now,
            limit: options.accountDeleteLimit ?? DEFAULT_ACCOUNT_DELETE_BATCH_SIZE,
          }),
        };
      });
      const stuckWorkflows = await runMaintenanceTask(async () => {
        if (!input.repositories) {
          return { status: "skipped" as const, reason: "Workflow repositories are not configured." };
        }
        return {
          status: "completed" as const,
          result: await input.repositories.ops.reclaimExhaustedWorkflows(
            now,
            options.stuckWorkflowLimit ?? DEFAULT_STUCK_WORKFLOW_BATCH_SIZE,
          ),
        };
      });

      return {
        now,
        emailOutbox,
        stuckEmails,
        rawProviderPayloads,
        acpSessions,
        stockReservations,
        ephemeralRecords,
        accountDeleteRequests,
        stuckWorkflows,
      };
    },
  };
}

async function processQueuedAccountDeleteRequests(input: {
  readonly repositories: MikaMaintenanceRepositories;
  readonly now: ISODateTime;
  readonly limit: number;
}): Promise<MikaMaintenanceAccountDeleteRequestsResult> {
  const queued = await input.repositories.ops.listQueuedAccountDeleteRequests(input.limit);
  const items: MikaMaintenanceAccountDeleteRequestItem[] = [];

  for (const item of queued.items) {
    const request = item.data;

    try {
      await assertAccountDeleteMaintenanceAllowed(input.repositories, request);
      const sentinel = accountDeleteSentinel(request);
      const tokensDeleted = await input.repositories.ephemeral.deleteTokensBySubjectHashes(
        subjectHashCandidates(request),
      );
      const stockResult = request.customerId
        ? await input.repositories.stock.releaseActiveReservationsByCustomer({
            customerId: request.customerId,
            now: input.now,
          })
        : { releasedCount: 0 };
      const emailsRedacted = await input.repositories.ops.redactQueuedFailedEmailsForAccountDelete({
        now: input.now,
        ...(request.customerId ? { customerId: request.customerId } : {}),
        ...(request.userId ? { userId: request.userId } : {}),
        ...(request.emailHash ? { emailHash: request.emailHash } : {}),
      });
      const ordersResult = sentinel
        ? await input.repositories.ledger.anonymizeOrdersForAccountDelete({
            now: input.now,
            sentinel,
            ...(request.customerId ? { customerId: request.customerId } : {}),
            ...(request.emailHash ? { emailHash: request.emailHash } : {}),
          })
        : { anonymized: 0 };
      const entitlementsResult = sentinel
        ? await input.repositories.account.anonymizeEntitlementsForAccountDelete({
            now: input.now,
            sentinel,
            ...(request.customerId ? { customerId: request.customerId } : {}),
            ...(request.emailHash ? { emailHash: request.emailHash } : {}),
            ...(request.userId ? { userId: request.userId } : {}),
          })
        : { anonymized: 0 };
      const licensesResult = sentinel
        ? await input.repositories.account.anonymizeLicensesForAccountDelete({
            now: input.now,
            sentinel,
            ...(request.customerId ? { customerId: request.customerId } : {}),
          })
        : { anonymized: 0 };
      const customerResult = await input.repositories.account.anonymizeCustomerForAccountDelete({
        now: input.now,
        ...(request.customerId ? { customerId: request.customerId } : {}),
        ...(request.emailHash ? { emailHash: request.emailHash } : {}),
      });

      const completed = await input.repositories.ops.completeAccountDeleteRequest({
        requestId: request.id,
        now: input.now,
        metadata: {
          maintenance: {
            tokensDeleted,
            reservationsReleased: stockResult.releasedCount,
            emailsRedacted,
            customerAnonymized: customerResult.anonymized,
            ordersAnonymized: ordersResult.anonymized,
            entitlementsAnonymized: entitlementsResult.anonymized,
            licensesAnonymized: licensesResult.anonymized,
          },
        },
      });
      if (!completed) {
        throw new Error(`Account delete request '${request.id}' could not be completed.`);
      }

      items.push({
        requestId: request.id,
        status: "completed",
        tokensDeleted,
        reservationsReleased: stockResult.releasedCount,
        emailsRedacted,
        customerAnonymized: customerResult.anonymized,
        ordersAnonymized: ordersResult.anonymized,
        entitlementsAnonymized: entitlementsResult.anonymized,
        licensesAnonymized: licensesResult.anonymized,
      });
    } catch (error) {
      const message = errorMessage(error);
      await input.repositories.ops.failAccountDeleteRequest({
        requestId: request.id,
        now: input.now,
        lastError: message,
      });
      items.push({
        requestId: request.id,
        status: "failed",
        error: message,
      });
    }
  }

  return {
    scanned: queued.items.length,
    completed: items.filter((item) => item.status === "completed").length,
    failed: items.filter((item) => item.status === "failed").length,
    hasMore: queued.hasMore,
    items,
  };
}

// Blocks account-delete completion while an active subscription or checkout-pending cart exists.
async function assertAccountDeleteMaintenanceAllowed(
  repositories: MikaMaintenanceRepositories,
  request: {
    readonly customerId?: MikaId;
    readonly userId?: string;
    readonly emailHash?: string;
  },
): Promise<void> {
  if (!request.customerId) return;

  const subscriptions = await repositories.account.listSubscriptionsByCustomer(
    request.customerId,
    Number.MAX_SAFE_INTEGER,
  );
  const activeSubscription = subscriptions.items.find(
    (item) => item.data.status !== "cancelled" && item.data.status !== "expired",
  );
  if (activeSubscription) {
    throw new Error(
      `Account delete request is blocked by active subscription '${activeSubscription.id}'.`,
    );
  }

  const pendingCarts = await repositories.session.listCheckoutPendingCartsByCustomer(
    request.customerId,
    1,
  );
  if (pendingCarts.items.length > 0) {
    throw new Error(
      `Account delete request is blocked by active checkout '${pendingCarts.items[0]!.id}'.`,
    );
  }
}

// Anonymization sentinel precedence: customerId, then emailHash, then userId.
function accountDeleteSentinel(request: {
  readonly customerId?: MikaId;
  readonly userId?: string;
  readonly emailHash?: string;
}): string | undefined {
  if (request.customerId) return `account-deleted:${request.customerId}`;
  if (request.emailHash) return `account-deleted-email:${request.emailHash}`;
  if (request.userId) return `account-deleted-user:${request.userId}`;

  return undefined;
}

async function runMaintenanceTask<TResult>(
  run: () => Promise<MikaMaintenanceTaskResult<TResult>>,
): Promise<MikaMaintenanceTaskResult<TResult>> {
  try {
    return await run();
  } catch (error) {
    return {
      status: "failed",
      error: errorMessage(error),
    };
  }
}

function createApiStockReservationRelease(
  api: Pick<MikaApi, "admin">,
): MikaMaintenanceReleaseExpiredReservations {
  return async ({ now }) => {
    const result = await api.admin.releaseExpiredReservations({ now });
    if (!result.ok) {
      throw new Error(apiErrorMessage(result));
    }

    return adminActionAffectedCounts(result.data);
  };
}

function adminActionAffectedCounts(
  data: AdminActionResultDTO,
): MikaMaintenanceStockReservationsResult {
  const affected = data.affected ?? {};

  return {
    reservationsScanned: numberField(affected, "reservationsScanned"),
    reservationsReleased: numberField(affected, "reservationsReleased"),
    stockItems: numberField(affected, "stockItems"),
  };
}

function numberField(input: Record<string, number> | undefined, key: string): number {
  const value = input?.[key];

  return typeof value === "number" ? value : 0;
}

function currentISODateTime(now?: MikaBackendNow): ISODateTime {
  return createISODateTime((now?.() ?? new Date()).toISOString());
}

function rawProviderPayloadCutoff(now: ISODateTime, retentionDays: number): ISODateTime {
  const days = Number.isFinite(retentionDays) ? Math.max(0, retentionDays) : 0;
  const retentionMs = days * 24 * 60 * 60 * 1000;

  return createISODateTime(new Date(Date.parse(now) - retentionMs).toISOString());
}

function apiErrorMessage(result: MikaApiResult<unknown>): string {
  return result.ok ? "Mika API call unexpectedly succeeded." : result.error.message;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
