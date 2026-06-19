import { describe, expect, expectTypeOf, it } from "vite-plus/test";

import {
  createMikaBackendApi,
  type CreateMikaBackendApiInput,
  type MikaBackendDependencies,
  type MikaBackendRepositories,
} from "../src/api/backend";
import type { StorageCollection } from "../src/storage/collections";
import type { MikaProviderCapability } from "../src/api/types";
import { mikaApiMethodNames, type MikaApi } from "../src/api/server";
import type {
  MikaProviderAdapter,
  MikaProviderCheckoutInput,
  MikaProviderWebhookVerificationInput,
} from "../src/provider";
import { createMikaProviderRegistry } from "../src/provider";
import type { MikaStorageDocuments } from "../src/types/documents";
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
import { createCurrencyCode, createMikaId, createProviderName } from "../src/types/primitives";
import {
  TEST_CURRENCY,
  TEST_NOW,
  TEST_PROVIDER,
  createTestClock,
  createTestContentRef,
  createTestCurrencyCode,
  createTestHash,
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
      status: 501,
      error: {
        code: "NOT_IMPLEMENTED",
        message: "Mika API 'stock.availability' has not been wired yet.",
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

function createTestBackendRepositories(): MikaBackendRepositories {
  const db = createUnusedDbExecutor();

  return {
    catalog: new CatalogRepository(createStorageCollection("catalog")),
    session: new SessionRepository(createStorageCollection("session")),
    account: new AccountRepository(createStorageCollection("account")),
    ledger: new LedgerRepository(createStorageCollection("ledger")),
    ops: new OpsRepository(createStorageCollection("ops")),
    stock: new StockRepository(db),
    ephemeral: new EphemeralRepository(db),
  } satisfies MikaBackendRepositories;
}

function createStorageCollection<TName extends keyof MikaStorageDocuments>(
  _name: TName,
): StorageCollection<MikaStorageDocuments[TName]> {
  return createMemoryStorageCollection<MikaStorageDocuments[TName]>();
}

function createUnusedDbExecutor(): MikaDbExecutor {
  return {} as MikaDbExecutor;
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
