import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { LibsqlDialect } from "@libsql/kysely-libsql";
import { describe, expect, expectTypeOf, it } from "vite-plus/test";
import { Kysely, sql } from "kysely";

import {
  createMikaStockLifecycleService,
  createMikaBackendApi,
  type CreateMikaBackendApiInput,
  type MikaBackendDependencies,
  type MikaBackendRepositories,
} from "../src/api/backend";
import { MIKA_AGENT_IDEMPOTENCY_KEY_HEADER } from "../src/api/agent-types";
import { callMikaOperation, mikaActionDefinitions } from "../src/api/operations";
import { createMikaPluginRoutes } from "../src/api/route-handlers";
import { mikaPluginRoutes } from "../src/api/routes";
import { createMikaStorageConfig, type StorageCollection } from "../src/storage/collections";
import { MIKA_ERROR_CODES, type CartDTO, type MikaProviderCapability } from "../src/api/types";
import { createMikaApi, mikaApiMethodNames, type MikaApi } from "../src/api/server";
import type {
  MikaProviderAdapter,
  MikaProviderCheckoutInput,
  MikaProviderWebhookEvent,
  MikaProviderWebhookVerificationInput,
  MikaVerifiedWebhookPayload,
} from "../src/provider";
import { createMikaProviderRegistry } from "../src/provider";
import type { PriceDefinition, SellableDefinition } from "../src/types/aggregates";
import type {
  CatalogItemDocument,
  CheckoutDocument,
  CustomerDocument,
  ProviderAccountDocument,
  MikaStorageDocuments,
  OrderDocument,
} from "../src/types/documents";
import type { StockEventRecord, StockItemRecord } from "../src/types/operational";
import {
  AccountRepository,
  CatalogRepository,
  EphemeralRepository,
  LedgerRepository,
  OpsRepository,
  SessionRepository,
  StockRepository,
  type MikaDb,
  type MikaDbExecutor,
} from "../src/storage/repositories";
import { mikaInitialMigration } from "../src/storage/migrations";
import type { MikaDatabase } from "../src/storage/schema";
import {
  createCurrencyCode,
  createISODateTime,
  createMikaId,
  createProviderName,
} from "../src/types/primitives";
import {
  TEST_CURRENCY,
  TEST_NOW,
  TEST_PROVIDER,
  createTestClock,
  createTestContentRef,
  createTestCurrencyCode,
  createTestHash,
  createTestMikaDb,
  createTestMikaId,
  createTestProviderName,
  createTestRequestContext,
  createTestSellableDTO,
} from "./helpers/backend";
import { createFakeMikaProvider } from "./helpers/provider";
import { createMemoryStorageCollection } from "./helpers/storage";

type MemoryRecord = {
  readonly type: "account" | "order";
  readonly name: string;
  readonly status: "active" | "archived" | "queued";
  readonly amount: number;
  readonly createdAt: string;
  readonly priority?: number;
};

describe("backend test storage helpers", () => {
  it("satisfies the storage collection contract", () => {
    expectTypeOf(createMemoryStorageCollection<MemoryRecord>()).toEqualTypeOf<
      StorageCollection<MemoryRecord>
    >();
  });

  it("aligns ops webhook unique indexes with webhook dedupe keys", () => {
    const opsConfig = createMikaStorageConfig().ops;

    expect(opsConfig.indexes).toEqual(
      expect.arrayContaining([
        ["provider", "providerEventId"],
        ["provider", "payloadHash"],
      ]),
    );
    expect(opsConfig.uniqueIndexes).toEqual(
      expect.arrayContaining([
        ["provider", "providerEventId"],
        ["provider", "payloadHash"],
      ]),
    );
    expect(opsConfig.uniqueIndexes).not.toEqual(
      expect.arrayContaining([["provider", "eventType", "payloadHash"]]),
    );
  });

  it("supports single-record storage methods", async () => {
    const collection = createMemoryStorageCollection<MemoryRecord>();
    const record = createRecord({ name: "Alpha" });

    await collection.put("record_1", record);

    await expect(collection.get("record_1")).resolves.toBe(record);
    await expect(collection.get("missing")).resolves.toBeNull();
    await expect(collection.exists("record_1")).resolves.toBe(true);
    await expect(collection.exists("missing")).resolves.toBe(false);
    await expect(collection.delete("record_1")).resolves.toBe(true);
    await expect(collection.delete("record_1")).resolves.toBe(false);
    await expect(collection.exists("record_1")).resolves.toBe(false);
  });

  it("supports batch storage methods", async () => {
    const collection = createMemoryStorageCollection<MemoryRecord>();
    const first = createRecord({ name: "Alpha" });
    const second = createRecord({ name: "Beta" });

    await collection.putMany([
      { id: "record_1", data: first },
      { id: "record_2", data: second },
    ]);

    const records = await collection.getMany(["record_2", "missing", "record_1"]);
    expect(Array.from(records.entries())).toEqual([
      ["record_2", second],
      ["record_1", first],
    ]);
    await expect(collection.deleteMany(["record_1", "missing", "record_2"])).resolves.toBe(2);
    await expect(collection.count()).resolves.toBe(0);
  });

  it("queries exact, range, in, and startsWith filters", async () => {
    const collection = await createSeededCollection();

    await expect(collection.query({ where: { status: "active" } })).resolves.toMatchObject({
      items: [{ id: "record_1" }, { id: "record_3" }, { id: "record_4" }],
      hasMore: false,
    });
    await expect(
      collection.query({ where: { amount: { gte: 20, lt: 40 } } }),
    ).resolves.toMatchObject({
      items: [{ id: "record_2" }, { id: "record_3" }],
    });
    await expect(
      collection.query({ where: { name: { in: ["Beta", "Delta"] } } }),
    ).resolves.toMatchObject({
      items: [{ id: "record_2" }, { id: "record_4" }],
    });
    await expect(
      collection.query({ where: { name: { startsWith: "Al" } } }),
    ).resolves.toMatchObject({
      items: [{ id: "record_1" }],
    });
    await expect(collection.count({ type: "order", status: "active" })).resolves.toBe(2);
  });

  it("orders, limits, and paginates query results with cursors", async () => {
    const collection = await createSeededCollection();

    const firstPage = await collection.query({
      where: { type: "order" },
      orderBy: { amount: "desc" },
      limit: 2,
    });
    expect(firstPage).toMatchObject({
      items: [{ id: "record_4" }, { id: "record_3" }],
      cursor: "2",
      hasMore: true,
    });

    const secondPage = await collection.query({
      where: { type: "order" },
      orderBy: { amount: "desc" },
      limit: 2,
      cursor: firstPage.cursor,
    });
    expect(secondPage).toMatchObject({
      items: [{ id: "record_2" }],
      hasMore: false,
    });
    expect(secondPage.cursor).toBeUndefined();
  });
});

describe("backend test Kysely stock database harness", () => {
  it("runs Mika stock migrations up and down", async () => {
    const db = createTestMikaDb();

    try {
      await mikaInitialMigration.up(db);

      await expect(listMikaTableNames(db)).resolves.toEqual([
        "mika_ephemeral_records",
        "mika_stock_events",
        "mika_stock_items",
      ]);

      await rollbackMikaInitialMigration(db);

      await expect(listMikaTableNames(db)).resolves.toEqual([]);
    } finally {
      await db.destroy();
    }
  });

  it("persists and loads stock items through a real Kysely executor", async () => {
    const db = createTestMikaDb();
    const repository = new StockRepository(db);
    const stockItem: StockItemRecord = {
      id: createTestMikaId("stock", 1),
      sellableId: createTestMikaId("sellable", 1),
      policy: "finite",
      quantityOnHand: 10,
      quantityReserved: 2,
      lowStockThreshold: 3,
      allowBackorder: false,
      availableOverride: true,
      createdAt: TEST_NOW,
      updatedAt: TEST_NOW,
      metadata: { source: "backend-test" },
    };

    try {
      await mikaInitialMigration.up(db);

      await repository.putItem(stockItem);

      await expect(repository.findBySellableId(stockItem.sellableId)).resolves.toEqual(stockItem);
      await expect(
        repository.findBySellableId(createTestMikaId("sellable", 2)),
      ).resolves.toBeNull();
    } finally {
      await rollbackMikaInitialMigration(db);
      await db.destroy();
    }
  });

  it("reserves finite stock atomically and records a reservation event", async () => {
    const database = createTransactionTestMikaDb();
    const { db } = database;
    const repository = new StockRepository(db);
    const service = createMikaStockLifecycleService(
      createIncrementingBackendDependencies({
        repositories: { ...createTestBackendRepositories(), stock: repository },
      }),
    );
    const clock = createTestClock();
    const stockItem = createStockRecord({
      quantityOnHand: 10,
      quantityReserved: 2,
    });

    try {
      await mikaInitialMigration.up(db);
      await repository.putItem(stockItem);

      const result = await service.reserve({
        stockItemId: stockItem.id,
        quantity: 3,
        expiresAt: clock.isoAt(15 * 60_000),
        cartId: createTestMikaId("cart", 1),
        checkoutSessionId: createTestMikaId("checkout", 1),
        sessionId: "session_reserve_1",
        idempotencyKey: "reserve_success_1",
        metadata: { source: "backend-test" },
      });

      expect(result).toMatchObject({
        status: "reserved",
        event: {
          id: "stock_event_1",
          stockItemId: stockItem.id,
          kind: "reservation",
          status: "active",
          cartId: "cart_1",
          checkoutSessionId: "checkout_1",
          sessionId: "session_reserve_1",
          idempotencyKey: "reserve_success_1",
          quantityDelta: 3,
          expiresAt: "2026-01-01T00:15:00.000Z",
          metadata: { source: "backend-test" },
        },
        stock: {
          id: stockItem.id,
          quantityReserved: 5,
        },
      });
      await expect(repository.findBySellableId(stockItem.sellableId)).resolves.toMatchObject({
        quantityOnHand: 10,
        quantityReserved: 5,
      });
      await expect(
        repository.findEventByIdempotencyKey("reserve_success_1"),
      ).resolves.toMatchObject({
        id: "stock_event_1",
        stockItemId: stockItem.id,
        quantityDelta: 3,
        status: "active",
      });
    } finally {
      await rollbackMikaInitialMigration(db);
      await database.destroy();
    }
  });

  it("rejects insufficient finite stock without increasing reserved quantity", async () => {
    const database = createTransactionTestMikaDb();
    const { db } = database;
    const repository = new StockRepository(db);
    const service = createMikaStockLifecycleService(
      createIncrementingBackendDependencies({
        repositories: { ...createTestBackendRepositories(), stock: repository },
      }),
    );
    const stockItem = createStockRecord({
      quantityOnHand: 5,
      quantityReserved: 4,
    });

    try {
      await mikaInitialMigration.up(db);
      await repository.putItem(stockItem);

      const result = await service.reserve({
        stockItemId: stockItem.id,
        quantity: 2,
        expiresAt: createTestClock().isoAt(15 * 60_000),
        idempotencyKey: "reserve_insufficient_1",
      });

      expect(result).toMatchObject({
        status: "insufficient_stock",
        stock: {
          id: stockItem.id,
          quantityReserved: 4,
        },
      });
      await expect(repository.findBySellableId(stockItem.sellableId)).resolves.toMatchObject({
        quantityOnHand: 5,
        quantityReserved: 4,
      });
      await expect(
        repository.findEventByIdempotencyKey("reserve_insufficient_1"),
      ).resolves.toBeNull();
      await expect(countStockEvents(db)).resolves.toBe(0);
    } finally {
      await rollbackMikaInitialMigration(db);
      await database.destroy();
    }
  });

  it("makes backorder, untracked, and manual reservation policy behavior explicit", async () => {
    const database = createTransactionTestMikaDb();
    const { db } = database;
    const repository = new StockRepository(db);
    const service = createMikaStockLifecycleService(
      createIncrementingBackendDependencies({
        repositories: { ...createTestBackendRepositories(), stock: repository },
      }),
    );
    const cases = [
      createStockRecord({
        id: createTestMikaId("stock", 11),
        sellableId: createTestMikaId("sellable", 11),
        quantityOnHand: 1,
        quantityReserved: 1,
        allowBackorder: true,
      }),
      createStockRecord({
        id: createTestMikaId("stock", 12),
        sellableId: createTestMikaId("sellable", 12),
        policy: "backorder",
        quantityOnHand: 0,
        quantityReserved: 0,
      }),
      createStockRecord({
        id: createTestMikaId("stock", 13),
        sellableId: createTestMikaId("sellable", 13),
        policy: "untracked",
        quantityOnHand: 0,
        quantityReserved: 0,
      }),
      createStockRecord({
        id: createTestMikaId("stock", 14),
        sellableId: createTestMikaId("sellable", 14),
        policy: "manual",
        quantityOnHand: 0,
        quantityReserved: 0,
      }),
    ];

    try {
      await mikaInitialMigration.up(db);

      for (const stockItem of cases) {
        await repository.putItem(stockItem);

        const result = await service.reserve({
          stockItemId: stockItem.id,
          quantity: 3,
          expiresAt: createTestClock().isoAt(15 * 60_000),
          idempotencyKey: `reserve_${stockItem.id}`,
        });

        expect(result).toMatchObject({
          status: "reserved",
          stock: {
            id: stockItem.id,
            quantityReserved: stockItem.quantityReserved + 3,
          },
        });
      }
    } finally {
      await rollbackMikaInitialMigration(db);
      await database.destroy();
    }
  });

  it("replays reservation idempotency keys without double reserving stock", async () => {
    const database = createTransactionTestMikaDb();
    const { db } = database;
    const repository = new StockRepository(db);
    const service = createMikaStockLifecycleService(
      createIncrementingBackendDependencies({
        repositories: { ...createTestBackendRepositories(), stock: repository },
      }),
    );
    const stockItem = createStockRecord({
      quantityOnHand: 10,
      quantityReserved: 0,
    });

    try {
      await mikaInitialMigration.up(db);
      await repository.putItem(stockItem);

      const firstReservation = await service.reserve({
        stockItemId: stockItem.id,
        quantity: 3,
        expiresAt: createTestClock().isoAt(15 * 60_000),
        idempotencyKey: "reserve_replay_1",
      });
      expect(firstReservation).toMatchObject({
        status: "reserved",
        event: { id: "stock_event_1" },
        stock: { quantityReserved: 3 },
      });
      const replayedReservation = await service.reserve({
        stockItemId: stockItem.id,
        quantity: 3,
        expiresAt: createTestClock().isoAt(15 * 60_000),
        idempotencyKey: "reserve_replay_1",
      });
      expect(replayedReservation).toMatchObject({
        status: "replayed",
        event: { id: "stock_event_1" },
        stock: { quantityReserved: 3 },
      });
      if (firstReservation.status !== "reserved" || replayedReservation.status !== "replayed") {
        throw new Error("Expected first reservation to apply and second reservation to replay.");
      }
      expect(replayedReservation.event).toEqual(firstReservation.event);
      expect(replayedReservation.stock).toEqual(firstReservation.stock);
      await expect(repository.findBySellableId(stockItem.sellableId)).resolves.toMatchObject({
        quantityReserved: 3,
      });
      await expect(countStockEvents(db)).resolves.toBe(1);
    } finally {
      await rollbackMikaInitialMigration(db);
      await database.destroy();
    }
  });

  it("releases active reservation events once", async () => {
    const database = createTransactionTestMikaDb();
    const { db } = database;
    const repository = new StockRepository(db);
    const service = createMikaStockLifecycleService(
      createIncrementingBackendDependencies({
        repositories: { ...createTestBackendRepositories(), stock: repository },
      }),
    );
    const clock = createTestClock();
    const stockItem = createStockRecord({
      quantityOnHand: 10,
      quantityReserved: 0,
    });

    try {
      await mikaInitialMigration.up(db);
      await repository.putItem(stockItem);

      const reservation = await service.reserve({
        stockItemId: stockItem.id,
        quantity: 4,
        expiresAt: clock.isoAt(15 * 60_000),
        idempotencyKey: "release_once_1",
      });
      if (reservation.status !== "reserved") {
        throw new Error(`Expected reservation, received '${reservation.status}'.`);
      }

      await expect(
        service.release({
          reservationEventId: reservation.event.id,
          now: clock.isoAt(60_000),
        }),
      ).resolves.toMatchObject({
        status: "released",
        event: {
          id: "stock_event_1",
          status: "released",
          updatedAt: "2026-01-01T00:01:00.000Z",
        },
        stock: {
          quantityOnHand: 10,
          quantityReserved: 0,
        },
      });
      await expect(
        service.release({
          reservationEventId: reservation.event.id,
          now: clock.isoAt(120_000),
        }),
      ).resolves.toMatchObject({
        status: "not_active",
        event: {
          id: "stock_event_1",
          status: "released",
          updatedAt: "2026-01-01T00:01:00.000Z",
        },
        stock: {
          quantityOnHand: 10,
          quantityReserved: 0,
        },
      });
      await expect(repository.findEventById(reservation.event.id)).resolves.toMatchObject({
        status: "released",
      });
      await expect(countStockEvents(db)).resolves.toBe(1);
    } finally {
      await rollbackMikaInitialMigration(db);
      await database.destroy();
    }
  });

  it("consumes active reservation events once without negative quantities", async () => {
    const database = createTransactionTestMikaDb();
    const { db } = database;
    const repository = new StockRepository(db);
    const service = createMikaStockLifecycleService(
      createIncrementingBackendDependencies({
        repositories: { ...createTestBackendRepositories(), stock: repository },
      }),
    );
    const clock = createTestClock();
    const stockItem = createStockRecord({
      quantityOnHand: 2,
      quantityReserved: 0,
      allowBackorder: true,
    });

    try {
      await mikaInitialMigration.up(db);
      await repository.putItem(stockItem);

      const reservation = await service.reserve({
        stockItemId: stockItem.id,
        quantity: 4,
        expiresAt: clock.isoAt(15 * 60_000),
        idempotencyKey: "consume_once_1",
      });
      if (reservation.status !== "reserved") {
        throw new Error(`Expected reservation, received '${reservation.status}'.`);
      }

      await expect(
        service.consume({
          reservationEventId: reservation.event.id,
          orderId: createTestMikaId("order", 1),
          orderLineId: createTestMikaId("order_line", 1),
          now: clock.isoAt(60_000),
        }),
      ).resolves.toMatchObject({
        status: "consumed",
        event: {
          id: "stock_event_1",
          status: "consumed",
          orderId: "order_1",
          orderLineId: "order_line_1",
          updatedAt: "2026-01-01T00:01:00.000Z",
        },
        stock: {
          quantityOnHand: 0,
          quantityReserved: 0,
        },
      });
      await expect(
        service.consume({
          reservationEventId: reservation.event.id,
          now: clock.isoAt(120_000),
        }),
      ).resolves.toMatchObject({
        status: "not_active",
        event: {
          id: "stock_event_1",
          status: "consumed",
          orderId: "order_1",
          orderLineId: "order_line_1",
          updatedAt: "2026-01-01T00:01:00.000Z",
        },
        stock: {
          quantityOnHand: 0,
          quantityReserved: 0,
        },
      });
      await expect(repository.findBySellableId(stockItem.sellableId)).resolves.toMatchObject({
        quantityOnHand: 0,
        quantityReserved: 0,
      });
      await expect(countStockEvents(db)).resolves.toBe(1);
    } finally {
      await rollbackMikaInitialMigration(db);
      await database.destroy();
    }
  });

  it("treats already released or consumed reservations as non-active conflicts", async () => {
    const database = createTransactionTestMikaDb();
    const { db } = database;
    const repository = new StockRepository(db);
    const service = createMikaStockLifecycleService(
      createIncrementingBackendDependencies({
        repositories: { ...createTestBackendRepositories(), stock: repository },
      }),
    );
    const clock = createTestClock();
    const stockItem = createStockRecord({
      quantityOnHand: 10,
      quantityReserved: 0,
    });

    try {
      await mikaInitialMigration.up(db);
      await repository.putItem(stockItem);

      const releasedReservation = await service.reserve({
        stockItemId: stockItem.id,
        quantity: 2,
        expiresAt: clock.isoAt(15 * 60_000),
        idempotencyKey: "already_released_1",
      });
      const consumedReservation = await service.reserve({
        stockItemId: stockItem.id,
        quantity: 3,
        expiresAt: clock.isoAt(15 * 60_000),
        idempotencyKey: "already_consumed_1",
      });
      if (releasedReservation.status !== "reserved" || consumedReservation.status !== "reserved") {
        throw new Error("Expected stock reservations to be created.");
      }

      await expect(
        service.release({
          reservationEventId: releasedReservation.event.id,
          now: clock.isoAt(60_000),
        }),
      ).resolves.toMatchObject({
        status: "released",
        event: { status: "released" },
        stock: { quantityOnHand: 10, quantityReserved: 3 },
      });
      await expect(
        service.consume({
          reservationEventId: releasedReservation.event.id,
          now: clock.isoAt(120_000),
        }),
      ).resolves.toMatchObject({
        status: "not_active",
        event: {
          id: releasedReservation.event.id,
          status: "released",
          updatedAt: "2026-01-01T00:01:00.000Z",
        },
        stock: { quantityOnHand: 10, quantityReserved: 3 },
      });

      await expect(
        service.consume({
          reservationEventId: consumedReservation.event.id,
          now: clock.isoAt(180_000),
        }),
      ).resolves.toMatchObject({
        status: "consumed",
        event: { status: "consumed" },
        stock: { quantityOnHand: 7, quantityReserved: 0 },
      });
      await expect(
        service.release({
          reservationEventId: consumedReservation.event.id,
          now: clock.isoAt(240_000),
        }),
      ).resolves.toMatchObject({
        status: "not_active",
        event: {
          id: consumedReservation.event.id,
          status: "consumed",
          updatedAt: "2026-01-01T00:03:00.000Z",
        },
        stock: { quantityOnHand: 7, quantityReserved: 0 },
      });
      await expect(countStockEvents(db)).resolves.toBe(2);
    } finally {
      await rollbackMikaInitialMigration(db);
      await database.destroy();
    }
  });

  it("releases expired active reservations once and reports admin affected counts", async () => {
    const database = createTransactionTestMikaDb();
    const { db } = database;
    const repository = new StockRepository(db);
    const api = createMikaBackendApi(
      createIncrementingBackendDependencies({
        repositories: { ...createTestBackendRepositories(), stock: repository },
      }),
    );
    const service = createMikaStockLifecycleService(
      createIncrementingBackendDependencies({
        repositories: { ...createTestBackendRepositories(), stock: repository },
      }),
    );
    const clock = createTestClock();
    const stockItem = createStockRecord({
      quantityOnHand: 10,
      quantityReserved: 0,
    });

    try {
      await mikaInitialMigration.up(db);
      await repository.putItem(stockItem);

      const expiredReservation = await service.reserve({
        stockItemId: stockItem.id,
        quantity: 3,
        expiresAt: clock.isoAt(30_000),
        idempotencyKey: "release_expired_1",
      });
      const activeReservation = await service.reserve({
        stockItemId: stockItem.id,
        quantity: 2,
        expiresAt: clock.isoAt(15 * 60_000),
        idempotencyKey: "release_expired_2",
      });
      if (expiredReservation.status !== "reserved" || activeReservation.status !== "reserved") {
        throw new Error("Expected stock reservations to be created.");
      }

      await expect(
        api.admin.releaseExpiredReservations({ now: clock.isoAt(60_000) }),
      ).resolves.toMatchObject({
        ok: true,
        status: 200,
        data: {
          status: "completed",
          affected: {
            reservationsScanned: 1,
            reservationsReleased: 1,
            stockItems: 1,
          },
        },
      });
      await expect(repository.findEventById(expiredReservation.event.id)).resolves.toMatchObject({
        status: "expired",
        updatedAt: "2026-01-01T00:01:00.000Z",
      });
      await expect(repository.findEventById(activeReservation.event.id)).resolves.toMatchObject({
        status: "active",
      });
      await expect(repository.findBySellableId(stockItem.sellableId)).resolves.toMatchObject({
        quantityOnHand: 10,
        quantityReserved: 2,
      });
      await expect(
        api.admin.releaseExpiredReservations({ now: clock.isoAt(120_000) }),
      ).resolves.toMatchObject({
        ok: true,
        data: {
          affected: {
            reservationsScanned: 0,
            reservationsReleased: 0,
            stockItems: 0,
          },
        },
      });
    } finally {
      await rollbackMikaInitialMigration(db);
      await database.destroy();
    }
  });

  it("applies admin stock adjustment once and records movement audit metadata", async () => {
    const database = createTransactionTestMikaDb();
    const { db } = database;
    const repository = new StockRepository(db);
    const api = createMikaBackendApi(
      createIncrementingBackendDependencies({
        repositories: { ...createTestBackendRepositories(), stock: repository },
      }),
    );
    const stockItem = createStockRecord({
      quantityOnHand: 5,
      quantityReserved: 1,
    });

    try {
      await mikaInitialMigration.up(db);
      await repository.putItem(stockItem);

      const input = {
        stockItemId: stockItem.id,
        quantityDelta: 4,
        reason: "sync" as const,
        adminAuditId: createTestMikaId("admin_audit", 1),
        idempotencyKey: "stock_adjust_1",
        metadata: { source: "backend-test" },
      };

      await expect(api.admin.stockAdjust(input)).resolves.toMatchObject({
        ok: true,
        status: 200,
        data: {
          id: "stock_event_1",
          status: "completed",
          affected: {
            stockItems: 1,
            movements: 1,
          },
        },
      });
      await expect(repository.findBySellableId(stockItem.sellableId)).resolves.toMatchObject({
        quantityOnHand: 9,
        quantityReserved: 1,
      });
      await expect(repository.findEventByIdempotencyKey("stock_adjust_1")).resolves.toMatchObject({
        id: "stock_event_1",
        stockItemId: stockItem.id,
        kind: "movement",
        status: "recorded",
        reason: "sync",
        adminAuditId: "admin_audit_1",
        idempotencyKey: "stock_adjust_1",
        quantityDelta: 4,
        metadata: { source: "backend-test" },
      });

      await expect(api.admin.stockAdjust(input)).resolves.toMatchObject({
        ok: true,
        data: {
          id: "stock_event_1",
          status: "completed",
          affected: {
            stockItems: 0,
            movements: 0,
          },
        },
      });
      await expect(repository.findBySellableId(stockItem.sellableId)).resolves.toMatchObject({
        quantityOnHand: 9,
        quantityReserved: 1,
      });
      await expect(countStockEvents(db)).resolves.toBe(1);
    } finally {
      await rollbackMikaInitialMigration(db);
      await database.destroy();
    }
  });

  it("rejects admin stock adjustment conflicts with a stable public error", async () => {
    const database = createTransactionTestMikaDb();
    const { db } = database;
    const repository = new StockRepository(db);
    const api = createMikaBackendApi(
      createIncrementingBackendDependencies({
        repositories: { ...createTestBackendRepositories(), stock: repository },
      }),
    );
    const stockItem = createStockRecord({
      quantityOnHand: 5,
      quantityReserved: 1,
    });

    try {
      await mikaInitialMigration.up(db);
      await repository.putItem(stockItem);

      await expect(
        api.admin.stockAdjust({
          stockItemId: stockItem.id,
          quantityDelta: -6,
          idempotencyKey: "stock_adjust_conflict_1",
        }),
      ).resolves.toEqual({
        ok: false,
        status: 409,
        error: {
          code: "CONFLICT",
          message: `Stock adjustment for '${stockItem.id}' would make on-hand quantity negative.`,
        },
      });
      await expect(repository.findBySellableId(stockItem.sellableId)).resolves.toMatchObject({
        quantityOnHand: 5,
        quantityReserved: 1,
      });
      await expect(
        repository.findEventByIdempotencyKey("stock_adjust_conflict_1"),
      ).resolves.toBeNull();
      await expect(countStockEvents(db)).resolves.toBe(0);
    } finally {
      await rollbackMikaInitialMigration(db);
      await database.destroy();
    }
  });
});

describe("backend test provider helpers", () => {
  it("satisfies the provider adapter contract", () => {
    expectTypeOf(createFakeMikaProvider().provider).toEqualTypeOf<MikaProviderAdapter>();
  });

  it("creates successful hosted checkout sessions by default", async () => {
    const fake = createFakeMikaProvider();
    const input = createCheckoutInput();

    await expect(Promise.resolve(fake.provider.capabilities())).resolves.toEqual([
      "hosted_checkout",
    ]);
    await expect(fake.provider.createCheckoutSession(input)).resolves.toMatchObject({
      id: "checkout_fake",
      status: "created",
      mode: "payment",
      provider: "fake",
      redirectUrl: "https://checkout.example.test/session/checkout_fake",
      providerCheckoutId: "provider_checkout_fake",
    });
    expect(fake.getCalls().createCheckoutSession).toEqual([input]);
  });

  it("records checkout, portal, invoice, sync, webhook, subscription, refund, and order calls", async () => {
    const fake = createFakeMikaProvider({
      id: "stripe",
      capabilities: [
        "hosted_checkout",
        "portal",
        "invoice_url",
        "product_sync",
        "webhook_signatures",
        "subscription_cancel",
        "subscription_change",
        "subscription_renew",
        "refunds",
      ] satisfies readonly MikaProviderCapability[],
    });
    const checkoutInput = createCheckoutInput({ provider: createProviderName("stripe") });
    const portalInput = {
      providerCustomerId: "customer_1",
      returnUrl: "https://shop.example.test/account",
    };
    const invoiceInput = { orderId: createMikaId("order_1"), providerPaymentId: "payment_1" };
    const subscriptionInput = {
      subscriptionId: createMikaId("subscription_1"),
      providerSubscriptionId: "provider_subscription_1",
    };
    const refundInput = {
      orderId: createMikaId("order_1"),
      providerPaymentId: "payment_1",
      amount: 500,
    };
    const orderCancelInput = { orderId: createMikaId("order_1"), reason: "customer_request" };
    const syncInput = { mode: "dry_run" } as const;
    const webhookInput = createWebhookInput(createProviderName("stripe"));

    await fake.provider.createCheckoutSession(checkoutInput);
    await fake.provider.retrieveCheckoutSession("checkout_fake");
    await fake.provider.createPortalSession?.(portalInput);
    await fake.provider.getInvoiceUrl?.(invoiceInput);
    await fake.provider.syncCatalog?.(syncInput);
    const verifiedWebhook = await fake.provider.verifyWebhook?.(webhookInput);
    if (verifiedWebhook) {
      await fake.provider.parseWebhookEvent?.(verifiedWebhook);
    }
    await fake.provider.cancelSubscription?.(subscriptionInput);
    await fake.provider.changeSubscription?.(subscriptionInput);
    await fake.provider.renewSubscription?.(subscriptionInput);
    await fake.provider.refundPayment?.(refundInput);
    await fake.provider.cancelOrder?.(orderCancelInput);

    expect(fake.getCalls()).toMatchObject({
      createCheckoutSession: [checkoutInput],
      retrieveCheckoutSession: ["checkout_fake"],
      createPortalSession: [portalInput],
      getInvoiceUrl: [invoiceInput],
      syncCatalog: [syncInput],
      verifyWebhook: [webhookInput],
      parseWebhookEvent: [expect.objectContaining({ payloadHash: "fake-webhook-hash" })],
      cancelSubscription: [subscriptionInput],
      changeSubscription: [subscriptionInput],
      renewSubscription: [subscriptionInput],
      refundPayment: [refundInput],
      cancelOrder: [orderCancelInput],
    });
  });

  it("can omit optional provider methods for unsupported-path tests", async () => {
    const fake = createFakeMikaProvider({ optionalMethods: "none" });

    expect("createPortalSession" in fake.provider).toBe(false);
    expect("getInvoiceUrl" in fake.provider).toBe(false);
    expect("syncCatalog" in fake.provider).toBe(false);
    expect("verifyWebhook" in fake.provider).toBe(false);
    await expect(fake.provider.createCheckoutSession(createCheckoutInput())).resolves.toMatchObject(
      {
        status: "created",
      },
    );
  });
});

describe("backend API composition", () => {
  it("declares catalog and stock service error codes in the public contract", () => {
    expect(MIKA_ERROR_CODES).toEqual(
      expect.arrayContaining([
        "SELLABLE_NOT_FOUND",
        "VALIDATION_FAILED",
        "OUT_OF_STOCK",
        "CONFLICT",
      ]),
    );
  });

  it("keeps createMikaApi missing methods on the default NOT_IMPLEMENTED shell", async () => {
    const api = createMikaApi({
      catalog: {
        sellables: async () => ({ ok: true, status: 200, data: [] }),
      },
    });

    await expect(api.catalog.sellables({ contentRef: createTestContentRef() })).resolves.toEqual({
      ok: true,
      status: 200,
      data: [],
    });

    for (const [namespace, methods] of Object.entries(mikaApiMethodNames)) {
      const apiNamespace = api[namespace as keyof MikaApi] as Record<
        string,
        (...args: readonly unknown[]) => Promise<unknown>
      >;

      for (const method of methods) {
        const methodName = String(method);
        if (namespace === "catalog" && methodName === "sellables") continue;
        const apiMethod = apiNamespace[methodName];

        expect(apiMethod).toEqual(expect.any(Function));
        if (!apiMethod) {
          throw new Error(`Missing Mika API method '${namespace}.${methodName}'.`);
        }

        await expect(apiMethod(createTestRequestContext(), {})).resolves.toMatchObject({
          ok: false,
          status: 501,
          error: {
            code: "NOT_IMPLEMENTED",
            message: `Mika API '${namespace}.${methodName}' has not been wired yet.`,
          },
        });
      }
    }
  });

  it("defines injectable dependencies from backend test helpers", () => {
    const dependencies = createTestBackendDependencies();

    expectTypeOf(dependencies).toEqualTypeOf<CreateMikaBackendApiInput>();
    expectTypeOf(dependencies).toMatchTypeOf<MikaBackendDependencies>();
    expect(dependencies.providers.get(TEST_PROVIDER)?.id).toBe(TEST_PROVIDER);
    expect(dependencies.defaults).toEqual({
      currency: TEST_CURRENCY,
      locale: "en-IE",
      provider: TEST_PROVIDER,
    });
    expect(dependencies.now().toISOString()).toBe("2026-01-01T00:00:00.000Z");
    expect(dependencies.createId("checkout")).toBe("checkout_1");
    expect(dependencies.hash("checkout:1")).toBe(createTestHash("checkout:1"));
  });

  it("creates a complete Mika API with focused overrides and stub defaults", async () => {
    const contentRef = createTestContentRef();
    const sellable = createTestSellableDTO({ contentRef });
    const dependencies = createTestBackendDependencies({
      overrides: {
        catalog: {
          sellables: async (input) => ({
            ok: true,
            status: 200,
            data: input.contentRef.id === contentRef.id ? [sellable] : [],
          }),
        },
      },
    });
    const api = createMikaBackendApi(dependencies);

    expectTypeOf(api).toEqualTypeOf<MikaApi>();
    for (const [namespace, methods] of Object.entries(mikaApiMethodNames)) {
      const apiNamespace = api[namespace as keyof MikaApi] as Record<string, unknown>;

      for (const method of methods) {
        expect(apiNamespace[String(method)]).toEqual(expect.any(Function));
      }
    }
    await expect(api.catalog.sellables({ contentRef })).resolves.toMatchObject({
      ok: true,
      status: 200,
      data: [sellable],
    });
    await expect(
      api.stock.availability({ sellableId: createTestMikaId("sellable", 1) }),
    ).resolves.toMatchObject({
      ok: false,
      status: 404,
      error: {
        code: "SELLABLE_NOT_FOUND",
        message: "Sellable 'sellable_1' was not found.",
      },
    });
  });

  it("dispatches plugin routes through createMikaBackendApi without route key changes", async () => {
    const contentRef = createTestContentRef({ id: "route-product", locale: "de-AT" });
    const sellable = createSellableDefinition({ maxPerOrder: 4 });
    const repositories = createTestBackendRepositories({
      stockBySellableId: new Map([
        [
          sellable.id,
          createStockRecord({
            sellableId: sellable.id,
            quantityOnHand: 6,
            quantityReserved: 1,
          }),
        ],
      ]),
    });
    await repositories.catalog.put(
      createCatalogItemDocument({ contentRef, sellables: [sellable] }),
    );
    const api = createMikaBackendApi(createTestBackendDependencies({ repositories }));
    const routes = createMikaPluginRoutes(api);

    expect(mikaPluginRoutes.catalogSellables).toBe("catalog/sellables");
    expect(mikaPluginRoutes.sellableAvailability).toBe("sellables/availability");
    expect(routes[mikaPluginRoutes.catalogSellables]).toMatchObject({ public: true });
    expect(routes[mikaPluginRoutes.sellableAvailability]).toMatchObject({ public: true });
    await expect(
      routes[mikaPluginRoutes.catalogSellables].handler({
        input: {},
        request: new Request(
          "https://shop.example.test/_emdash/api/plugins/mika/catalog/sellables?collection=products&id=route-product&locale=de-AT",
        ),
      }),
    ).resolves.toMatchObject({
      ok: true,
      status: 200,
      data: [
        {
          id: sellable.id,
          contentRef,
          availability: {
            sellableId: sellable.id,
            status: "available",
            availableQuantity: 5,
            maxPerOrder: 4,
          },
        },
      ],
    });
    await expect(
      routes[mikaPluginRoutes.sellableAvailability].handler({
        input: {},
        request: new Request(
          `https://shop.example.test/_emdash/api/plugins/mika/sellables/availability?sellableId=${sellable.id}`,
        ),
      }),
    ).resolves.toMatchObject({
      ok: true,
      status: 200,
      data: {
        sellableId: sellable.id,
        status: "available",
        availableQuantity: 5,
      },
    });
  });

  it("rejects webhooks that fail provider verification", async () => {
    const opsCollection = createStorageCollection("ops");
    const repositories = {
      ...createTestBackendRepositories(),
      ops: new OpsRepository(opsCollection),
    };
    const fake = createFakeMikaProvider({
      id: TEST_PROVIDER,
      overrides: {
        verifyWebhook: async (webhookInput) => {
          expect(new URL(webhookInput.request.url).pathname).toBe("/bad-webhook-path");
          throw new Error("invalid webhook path");
        },
      },
    });
    const api = createMikaBackendApi(
      createTestBackendDependencies({
        repositories,
        providers: createMikaProviderRegistry([fake.provider]),
      }),
    );

    await expect(
      api.webhook.receive(
        createTestRequestContext({
          request: createWebhookRequest("{}", "/bad-webhook-path"),
          sessionId: false,
          customerId: false,
          userId: false,
          idempotencyKey: false,
        }),
        { provider: TEST_PROVIDER },
      ),
    ).resolves.toMatchObject({
      ok: false,
      status: 400,
      error: {
        code: "WEBHOOK_INVALID",
      },
    });
    expect(fake.getCalls()).toMatchObject({
      verifyWebhook: [expect.any(Object)],
      parseWebhookEvent: [],
    });
    await expect(opsCollection.count({ type: "webhook" })).resolves.toBe(0);
  });

  it("preserves raw body bytes when dispatching webhook routes", async () => {
    const rawBody = '{"event":"route.raw"}';
    const fake = createFakeMikaProvider({
      id: TEST_PROVIDER,
      overrides: {
        verifyWebhook: async (webhookInput) => {
          expect(new TextDecoder().decode(webhookInput.rawBody)).toBe(rawBody);
          return createVerifiedWebhookPayload(webhookInput, {
            payloadHash: "route_hash_1",
            parsed: { event: "route.raw" },
          });
        },
        parseWebhookEvent: async (verified) =>
          createWebhookEvent(verified, {
            providerEventId: "event_route_1",
            type: "route.raw",
          }),
      },
    });
    const api = createMikaBackendApi(
      createTestBackendDependencies({
        providers: createMikaProviderRegistry([fake.provider]),
      }),
    );
    const routes = createMikaPluginRoutes(api);

    await expect(
      routes[mikaPluginRoutes.webhook].handler({
        input: { provider: TEST_PROVIDER },
        request: createWebhookRequest(rawBody),
      }),
    ).resolves.toMatchObject({
      ok: true,
      status: 200,
      data: {
        id: "webhook_1",
        status: "received",
      },
    });
  });

  it("stores accepted webhooks and deduplicates by provider event id or payload hash", async () => {
    const opsCollection = createStorageCollection("ops");
    const repositories = {
      ...createTestBackendRepositories(),
      ops: new OpsRepository(opsCollection),
    };
    const payloadHashes = ["hash_1", "hash_2", "hash_1"];
    const providerEventIds = ["event_1", "event_1", "event_2"];
    const eventTypes = ["payment.completed", "payment.completed", "invoice.paid"];
    const fake = createFakeMikaProvider({
      id: TEST_PROVIDER,
      overrides: {
        verifyWebhook: async (webhookInput) => {
          const payloadHash = payloadHashes.shift();
          if (!payloadHash) throw new Error("Unexpected webhook verification call.");

          return createVerifiedWebhookPayload(webhookInput, {
            payloadHash,
            parsed: { payloadHash },
          });
        },
        parseWebhookEvent: async (verified) => {
          const providerEventId = providerEventIds.shift();
          const eventType = eventTypes.shift();
          if (!providerEventId) throw new Error("Unexpected webhook parse call.");
          if (!eventType) throw new Error("Unexpected webhook event type.");

          return createWebhookEvent(verified, {
            providerEventId,
            type: eventType,
          });
        },
      },
    });
    const api = createMikaBackendApi(
      createIncrementingBackendDependencies({
        repositories,
        providers: createMikaProviderRegistry([fake.provider]),
      }),
    );

    await expect(receiveWebhook(api, "first")).resolves.toMatchObject({
      ok: true,
      status: 200,
      data: {
        id: "webhook_1",
        status: "received",
        replayable: true,
      },
    });
    await expect(receiveWebhook(api, "same-event-id")).resolves.toMatchObject({
      ok: true,
      status: 200,
      data: {
        id: "webhook_1",
        status: "duplicate",
      },
    });
    await expect(receiveWebhook(api, "same-payload-hash")).resolves.toMatchObject({
      ok: true,
      status: 200,
      data: {
        id: "webhook_1",
        status: "duplicate",
      },
    });

    await expect(opsCollection.count({ type: "webhook" })).resolves.toBe(1);
    await expect(
      repositories.ops.findWebhookDuplicate({
        provider: TEST_PROVIDER,
        providerEventId: "event_1",
        eventType: "payment.completed",
        payloadHash: "hash_1",
      }),
    ).resolves.toMatchObject({
      id: "webhook_1",
      status: "received",
      record: {
        provider: TEST_PROVIDER,
        providerEventId: "event_1",
        eventType: "payment.completed",
        payloadHash: "hash_1",
        status: "received",
        attemptCount: 0,
        receivedAt: TEST_NOW,
        rawPayloadJson: { payloadHash: "hash_1" },
      },
    });
    expect(fake.getCalls()).toMatchObject({
      verifyWebhook: [expect.any(Object), expect.any(Object), expect.any(Object)],
      parseWebhookEvent: [expect.any(Object), expect.any(Object), expect.any(Object)],
    });
  });

  it("creates one paid order from replayed payment webhook events", async () => {
    const stripe = createProviderName("stripe");
    const sessionCollection = createStorageCollection("session");
    const ledgerCollection = createStorageCollection("ledger");
    const opsCollection = createStorageCollection("ops");
    const repositories = {
      ...createTestBackendRepositories(),
      session: new SessionRepository(sessionCollection),
      ledger: new LedgerRepository(ledgerCollection),
      ops: new OpsRepository(opsCollection),
    };
    const sellable = createSellableDefinition({
      prices: [
        createPriceDefinition({
          providerRefs: [{ provider: stripe, productId: "prod_payment", priceId: "price_payment" }],
        }),
      ],
    });
    const webhookDeliveries = [
      { payloadHash: "payment_hash_1", providerEventId: "event_payment_1" },
      { payloadHash: "payment_hash_2", providerEventId: "event_payment_2" },
    ];
    const fake = createFakeMikaProvider({
      id: stripe,
      overrides: {
        verifyWebhook: async (webhookInput) => {
          const delivery = webhookDeliveries[0];
          if (!delivery) throw new Error("Unexpected webhook verification call.");

          return createVerifiedWebhookPayload(webhookInput, {
            payloadHash: delivery.payloadHash,
            parsed: { delivery: delivery.providerEventId },
          });
        },
        parseWebhookEvent: async (verified) => {
          const delivery = webhookDeliveries.shift();
          if (!delivery) throw new Error("Unexpected webhook parse call.");

          return createPaymentWebhookEvent(verified, {
            providerEventId: delivery.providerEventId,
            providerCheckoutId: "provider_checkout_fake",
            providerPaymentId: "payment_1",
            providerOrderId: "provider_order_1",
            invoiceUrl: "https://invoice.example.test/payment_1",
            customer: { email: "Shopper@Example.test", name: "Shopper One" },
          });
        },
      },
    });
    await repositories.catalog.put(
      createCatalogItemDocument({ contentRef: createTestContentRef(), sellables: [sellable] }),
    );
    const api = createMikaBackendApi(
      createIncrementingBackendDependencies({
        repositories,
        providers: createMikaProviderRegistry([fake.provider]),
      }),
    );
    const shopperCtx = createTestRequestContext({
      sessionId: "session_payment",
      customerId: createTestMikaId("customer", 1),
      userId: "user_payment",
      idempotencyKey: "checkout_payment_1",
    });

    const cart = await api.cart.add(shopperCtx, { sellableId: sellable.id, quantity: 2 });
    if (!cart.ok) {
      throw new Error("Expected cart.add to succeed.");
    }
    const checkout = await api.checkout.start(shopperCtx, {
      cartId: cart.data.id,
      provider: stripe,
    });
    if (!checkout.ok) {
      throw new Error("Expected checkout.start to succeed.");
    }

    await expect(receiveWebhook(api, "payment-first", stripe)).resolves.toMatchObject({
      ok: true,
      status: 200,
      data: {
        id: "webhook_1",
        status: "received",
        replayable: true,
      },
    });
    await expect(receiveWebhook(api, "payment-replay", stripe)).resolves.toMatchObject({
      ok: true,
      status: 200,
      data: {
        id: "webhook_2",
        status: "received",
        replayable: true,
      },
    });

    await expect(ledgerCollection.count({ type: "order" })).resolves.toBe(1);
    await expect(
      repositories.ledger.findOrderByProviderPayment(stripe, "payment_1"),
    ).resolves.toMatchObject({
      id: "order_1",
      provider: "stripe",
      providerCheckoutId: "provider_checkout_fake",
      providerPaymentId: "payment_1",
      providerOrderId: "provider_order_1",
      checkoutSessionId: "checkout_1",
      status: "paid",
      paymentStatus: "paid",
      currency: TEST_CURRENCY,
      totalAmount: 2400,
      paidAt: TEST_NOW,
      aggregate: {
        customer: {
          customerId: "customer_1",
          email: "Shopper@Example.test",
          emailHash: createTestHash("email:shopper@example.test"),
        },
        invoiceUrl: "https://invoice.example.test/payment_1",
        lines: [
          {
            id: "order_line_1",
            quantity: 2,
            totalAmount: 2400,
          },
        ],
        providerRefs: [
          {
            provider: "stripe",
            checkoutId: "provider_checkout_fake",
            paymentId: "payment_1",
            orderId: "provider_order_1",
          },
        ],
      },
    });
    await expect(
      repositories.session.findById(createTestMikaId("checkout", 1)),
    ).resolves.toMatchObject({
      type: "checkout",
      status: "completed",
      aggregate: {
        metadata: {
          checkoutOrderId: "order_1",
          checkoutProviderStatus: "completed",
          providerPaymentId: "payment_1",
          providerOrderId: "provider_order_1",
        },
      },
    });
    await expect(repositories.session.findById(cart.data.id)).resolves.toMatchObject({
      type: "cart",
      status: "converted",
      aggregate: { metadata: { checkoutSessionId: "checkout_1", checkoutOrderId: "order_1" } },
    });
    await expect(opsCollection.get("webhook_1")).resolves.toMatchObject({
      status: "processed",
      record: { status: "processed", relatedOrderId: "order_1" },
    });
    await expect(opsCollection.get("webhook_2")).resolves.toMatchObject({
      status: "processed",
      record: { status: "processed", relatedOrderId: "order_1" },
    });
  });

  it("creates fulfillment side effects once from replayed payment webhook events", async () => {
    const stripe = createProviderName("stripe");
    const accountCollection = createStorageCollection("account");
    const sessionCollection = createStorageCollection("session");
    const ledgerCollection = createStorageCollection("ledger");
    const opsCollection = createStorageCollection("ops");
    const entitlementSellable = createSellableDefinition({
      id: createTestMikaId("sellable", 1),
      prices: [
        createPriceDefinition({
          id: createTestMikaId("price", 1),
          fulfillmentKind: "entitlement",
          entitlementKey: "course:test-product",
          providerRefs: [{ provider: stripe, productId: "prod_ent", priceId: "price_ent" }],
        }),
      ],
    });
    const licenseSellable = createSellableDefinition({
      id: createTestMikaId("sellable", 2),
      prices: [
        createPriceDefinition({
          id: createTestMikaId("price", 2),
          fulfillmentKind: "license",
          providerRefs: [{ provider: stripe, productId: "prod_license", priceId: "price_license" }],
        }),
      ],
    });
    const downloadSellable = createSellableDefinition({
      id: createTestMikaId("sellable", 3),
      prices: [
        createPriceDefinition({
          id: createTestMikaId("price", 3),
          fulfillmentKind: "download",
          providerRefs: [
            { provider: stripe, productId: "prod_download", priceId: "price_download" },
          ],
        }),
      ],
    });
    const stockRepository = createTestStockRepository(
      new Map([
        [
          entitlementSellable.id,
          createStockRecord({
            id: createTestMikaId("stock", 1),
            sellableId: entitlementSellable.id,
            quantityOnHand: 5,
            quantityReserved: 0,
          }),
        ],
        [
          licenseSellable.id,
          createStockRecord({
            id: createTestMikaId("stock", 2),
            sellableId: licenseSellable.id,
            quantityOnHand: 5,
            quantityReserved: 0,
          }),
        ],
        [
          downloadSellable.id,
          createStockRecord({
            id: createTestMikaId("stock", 3),
            sellableId: downloadSellable.id,
            quantityOnHand: 5,
            quantityReserved: 0,
          }),
        ],
      ]),
    );
    const repositories = {
      ...createTestBackendRepositories(),
      account: new AccountRepository(accountCollection),
      session: new SessionRepository(sessionCollection),
      ledger: new LedgerRepository(ledgerCollection),
      ops: new OpsRepository(opsCollection),
      stock: stockRepository,
    };
    const webhookDeliveries = [
      { payloadHash: "fulfillment_hash_1", providerEventId: "event_fulfillment_1" },
      { payloadHash: "fulfillment_hash_2", providerEventId: "event_fulfillment_2" },
    ];
    const fake = createFakeMikaProvider({
      id: stripe,
      overrides: {
        verifyWebhook: async (webhookInput) => {
          const delivery = webhookDeliveries[0];
          if (!delivery) throw new Error("Unexpected webhook verification call.");

          return createVerifiedWebhookPayload(webhookInput, {
            payloadHash: delivery.payloadHash,
            parsed: { delivery: delivery.providerEventId },
          });
        },
        parseWebhookEvent: async (verified) => {
          const delivery = webhookDeliveries.shift();
          if (!delivery) throw new Error("Unexpected webhook parse call.");

          return createPaymentWebhookEvent(verified, {
            providerEventId: delivery.providerEventId,
            providerCheckoutId: "provider_checkout_fake",
            providerPaymentId: "payment_fulfillment_1",
            providerOrderId: "provider_order_fulfillment_1",
            customer: { email: "Fulfillment@Example.test", name: "Fulfillment Shopper" },
          });
        },
      },
    });
    await repositories.catalog.put(
      createCatalogItemDocument({
        contentRef: createTestContentRef(),
        sellables: [entitlementSellable, licenseSellable, downloadSellable],
      }),
    );
    const api = createMikaBackendApi(
      createIncrementingBackendDependencies({
        repositories,
        providers: createMikaProviderRegistry([fake.provider]),
      }),
    );
    const shopperCtx = createTestRequestContext({
      sessionId: "session_fulfillment",
      customerId: createTestMikaId("customer", 1),
      userId: "user_fulfillment",
      idempotencyKey: "checkout_fulfillment_1",
    });

    const firstCart = await api.cart.add(shopperCtx, {
      sellableId: entitlementSellable.id,
      quantity: 1,
    });
    if (!firstCart.ok) throw new Error("Expected first cart.add to succeed.");
    const secondCart = await api.cart.add(shopperCtx, {
      sellableId: licenseSellable.id,
      quantity: 1,
    });
    if (!secondCart.ok) throw new Error("Expected second cart.add to succeed.");
    const cart = await api.cart.add(shopperCtx, {
      sellableId: downloadSellable.id,
      quantity: 1,
    });
    if (!cart.ok) throw new Error("Expected third cart.add to succeed.");
    const checkout = await api.checkout.start(shopperCtx, {
      cartId: cart.data.id,
      provider: stripe,
    });
    if (!checkout.ok) throw new Error("Expected checkout.start to succeed.");

    await expect(receiveWebhook(api, "fulfillment-first", stripe)).resolves.toMatchObject({
      ok: true,
      status: 200,
      data: { id: "webhook_1", status: "received" },
    });
    await expect(receiveWebhook(api, "fulfillment-replay", stripe)).resolves.toMatchObject({
      ok: true,
      status: 200,
      data: { id: "webhook_2", status: "received" },
    });

    await expect(ledgerCollection.count({ type: "order" })).resolves.toBe(1);
    await expect(accountCollection.count({ type: "entitlement" })).resolves.toBe(1);
    await expect(accountCollection.count({ type: "license" })).resolves.toBe(1);
    await expect(opsCollection.count({ type: "email" })).resolves.toBe(1);
    await expect(accountCollection.get("entitlement_order_1_order_line_1")).resolves.toMatchObject({
      type: "entitlement",
      customerId: "customer_1",
      entitlementKey: "course:test-product",
      status: "active",
      record: {
        orderId: "order_1",
        sellableId: entitlementSellable.id,
      },
    });
    await expect(accountCollection.get("license_order_1_order_line_2")).resolves.toMatchObject({
      type: "license",
      customerId: "customer_1",
      orderId: "order_1",
      orderLineId: "order_line_2",
      status: "active",
      record: {
        status: "active",
        displayKeySuffix: expect.any(String),
      },
    });
    await expect(opsCollection.get("email_order_1_order_confirmation")).resolves.toMatchObject({
      type: "email",
      status: "queued",
      orderId: "order_1",
      kind: "order_confirmation",
      record: {
        toEmail: "Fulfillment@Example.test",
        status: "queued",
        attemptCount: 0,
        idempotencyKey: "order-confirmation:order_1",
      },
    });
    await expect(
      repositories.ledger.findOrderByProviderPayment(stripe, "payment_fulfillment_1"),
    ).resolves.toMatchObject({
      id: "order_1",
      aggregate: {
        lines: [
          {
            id: "order_line_1",
            entitlementId: "entitlement_order_1_order_line_1",
            stockMovementId: "stock_event_1",
          },
          {
            id: "order_line_2",
            licenseKeySuffix: expect.any(String),
            stockMovementId: "stock_event_2",
          },
          {
            id: "order_line_3",
            downloadRefs: ["download:order_1:order_line_3"],
            stockMovementId: "stock_event_3",
          },
        ],
      },
    });
    await expect(
      stockRepository.findEventById(createTestMikaId("stock_event", 1)),
    ).resolves.toMatchObject({
      status: "consumed",
      orderId: "order_1",
      orderLineId: "order_line_1",
    });
    await expect(
      stockRepository.findEventById(createTestMikaId("stock_event", 2)),
    ).resolves.toMatchObject({
      status: "consumed",
      orderId: "order_1",
      orderLineId: "order_line_2",
    });
    await expect(
      stockRepository.findEventById(createTestMikaId("stock_event", 3)),
    ).resolves.toMatchObject({
      status: "consumed",
      orderId: "order_1",
      orderLineId: "order_line_3",
    });
    await expect(stockRepository.findBySellableId(entitlementSellable.id)).resolves.toMatchObject({
      quantityOnHand: 4,
      quantityReserved: 0,
    });
    await expect(stockRepository.findBySellableId(licenseSellable.id)).resolves.toMatchObject({
      quantityOnHand: 4,
      quantityReserved: 0,
    });
    await expect(stockRepository.findBySellableId(downloadSellable.id)).resolves.toMatchObject({
      quantityOnHand: 4,
      quantityReserved: 0,
    });
  });

  it("recovers payment webhook processing when a concurrent order insert wins", async () => {
    const stripe = createProviderName("stripe");
    const sessionCollection = createStorageCollection("session");
    const ledgerCollection = createStorageCollection("ledger");
    const opsCollection = createStorageCollection("ops");
    const baseLedger = new LedgerRepository(ledgerCollection);
    let concurrentOrder: OrderDocument | null = null;
    let createPutAttempts = 0;
    const racingLedger: MikaBackendRepositories["ledger"] = {
      findOrderById: (orderId) => baseLedger.findOrderById(orderId),
      findOrderByNumber: (orderNumber) => baseLedger.findOrderByNumber(orderNumber),
      findOrderByProviderPayment: async (provider, providerPaymentId) =>
        concurrentOrder?.provider === provider &&
        concurrentOrder.providerPaymentId === providerPaymentId
          ? concurrentOrder
          : baseLedger.findOrderByProviderPayment(provider, providerPaymentId),
      findOrderByProviderCheckout: async (provider, providerCheckoutId) =>
        concurrentOrder?.provider === provider &&
        concurrentOrder.providerCheckoutId === providerCheckoutId
          ? concurrentOrder
          : baseLedger.findOrderByProviderCheckout(provider, providerCheckoutId),
      findOrderByProviderOrder: async (provider, providerOrderId) =>
        concurrentOrder?.provider === provider &&
        concurrentOrder.providerOrderId === providerOrderId
          ? concurrentOrder
          : baseLedger.findOrderByProviderOrder(provider, providerOrderId),
      findOrderByCheckoutSession: async (checkoutSessionId) =>
        concurrentOrder?.checkoutSessionId === checkoutSessionId
          ? concurrentOrder
          : baseLedger.findOrderByCheckoutSession(checkoutSessionId),
      listOrdersByCustomer: (customerId, limit) =>
        baseLedger.listOrdersByCustomer(customerId, limit),
      put: async (document) => {
        if (
          document.type === "order" &&
          document.providerPaymentId === "payment_race" &&
          !concurrentOrder
        ) {
          createPutAttempts += 1;
          concurrentOrder = {
            ...document,
            id: createTestMikaId("order", 99),
            orderNumber: "order_99",
          };
          await baseLedger.put(concurrentOrder);
          throw new Error("unique constraint failed: provider payment id");
        }

        await baseLedger.put(document);
      },
    };
    const repositories = {
      ...createTestBackendRepositories(),
      session: new SessionRepository(sessionCollection),
      ledger: racingLedger,
      ops: new OpsRepository(opsCollection),
    };
    const sellable = createSellableDefinition();
    const fake = createFakeMikaProvider({
      id: stripe,
      overrides: {
        verifyWebhook: async (webhookInput) =>
          createVerifiedWebhookPayload(webhookInput, {
            payloadHash: "payment_race_hash",
            parsed: { delivery: "payment_race" },
          }),
        parseWebhookEvent: async (verified) =>
          createPaymentWebhookEvent(verified, {
            providerEventId: "event_payment_race",
            providerCheckoutId: "provider_checkout_fake",
            providerPaymentId: "payment_race",
            providerOrderId: "provider_order_race",
          }),
      },
    });
    await repositories.catalog.put(
      createCatalogItemDocument({ contentRef: createTestContentRef(), sellables: [sellable] }),
    );
    const api = createMikaBackendApi(
      createIncrementingBackendDependencies({
        repositories,
        providers: createMikaProviderRegistry([fake.provider]),
      }),
    );
    const shopperCtx = createTestRequestContext({
      sessionId: "session_payment_race",
      customerId: createTestMikaId("customer", 1),
      userId: "user_payment_race",
      idempotencyKey: "checkout_payment_race",
    });

    const cart = await api.cart.add(shopperCtx, { sellableId: sellable.id, quantity: 1 });
    if (!cart.ok) {
      throw new Error("Expected cart.add to succeed.");
    }
    const checkout = await api.checkout.start(shopperCtx, {
      cartId: cart.data.id,
      provider: stripe,
    });
    if (!checkout.ok) {
      throw new Error("Expected checkout.start to succeed.");
    }

    await expect(receiveWebhook(api, "payment-race", stripe)).resolves.toMatchObject({
      ok: true,
      status: 200,
      data: {
        id: "webhook_1",
        status: "received",
        replayable: true,
      },
    });

    expect(createPutAttempts).toBe(1);
    await expect(ledgerCollection.count({ type: "order" })).resolves.toBe(1);
    await expect(
      baseLedger.findOrderByProviderPayment(stripe, "payment_race"),
    ).resolves.toMatchObject({
      id: "order_99",
      providerPaymentId: "payment_race",
      providerOrderId: "provider_order_race",
      checkoutSessionId: "checkout_1",
      status: "paid",
      paymentStatus: "paid",
      aggregate: {
        lines: [{ id: "order_line_1", quantity: 1 }],
        metadata: {
          providerEventId: "event_payment_race",
          providerPaymentId: "payment_race",
          providerOrderId: "provider_order_race",
        },
      },
    });
    await expect(
      repositories.session.findById(createTestMikaId("checkout", 1)),
    ).resolves.toMatchObject({
      type: "checkout",
      status: "completed",
      aggregate: { metadata: { checkoutOrderId: "order_99" } },
    });
    await expect(opsCollection.get("webhook_1")).resolves.toMatchObject({
      status: "processed",
      record: { status: "processed", relatedOrderId: "order_99" },
    });
  });

  it("updates subscription status, periods, and entitlement from webhook events", async () => {
    const stripe = createProviderName("stripe");
    const accountCollection = createStorageCollection("account");
    const opsCollection = createStorageCollection("ops");
    const subscriptionSellable = createSellableDefinition({
      prices: [
        createPriceDefinition({
          id: createTestMikaId("price", 1),
          mode: "subscription",
          fulfillmentKind: "entitlement",
          entitlementKey: "course:subscription-product",
          providerRefs: [{ provider: stripe, productId: "prod_sub", priceId: "price_sub" }],
        }),
      ],
    });
    const repositories = {
      ...createTestBackendRepositories(),
      account: new AccountRepository(accountCollection),
      ops: new OpsRepository(opsCollection),
    };
    const deliveries = [
      {
        payloadHash: "subscription_hash_1",
        providerEventId: "event_subscription_1",
        status: "active" as const,
        currentPeriodStart: createISODateTime("2026-01-01T00:00:00.000Z"),
        currentPeriodEnd: createISODateTime("2026-02-01T00:00:00.000Z"),
      },
      {
        payloadHash: "subscription_hash_2",
        providerEventId: "event_subscription_2",
        status: "cancel_at_period_end" as const,
        currentPeriodStart: createISODateTime("2026-02-01T00:00:00.000Z"),
        currentPeriodEnd: createISODateTime("2026-03-01T00:00:00.000Z"),
        cancelAtPeriodEnd: true,
      },
      {
        payloadHash: "subscription_hash_2",
        providerEventId: "event_subscription_2",
        status: "cancel_at_period_end" as const,
        currentPeriodStart: createISODateTime("2026-02-01T00:00:00.000Z"),
        currentPeriodEnd: createISODateTime("2026-03-01T00:00:00.000Z"),
        cancelAtPeriodEnd: true,
      },
    ];
    const fake = createFakeMikaProvider({
      id: stripe,
      overrides: {
        verifyWebhook: async (webhookInput) => {
          const delivery = deliveries[0];
          if (!delivery) throw new Error("Unexpected webhook verification call.");

          return createVerifiedWebhookPayload(webhookInput, {
            payloadHash: delivery.payloadHash,
            parsed: { delivery: delivery.providerEventId },
          });
        },
        parseWebhookEvent: async (verified) => {
          const delivery = deliveries.shift();
          if (!delivery) throw new Error("Unexpected webhook parse call.");

          return createSubscriptionWebhookEvent(verified, {
            providerEventId: delivery.providerEventId,
            providerSubscriptionId: "provider_subscription_1",
            providerCustomerId: "provider_customer_1",
            providerPriceId: "price_sub",
            status: delivery.status,
            currentPeriodStart: delivery.currentPeriodStart,
            currentPeriodEnd: delivery.currentPeriodEnd,
            cancelAtPeriodEnd: delivery.cancelAtPeriodEnd,
          });
        },
      },
    });
    await repositories.catalog.put(
      createCatalogItemDocument({
        contentRef: createTestContentRef(),
        sellables: [subscriptionSellable],
      }),
    );
    await repositories.account.put(createCustomerDocument());
    await repositories.account.put(createProviderAccountDocument({ provider: stripe }));
    const api = createMikaBackendApi(
      createIncrementingBackendDependencies({
        repositories,
        providers: createMikaProviderRegistry([fake.provider]),
      }),
    );

    await expect(receiveWebhook(api, "subscription-active", stripe)).resolves.toMatchObject({
      ok: true,
      status: 200,
      data: { id: "webhook_1", status: "received" },
    });
    await expect(receiveWebhook(api, "subscription-updated", stripe)).resolves.toMatchObject({
      ok: true,
      status: 200,
      data: { id: "webhook_2", status: "received" },
    });
    await expect(receiveWebhook(api, "subscription-duplicate", stripe)).resolves.toMatchObject({
      ok: true,
      status: 200,
      data: { id: "webhook_2", status: "duplicate" },
    });

    await expect(accountCollection.count({ type: "subscription" })).resolves.toBe(1);
    await expect(accountCollection.count({ type: "entitlement" })).resolves.toBe(1);
    await expect(accountCollection.get("subscription_1")).resolves.toMatchObject({
      type: "subscription",
      customerId: "customer_1",
      provider: "stripe",
      providerCustomerId: "provider_customer_1",
      providerSubscriptionId: "provider_subscription_1",
      status: "cancel_at_period_end",
      currentPeriodEnd: "2026-03-01T00:00:00.000Z",
      aggregate: {
        status: "cancel_at_period_end",
        cancelAtPeriodEnd: true,
        currentPeriodStart: "2026-02-01T00:00:00.000Z",
        currentPeriodEnd: "2026-03-01T00:00:00.000Z",
        entitlementId: "entitlement_subscription_1_subscription",
        providerRef: {
          provider: "stripe",
          subscriptionId: "provider_subscription_1",
          customerId: "provider_customer_1",
          priceId: "price_sub",
        },
      },
    });
    await expect(
      accountCollection.get("entitlement_subscription_1_subscription"),
    ).resolves.toMatchObject({
      type: "entitlement",
      customerId: "customer_1",
      entitlementKey: "course:subscription-product",
      status: "active",
      subscriptionId: "subscription_1",
      record: {
        subscriptionId: "subscription_1",
        sourceStatus: "cancel_at_period_end",
        currentPeriodEnd: "2026-03-01T00:00:00.000Z",
      },
    });
    await expect(opsCollection.get("webhook_2")).resolves.toMatchObject({
      status: "processed",
      record: {
        status: "processed",
        relatedCustomerId: "customer_1",
        relatedSubscriptionId: "subscription_1",
      },
    });
    await expect(opsCollection.count({ type: "webhook" })).resolves.toBe(2);
  });

  it("fails subscription webhook processing with a stable error for unknown targets", async () => {
    const stripe = createProviderName("stripe");
    const accountCollection = createStorageCollection("account");
    const opsCollection = createStorageCollection("ops");
    const repositories = {
      ...createTestBackendRepositories(),
      account: new AccountRepository(accountCollection),
      ops: new OpsRepository(opsCollection),
    };
    const fake = createFakeMikaProvider({
      id: stripe,
      overrides: {
        verifyWebhook: async (webhookInput) =>
          createVerifiedWebhookPayload(webhookInput, {
            payloadHash: "subscription_unknown_hash",
            parsed: { delivery: "event_subscription_unknown" },
          }),
        parseWebhookEvent: async (verified) =>
          createSubscriptionWebhookEvent(verified, {
            providerEventId: "event_subscription_unknown",
            providerSubscriptionId: "provider_subscription_unknown",
            providerCustomerId: "provider_customer_unknown",
            providerPriceId: "price_unknown",
            status: "active",
          }),
      },
    });
    const api = createMikaBackendApi(
      createIncrementingBackendDependencies({
        repositories,
        providers: createMikaProviderRegistry([fake.provider]),
      }),
    );

    await expect(receiveWebhook(api, "subscription-unknown", stripe)).resolves.toMatchObject({
      ok: true,
      status: 200,
      data: { id: "webhook_1", status: "failed", replayable: true },
    });

    await expect(accountCollection.count({ type: "subscription" })).resolves.toBe(0);
    await expect(accountCollection.count({ type: "entitlement" })).resolves.toBe(0);
    await expect(opsCollection.get("webhook_1")).resolves.toMatchObject({
      status: "failed",
      record: {
        status: "failed",
        lastError: "Subscription event could not be linked to a subscription.",
      },
    });
  });

  it("keeps catalog and stock validation failures in the route layer", async () => {
    const api = createMikaApi({
      catalog: {
        sellables: async () => {
          throw new Error("catalog.sellables should not run for invalid route input.");
        },
      },
      stock: {
        availability: async () => {
          throw new Error("stock.availability should not run for invalid route input.");
        },
      },
    });
    const routes = createMikaPluginRoutes(api);

    await expect(
      routes[mikaPluginRoutes.catalogSellables].handler({
        input: {},
        request: new Request(
          "https://shop.example.test/_emdash/api/plugins/mika/catalog/sellables?collection=products",
        ),
      }),
    ).resolves.toMatchObject({
      ok: false,
      status: 422,
      error: {
        code: "VALIDATION_FAILED",
        message: "Mika input validation failed.",
        fieldErrors: {
          id: expect.any(String),
        },
      },
    });
    await expect(
      routes[mikaPluginRoutes.sellableAvailability].handler({
        input: {},
        request: new Request(
          "https://shop.example.test/_emdash/api/plugins/mika/sellables/availability",
        ),
      }),
    ).resolves.toMatchObject({
      ok: false,
      status: 422,
      error: {
        code: "VALIDATION_FAILED",
        message: "Mika input validation failed.",
        fieldErrors: {
          sellableId: expect.any(String),
        },
      },
    });
  });

  it("runs action-bound cart and wishlist operations against the request-bound backend API", async () => {
    const contentRef = createTestContentRef();
    const sellable = createSellableDefinition({ maxPerOrder: 5 });
    const repositories = createTestBackendRepositories();
    await repositories.catalog.put(
      createCatalogItemDocument({ contentRef, sellables: [sellable] }),
    );
    const api = createMikaBackendApi(createIncrementingBackendDependencies({ repositories }));
    const ctx = createTestRequestContext({
      method: "POST",
      sessionId: "session_action_backend",
      customerId: false,
      userId: false,
    });

    const added = await callMikaOperation<CartDTO>(
      mikaActionDefinitions.cartAdd.operation,
      api,
      ctx,
      {
        sellableId: sellable.id,
        priceId: createTestMikaId("price", 1),
        quantity: 2,
      },
    );
    expect(added).toMatchObject({
      ok: true,
      status: 200,
      data: {
        id: "cart_1",
        items: [{ sellableId: sellable.id, priceId: "price_1", quantity: 2 }],
        total: { amount: 2400 },
      },
    });
    if (!added.ok) {
      throw new Error("Expected action-bound cart operation to return a cart DTO.");
    }

    const saved = await callMikaOperation(
      mikaActionDefinitions.wishlistSaveForLater.operation,
      api,
      ctx,
      {
        lineId: added.data.items[0]!.id,
      },
    );
    expect(saved).toMatchObject({
      ok: true,
      status: 200,
      data: {
        id: "wishlist_1",
        items: [{ sellableId: sellable.id, priceId: "price_1" }],
      },
    });
    await expect(
      api.cart.get(
        createTestRequestContext({
          sessionId: "session_action_backend",
          customerId: false,
          userId: false,
        }),
      ),
    ).resolves.toMatchObject({
      ok: true,
      data: { id: "cart_1", items: [], total: { amount: 0 } },
    });
    expect(mikaActionDefinitions.cartAdd.name).toBe("cart.add");
    expect(mikaActionDefinitions.wishlistSaveForLater.name).toBe("wishlist.saveForLater");
  });

  it("runs trusted cart and wishlist JSON routes against the request-bound backend API", async () => {
    const contentRef = createTestContentRef();
    const sellable = createSellableDefinition({ maxPerOrder: 5 });
    const repositories = createTestBackendRepositories();
    await repositories.catalog.put(
      createCatalogItemDocument({ contentRef, sellables: [sellable] }),
    );
    const api = createMikaBackendApi(createIncrementingBackendDependencies({ repositories }));
    const routes = createMikaPluginRoutes(api);
    const sessionId = "session_route_backend";

    const added = await routes[mikaPluginRoutes.cartItems].handler({
      input: { sellableId: sellable.id, priceId: "price_1", quantity: 2 },
      request: new Request("https://shop.example.test/_emdash/api/plugins/mika/cart/items", {
        method: "POST",
      }),
      sessionId,
    });
    expect(added).toMatchObject({
      ok: true,
      status: 200,
      data: {
        id: "cart_1",
        items: [{ sellableId: sellable.id, priceId: "price_1", quantity: 2 }],
      },
    });
    if (!isCartRouteResult(added)) {
      throw new Error("Expected cart route to return a cart DTO.");
    }

    await expect(
      routes[mikaPluginRoutes.wishlistSaveForLater].handler({
        input: { lineId: added.data.items[0]!.id },
        request: new Request(
          "https://shop.example.test/_emdash/api/plugins/mika/wishlist/save-for-later",
          { method: "POST" },
        ),
        sessionId,
      }),
    ).resolves.toMatchObject({
      ok: true,
      status: 200,
      data: {
        id: "wishlist_1",
        items: [{ sellableId: sellable.id, priceId: "price_1" }],
      },
    });
    await expect(
      api.cart.get(createTestRequestContext({ sessionId, customerId: false, userId: false })),
    ).resolves.toMatchObject({
      ok: true,
      data: { id: "cart_1", items: [], total: { amount: 0 } },
    });
  });

  it("returns active catalog sellables with stock availability", async () => {
    const contentRef = createTestContentRef();
    const sellable = createSellableDefinition({ maxPerOrder: 3 });
    const repositories = createTestBackendRepositories({
      stockBySellableId: new Map([[sellable.id, createStockRecord({ sellableId: sellable.id })]]),
    });
    await repositories.catalog.put(
      createCatalogItemDocument({ contentRef, sellables: [sellable] }),
    );
    const api = createMikaBackendApi(createTestBackendDependencies({ repositories }));

    await expect(api.catalog.sellables({ contentRef })).resolves.toMatchObject({
      ok: true,
      status: 200,
      data: [
        {
          id: sellable.id,
          contentRef,
          title: "Test sellable",
          active: true,
          prices: [{ id: "price_1", active: true }],
          availability: {
            sellableId: sellable.id,
            status: "low_stock",
            availableQuantity: 2,
            maxPerOrder: 3,
          },
        },
      ],
    });
  });

  it("returns an empty catalog sellables list for missing content", async () => {
    const api = createMikaBackendApi(createTestBackendDependencies());

    await expect(api.catalog.sellables({ contentRef: createTestContentRef() })).resolves.toEqual({
      ok: true,
      status: 200,
      data: [],
    });
  });

  it("returns stock availability for each stock status", async () => {
    const cases = [
      {
        id: createTestMikaId("sellable", 1),
        stock: createStockRecord({
          sellableId: createTestMikaId("sellable", 1),
          quantityOnHand: 8,
          quantityReserved: 3,
          lowStockThreshold: 2,
        }),
        expected: {
          sellableId: "sellable_1",
          status: "available",
          availableQuantity: 5,
          lowStock: false,
        },
      },
      {
        id: createTestMikaId("sellable", 2),
        stock: createStockRecord({
          sellableId: createTestMikaId("sellable", 2),
          quantityOnHand: 5,
          quantityReserved: 3,
          lowStockThreshold: 2,
        }),
        expected: {
          sellableId: "sellable_2",
          status: "low_stock",
          availableQuantity: 2,
          lowStock: true,
        },
      },
      {
        id: createTestMikaId("sellable", 3),
        stock: createStockRecord({
          sellableId: createTestMikaId("sellable", 3),
          quantityOnHand: 3,
          quantityReserved: 3,
          lowStockThreshold: 2,
        }),
        expected: {
          sellableId: "sellable_3",
          status: "out_of_stock",
          availableQuantity: 0,
          lowStock: false,
        },
      },
      {
        id: createTestMikaId("sellable", 4),
        stock: createStockRecord({
          sellableId: createTestMikaId("sellable", 4),
          quantityOnHand: 0,
          quantityReserved: 0,
          allowBackorder: true,
        }),
        expected: {
          sellableId: "sellable_4",
          status: "backorder",
          availableQuantity: 0,
          lowStock: false,
        },
      },
      {
        id: createTestMikaId("sellable", 5),
        stock: createStockRecord({
          sellableId: createTestMikaId("sellable", 5),
          policy: "untracked",
        }),
        expected: {
          sellableId: "sellable_5",
          status: "untracked",
        },
      },
      {
        id: createTestMikaId("sellable", 6),
        stock: createStockRecord({
          sellableId: createTestMikaId("sellable", 6),
          policy: "manual",
        }),
        expected: {
          sellableId: "sellable_6",
          status: "manual",
          availableQuantity: 2,
          lowStock: true,
        },
      },
    ];
    const repositories = createTestBackendRepositories({
      stockBySellableId: new Map(cases.map((testCase) => [testCase.id, testCase.stock])),
    });
    const api = createMikaBackendApi(createTestBackendDependencies({ repositories }));

    for (const testCase of cases) {
      await expect(api.stock.availability({ sellableId: testCase.id })).resolves.toMatchObject({
        ok: true,
        status: 200,
        data: testCase.expected,
      });
    }
  });

  it("honors stock availability overrides", async () => {
    const forcedOut = createTestMikaId("sellable", 1);
    const forcedAvailable = createTestMikaId("sellable", 2);
    const repositories = createTestBackendRepositories({
      stockBySellableId: new Map([
        [
          forcedOut,
          createStockRecord({
            sellableId: forcedOut,
            quantityOnHand: 10,
            quantityReserved: 0,
            availableOverride: false,
          }),
        ],
        [
          forcedAvailable,
          createStockRecord({
            sellableId: forcedAvailable,
            quantityOnHand: 0,
            quantityReserved: 0,
            availableOverride: true,
          }),
        ],
      ]),
    });
    const api = createMikaBackendApi(createTestBackendDependencies({ repositories }));

    await expect(api.stock.availability({ sellableId: forcedOut })).resolves.toMatchObject({
      ok: true,
      status: 200,
      data: {
        sellableId: forcedOut,
        status: "out_of_stock",
        availableQuantity: 10,
        lowStock: false,
      },
    });
    await expect(api.stock.availability({ sellableId: forcedAvailable })).resolves.toMatchObject({
      ok: true,
      status: 200,
      data: {
        sellableId: forcedAvailable,
        status: "available",
        availableQuantity: 0,
        lowStock: false,
      },
    });
  });

  it("returns stable not found for missing stock availability", async () => {
    const api = createMikaBackendApi(createTestBackendDependencies());

    await expect(
      api.stock.availability({ sellableId: createTestMikaId("sellable", 404) }),
    ).resolves.toEqual({
      ok: false,
      status: 404,
      error: {
        code: "SELLABLE_NOT_FOUND",
        message: "Sellable 'sellable_404' was not found.",
      },
    });
  });

  it("filters inactive catalog sellables", async () => {
    const contentRef = createTestContentRef();
    const activeSellable = createSellableDefinition({ id: createTestMikaId("sellable", 1) });
    const inactiveSellable = createSellableDefinition({
      id: createTestMikaId("sellable", 2),
      active: false,
    });
    const repositories = createTestBackendRepositories();
    await repositories.catalog.put(
      createCatalogItemDocument({
        contentRef,
        sellables: [inactiveSellable, activeSellable],
      }),
    );
    const api = createMikaBackendApi(createTestBackendDependencies({ repositories }));

    await expect(api.catalog.sellables({ contentRef })).resolves.toMatchObject({
      ok: true,
      data: [{ id: activeSellable.id }],
    });
  });

  it("filters inactive catalog sellable prices", async () => {
    const contentRef = createTestContentRef();
    const sellable = createSellableDefinition({
      prices: [
        createPriceDefinition({ id: createTestMikaId("price", 1), active: false }),
        createPriceDefinition({ id: createTestMikaId("price", 2), active: true }),
      ],
    });
    const repositories = createTestBackendRepositories();
    await repositories.catalog.put(
      createCatalogItemDocument({ contentRef, sellables: [sellable] }),
    );
    const api = createMikaBackendApi(createTestBackendDependencies({ repositories }));
    const result = await api.catalog.sellables({ contentRef });

    expect(result).toMatchObject({
      ok: true,
      data: [{ prices: [{ id: "price_2", active: true }] }],
    });
    if (!result.ok) {
      throw new Error("Expected catalog sellables to succeed.");
    }
    expect(result.data[0]?.prices).toHaveLength(1);
  });

  it("returns or creates open carts for anonymous and customer identities", async () => {
    const dependencies = createIncrementingBackendDependencies();
    const api = createMikaBackendApi(dependencies);
    const anonymousCtx = createTestRequestContext({
      customerId: false,
      userId: false,
      sessionId: "session_anonymous",
    });
    const customerCtx = createTestRequestContext({
      customerId: "customer_1",
      userId: "user_1",
      sessionId: "session_anonymous",
    });

    const anonymous = await api.cart.get(anonymousCtx);
    const anonymousAgain = await api.cart.get(anonymousCtx);
    const customer = await api.cart.get(customerCtx);

    expect(anonymous).toMatchObject({
      ok: true,
      status: 200,
      data: {
        id: "cart_1",
        status: "open",
        currency: TEST_CURRENCY,
        items: [],
      },
    });
    expect(anonymousAgain).toMatchObject({ ok: true, data: { id: "cart_1" } });
    expect(customer).toMatchObject({
      ok: true,
      data: {
        id: "cart_2",
        status: "open",
        currency: TEST_CURRENCY,
        items: [],
      },
    });
  });

  it("adds duplicate cart lines by merging quantities", async () => {
    const contentRef = createTestContentRef();
    const sellable = createSellableDefinition({ maxPerOrder: 5 });
    const repositories = createTestBackendRepositories();
    await repositories.catalog.put(
      createCatalogItemDocument({ contentRef, sellables: [sellable] }),
    );
    const api = createMikaBackendApi(createIncrementingBackendDependencies({ repositories }));
    const ctx = createTestRequestContext({
      customerId: false,
      userId: false,
    });

    await expect(
      api.cart.add(ctx, {
        sellableId: sellable.id,
        priceId: createTestMikaId("price", 1),
        quantity: 1,
      }),
    ).resolves.toMatchObject({
      ok: true,
      data: {
        items: [{ sellableId: sellable.id, quantity: 1, total: { amount: 1200 } }],
        total: { amount: 1200 },
      },
    });
    await expect(
      api.cart.add(ctx, {
        sellableId: sellable.id,
        priceId: createTestMikaId("price", 1),
        quantity: 2,
      }),
    ).resolves.toMatchObject({
      ok: true,
      data: {
        items: [{ sellableId: sellable.id, quantity: 3, total: { amount: 3600 } }],
        total: { amount: 3600 },
      },
    });

    const cart = await api.cart.get(ctx);
    expect(cart).toMatchObject({ ok: true, data: { items: [{ quantity: 3 }] } });
    if (!cart.ok) {
      throw new Error("Expected cart.get to succeed.");
    }
    expect(cart.data.items).toHaveLength(1);
  });

  it("returns stable errors for missing cart lines on update and remove", async () => {
    const api = createMikaBackendApi(createIncrementingBackendDependencies());
    const ctx = createTestRequestContext({
      customerId: false,
      userId: false,
    });

    await expect(
      api.cart.update(ctx, { lineId: createTestMikaId("line", 404), quantity: 2 }),
    ).resolves.toMatchObject({
      ok: false,
      status: 404,
      error: {
        code: "VALIDATION_FAILED",
        fieldErrors: { lineId: "Cart line was not found." },
      },
    });
    await expect(
      api.cart.remove(ctx, { lineId: createTestMikaId("line", 404) }),
    ).resolves.toMatchObject({
      ok: false,
      status: 404,
      error: {
        code: "VALIDATION_FAILED",
        fieldErrors: { lineId: "Cart line was not found." },
      },
    });
  });

  it("merges compatible cart lines from a source session into the current cart", async () => {
    const contentRef = createTestContentRef();
    const sellable = createSellableDefinition({ maxPerOrder: 5 });
    const repositories = createTestBackendRepositories();
    await repositories.catalog.put(
      createCatalogItemDocument({ contentRef, sellables: [sellable] }),
    );
    const api = createMikaBackendApi(createIncrementingBackendDependencies({ repositories }));
    const sourceCtx = createTestRequestContext({
      customerId: false,
      userId: false,
      sessionId: "session_source",
    });
    const targetCtx = createTestRequestContext({
      customerId: "customer_1",
      userId: "user_1",
      sessionId: "session_target",
    });

    await api.cart.add(sourceCtx, {
      sellableId: sellable.id,
      priceId: createTestMikaId("price", 1),
      quantity: 2,
    });
    await api.cart.add(targetCtx, {
      sellableId: sellable.id,
      priceId: createTestMikaId("price", 1),
      quantity: 1,
    });

    await expect(
      api.cart.merge(targetCtx, { sourceSessionId: "session_source" }),
    ).resolves.toMatchObject({
      ok: true,
      status: 200,
      data: {
        items: [{ sellableId: sellable.id, quantity: 3, total: { amount: 3600 } }],
        subtotal: { amount: 3600 },
        total: { amount: 3600 },
      },
    });
    await expect(
      repositories.session.findOpenCartBySession("session_source", TEST_CURRENCY),
    ).resolves.toBeNull();
  });

  it("applies and removes coupon snapshots on cart totals", async () => {
    const contentRef = createTestContentRef();
    const sellable = createSellableDefinition();
    const repositories = createTestBackendRepositories();
    await repositories.catalog.put(
      createCatalogItemDocument({ contentRef, sellables: [sellable] }),
    );
    const api = createMikaBackendApi(createIncrementingBackendDependencies({ repositories }));
    const ctx = createTestRequestContext({
      customerId: false,
      userId: false,
    });

    await api.cart.add(ctx, { sellableId: sellable.id, quantity: 2 });

    await expect(api.cart.applyCoupon(ctx, { code: " save10 " })).resolves.toMatchObject({
      ok: true,
      status: 200,
      data: {
        coupon: {
          label: "SAVE10",
          discount: { amount: 240, currency: TEST_CURRENCY },
        },
        subtotal: { amount: 2400, currency: TEST_CURRENCY },
        discount: { amount: 240, currency: TEST_CURRENCY },
        total: { amount: 2160, currency: TEST_CURRENCY },
      },
    });
    await expect(api.cart.removeCoupon(ctx, {})).resolves.toMatchObject({
      ok: true,
      data: {
        coupon: undefined,
        subtotal: { amount: 2400, currency: TEST_CURRENCY },
        discount: undefined,
        total: { amount: 2400, currency: TEST_CURRENCY },
      },
    });
  });

  it("returns a valid cart quote without provider or stock mutations", async () => {
    const contentRef = createTestContentRef();
    const sellable = createSellableDefinition();
    const stock = createStockRecord({
      sellableId: sellable.id,
      quantityOnHand: 5,
      quantityReserved: 0,
    });
    const repositories = createTestBackendRepositories({
      stockBySellableId: new Map([[sellable.id, stock]]),
    });
    const fake = createFakeMikaProvider();
    await repositories.catalog.put(
      createCatalogItemDocument({ contentRef, sellables: [sellable] }),
    );
    const api = createMikaBackendApi(
      createIncrementingBackendDependencies({
        repositories,
        providers: createMikaProviderRegistry([fake.provider]),
        config: { cart: { ttlMs: 60_000 } },
      }),
    );
    const ctx = createTestRequestContext({ customerId: false, userId: false });

    const added = await api.cart.add(ctx, { sellableId: sellable.id, quantity: 2 });
    if (!added.ok) {
      throw new Error("Expected cart.add to succeed.");
    }

    await expect(api.cart.quote(ctx, { cartId: added.data.id })).resolves.toMatchObject({
      ok: true,
      status: 200,
      data: {
        id: "cart_quote_1",
        cartId: added.data.id,
        status: "valid",
        currency: TEST_CURRENCY,
        items: [
          {
            lineId: added.data.items[0]!.id,
            sellableId: sellable.id,
            quantity: 2,
            unitAmount: { amount: 1200, currency: TEST_CURRENCY },
            subtotal: { amount: 2400, currency: TEST_CURRENCY },
            total: { amount: 2400, currency: TEST_CURRENCY },
            availability: { status: "available", availableQuantity: 5 },
          },
        ],
        subtotal: { amount: 2400, currency: TEST_CURRENCY },
        total: { amount: 2400, currency: TEST_CURRENCY },
        expiresAt: "2026-01-01T00:01:00.000Z",
      },
    });
    await expect(
      repositories.session.findOpenCartBySession("session_1", TEST_CURRENCY),
    ).resolves.toMatchObject({ id: added.data.id, updatedAt: TEST_NOW });
    expect(Object.values(fake.getCalls()).flat()).toEqual([]);
  });

  it("quotes an explicit cart id using the stored cart currency", async () => {
    const usd = createTestCurrencyCode("USD");
    const contentRef = createTestContentRef();
    const sellable = createSellableDefinition({
      prices: [createPriceDefinition({ currency: usd, amount: 1500 })],
    });
    const repositories = createTestBackendRepositories();
    await repositories.catalog.put(
      createCatalogItemDocument({ contentRef, sellables: [sellable] }),
    );
    const dependencies = createIncrementingBackendDependencies({ repositories });
    const usdApi = createMikaBackendApi({
      ...dependencies,
      defaults: { ...dependencies.defaults, currency: usd },
    });
    const defaultApi = createMikaBackendApi(dependencies);
    const ctx = createTestRequestContext({ customerId: false, userId: false });

    const added = await usdApi.cart.add(ctx, { sellableId: sellable.id, quantity: 2 });
    if (!added.ok) {
      throw new Error("Expected USD cart.add to succeed.");
    }

    await expect(defaultApi.cart.quote(ctx, { cartId: added.data.id })).resolves.toMatchObject({
      ok: true,
      status: 200,
      data: {
        cartId: added.data.id,
        status: "valid",
        currency: usd,
        items: [
          {
            sellableId: sellable.id,
            unitAmount: { amount: 1500, currency: usd },
            subtotal: { amount: 3000, currency: usd },
            total: { amount: 3000, currency: usd },
          },
        ],
        subtotal: { amount: 3000, currency: usd },
        total: { amount: 3000, currency: usd },
        inputHash: createTestHash(
          JSON.stringify({
            cartId: added.data.id,
            quantity: undefined,
            currency: usd,
          }),
        ),
      },
    });
  });

  it("marks cart quotes changed when current price or coupon input differs", async () => {
    const contentRef = createTestContentRef();
    const sellable = createSellableDefinition();
    const repricedSellable = createSellableDefinition({
      prices: [createPriceDefinition({ amount: 1500 })],
    });
    const repositories = createTestBackendRepositories();
    await repositories.catalog.put(
      createCatalogItemDocument({ contentRef, sellables: [sellable] }),
    );
    const api = createMikaBackendApi(createIncrementingBackendDependencies({ repositories }));
    const ctx = createTestRequestContext({ customerId: false, userId: false });

    const added = await api.cart.add(ctx, { sellableId: sellable.id, quantity: 2 });
    if (!added.ok) {
      throw new Error("Expected cart.add to succeed.");
    }
    await repositories.catalog.put(
      createCatalogItemDocument({ contentRef, sellables: [repricedSellable] }),
    );

    await expect(
      api.cart.quote(ctx, { cartId: added.data.id, couponCode: "save10" }),
    ).resolves.toMatchObject({
      ok: true,
      data: {
        status: "changed",
        items: [
          {
            sellableId: sellable.id,
            unitAmount: { amount: 1500, currency: TEST_CURRENCY },
            subtotal: { amount: 3000, currency: TEST_CURRENCY },
            warnings: [expect.any(String)],
          },
        ],
        coupon: {
          label: "SAVE10",
          discount: { amount: 300, currency: TEST_CURRENCY },
        },
        subtotal: { amount: 3000, currency: TEST_CURRENCY },
        discount: { amount: 300, currency: TEST_CURRENCY },
        total: { amount: 2700, currency: TEST_CURRENCY },
      },
    });
  });

  it("marks cart quotes unavailable when current stock cannot satisfy the cart", async () => {
    const contentRef = createTestContentRef();
    const sellable = createSellableDefinition();
    const stockBySellableId = new Map<string, StockItemRecord>([
      [
        sellable.id,
        createStockRecord({ sellableId: sellable.id, quantityOnHand: 3, quantityReserved: 0 }),
      ],
    ]);
    const repositories = createTestBackendRepositories({ stockBySellableId });
    await repositories.catalog.put(
      createCatalogItemDocument({ contentRef, sellables: [sellable] }),
    );
    const api = createMikaBackendApi(createIncrementingBackendDependencies({ repositories }));
    const ctx = createTestRequestContext({ customerId: false, userId: false });

    const added = await api.cart.add(ctx, { sellableId: sellable.id, quantity: 2 });
    if (!added.ok) {
      throw new Error("Expected cart.add to succeed.");
    }
    stockBySellableId.set(
      sellable.id,
      createStockRecord({ sellableId: sellable.id, quantityOnHand: 0, quantityReserved: 0 }),
    );

    await expect(api.cart.quote(ctx, { cartId: added.data.id })).resolves.toMatchObject({
      ok: true,
      data: {
        status: "unavailable",
        items: [
          {
            sellableId: sellable.id,
            availability: { status: "out_of_stock", availableQuantity: 0 },
            warnings: [expect.stringContaining("does not have enough stock")],
          },
        ],
      },
    });
  });

  it("marks cart quotes expired without mutating the cart", async () => {
    const contentRef = createTestContentRef();
    const sellable = createSellableDefinition();
    const repositories = createTestBackendRepositories();
    await repositories.catalog.put(
      createCatalogItemDocument({ contentRef, sellables: [sellable] }),
    );
    const api = createMikaBackendApi(
      createIncrementingBackendDependencies({
        repositories,
        config: { cart: { ttlMs: 1 } },
      }),
    );
    const addCtx = createTestRequestContext({ customerId: false, userId: false });
    const quoteCtx = createTestRequestContext({
      customerId: false,
      userId: false,
      now: new Date(createTestClock().isoAt(60_000)),
    });

    const added = await api.cart.add(addCtx, { sellableId: sellable.id, quantity: 1 });
    if (!added.ok) {
      throw new Error("Expected cart.add to succeed.");
    }

    await expect(api.cart.quote(quoteCtx, { cartId: added.data.id })).resolves.toMatchObject({
      ok: true,
      data: {
        status: "expired",
        cartId: added.data.id,
        warnings: ["Cart quote has expired."],
        errors: [{ code: "CHECKOUT_EXPIRED" }],
      },
    });
    await expect(
      repositories.session.findOpenCartBySession("session_1", TEST_CURRENCY),
    ).resolves.toMatchObject({ id: added.data.id, status: "open", updatedAt: TEST_NOW });
  });

  it("returns an unavailable empty quote without creating a cart", async () => {
    const repositories = createTestBackendRepositories();
    const api = createMikaBackendApi(createIncrementingBackendDependencies({ repositories }));
    const ctx = createTestRequestContext({ customerId: false, userId: false });

    await expect(api.cart.quote(ctx, {})).resolves.toMatchObject({
      ok: true,
      status: 200,
      data: {
        id: "cart_quote_1",
        status: "unavailable",
        items: [],
        subtotal: { amount: 0, currency: TEST_CURRENCY },
        total: { amount: 0, currency: TEST_CURRENCY },
        warnings: ["Cart quote is empty."],
        errors: [{ code: "CHECKOUT_EMPTY" }],
      },
    });
    await expect(
      repositories.session.findOpenCartBySession("session_1", TEST_CURRENCY),
    ).resolves.toBeNull();
  });

  it("previews checkout totals, lines, provider, mode, and proof requirements", async () => {
    const contentRef = createTestContentRef();
    const sellable = createSellableDefinition();
    const stock = createStockRecord({
      sellableId: sellable.id,
      quantityOnHand: 5,
      quantityReserved: 0,
    });
    const repositories = createTestBackendRepositories({
      stockBySellableId: new Map([[sellable.id, stock]]),
    });
    const fake = createFakeMikaProvider({ id: createProviderName("stripe") });
    await repositories.catalog.put(
      createCatalogItemDocument({ contentRef, sellables: [sellable] }),
    );
    const api = createMikaBackendApi(
      createIncrementingBackendDependencies({
        repositories,
        providers: createMikaProviderRegistry([fake.provider]),
      }),
    );
    const ctx = createTestRequestContext({ customerId: false, userId: false });

    const added = await api.cart.add(ctx, { sellableId: sellable.id, quantity: 2 });
    if (!added.ok) {
      throw new Error("Expected cart.add to succeed.");
    }

    const preview = await api.checkout.preview(ctx, {
      cartId: added.data.id,
      provider: createProviderName("stripe"),
    });

    expect(preview).toMatchObject({
      ok: true,
      status: 200,
      data: {
        id: "checkout_preview_1",
        quoteId: "cart_quote_1",
        status: "requires_payment_authorization",
        mode: "payment",
        provider: "stripe",
        quote: {
          cartId: added.data.id,
          status: "valid",
          items: [
            {
              lineId: added.data.items[0]!.id,
              sellableId: sellable.id,
              quantity: 2,
              unitAmount: { amount: 1200, currency: TEST_CURRENCY },
              subtotal: { amount: 2400, currency: TEST_CURRENCY },
              total: { amount: 2400, currency: TEST_CURRENCY },
            },
          ],
          subtotal: { amount: 2400, currency: TEST_CURRENCY },
          total: { amount: 2400, currency: TEST_CURRENCY },
        },
        requiredProofs: [
          {
            kind: "payment_authorization",
            required: true,
            reason: expect.stringContaining("payment confirmation"),
            inputHash: expect.any(String),
          },
        ],
        acceptedProofs: ["consent", "mandate", "payment_authorization"],
        inputHash: expect.any(String),
      },
    });
    if (!preview.ok) {
      throw new Error("Expected checkout.preview to succeed.");
    }
    await expect(repositories.session.findById(preview.data.id!)).resolves.toBeNull();
    await expect(
      repositories.session.findById(createTestMikaId("checkout", 1)),
    ).resolves.toBeNull();
    expect(Object.values(fake.getCalls()).flat()).toEqual([]);
  });

  it("requires current bound payment authorization when checkout preview quote changes", async () => {
    const contentRef = createTestContentRef();
    const sellable = createSellableDefinition();
    const repricedSellable = createSellableDefinition({
      prices: [createPriceDefinition({ amount: 1500 })],
    });
    const repositories = createTestBackendRepositories();
    const fake = createFakeMikaProvider();
    await repositories.catalog.put(
      createCatalogItemDocument({ contentRef, sellables: [sellable] }),
    );
    const api = createMikaBackendApi(
      createIncrementingBackendDependencies({
        repositories,
        providers: createMikaProviderRegistry([fake.provider]),
      }),
    );
    const ctx = createTestRequestContext({ customerId: false, userId: false });

    const added = await api.cart.add(ctx, { sellableId: sellable.id, quantity: 2 });
    if (!added.ok) {
      throw new Error("Expected cart.add to succeed.");
    }

    const originalPreview = await api.checkout.preview(ctx, { cartId: added.data.id });
    if (!originalPreview.ok) {
      throw new Error("Expected checkout.preview to succeed.");
    }

    await repositories.catalog.put(
      createCatalogItemDocument({ contentRef, sellables: [repricedSellable] }),
    );

    const unboundProofPreview = await api.checkout.preview(ctx, {
      cartId: added.data.id,
      proofRefs: [{ kind: "payment_authorization", id: "proof_unbound" }],
    });
    expect(unboundProofPreview).toMatchObject({
      ok: true,
      data: {
        status: "requires_payment_authorization",
        quote: {
          status: "changed",
          total: { amount: 3000, currency: TEST_CURRENCY },
        },
      },
    });
    if (!unboundProofPreview.ok) {
      throw new Error("Expected checkout.preview to succeed.");
    }

    const staleProofPreview = await api.checkout.preview(ctx, {
      cartId: added.data.id,
      proofRefs: [
        {
          kind: "payment_authorization",
          id: "proof_stale",
          inputHash: originalPreview.data.inputHash,
        },
      ],
    });
    expect(staleProofPreview).toMatchObject({
      ok: true,
      data: {
        status: "requires_payment_authorization",
        quote: { status: "changed" },
      },
    });
    if (!staleProofPreview.ok) {
      throw new Error("Expected checkout.preview to succeed.");
    }
    expect(staleProofPreview.data.inputHash).not.toBe(originalPreview.data.inputHash);

    await expect(
      api.checkout.preview(ctx, {
        cartId: added.data.id,
        proofRefs: [
          {
            kind: "payment_authorization",
            id: "proof_current",
            inputHash: staleProofPreview.data.inputHash,
          },
        ],
      }),
    ).resolves.toMatchObject({
      ok: true,
      data: {
        status: "ready",
        quote: { status: "changed" },
      },
    });
    await expect(repositories.session.findById(unboundProofPreview.data.id!)).resolves.toBeNull();
    await expect(repositories.session.findById(staleProofPreview.data.id!)).resolves.toBeNull();
    expect(Object.values(fake.getCalls()).flat()).toEqual([]);
  });

  it("binds checkout preview authorization to visible line availability projection", async () => {
    const contentRef = createTestContentRef();
    const sellable = createSellableDefinition();
    const stockBySellableId = new Map<string, StockItemRecord>([
      [
        sellable.id,
        createStockRecord({ sellableId: sellable.id, quantityOnHand: 5, quantityReserved: 0 }),
      ],
    ]);
    const repositories = createTestBackendRepositories({ stockBySellableId });
    await repositories.catalog.put(
      createCatalogItemDocument({ contentRef, sellables: [sellable] }),
    );
    const api = createMikaBackendApi(createIncrementingBackendDependencies({ repositories }));
    const ctx = createTestRequestContext({ customerId: false, userId: false });

    const added = await api.cart.add(ctx, { sellableId: sellable.id, quantity: 1 });
    if (!added.ok) {
      throw new Error("Expected cart.add to succeed.");
    }

    const availablePreview = await api.checkout.preview(ctx, { cartId: added.data.id });
    if (!availablePreview.ok) {
      throw new Error("Expected checkout.preview to succeed.");
    }
    expect(availablePreview).toMatchObject({
      ok: true,
      data: {
        quote: {
          status: "valid",
          items: [{ availability: { status: "available", availableQuantity: 5 } }],
          total: { amount: 1200, currency: TEST_CURRENCY },
        },
      },
    });

    stockBySellableId.set(
      sellable.id,
      createStockRecord({ sellableId: sellable.id, quantityOnHand: 2, quantityReserved: 0 }),
    );

    const staleAvailabilityProofPreview = await api.checkout.preview(ctx, {
      cartId: added.data.id,
      proofRefs: [
        {
          kind: "payment_authorization",
          id: "proof_stale_availability",
          inputHash: availablePreview.data.inputHash,
        },
      ],
    });
    expect(staleAvailabilityProofPreview).toMatchObject({
      ok: true,
      data: {
        status: "requires_payment_authorization",
        quote: {
          status: "valid",
          items: [{ availability: { status: "low_stock", availableQuantity: 2 } }],
          total: { amount: 1200, currency: TEST_CURRENCY },
        },
      },
    });
    if (!staleAvailabilityProofPreview.ok) {
      throw new Error("Expected checkout.preview to succeed.");
    }
    expect(staleAvailabilityProofPreview.data.inputHash).not.toBe(availablePreview.data.inputHash);

    await expect(
      api.checkout.preview(ctx, {
        cartId: added.data.id,
        proofRefs: [
          {
            kind: "payment_authorization",
            id: "proof_current_availability",
            inputHash: staleAvailabilityProofPreview.data.inputHash,
          },
        ],
      }),
    ).resolves.toMatchObject({
      ok: true,
      data: {
        status: "ready",
        quote: {
          status: "valid",
          items: [{ availability: { status: "low_stock", availableQuantity: 2 } }],
          total: { amount: 1200, currency: TEST_CURRENCY },
        },
      },
    });
    await expect(
      repositories.session.findById(staleAvailabilityProofPreview.data.id!),
    ).resolves.toBeNull();
  });

  it("rejects checkout start for empty carts before provider handoff", async () => {
    const repositories = createTestBackendRepositories();
    const fake = createFakeMikaProvider();
    const api = createMikaBackendApi(
      createIncrementingBackendDependencies({
        repositories,
        providers: createMikaProviderRegistry([fake.provider]),
      }),
    );
    const ctx = createTestRequestContext({ customerId: false, userId: false });

    await expect(api.checkout.start(ctx, {})).resolves.toMatchObject({
      ok: false,
      status: 409,
      error: {
        code: "CHECKOUT_EMPTY",
      },
    });
    expect(Object.values(fake.getCalls()).flat()).toEqual([]);
    await expect(
      repositories.session.findOpenCartBySession("session_1", TEST_CURRENCY),
    ).resolves.toBeNull();
  });

  it("rejects checkout start when current stock cannot satisfy the cart", async () => {
    const contentRef = createTestContentRef();
    const sellable = createSellableDefinition();
    const stockBySellableId = new Map<string, StockItemRecord>([
      [
        sellable.id,
        createStockRecord({ sellableId: sellable.id, quantityOnHand: 1, quantityReserved: 0 }),
      ],
    ]);
    const repositories = createTestBackendRepositories({ stockBySellableId });
    const fake = createFakeMikaProvider();
    await repositories.catalog.put(
      createCatalogItemDocument({ contentRef, sellables: [sellable] }),
    );
    const api = createMikaBackendApi(
      createIncrementingBackendDependencies({
        repositories,
        providers: createMikaProviderRegistry([fake.provider]),
      }),
    );
    const ctx = createTestRequestContext({ customerId: false, userId: false });

    const added = await api.cart.add(ctx, { sellableId: sellable.id, quantity: 1 });
    if (!added.ok) {
      throw new Error("Expected cart.add to succeed.");
    }
    await repositories.stock.putItem(
      createStockRecord({ sellableId: sellable.id, quantityOnHand: 1, quantityReserved: 1 }),
    );

    await expect(api.checkout.start(ctx, { cartId: added.data.id })).resolves.toMatchObject({
      ok: false,
      status: 409,
      error: {
        code: "OUT_OF_STOCK",
      },
    });
    expect(fake.getCalls().createCheckoutSession).toEqual([]);
    await expect(
      repositories.session.findById(createTestMikaId("checkout", 1)),
    ).resolves.toBeNull();
  });

  it("rejects checkout start for providers without hosted checkout support", async () => {
    const contentRef = createTestContentRef();
    const sellable = createSellableDefinition();
    const stock = createStockRecord({
      sellableId: sellable.id,
      quantityOnHand: 5,
      quantityReserved: 0,
    });
    const repositories = createTestBackendRepositories({
      stockBySellableId: new Map([[sellable.id, stock]]),
    });
    const fake = createFakeMikaProvider({ capabilities: ["payments"] });
    await repositories.catalog.put(
      createCatalogItemDocument({ contentRef, sellables: [sellable] }),
    );
    const api = createMikaBackendApi(
      createIncrementingBackendDependencies({
        repositories,
        providers: createMikaProviderRegistry([fake.provider]),
      }),
    );
    const ctx = createTestRequestContext({ customerId: false, userId: false });

    const added = await api.cart.add(ctx, { sellableId: sellable.id, quantity: 1 });
    if (!added.ok) {
      throw new Error("Expected cart.add to succeed.");
    }

    await expect(api.checkout.start(ctx, { cartId: added.data.id })).resolves.toMatchObject({
      ok: false,
      status: 409,
      error: {
        code: "PROVIDER_UNSUPPORTED",
      },
    });
    expect(fake.getCalls().createCheckoutSession).toEqual([]);
    await expect(repositories.stock.findBySellableId(sellable.id)).resolves.toMatchObject({
      quantityReserved: 0,
    });
  });

  it("releases reserved stock when checkout provider creation fails", async () => {
    const contentRef = createTestContentRef();
    const sellable = createSellableDefinition();
    const repositories = createTestBackendRepositories({
      stockBySellableId: new Map([
        [
          sellable.id,
          createStockRecord({ sellableId: sellable.id, quantityOnHand: 5, quantityReserved: 0 }),
        ],
      ]),
    });
    const fake = createFakeMikaProvider({
      overrides: {
        createCheckoutSession: async () => {
          throw new Error("provider offline");
        },
      },
    });
    await repositories.catalog.put(
      createCatalogItemDocument({ contentRef, sellables: [sellable] }),
    );
    const api = createMikaBackendApi(
      createIncrementingBackendDependencies({
        repositories,
        providers: createMikaProviderRegistry([fake.provider]),
      }),
    );
    const ctx = createTestRequestContext({ customerId: false, userId: false });

    const added = await api.cart.add(ctx, { sellableId: sellable.id, quantity: 2 });
    if (!added.ok) {
      throw new Error("Expected cart.add to succeed.");
    }

    await expect(api.checkout.start(ctx, { cartId: added.data.id })).resolves.toMatchObject({
      ok: false,
      status: 502,
      error: {
        code: "PROVIDER_FAILED",
      },
    });
    expect(fake.getCalls().createCheckoutSession).toHaveLength(1);
    await expect(repositories.stock.findBySellableId(sellable.id)).resolves.toMatchObject({
      quantityReserved: 0,
    });
    await expect(
      repositories.session.findById(createTestMikaId("checkout", 1)),
    ).resolves.toBeNull();
    await expect(repositories.session.findById(added.data.id)).resolves.toMatchObject({
      type: "cart",
      status: "open",
    });
  });

  it("starts hosted checkout, persists binding, and returns the redirect URL", async () => {
    const contentRef = createTestContentRef();
    const stripe = createProviderName("stripe");
    const sellable = createSellableDefinition({
      prices: [
        createPriceDefinition({
          providerRefs: [{ provider: stripe, productId: "prod_test", priceId: "price_test" }],
        }),
      ],
    });
    const repositories = createTestBackendRepositories({
      stockBySellableId: new Map([
        [
          sellable.id,
          createStockRecord({ sellableId: sellable.id, quantityOnHand: 5, quantityReserved: 0 }),
        ],
      ]),
    });
    const fake = createFakeMikaProvider({ id: stripe });
    await repositories.catalog.put(
      createCatalogItemDocument({ contentRef, sellables: [sellable] }),
    );
    const api = createMikaBackendApi(
      createIncrementingBackendDependencies({
        repositories,
        providers: createMikaProviderRegistry([fake.provider]),
      }),
    );
    const ctx = createTestRequestContext({ customerId: false, userId: false });

    const added = await api.cart.add(ctx, { sellableId: sellable.id, quantity: 2 });
    if (!added.ok) {
      throw new Error("Expected cart.add to succeed.");
    }

    const checkout = await api.checkout.start(ctx, {
      cartId: added.data.id,
      provider: stripe,
      customer: { email: "shopper@example.test" },
    });

    expect(checkout).toMatchObject({
      ok: true,
      status: 200,
      data: {
        id: "checkout_1",
        status: "created",
        mode: "payment",
        provider: "stripe",
        redirectUrl: "https://checkout.example.test/session/checkout_fake",
        expiresAt: "2026-01-01T01:00:00.000Z",
      },
      effects: [{ type: "redirect", url: "https://checkout.example.test/session/checkout_fake" }],
    });
    const providerCalls = fake.getCalls().createCheckoutSession;
    expect(providerCalls).toHaveLength(1);
    expect(providerCalls[0]).toMatchObject({
      idempotencyKey: "idem_1",
      mode: "payment",
      provider: "stripe",
      customer: { email: "shopper@example.test" },
      successUrl: "https://shop.example.test/success?checkoutId=checkout_1",
      cancelUrl: "https://shop.example.test/cancel",
      lines: [
        {
          sellableId: sellable.id,
          priceId: "price_1",
          providerProductId: "prod_test",
          providerPriceId: "price_test",
          quantity: 2,
          unitAmount: 1200,
          currency: TEST_CURRENCY,
        },
      ],
    });
    await expect(
      repositories.session.findById(createTestMikaId("checkout", 1)),
    ).resolves.toMatchObject({
      type: "checkout",
      cartId: added.data.id,
      provider: "stripe",
      providerCheckoutId: "provider_checkout_fake",
      status: "created",
      aggregate: {
        binding: {
          provider: "stripe",
          providerCheckoutId: "provider_checkout_fake",
          providerCustomerId: undefined,
        },
        lines: [{ cartLineId: added.data.items[0]!.id, reservationId: "stock_event_1" }],
      },
    });
    await expect(repositories.session.findById(added.data.id)).resolves.toMatchObject({
      type: "cart",
      status: "checkout_pending",
      aggregate: {
        items: [{ reservationId: "stock_event_1" }],
        metadata: { checkoutSessionId: "checkout_1" },
      },
    });
    await expect(repositories.stock.findBySellableId(sellable.id)).resolves.toMatchObject({
      quantityReserved: 2,
    });
  });

  it("replays duplicate checkout starts locally without another provider handoff", async () => {
    const contentRef = createTestContentRef();
    const sellable = createSellableDefinition();
    const repositories = createTestBackendRepositories({
      stockBySellableId: new Map([
        [
          sellable.id,
          createStockRecord({ sellableId: sellable.id, quantityOnHand: 5, quantityReserved: 0 }),
        ],
      ]),
    });
    let providerShouldFail = false;
    const fake = createFakeMikaProvider({
      overrides: {
        createCheckoutSession: async () => {
          if (providerShouldFail) {
            throw new Error("duplicate provider call should not happen");
          }

          return {
            id: createMikaId("checkout_fake"),
            status: "created",
            mode: "payment",
            provider: TEST_PROVIDER,
            redirectUrl: "https://checkout.example.test/session/checkout_fake",
            expiresAt: createTestClock().isoAt(60 * 60_000),
            providerCheckoutId: "provider_checkout_fake",
          };
        },
      },
    });
    await repositories.catalog.put(
      createCatalogItemDocument({ contentRef, sellables: [sellable] }),
    );
    const api = createMikaBackendApi(
      createIncrementingBackendDependencies({
        repositories,
        providers: createMikaProviderRegistry([fake.provider]),
      }),
    );
    const ctx = createTestRequestContext({
      customerId: false,
      userId: false,
      idempotencyKey: "checkout_replay_1",
    });

    const added = await api.cart.add(ctx, { sellableId: sellable.id, quantity: 2 });
    if (!added.ok) {
      throw new Error("Expected cart.add to succeed.");
    }

    const first = await api.checkout.start(ctx, { cartId: added.data.id });
    providerShouldFail = true;
    const replay = await api.checkout.start(ctx, { cartId: added.data.id });

    expect(first).toMatchObject({
      ok: true,
      data: {
        id: "checkout_1",
        redirectUrl: "https://checkout.example.test/session/checkout_fake",
      },
    });
    expect(replay).toMatchObject({
      ok: true,
      data: {
        id: "checkout_1",
        redirectUrl: "https://checkout.example.test/session/checkout_fake",
      },
    });
    expect(fake.getCalls().createCheckoutSession).toHaveLength(1);
    await expect(repositories.stock.findBySellableId(sellable.id)).resolves.toMatchObject({
      quantityReserved: 2,
    });
    await expect(repositories.session.findById(added.data.id)).resolves.toMatchObject({
      type: "cart",
      status: "checkout_pending",
    });
  });

  it("returns stored checkout status without a provider lookup", async () => {
    const contentRef = createTestContentRef();
    const sellable = createSellableDefinition();
    const repositories = createTestBackendRepositories({
      stockBySellableId: new Map([
        [
          sellable.id,
          createStockRecord({ sellableId: sellable.id, quantityOnHand: 5, quantityReserved: 0 }),
        ],
      ]),
    });
    const fake = createFakeMikaProvider();
    await repositories.catalog.put(
      createCatalogItemDocument({ contentRef, sellables: [sellable] }),
    );
    const api = createMikaBackendApi(
      createIncrementingBackendDependencies({
        repositories,
        providers: createMikaProviderRegistry([fake.provider]),
      }),
    );
    const ctx = createTestRequestContext({ customerId: false, userId: false });

    const added = await api.cart.add(ctx, { sellableId: sellable.id, quantity: 2 });
    if (!added.ok) {
      throw new Error("Expected cart.add to succeed.");
    }
    const started = await api.checkout.start(ctx, { cartId: added.data.id });
    if (!started.ok) {
      throw new Error("Expected checkout.start to succeed.");
    }

    await expect(api.checkout.status({ checkoutId: started.data.id })).resolves.toMatchObject({
      ok: true,
      status: 200,
      data: {
        id: "checkout_1",
        status: "created",
        mode: "payment",
        provider: TEST_PROVIDER,
        redirectUrl: "https://checkout.example.test/session/checkout_fake",
        expiresAt: "2026-01-01T01:00:00.000Z",
      },
      effects: [{ type: "redirect", url: "https://checkout.example.test/session/checkout_fake" }],
    });
    expect(fake.getCalls().retrieveCheckoutSession).toEqual([]);
  });

  it("returns stable checkout status errors for missing, expired, and binding mismatch states", async () => {
    const repositories = createTestBackendRepositories();
    const api = createMikaBackendApi(createIncrementingBackendDependencies({ repositories }));

    await repositories.session.put(
      createCheckoutDocument({
        id: createTestMikaId("checkout", 1),
        expiresAt: createTestClock().isoAt(-1),
      }),
    );
    await repositories.session.put(
      createCheckoutDocument({
        id: createTestMikaId("checkout", 2),
        providerCheckoutId: "provider_checkout_actual",
        bindingProviderCheckoutId: "provider_checkout_stale",
      }),
    );

    await expect(
      api.checkout.status({ checkoutId: createTestMikaId("checkout", 404) }),
    ).resolves.toMatchObject({
      ok: false,
      status: 404,
      error: {
        code: "VALIDATION_FAILED",
        fieldErrors: { checkoutId: "Checkout was not found." },
      },
    });
    await expect(
      api.checkout.status({ checkoutId: createTestMikaId("checkout", 1) }),
    ).resolves.toMatchObject({
      ok: false,
      status: 409,
      error: { code: "CHECKOUT_EXPIRED" },
    });
    await expect(
      api.checkout.status({ checkoutId: createTestMikaId("checkout", 2) }),
    ).resolves.toMatchObject({
      ok: false,
      status: 409,
      error: { code: "CHECKOUT_BINDING_MISMATCH" },
    });
  });

  it("maps terminal checkout documents to status DTOs after expiry", async () => {
    const repositories = createTestBackendRepositories();
    const api = createMikaBackendApi(createIncrementingBackendDependencies({ repositories }));

    await repositories.session.put(
      createCheckoutDocument({
        id: createTestMikaId("checkout", 1),
        status: "completed",
        expiresAt: createTestClock().isoAt(-1),
        metadata: { checkoutProviderStatus: "completed", checkoutOrderId: "order_1" },
      }),
    );
    await repositories.session.put(
      createCheckoutDocument({
        id: createTestMikaId("checkout", 2),
        status: "failed",
        expiresAt: createTestClock().isoAt(-1),
        metadata: { checkoutProviderStatus: "failed" },
      }),
    );
    await repositories.session.put(
      createCheckoutDocument({
        id: createTestMikaId("checkout", 3),
        status: "cancelled",
        expiresAt: createTestClock().isoAt(-1),
        metadata: { checkoutProviderStatus: "cancelled" },
      }),
    );

    await expect(
      api.checkout.status({ checkoutId: createTestMikaId("checkout", 1) }),
    ).resolves.toMatchObject({
      ok: true,
      status: 200,
      data: {
        id: "checkout_1",
        status: "completed",
        mode: "payment",
        provider: TEST_PROVIDER,
        orderId: "order_1",
      },
    });
    await expect(
      api.checkout.status({ checkoutId: createTestMikaId("checkout", 2) }),
    ).resolves.toMatchObject({
      ok: true,
      status: 200,
      data: {
        id: "checkout_2",
        status: "failed",
        mode: "payment",
        provider: TEST_PROVIDER,
      },
    });
    await expect(
      api.checkout.status({ checkoutId: createTestMikaId("checkout", 3) }),
    ).resolves.toMatchObject({
      ok: true,
      status: 200,
      data: {
        id: "checkout_3",
        status: "cancelled",
        mode: "payment",
        provider: TEST_PROVIDER,
      },
    });
  });

  it("compensates stock when local checkout persistence fails after provider success", async () => {
    const contentRef = createTestContentRef();
    const sellable = createSellableDefinition();
    const repositories = createTestBackendRepositories({
      stockBySellableId: new Map([
        [
          sellable.id,
          createStockRecord({ sellableId: sellable.id, quantityOnHand: 5, quantityReserved: 0 }),
        ],
      ]),
    });
    const originalSessionPut = repositories.session.put.bind(repositories.session);
    (
      repositories.session as {
        put: typeof repositories.session.put;
      }
    ).put = async (document) => {
      if (document.type === "cart" && document.status === "checkout_pending") {
        throw new Error("cart persistence unavailable");
      }

      return originalSessionPut(document);
    };
    const fake = createFakeMikaProvider();
    await repositories.catalog.put(
      createCatalogItemDocument({ contentRef, sellables: [sellable] }),
    );
    const api = createMikaBackendApi(
      createIncrementingBackendDependencies({
        repositories,
        providers: createMikaProviderRegistry([fake.provider]),
      }),
    );
    const ctx = createTestRequestContext({
      customerId: false,
      userId: false,
      idempotencyKey: "checkout_persistence_failure_1",
    });

    const added = await api.cart.add(ctx, { sellableId: sellable.id, quantity: 2 });
    if (!added.ok) {
      throw new Error("Expected cart.add to succeed.");
    }

    await expect(api.checkout.start(ctx, { cartId: added.data.id })).resolves.toMatchObject({
      ok: false,
      status: 409,
      error: {
        code: "CONFLICT",
      },
    });
    expect(fake.getCalls().createCheckoutSession).toHaveLength(1);
    await expect(repositories.stock.findBySellableId(sellable.id)).resolves.toMatchObject({
      quantityReserved: 0,
    });
    const failedCheckout = await repositories.session.findById(createTestMikaId("checkout", 1));
    expect(failedCheckout).toMatchObject({
      type: "checkout",
      status: "failed",
      aggregate: {
        metadata: {
          checkoutPersistenceFailed: true,
          checkoutProviderStatus: "failed",
        },
      },
    });
    if (!failedCheckout || failedCheckout.type !== "checkout") {
      throw new Error("Expected failed checkout document to be persisted.");
    }
    expect(failedCheckout.aggregate.metadata?.["checkoutRedirectUrl"]).toBeUndefined();
    await expect(repositories.session.findById(added.data.id)).resolves.toMatchObject({
      type: "cart",
      status: "open",
    });

    const replay = await api.checkout.start(ctx, { cartId: added.data.id });
    expect(replay).toMatchObject({
      ok: false,
      status: 409,
      error: {
        code: "CONFLICT",
      },
    });
    expect("effects" in replay).toBe(false);
    expect(fake.getCalls().createCheckoutSession).toHaveLength(1);
    await expect(repositories.stock.findBySellableId(sellable.id)).resolves.toMatchObject({
      quantityReserved: 0,
    });
  });

  it("returns stable errors for invalid target cart and merge currency mismatches", async () => {
    const dependencies = createIncrementingBackendDependencies();
    const api = createMikaBackendApi(dependencies);
    const ctx = createTestRequestContext({
      customerId: "customer_1",
      userId: "user_1",
      sessionId: "session_target",
    });
    const sourceCtx = createTestRequestContext({
      customerId: false,
      userId: false,
      sessionId: "session_usd_source",
    });
    const usdApi = createMikaBackendApi({
      ...dependencies,
      defaults: { ...dependencies.defaults, currency: createTestCurrencyCode("USD") },
    });

    await expect(
      api.cart.merge(ctx, { targetCartId: createTestMikaId("cart", 404) }),
    ).resolves.toMatchObject({
      ok: false,
      status: 404,
      error: {
        code: "VALIDATION_FAILED",
        fieldErrors: { targetCartId: "Open cart was not found." },
      },
    });

    const usdCart = await usdApi.cart.get(ctx);
    if (!usdCart.ok) {
      throw new Error("Expected USD cart.get to succeed.");
    }

    await expect(api.cart.merge(ctx, { targetCartId: usdCart.data.id })).resolves.toMatchObject({
      ok: false,
      status: 422,
      error: {
        code: "VALIDATION_FAILED",
        fieldErrors: { targetCartId: expect.any(String) },
      },
    });

    await usdApi.cart.get(sourceCtx);

    await expect(
      api.cart.merge(ctx, { sourceSessionId: "session_usd_source" }),
    ).resolves.toMatchObject({
      ok: false,
      status: 422,
      error: {
        code: "VALIDATION_FAILED",
        fieldErrors: { sourceSessionId: expect.any(String) },
      },
    });
  });

  it("rejects inactive sellables, inactive prices, currency mismatches, max quantity, and unavailable stock before creating a cart", async () => {
    const contentRef = createTestContentRef();
    const inactiveSellable = createSellableDefinition({
      id: createTestMikaId("sellable", 1),
      active: false,
    });
    const inactivePriceSellable = createSellableDefinition({
      id: createTestMikaId("sellable", 2),
      prices: [createPriceDefinition({ id: createTestMikaId("price", 2), active: false })],
    });
    const usdSellable = createSellableDefinition({
      id: createTestMikaId("sellable", 3),
      prices: [
        createPriceDefinition({
          id: createTestMikaId("price", 3),
          currency: createTestCurrencyCode("USD"),
        }),
      ],
    });
    const limitedSellable = createSellableDefinition({
      id: createTestMikaId("sellable", 4),
      maxPerOrder: 2,
    });
    const outOfStockSellable = createSellableDefinition({
      id: createTestMikaId("sellable", 5),
    });
    const repositories = createTestBackendRepositories({
      stockBySellableId: new Map([
        [
          outOfStockSellable.id,
          createStockRecord({
            sellableId: outOfStockSellable.id,
            quantityOnHand: 1,
            quantityReserved: 1,
          }),
        ],
      ]),
    });
    await repositories.catalog.put(
      createCatalogItemDocument({
        contentRef,
        sellables: [
          inactiveSellable,
          inactivePriceSellable,
          usdSellable,
          limitedSellable,
          outOfStockSellable,
        ],
      }),
    );
    const api = createMikaBackendApi(createIncrementingBackendDependencies({ repositories }));
    const ctx = createTestRequestContext({
      customerId: false,
      userId: false,
      sessionId: "session_rejected",
    });

    await expect(api.cart.add(ctx, { sellableId: inactiveSellable.id })).resolves.toMatchObject({
      ok: false,
      status: 409,
      error: { code: "SELLABLE_INACTIVE" },
    });
    await expect(
      api.cart.add(ctx, {
        sellableId: inactivePriceSellable.id,
        priceId: createTestMikaId("price", 2),
      }),
    ).resolves.toMatchObject({
      ok: false,
      status: 409,
      error: { code: "PRICE_INACTIVE" },
    });
    await expect(
      api.cart.add(ctx, { sellableId: usdSellable.id, priceId: createTestMikaId("price", 3) }),
    ).resolves.toMatchObject({
      ok: false,
      status: 422,
      error: { code: "VALIDATION_FAILED", fieldErrors: { priceId: expect.any(String) } },
    });
    await expect(
      api.cart.add(ctx, { sellableId: limitedSellable.id, quantity: 3 }),
    ).resolves.toMatchObject({
      ok: false,
      status: 409,
      error: { code: "MAX_PER_ORDER_EXCEEDED" },
    });
    await expect(api.cart.add(ctx, { sellableId: outOfStockSellable.id })).resolves.toEqual({
      ok: false,
      status: 409,
      error: {
        code: "OUT_OF_STOCK",
        message: `Sellable '${outOfStockSellable.id}' does not have enough stock.`,
      },
    });
    await expect(
      repositories.session.findOpenCartBySession("session_rejected", TEST_CURRENCY),
    ).resolves.toBeNull();
  });

  it("returns or creates active wishlists for anonymous and customer identities", async () => {
    const dependencies = createIncrementingBackendDependencies();
    const api = createMikaBackendApi(dependencies);
    const anonymousCtx = createTestRequestContext({
      customerId: false,
      userId: false,
      sessionId: "session_wishlist_anonymous",
    });
    const customerCtx = createTestRequestContext({
      customerId: "customer_wishlist_1",
      userId: "user_wishlist_1",
      sessionId: "session_wishlist_anonymous",
    });

    const anonymous = await api.wishlist.get(anonymousCtx);
    const anonymousAgain = await api.wishlist.get(anonymousCtx);
    const customer = await api.wishlist.get(customerCtx);

    expect(anonymous).toMatchObject({
      ok: true,
      status: 200,
      data: {
        id: "wishlist_1",
        items: [],
      },
    });
    expect(anonymousAgain).toMatchObject({ ok: true, data: { id: "wishlist_1" } });
    expect(customer).toMatchObject({
      ok: true,
      data: {
        id: "wishlist_2",
        items: [],
      },
    });
  });

  it("adds active sellables with active prices to the current wishlist", async () => {
    const contentRef = createTestContentRef();
    const sellable = createSellableDefinition({ maxPerOrder: 5 });
    const repositories = createTestBackendRepositories({
      stockBySellableId: new Map([[sellable.id, createStockRecord({ sellableId: sellable.id })]]),
    });
    await repositories.catalog.put(
      createCatalogItemDocument({ contentRef, sellables: [sellable] }),
    );
    const api = createMikaBackendApi(createIncrementingBackendDependencies({ repositories }));
    const ctx = createTestRequestContext({ customerId: false, userId: false });

    await expect(
      api.wishlist.add(ctx, {
        sellableId: sellable.id,
        priceId: createTestMikaId("price", 1),
      }),
    ).resolves.toMatchObject({
      ok: true,
      status: 200,
      data: {
        items: [
          {
            id: "wishlist_item_1",
            sellableId: sellable.id,
            priceId: "price_1",
            title: "Test sellable",
            sku: "TEST-SKU-1",
            variantOptions: [],
            addedAt: TEST_NOW,
            availability: {
              sellableId: sellable.id,
              status: "low_stock",
              availableQuantity: 2,
            },
          },
        ],
      },
    });

    await expect(api.wishlist.add(ctx, { sellableId: sellable.id })).resolves.toMatchObject({
      ok: true,
      data: {
        items: [{ sellableId: sellable.id }],
      },
    });
    const wishlist = await api.wishlist.get(ctx);
    if (!wishlist.ok) {
      throw new Error("Expected wishlist.get to succeed.");
    }
    expect(wishlist.data.items).toHaveLength(1);
  });

  it("rejects inactive sellables, inactive prices, and currency mismatches before creating a wishlist", async () => {
    const contentRef = createTestContentRef();
    const inactiveSellable = createSellableDefinition({
      id: createTestMikaId("sellable", 1),
      active: false,
    });
    const inactivePriceSellable = createSellableDefinition({
      id: createTestMikaId("sellable", 2),
      prices: [createPriceDefinition({ id: createTestMikaId("price", 2), active: false })],
    });
    const usdSellable = createSellableDefinition({
      id: createTestMikaId("sellable", 3),
      prices: [
        createPriceDefinition({
          id: createTestMikaId("price", 3),
          currency: createTestCurrencyCode("USD"),
        }),
      ],
    });
    const repositories = createTestBackendRepositories();
    await repositories.catalog.put(
      createCatalogItemDocument({
        contentRef,
        sellables: [inactiveSellable, inactivePriceSellable, usdSellable],
      }),
    );
    const api = createMikaBackendApi(createIncrementingBackendDependencies({ repositories }));
    const ctx = createTestRequestContext({
      customerId: false,
      userId: false,
      sessionId: "session_wishlist_rejected",
    });

    await expect(api.wishlist.add(ctx, { sellableId: inactiveSellable.id })).resolves.toMatchObject(
      {
        ok: false,
        status: 409,
        error: { code: "SELLABLE_INACTIVE" },
      },
    );
    await expect(
      api.wishlist.add(ctx, {
        sellableId: inactivePriceSellable.id,
        priceId: createTestMikaId("price", 2),
      }),
    ).resolves.toMatchObject({
      ok: false,
      status: 409,
      error: { code: "PRICE_INACTIVE" },
    });
    await expect(
      api.wishlist.add(ctx, {
        sellableId: usdSellable.id,
        priceId: createTestMikaId("price", 3),
      }),
    ).resolves.toMatchObject({
      ok: false,
      status: 422,
      error: { code: "VALIDATION_FAILED", fieldErrors: { priceId: expect.any(String) } },
    });
    await expect(
      repositories.session.findWishlistBySession("session_wishlist_rejected"),
    ).resolves.toBeNull();
  });

  it("moves wishlist items to the cart and merges duplicate cart lines", async () => {
    const contentRef = createTestContentRef();
    const sellable = createSellableDefinition({ maxPerOrder: 5 });
    const repositories = createTestBackendRepositories();
    await repositories.catalog.put(
      createCatalogItemDocument({ contentRef, sellables: [sellable] }),
    );
    const api = createMikaBackendApi(createIncrementingBackendDependencies({ repositories }));
    const ctx = createTestRequestContext({ customerId: false, userId: false });

    const cart = await api.cart.add(ctx, { sellableId: sellable.id, quantity: 1 });
    const wishlist = await api.wishlist.add(ctx, { sellableId: sellable.id });
    if (!cart.ok || !wishlist.ok) {
      throw new Error("Expected cart.add and wishlist.add to succeed.");
    }

    await expect(
      api.wishlist.moveToCart(ctx, { itemId: wishlist.data.items[0]!.id, quantity: 2 }),
    ).resolves.toMatchObject({
      ok: true,
      status: 200,
      data: {
        items: [{ sellableId: sellable.id, quantity: 3, total: { amount: 3600 } }],
        subtotal: { amount: 3600 },
        total: { amount: 3600 },
      },
    });

    const updatedCart = await api.cart.get(ctx);
    const updatedWishlist = await api.wishlist.get(ctx);
    expect(updatedCart).toMatchObject({
      ok: true,
      data: { items: [{ sellableId: sellable.id, quantity: 3 }] },
    });
    expect(updatedWishlist).toMatchObject({ ok: true, data: { items: [] } });
    if (!updatedCart.ok) {
      throw new Error("Expected cart.get to succeed.");
    }
    expect(updatedCart.data.items).toHaveLength(1);
  });

  it("saves cart lines for later and removes them from the cart", async () => {
    const contentRef = createTestContentRef();
    const sellable = createSellableDefinition();
    const repositories = createTestBackendRepositories();
    await repositories.catalog.put(
      createCatalogItemDocument({ contentRef, sellables: [sellable] }),
    );
    const api = createMikaBackendApi(createIncrementingBackendDependencies({ repositories }));
    const ctx = createTestRequestContext({ customerId: false, userId: false });

    const cart = await api.cart.add(ctx, { sellableId: sellable.id, quantity: 2 });
    if (!cart.ok) {
      throw new Error("Expected cart.add to succeed.");
    }

    await expect(
      api.wishlist.saveForLater(ctx, { lineId: cart.data.items[0]!.id }),
    ).resolves.toMatchObject({
      ok: true,
      status: 200,
      data: {
        items: [{ sellableId: sellable.id, priceId: "price_1", title: "Test sellable" }],
      },
    });

    await expect(api.cart.get(ctx)).resolves.toMatchObject({
      ok: true,
      data: { items: [], total: { amount: 0 } },
    });
    await expect(api.wishlist.get(ctx)).resolves.toMatchObject({
      ok: true,
      data: { items: [{ sellableId: sellable.id }] },
    });
  });

  it("merges wishlists with deterministic duplicate handling", async () => {
    const contentRef = createTestContentRef();
    const duplicateSellable = createSellableDefinition({
      id: createTestMikaId("sellable", 1),
    });
    const sourceOnlySellable = createSellableDefinition({
      id: createTestMikaId("sellable", 2),
      sku: "TEST-SKU-2",
      titleSnapshot: "Source only sellable",
      prices: [createPriceDefinition({ id: createTestMikaId("price", 2) })],
    });
    const repositories = createTestBackendRepositories();
    await repositories.catalog.put(
      createCatalogItemDocument({
        contentRef,
        sellables: [duplicateSellable, sourceOnlySellable],
      }),
    );
    const api = createMikaBackendApi(createIncrementingBackendDependencies({ repositories }));
    const sourceCtx = createTestRequestContext({
      customerId: false,
      userId: false,
      sessionId: "session_wishlist_source",
    });
    const targetCtx = createTestRequestContext({
      customerId: "customer_1",
      userId: "user_1",
      sessionId: "session_wishlist_target",
    });

    await api.wishlist.add(sourceCtx, { sellableId: duplicateSellable.id });
    await api.wishlist.add(sourceCtx, { sellableId: sourceOnlySellable.id });
    await api.wishlist.add(targetCtx, { sellableId: duplicateSellable.id });
    const sourceBeforeMerge = await api.wishlist.get(sourceCtx);
    if (!sourceBeforeMerge.ok) {
      throw new Error("Expected source wishlist.get to succeed.");
    }

    await expect(
      api.wishlist.merge(targetCtx, { sourceSessionId: "session_wishlist_source" }),
    ).resolves.toMatchObject({
      ok: true,
      status: 200,
      data: {
        items: [{ sellableId: duplicateSellable.id }, { sellableId: sourceOnlySellable.id }],
      },
    });

    const merged = await api.wishlist.get(targetCtx);
    expect(merged).toMatchObject({
      ok: true,
      data: {
        items: [{ sellableId: duplicateSellable.id }, { sellableId: sourceOnlySellable.id }],
      },
    });
    if (!merged.ok) {
      throw new Error("Expected target wishlist.get to succeed.");
    }
    expect(merged.data.items).toHaveLength(2);
    await expect(
      repositories.session.findWishlistBySession("session_wishlist_source"),
    ).resolves.toBeNull();
    await expect(repositories.session.findById(sourceBeforeMerge.data.id)).resolves.toMatchObject({
      type: "wishlist",
      status: "merged",
    });
  });

  it("returns stable errors for missing wishlist items on remove", async () => {
    const api = createMikaBackendApi(createIncrementingBackendDependencies());
    const ctx = createTestRequestContext({ customerId: false, userId: false });

    await expect(
      api.wishlist.remove(ctx, { itemId: createTestMikaId("wishlist_item", 404) }),
    ).resolves.toMatchObject({
      ok: false,
      status: 404,
      error: {
        code: "VALIDATION_FAILED",
        fieldErrors: { itemId: "Wishlist item was not found." },
      },
    });
  });

  it("dispatches quote, checkout preview, start, and status routes with checkout idempotency", async () => {
    const contentRef = createTestContentRef();
    const sellable = createSellableDefinition({
      prices: [
        createPriceDefinition({
          providerRefs: [
            { provider: TEST_PROVIDER, productId: "prod_route", priceId: "price_route" },
          ],
        }),
      ],
    });
    const repositories = createTestBackendRepositories({
      stockBySellableId: new Map([
        [
          sellable.id,
          createStockRecord({ sellableId: sellable.id, quantityOnHand: 5, quantityReserved: 0 }),
        ],
      ]),
    });
    const fake = createFakeMikaProvider();
    await repositories.catalog.put(
      createCatalogItemDocument({ contentRef, sellables: [sellable] }),
    );
    const api = createMikaBackendApi(
      createIncrementingBackendDependencies({
        repositories,
        providers: createMikaProviderRegistry([fake.provider]),
      }),
    );
    const routes = createMikaPluginRoutes(api);
    const sessionId = "session_checkout_routes";

    const added = await routes[mikaPluginRoutes.cartItems].handler({
      input: { sellableId: sellable.id, priceId: "price_1", quantity: 2 },
      request: new Request("https://shop.example.test/_emdash/api/plugins/mika/cart/items", {
        method: "POST",
      }),
      sessionId,
    });
    if (!isCartRouteResult(added)) {
      throw new Error("Expected cart route to return a cart DTO.");
    }

    await expect(
      routes[mikaPluginRoutes.cartQuote].handler({
        input: { cartId: added.data.id },
        request: new Request("https://shop.example.test/_emdash/api/plugins/mika/cart/quote", {
          method: "POST",
        }),
        sessionId,
      }),
    ).resolves.toMatchObject({
      ok: true,
      status: 200,
      data: {
        cartId: added.data.id,
        status: "valid",
        total: { amount: 2400, currency: TEST_CURRENCY },
      },
    });

    await expect(
      routes[mikaPluginRoutes.checkoutPreview].handler({
        input: { cartId: added.data.id },
        request: new Request(
          "https://shop.example.test/_emdash/api/plugins/mika/checkout/preview",
          { method: "POST" },
        ),
        sessionId,
      }),
    ).resolves.toMatchObject({
      ok: true,
      status: 200,
      data: {
        status: "requires_payment_authorization",
        provider: TEST_PROVIDER,
        quote: {
          cartId: added.data.id,
          total: { amount: 2400, currency: TEST_CURRENCY },
        },
      },
    });

    const startRequest = () =>
      new Request("https://shop.example.test/_emdash/api/plugins/mika/checkout", {
        method: "POST",
        headers: { [MIKA_AGENT_IDEMPOTENCY_KEY_HEADER]: "checkout_route_replay_1" },
      });
    const firstStart = await routes[mikaPluginRoutes.checkout].handler({
      input: { cartId: added.data.id },
      request: startRequest(),
      sessionId,
    });
    const replayStart = await routes[mikaPluginRoutes.checkout].handler({
      input: { cartId: added.data.id },
      request: startRequest(),
      sessionId,
    });

    expect(firstStart).toMatchObject({
      ok: true,
      status: 200,
      data: {
        id: "checkout_1",
        redirectUrl: "https://checkout.example.test/session/checkout_fake",
      },
    });
    expect(replayStart).toMatchObject({
      ok: true,
      status: 200,
      data: {
        id: "checkout_1",
        redirectUrl: "https://checkout.example.test/session/checkout_fake",
      },
    });
    expect(fake.getCalls().createCheckoutSession).toHaveLength(1);

    await expect(
      routes[mikaPluginRoutes.checkoutStatus].handler({
        input: {},
        request: new Request(
          "https://shop.example.test/_emdash/api/plugins/mika/checkout/status?checkoutId=checkout_1",
        ),
        sessionId,
      }),
    ).resolves.toMatchObject({
      ok: true,
      status: 200,
      data: {
        id: "checkout_1",
        status: "created",
        redirectUrl: "https://checkout.example.test/session/checkout_fake",
      },
      effects: [{ type: "redirect", url: "https://checkout.example.test/session/checkout_fake" }],
    });
  });
});

describe("backend fixture helpers", () => {
  it("returns deterministic time, IDs, providers, currency, and hashes", () => {
    const clock = createTestClock();

    expect(clock.iso).toBe(TEST_NOW);
    expect(clock.now.toISOString()).toBe("2026-01-01T00:00:00.000Z");
    expect(clock.isoAt(60_000)).toBe("2026-01-01T00:01:00.000Z");
    expect(createTestMikaId("order", 7)).toBe("order_7");
    expect(createTestProviderName("stripe")).toBe("stripe");
    expect(createTestCurrencyCode("USD")).toBe("USD");
    expect(TEST_PROVIDER).toBe("fake");
    expect(TEST_CURRENCY).toBe("EUR");
    expect(createTestHash("checkout:1")).toBe(createTestHash("checkout:1"));
    expect(createTestHash("checkout:1")).not.toBe(createTestHash("checkout:2"));
  });

  it("creates request contexts with request, URL, identity, idempotency key, and locale", async () => {
    const context = createTestRequestContext({
      method: "POST",
      customerId: "customer_99",
      userId: "user_99",
      sessionId: "session_99",
      idempotencyKey: "idem_99",
      locale: "de-AT",
    });

    expect(context.request).toBeInstanceOf(Request);
    expect(context.request?.method).toBe("POST");
    expect(context.url?.href).toBe("https://shop.example.test/products/test-product?ref=test");
    expect(context.method).toBe("POST");
    expect(context.sessionId).toBe("session_99");
    expect(context.session?.sessionID).toBe("session_99");
    expect(context.customerId).toBe("customer_99");
    expect(context.userId).toBe("user_99");
    expect(context.idempotencyKey).toBe("idem_99");
    expect(context.locale).toBe("de-AT");
    expect(context.now).toBe(TEST_NOW);

    await context.session?.set("cartId", "cart_1");
    await expect(context.session?.get("cartId")).resolves.toBe("cart_1");
  });

  it("can omit optional request context identity fields", () => {
    const context = createTestRequestContext({
      sessionId: false,
      customerId: false,
      userId: false,
      idempotencyKey: false,
      locale: false,
    });

    expect(context.sessionId).toBeUndefined();
    expect(context.session).toBeUndefined();
    expect(context.customerId).toBeUndefined();
    expect(context.userId).toBeUndefined();
    expect(context.idempotencyKey).toBeUndefined();
    expect(context.locale).toBeUndefined();
  });

  it("creates common content, sellable, and price DTO fixtures", () => {
    const contentRef = createTestContentRef({ id: "special-product" });
    const sellable = createTestSellableDTO({
      contentRef,
      title: "Special product",
      prices: [
        {
          id: createTestMikaId("price", 2),
          sellableId: createTestMikaId("sellable", 1),
          amount: 2500,
          currency: createTestCurrencyCode("USD"),
          mode: "subscription",
          fulfillmentKind: "entitlement",
          interval: "month",
          intervalCount: 1,
          active: true,
        },
      ],
    });

    expect(sellable).toMatchObject({
      id: "sellable_1",
      contentRef: { collection: "products", id: "special-product", locale: "en-IE" },
      title: "Special product",
      active: true,
      prices: [
        {
          id: "price_2",
          sellableId: "sellable_1",
          amount: 2500,
          currency: "USD",
          mode: "subscription",
          fulfillmentKind: "entitlement",
          interval: "month",
          active: true,
        },
      ],
    });
  });
});

async function createSeededCollection(): Promise<StorageCollection<MemoryRecord>> {
  const collection = createMemoryStorageCollection<MemoryRecord>();

  await collection.putMany([
    { id: "record_1", data: createRecord({ name: "Alpha", amount: 10, type: "account" }) },
    {
      id: "record_2",
      data: createRecord({ name: "Beta", amount: 20, status: "archived" }),
    },
    { id: "record_3", data: createRecord({ name: "Gamma", amount: 30 }) },
    { id: "record_4", data: createRecord({ name: "Delta", amount: 40 }) },
  ]);

  return collection;
}

function createTransactionTestMikaDb(): {
  readonly db: MikaDb;
  readonly destroy: () => Promise<void>;
} {
  const dir = mkdtempSync(join(tmpdir(), "emdash-mika-stock-"));
  const db = new Kysely<MikaDatabase>({
    dialect: new LibsqlDialect({ url: `file:${join(dir, "test.db")}` }),
  });

  return {
    db,
    destroy: async () => {
      await db.destroy();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

async function listMikaTableNames(db: MikaDbExecutor): Promise<readonly string[]> {
  const result = await sql<{ name: string }>`
    select name
    from sqlite_master
    where type = 'table' and name like 'mika_%'
    order by name
  `.execute(db);

  return result.rows.map((row) => row.name);
}

async function countStockEvents(db: MikaDbExecutor): Promise<number> {
  const result = await sql<{ count: number }>`
    select count(*) as count from mika_stock_events
  `.execute(db);

  return result.rows[0]?.count ?? 0;
}

async function rollbackMikaInitialMigration(db: MikaDbExecutor): Promise<void> {
  if (!mikaInitialMigration.down) {
    throw new Error("Mika initial migration is missing a down migration.");
  }

  await mikaInitialMigration.down(db);
}

function createRecord(overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  return {
    type: "order",
    name: "Record",
    status: "active",
    amount: 0,
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function createTestBackendDependencies(
  overrides: Partial<CreateMikaBackendApiInput> = {},
): CreateMikaBackendApiInput {
  const providers = createMikaProviderRegistry([createFakeMikaProvider().provider]);

  return {
    repositories: createTestBackendRepositories(),
    providers,
    now: () => createTestClock().now,
    isoNow: () => createTestClock().iso,
    createId: (namespace) => createTestMikaId(namespace, 1),
    hash: (input) =>
      createTestHash(typeof input === "string" ? input : new TextDecoder().decode(input)),
    defaults: {
      currency: TEST_CURRENCY,
      locale: "en-IE",
      provider: TEST_PROVIDER,
    },
    config: {
      checkout: {
        successUrl: "https://shop.example.test/success",
        cancelUrl: "https://shop.example.test/cancel",
      },
    },
    ...overrides,
  };
}

function createIncrementingBackendDependencies(
  overrides: Partial<CreateMikaBackendApiInput> = {},
): CreateMikaBackendApiInput {
  const counts = new Map<string, number>();

  return createTestBackendDependencies({
    createId: (namespace) => {
      const count = (counts.get(namespace) ?? 0) + 1;
      counts.set(namespace, count);

      return createTestMikaId(namespace, count);
    },
    ...overrides,
  });
}

function createTestBackendRepositories(
  options: {
    readonly stockBySellableId?: ReadonlyMap<string, StockItemRecord>;
  } = {},
): MikaBackendRepositories {
  const db = createUnusedDbExecutor();

  return {
    catalog: new CatalogRepository(createStorageCollection("catalog")),
    session: new SessionRepository(createStorageCollection("session")),
    account: new AccountRepository(createStorageCollection("account")),
    ledger: new LedgerRepository(createStorageCollection("ledger")),
    ops: new OpsRepository(createStorageCollection("ops")),
    stock: createTestStockRepository(options.stockBySellableId),
    ephemeral: new EphemeralRepository(db),
  } satisfies MikaBackendRepositories;
}

function createTestStockRepository(
  stockBySellableId: ReadonlyMap<string, StockItemRecord> = new Map(),
): MikaBackendRepositories["stock"] {
  const stockItems =
    stockBySellableId instanceof Map ? stockBySellableId : new Map(stockBySellableId);
  const eventsById = new Map<string, StockEventRecord>();
  const eventsByIdempotencyKey = new Map<string, StockEventRecord>();

  return {
    async findItemById(stockItemId) {
      return Array.from(stockItems.values()).find((stock) => stock.id === stockItemId) ?? null;
    },
    async findBySellableId(sellableId) {
      return stockItems.get(sellableId) ?? null;
    },
    async findEventByIdempotencyKey(idempotencyKey) {
      return eventsByIdempotencyKey.get(idempotencyKey) ?? null;
    },
    async findEventById(stockEventId) {
      return eventsById.get(stockEventId) ?? null;
    },
    async putItem(stock) {
      stockItems.set(stock.sellableId, stock);
    },
    async insertEvent(event) {
      eventsById.set(event.id, event);
      if (event.idempotencyKey) {
        eventsByIdempotencyKey.set(event.idempotencyKey, event);
      }
    },
    async reserve(reservation) {
      const replayed = reservation.idempotencyKey
        ? eventsByIdempotencyKey.get(reservation.idempotencyKey)
        : undefined;
      if (replayed) {
        return {
          status: "replayed",
          event: replayed,
          stock:
            Array.from(stockItems.values()).find((stock) => stock.id === replayed.stockItemId) ??
            null,
        };
      }

      const current =
        Array.from(stockItems.values()).find((stock) => stock.id === reservation.stockItemId) ??
        null;
      if (!current) return { status: "not_found" };

      const availableQuantity = current.quantityOnHand - current.quantityReserved;
      const canReserve =
        current.availableOverride !== false &&
        (current.availableOverride === true ||
          current.policy !== "finite" ||
          current.allowBackorder ||
          reservation.quantity <= availableQuantity);
      if (!canReserve) {
        return { status: "insufficient_stock", stock: current };
      }

      const stock: StockItemRecord = {
        ...current,
        quantityReserved: current.quantityReserved + reservation.quantity,
        updatedAt: reservation.now,
      };
      const event: StockEventRecord = {
        id: reservation.reservationEventId,
        stockItemId: reservation.stockItemId,
        kind: "reservation",
        status: "active",
        cartId: reservation.cartId,
        checkoutSessionId: reservation.checkoutSessionId,
        customerId: reservation.customerId,
        sessionId: reservation.sessionId,
        idempotencyKey: reservation.idempotencyKey,
        quantityDelta: reservation.quantity,
        expiresAt: reservation.expiresAt,
        createdAt: reservation.now,
        updatedAt: reservation.now,
        metadata: reservation.metadata,
      };
      stockItems.set(stock.sellableId, stock);
      eventsById.set(event.id, event);
      if (event.idempotencyKey) {
        eventsByIdempotencyKey.set(event.idempotencyKey, event);
      }

      return { status: "reserved", event, stock };
    },
    async release(release) {
      const event = eventsById.get(release.reservationEventId);
      if (!event) return { status: "not_found" };

      const current =
        Array.from(stockItems.values()).find((stock) => stock.id === event.stockItemId) ?? null;
      if (event.status !== "active") {
        return { status: "not_active", event, stock: current };
      }

      const releasedEvent: StockEventRecord = {
        ...event,
        status: "released",
        updatedAt: release.now,
      };
      const stock = current
        ? {
            ...current,
            quantityReserved: Math.max(0, current.quantityReserved - event.quantityDelta),
            updatedAt: release.now,
          }
        : null;
      eventsById.set(releasedEvent.id, releasedEvent);
      if (releasedEvent.idempotencyKey) {
        eventsByIdempotencyKey.set(releasedEvent.idempotencyKey, releasedEvent);
      }
      if (stock) {
        stockItems.set(stock.sellableId, stock);
      }

      return stock
        ? { status: "released", event: releasedEvent, stock }
        : { status: "not_active", event: releasedEvent, stock };
    },
    async consume(consume) {
      const event = eventsById.get(consume.reservationEventId);
      if (!event || event.kind !== "reservation") return { status: "not_found" };

      const current =
        Array.from(stockItems.values()).find((stock) => stock.id === event.stockItemId) ?? null;
      if (event.status !== "active") {
        return { status: "not_active", event, stock: current };
      }

      const consumedEvent: StockEventRecord = {
        ...event,
        status: "consumed",
        orderId: consume.orderId,
        orderLineId: consume.orderLineId,
        updatedAt: consume.now,
      };
      const stock = current
        ? {
            ...current,
            quantityOnHand: current.quantityOnHand - event.quantityDelta,
            quantityReserved: Math.max(0, current.quantityReserved - event.quantityDelta),
            updatedAt: consume.now,
          }
        : null;
      eventsById.set(consumedEvent.id, consumedEvent);
      if (consumedEvent.idempotencyKey) {
        eventsByIdempotencyKey.set(consumedEvent.idempotencyKey, consumedEvent);
      }
      if (stock) {
        stockItems.set(stock.sellableId, stock);
      }

      return stock
        ? { status: "consumed", event: consumedEvent, stock }
        : { status: "not_active", event: consumedEvent, stock };
    },
    async releaseExpiredReservations() {
      return { scannedCount: 0, releasedCount: 0, stockItemsAffected: 0 };
    },
    async adjustStock() {
      throw new Error("The test stock repository does not implement adjustStock().");
    },
  };
}

function createStorageCollection<TName extends keyof MikaStorageDocuments>(
  _name: TName,
): StorageCollection<MikaStorageDocuments[TName]> {
  return createMemoryStorageCollection<MikaStorageDocuments[TName]>();
}

function createUnusedDbExecutor(): MikaDbExecutor {
  return {} as MikaDbExecutor;
}

function isCartRouteResult(
  result: unknown,
): result is { readonly ok: true; readonly data: CartDTO } {
  return (
    typeof result === "object" &&
    result !== null &&
    "ok" in result &&
    result.ok === true &&
    "data" in result
  );
}

function createCustomerDocument(overrides: Partial<CustomerDocument> = {}): CustomerDocument {
  return {
    id: createTestMikaId("customer_document", 1),
    type: "customer",
    schemaVersion: 1,
    customerId: createTestMikaId("customer", 1),
    userId: "user_1",
    emailHash: createTestHash("email:subscriber@example.test"),
    aggregate: {
      schemaVersion: 1,
      email: "Subscriber@Example.test",
      emailHash: createTestHash("email:subscriber@example.test"),
      name: "Subscriber One",
    },
    createdAt: TEST_NOW,
    updatedAt: TEST_NOW,
    ...overrides,
  };
}

function createProviderAccountDocument(
  overrides: Partial<ProviderAccountDocument> = {},
): ProviderAccountDocument {
  const provider = overrides.provider ?? TEST_PROVIDER;
  const providerCustomerId = overrides.providerCustomerId ?? "provider_customer_1";
  const customerId = overrides.customerId ?? createTestMikaId("customer", 1);
  const record = {
    id: overrides.id ?? createTestMikaId("provider_account", 1),
    customerId,
    provider,
    providerCustomerId,
    emailSnapshot: "Subscriber@Example.test",
    createdAt: TEST_NOW,
    updatedAt: TEST_NOW,
    ...overrides.record,
  };

  return {
    id: record.id,
    type: "providerAccount",
    schemaVersion: 1,
    customerId: record.customerId,
    provider: record.provider,
    providerCustomerId: record.providerCustomerId,
    record,
    createdAt: TEST_NOW,
    updatedAt: TEST_NOW,
    ...overrides,
  };
}

function createCatalogItemDocument(input: {
  readonly contentRef: ReturnType<typeof createTestContentRef>;
  readonly sellables: readonly SellableDefinition[];
}): CatalogItemDocument {
  return {
    id: createTestMikaId("catalog", 1),
    type: "catalogItem",
    schemaVersion: 1,
    contentCollection: input.contentRef.collection,
    contentId: input.contentRef.id,
    active: true,
    titleSnapshot: "Test product",
    aggregate: {
      schemaVersion: 1,
      content: input.contentRef,
      titleSnapshot: "Test product",
      sellables: input.sellables,
    },
    createdAt: TEST_NOW,
    updatedAt: TEST_NOW,
  };
}

function createSellableDefinition(overrides: Partial<SellableDefinition> = {}): SellableDefinition {
  return {
    id: createTestMikaId("sellable", 1),
    sku: "TEST-SKU-1",
    titleSnapshot: "Test sellable",
    variantOptions: [],
    active: true,
    sortOrder: 1,
    prices: [createPriceDefinition()],
    ...overrides,
  };
}

function createPriceDefinition(overrides: Partial<PriceDefinition> = {}): PriceDefinition {
  return {
    id: createTestMikaId("price", 1),
    providerRefs: [],
    amount: 1200,
    currency: TEST_CURRENCY,
    mode: "payment",
    fulfillmentKind: "none",
    active: true,
    ...overrides,
  };
}

function createStockRecord(overrides: Partial<StockItemRecord> = {}): StockItemRecord {
  const sellableId = overrides.sellableId ?? createTestMikaId("sellable", 1);

  return {
    id: createTestMikaId("stock", 1),
    sellableId,
    policy: "finite",
    quantityOnHand: 5,
    quantityReserved: 3,
    lowStockThreshold: 2,
    allowBackorder: false,
    createdAt: TEST_NOW,
    updatedAt: TEST_NOW,
    ...overrides,
  };
}

function createCheckoutDocument(
  overrides: {
    readonly id?: CheckoutDocument["id"];
    readonly status?: CheckoutDocument["status"];
    readonly providerCheckoutId?: string;
    readonly bindingProviderCheckoutId?: string;
    readonly expiresAt?: CheckoutDocument["expiresAt"];
    readonly metadata?: CheckoutDocument["aggregate"]["metadata"];
  } = {},
): CheckoutDocument {
  const id = overrides.id ?? createTestMikaId("checkout", 1);
  const providerCheckoutId = overrides.providerCheckoutId ?? "provider_checkout_fake";

  return {
    id,
    type: "checkout",
    schemaVersion: 1,
    provider: TEST_PROVIDER,
    providerCheckoutId,
    status: overrides.status ?? "created",
    expiresAt: overrides.expiresAt ?? createTestClock().isoAt(60 * 60_000),
    aggregate: {
      schemaVersion: 1,
      mode: "payment",
      currency: TEST_CURRENCY,
      lines: [],
      totals: {
        subtotal: { amount: 0, currency: TEST_CURRENCY },
        total: { amount: 0, currency: TEST_CURRENCY },
      },
      binding: {
        provider: TEST_PROVIDER,
        providerCheckoutId: overrides.bindingProviderCheckoutId ?? providerCheckoutId,
        returnPath: "/checkout",
        cancelPath: "/checkout/cancel",
        successPath: "/checkout/success",
      },
      metadata: overrides.metadata,
    },
    createdAt: TEST_NOW,
    updatedAt: TEST_NOW,
  };
}

function createCheckoutInput(
  overrides: Partial<MikaProviderCheckoutInput> = {},
): MikaProviderCheckoutInput {
  return {
    mode: "payment",
    provider: createProviderName("fake"),
    lines: [
      {
        sellableId: createMikaId("sellable_1"),
        contentRef: { collection: "products", id: "product_1" },
        title: "Test product",
        quantity: 1,
        unitAmount: 1200,
        currency: createCurrencyCode("EUR"),
        mode: "payment",
        fulfillmentKind: "none",
      },
    ],
    successUrl: "https://shop.example.test/success",
    cancelUrl: "https://shop.example.test/cancel",
    ...overrides,
  };
}

function receiveWebhook(api: MikaApi, marker: string, provider = TEST_PROVIDER) {
  return api.webhook.receive(
    createTestRequestContext({
      request: createWebhookRequest(JSON.stringify({ marker })),
      sessionId: false,
      customerId: false,
      userId: false,
      idempotencyKey: false,
    }),
    { provider },
  );
}

function createWebhookRequest(
  rawBody = "{}",
  path = "/_emdash/api/plugins/mika/webhooks",
): Request {
  return new Request(new URL(path, "https://shop.example.test").toString(), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-test-signature": "signature_1",
    },
    body: rawBody,
  });
}

function createVerifiedWebhookPayload(
  input: MikaProviderWebhookVerificationInput,
  overrides: Partial<Omit<MikaVerifiedWebhookPayload, "provider" | "rawBody">> = {},
): MikaVerifiedWebhookPayload {
  return {
    provider: input.provider,
    rawBody: input.rawBody,
    payloadHash: "hash_1",
    headers: Object.fromEntries(input.request.headers.entries()),
    ...overrides,
  };
}

function createWebhookEvent(
  verified: MikaVerifiedWebhookPayload,
  overrides: {
    readonly providerEventId?: string;
    readonly type?: string;
  } = {},
): MikaProviderWebhookEvent {
  return {
    kind: "unknown",
    provider: verified.provider,
    providerEventId: overrides.providerEventId,
    type: overrides.type ?? "test.webhook",
  };
}

function createPaymentWebhookEvent(
  verified: MikaVerifiedWebhookPayload,
  overrides: {
    readonly providerEventId?: string;
    readonly type?: string;
    readonly providerCheckoutId?: string;
    readonly providerPaymentId?: string;
    readonly providerOrderId?: string;
    readonly invoiceUrl?: string;
    readonly customer?: Extract<MikaProviderWebhookEvent, { readonly kind: "payment" }>["customer"];
  } = {},
): MikaProviderWebhookEvent {
  return {
    kind: "payment",
    provider: verified.provider,
    providerEventId: overrides.providerEventId,
    type: overrides.type ?? "payment.completed",
    providerCheckoutId: overrides.providerCheckoutId,
    providerPaymentId: overrides.providerPaymentId,
    providerOrderId: overrides.providerOrderId,
    customer: overrides.customer,
    lines: [],
    invoiceUrl: overrides.invoiceUrl,
  };
}

function createSubscriptionWebhookEvent(
  verified: MikaVerifiedWebhookPayload,
  overrides: {
    readonly providerEventId?: string;
    readonly type?: string;
    readonly providerSubscriptionId?: string;
    readonly providerCustomerId?: string;
    readonly providerPriceId?: string;
    readonly status?: Extract<
      MikaProviderWebhookEvent,
      { readonly kind: "subscription" }
    >["status"];
    readonly currentPeriodStart?: Extract<
      MikaProviderWebhookEvent,
      { readonly kind: "subscription" }
    >["currentPeriodStart"];
    readonly currentPeriodEnd?: Extract<
      MikaProviderWebhookEvent,
      { readonly kind: "subscription" }
    >["currentPeriodEnd"];
    readonly cancelAtPeriodEnd?: boolean;
  } = {},
): MikaProviderWebhookEvent {
  return {
    kind: "subscription",
    provider: verified.provider,
    providerEventId: overrides.providerEventId,
    type: overrides.type ?? "customer.subscription.updated",
    providerSubscriptionId: overrides.providerSubscriptionId,
    providerCustomerId: overrides.providerCustomerId,
    providerPriceId: overrides.providerPriceId,
    status: overrides.status ?? "active",
    currentPeriodStart: overrides.currentPeriodStart,
    currentPeriodEnd: overrides.currentPeriodEnd,
    cancelAtPeriodEnd: overrides.cancelAtPeriodEnd,
  };
}

function createWebhookInput(
  provider: MikaProviderWebhookVerificationInput["provider"],
): MikaProviderWebhookVerificationInput {
  return {
    provider,
    request: new Request("https://shop.example.test/webhook", {
      headers: { "x-test-signature": "signature_1" },
    }),
    rawBody: new TextEncoder().encode("{}"),
  };
}
