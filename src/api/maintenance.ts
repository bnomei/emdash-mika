import type { MikaBackendNow, MikaBackendRepositories } from "./backend";
import type {
  AdminActionResultDTO,
  MikaApiResult,
  ReleaseExpiredReservationsInput,
} from "./types";
import type { MikaApi } from "./server";
import type {
  MikaEmailOutboxRunner,
  MikaEmailOutboxRunOptions,
  MikaEmailOutboxRunResult,
} from "./email-outbox";
import { createISODateTime, type ISODateTime } from "../types/primitives";

export interface MikaMaintenanceRunOptions {
  readonly now?: ISODateTime;
  readonly emailLimit?: number;
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

export interface MikaMaintenanceRunResult {
  readonly now: ISODateTime;
  readonly emailOutbox: MikaMaintenanceTaskResult<MikaEmailOutboxRunResult>;
  readonly stockReservations: MikaMaintenanceTaskResult<MikaMaintenanceStockReservationsResult>;
  readonly ephemeralRecords: MikaMaintenanceTaskResult<MikaMaintenanceEphemeralRecordsResult>;
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
  readonly repositories?: Pick<MikaBackendRepositories, "ephemeral">;
  readonly now?: MikaBackendNow;
  readonly releaseExpiredReservations?: MikaMaintenanceReleaseExpiredReservations;
  readonly purgeExpiredEphemeralRecords?: MikaMaintenancePurgeExpiredEphemeralRecords;
}

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

      return {
        now,
        emailOutbox,
        stockReservations,
        ephemeralRecords,
      };
    },
  };
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
