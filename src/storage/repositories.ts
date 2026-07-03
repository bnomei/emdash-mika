/**
 * Repository layer over document collections and operational SQLite tables.
 * This file is a thin barrel; the implementation lives in ./repositories/*.
 */
export type { MikaDb, MikaDbExecutor } from "./repositories/db-shared";
export { EphemeralRepository } from "./repositories/ephemeral";
export { CatalogRepository } from "./repositories/catalog";
export { LedgerRepository } from "./repositories/ledger";
export { AccountRepository } from "./repositories/account";
export {
  SessionRepository,
  findSessionRepositoryOpenCartBySessionAnyCurrency,
} from "./repositories/session";
export { nextCartVersion } from "../model/cart-version";
export { StockRepository } from "./repositories/stock";
export { OpsRepository } from "./repositories/ops";
export type {
  AccountDeleteEmailRedactionRepositoryInput,
  AccountDeleteMaintenanceStepRepositoryInput,
  AccountDeleteRequestCompletionRepositoryInput,
  AccountDeleteRequestFailureRepositoryInput,
  AdjustStockRepositoryInput,
  AdjustStockRepositoryResult,
  AdminAuditIdempotencyClaimResult,
  CatalogProviderPriceMatch,
  ConsumeReservedStockRepositoryInput,
  ConsumeReservedStockRepositoryResult,
  EmailCompleteRepositoryInput,
  EmailDeliveredRepositoryInput,
  EmailFailureRepositoryInput,
  EmailLeaseRepositoryInput,
  EmailSkipRepositoryInput,
  ExpireReservedStockRepositoryResult,
  ExtendReservationsRepositoryInput,
  ReleaseActiveReservationsByCustomerRepositoryInput,
  ReleaseExpiredReservationsRepositoryInput,
  ReleaseExpiredReservationsRepositoryResult,
  ReleaseReservedStockRepositoryInput,
  ReleaseReservedStockRepositoryResult,
  ReserveStockRepositoryInput,
  ReserveStockRepositoryResult,
  WorkflowFailureRepositoryInput,
  WorkflowLeaseRepositoryInput,
  WorkflowStepRepositoryInput,
} from "./repositories/contracts";
