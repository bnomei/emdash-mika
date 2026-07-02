import type { MikaStorageCollections } from "../collections";
import type { MikaDbExecutor } from "./db-shared";
import { EphemeralRepository } from "./ephemeral";
import { StockRepository } from "./stock";
import { CatalogRepository } from "./catalog";
import { LedgerRepository } from "./ledger";
import { SessionRepository } from "./session";
import { AccountRepository } from "./account";
import { OpsRepository } from "./ops";

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
