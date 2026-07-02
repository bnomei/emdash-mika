/**
 * Repository layer over document collections and operational SQLite tables.
 * This file is a thin barrel; the implementation lives in ./repositories/*.
 */
export { createMikaRepositories, MikaRepositories } from "./repositories/factory";
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
export {
  OpsRepository,
  type EmailCompleteRepositoryInput,
  type EmailDeliveredRepositoryInput,
  type EmailFailureRepositoryInput,
  type EmailLeaseRepositoryInput,
  type EmailSkipRepositoryInput,
  type WorkflowFailureRepositoryInput,
  type WorkflowLeaseRepositoryInput,
  type WorkflowStepRepositoryInput,
} from "./repositories/ops";
