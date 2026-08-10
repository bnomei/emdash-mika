/**
 * Scheduled maintenance orchestrator for background commerce hygiene.
 *
 * `runOnce` sweeps nine optional tasks — each skips when its dependency is unconfigured:
 * email outbox delivery, stuck email lease reclaim, raw webhook payload purge, ACP session
 * cleanup, expired stock reservation release, ephemeral record purge, queued account-delete
 * completion, stuck workflow lease reclaim, and due payment-webhook retry.
 */
import type { MikaBackendNow, MikaBackendRepositories } from "./backend";
import type { AdminActionResultDTO, MikaApiResult } from "./types";
import type { MikaApi } from "./server";
import type { AccountDeleteRequestDocument } from "../types/documents";
import type {
  MikaEmailOutboxRunner,
  MikaEmailOutboxRunOptions,
  MikaEmailOutboxRunResult,
} from "./email-outbox";
import type {
  MikaAcpSessionCleanupInput,
  MikaAcpSessionCleanupResult,
  MikaAcpSessionStore,
} from "./acp-session";
import { subjectHashCandidates } from "./subject-ref";
import {
  createISODateTime,
  isJsonObject,
  type ISODateTime,
  type JsonObject,
  type MikaId,
} from "../types/primitives";

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
  readonly webhookRetryLimit?: number;
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

/** Counts from re-driving due payment-webhook fulfillment workflows during maintenance. */
export interface MikaMaintenanceWebhookRetriesResult {
  readonly scanned: number;
  readonly retried: number;
  readonly skippedExhausted: number;
  readonly hasMore: boolean;
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
      readonly accountExportsRedacted: number;
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
  readonly webhookRetries: MikaMaintenanceTaskResult<MikaMaintenanceWebhookRetriesResult>;
}

/** Runs background hygiene tasks; skips tasks when dependencies are not configured. */
export interface MikaMaintenanceRunner {
  runOnce(options?: MikaMaintenanceRunOptions): Promise<MikaMaintenanceRunResult>;
}

type MikaMaintenanceReleaseExpiredReservations = (input: {
  readonly now: ISODateTime;
}) => Promise<MikaMaintenanceStockReservationsResult>;

type MikaMaintenancePurgeExpiredEphemeralRecords = (input: {
  readonly now: ISODateTime;
}) => Promise<MikaMaintenanceEphemeralRecordsResult>;

type MikaMaintenanceRepositories = Pick<
  MikaBackendRepositories,
  "account" | "ephemeral" | "ledger" | "ops" | "session" | "stock"
>;

export interface MikaMaintenanceRunnerInput {
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
const DEFAULT_WEBHOOK_RETRY_BATCH_SIZE = 50;

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
        const acpSessionStore = input.acpSessionStore;
        const cleanup =
          input.cleanupExpiredAcpSessions ?? acpSessionStore?.cleanupExpired?.bind(acpSessionStore);
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
          return {
            status: "skipped" as const,
            reason: "Workflow repositories are not configured.",
          };
        }
        return {
          status: "completed" as const,
          result: await input.repositories.ops.reclaimExhaustedWorkflows(
            now,
            options.stuckWorkflowLimit ?? DEFAULT_STUCK_WORKFLOW_BATCH_SIZE,
          ),
        };
      });
      const webhookRetries = await runMaintenanceTask(async () => {
        if (!input.repositories || !input.api) {
          return {
            status: "skipped" as const,
            reason: "Webhook retry driver requires repositories and api.",
          };
        }
        return {
          status: "completed" as const,
          result: await retryDuePaymentWebhooks({
            repositories: input.repositories,
            api: input.api,
            now,
            limit: options.webhookRetryLimit ?? DEFAULT_WEBHOOK_RETRY_BATCH_SIZE,
          }),
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
        webhookRetries,
      };
    },
  };
}

async function retryDuePaymentWebhooks(input: {
  readonly repositories: MikaMaintenanceRepositories;
  readonly api: Pick<MikaApi, "admin">;
  readonly now: ISODateTime;
  readonly limit: number;
}): Promise<MikaMaintenanceWebhookRetriesResult> {
  const due = await input.repositories.ops.listDueWorkflows(
    input.now,
    input.limit,
    "payment_webhook_fulfillment",
  );
  let retried = 0;
  let skippedExhausted = 0;

  for (const item of due.items) {
    const workflow = item.data;
    if (workflow.record.attemptCount >= workflow.record.maxAttempts) {
      skippedExhausted += 1;
      continue;
    }
    if (!workflow.subjectId) continue;

    await input.api.admin.webhookReplay({ webhookId: workflow.subjectId });
    retried += 1;
  }

  return {
    scanned: due.items.length,
    retried,
    skippedExhausted,
    hasMore: due.hasMore,
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
    let request = item.data;
    let cleanupApplied = hasCompletedAccountDeleteMaintenanceSteps(request);

    try {
      await assertAccountDeleteMaintenanceAllowed(input.repositories, request);
      const sentinel = accountDeleteSentinel(request);
      const runStep = async <TValue extends number | boolean>(
        stepName: AccountDeleteMaintenanceStepName,
        valueType: "number" | "boolean",
        run: () => Promise<TValue>,
      ): Promise<TValue> => {
        const recorded = accountDeleteMaintenanceStepValue(request, stepName);
        if (typeof recorded === valueType) return recorded as TValue;

        const value = await run();
        cleanupApplied = true;
        const updated = await input.repositories.ops.recordAccountDeleteMaintenanceStep({
          requestId: request.id,
          now: input.now,
          stepName,
          result: { value },
        });
        if (!updated) {
          throw new Error(
            `Account delete request '${request.id}' step '${stepName}' could not be recorded.`,
          );
        }
        request = updated;

        return value;
      };

      const tokensDeleted = await runStep("tokensDeleted", "number", () =>
        input.repositories.ephemeral.deleteTokensBySubjectHashes(subjectHashCandidates(request)),
      );
      const reservationsReleased = await runStep("reservationsReleased", "number", async () => {
        if (!request.customerId) return 0;
        const stockResult = await input.repositories.stock.releaseActiveReservationsByCustomer({
          customerId: request.customerId,
          now: input.now,
        });

        return stockResult.releasedCount;
      });
      const emailsRedacted = await runStep("emailsRedacted", "number", () =>
        input.repositories.ops.redactQueuedFailedEmailsForAccountDelete({
          now: input.now,
          ...(request.customerId ? { customerId: request.customerId } : {}),
          ...(request.userId ? { userId: request.userId } : {}),
          ...(request.emailHash ? { emailHash: request.emailHash } : {}),
        }),
      );
      const accountExportsRedacted = await runStep("accountExportsRedacted", "number", () =>
        input.repositories.ops.redactAccountExportsForAccountDelete({
          now: input.now,
          ...(request.customerId ? { customerId: request.customerId } : {}),
          ...(request.userId ? { userId: request.userId } : {}),
          ...(request.emailHash ? { emailHash: request.emailHash } : {}),
        }),
      );
      const ordersAnonymized = await runStep("ordersAnonymized", "number", async () => {
        if (!sentinel) return 0;
        const result = await input.repositories.ledger.anonymizeOrdersForAccountDelete({
          now: input.now,
          sentinel,
          ...(request.customerId ? { customerId: request.customerId } : {}),
          ...(request.emailHash ? { emailHash: request.emailHash } : {}),
        });

        return result.anonymized;
      });
      const entitlementsAnonymized = await runStep("entitlementsAnonymized", "number", async () => {
        if (!sentinel) return 0;
        const result = await input.repositories.account.anonymizeEntitlementsForAccountDelete({
          now: input.now,
          sentinel,
          ...(request.customerId ? { customerId: request.customerId } : {}),
          ...(request.emailHash ? { emailHash: request.emailHash } : {}),
          ...(request.userId ? { userId: request.userId } : {}),
        });

        return result.anonymized;
      });
      const licensesAnonymized = await runStep("licensesAnonymized", "number", async () => {
        if (!sentinel) return 0;
        const result = await input.repositories.account.anonymizeLicensesForAccountDelete({
          now: input.now,
          sentinel,
          ...(request.customerId ? { customerId: request.customerId } : {}),
        });

        return result.anonymized;
      });
      const customerAnonymized = await runStep("customerAnonymized", "boolean", async () => {
        const result = await input.repositories.account.anonymizeCustomerForAccountDelete({
          now: input.now,
          ...(request.customerId ? { customerId: request.customerId } : {}),
          ...(request.emailHash ? { emailHash: request.emailHash } : {}),
        });

        return result.anonymized;
      });

      const completed = await input.repositories.ops.completeAccountDeleteRequest({
        requestId: request.id,
        now: input.now,
        metadata: {
          maintenance: {
            ...accountDeleteMaintenanceMetadata(request),
            tokensDeleted,
            reservationsReleased,
            emailsRedacted,
            accountExportsRedacted,
            customerAnonymized,
            ordersAnonymized,
            entitlementsAnonymized,
            licensesAnonymized,
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
        reservationsReleased,
        emailsRedacted,
        accountExportsRedacted,
        customerAnonymized,
        ordersAnonymized,
        entitlementsAnonymized,
        licensesAnonymized,
      });
    } catch (error) {
      const message = errorMessage(error);
      await recordAccountDeleteRequestFailure(input.repositories, request, input.now, message, {
        retryable: cleanupApplied || hasCompletedAccountDeleteMaintenanceSteps(request),
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

type AccountDeleteMaintenanceStepName =
  | "tokensDeleted"
  | "reservationsReleased"
  | "emailsRedacted"
  | "accountExportsRedacted"
  | "ordersAnonymized"
  | "entitlementsAnonymized"
  | "licensesAnonymized"
  | "customerAnonymized";

async function recordAccountDeleteRequestFailure(
  repositories: MikaMaintenanceRepositories,
  request: AccountDeleteRequestDocument,
  now: ISODateTime,
  lastError: string,
  options: { readonly retryable: boolean },
): Promise<void> {
  if (options.retryable) {
    try {
      await repositories.ops.recordAccountDeleteRequestError({
        requestId: request.id,
        now,
        lastError,
      });
    } catch {
      // Keep the in-memory result failed while leaving the queued request retryable.
    }

    return;
  }

  await repositories.ops.failAccountDeleteRequest({
    requestId: request.id,
    now,
    lastError,
  });
}

function hasCompletedAccountDeleteMaintenanceSteps(request: AccountDeleteRequestDocument): boolean {
  const steps = jsonObjectChild(accountDeleteMaintenanceMetadata(request), "steps");

  return steps ? Object.keys(steps).length > 0 : false;
}

function accountDeleteMaintenanceStepValue(
  request: AccountDeleteRequestDocument,
  stepName: AccountDeleteMaintenanceStepName,
): number | boolean | undefined {
  const steps = jsonObjectChild(accountDeleteMaintenanceMetadata(request), "steps");
  const step = jsonObjectChild(steps, stepName);
  if (step?.["status"] !== "completed") return undefined;

  const result = jsonObjectChild(step, "result");
  const value = result?.["value"];

  return typeof value === "number" || typeof value === "boolean" ? value : undefined;
}

function accountDeleteMaintenanceMetadata(request: AccountDeleteRequestDocument): JsonObject {
  return jsonObjectChild(request.record.metadata, "maintenance") ?? {};
}

function jsonObjectChild(input: JsonObject | undefined, key: string): JsonObject | undefined {
  const value = input?.[key];

  return isJsonObject(value) ? value : undefined;
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
