import { describe, expect, expectTypeOf, it } from "vite-plus/test";
import { sql } from "kysely";

import {
  createMikaBackendApi,
  type CreateMikaBackendApiInput,
  type MikaBackendDependencies,
  type MikaBackendRepositories,
} from "../src/api/backend";
import { callMikaOperation, mikaActionDefinitions } from "../src/api/operations";
import { createMikaPluginRoutes } from "../src/api/route-handlers";
import { mikaPluginRoutes } from "../src/api/routes";
import type { StorageCollection } from "../src/storage/collections";
import { MIKA_ERROR_CODES, type CartDTO, type MikaProviderCapability } from "../src/api/types";
import { createMikaApi, mikaApiMethodNames, type MikaApi } from "../src/api/server";
import type {
  MikaProviderAdapter,
  MikaProviderCheckoutInput,
  MikaProviderWebhookVerificationInput,
} from "../src/provider";
import { createMikaProviderRegistry } from "../src/provider";
import type { PriceDefinition, SellableDefinition } from "../src/types/aggregates";
import type { CatalogItemDocument, MikaStorageDocuments } from "../src/types/documents";
import type { StockItemRecord } from "../src/types/operational";
import {
  AccountRepository,
  CatalogRepository,
  EphemeralRepository,
  LedgerRepository,
  OpsRepository,
  SessionRepository,
  StockRepository,
  type MikaDbExecutor,
} from "../src/storage/repositories";
import { mikaInitialMigration } from "../src/storage/migrations";
import { createCurrencyCode, createMikaId, createProviderName } from "../src/types/primitives";
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
      expect.arrayContaining(["SELLABLE_NOT_FOUND", "VALIDATION_FAILED"]),
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
    const ctx = createTestRequestContext({ customerId: false, userId: false });

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
    const ctx = createTestRequestContext({ customerId: false, userId: false });

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
    const ctx = createTestRequestContext({ customerId: false, userId: false });

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

  it("rejects inactive sellables, inactive prices, currency mismatches, and max quantity before creating a cart", async () => {
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
    const repositories = createTestBackendRepositories();
    await repositories.catalog.put(
      createCatalogItemDocument({
        contentRef,
        sellables: [inactiveSellable, inactivePriceSellable, usdSellable, limitedSellable],
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

async function listMikaTableNames(db: MikaDbExecutor): Promise<readonly string[]> {
  const result = await sql<{ name: string }>`
    select name
    from sqlite_master
    where type = 'table' and name like 'mika_%'
    order by name
  `.execute(db);

  return result.rows.map((row) => row.name);
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
  return {
    async findBySellableId(sellableId) {
      return stockBySellableId.get(sellableId) ?? null;
    },
    async putItem() {
      // No-op test double.
    },
    async insertEvent() {
      // No-op test double.
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
