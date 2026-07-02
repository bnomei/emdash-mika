/**
 * Repository layer over document collections and operational SQLite tables.
 * Encapsulates typed queries, stock mutations, workflow leases, and ephemeral record access.
 */
import type { MikaStorageCollections } from "./collections";
import type { MikaDbExecutor } from "./repositories/db-shared";
import { EphemeralRepository } from "./repositories/ephemeral";
import { StockRepository } from "./repositories/stock";
import { CatalogRepository } from "./repositories/catalog";
import { LedgerRepository } from "./repositories/ledger";
import { SessionRepository } from "./repositories/session";
import { AccountRepository } from "./repositories/account";
import { OpsRepository } from "./repositories/ops";

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
