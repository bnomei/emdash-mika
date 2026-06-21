import type { MikaBackendNow, MikaBackendRepositories } from "./backend";
import type { AdminActionResultDTO, MikaApiResult, ReleaseExpiredReservationsInput } from "./types";
import type { MikaApi } from "./server";
import type {
  MikaEmailOutboxRunner,
  MikaEmailOutboxRunOptions,
  MikaEmailOutboxRunResult,
} from "./email-outbox";
import { createISODateTime, type ISODateTime, type MikaId } from "../types/primitives";

export interface MikaMaintenanceRunOptions {
  readonly now?: ISODateTime;
  readonly emailLimit?: number;
  readonly accountDeleteLimit?: number;
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

export interface MikaMaintenanceStockReservationsResult {
  readonly reservationsScanned: number;
  readonly reservationsReleased: number;
  readonly stockItems: number;
}

export interface MikaMaintenanceEphemeralRecordsResult {
  readonly purged: number;
}

export interface MikaMaintenanceAccountDeleteRequestsResult {
  readonly scanned: number;
  readonly completed: number;
  readonly failed: number;
  readonly hasMore: boolean;
  readonly items: readonly MikaMaintenanceAccountDeleteRequestItem[];
}

export type MikaMaintenanceAccountDeleteRequestItem =
  | {
      readonly requestId: MikaId;
      readonly status: "completed";
      readonly tokensDeleted: number;
      readonly reservationsReleased: number;
      readonly emailsRedacted: number;
    }
  | {
      readonly requestId: MikaId;
      readonly status: "failed";
      readonly error: string;
    };

export interface MikaMaintenanceRunResult {
  readonly now: ISODateTime;
  readonly emailOutbox: MikaMaintenanceTaskResult<MikaEmailOutboxRunResult>;
  readonly stockReservations: MikaMaintenanceTaskResult<MikaMaintenanceStockReservationsResult>;
  readonly ephemeralRecords: MikaMaintenanceTaskResult<MikaMaintenanceEphemeralRecordsResult>;
  readonly accountDeleteRequests: MikaMaintenanceTaskResult<MikaMaintenanceAccountDeleteRequestsResult>;
}

export interface MikaMaintenanceRunner {
  runOnce(options?: MikaMaintenanceRunOptions): Promise<MikaMaintenanceRunResult>;
}

type MikaMaintenanceReleaseExpiredReservations = (
  input: Required<ReleaseExpiredReservationsInput>,
) => Promise<MikaMaintenanceStockReservationsResult>;

type MikaMaintenancePurgeExpiredEphemeralRecords = (input: {
  readonly now: ISODateTime;
}) => Promise<MikaMaintenanceEphemeralRecordsResult>;

interface MikaMaintenanceRunnerInput {
  readonly api?: Pick<MikaApi, "admin">;
  readonly emailOutboxRunner?: MikaEmailOutboxRunner;
  readonly repositories?: Pick<MikaBackendRepositories, "ephemeral" | "ops" | "stock">;
  readonly now?: MikaBackendNow;
  readonly releaseExpiredReservations?: MikaMaintenanceReleaseExpiredReservations;
  readonly purgeExpiredEphemeralRecords?: MikaMaintenancePurgeExpiredEphemeralRecords;
}

const DEFAULT_ACCOUNT_DELETE_BATCH_SIZE = 25;

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

      return {
        now,
        emailOutbox,
        stockReservations,
        ephemeralRecords,
        accountDeleteRequests,
      };
    },
  };
}

async function processQueuedAccountDeleteRequests(input: {
  readonly repositories: Pick<MikaBackendRepositories, "ephemeral" | "ops" | "stock">;
  readonly now: ISODateTime;
  readonly limit: number;
}): Promise<MikaMaintenanceAccountDeleteRequestsResult> {
  const queued = await input.repositories.ops.listQueuedAccountDeleteRequests(input.limit);
  const items: MikaMaintenanceAccountDeleteRequestItem[] = [];

  for (const item of queued.items) {
    const request = item.data;

    try {
      const tokensDeleted = await input.repositories.ephemeral.deleteTokensBySubjectHashes(
        accountDeleteSubjectHashes(request),
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

      const completed = await input.repositories.ops.completeAccountDeleteRequest({
        requestId: request.id,
        now: input.now,
        metadata: {
          maintenance: {
            tokensDeleted,
            reservationsReleased: stockResult.releasedCount,
            emailsRedacted,
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

function accountDeleteSubjectHashes(input: {
  readonly customerId?: MikaId;
  readonly userId?: string;
  readonly emailHash?: string;
}): readonly string[] {
  return [
    ...(input.customerId ? [input.customerId, `customer:${input.customerId}`] : []),
    ...(input.userId ? [`user:${input.userId}`] : []),
    ...(input.emailHash ? [input.emailHash, `email:${input.emailHash}`] : []),
  ];
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

function apiErrorMessage(result: MikaApiResult<unknown>): string {
  return result.ok ? "Mika API call unexpectedly succeeded." : result.error.message;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
