/**
 * Backend API integration tests for Mika operations and storage.
 * Exercises repositories, route handlers, checkout flows, and notification hooks.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { LibsqlDialect } from "@libsql/kysely-libsql";
import { describe, expect, expectTypeOf, it } from "vite-plus/test";
import { Kysely, sql } from "kysely";

import {
  createMikaStockLifecycleService,
  createMikaBackendApi,
  createMikaFixedRateCouponResolver,
  type CreateMikaBackendApiInput,
  type MikaBackendDependencies,
  type MikaBackendRepositories,
  type MikaAccountDeleteJobRepositoryPort,
  type MikaAccountRepositoryPort,
  type MikaAdminAuditRepositoryPort,
  type MikaCatalogRepositoryPort,
  type MikaEmailOutboxRepositoryPort,
  type MikaEphemeralRepositoryPort,
  type MikaLedgerRepositoryPort,
  type MikaOpsRepositoryPort,
  type MikaSessionRepositoryPort,
  type MikaStockRepositoryPort,
  type MikaWebhookRepositoryPort,
  type MikaWorkflowRepositoryPort,
} from "../src/api/backend";
import { MIKA_AGENT_IDEMPOTENCY_KEY_HEADER } from "../src/api/agent-types";
import { callMikaOperation, mikaActionDefinitions } from "../src/api/operations";
import { createMikaPluginRoutes } from "../src/api/route-handlers";
import { mikaPluginRoutes } from "../src/api/routes";
import { formatSubjectRef, parseSubjectRef, subjectHashCandidates } from "../src/api/subject-ref";
import { createMikaStorageConfig, type StorageCollection } from "../src/storage/collections";
import {
  MIKA_ERROR_CODES,
  type CartDTO,
  type MikaApiResult,
  type MikaProviderCapability,
} from "../src/api/types";
import {
  assertMikaApiWired,
  createMikaApi,
  mikaApiMethodNames,
  type MikaApi,
  type MikaApiOverrides,
} from "../src/api/server";
import {
  createEmDashMikaEmailSender,
  createMikaEmailOutboxRunner,
  createMikaMaintenanceRunner,
  type MikaEmailDeliveryMessage,
  type MikaNotificationHook,
  type MikaNotificationIntent,
} from "../src/server";
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
  AdminAuditDocument,
  CartDocument,
  CheckoutDocument,
  CustomerDocument,
  EmailDocument,
  ProviderAccountDocument,
  EntitlementDocument,
  LicenseDocument,
  MikaStorageDocuments,
  OrderDocument,
  SubscriptionDocument,
  WebhookDocument,
  WorkflowDocument,
} from "../src/types/documents";
import type { EphemeralRecord, StockEventRecord, StockItemRecord } from "../src/types/operational";
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
  isJsonObject,
  isJsonValue,
  type ISODateTime,
  type JsonObject,
  type MikaId,
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
import { expectMethodBackedProviderCapabilities } from "./helpers/provider-contract";
import {
  createMemoryStorageCollection,
  createMemoryStorageCollectionWithConfig,
} from "./helpers/storage";

type MemoryRecord = {
  readonly type: "account" | "order";
  readonly name: string;
  readonly status: "active" | "archived" | "queued";
  readonly amount: number;
  readonly createdAt: string;
  readonly priority?: number;
};

describe("isJsonValue / isJsonObject", () => {
  it("accepts valid JSON that reuses a non-cyclic object reference (diamond)", () => {
    const ref = { v: 1 };
    const value = { a: ref, b: ref };

    expect(() => JSON.stringify(value)).not.toThrow();
    expect(isJsonValue(value)).toBe(true);
    expect(isJsonObject(value)).toBe(true);

    expect(isJsonValue([ref, ref, { nested: ref }])).toBe(true);
  });

  it("still rejects true cycles", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic["self"] = cyclic;
    expect(isJsonValue(cyclic)).toBe(false);

    const a: Record<string, unknown> = {};
    const b: Record<string, unknown> = { a };
    a["b"] = b;
    expect(isJsonValue({ a, b })).toBe(false);
  });

  it("rejects non-JSON leaves", () => {
    expect(isJsonValue(Number.POSITIVE_INFINITY)).toBe(false);
    expect(isJsonValue({ fn: () => 1 })).toBe(false);
    expect(isJsonValue(undefined)).toBe(false);
  });
});

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

  it("declares checkout, workflow, and account list index coverage", () => {
    const config = createMikaStorageConfig();

    expect(config.session.indexes).toEqual(
      expect.arrayContaining([["type", "checkoutIdempotencyKey"]]),
    );
    expect(config.session.uniqueIndexes).toEqual(
      expect.arrayContaining([["type", "checkoutIdempotencyKey"]]),
    );
    expect(config.ops.indexes).toEqual(
      expect.arrayContaining([
        ["type", "kind", "status", "nextAttemptAt"],
        ["type", "kind", "subjectType", "subjectId"],
        ["type", "kind", "idempotencyKey"],
        ["type", "action", "idempotencyKey"],
      ]),
    );
    expect(config.ops.uniqueIndexes).toEqual(
      expect.arrayContaining([
        ["type", "kind", "idempotencyKey"],
        ["type", "kind", "subjectType", "subjectId"],
        ["type", "action", "idempotencyKey"],
      ]),
    );
    expect(config.account.indexes).toEqual(
      expect.arrayContaining([
        ["type", "customerId", "updatedAt"],
        ["type", "userId", "updatedAt"],
        ["type", "emailHash", "updatedAt"],
        ["type", "customerId", "currentPeriodEnd"],
      ]),
    );
  });

  it("keeps concrete repositories aligned with backend ports", () => {
    expectTypeOf<CatalogRepository>().toMatchTypeOf<MikaCatalogRepositoryPort>();
    expectTypeOf<SessionRepository>().toMatchTypeOf<MikaSessionRepositoryPort>();
    expectTypeOf<AccountRepository>().toMatchTypeOf<MikaAccountRepositoryPort>();
    expectTypeOf<LedgerRepository>().toMatchTypeOf<MikaLedgerRepositoryPort>();
    expectTypeOf<OpsRepository>().toMatchTypeOf<MikaOpsRepositoryPort>();
    expectTypeOf<StockRepository>().toMatchTypeOf<MikaStockRepositoryPort>();
    expectTypeOf<EphemeralRepository>().toMatchTypeOf<MikaEphemeralRepositoryPort>();
    expectTypeOf(createTestStockRepository()).toMatchTypeOf<MikaStockRepositoryPort>();
  });

  it("lets a host target a single ops concern via the segregated per-store ports", () => {
    // MikaOpsRepositoryPort is one flat interface because OpsRepository backs every ops concern
    // with a single storage collection, but the port itself is composed from five independently
    // satisfiable pieces so a host implementing only e.g. a custom email outbox isn't forced to
    // also implement webhook, workflow, admin-audit, and account-delete-job methods.
    expectTypeOf<OpsRepository>().toMatchTypeOf<MikaWebhookRepositoryPort>();
    expectTypeOf<OpsRepository>().toMatchTypeOf<MikaAccountDeleteJobRepositoryPort>();
    expectTypeOf<OpsRepository>().toMatchTypeOf<MikaWorkflowRepositoryPort>();
    expectTypeOf<OpsRepository>().toMatchTypeOf<MikaAdminAuditRepositoryPort>();
    expectTypeOf<OpsRepository>().toMatchTypeOf<MikaEmailOutboxRepositoryPort>();
  });

  it("enforces configured unique indexes in memory storage", async () => {
    const collection = createMemoryStorageCollectionWithConfig<MemoryRecord>({
      uniqueIndexes: [["type", "name"]],
    });
    await collection.put("record_1", createRecord({ type: "order", name: "Alpha" }));

    await expect(
      collection.put("record_2", createRecord({ type: "order", name: "Alpha" })),
    ).rejects.toThrow("Unique storage index violation");
  });

  it("does not claim a failed admin idempotency retry when another retry already started", async () => {
    const baseCollection = createStorageCollection("ops");
    const failed = createAdminAuditTestDocument({
      id: createTestMikaId("admin_audit", 1),
      status: "failed",
    });
    const started = createAdminAuditTestDocument({
      id: failed.id,
      status: "started",
    });
    const retry = createAdminAuditTestDocument({
      id: createTestMikaId("admin_audit", 2),
      status: "started",
    });
    await baseCollection.put(failed.id, started);
    let returnStaleFailure = true;
    const staleLookupCollection: StorageCollection<MikaStorageDocuments["ops"]> = {
      ...baseCollection,
      query: async (options) => {
        if (returnStaleFailure) {
          returnStaleFailure = false;

          return { items: [{ id: failed.id, data: failed }], hasMore: false };
        }

        return baseCollection.query(options);
      },
    };
    const ops = new OpsRepository(staleLookupCollection);

    await expect(ops.claimAdminAuditIdempotency(retry)).resolves.toMatchObject({
      status: "existing",
      audit: { id: failed.id, status: "started" },
    });
  });

  it("does not report a stale reclaim when an optimistic-retry adapter re-invokes the updater", async () => {
    // The update() contract allows adapters to re-invoke the updater on write contention. A
    // first invocation may see a "failed" audit and tentatively decide to reclaim it, but if a
    // concurrent call already claimed it before this call's write lands, the adapter's retry
    // sees the already-"started" state and must return it unchanged — the repository must not
    // report "claimed" (crediting this call for someone else's reclaim) from a stale flag set by
    // the earlier, uncommitted invocation.
    const baseCollection = createStorageCollection("ops");
    const failed = createAdminAuditTestDocument({
      id: createTestMikaId("admin_audit", 1),
      status: "failed",
    });
    await baseCollection.put(failed.id, failed);
    const retry = createAdminAuditTestDocument({
      id: createTestMikaId("admin_audit", 2),
      status: "started",
    });
    const concurrentlyClaimed = createAdminAuditTestDocument({
      id: failed.id,
      status: "started",
    });

    let invocationCount = 0;
    const retryingCollection: StorageCollection<MikaStorageDocuments["ops"]> = {
      ...baseCollection,
      async update(id, updater) {
        // Simulate an optimistic-retry adapter: invoke the updater against the current state,
        // then invoke it again against a state a concurrent call already claimed (no longer
        // "failed"), and only commit the second, later invocation's result.
        invocationCount += 1;
        updater(await baseCollection.get(id));
        const second = updater(concurrentlyClaimed);
        if (second === null) return null;
        await baseCollection.put(id, second);

        return second;
      },
    };
    const ops = new OpsRepository(retryingCollection);

    await expect(ops.claimAdminAuditIdempotency(retry)).resolves.toMatchObject({
      status: "existing",
      audit: concurrentlyClaimed,
    });
    expect(invocationCount).toBe(1);
  });

  it("lists due workflows and leases one worker at a time", async () => {
    const clock = createTestClock();
    const ops = new OpsRepository(createStorageCollection("ops"));
    const dueWorkflow = createWorkflowDocument({
      id: createTestMikaId("workflow", 1),
      nextAttemptAt: clock.isoAt(-1_000),
    });
    const futureWorkflow = createWorkflowDocument({
      id: createTestMikaId("workflow", 2),
      subjectId: createTestMikaId("webhook", 2),
      idempotencyKey: "event_2",
      nextAttemptAt: clock.isoAt(60_000),
    });
    await ops.put(dueWorkflow);
    await ops.put(futureWorkflow);

    await expect(ops.listDueWorkflows(TEST_NOW)).resolves.toMatchObject({
      items: [{ id: "workflow_1" }],
    });
    await expect(
      ops.tryLeaseWorkflow({
        workflowId: futureWorkflow.id,
        leaseKey: "worker_future",
        now: TEST_NOW,
        leaseExpiresAt: clock.isoAt(300_000),
      }),
    ).resolves.toBeNull();
    await expect(
      ops.tryLeaseWorkflow({
        workflowId: dueWorkflow.id,
        leaseKey: "worker_1",
        now: TEST_NOW,
        leaseExpiresAt: clock.isoAt(300_000),
      }),
    ).resolves.toMatchObject({
      status: "running",
      leaseExpiresAt: clock.isoAt(300_000),
      record: { attemptCount: 1, leaseKey: "worker_1" },
    });
    await expect(
      ops.tryLeaseWorkflow({
        workflowId: dueWorkflow.id,
        leaseKey: "worker_2",
        now: TEST_NOW,
        leaseExpiresAt: clock.isoAt(300_000),
      }),
    ).resolves.toBeNull();
  });

  it("paginates past exhausted workflows when listing due workflows", async () => {
    const clock = createTestClock();
    const ops = new OpsRepository(createStorageCollection("ops"));
    const exhaustedWorkflow = createWorkflowDocument({
      id: createTestMikaId("workflow", 1),
      status: "failed",
      nextAttemptAt: clock.isoAt(-120_000),
      attemptCount: 5,
      maxAttempts: 5,
    });
    const dueWorkflow = createWorkflowDocument({
      id: createTestMikaId("workflow", 2),
      subjectId: createTestMikaId("webhook", 2),
      idempotencyKey: "event_2",
      nextAttemptAt: clock.isoAt(-60_000),
    });
    await ops.put(exhaustedWorkflow);
    await ops.put(dueWorkflow);

    await expect(ops.listDueWorkflows(TEST_NOW, 1)).resolves.toMatchObject({
      items: [{ id: dueWorkflow.id }],
    });
  });

  it("does not fabricate an unusable cursor when more due work exists than fits one page", async () => {
    // listDueWorkflows merges two independently-cursored sub-queries and re-sorts them, so there
    // is no real resumable cursor for the merged page — and its own signature has no cursor
    // parameter to resume with anyway. hasMore alone must carry the "more than fits" signal.
    const clock = createTestClock();
    const ops = new OpsRepository(createStorageCollection("ops"));
    for (let index = 1; index <= 3; index += 1) {
      await ops.put(
        createWorkflowDocument({
          id: createTestMikaId("workflow", index),
          subjectId: createTestMikaId("webhook", index),
          idempotencyKey: `event_${index}`,
          nextAttemptAt: clock.isoAt(-60_000 + index),
        }),
      );
    }

    const page = await ops.listDueWorkflows(TEST_NOW, 1);
    expect(page).toMatchObject({ hasMore: true });
    expect(page.cursor).toBeUndefined();

    const emails = new OpsRepository(createStorageCollection("ops"));
    for (let index = 1; index <= 3; index += 1) {
      await emails.put(
        createEmailDocument({
          id: createTestMikaId("email", index),
          record: {
            id: createTestMikaId("email", index),
            kind: "magic_link",
            templateKey: "magic_link",
            attemptCount: 0,
            nextAttemptAt: clock.isoAt(-60_000 + index),
            metadata: { link: `https://shop.example.test/sign-in/${index}` },
          },
        }),
      );
    }

    const emailPage = await emails.listDueEmails(TEST_NOW, 1);
    expect(emailPage).toMatchObject({ hasMore: true });
    expect(emailPage.cursor).toBeUndefined();
  });

  it("anonymizes every matching record for an account-delete sweep beyond one internal page", async () => {
    // Account-delete sweeps used to request Number.MAX_SAFE_INTEGER in one query; they now
    // paginate internally in bounded pages. Seed more entitlements/orders than one page to prove
    // the sweep still reaches every record, not just the first page's worth.
    const customerId = createTestMikaId("customer", 1);
    const account = new AccountRepository(createStorageCollection("account"));
    const entitlementCount = 55;
    for (let index = 1; index <= entitlementCount; index += 1) {
      await account.put(
        createEntitlementDocument({
          id: createTestMikaId("entitlement", index),
          record: { id: createTestMikaId("entitlement", index), customerId },
        }),
      );
    }

    const result = await account.anonymizeEntitlementsForAccountDelete({
      customerId,
      sentinel: `account-deleted:${customerId}`,
      now: TEST_NOW,
    });

    expect(result).toEqual({ anonymized: entitlementCount });
    const page = await account.listEntitlementsByCustomer(customerId, entitlementCount);
    expect(page.items).toHaveLength(entitlementCount);
    expect(page.items.every((item) => item.data.userId === `account-deleted:${customerId}`)).toBe(
      true,
    );

    const ledger = new LedgerRepository(createStorageCollection("ledger"));
    const orderCount = 55;
    for (let index = 1; index <= orderCount; index += 1) {
      await ledger.put(
        createOrderDocument({
          id: createTestMikaId("order", index),
          customerId,
          orderNumber: `M-${1000 + index}`,
          providerPaymentId: `payment_${index}`,
          providerOrderId: `provider_order_${index}`,
        }),
      );
    }

    const orderResult = await ledger.anonymizeOrdersForAccountDelete({
      customerId,
      sentinel: `account-deleted:${customerId}`,
      now: TEST_NOW,
    });

    expect(orderResult).toEqual({ anonymized: orderCount });
    const orderPage = await ledger.listOrdersByCustomer(customerId, orderCount);
    expect(orderPage.items).toHaveLength(orderCount);
    expect(
      orderPage.items.every((item) => item.data.emailHash === `account-deleted:${customerId}`),
    ).toBe(true);
  });

  it("allows expired workflow leases to be reclaimed", async () => {
    const clock = createTestClock();
    const ops = new OpsRepository(createStorageCollection("ops"));
    const workflow = createWorkflowDocument({
      status: "running",
      nextAttemptAt: undefined,
      leaseKey: "worker_1",
      leasedAt: clock.isoAt(-600_000),
      leaseExpiresAt: clock.isoAt(-60_000),
      attemptCount: 1,
    });
    await ops.put(workflow);

    await expect(ops.listDueWorkflows(TEST_NOW)).resolves.toMatchObject({
      items: [{ id: workflow.id }],
    });
    await expect(
      ops.tryLeaseWorkflow({
        workflowId: workflow.id,
        leaseKey: "worker_2",
        now: TEST_NOW,
        leaseExpiresAt: clock.isoAt(300_000),
      }),
    ).resolves.toMatchObject({
      status: "running",
      leaseExpiresAt: clock.isoAt(300_000),
      record: { attemptCount: 2, leaseKey: "worker_2" },
    });
  });

  it("allows forced workflow leases after max attempts but not active leases", async () => {
    const clock = createTestClock();
    const ops = new OpsRepository(createStorageCollection("ops"));
    const workflow = createWorkflowDocument({
      status: "failed",
      nextAttemptAt: clock.isoAt(60_000),
      attemptCount: 5,
      maxAttempts: 5,
    });
    await ops.put(workflow);

    await expect(
      ops.tryLeaseWorkflow({
        workflowId: workflow.id,
        leaseKey: "worker_1",
        now: TEST_NOW,
        leaseExpiresAt: clock.isoAt(300_000),
      }),
    ).resolves.toBeNull();
    await expect(
      ops.tryLeaseWorkflow({
        workflowId: workflow.id,
        leaseKey: "worker_forced",
        now: TEST_NOW,
        leaseExpiresAt: clock.isoAt(300_000),
        force: true,
      }),
    ).resolves.toMatchObject({
      status: "running",
      record: {
        attemptCount: 6,
        leaseKey: "worker_forced",
      },
    });
  });

  it("reclaims stuck workflows whose lease expired after exhausting attempts", async () => {
    const clock = createTestClock();
    const ops = new OpsRepository(createStorageCollection("ops"));
    const stuck = createWorkflowDocument({
      status: "running",
      nextAttemptAt: undefined,
      leaseKey: "worker_1",
      leasedAt: clock.isoAt(-600_000),
      leaseExpiresAt: clock.isoAt(-60_000),
      attemptCount: 5,
      maxAttempts: 5,
    });
    const active = createWorkflowDocument({
      id: createTestMikaId("workflow", 2),
      subjectId: createTestMikaId("webhook", 2),
      idempotencyKey: "event_2",
      status: "running",
      leaseKey: "worker_2",
      leaseExpiresAt: clock.isoAt(300_000),
      attemptCount: 5,
      maxAttempts: 5,
    });
    await ops.put(stuck);
    await ops.put(active);

    await expect(
      ops.tryLeaseWorkflow({
        workflowId: stuck.id,
        leaseKey: "w",
        now: TEST_NOW,
        leaseExpiresAt: clock.isoAt(300_000),
      }),
    ).resolves.toBeNull();

    await expect(ops.reclaimExhaustedWorkflows(TEST_NOW)).resolves.toEqual({
      scanned: 1,
      reclaimed: 1,
    });

    const reclaimed = await ops.findWorkflow(stuck.id);
    expect(reclaimed).toMatchObject({
      status: "failed",
      record: { leaseKey: undefined },
    });
    expect(reclaimed?.record.lastError).toBeTruthy();

    await expect(ops.findWorkflow(active.id)).resolves.toMatchObject({
      status: "running",
    });
  });

  it("purges stale raw webhook provider payloads without dropping normalized event rows", async () => {
    const clock = createTestClock();
    const ops = new OpsRepository(createStorageCollection("ops"));
    const staleProcessed = createWebhookDocument({
      id: createTestMikaId("webhook", 1),
      status: "processed",
      receivedAt: clock.isoAt(-15 * 24 * 60 * 60 * 1000),
      record: {
        id: createTestMikaId("webhook", 1),
        status: "processed",
        receivedAt: clock.isoAt(-15 * 24 * 60 * 60 * 1000),
        rawPayloadJson: { providerPayload: { marker: "stale" } },
      },
    });
    const staleReplayable = createWebhookDocument({
      id: createTestMikaId("webhook", 4),
      providerEventId: "event_4",
      payloadHash: "hash_4",
      status: "failed",
      receivedAt: clock.isoAt(-16 * 24 * 60 * 60 * 1000),
      record: {
        id: createTestMikaId("webhook", 4),
        providerEventId: "event_4",
        payloadHash: "hash_4",
        status: "failed",
        receivedAt: clock.isoAt(-16 * 24 * 60 * 60 * 1000),
        rawPayloadJson: { providerPayload: { marker: "replayable" } },
      },
    });
    const normalizedReplayable = createWebhookDocument({
      id: createTestMikaId("webhook", 5),
      providerEventId: "event_5",
      payloadHash: "hash_5",
      status: "failed",
      receivedAt: clock.isoAt(-17 * 24 * 60 * 60 * 1000),
      record: {
        id: createTestMikaId("webhook", 5),
        providerEventId: "event_5",
        payloadHash: "hash_5",
        status: "failed",
        receivedAt: clock.isoAt(-17 * 24 * 60 * 60 * 1000),
        rawPayloadJson: { providerPayload: { marker: "normalized" } },
        normalizedPayloadJson: {
          kind: "payment",
          provider: TEST_PROVIDER,
          type: "payment.completed",
        },
      },
    });
    const fresh = createWebhookDocument({
      id: createTestMikaId("webhook", 2),
      providerEventId: "event_2",
      payloadHash: "hash_2",
      receivedAt: clock.isoAt(-2 * 24 * 60 * 60 * 1000),
      record: {
        id: createTestMikaId("webhook", 2),
        providerEventId: "event_2",
        payloadHash: "hash_2",
        receivedAt: clock.isoAt(-2 * 24 * 60 * 60 * 1000),
        rawPayloadJson: { providerPayload: { marker: "fresh" } },
      },
    });
    const alreadyPurged = createWebhookDocument({
      id: createTestMikaId("webhook", 3),
      providerEventId: "event_3",
      payloadHash: "hash_3",
      receivedAt: clock.isoAt(-20 * 24 * 60 * 60 * 1000),
      record: {
        id: createTestMikaId("webhook", 3),
        providerEventId: "event_3",
        payloadHash: "hash_3",
        receivedAt: clock.isoAt(-20 * 24 * 60 * 60 * 1000),
        rawPayloadJson: undefined,
        rawPayloadPurgedAt: clock.isoAt(-1_000),
      },
    });
    await ops.put(staleProcessed);
    await ops.put(staleReplayable);
    await ops.put(normalizedReplayable);
    await ops.put(fresh);
    await ops.put(alreadyPurged);

    await expect(
      ops.purgeWebhookRawPayloads(clock.isoAt(-14 * 24 * 60 * 60 * 1000), TEST_NOW),
    ).resolves.toEqual({
      scanned: 2,
      purged: 2,
    });
    await expect(ops.findWebhookById(staleProcessed.id)).resolves.toMatchObject({
      id: staleProcessed.id,
      status: "processed",
      record: {
        rawPayloadJson: undefined,
        rawPayloadPurgedAt: TEST_NOW,
      },
    });
    await expect(ops.findWebhookById(staleReplayable.id)).resolves.toMatchObject({
      record: {
        rawPayloadJson: { providerPayload: { marker: "replayable" } },
        rawPayloadPurgedAt: undefined,
      },
    });
    await expect(ops.findWebhookById(normalizedReplayable.id)).resolves.toMatchObject({
      record: {
        rawPayloadJson: undefined,
        normalizedPayloadJson: {
          kind: "payment",
          provider: TEST_PROVIDER,
          type: "payment.completed",
        },
        rawPayloadPurgedAt: TEST_NOW,
      },
    });
    await expect(ops.findWebhookById(fresh.id)).resolves.toMatchObject({
      record: {
        rawPayloadJson: { providerPayload: { marker: "fresh" } },
        rawPayloadPurgedAt: undefined,
      },
    });
    await expect(ops.findWebhookById(alreadyPurged.id)).resolves.toMatchObject({
      record: { rawPayloadPurgedAt: clock.isoAt(-1_000) },
    });
  });

  it("lists due emails and requires an active delivery lease for terminal mutations", async () => {
    const clock = createTestClock();
    const ops = new OpsRepository(createStorageCollection("ops"));
    const dueEmail = createEmailDocument({
      id: createTestMikaId("email", 1),
      record: {
        id: createTestMikaId("email", 1),
        kind: "magic_link",
        templateKey: "magic_link",
        attemptCount: 0,
        nextAttemptAt: clock.isoAt(-1_000),
        metadata: { link: "https://shop.example.test/sign-in" },
      },
    });
    const futureEmail = createEmailDocument({
      id: createTestMikaId("email", 2),
      nextAttemptAt: clock.isoAt(60_000),
      record: {
        id: createTestMikaId("email", 2),
        kind: "magic_link",
        templateKey: "magic_link",
        attemptCount: 0,
        nextAttemptAt: clock.isoAt(60_000),
        metadata: { link: "https://shop.example.test/future" },
      },
    });
    const immediateEmail = createEmailDocument({
      id: createTestMikaId("email", 3),
      nextAttemptAt: undefined,
      record: {
        id: createTestMikaId("email", 3),
        kind: "magic_link",
        templateKey: "magic_link",
        attemptCount: 0,
        nextAttemptAt: undefined,
        metadata: { link: "https://shop.example.test/immediate" },
      },
    });
    await ops.put(dueEmail);
    await ops.put(futureEmail);
    await ops.put(immediateEmail);

    const due = await ops.listDueEmails(TEST_NOW);
    expect(due.items.map((item) => item.id).sort()).toEqual(
      [dueEmail.id, immediateEmail.id].sort(),
    );
    await expect(
      ops.tryLeaseEmail({
        emailId: dueEmail.id,
        leaseKey: "email_worker_1",
        now: TEST_NOW,
        leaseExpiresAt: clock.isoAt(300_000),
      }),
    ).resolves.toMatchObject({
      status: "queued",
      nextAttemptAt: clock.isoAt(300_000),
      record: {
        attemptCount: 1,
        leaseKey: "email_worker_1",
        leaseExpiresAt: clock.isoAt(300_000),
        metadata: { link: "https://shop.example.test/sign-in" },
      },
    });
    await expect(ops.listDueEmails(TEST_NOW)).resolves.toMatchObject({
      items: [{ id: immediateEmail.id }],
    });
    await expect(
      ops.completeEmail({
        emailId: dueEmail.id,
        leaseKey: "email_worker_2",
        now: TEST_NOW,
      }),
    ).resolves.toBeNull();
    await expect(
      ops.completeEmail({
        emailId: dueEmail.id,
        leaseKey: "email_worker_1",
        now: TEST_NOW,
        providerMessageId: "provider_message_1",
      }),
    ).resolves.toMatchObject({
      status: "sent",
      nextAttemptAt: undefined,
      record: {
        status: "sent",
        providerMessageId: "provider_message_1",
        sentAt: TEST_NOW,
        metadata: { linkRedactedAt: TEST_NOW },
      },
    });
  });

  it("discovers every due email when more than the limit share a page", async () => {
    const clock = createTestClock();
    const ops = new OpsRepository(createStorageCollection("ops"));
    const dueIds: MikaId[] = [];
    for (let index = 1; index <= 5; index += 1) {
      const id = createTestMikaId("email", index);
      dueIds.push(id);
      await ops.put(
        createEmailDocument({
          id,
          record: {
            id,
            kind: "magic_link",
            templateKey: "magic_link",
            attemptCount: 0,
            nextAttemptAt: clock.isoAt(-10_000 + index),
            metadata: { link: `https://shop.example.test/sign-in/${index}` },
          },
        }),
      );
    }

    const leased = new Set<string>();
    for (let round = 0; round < 10 && leased.size < dueIds.length; round += 1) {
      const due = await ops.listDueEmails(TEST_NOW, 2);
      if (due.items.length === 0) break;
      for (const item of due.items) {
        const result = await ops.tryLeaseEmail({
          emailId: createMikaId(item.id),
          leaseKey: `worker_${round}`,
          now: TEST_NOW,
          leaseExpiresAt: clock.isoAt(300_000),
        });
        if (result) leased.add(item.id);
      }
    }

    expect([...leased].sort()).toEqual([...dueIds].sort());
  });

  it("marks exhausted queued emails from lease loss as failed for review", async () => {
    const clock = createTestClock();
    const ops = new OpsRepository(createStorageCollection("ops"));
    const exhausted = createEmailDocument({
      id: createTestMikaId("email", 1),
      status: "queued",
      nextAttemptAt: clock.isoAt(-1),
      record: {
        id: createTestMikaId("email", 1),
        kind: "order_confirmation",
        templateKey: "order_confirmation",
        status: "queued",
        attemptCount: 5,
        maxAttempts: 5,
        nextAttemptAt: clock.isoAt(-1),
        leaseKey: "lost_worker",
        leasedAt: clock.isoAt(-600_000),
        leaseExpiresAt: clock.isoAt(-1),
      },
    });
    const realFailure = createEmailDocument({
      id: createTestMikaId("email", 2),
      status: "queued",
      nextAttemptAt: clock.isoAt(-1),
      record: {
        id: createTestMikaId("email", 2),
        kind: "order_confirmation",
        templateKey: "order_confirmation",
        status: "queued",
        attemptCount: 5,
        maxAttempts: 5,
        nextAttemptAt: clock.isoAt(-1),
        leaseKey: "failed_worker",
        leaseExpiresAt: clock.isoAt(-1),
        lastError: "Provider rejected message.",
      },
    });
    await ops.put(exhausted);
    await ops.put(realFailure);

    await expect(ops.listDueEmails(TEST_NOW)).resolves.toMatchObject({ items: [] });
    await expect(ops.reclaimExhaustedEmails(TEST_NOW)).resolves.toEqual({
      scanned: 1,
      reclaimed: 1,
    });
    await expect(ops.findEmail(exhausted.id)).resolves.toMatchObject({
      status: "failed",
      nextAttemptAt: undefined,
      record: {
        status: "failed",
        leaseKey: undefined,
        leaseExpiresAt: undefined,
        lastError: "Email exhausted its lease attempts without delivery; marked failed for review.",
      },
    });
    await expect(ops.findEmail(realFailure.id)).resolves.toMatchObject({
      status: "queued",
      record: { lastError: "Provider rejected message." },
    });
  });

  it("re-queues an exhausted email for delivery on admin resend", async () => {
    const clock = createTestClock();
    const opsCollection = createStorageCollection("ops");
    const repositories = {
      ...createTestBackendRepositories(),
      ops: new OpsRepository(opsCollection),
    };
    const api = createMikaBackendApi(createIncrementingBackendDependencies({ repositories }));

    const email = createEmailDocument({
      id: createTestMikaId("email", 1),
      status: "failed",
      record: {
        id: createTestMikaId("email", 1),
        kind: "order_confirmation",
        templateKey: "order_confirmation",
        status: "failed",
        attemptCount: 5,
        maxAttempts: 5,
        nextAttemptAt: clock.isoAt(-1_000),
        lastError: "Provider unavailable.",
        leaseKey: "stale_lease",
        leaseExpiresAt: clock.isoAt(-1),
      },
    });
    await repositories.ops.put(email);

    await expect(api.admin.emailResend({ emailId: email.id })).resolves.toMatchObject({
      ok: true,
      data: { id: email.id, status: "completed" },
    });

    const requeued = await repositories.ops.findEmail(email.id);
    expect(requeued).toMatchObject({
      status: "queued",
      record: { status: "queued", attemptCount: 0, leaseKey: undefined },
    });

    await expect(
      repositories.ops.tryLeaseEmail({
        emailId: email.id,
        leaseKey: "worker_resend",
        now: TEST_NOW,
        leaseExpiresAt: clock.isoAt(300_000),
      }),
    ).resolves.toMatchObject({ status: "queued", record: { attemptCount: 1 } });
  });

  it("fails one email and continues the outbox sweep when its prepare throws", async () => {
    const repositories = createTestBackendRepositories();
    const throwing = createEmailDocument({
      id: createTestMikaId("email", 1),
      record: {
        id: createTestMikaId("email", 1),
        kind: "order_confirmation",
        toEmail: "a@example.test",
        templateKey: "order_confirmation",
        attemptCount: 0,
        nextAttemptAt: TEST_NOW,
        orderId: createTestMikaId("order", 1),
        metadata: {},
      },
    });
    const healthy = createEmailDocument({
      id: createTestMikaId("email", 2),
      record: {
        id: createTestMikaId("email", 2),
        kind: "magic_link",
        toEmail: "b@example.test",
        templateKey: "magic_link",
        attemptCount: 0,
        nextAttemptAt: TEST_NOW,
        metadata: {
          link: "https://shop.example.test/x?token=t2",
          purpose: "checkout",
          expiresAt: createTestClock().isoAt(15 * 60_000),
        },
      },
    });
    await repositories.ops.put(throwing);
    await repositories.ops.put(healthy);
    repositories.ledger.findOrderById = async () => {
      throw new Error("ledger read outage during render");
    };

    const sent: MikaEmailDeliveryMessage[] = [];
    const runner = createMikaEmailOutboxRunner({
      repositories,
      now: () => new Date(TEST_NOW),
      createId: createIncrementingIdFactory("email_lease"),
      sender: async (message) => {
        sent.push(message);
        return { providerMessageId: "pm" };
      },
    });

    await expect(runner.runOnce()).resolves.toMatchObject({ sent: 1, failed: 1 });
    expect(sent.map((message) => message.emailId)).toEqual([healthy.id]);
    await expect(repositories.ops.findEmail(throwing.id)).resolves.toMatchObject({
      status: "failed",
    });
    await expect(repositories.ops.findEmail(healthy.id)).resolves.toMatchObject({ status: "sent" });
  });

  it("does not re-queue an email for resend when recording the successful send fails", async () => {
    const repositories = createTestBackendRepositories();
    const email = createEmailDocument({
      id: createTestMikaId("email", 1),
      record: {
        id: createTestMikaId("email", 1),
        kind: "magic_link",
        toEmail: "a@example.test",
        templateKey: "magic_link",
        attemptCount: 0,
        nextAttemptAt: TEST_NOW,
        metadata: {
          link: "https://shop.example.test/x?token=t1",
          purpose: "checkout",
          expiresAt: createTestClock().isoAt(15 * 60_000),
        },
      },
    });
    await repositories.ops.put(email);
    repositories.ops.completeEmail = async () => {
      throw new Error("ops write outage after a successful send");
    };

    let sendCount = 0;
    const runner = createMikaEmailOutboxRunner({
      repositories,
      now: () => new Date(TEST_NOW),
      createId: createIncrementingIdFactory("email_lease"),
      sender: async () => {
        sendCount += 1;
        return { providerMessageId: `pm_${sendCount}` };
      },
    });

    await runner.runOnce();

    expect(sendCount).toBe(1);
    await expect(repositories.ops.findEmail(email.id)).resolves.toMatchObject({ status: "sent" });
  });

  it("delivers queued magic-link email through the outbox runner", async () => {
    const repositories = createTestBackendRepositories();
    const sent: MikaEmailDeliveryMessage[] = [];
    const email = createEmailDocument({
      id: createTestMikaId("email", 1),
      record: {
        id: createTestMikaId("email", 1),
        kind: "magic_link",
        toEmail: "Subscriber@Example.test",
        templateKey: "magic_link",
        attemptCount: 0,
        nextAttemptAt: TEST_NOW,
        metadata: {
          link: "https://shop.example.test/_emdash/api/plugins/mika/magic-link/verify?token=token_1",
          purpose: "checkout",
          expiresAt: createTestClock().isoAt(15 * 60_000),
        },
      },
    });
    await repositories.ops.put(email);

    const runner = createMikaEmailOutboxRunner({
      repositories,
      now: () => new Date(TEST_NOW),
      createId: createIncrementingIdFactory("email_lease"),
      sender: async (message) => {
        sent.push(message);

        return { providerMessageId: "provider_message_1" };
      },
    });

    await expect(runner.runOnce()).resolves.toMatchObject({
      scanned: 1,
      leased: 1,
      sent: 1,
      failed: 0,
      skipped: 0,
      items: [{ emailId: email.id, status: "sent", providerMessageId: "provider_message_1" }],
    });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      emailId: email.id,
      kind: "magic_link",
      to: "Subscriber@Example.test",
      subject: "Continue checkout on Mika",
      text: expect.stringContaining("token=token_1"),
    });
    expect(sent[0]?.metadata).toEqual({
      link: "https://shop.example.test/_emdash/api/plugins/mika/magic-link/verify?token=token_1",
      purpose: "checkout",
      expiresAt: createTestClock().isoAt(15 * 60_000),
    });
    await expect(repositories.ops.findEmail(email.id)).resolves.toMatchObject({
      status: "sent",
      nextAttemptAt: undefined,
      record: {
        attemptCount: 1,
        providerMessageId: "provider_message_1",
        sentAt: TEST_NOW,
        metadata: {
          purpose: "checkout",
          expiresAt: createTestClock().isoAt(15 * 60_000),
          linkRedactedAt: TEST_NOW,
        },
      },
    });
    const stored = await repositories.ops.findEmail(email.id);
    expect(stored?.record.metadata?.["link"]).toBeUndefined();
  });

  it("terminalizes a delivered email when the lease is lost so it is never re-sent", async () => {
    const repositories = createTestBackendRepositories();
    const email = createEmailDocument({
      id: createTestMikaId("email", 1),
      record: {
        id: createTestMikaId("email", 1),
        kind: "magic_link",
        toEmail: "subscriber@example.test",
        templateKey: "magic_link",
        attemptCount: 0,
        nextAttemptAt: TEST_NOW,
        metadata: {
          link: "https://shop.example.test/_emdash/api/plugins/mika/magic-link/verify?token=token_1",
          purpose: "checkout",
          expiresAt: createTestClock().isoAt(15 * 60_000),
        },
      },
    });
    await repositories.ops.put(email);

    const leaseLosingOps = Object.assign(Object.create(repositories.ops), {
      completeEmail: async () => null,
    });
    const sent: MikaEmailDeliveryMessage[] = [];
    const runner = createMikaEmailOutboxRunner({
      repositories: { ...repositories, ops: leaseLosingOps },
      now: () => new Date(TEST_NOW),
      createId: createIncrementingIdFactory("email_lease"),
      sender: async (message) => {
        sent.push(message);
        return { providerMessageId: "provider_message_1" };
      },
    });

    await expect(runner.runOnce()).resolves.toMatchObject({
      sent: 1,
      leaseLost: 0,
      items: [{ emailId: email.id, status: "sent", recoveredLeaseLost: true }],
    });
    expect(sent).toHaveLength(1);

    await expect(repositories.ops.findEmail(email.id)).resolves.toMatchObject({
      status: "sent",
      record: {
        sentAt: TEST_NOW,
        providerMessageId: "provider_message_1",
        metadata: { linkRedactedAt: TEST_NOW },
      },
    });
    const stored = await repositories.ops.findEmail(email.id);
    expect(stored?.record.metadata?.["link"]).toBeUndefined();

    const resend: MikaEmailDeliveryMessage[] = [];
    const secondRunner = createMikaEmailOutboxRunner({
      repositories,
      now: () => new Date(TEST_NOW),
      createId: createIncrementingIdFactory("email_lease_second"),
      sender: async (message) => {
        resend.push(message);
        return { providerMessageId: "provider_message_2" };
      },
    });
    await expect(secondRunner.runOnce()).resolves.toMatchObject({ scanned: 0, sent: 0 });
    expect(resend).toHaveLength(0);
  });

  it("renders order-confirmation emails from the queued order reference", async () => {
    const repositories = createTestBackendRepositories();
    const sent: MikaEmailDeliveryMessage[] = [];
    const order = createOrderDocument();
    const email = createEmailDocument({
      id: createTestMikaId("email", 1),
      record: {
        id: createTestMikaId("email", 1),
        orderId: order.id,
        kind: "order_confirmation",
        toEmail: "subscriber@example.test",
        templateKey: "order_confirmation",
        attemptCount: 0,
        nextAttemptAt: TEST_NOW,
        metadata: { orderLineIds: [createTestMikaId("order_line", 1)] },
      },
    });
    await repositories.ledger.put(order);
    await repositories.ops.put(email);

    const runner = createMikaEmailOutboxRunner({
      repositories,
      now: () => new Date(TEST_NOW),
      createId: createIncrementingIdFactory("email_lease"),
      accountUrl: ({ order: deliveredOrder }) => `/account/orders/${deliveredOrder.orderNumber}`,
      sender: async (message) => {
        sent.push(message);
      },
    });

    await expect(runner.runOnce()).resolves.toMatchObject({
      scanned: 1,
      sent: 1,
    });
    expect(sent[0]).toMatchObject({
      subject: "Order M-1001 confirmed",
      text: expect.stringContaining("Test download"),
      html: expect.stringContaining("/account/orders/M-1001"),
    });
  });

  it("renders order-confirmation discounts so itemized receipts reconcile", async () => {
    const repositories = createTestBackendRepositories();
    const sent: MikaEmailDeliveryMessage[] = [];
    const baseOrder = createOrderDocument();
    const order = createOrderDocument({
      totalAmount: 1080,
      aggregate: {
        ...baseOrder.aggregate,
        totals: {
          subtotal: { amount: 1200, currency: TEST_CURRENCY },
          discount: { amount: 120, currency: TEST_CURRENCY },
          total: { amount: 1080, currency: TEST_CURRENCY },
        },
      },
    });
    const email = createEmailDocument({
      id: createTestMikaId("email", 1),
      record: {
        id: createTestMikaId("email", 1),
        orderId: order.id,
        kind: "order_confirmation",
        toEmail: "subscriber@example.test",
        templateKey: "order_confirmation",
        attemptCount: 0,
        nextAttemptAt: TEST_NOW,
      },
    });
    await repositories.ledger.put(order);
    await repositories.ops.put(email);

    const runner = createMikaEmailOutboxRunner({
      repositories,
      now: () => new Date(TEST_NOW),
      createId: createIncrementingIdFactory("email_lease"),
      sender: async (message) => {
        sent.push(message);
      },
    });

    await expect(runner.runOnce()).resolves.toMatchObject({ sent: 1 });
    expect(sent[0]?.text).toContain("Subtotal:");
    expect(sent[0]?.text).toContain("Discount: -");
    expect(sent[0]?.text).toContain("Total:");
    expect(sent[0]?.html).toContain("<strong>Discount:</strong> -");
  });

  it("skips queued order-confirmation emails when the order was refunded or cancelled", async () => {
    const cases = ["refunded", "cancelled"] as const;

    for (const status of cases) {
      const repositories = createTestBackendRepositories();
      const sent: MikaEmailDeliveryMessage[] = [];
      const order = createOrderDocument({
        status,
        paymentStatus: status === "refunded" ? "refunded" : "paid",
      });
      const email = createEmailDocument({
        id: createTestMikaId("email", 1),
        record: {
          id: createTestMikaId("email", 1),
          orderId: order.id,
          kind: "order_confirmation",
          toEmail: "subscriber@example.test",
          templateKey: "order_confirmation",
          attemptCount: 0,
          nextAttemptAt: TEST_NOW,
          metadata: {},
        },
      });
      await repositories.ledger.put(order);
      await repositories.ops.put(email);

      const runner = createMikaEmailOutboxRunner({
        repositories,
        now: () => new Date(TEST_NOW),
        createId: createIncrementingIdFactory(`email_lease_${status}`),
        sender: async (message) => {
          sent.push(message);
        },
      });

      await expect(runner.runOnce()).resolves.toMatchObject({
        scanned: 1,
        sent: 0,
        skipped: 1,
        items: [
          {
            emailId: email.id,
            status: "skipped",
            error: `Order '${order.id}' is ${status}; order-confirmation email skipped.`,
          },
        ],
      });
      expect(sent).toEqual([]);
    }
  });

  it("retries failed email delivery and then records terminal failure", async () => {
    const clock = createTestClock();
    const repositories = createTestBackendRepositories();
    const email = createEmailDocument({
      id: createTestMikaId("email", 1),
      record: {
        id: createTestMikaId("email", 1),
        kind: "magic_link",
        templateKey: "magic_link",
        attemptCount: 0,
        maxAttempts: 2,
        nextAttemptAt: TEST_NOW,
        metadata: { link: "https://shop.example.test/sign-in" },
      },
    });
    await repositories.ops.put(email);

    const runner = createMikaEmailOutboxRunner({
      repositories,
      createId: createIncrementingIdFactory("email_lease"),
      sender: async () => {
        throw new Error("provider unavailable");
      },
    });

    await expect(runner.runOnce({ now: TEST_NOW })).resolves.toMatchObject({
      scanned: 1,
      sent: 0,
      failed: 1,
      items: [
        {
          emailId: email.id,
          status: "failed",
          error: "provider unavailable",
          nextAttemptAt: clock.isoAt(60_000),
          terminal: false,
        },
      ],
    });
    await expect(repositories.ops.findEmail(email.id)).resolves.toMatchObject({
      status: "failed",
      nextAttemptAt: clock.isoAt(60_000),
      record: { attemptCount: 1, lastError: "provider unavailable" },
    });

    await expect(runner.runOnce({ now: clock.isoAt(60_000) })).resolves.toMatchObject({
      scanned: 1,
      failed: 1,
      items: [
        {
          emailId: email.id,
          status: "failed",
          terminal: true,
          nextAttemptAt: undefined,
        },
      ],
    });
    await expect(repositories.ops.findEmail(email.id)).resolves.toMatchObject({
      status: "failed",
      nextAttemptAt: undefined,
      record: { attemptCount: 2, lastError: "provider unavailable" },
    });
  });

  it("skips queued email kinds without a Mika renderer", async () => {
    const repositories = createTestBackendRepositories();
    const email = createEmailDocument({
      id: createTestMikaId("email", 1),
      record: {
        id: createTestMikaId("email", 1),
        kind: "download",
        templateKey: "download",
        attemptCount: 0,
        nextAttemptAt: TEST_NOW,
      },
    });
    await repositories.ops.put(email);

    const runner = createMikaEmailOutboxRunner({
      repositories,
      createId: createIncrementingIdFactory("email_lease"),
      sender: async () => {
        throw new Error("download email should not be sent");
      },
    });

    await expect(runner.runOnce({ now: TEST_NOW })).resolves.toMatchObject({
      scanned: 1,
      skipped: 1,
      failed: 0,
      items: [{ emailId: email.id, status: "skipped" }],
    });
    await expect(repositories.ops.findEmail(email.id)).resolves.toMatchObject({
      status: "skipped",
      nextAttemptAt: undefined,
      record: {
        attemptCount: 1,
        lastError: "Email kind 'download' has no Mika renderer.",
      },
    });
  });

  it("runs Mika maintenance across email, stock, and ephemeral tasks", async () => {
    const database = createTransactionTestMikaDb();
    const { db } = database;
    const clock = createTestClock();
    const stock = new StockRepository(db);
    const repositories = {
      ...createTestBackendRepositories(),
      stock,
      ephemeral: new EphemeralRepository(db),
    } satisfies MikaBackendRepositories;
    const service = createMikaStockLifecycleService(
      createIncrementingBackendDependencies({ repositories }),
    );
    const api = createMikaBackendApi(createIncrementingBackendDependencies({ repositories }));
    const sent: MikaEmailDeliveryMessage[] = [];
    const stockItem = createStockRecord({ quantityOnHand: 5, quantityReserved: 0 });
    const email = createEmailDocument({
      id: createTestMikaId("email", 1),
      record: {
        id: createTestMikaId("email", 1),
        kind: "magic_link",
        templateKey: "magic_link",
        attemptCount: 0,
        nextAttemptAt: TEST_NOW,
        metadata: { link: "https://shop.example.test/sign-in" },
      },
    });

    try {
      await mikaInitialMigration.up(db);
      await stock.putItem(stockItem);
      await service.reserve({
        stockItemId: stockItem.id,
        quantity: 2,
        expiresAt: clock.isoAt(30_000),
      });
      await repositories.ephemeral.put({
        key: "expired_token",
        kind: "token",
        status: "pending",
        count: 0,
        expiresAt: clock.isoAt(-1_000),
        version: 1,
        createdAt: TEST_NOW,
        updatedAt: TEST_NOW,
      });
      await repositories.ops.put(email);

      const runner = createMikaMaintenanceRunner({
        api,
        repositories,
        emailOutboxRunner: createMikaEmailOutboxRunner({
          repositories,
          createId: createIncrementingIdFactory("email_lease"),
          sender: async (message) => {
            sent.push(message);
          },
        }),
      });

      await expect(runner.runOnce({ now: clock.isoAt(60_000) })).resolves.toMatchObject({
        now: clock.isoAt(60_000),
        emailOutbox: {
          status: "completed",
          result: { scanned: 1, sent: 1, failed: 0 },
        },
        stockReservations: {
          status: "completed",
          result: { reservationsScanned: 1, reservationsReleased: 1, stockItems: 1 },
        },
        ephemeralRecords: {
          status: "completed",
          result: { purged: 1 },
        },
      });
      expect(sent).toHaveLength(1);
      await expect(repositories.ops.findEmail(email.id)).resolves.toMatchObject({
        status: "sent",
      });
      await expect(repositories.ephemeral.get("expired_token")).resolves.toBeNull();
      await expect(stock.findBySellableId(stockItem.sellableId)).resolves.toMatchObject({
        quantityOnHand: 5,
        quantityReserved: 0,
      });
    } finally {
      await rollbackMikaInitialMigration(db);
      await database.destroy();
    }
  });

  it("continues Mika maintenance tasks when one task fails", async () => {
    const runner = createMikaMaintenanceRunner({
      now: () => new Date(TEST_NOW),
      emailOutboxRunner: {
        runOnce: async () => {
          throw new Error("outbox unavailable");
        },
      },
      releaseExpiredReservations: async () => ({
        reservationsScanned: 2,
        reservationsReleased: 1,
        stockItems: 1,
      }),
      purgeExpiredEphemeralRecords: async () => ({ purged: 3 }),
    });

    await expect(runner.runOnce()).resolves.toMatchObject({
      now: TEST_NOW,
      emailOutbox: {
        status: "failed",
        error: "outbox unavailable",
      },
      stockReservations: {
        status: "completed",
        result: { reservationsScanned: 2, reservationsReleased: 1, stockItems: 1 },
      },
      ephemeralRecords: {
        status: "completed",
        result: { purged: 3 },
      },
    });
  });

  it("uses EmDash email delivery with system source by default", async () => {
    const calls: Array<{ readonly message: unknown; readonly source: string }> = [];
    const sender = createEmDashMikaEmailSender({
      isAvailable: () => true,
      send: async (message, source) => {
        calls.push({ message, source });
      },
    });

    await sender({
      emailId: createTestMikaId("email", 1),
      kind: "magic_link",
      to: "subscriber@example.test",
      subject: "Sign in",
      text: "Use this link",
      html: "<p>Use this link</p>",
      idempotencyKey: "magic-link:email_1",
    });

    expect(calls).toEqual([
      {
        source: "system",
        message: {
          to: "subscriber@example.test",
          subject: "Sign in",
          text: "Use this link",
          html: "<p>Use this link</p>",
          idempotencyKey: "magic-link:email_1",
        },
      },
    ]);
  });

  it("rejects plugin-scoped EmDash email adapters unless explicitly allowed", async () => {
    const sender = createEmDashMikaEmailSender({
      send: async () => undefined,
    });

    await expect(
      sender({
        emailId: createTestMikaId("email", 1),
        kind: "magic_link",
        to: "subscriber@example.test",
        subject: "Sign in",
        text: "Use this link",
        html: "<p>Use this link</p>",
      }),
    ).rejects.toThrow("must accept a source argument");
  });

  it("does not overwrite an existing workflow when creating one atomically", async () => {
    const clock = createTestClock();
    const ops = new OpsRepository(createStorageCollection("ops"));
    const existing = createWorkflowDocument({
      status: "running",
      nextAttemptAt: undefined,
      leaseKey: "worker_1",
      leasedAt: TEST_NOW,
      leaseExpiresAt: clock.isoAt(300_000),
      attemptCount: 1,
    });
    await ops.put(existing);

    await expect(
      ops.createWorkflow(
        createWorkflowDocument({
          id: existing.id,
          status: "queued",
          nextAttemptAt: TEST_NOW,
        }),
      ),
    ).resolves.toBeNull();
    await expect(ops.findWorkflow(existing.id)).resolves.toMatchObject({
      status: "running",
      nextAttemptAt: undefined,
      record: {
        leaseKey: "worker_1",
        attemptCount: 1,
      },
    });
  });

  it("does not complete a workflow step when the side effect fails", async () => {
    const clock = createTestClock();
    const ops = new OpsRepository(createStorageCollection("ops"));
    const workflow = createWorkflowDocument();
    await ops.put(workflow);
    const leased = await ops.tryLeaseWorkflow({
      workflowId: workflow.id,
      leaseKey: "worker_1",
      now: TEST_NOW,
      leaseExpiresAt: clock.isoAt(300_000),
    });
    if (!leased?.record.leaseKey) throw new Error("Expected workflow lease.");

    await ops.startWorkflowStep({
      workflowId: workflow.id,
      leaseKey: leased.record.leaseKey,
      stepName: "persist_order",
      now: TEST_NOW,
    });
    await ops.failWorkflowStep({
      workflowId: workflow.id,
      leaseKey: leased.record.leaseKey,
      stepName: "persist_order",
      now: TEST_NOW,
      lastError: "side effect failed",
      nextAttemptAt: clock.isoAt(60_000),
    });

    await expect(ops.findWorkflow(workflow.id)).resolves.toMatchObject({
      status: "failed",
      nextAttemptAt: clock.isoAt(60_000),
      record: {
        status: "failed",
        steps: expect.arrayContaining([
          expect.objectContaining({
            name: "persist_order",
            status: "failed",
            lastError: "side effect failed",
          }),
        ]),
      },
    });
    await expect(ops.listDueWorkflows(clock.isoAt(60_001))).resolves.toMatchObject({
      items: [{ id: workflow.id }],
    });
  });

  it("requires an active workflow lease for step and terminal mutations", async () => {
    const clock = createTestClock();
    const ops = new OpsRepository(createStorageCollection("ops"));
    const workflow = createWorkflowDocument({
      status: "running",
      nextAttemptAt: undefined,
      leaseKey: "worker_1",
      leasedAt: clock.isoAt(-600_000),
      leaseExpiresAt: clock.isoAt(-60_000),
      attemptCount: 1,
    });
    await ops.put(workflow);

    await expect(
      ops.startWorkflowStep({
        workflowId: workflow.id,
        leaseKey: "worker_1",
        stepName: "persist_order",
        now: TEST_NOW,
      }),
    ).resolves.toBeNull();
    await expect(
      ops.completeWorkflow({
        workflowId: workflow.id,
        leaseKey: "worker_1",
        now: TEST_NOW,
      }),
    ).resolves.toBeNull();
    await expect(ops.findWorkflow(workflow.id)).resolves.toMatchObject({
      status: "running",
      record: {
        leaseKey: "worker_1",
        steps: expect.arrayContaining([
          expect.objectContaining({ name: "persist_order", status: "queued" }),
        ]),
      },
    });
  });

  it("does not mark unrun workflow steps completed when completing a workflow", async () => {
    const clock = createTestClock();
    const ops = new OpsRepository(createStorageCollection("ops"));
    const workflow = createWorkflowDocument();
    await ops.put(workflow);
    const leased = await ops.tryLeaseWorkflow({
      workflowId: workflow.id,
      leaseKey: "worker_1",
      now: TEST_NOW,
      leaseExpiresAt: clock.isoAt(300_000),
    });
    if (!leased?.record.leaseKey) throw new Error("Expected workflow lease.");

    await ops.startWorkflowStep({
      workflowId: workflow.id,
      leaseKey: leased.record.leaseKey,
      stepName: "link_checkout",
      now: TEST_NOW,
    });
    await ops.completeWorkflowStep({
      workflowId: workflow.id,
      leaseKey: leased.record.leaseKey,
      stepName: "link_checkout",
      now: TEST_NOW,
    });
    await ops.completeWorkflow({
      workflowId: workflow.id,
      leaseKey: leased.record.leaseKey,
      now: TEST_NOW,
    });

    await expect(ops.findWorkflow(workflow.id)).resolves.toMatchObject({
      status: "completed",
      record: {
        steps: expect.arrayContaining([
          expect.objectContaining({ name: "link_checkout", status: "completed" }),
          expect.objectContaining({ name: "persist_order", status: "skipped" }),
          expect.objectContaining({ name: "fulfill_order", status: "skipped" }),
        ]),
      },
    });
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

describe("backend repository characterization", () => {
  it("finds catalog items and prices through current aggregate lookups", async () => {
    const collection = createStorageCollection("catalog");
    const repository = new CatalogRepository(collection);
    const contentRef = createTestContentRef();
    const inactiveSellable = createSellableDefinition({
      id: createTestMikaId("sellable", 2),
      active: false,
      prices: [
        createPriceDefinition({
          id: createTestMikaId("price", 2),
          active: false,
          titleSnapshot: "Inactive price",
        }),
      ],
    });
    const firstCatalog = createCatalogItemDocument({
      contentRef,
      sellables: [createSellableDefinition(), inactiveSellable],
    });
    const duplicateContentCatalog: CatalogItemDocument = {
      ...createCatalogItemDocument({
        contentRef: createTestContentRef({ id: "other-product" }),
        sellables: [
          createSellableDefinition({
            id: createTestMikaId("sellable", 3),
            prices: [createPriceDefinition({ id: createTestMikaId("price", 3) })],
          }),
        ],
      }),
      id: createTestMikaId("catalog", 2),
    };

    await repository.put(duplicateContentCatalog);
    await repository.put(firstCatalog);

    await expect(repository.findItemByContent(contentRef)).resolves.toEqual(firstCatalog);
    await expect(
      repository.findItemByContent(createTestContentRef({ id: "missing-product" })),
    ).resolves.toBeNull();
    await expect(repository.findPriceById(createTestMikaId("price", 2))).resolves.toMatchObject({
      catalog: { id: firstCatalog.id },
      sellable: { id: inactiveSellable.id, active: false },
      price: { id: "price_2", active: false },
    });
    await expect(repository.findPriceById(createTestMikaId("price", 404))).resolves.toBeNull();
  });

  it("finds checkout idempotency keys through indexed fields with metadata fallback", async () => {
    const collection = createStorageCollection("session");
    const repository = new SessionRepository(collection);
    const noMetadataCheckout = createCheckoutDocument({
      id: createTestMikaId("checkout", 1),
      providerCheckoutId: "provider_checkout_1",
    });
    const metadataIdempotentCheckout = createCheckoutDocument({
      id: createTestMikaId("checkout", 2),
      providerCheckoutId: "provider_checkout_2",
      metadata: {
        checkoutIdempotencyKey: "checkout_metadata_replay_key",
        checkoutIdempotencyInputHash: "hash_1",
      },
    });
    const indexedIdempotentCheckout = createCheckoutDocument({
      id: createTestMikaId("checkout", 4),
      providerCheckoutId: "provider_checkout_4",
      checkoutIdempotencyKey: "checkout_replay_key",
      checkoutIdempotencyInputHash: "hash_2",
    });
    const sanitizedCheckout = createCheckoutDocument({
      id: createTestMikaId("checkout", 3),
      providerCheckoutId: "provider_checkout_3",
      metadata: {
        checkoutProviderStatus: "created",
      },
    });

    await repository.put(noMetadataCheckout);
    await repository.put(metadataIdempotentCheckout);
    await repository.put(sanitizedCheckout);
    await repository.put(indexedIdempotentCheckout);

    await expect(repository.findCheckoutByIdempotencyKey("checkout_replay_key")).resolves.toEqual(
      indexedIdempotentCheckout,
    );
    await expect(
      repository.findCheckoutByIdempotencyKey("checkout_metadata_replay_key"),
    ).resolves.toEqual(metadataIdempotentCheckout);
    await expect(
      repository.findCheckoutByIdempotencyKey("checkout_metadata_replay_key"),
    ).resolves.toMatchObject({
      aggregate: { metadata: { checkoutIdempotencyInputHash: "hash_1" } },
    });
    await expect(repository.findCheckoutByIdempotencyKey("missing_key")).resolves.toBeNull();
    await expect(repository.findCheckoutByIdempotencyKey("")).resolves.toBeNull();
  });

  it("finds checkout metadata idempotency keys across cursor-paginated fallbacks", async () => {
    const collection = createStorageCollection("session");
    const repository = new SessionRepository(collection);
    const target = createCheckoutDocument({
      id: createTestMikaId("checkout", 101),
      metadata: { checkoutIdempotencyKey: "checkout_metadata_cursor_key" },
    });

    for (let index = 1; index <= 100; index += 1) {
      await repository.put(
        createCheckoutDocument({
          id: createTestMikaId("checkout", index),
          providerCheckoutId: `provider_checkout_${index}`,
        }),
      );
    }
    await repository.put(target);

    await expect(
      repository.findCheckoutByIdempotencyKey("checkout_metadata_cursor_key"),
    ).resolves.toEqual(target);
  });

  it("finds catalog aggregate refs across cursor-paginated fallbacks", async () => {
    const collection = createStorageCollection("catalog");
    const repository = new CatalogRepository(collection);
    const provider = createTestProviderName("stripe");
    const targetPrice = createPriceDefinition({
      id: createTestMikaId("price", 101),
      providerRefs: [{ provider, priceId: "price_cursor_101" }],
    });
    const targetSellable = createSellableDefinition({
      id: createTestMikaId("sellable", 101),
      prices: [targetPrice],
    });
    const targetCatalog = {
      ...createCatalogItemDocument({
        contentRef: createTestContentRef({ id: "cursor-product-101" }),
        sellables: [targetSellable],
      }),
      id: createTestMikaId("catalog", 101),
    };

    for (let index = 1; index <= 100; index += 1) {
      await repository.put({
        ...createCatalogItemDocument({
          contentRef: createTestContentRef({ id: `cursor-product-${index}` }),
          sellables: [
            createSellableDefinition({
              id: createTestMikaId("sellable", index),
              prices: [createPriceDefinition({ id: createTestMikaId("price", index) })],
            }),
          ],
        }),
        id: createTestMikaId("catalog", index),
      });
    }
    await repository.put(targetCatalog);

    await expect(repository.findItemBySellableId(targetSellable.id)).resolves.toEqual(
      targetCatalog,
    );
    await expect(repository.findPriceById(targetPrice.id)).resolves.toMatchObject({
      catalog: { id: targetCatalog.id },
      sellable: { id: targetSellable.id },
      price: { id: targetPrice.id },
    });
    await expect(
      repository.findItemByProviderPrice(provider, "price_cursor_101"),
    ).resolves.toMatchObject({
      catalog: { id: targetCatalog.id },
      sellable: { id: targetSellable.id },
      price: { id: targetPrice.id },
    });
  });

  it("finds orders by nested download refs across lines", async () => {
    const collection = createStorageCollection("ledger");
    const repository = new LedgerRepository(collection);
    const firstOrder = createOrderDocument({
      aggregate: {
        ...createOrderDocument().aggregate,
        lines: [
          {
            ...createOrderDocument().aggregate.lines[0]!,
            id: createTestMikaId("order_line", 1),
            downloadRefs: ["download:first:line_1"],
          },
          {
            ...createOrderDocument().aggregate.lines[0]!,
            id: createTestMikaId("order_line", 2),
            downloadRefs: ["download:first:line_2", "download:shared"],
          },
        ],
      },
    });
    const secondOrder = createOrderDocument({
      id: createTestMikaId("order", 2),
      orderNumber: "M-1002",
      providerPaymentId: "payment_2",
      providerOrderId: "provider_order_2",
      aggregate: {
        ...createOrderDocument().aggregate,
        lines: [
          {
            ...createOrderDocument().aggregate.lines[0]!,
            id: createTestMikaId("order_line", 3),
            downloadRefs: ["download:shared"],
          },
        ],
      },
    });

    await repository.put(secondOrder);
    await repository.put(firstOrder);

    await expect(repository.findOrderByDownloadRef("download:first:line_2")).resolves.toEqual(
      firstOrder,
    );
    await expect(repository.findOrderByDownloadRef("download:shared")).resolves.toEqual(firstOrder);
    await expect(repository.findOrderByDownloadRef("download:missing")).resolves.toBeNull();
  });

  it("finds nested download refs across cursor-paginated fallbacks", async () => {
    const collection = createStorageCollection("ledger");
    const repository = new LedgerRepository(collection);
    const target = createOrderDocument({
      id: createTestMikaId("order", 101),
      orderNumber: "M-1101",
      providerPaymentId: "payment_101",
      providerOrderId: "provider_order_101",
      aggregate: {
        ...createOrderDocument().aggregate,
        lines: [
          {
            ...createOrderDocument().aggregate.lines[0]!,
            downloadRefs: ["download:cursor:101"],
          },
        ],
      },
    });

    for (let index = 1; index <= 100; index += 1) {
      await repository.put(
        createOrderDocument({
          id: createTestMikaId("order", index),
          orderNumber: `M-${1000 + index}`,
          providerPaymentId: `payment_${index}`,
          providerOrderId: `provider_order_${index}`,
        }),
      );
    }
    await repository.put(target);

    await expect(repository.findOrderByDownloadRef("download:cursor:101")).resolves.toEqual(target);
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

  it("upserts stock definitions without overwriting live quantities", async () => {
    const db = createTestMikaDb();
    const repository = new StockRepository(db);
    const stockItem = createStockRecord({
      quantityOnHand: 10,
      quantityReserved: 4,
      lowStockThreshold: 3,
      allowBackorder: false,
      metadata: { source: "initial" },
    });

    try {
      await mikaInitialMigration.up(db);
      await repository.putItem(stockItem);
      await repository.putItemDefinition({
        ...stockItem,
        policy: "backorder",
        quantityOnHand: 99,
        quantityReserved: 88,
        lowStockThreshold: 7,
        allowBackorder: true,
        updatedAt: createTestClock().isoAt(60_000),
        metadata: { source: "definition-sync" },
      });

      await expect(repository.findBySellableId(stockItem.sellableId)).resolves.toMatchObject({
        policy: "backorder",
        quantityOnHand: 10,
        quantityReserved: 4,
        lowStockThreshold: 7,
        allowBackorder: true,
        updatedAt: "2026-01-01T00:01:00.000Z",
        metadata: { source: "definition-sync" },
      });
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

  it("composes stock mutations inside an already-open kysely transaction", async () => {
    const database = createTransactionTestMikaDb();
    const { db } = database;
    const clock = createTestClock();
    const stockItem = createStockRecord({
      quantityOnHand: 10,
      quantityReserved: 2,
    });

    try {
      await mikaInitialMigration.up(db);
      await new StockRepository(db).putItem(stockItem);

      const result = await db.transaction().execute(async (transaction) => {
        const repository = new StockRepository(transaction);

        return repository.reserve({
          reservationEventId: createTestMikaId("stock_event", 90),
          stockItemId: stockItem.id,
          quantity: 3,
          expiresAt: clock.isoAt(15 * 60_000),
          now: TEST_NOW,
          idempotencyKey: "reserve_inside_transaction_1",
        });
      });

      expect(result).toMatchObject({
        status: "reserved",
        stock: { quantityReserved: 5 },
      });
      await expect(
        new StockRepository(db).findBySellableId(stockItem.sellableId),
      ).resolves.toMatchObject({
        quantityOnHand: 10,
        quantityReserved: 5,
      });
    } finally {
      await rollbackMikaInitialMigration(db);
      await database.destroy();
    }
  });

  it("rolls back a stock mutation composed into an already-open transaction that later fails", async () => {
    // withTransaction reuses an open transaction scope instead of wrapping it in a nested one
    // (fixed in 51af9b4). Composing correctly into the caller's transaction means the mutation
    // must roll back with it, not just avoid a nested-BEGIN error — this proves atomicity, not
    // just that the call succeeds.
    const database = createTransactionTestMikaDb();
    const { db } = database;
    const clock = createTestClock();
    const stockItem = createStockRecord({
      quantityOnHand: 10,
      quantityReserved: 2,
    });

    try {
      await mikaInitialMigration.up(db);
      await new StockRepository(db).putItem(stockItem);

      await expect(
        db.transaction().execute(async (transaction) => {
          const repository = new StockRepository(transaction);
          const result = await repository.reserve({
            reservationEventId: createTestMikaId("stock_event", 91),
            stockItemId: stockItem.id,
            quantity: 3,
            expiresAt: clock.isoAt(15 * 60_000),
            now: TEST_NOW,
            idempotencyKey: "reserve_inside_transaction_rollback_1",
          });
          expect(result).toMatchObject({ status: "reserved" });

          throw new Error("simulated failure after the reservation, inside the same transaction");
        }),
      ).rejects.toThrow("simulated failure after the reservation");

      await expect(
        new StockRepository(db).findBySellableId(stockItem.sellableId),
      ).resolves.toMatchObject({
        quantityOnHand: 10,
        quantityReserved: 2,
      });
      await expect(
        new StockRepository(db).findEventByIdempotencyKey("reserve_inside_transaction_rollback_1"),
      ).resolves.toBeNull();
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

  for (const repositoryKind of ["fake", "real"] as const) {
    it(`${repositoryKind} stock repository contract consumes finite reservations without negative quantities`, async () => {
      const stockItem = createStockRecord({
        quantityOnHand: 2,
        quantityReserved: 0,
        allowBackorder: true,
      });

      await withStockRepositoryContractHarness(
        repositoryKind,
        stockItem,
        async ({ repository, service }) => {
          const clock = createTestClock();
          const reservation = await service.reserve({
            stockItemId: stockItem.id,
            quantity: 4,
            expiresAt: clock.isoAt(15 * 60_000),
            idempotencyKey: `${repositoryKind}_consume_contract_1`,
          });
          if (reservation.status !== "reserved") {
            throw new Error(`Expected reservation, received '${reservation.status}'.`);
          }

          await expect(
            service.consume({
              reservationEventId: reservation.event.id,
              now: clock.isoAt(60_000),
            }),
          ).resolves.toMatchObject({
            status: "consumed",
            stock: {
              quantityOnHand: 0,
              quantityReserved: 0,
            },
          });
          await expect(repository.findBySellableId(stockItem.sellableId)).resolves.toMatchObject({
            quantityOnHand: 0,
            quantityReserved: 0,
          });
        },
      );
    });

    it(`${repositoryKind} stock repository contract keeps reservation policy independent from availability override`, async () => {
      const stockItem = createStockRecord({
        quantityOnHand: 2,
        quantityReserved: 0,
        availableOverride: false,
      });

      await withStockRepositoryContractHarness(
        repositoryKind,
        stockItem,
        async ({ repository, service }) => {
          const result = await service.reserve({
            stockItemId: stockItem.id,
            quantity: 1,
            expiresAt: createTestClock().isoAt(15 * 60_000),
            idempotencyKey: `${repositoryKind}_available_override_contract_1`,
          });

          expect(result).toMatchObject({
            status: "reserved",
            stock: {
              quantityReserved: 1,
            },
          });
          await expect(repository.findBySellableId(stockItem.sellableId)).resolves.toMatchObject({
            quantityReserved: 1,
          });
        },
      );
    });

    it(`${repositoryKind} stock repository contract releases expired reservations once`, async () => {
      const stockItem = createStockRecord({
        quantityOnHand: 5,
        quantityReserved: 0,
      });

      await withStockRepositoryContractHarness(
        repositoryKind,
        stockItem,
        async ({ repository, service }) => {
          const clock = createTestClock();
          const expiredReservation = await service.reserve({
            stockItemId: stockItem.id,
            quantity: 2,
            expiresAt: clock.isoAt(30_000),
            idempotencyKey: `${repositoryKind}_expired_contract_1`,
          });
          const activeReservation = await service.reserve({
            stockItemId: stockItem.id,
            quantity: 1,
            expiresAt: clock.isoAt(15 * 60_000),
            idempotencyKey: `${repositoryKind}_expired_contract_2`,
          });
          if (expiredReservation.status !== "reserved" || activeReservation.status !== "reserved") {
            throw new Error("Expected reservations to be created.");
          }

          await expect(
            service.releaseExpiredReservations({ now: clock.isoAt(60_000) }),
          ).resolves.toMatchObject({
            scannedCount: 1,
            releasedCount: 1,
            stockItemsAffected: 1,
          });
          await expect(
            repository.findEventById(expiredReservation.event.id),
          ).resolves.toMatchObject({
            status: "expired",
          });
          await expect(repository.findEventById(activeReservation.event.id)).resolves.toMatchObject(
            {
              status: "active",
            },
          );
          await expect(repository.findBySellableId(stockItem.sellableId)).resolves.toMatchObject({
            quantityReserved: 1,
          });
        },
      );
    });

    it(`${repositoryKind} stock repository contract frees the idempotency key when a reservation expires`, async () => {
      const stockItem = createStockRecord({
        quantityOnHand: 5,
        quantityReserved: 0,
      });

      await withStockRepositoryContractHarness(
        repositoryKind,
        stockItem,
        async ({ repository, service }) => {
          const clock = createTestClock();
          const key = `${repositoryKind}_stuck_replay_key`;
          const reservation = await service.reserve({
            stockItemId: stockItem.id,
            quantity: 2,
            expiresAt: clock.isoAt(30_000),
            idempotencyKey: key,
          });
          if (reservation.status !== "reserved") {
            throw new Error("Expected reservation to be created.");
          }

          await expect(repository.findEventByIdempotencyKey(key)).resolves.toMatchObject({
            id: reservation.event.id,
            status: "active",
          });

          await service.releaseExpiredReservations({ now: clock.isoAt(60_000) });

          await expect(repository.findEventByIdempotencyKey(key)).resolves.toBeNull();

          const retry = await service.reserve({
            stockItemId: stockItem.id,
            quantity: 1,
            expiresAt: clock.isoAt(20 * 60_000),
            idempotencyKey: key,
          });
          expect(retry.status).toBe("reserved");
          if (retry.status === "reserved") {
            expect(retry.event.id).not.toBe(reservation.event.id);
          }
        },
      );
    });

    it(`${repositoryKind} stock repository contract extends active reservation expiry without shortening`, async () => {
      const stockItem = createStockRecord({
        quantityOnHand: 5,
        quantityReserved: 0,
      });

      await withStockRepositoryContractHarness(
        repositoryKind,
        stockItem,
        async ({ repository, service }) => {
          const clock = createTestClock();
          const reservation = await service.reserve({
            stockItemId: stockItem.id,
            quantity: 2,
            expiresAt: clock.isoAt(15 * 60_000),
            idempotencyKey: `${repositoryKind}_extend_contract_1`,
          });
          if (reservation.status !== "reserved") {
            throw new Error("Expected reservation to be created.");
          }

          await service.extendReservations({
            reservationEventIds: [reservation.event.id],
            expiresAt: clock.isoAt(24 * 60 * 60_000),
            now: clock.isoAt(1_000),
          });
          await service.extendReservations({
            reservationEventIds: [reservation.event.id],
            expiresAt: clock.isoAt(5 * 60_000),
            now: clock.isoAt(2_000),
          });
          await expect(repository.findEventById(reservation.event.id)).resolves.toMatchObject({
            status: "active",
            expiresAt: clock.isoAt(24 * 60 * 60_000),
          });

          await expect(
            service.releaseExpiredReservations({ now: clock.isoAt(16 * 60_000) }),
          ).resolves.toMatchObject({ releasedCount: 0 });
          await expect(repository.findEventById(reservation.event.id)).resolves.toMatchObject({
            status: "active",
          });
          await expect(repository.findBySellableId(stockItem.sellableId)).resolves.toMatchObject({
            quantityReserved: 2,
          });
        },
      );
    });

    it(`${repositoryKind} stock repository contract consumes an expired reservation for late paid fulfillment`, async () => {
      const stockItem = createStockRecord({
        quantityOnHand: 5,
        quantityReserved: 0,
      });

      await withStockRepositoryContractHarness(
        repositoryKind,
        stockItem,
        async ({ repository, service }) => {
          const clock = createTestClock();
          const expiredReservation = await service.reserve({
            stockItemId: stockItem.id,
            quantity: 2,
            expiresAt: clock.isoAt(30_000),
            idempotencyKey: `${repositoryKind}_expired_consume_1`,
          });
          const otherReservation = await service.reserve({
            stockItemId: stockItem.id,
            quantity: 1,
            expiresAt: clock.isoAt(15 * 60_000),
            idempotencyKey: `${repositoryKind}_expired_consume_2`,
          });
          if (expiredReservation.status !== "reserved" || otherReservation.status !== "reserved") {
            throw new Error("Expected reservations to be created.");
          }

          await service.releaseExpiredReservations({ now: clock.isoAt(60_000) });
          await expect(repository.findBySellableId(stockItem.sellableId)).resolves.toMatchObject({
            quantityOnHand: 5,
            quantityReserved: 1,
          });

          await expect(
            service.consume({
              reservationEventId: expiredReservation.event.id,
              orderId: createTestMikaId("order", 1),
              orderLineId: createTestMikaId("order_line", 1),
              now: clock.isoAt(90_000),
            }),
          ).resolves.toMatchObject({ status: "consumed", event: { status: "consumed" } });

          await expect(repository.findBySellableId(stockItem.sellableId)).resolves.toMatchObject({
            quantityOnHand: 3,
            quantityReserved: 1,
          });

          await expect(
            service.consume({
              reservationEventId: expiredReservation.event.id,
              orderId: createTestMikaId("order", 1),
              orderLineId: createTestMikaId("order_line", 1),
              now: clock.isoAt(120_000),
            }),
          ).resolves.toMatchObject({ status: "not_active", event: { status: "consumed" } });
          await expect(repository.findBySellableId(stockItem.sellableId)).resolves.toMatchObject({
            quantityOnHand: 3,
            quantityReserved: 1,
          });
        },
      );
    });

    it(`${repositoryKind} stock repository contract refuses an expired-reservation consume that would oversell`, async () => {
      const stockItem = createStockRecord({
        quantityOnHand: 5,
        quantityReserved: 0,
      });

      await withStockRepositoryContractHarness(
        repositoryKind,
        stockItem,
        async ({ repository, service }) => {
          const clock = createTestClock();
          const expiredReservation = await service.reserve({
            stockItemId: stockItem.id,
            quantity: 5,
            expiresAt: clock.isoAt(30_000),
            idempotencyKey: `${repositoryKind}_oversell_contract_1`,
          });
          if (expiredReservation.status !== "reserved") {
            throw new Error("Expected reservation to be created.");
          }

          await service.releaseExpiredReservations({ now: clock.isoAt(60_000) });

          const activeReservation = await service.reserve({
            stockItemId: stockItem.id,
            quantity: 5,
            expiresAt: clock.isoAt(15 * 60_000),
            idempotencyKey: `${repositoryKind}_oversell_contract_2`,
          });
          if (activeReservation.status !== "reserved") {
            throw new Error("Expected re-reservation to succeed.");
          }
          await expect(repository.findBySellableId(stockItem.sellableId)).resolves.toMatchObject({
            quantityOnHand: 5,
            quantityReserved: 5,
          });

          await expect(
            service.consume({
              reservationEventId: expiredReservation.event.id,
              orderId: createTestMikaId("order", 1),
              orderLineId: createTestMikaId("order_line", 1),
              now: clock.isoAt(90_000),
            }),
          ).rejects.toThrow(/oversell/i);

          await expect(repository.findBySellableId(stockItem.sellableId)).resolves.toMatchObject({
            quantityOnHand: 5,
            quantityReserved: 5,
          });
          await expect(
            repository.findEventById(expiredReservation.event.id),
          ).resolves.toMatchObject({ status: "expired" });
        },
      );
    });

    it(`${repositoryKind} stock repository contract re-reserves with the same idempotency key after release`, async () => {
      const stockItem = createStockRecord({
        quantityOnHand: 5,
        quantityReserved: 0,
      });

      await withStockRepositoryContractHarness(
        repositoryKind,
        stockItem,
        async ({ repository, service }) => {
          const clock = createTestClock();
          const idempotencyKey = `${repositoryKind}_rereserve_after_release`;

          const first = await service.reserve({
            stockItemId: stockItem.id,
            quantity: 2,
            expiresAt: clock.isoAt(15 * 60_000),
            idempotencyKey,
          });
          if (first.status !== "reserved") {
            throw new Error(`Expected reservation, received '${first.status}'.`);
          }

          await expect(
            service.release({ reservationEventId: first.event.id, now: clock.isoAt(60_000) }),
          ).resolves.toMatchObject({ status: "released", event: { status: "released" } });
          await expect(repository.findBySellableId(stockItem.sellableId)).resolves.toMatchObject({
            quantityReserved: 0,
          });

          const retry = await service.reserve({
            stockItemId: stockItem.id,
            quantity: 2,
            expiresAt: clock.isoAt(20 * 60_000),
            idempotencyKey,
          });
          expect(retry.status).toBe("reserved");
          if (retry.status !== "reserved") {
            throw new Error(`Expected re-reservation, received '${retry.status}'.`);
          }
          expect(retry.event.id).not.toBe(first.event.id);
          await expect(repository.findBySellableId(stockItem.sellableId)).resolves.toMatchObject({
            quantityReserved: 2,
          });
        },
      );
    });

    it(`${repositoryKind} stock repository contract preserves terminal reservation invariants`, async () => {
      const scenarios = [
        {
          name: "release twice",
          run: async (
            service: ReturnType<typeof createMikaStockLifecycleService>,
            stockItem: StockItemRecord,
            idempotencyKey: string,
          ) => {
            const clock = createTestClock();
            const reservation = await service.reserve({
              stockItemId: stockItem.id,
              quantity: 3,
              expiresAt: clock.isoAt(15 * 60_000),
              idempotencyKey,
            });
            if (reservation.status !== "reserved") {
              throw new Error(`Expected reservation, received '${reservation.status}'.`);
            }

            await expect(
              service.release({
                reservationEventId: reservation.event.id,
                now: clock.isoAt(60_000),
              }),
            ).resolves.toMatchObject({ status: "released", event: { status: "released" } });
            await expect(
              service.release({
                reservationEventId: reservation.event.id,
                now: clock.isoAt(120_000),
              }),
            ).resolves.toMatchObject({ status: "not_active", event: { status: "released" } });

            return { eventId: reservation.event.id, status: "released" as const };
          },
          expectedStock: { quantityOnHand: 8, quantityReserved: 0 },
        },
        {
          name: "consume then release",
          run: async (
            service: ReturnType<typeof createMikaStockLifecycleService>,
            stockItem: StockItemRecord,
            idempotencyKey: string,
          ) => {
            const clock = createTestClock();
            const reservation = await service.reserve({
              stockItemId: stockItem.id,
              quantity: 3,
              expiresAt: clock.isoAt(15 * 60_000),
              idempotencyKey,
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
            ).resolves.toMatchObject({ status: "consumed", event: { status: "consumed" } });
            await expect(
              service.release({
                reservationEventId: reservation.event.id,
                now: clock.isoAt(120_000),
              }),
            ).resolves.toMatchObject({ status: "not_active", event: { status: "consumed" } });

            return { eventId: reservation.event.id, status: "consumed" as const };
          },
          expectedStock: { quantityOnHand: 5, quantityReserved: 0 },
        },
        {
          name: "expire then release expired",
          run: async (
            service: ReturnType<typeof createMikaStockLifecycleService>,
            stockItem: StockItemRecord,
            idempotencyKey: string,
          ) => {
            const clock = createTestClock();
            const reservation = await service.reserve({
              stockItemId: stockItem.id,
              quantity: 3,
              expiresAt: clock.isoAt(30_000),
              idempotencyKey,
            });
            if (reservation.status !== "reserved") {
              throw new Error(`Expected reservation, received '${reservation.status}'.`);
            }

            await expect(
              service.releaseExpiredReservations({ now: clock.isoAt(60_000) }),
            ).resolves.toMatchObject({
              scannedCount: 1,
              releasedCount: 1,
              stockItemsAffected: 1,
            });
            await expect(
              service.releaseExpiredReservations({ now: clock.isoAt(120_000) }),
            ).resolves.toMatchObject({
              scannedCount: 0,
              releasedCount: 0,
              stockItemsAffected: 0,
            });

            return { eventId: reservation.event.id, status: "expired" as const };
          },
          expectedStock: { quantityOnHand: 8, quantityReserved: 0 },
        },
        {
          name: "reserve replay",
          run: async (
            service: ReturnType<typeof createMikaStockLifecycleService>,
            stockItem: StockItemRecord,
            idempotencyKey: string,
          ) => {
            const clock = createTestClock();
            const reservation = await service.reserve({
              stockItemId: stockItem.id,
              quantity: 3,
              expiresAt: clock.isoAt(15 * 60_000),
              idempotencyKey,
            });
            const replay = await service.reserve({
              stockItemId: stockItem.id,
              quantity: 3,
              expiresAt: clock.isoAt(15 * 60_000),
              idempotencyKey,
            });
            if (reservation.status !== "reserved" || replay.status !== "replayed") {
              throw new Error("Expected reservation replay to reuse the original event.");
            }

            expect(replay.event).toEqual(reservation.event);
            expect(replay.stock).toEqual(reservation.stock);

            return { eventId: reservation.event.id, status: "active" as const };
          },
          expectedStock: { quantityOnHand: 8, quantityReserved: 3 },
        },
      ];

      for (const scenario of scenarios) {
        const stockItem = createStockRecord({
          quantityOnHand: 8,
          quantityReserved: 0,
        });
        const idempotencyKey = `${repositoryKind}_${scenario.name.replaceAll(" ", "_")}`;

        await withStockRepositoryContractHarness(
          repositoryKind,
          stockItem,
          async ({ repository, service }) => {
            const terminal = await scenario.run(service, stockItem, idempotencyKey);

            await expect(repository.findEventById(terminal.eventId)).resolves.toMatchObject({
              status: terminal.status,
            });
            await expect(repository.findBySellableId(stockItem.sellableId)).resolves.toMatchObject(
              scenario.expectedStock,
            );
            const finalStock = await repository.findBySellableId(stockItem.sellableId);
            expect(finalStock?.quantityOnHand ?? -1).toBeGreaterThanOrEqual(0);
            expect(finalStock?.quantityReserved ?? -1).toBeGreaterThanOrEqual(0);
          },
        );
      }
    });

    it(`${repositoryKind} stock repository contract adjusts stock and replays idempotency keys`, async () => {
      const stockItem = createStockRecord({
        quantityOnHand: 5,
        quantityReserved: 2,
      });

      await withStockRepositoryContractHarness(
        repositoryKind,
        stockItem,
        async ({ repository, service }) => {
          const result = await service.adjust({
            stockItemId: stockItem.id,
            quantityDelta: 3,
            reason: "sync",
            idempotencyKey: `${repositoryKind}_adjust_contract_1`,
            metadata: { source: "contract-test" },
          });

          expect(result).toMatchObject({
            status: "adjusted",
            event: {
              kind: "movement",
              status: "recorded",
              reason: "sync",
              quantityDelta: 3,
              idempotencyKey: `${repositoryKind}_adjust_contract_1`,
              metadata: { source: "contract-test" },
            },
            stock: {
              quantityOnHand: 8,
              quantityReserved: 2,
            },
          });
          if (result.status !== "adjusted") {
            throw new Error(`Expected adjusted stock, received '${result.status}'.`);
          }

          const replay = await service.adjust({
            stockItemId: stockItem.id,
            quantityDelta: 3,
            idempotencyKey: `${repositoryKind}_adjust_contract_1`,
          });

          expect(replay).toMatchObject({
            status: "replayed",
            event: { id: result.event.id },
            stock: { quantityOnHand: 8, quantityReserved: 2 },
          });
          await expect(repository.findBySellableId(stockItem.sellableId)).resolves.toMatchObject({
            quantityOnHand: 8,
            quantityReserved: 2,
          });
        },
      );
    });

    it(`${repositoryKind} stock repository contract reports missing and invalid adjustments`, async () => {
      const stockItem = createStockRecord({
        quantityOnHand: 5,
        quantityReserved: 2,
      });

      await withStockRepositoryContractHarness(
        repositoryKind,
        stockItem,
        async ({ repository, service }) => {
          await expect(
            service.adjust({
              stockItemId: createTestMikaId("stock", 404),
              quantityDelta: 1,
              idempotencyKey: `${repositoryKind}_adjust_missing_1`,
            }),
          ).resolves.toEqual({ status: "not_found" });

          await expect(
            service.adjust({
              stockItemId: stockItem.id,
              quantityDelta: -6,
              idempotencyKey: `${repositoryKind}_adjust_negative_1`,
            }),
          ).resolves.toMatchObject({
            status: "would_go_negative",
            stock: { quantityOnHand: 5, quantityReserved: 2 },
          });

          await expect(
            service.adjust({
              stockItemId: stockItem.id,
              quantityDelta: -4,
              idempotencyKey: `${repositoryKind}_adjust_reserved_1`,
            }),
          ).resolves.toMatchObject({
            status: "would_undercut_reserved",
            stock: { quantityOnHand: 5, quantityReserved: 2 },
          });

          await expect(
            service.adjust({
              stockItemId: stockItem.id,
              quantityDelta: 0,
            }),
          ).rejects.toThrow("Stock adjustment quantity must be a non-zero whole number.");

          await expect(repository.findBySellableId(stockItem.sellableId)).resolves.toMatchObject({
            quantityOnHand: 5,
            quantityReserved: 2,
          });
        },
      );
    });
  }

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
      await expect(api.admin.releaseExpiredReservations()).resolves.toMatchObject({
        ok: true,
        status: 200,
        data: {
          status: "completed",
          affected: {
            reservationsReleased: 0,
          },
        },
      });
    } finally {
      await rollbackMikaInitialMigration(db);
      await database.destroy();
    }
  });

  it("deduplicates expired reservation release by idempotency key", async () => {
    const database = createTransactionTestMikaDb();
    const { db } = database;
    const repository = new StockRepository(db);
    const repositories = { ...createTestBackendRepositories(), stock: repository };
    const dependencies = createIncrementingBackendDependencies({ repositories });
    const api = createMikaBackendApi(dependencies);
    const service = createMikaStockLifecycleService(dependencies);
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
        idempotencyKey: "release_expired_idem_reserve_1",
      });
      if (expiredReservation.status !== "reserved") {
        throw new Error("Expected stock reservation to be created.");
      }
      const releaseInput = {
        now: clock.isoAt(60_000),
        idempotencyKey: "release_expired_idem_1",
      };

      const first = await api.admin.releaseExpiredReservations(releaseInput);
      expect(first).toMatchObject({
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

      const second = await api.admin.releaseExpiredReservations(releaseInput);
      expect(second).toMatchObject({
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
      });
      await expect(countStockEvents(db)).resolves.toBe(1);
      await expect(
        repositories.ops.findAdminAudit(createTestMikaId("admin_audit", 2)),
      ).resolves.toBeNull();
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
        now: createTestClock().isoAt(60_000),
      };

      expectMikaOk(await api.admin.stockAdjust(input), {
        id: "stock_event_1",
        status: "completed",
        affected: {
          stockItems: 1,
          movements: 1,
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
        createdAt: TEST_NOW,
        updatedAt: TEST_NOW,
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

  it("rejects admin stock adjustment idempotency replay for a different stock item", async () => {
    const database = createTransactionTestMikaDb();
    const { db } = database;
    const repository = new StockRepository(db);
    const api = createMikaBackendApi(
      createIncrementingBackendDependencies({
        repositories: { ...createTestBackendRepositories(), stock: repository },
      }),
    );
    const firstStockItem = createStockRecord({
      id: createTestMikaId("stock", 1),
      sellableId: createTestMikaId("sellable", 1),
      quantityOnHand: 5,
      quantityReserved: 0,
    });
    const secondStockItem = createStockRecord({
      id: createTestMikaId("stock", 2),
      sellableId: createTestMikaId("sellable", 2),
      quantityOnHand: 7,
      quantityReserved: 0,
    });

    try {
      await mikaInitialMigration.up(db);
      await repository.putItem(firstStockItem);
      await repository.putItem(secondStockItem);

      await expect(
        api.admin.stockAdjust({
          stockItemId: firstStockItem.id,
          quantityDelta: 2,
          idempotencyKey: "stock_adjust_shared_key",
        }),
      ).resolves.toMatchObject({ ok: true, status: 200 });
      await expect(
        api.admin.stockAdjust({
          stockItemId: secondStockItem.id,
          quantityDelta: 3,
          idempotencyKey: "stock_adjust_shared_key",
        }),
      ).resolves.toEqual({
        ok: false,
        status: 409,
        error: {
          code: "CONFLICT",
          message: "Stock adjustment idempotency key was reused for a different stock item.",
        },
      });
      await expect(repository.findBySellableId(secondStockItem.sellableId)).resolves.toMatchObject({
        quantityOnHand: 7,
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
        api.admin.stockAdjust({
          stockItemId: stockItem.id,
          quantityDelta: -5,
          idempotencyKey: "stock_adjust_reserved_conflict_1",
        }),
      ).resolves.toEqual({
        ok: false,
        status: 409,
        error: {
          code: "CONFLICT",
          message: `Stock adjustment for '${stockItem.id}' would undercut active reservations.`,
        },
      });
      await expect(repository.findBySellableId(stockItem.sellableId)).resolves.toMatchObject({
        quantityOnHand: 5,
        quantityReserved: 1,
      });
      await expect(
        repository.findEventByIdempotencyKey("stock_adjust_conflict_1"),
      ).resolves.toBeNull();
      await expect(
        repository.findEventByIdempotencyKey("stock_adjust_reserved_conflict_1"),
      ).resolves.toBeNull();
      await expect(countStockEvents(db)).resolves.toBe(0);
    } finally {
      await rollbackMikaInitialMigration(db);
      await database.destroy();
    }
  });
});

describe("backend test ephemeral token repository", () => {
  it("purges the download-token reuse pointer alongside the token on account-delete erasure", async () => {
    // createOrderLineDownloadToken's reuse pointer (kind: "cache_marker") carries the same
    // subjectHash as the "token" record it points to. Account-delete erasure must sweep both, or
    // a subject-linked pointer survives the customer's own token being purged.
    const db = createTestMikaDb();
    const repository = new EphemeralRepository(db);
    const subjectHash = "customer:customer_1";

    try {
      await mikaInitialMigration.up(db);
      await repository.put({
        key: "download-token:token_1",
        kind: "token",
        subjectHash,
        status: "pending",
        count: 0,
        expiresAt: TEST_NOW,
        version: 1,
        createdAt: TEST_NOW,
        updatedAt: TEST_NOW,
      });
      await repository.put({
        key: "download-token-pointer:order_1:order_line_1:download_ref_1",
        kind: "cache_marker",
        subjectHash,
        status: "active",
        count: 0,
        expiresAt: TEST_NOW,
        version: 1,
        createdAt: TEST_NOW,
        updatedAt: TEST_NOW,
        data: { tokenId: "token_1" },
      });

      await expect(repository.deleteTokensBySubjectHashes([subjectHash])).resolves.toBe(2);
      await expect(repository.get("download-token:token_1")).resolves.toBeNull();
      await expect(
        repository.get("download-token-pointer:order_1:order_line_1:download_ref_1"),
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
    await expectMethodBackedProviderCapabilities(fake.provider);
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

    await expectMethodBackedProviderCapabilities(fake.provider);
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
    expect(() => assertMikaApiWired(api, { scope: ["catalog"] })).not.toThrow();
    expect(() => assertMikaApiWired(api, { scope: ["cart.add"] })).toThrow(
      "Mika API is missing wired methods: cart.add.",
    );
    expect(() => assertMikaApiWired(api, { scope: ["chekout"] })).toThrow(
      "Unknown Mika API wiring scope: chekout.",
    );
    expect(() => assertMikaApiWired(api, { scope: ["checkout.satrt"] })).toThrow(
      "Unknown Mika API wiring scope: checkout.satrt.",
    );
    expect(() => assertMikaApiWired(api)).toThrow("cart.add");
    expect(() => assertMikaApiWired(createFullyWiredTestApi())).not.toThrow();

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

  it("creates a complete Mika API with focused overrides and override-shell defaults", async () => {
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
    expect(() =>
      assertMikaApiWired(api, {
        scope: [
          "catalog",
          "stock",
          "cart",
          "wishlist",
          "checkout",
          "magicLink",
          "account",
          "subscription",
          "download",
          "order",
          "webhook",
          "admin",
        ],
      }),
    ).not.toThrow();
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

  it("converts an unhandled host API throw into a 500 envelope on the route dispatch path", async () => {
    // handleRouteOperation previously let a throwing host MikaApi override propagate raw,
    // unlike the admin action runner path, which already caught this. A throwing override
    // (a policy hook bug, an unimplemented edge case) must not escape as an uncaught rejection.
    const api = createMikaApi({
      catalog: {
        sellables: async () => {
          throw new Error("host override bug");
        },
      },
    });
    const routes = createMikaPluginRoutes(api);

    await expect(
      routes[mikaPluginRoutes.catalogSellables].handler({
        input: {},
        request: new Request(
          "https://shop.example.test/_emdash/api/plugins/mika/catalog/sellables?collection=products&id=route-product",
        ),
      }),
    ).resolves.toMatchObject({
      ok: false,
      status: 500,
      error: { code: "INTERNAL", message: "Mika operation failed." },
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

  it("queues a pending token and email for magic link requests", async () => {
    const notificationIntents: MikaNotificationIntent[] = [];
    const harness = await createMagicLinkHarness({
      ttlMs: 60_000,
      notificationHook: (intent) => {
        notificationIntents.push(intent);
      },
    });

    try {
      await expect(
        harness.api.magicLink.request(
          createTestRequestContext({ customerId: false, userId: false }),
          { email: "Subscriber@Example.test", returnTo: "/account" },
        ),
      ).resolves.toEqual({ ok: true, status: 200, data: { sent: true } });

      const tokenHash = createTestHash("magic-link-token:magic_link_token_1");
      const expectedLink =
        "https://shop.example.test/account/magic-link?token=magic_link_token_1&returnTo=%2Faccount";
      await expect(harness.repositories.ephemeral.get(tokenHash)).resolves.toMatchObject({
        key: tokenHash,
        kind: "token",
        subjectHash: createTestHash("email:subscriber@example.test"),
        status: "pending",
        count: 0,
        expiresAt: "2026-01-01T00:01:00.000Z",
        data: {
          purpose: "magic_link",
          tokenId: "magic_link_token_1",
          email: "Subscriber@Example.test",
          returnTo: "/account",
        },
      });
      expect(notificationIntents).toHaveLength(1);
      expect(notificationIntents[0]).toMatchObject({
        kind: "magic_link.requested",
        occurredAt: TEST_NOW,
        context: {
          toEmail: "Subscriber@Example.test",
          emailHash: createTestHash("email:subscriber@example.test"),
          link: expectedLink,
          purpose: "sign_in",
          expiresAt: "2026-01-01T00:01:00.000Z",
          returnTo: "/account",
          tokenId: "magic_link_token_1",
        },
      });

      const emails = await harness.opsCollection.query({ where: { type: "email" } });
      expect(emails.items).toHaveLength(1);
      const queuedEmail = emails.items[0]?.data;
      if (!queuedEmail || queuedEmail.type !== "email") {
        throw new Error("Expected a queued magic link email document.");
      }
      expect(queuedEmail).toMatchObject({
        id: "email_1",
        type: "email",
        status: "queued",
        tokenId: "magic_link_token_1",
        kind: "magic_link",
        record: {
          toEmail: "Subscriber@Example.test",
          subject: "Sign in to Mika",
          status: "queued",
          idempotencyKey: `magic-link:${tokenHash}`,
          nextAttemptAt: "2026-01-01T00:00:00.000Z",
          metadata: {
            expiresAt: "2026-01-01T00:01:00.000Z",
            returnTo: "/account",
          },
        },
      });
      expect(queuedEmail.record.metadata?.["link"]).toBe(expectedLink);
    } finally {
      await harness.destroy();
    }
  });

  it("normalizes unsafe magic link return targets before storing and emailing them", async () => {
    const notificationIntents: MikaNotificationIntent[] = [];
    const harness = await createMagicLinkHarness({
      ttlMs: 60_000,
      notificationHook: (intent) => {
        notificationIntents.push(intent);
      },
    });

    try {
      await expect(
        harness.api.magicLink.request(
          createTestRequestContext({ customerId: false, userId: false }),
          { email: "Subscriber@Example.test", returnTo: "https://evil.test/phish" },
        ),
      ).resolves.toEqual({ ok: true, status: 200, data: { sent: true } });

      const tokenHash = createTestHash("magic-link-token:magic_link_token_1");
      await expect(harness.repositories.ephemeral.get(tokenHash)).resolves.toMatchObject({
        data: {
          returnTo: "/products/test-product?ref=test",
        },
      });
      expect(notificationIntents).toHaveLength(1);
      expect(notificationIntents[0]).toMatchObject({
        kind: "magic_link.requested",
        context: {
          returnTo: "/products/test-product?ref=test",
          link: "https://shop.example.test/account/magic-link?token=magic_link_token_1&returnTo=%2Fproducts%2Ftest-product%3Fref%3Dtest",
        },
      });

      const emails = await harness.opsCollection.query({ where: { type: "email" } });
      const queuedEmail = emails.items[0]?.data;
      if (!queuedEmail || queuedEmail.type !== "email") {
        throw new Error("Expected a queued magic link email document.");
      }
      expect(queuedEmail.record.metadata?.["returnTo"]).toBe("/products/test-product?ref=test");
      expect(queuedEmail.record.metadata?.["link"]).toBe(
        "https://shop.example.test/account/magic-link?token=magic_link_token_1&returnTo=%2Fproducts%2Ftest-product%3Fref%3Dtest",
      );
    } finally {
      await harness.destroy();
    }
  });

  it("builds the magic-link email URL from the configured verify page path", async () => {
    const notificationIntents: MikaNotificationIntent[] = [];
    const harness = await createMagicLinkHarness({
      ttlMs: 60_000,
      verifyPath: "/sign-in",
      notificationHook: (intent) => {
        notificationIntents.push(intent);
      },
    });

    try {
      await expect(
        harness.api.magicLink.request(
          createTestRequestContext({ customerId: false, userId: false }),
          { email: "Subscriber@Example.test", returnTo: "/account" },
        ),
      ).resolves.toEqual({ ok: true, status: 200, data: { sent: true } });

      expect(notificationIntents[0]).toMatchObject({
        kind: "magic_link.requested",
        context: {
          link: "https://shop.example.test/sign-in?token=magic_link_token_1&returnTo=%2Faccount",
        },
      });
    } finally {
      await harness.destroy();
    }
  });

  it("does not queue Mika's default magic-link email when the hook handles it", async () => {
    const notificationIntents: MikaNotificationIntent[] = [];
    const harness = await createMagicLinkHarness({
      ttlMs: 60_000,
      notificationHook: (intent) => {
        notificationIntents.push(intent);
        return { handled: true };
      },
    });

    try {
      await expect(
        harness.api.magicLink.request(
          createTestRequestContext({ customerId: false, userId: false }),
          { email: "Subscriber@Example.test", returnTo: "/account" },
        ),
      ).resolves.toEqual({ ok: true, status: 200, data: { sent: true } });

      expect(notificationIntents).toHaveLength(1);
      expect(notificationIntents[0]).toMatchObject({
        kind: "magic_link.requested",
        context: {
          toEmail: "Subscriber@Example.test",
          returnTo: "/account",
        },
      });
      const emails = await harness.opsCollection.query({ where: { type: "email" } });
      expect(emails.items).toHaveLength(0);
    } finally {
      await harness.destroy();
    }
  });

  it("queues Mika's default magic-link email when the notification hook throws", async () => {
    const harness = await createMagicLinkHarness({
      ttlMs: 60_000,
      notificationHook: () => {
        throw new Error("notification unavailable");
      },
    });

    try {
      await expect(
        harness.api.magicLink.request(
          createTestRequestContext({ customerId: false, userId: false }),
          { email: "Subscriber@Example.test", returnTo: "/account" },
        ),
      ).resolves.toEqual({ ok: true, status: 200, data: { sent: true } });

      const emails = await harness.opsCollection.query({ where: { type: "email" } });
      expect(emails.items).toHaveLength(1);
      expect(emails.items[0]?.data).toMatchObject({
        type: "email",
        kind: "magic_link",
        status: "queued",
        record: {
          metadata: {
            link: "https://shop.example.test/account/magic-link?token=magic_link_token_1&returnTo=%2Faccount",
          },
        },
      });
    } finally {
      await harness.destroy();
    }
  });

  it("verifies magic links once and returns the matching account DTO", async () => {
    const harness = await createMagicLinkHarness();

    try {
      await harness.accountCollection.put("customer_document_1", createCustomerDocument());
      await harness.api.magicLink.request(createTestRequestContext(), {
        email: "subscriber@example.test",
      });

      await expect(
        harness.api.magicLink.verify(createTestRequestContext(), {
          token: "magic_link_token_1",
        }),
      ).resolves.toMatchObject({
        ok: true,
        status: 200,
        data: {
          customer: {
            id: "customer_1",
            userId: "user_1",
            email: "Subscriber@Example.test",
            name: "Subscriber One",
          },
          orders: [],
          subscriptions: [],
          entitlements: [],
          downloads: [],
        },
      });

      await expect(
        harness.repositories.ephemeral.get(createTestHash("magic-link-token:magic_link_token_1")),
      ).resolves.toMatchObject({
        status: "consumed",
        version: 2,
      });
      await expect(
        harness.api.magicLink.verify(createTestRequestContext(), {
          token: "magic_link_token_1",
        }),
      ).resolves.toMatchObject({
        ok: false,
        status: 410,
        error: { code: "TOKEN_USED" },
      });
    } finally {
      await harness.destroy();
    }
  });

  it("restores the magic-link token when the session write fails so the link stays usable", async () => {
    const harness = await createMagicLinkHarness();

    try {
      await harness.accountCollection.put("customer_document_1", createCustomerDocument());
      await harness.api.magicLink.request(createTestRequestContext(), {
        email: "subscriber@example.test",
      });
      const tokenHash = createTestHash("magic-link-token:magic_link_token_1");

      const failingCtx = {
        ...createTestRequestContext(),
        session: {
          get: async () => undefined,
          set: async () => {
            throw new Error("session store outage");
          },
        },
      };
      await expect(
        harness.api.magicLink.verify(failingCtx, { token: "magic_link_token_1" }),
      ).rejects.toThrow("session store outage");

      await expect(harness.repositories.ephemeral.get(tokenHash)).resolves.toMatchObject({
        status: "pending",
      });

      await expect(
        harness.api.magicLink.verify(createTestRequestContext(), {
          token: "magic_link_token_1",
        }),
      ).resolves.toMatchObject({
        ok: true,
        status: 200,
        data: { customer: { id: "customer_1" } },
      });
    } finally {
      await harness.destroy();
    }
  });

  it("rotates the session before binding identity on magic-link verify", async () => {
    const harness = await createMagicLinkHarness();

    try {
      await harness.accountCollection.put("customer_document_1", createCustomerDocument());
      await harness.api.magicLink.request(createTestRequestContext(), {
        email: "subscriber@example.test",
      });

      const calls: string[] = [];
      const store: Record<string, unknown> = {};
      const ctx = {
        ...createTestRequestContext(),
        session: {
          get: async () => undefined,
          set: async (key: string, value: unknown) => {
            calls.push(`set:${key}`);
            store[key] = value;
          },
          regenerate: async () => {
            calls.push("regenerate");
          },
        },
      };

      await expect(
        harness.api.magicLink.verify(ctx, { token: "magic_link_token_1" }),
      ).resolves.toMatchObject({ ok: true, data: { customer: { id: "customer_1" } } });

      expect(calls).toContain("regenerate");
      expect(calls[0]).toBe("regenerate");
      expect(calls.indexOf("regenerate")).toBeLessThan(calls.indexOf("set:mika.customerId"));
      expect(store["mika.customerId"]).toBe("customer_1");
    } finally {
      await harness.destroy();
    }
  });

  it("restores the magic-link token when the account view fails, leaving the session unwritten", async () => {
    const harness = await createMagicLinkHarness();

    try {
      await harness.accountCollection.put("customer_document_1", createCustomerDocument());
      await harness.api.magicLink.request(createTestRequestContext(), {
        email: "subscriber@example.test",
      });
      const tokenHash = createTestHash("magic-link-token:magic_link_token_1");

      const originalListOrders = harness.repositories.ledger.listOrdersByCustomer;
      harness.repositories.ledger.listOrdersByCustomer = async () => {
        throw new Error("ledger read outage");
      };
      const ctx = createTestRequestContext();
      await expect(
        harness.api.magicLink.verify(ctx, { token: "magic_link_token_1" }),
      ).rejects.toThrow("ledger read outage");

      expect(await ctx.session?.get("mika.customerId")).toBeUndefined();
      await expect(harness.repositories.ephemeral.get(tokenHash)).resolves.toMatchObject({
        status: "pending",
      });

      harness.repositories.ledger.listOrdersByCustomer = originalListOrders;
      const ctx2 = createTestRequestContext();
      await expect(
        harness.api.magicLink.verify(ctx2, { token: "magic_link_token_1" }),
      ).resolves.toMatchObject({ ok: true, data: { customer: { id: "customer_1" } } });
      expect(await ctx2.session?.get("mika.customerId")).toBe("customer_1");
    } finally {
      await harness.destroy();
    }
  });

  it("does not consume a magic-link token when no writable session is present", async () => {
    const harness = await createMagicLinkHarness();

    try {
      await harness.api.magicLink.request(createTestRequestContext(), {
        email: "guest@example.test",
      });
      const tokenHash = createTestHash("magic-link-token:magic_link_token_1");
      const ctx = createTestRequestContext({ sessionId: false, customerId: false, userId: false });

      await expect(
        harness.api.magicLink.verify(ctx, { token: "magic_link_token_1" }),
      ).resolves.toMatchObject({
        ok: false,
        status: 401,
        error: { code: "AUTH_REQUIRED" },
      });
      await expect(harness.repositories.ephemeral.get(tokenHash)).resolves.toMatchObject({
        status: "pending",
      });
    } finally {
      await harness.destroy();
    }
  });

  it("clears stale customer session keys when verifying a guest magic link", async () => {
    const harness = await createMagicLinkHarness();

    try {
      await harness.api.magicLink.request(createTestRequestContext(), {
        email: "guest@example.test",
      });
      const emailHash = createTestHash("email:guest@example.test");
      const ctx = createTestRequestContext({ customerId: false, userId: false });
      await ctx.session?.set("mika.customerId", createTestMikaId("customer", 99));
      await ctx.session?.set("mika.userId", "user_99");

      await expect(
        harness.api.magicLink.verify(ctx, { token: "magic_link_token_1" }),
      ).resolves.toMatchObject({
        ok: true,
        status: 200,
        data: { customer: { email: "guest@example.test" } },
      });

      await expect(ctx.session?.get("mika.customerId")).resolves.toBeUndefined();
      await expect(ctx.session?.get("mika.userId")).resolves.toBeUndefined();
      await expect(ctx.session?.get("mika.emailHash")).resolves.toBe(emailHash);
    } finally {
      await harness.destroy();
    }
  });

  it("returns account overview sections for an authenticated customer", async () => {
    const accountCollection = createStorageCollection("account");
    const ledgerCollection = createStorageCollection("ledger");
    const repositories = {
      ...createTestBackendRepositories(),
      account: new AccountRepository(accountCollection),
      ledger: new LedgerRepository(ledgerCollection),
    } satisfies MikaBackendRepositories;
    const customer = createCustomerDocument();

    await repositories.account.put(customer);
    await repositories.account.put(createProviderAccountDocument());
    await repositories.account.put(createSubscriptionDocument());
    await repositories.account.put(createEntitlementDocument());
    await repositories.account.put(createLicenseDocument());
    await repositories.ledger.put(createOrderDocument());

    const api = createMikaBackendApi(createTestBackendDependencies({ repositories }));

    const account = await api.account.get(
      createTestRequestContext({ customerId: customer.customerId }),
    );

    expect(account).toMatchObject({
      ok: true,
      status: 200,
      data: {
        customer: {
          id: "customer_1",
          userId: "user_1",
          email: "Subscriber@Example.test",
          name: "Subscriber One",
        },
        orders: [
          {
            id: "order_1",
            orderNumber: "M-1001",
            status: "paid",
            paymentStatus: "paid",
            total: { amount: 1200, currency: TEST_CURRENCY },
            invoiceHref:
              "https://shop.example.test/_emdash/api/plugins/mika/orders/invoice?orderId=order_1&token=order_invoice_token_1",
          },
        ],
        subscriptions: [
          {
            id: "subscription_1",
            title: "Test subscription",
            status: "active",
            currentPeriodEnd: "2026-02-01T00:00:00.000Z",
            cancelAtPeriodEnd: false,
          },
        ],
        entitlements: [
          {
            key: "downloads.pro",
            status: "active",
            source: "order",
            expiresAt: "2026-02-01T00:00:00.000Z",
          },
        ],
        downloads: [
          {
            id: "download:order_1:order_line_1",
            title: "Test download",
            href: "/download/download_token_1",
            expiresAt: "2026-01-01T00:15:00.000Z",
          },
        ],
      },
    });
    if (!account.ok) throw new Error("Expected account.get to succeed.");
    expect(account.data.orders[0]).not.toHaveProperty("invoiceUrl");
  });

  it("includes guest-era emailHash orders and entitlements in a registered customer account view", async () => {
    const accountCollection = createStorageCollection("account");
    const ledgerCollection = createStorageCollection("ledger");
    const repositories = {
      ...createTestBackendRepositories(),
      account: new AccountRepository(accountCollection),
      ledger: new LedgerRepository(ledgerCollection),
    } satisfies MikaBackendRepositories;
    const emailHash = createTestHash("email:subscriber@example.test");
    const customer = createCustomerDocument({ emailHash });
    const baseOrder = createOrderDocument();
    const guestOrder = createOrderDocument({
      customerId: undefined,
      emailHash,
      aggregate: {
        ...baseOrder.aggregate,
        customer: {
          ...baseOrder.aggregate.customer,
          customerId: undefined,
          emailHash,
        },
      },
    });
    const guestEntitlement = createEntitlementDocument({
      customerId: undefined,
      emailHash,
      record: {
        customerId: undefined,
        emailHash,
      },
    });
    const api = createMikaBackendApi(createTestBackendDependencies({ repositories }));

    await repositories.account.put(customer);
    await repositories.ledger.put(guestOrder);
    await repositories.account.put(guestEntitlement);

    await expect(
      api.account.get(createTestRequestContext({ customerId: customer.customerId })),
    ).resolves.toMatchObject({
      ok: true,
      data: {
        orders: [{ id: guestOrder.id }],
        entitlements: [{ key: guestEntitlement.entitlementKey }],
        downloads: [{ id: "download:order_1:order_line_1" }],
      },
    });
  });

  it("mints a resolvable capability token for each account download link", async () => {
    const accountCollection = createStorageCollection("account");
    const ledgerCollection = createStorageCollection("ledger");
    const repositories = {
      ...createTestBackendRepositories(),
      account: new AccountRepository(accountCollection),
      ledger: new LedgerRepository(ledgerCollection),
    } satisfies MikaBackendRepositories;
    const customer = createCustomerDocument();
    await repositories.account.put(customer);
    await repositories.ledger.put(createOrderDocument());
    const api = createMikaBackendApi(createTestBackendDependencies({ repositories }));

    const account = await api.account.get(
      createTestRequestContext({ customerId: customer.customerId }),
    );
    if (!account.ok) throw new Error("Expected account.get to succeed.");

    const download = account.data.downloads[0];
    if (!download) throw new Error("Expected an account download.");
    expect(download.href).toBe("/download/download_token_1");
    expect(download.expiresAt).toBe("2026-01-01T00:15:00.000Z");
    const token = download.href.split("/").pop();
    expect(token).toBe("download_token_1");
    await expect(
      repositories.ephemeral.get(createTestHash("download-token:download_token_1")),
    ).resolves.toMatchObject({ subjectHash: `customer:${customer.customerId}` });

    await expect(api.download.confirm({ token: token ?? "" })).resolves.toMatchObject({
      ok: true,
      status: 200,
      data: { redirectUrl: "download:order_1:order_line_1" },
    });
  });

  it("reuses a still-valid download token across repeated account.get views instead of re-minting", async () => {
    // account.get can be called far more often than a download link is actually clicked (every
    // page view/refresh) — repeated views within the token's TTL must not each persist a new
    // ephemeral token record.
    const accountCollection = createStorageCollection("account");
    const ledgerCollection = createStorageCollection("ledger");
    const repositories = {
      ...createTestBackendRepositories(),
      account: new AccountRepository(accountCollection),
      ledger: new LedgerRepository(ledgerCollection),
    } satisfies MikaBackendRepositories;
    const customer = createCustomerDocument();
    await repositories.account.put(customer);
    await repositories.ledger.put(createOrderDocument());
    const api = createMikaBackendApi(createIncrementingBackendDependencies({ repositories }));
    const ctx = createTestRequestContext({ customerId: customer.customerId });

    const first = await api.account.get(ctx);
    const second = await api.account.get(ctx);
    if (!first.ok || !second.ok) throw new Error("Expected account.get to succeed.");

    const firstDownload = first.data.downloads[0];
    const secondDownload = second.data.downloads[0];
    if (!firstDownload || !secondDownload) throw new Error("Expected an account download.");
    // With an incrementing id factory, a second real mint would produce download_token_2 — an
    // identical href across both views proves the second view reused the first's token.
    expect(secondDownload.href).toBe(firstDownload.href);
    expect(secondDownload.expiresAt).toBe(firstDownload.expiresAt);

    await expect(api.download.confirm({ token: "download_token_1" })).resolves.toMatchObject({
      ok: true,
      status: 200,
    });
  });

  it("mints guest account download tokens with an email subject hash", async () => {
    const accountCollection = createStorageCollection("account");
    const ledgerCollection = createStorageCollection("ledger");
    const repositories = {
      ...createTestBackendRepositories(),
      account: new AccountRepository(accountCollection),
      ledger: new LedgerRepository(ledgerCollection),
    } satisfies MikaBackendRepositories;
    const emailHash = createTestHash("email:guest-download@example.test");
    const baseOrder = createOrderDocument();
    const guestOrder = createOrderDocument({
      customerId: undefined,
      emailHash,
      aggregate: {
        ...baseOrder.aggregate,
        customer: {
          ...baseOrder.aggregate.customer,
          customerId: undefined,
          userId: undefined,
          email: "guest-download@example.test",
          emailHash,
        },
      },
    });
    await repositories.ledger.put(guestOrder);
    const api = createMikaBackendApi(createTestBackendDependencies({ repositories }));
    const ctx = createTestRequestContext({ customerId: false, userId: false });
    await ctx.session?.set("mika.emailHash", emailHash);

    const account = await api.account.get(ctx);
    if (!account.ok) throw new Error("Expected guest account.get to succeed.");
    expect(account.data.downloads[0]?.href).toBe("/download/download_token_1");
    await expect(
      repositories.ephemeral.get(createTestHash("download-token:download_token_1")),
    ).resolves.toMatchObject({ subjectHash: `email:${emailHash}` });
  });

  it("does not return account data for conflicting customer and user identity", async () => {
    const accountCollection = createStorageCollection("account");
    const repositories = {
      ...createTestBackendRepositories(),
      account: new AccountRepository(accountCollection),
    } satisfies MikaBackendRepositories;
    const api = createMikaBackendApi(createTestBackendDependencies({ repositories }));

    await repositories.account.put(createCustomerDocument());
    await repositories.account.put(
      createCustomerDocument({
        id: createTestMikaId("customer_document", 2),
        customerId: createTestMikaId("customer", 2),
        userId: "user_2",
        emailHash: createTestHash("email:other@example.test"),
        aggregate: {
          schemaVersion: 1,
          email: "other@example.test",
          emailHash: createTestHash("email:other@example.test"),
          name: "Other Customer",
        },
      }),
    );

    await expect(
      api.account.get(
        createTestRequestContext({
          customerId: createTestMikaId("customer", 1),
          userId: "user_2",
        }),
      ),
    ).resolves.toMatchObject({
      ok: false,
      status: 401,
      error: { code: "AUTH_REQUIRED" },
    });
  });

  it("resolves account identity through customer, user-only, and session email hash paths", async () => {
    const customerRepositories = {
      ...createTestBackendRepositories(),
      account: new AccountRepository(createStorageCollection("account")),
    } satisfies MikaBackendRepositories;
    await customerRepositories.account.put(createCustomerDocument());
    await customerRepositories.account.put(createEntitlementDocument());

    const customerApi = createMikaBackendApi(
      createTestBackendDependencies({ repositories: customerRepositories }),
    );
    await expect(customerApi.account.get(createTestRequestContext())).resolves.toMatchObject({
      ok: true,
      status: 200,
      data: {
        customer: { id: "customer_1", userId: "user_1" },
        entitlements: [{ key: "downloads.pro", status: "active" }],
      },
    });

    const userOnlyRepositories = {
      ...createTestBackendRepositories(),
      account: new AccountRepository(createStorageCollection("account")),
    } satisfies MikaBackendRepositories;
    const userOnlyEntitlement = createEntitlementDocument({
      id: createTestMikaId("entitlement", 2),
    });
    await userOnlyRepositories.account.put({
      ...userOnlyEntitlement,
      customerId: undefined,
      userId: "user_only",
      emailHash: undefined,
      entitlementKey: "downloads.user",
      record: {
        ...userOnlyEntitlement.record,
        customerId: undefined,
        userId: "user_only",
        emailHash: undefined,
        entitlementKey: "downloads.user",
      },
    });

    const userOnlyApi = createMikaBackendApi(
      createTestBackendDependencies({ repositories: userOnlyRepositories }),
    );
    const userOnlyResult = await userOnlyApi.account.get(
      createTestRequestContext({ customerId: false, userId: "user_only" }),
    );
    expect(userOnlyResult).toMatchObject({
      ok: true,
      status: 200,
      data: {
        entitlements: [{ key: "downloads.user", status: "active" }],
      },
    });
    if (!userOnlyResult.ok) throw new Error("Expected user-only account lookup to succeed.");
    expect("customer" in userOnlyResult.data).toBe(false);

    const emailHash = createTestHash("email:session@example.test");
    const emailHashRepositories = {
      ...createTestBackendRepositories(),
      account: new AccountRepository(createStorageCollection("account")),
    } satisfies MikaBackendRepositories;
    const emailHashEntitlement = createEntitlementDocument({
      id: createTestMikaId("entitlement", 3),
    });
    await emailHashRepositories.account.put({
      ...emailHashEntitlement,
      customerId: undefined,
      userId: undefined,
      emailHash,
      entitlementKey: "downloads.email",
      record: {
        ...emailHashEntitlement.record,
        customerId: undefined,
        userId: undefined,
        emailHash,
        entitlementKey: "downloads.email",
      },
    });

    const emailHashApi = createMikaBackendApi(
      createTestBackendDependencies({ repositories: emailHashRepositories }),
    );
    const emailHashContext = createTestRequestContext({ customerId: false, userId: false });
    void emailHashContext.session?.set("mika.emailHash", emailHash);
    const emailHashResult = await emailHashApi.account.get(emailHashContext);
    expect(emailHashResult).toMatchObject({
      ok: true,
      status: 200,
      data: {
        entitlements: [{ key: "downloads.email", status: "active" }],
      },
    });
    if (!emailHashResult.ok) throw new Error("Expected email-hash account lookup to succeed.");
    expect("customer" in emailHashResult.data).toBe(false);
  });

  it("lists guest orders for an emailHash-only magic-link identity", async () => {
    const emailHash = createTestHash("email:guest@example.test");
    const repositories = createTestBackendRepositories();

    const baseOrder = createOrderDocument();
    const guestOrder = createOrderDocument({
      orderNumber: "M-2001",
      customerId: undefined,
      emailHash,
      aggregate: {
        ...baseOrder.aggregate,
        customer: {
          ...baseOrder.aggregate.customer,
          customerId: undefined,
          userId: undefined,
          email: "guest@example.test",
          emailHash,
        },
      },
    });
    await repositories.ledger.put(guestOrder);

    const baseEntitlement = createEntitlementDocument({ id: createTestMikaId("entitlement", 1) });
    await repositories.account.put({
      ...baseEntitlement,
      customerId: undefined,
      userId: undefined,
      emailHash,
      entitlementKey: "downloads.guest",
      record: {
        ...baseEntitlement.record,
        customerId: undefined,
        userId: undefined,
        emailHash,
        entitlementKey: "downloads.guest",
      },
    });

    const api = createMikaBackendApi(createTestBackendDependencies({ repositories }));
    const ctx = createTestRequestContext({ customerId: false, userId: false });
    await ctx.session?.set("mika.emailHash", emailHash);

    const account = await api.account.get(ctx);
    expect(account).toMatchObject({
      ok: true,
      status: 200,
      data: {
        orders: [{ id: guestOrder.id, orderNumber: "M-2001", status: "paid" }],
        entitlements: [{ key: "downloads.guest" }],
      },
    });
    if (!account.ok) throw new Error("Expected guest account lookup to succeed.");
    expect(account.data.orders).toHaveLength(1);
  });

  it("lists guest orders for an emailHash-only magic-link identity without entitlements", async () => {
    const emailHash = createTestHash("email:guest-orders-only@example.test");
    const repositories = createTestBackendRepositories();

    const baseOrder = createOrderDocument();
    const guestOrder = createOrderDocument({
      orderNumber: "M-2002",
      customerId: undefined,
      emailHash,
      aggregate: {
        ...baseOrder.aggregate,
        customer: {
          ...baseOrder.aggregate.customer,
          customerId: undefined,
          userId: undefined,
          email: "guest-orders-only@example.test",
          emailHash,
        },
      },
    });
    await repositories.ledger.put(guestOrder);

    const api = createMikaBackendApi(createTestBackendDependencies({ repositories }));
    const ctx = createTestRequestContext({ customerId: false, userId: false });
    await ctx.session?.set("mika.emailHash", emailHash);

    const account = await api.account.get(ctx);
    expect(account).toMatchObject({
      ok: true,
      status: 200,
      data: {
        orders: [{ id: guestOrder.id, orderNumber: "M-2002", status: "paid" }],
        entitlements: [],
      },
    });
    if (!account.ok) throw new Error("Expected guest order-only account lookup to succeed.");
    expect(account.data.orders).toHaveLength(1);
  });

  it("requires identity for account overview", async () => {
    const api = createMikaBackendApi(createTestBackendDependencies());

    await expect(
      api.account.get(createTestRequestContext({ customerId: false, userId: false })),
    ).resolves.toMatchObject({
      ok: false,
      status: 401,
      error: { code: "AUTH_REQUIRED" },
    });
  });

  it("requests the complete order history for an account export, not the default page", async () => {
    const harness = await createAccountServicesHarness();

    try {
      await harness.repositories.account.put(createCustomerDocument());
      await harness.repositories.ledger.put(createOrderDocument());

      const exportLimits: { orders?: number; subscriptions?: number } = {};
      const baseListOrders = harness.repositories.ledger.listOrdersByCustomer.bind(
        harness.repositories.ledger,
      );
      harness.repositories.ledger.listOrdersByCustomer = async (customerId, limit) => {
        exportLimits.orders = limit;
        return baseListOrders(customerId, limit);
      };
      const baseListSubscriptions = harness.repositories.account.listSubscriptionsByCustomer.bind(
        harness.repositories.account,
      );
      harness.repositories.account.listSubscriptionsByCustomer = async (customerId, limit) => {
        exportLimits.subscriptions = limit;
        return baseListSubscriptions(customerId, limit);
      };

      await expect(
        harness.api.account.export(
          createTestRequestContext({ customerId: createTestMikaId("customer", 1) }),
          {},
        ),
      ).resolves.toMatchObject({ ok: true, data: { status: "ready" } });

      expect(exportLimits).toEqual({
        orders: Number.MAX_SAFE_INTEGER,
        subscriptions: Number.MAX_SAFE_INTEGER,
      });
    } finally {
      await harness.destroy();
    }
  });

  it("creates, reports, and downloads an account export with a one-time token", async () => {
    const notificationIntents: MikaNotificationIntent[] = [];
    const harness = await createAccountServicesHarness({
      exportTtlMs: 60_000,
      notificationHook: (intent) => {
        notificationIntents.push(intent);
      },
    });

    try {
      await harness.repositories.account.put(createCustomerDocument());
      await harness.repositories.ledger.put(createOrderDocument());

      await expect(
        harness.api.account.export(
          createTestRequestContext({ customerId: createTestMikaId("customer", 1) }),
          {},
        ),
      ).resolves.toMatchObject({
        ok: true,
        status: 202,
        data: {
          id: "account_export_1",
          status: "ready",
          requestedAt: TEST_NOW,
          expiresAt: "2026-01-01T00:01:00.000Z",
          downloadHref:
            "https://shop.example.test/_emdash/api/plugins/mika/account/export/download?exportId=account_export_1&token=account_export_token_1",
        },
      });
      await expect(
        harness.repositories.ops.findAccountExport(createTestMikaId("account_export", 1)),
      ).resolves.toMatchObject({
        type: "accountExport",
        status: "ready",
        record: {
          customerId: "customer_1",
          downloadTokenHash: createTestHash("account-export-download-token:account_export_token_1"),
          artifactRef: expect.stringContaining("data:application/json"),
        },
      });
      expect(notificationIntents).toContainEqual(
        expect.objectContaining({
          kind: "account.export_ready",
          occurredAt: TEST_NOW,
          context: expect.objectContaining({
            exportId: "account_export_1",
            customerId: "customer_1",
            userId: "user_1",
            emailHash: createTestHash("email:subscriber@example.test"),
            expiresAt: "2026-01-01T00:01:00.000Z",
            downloadHref:
              "https://shop.example.test/_emdash/api/plugins/mika/account/export/download?exportId=account_export_1&token=account_export_token_1",
            tokenId: "account_export_token_1",
          }),
        }),
      );
      const exportIntent = notificationIntents.find(
        (intent) => intent.kind === "account.export_ready",
      );
      expect(exportIntent?.context).not.toHaveProperty("artifactRef");

      await expect(
        harness.api.account.exportStatus(createTestRequestContext(), {
          exportId: createTestMikaId("account_export", 1),
        }),
      ).resolves.toMatchObject({
        ok: true,
        status: 200,
        data: {
          id: "account_export_1",
          status: "ready",
          downloadHref:
            "https://shop.example.test/_emdash/api/plugins/mika/account/export/download?exportId=account_export_1",
        },
      });

      await expect(
        harness.api.account.exportDownload(
          createTestRequestContext({ customerId: false, userId: false }),
          {
            exportId: createTestMikaId("account_export", 1),
            token: createTestMikaId("account_export_token", 1),
          },
        ),
      ).resolves.toMatchObject({
        ok: true,
        status: 200,
        data: {
          id: "account_export_1",
          expiresAt: "2026-01-01T00:01:00.000Z",
          requiresConfirmation: true,
          confirmMethod: "POST",
        },
      });
      await expect(
        harness.repositories.ephemeral.get(
          createTestHash("account-export-download-token:account_export_token_1"),
        ),
      ).resolves.toMatchObject({ status: "pending" });

      await expect(
        harness.api.account.exportDownload(
          createTestRequestContext({ customerId: false, userId: false }),
          {
            exportId: createTestMikaId("account_export", 1),
            token: createTestMikaId("account_export_token", 1),
            consumeToken: true,
          },
        ),
      ).resolves.toMatchObject({
        ok: true,
        status: 200,
        data: {
          id: "account_export_1",
          href: expect.stringContaining(encodeURIComponent("Subscriber@Example.test")),
          expiresAt: "2026-01-01T00:01:00.000Z",
        },
      });
      await expect(
        harness.api.account.exportDownload(createTestRequestContext(), {
          exportId: createTestMikaId("account_export", 1),
          token: createTestMikaId("account_export_token", 1),
        }),
      ).resolves.toMatchObject({
        ok: false,
        status: 410,
        error: { code: "TOKEN_USED" },
      });
    } finally {
      await harness.destroy();
    }
  });

  it("forbids account export status and download access for unrelated identities", async () => {
    const harness = await createAccountServicesHarness({ exportTtlMs: 60_000 });
    const otherEmailHash = createTestHash("email:other@example.test");

    try {
      await harness.repositories.account.put(createCustomerDocument());
      await harness.repositories.account.put(
        createCustomerDocument({
          id: createTestMikaId("customer_document", 2),
          customerId: createTestMikaId("customer", 2),
          userId: "user_2",
          emailHash: otherEmailHash,
          aggregate: {
            schemaVersion: 1,
            email: "other@example.test",
            emailHash: otherEmailHash,
            name: "Other Customer",
          },
        }),
      );

      await expect(
        harness.api.account.export(
          createTestRequestContext({ customerId: createTestMikaId("customer", 1) }),
          {},
        ),
      ).resolves.toMatchObject({
        ok: true,
        status: 202,
        data: { id: "account_export_1" },
      });

      const unrelatedContext = createTestRequestContext({
        customerId: createTestMikaId("customer", 2),
        userId: "user_2",
      });
      await expect(
        harness.api.account.exportStatus(unrelatedContext, {
          exportId: createTestMikaId("account_export", 1),
        }),
      ).resolves.toMatchObject({
        ok: false,
        status: 403,
        error: { code: "FORBIDDEN" },
      });
      await expect(
        harness.api.account.exportDownload(unrelatedContext, {
          exportId: createTestMikaId("account_export", 1),
        }),
      ).resolves.toMatchObject({
        ok: false,
        status: 403,
        error: { code: "FORBIDDEN" },
      });
      await expect(
        harness.api.account.exportDownload(
          createTestRequestContext({ customerId: false, userId: false }),
          {
            exportId: createTestMikaId("account_export", 1),
            token: "wrong-token",
          },
        ),
      ).resolves.toMatchObject({
        ok: false,
        status: 400,
        error: { code: "TOKEN_INVALID" },
      });
    } finally {
      await harness.destroy();
    }
  });

  it("authorizes account export status for an emailHash-only magic-link identity", async () => {
    const emailHash = createTestHash("email:exporter@example.test");
    const repositories = createTestBackendRepositories();
    const baseEntitlement = createEntitlementDocument({ id: createTestMikaId("entitlement", 1) });
    await repositories.account.put({
      ...baseEntitlement,
      customerId: undefined,
      userId: undefined,
      emailHash,
      entitlementKey: "downloads.email",
      record: {
        ...baseEntitlement.record,
        customerId: undefined,
        userId: undefined,
        emailHash,
        entitlementKey: "downloads.email",
      },
    });

    const api = createMikaBackendApi(createTestBackendDependencies({ repositories }));
    const ctx = createTestRequestContext({ customerId: false, userId: false });
    await ctx.session?.set("mika.emailHash", emailHash);

    const created = await api.account.export(ctx, {});
    if (!created.ok) throw new Error("Expected emailHash account export to be created.");

    await expect(
      api.account.exportStatus(ctx, { exportId: created.data.id }),
    ).resolves.toMatchObject({
      ok: true,
      status: 200,
      data: { id: created.data.id, status: "ready" },
    });
  });

  it("returns stable account export download token errors", async () => {
    const expiredHarness = await createAccountServicesHarness({ exportTtlMs: 1 });

    try {
      await expiredHarness.repositories.account.put(createCustomerDocument());
      await expiredHarness.api.account.export(createTestRequestContext(), {});

      await expect(
        expiredHarness.api.account.exportDownload(createTestRequestContext(), {
          exportId: createTestMikaId("account_export", 1),
          token: "wrong-token",
        }),
      ).resolves.toMatchObject({
        ok: false,
        status: 400,
        error: { code: "TOKEN_INVALID" },
      });
      await expect(
        expiredHarness.api.account.exportDownload(
          createTestRequestContext({ now: createTestClock().at(2) }),
          {
            exportId: createTestMikaId("account_export", 1),
            token: createTestMikaId("account_export_token", 1),
          },
        ),
      ).resolves.toMatchObject({
        ok: false,
        status: 410,
        error: { code: "TOKEN_EXPIRED" },
      });
    } finally {
      await expiredHarness.destroy();
    }

    const revokedHarness = await createAccountServicesHarness({ exportTtlMs: 60_000 });

    try {
      await revokedHarness.repositories.account.put(createCustomerDocument());
      await revokedHarness.api.account.export(createTestRequestContext(), {});
      const tokenHash = createTestHash("account-export-download-token:account_export_token_1");
      const tokenRecord = await revokedHarness.repositories.ephemeral.get(tokenHash);
      if (!tokenRecord) throw new Error("Expected account export token to be stored.");
      await revokedHarness.repositories.ephemeral.put({
        ...tokenRecord,
        status: "revoked",
        updatedAt: TEST_NOW,
      });

      await expect(
        revokedHarness.api.account.exportDownload(createTestRequestContext(), {
          exportId: createTestMikaId("account_export", 1),
          token: createTestMikaId("account_export_token", 1),
        }),
      ).resolves.toMatchObject({
        ok: false,
        status: 410,
        error: { code: "DOWNLOAD_REVOKED" },
      });
    } finally {
      await revokedHarness.destroy();
    }
  });

  it("resolves a valid download token repeatedly without leaking account data", async () => {
    const harness = await createAccountServicesHarness();

    try {
      await harness.repositories.ledger.put(createOrderDocument());
      await harness.repositories.account.put(createEntitlementDocument());
      await harness.repositories.account.put(createLicenseDocument());
      await issueDownloadToken(harness.repositories, {
        token: "download_token_1",
        expiresAt: createTestClock().isoAt(60_000),
        data: {
          downloadRef: "download:order_1:order_line_1",
          orderId: createTestMikaId("order", 1),
          orderLineId: createTestMikaId("order_line", 1),
          entitlementId: createTestMikaId("entitlement", 1),
          licenseId: createTestMikaId("license", 1),
          redirectUrl: "https://files.example.test/downloads/order_1/order_line_1",
          title: "Private download",
        },
      });

      const result = await harness.api.download.resolve({ token: "download_token_1" });
      const replay = await harness.api.download.resolve({ token: "download_token_1" });

      expect(result).toMatchObject({
        ok: true,
        status: 200,
        data: {
          title: "Private download",
          redirectUrl: "https://files.example.test/downloads/order_1/order_line_1",
          expiresAt: "2026-01-01T00:01:00.000Z",
        },
      });
      expect(replay).toMatchObject({
        ok: true,
        status: 200,
        data: {
          redirectUrl: "https://files.example.test/downloads/order_1/order_line_1",
        },
      });
      expect(JSON.stringify(result)).not.toContain("customer_1");
      expect(JSON.stringify(result)).not.toContain("Subscriber@Example.test");
      await expect(
        harness.repositories.ephemeral.get(createTestHash("download-token:download_token_1")),
      ).resolves.toMatchObject({ status: "pending" });
    } finally {
      await harness.destroy();
    }
  });

  it("resolves a download by the token's order id instead of scanning the ledger", async () => {
    const harness = await createAccountServicesHarness();

    try {
      await harness.repositories.ledger.put(createOrderDocument());
      await harness.repositories.account.put(createEntitlementDocument());
      await harness.repositories.account.put(createLicenseDocument());
      await issueDownloadToken(harness.repositories, {
        token: "download_token_indexed",
        expiresAt: createTestClock().isoAt(60_000),
        data: {
          downloadRef: "download:order_1:order_line_1",
          orderId: createTestMikaId("order", 1),
          orderLineId: createTestMikaId("order_line", 1),
          entitlementId: createTestMikaId("entitlement", 1),
          licenseId: createTestMikaId("license", 1),
          redirectUrl: "https://files.example.test/downloads/order_1/order_line_1",
          title: "Private download",
        },
      });

      const scanGuardedLedger = new Proxy(harness.repositories.ledger, {
        get(target, property, receiver) {
          if (property === "findOrderByDownloadRef") {
            return async () => {
              throw new Error(
                "findOrderByDownloadRef should not be called when the token already carries an order id.",
              );
            };
          }
          const value = Reflect.get(target, property, receiver);

          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      const api = createMikaBackendApi(
        createIncrementingBackendDependencies({
          repositories: { ...harness.repositories, ledger: scanGuardedLedger },
        }),
      );

      await expect(
        api.download.resolve({ token: "download_token_indexed" }),
      ).resolves.toMatchObject({
        ok: true,
        status: 200,
        data: { redirectUrl: "https://files.example.test/downloads/order_1/order_line_1" },
      });
    } finally {
      await harness.destroy();
    }
  });

  it("confirms a download token exactly once after resolve", async () => {
    const harness = await createAccountServicesHarness();

    try {
      await harness.repositories.ledger.put(createOrderDocument());
      await harness.repositories.account.put(createEntitlementDocument());
      await harness.repositories.account.put(createLicenseDocument());
      await issueDownloadToken(harness.repositories, {
        token: "download_confirm_token_1",
        expiresAt: createTestClock().isoAt(60_000),
        data: {
          downloadRef: "download:order_1:order_line_1",
          orderId: createTestMikaId("order", 1),
          orderLineId: createTestMikaId("order_line", 1),
          entitlementId: createTestMikaId("entitlement", 1),
          licenseId: createTestMikaId("license", 1),
          redirectUrl: "https://files.example.test/downloads/order_1/order_line_1",
        },
      });

      await expect(
        harness.api.download.resolve({ token: "download_confirm_token_1" }),
      ).resolves.toMatchObject({ ok: true, status: 200 });
      await expect(
        harness.api.download.confirm({ token: "download_confirm_token_1" }),
      ).resolves.toMatchObject({
        ok: true,
        status: 200,
        data: { redirectUrl: "https://files.example.test/downloads/order_1/order_line_1" },
      });
      await expect(
        harness.api.download.confirm({ token: "download_confirm_token_1" }),
      ).resolves.toMatchObject({
        ok: false,
        status: 410,
        error: { code: "TOKEN_USED" },
      });
      await expect(
        harness.repositories.ephemeral.get(
          createTestHash("download-token:download_confirm_token_1"),
        ),
      ).resolves.toMatchObject({ status: "consumed" });
    } finally {
      await harness.destroy();
    }
  });

  it("treats a non-canonical (offset) download-token expiry as expired by canonicalizing it", async () => {
    const harness = await createAccountServicesHarness();

    try {
      await harness.repositories.ledger.put(createOrderDocument());
      await issueDownloadToken(harness.repositories, {
        token: "noncanonical_expired_download_token",
        expiresAt: "2026-01-01T13:00:00+14:00",
        data: { downloadRef: "download:order_1:order_line_1" },
      });

      await expect(
        harness.api.download.resolve({ token: "noncanonical_expired_download_token" }),
      ).resolves.toMatchObject({
        ok: false,
        status: 410,
        error: { code: "TOKEN_EXPIRED" },
      });
    } finally {
      await harness.destroy();
    }
  });

  it("returns stable download token errors for invalid, expired, used, and revoked tokens", async () => {
    const harness = await createAccountServicesHarness();

    try {
      await harness.repositories.ledger.put(createOrderDocument());

      await expect(harness.api.download.resolve({ token: "missing" })).resolves.toMatchObject({
        ok: false,
        status: 400,
        error: { code: "TOKEN_INVALID" },
      });

      await issueDownloadToken(harness.repositories, {
        token: "expired_download_token",
        expiresAt: TEST_NOW,
        data: { downloadRef: "download:order_1:order_line_1" },
      });
      await expect(
        harness.api.download.resolve({
          token: "expired_download_token",
        }),
      ).resolves.toMatchObject({
        ok: false,
        status: 410,
        error: { code: "TOKEN_EXPIRED" },
      });

      await issueDownloadToken(harness.repositories, {
        token: "used_download_token",
        status: "consumed",
        expiresAt: createTestClock().isoAt(60_000),
        data: { downloadRef: "download:order_1:order_line_1" },
      });
      await expect(
        harness.api.download.resolve({ token: "used_download_token" }),
      ).resolves.toMatchObject({
        ok: false,
        status: 410,
        error: { code: "TOKEN_USED" },
      });

      await issueDownloadToken(harness.repositories, {
        token: "revoked_download_token",
        status: "revoked",
        expiresAt: createTestClock().isoAt(60_000),
        data: { downloadRef: "download:order_1:order_line_1" },
      });
      await expect(
        harness.api.download.resolve({ token: "revoked_download_token" }),
      ).resolves.toMatchObject({
        ok: false,
        status: 410,
        error: { code: "DOWNLOAD_REVOKED" },
      });
    } finally {
      await harness.destroy();
    }
  });

  it("rejects download tokens when entitlement, license, or download record state is unavailable", async () => {
    const harness = await createAccountServicesHarness();

    try {
      const revokedEntitlement = createEntitlementDocument();
      const activeEntitlement = createEntitlementDocument();
      const revokedLicense = createLicenseDocument();

      await harness.repositories.ledger.put(createOrderDocument());
      await harness.repositories.account.put({
        ...revokedEntitlement,
        status: "revoked",
        record: { ...revokedEntitlement.record, status: "revoked", revokedAt: TEST_NOW },
      });
      await harness.repositories.account.put(createLicenseDocument());
      await issueDownloadToken(harness.repositories, {
        token: "revoked_entitlement_download_token",
        expiresAt: createTestClock().isoAt(60_000),
        data: {
          downloadRef: "download:order_1:order_line_1",
          entitlementId: createTestMikaId("entitlement", 1),
        },
      });

      await expect(
        harness.api.download.resolve({ token: "revoked_entitlement_download_token" }),
      ).resolves.toMatchObject({
        ok: false,
        status: 410,
        error: { code: "DOWNLOAD_REVOKED" },
      });

      await harness.repositories.account.put({
        ...activeEntitlement,
        status: "active",
        record: { ...activeEntitlement.record, status: "active" },
      });
      await harness.repositories.account.put({
        ...revokedLicense,
        status: "revoked",
        record: { ...revokedLicense.record, status: "revoked", revokedAt: TEST_NOW },
      });
      await issueDownloadToken(harness.repositories, {
        token: "revoked_license_download_token",
        expiresAt: createTestClock().isoAt(60_000),
        data: {
          downloadRef: "download:order_1:order_line_1",
          licenseId: createTestMikaId("license", 1),
        },
      });

      await expect(
        harness.api.download.resolve({ token: "revoked_license_download_token" }),
      ).resolves.toMatchObject({
        ok: false,
        status: 410,
        error: { code: "DOWNLOAD_REVOKED" },
      });

      await issueDownloadToken(harness.repositories, {
        token: "missing_download_record_token",
        expiresAt: createTestClock().isoAt(60_000),
        data: { downloadRef: "download:order_1:other_line" },
      });

      await expect(
        harness.api.download.resolve({ token: "missing_download_record_token" }),
      ).resolves.toMatchObject({
        ok: false,
        status: 400,
        error: { code: "TOKEN_INVALID" },
      });
    } finally {
      await harness.destroy();
    }
  });

  it("consumes a single-use download token via download.confirm exactly like download.resolve", async () => {
    const harness = await createAccountServicesHarness();

    try {
      await harness.repositories.ledger.put(createOrderDocument());
      await harness.repositories.account.put(createEntitlementDocument());
      await harness.repositories.account.put(createLicenseDocument());
      await issueDownloadToken(harness.repositories, {
        token: "download_token_1",
        expiresAt: createTestClock().isoAt(60_000),
        data: {
          downloadRef: "download:order_1:order_line_1",
          orderId: createTestMikaId("order", 1),
          orderLineId: createTestMikaId("order_line", 1),
          entitlementId: createTestMikaId("entitlement", 1),
          licenseId: createTestMikaId("license", 1),
          redirectUrl: "https://files.example.test/downloads/order_1/order_line_1",
          title: "Private download",
        },
      });

      const confirmed = await harness.api.download.confirm({ token: "download_token_1" });
      expect(confirmed).toMatchObject({
        ok: true,
        status: 200,
        data: {
          title: "Private download",
          redirectUrl: "https://files.example.test/downloads/order_1/order_line_1",
          expiresAt: "2026-01-01T00:01:00.000Z",
        },
      });
      await expect(
        harness.repositories.ephemeral.get(createTestHash("download-token:download_token_1")),
      ).resolves.toMatchObject({ status: "consumed" });

      await expect(
        harness.api.download.confirm({ token: "download_token_1" }),
      ).resolves.toMatchObject({
        ok: false,
        status: 410,
        error: { code: "TOKEN_USED" },
      });
      await expect(
        harness.api.download.resolve({ token: "download_token_1" }),
      ).resolves.toMatchObject({
        ok: false,
        status: 410,
        error: { code: "TOKEN_USED" },
      });
    } finally {
      await harness.destroy();
    }
  });

  it("stores account delete requests and returns requested status", async () => {
    const notificationIntents: MikaNotificationIntent[] = [];
    const harness = await createAccountServicesHarness({
      notificationHook: (intent) => {
        notificationIntents.push(intent);
      },
    });

    try {
      await harness.repositories.account.put(createCustomerDocument());

      await expect(harness.api.account.delete(createTestRequestContext(), {})).resolves.toEqual({
        ok: true,
        status: 202,
        data: { requested: true },
      });
      await expect(
        harness.repositories.ops.findAccountDeleteRequest(
          createTestMikaId("account_delete_request", 1),
        ),
      ).resolves.toMatchObject({
        type: "accountDeleteRequest",
        status: "queued",
        customerId: "customer_1",
        userId: "user_1",
        record: {
          status: "queued",
          requestedAt: TEST_NOW,
        },
      });
      expect(notificationIntents).toEqual([
        expect.objectContaining({
          kind: "account.delete_requested",
          occurredAt: TEST_NOW,
          context: {
            requestId: "account_delete_request_1",
            customerId: "customer_1",
            userId: "user_1",
            emailHash: createTestHash("email:subscriber@example.test"),
          },
        }),
      ]);
    } finally {
      await harness.destroy();
    }
  });

  it("blocks account delete while the customer has an active subscription", async () => {
    const harness = await createAccountServicesHarness();

    try {
      await harness.repositories.account.put(createCustomerDocument());
      await harness.repositories.account.put(createSubscriptionDocument({ status: "active" }));

      await expect(
        harness.api.account.delete(createTestRequestContext(), {}),
      ).resolves.toMatchObject({
        ok: false,
        status: 409,
        error: {
          code: "CONFLICT",
          fieldErrors: {
            subscriptionId: "Active subscriptions must be cancelled before account deletion.",
          },
        },
      });
      await expect(
        harness.repositories.ops.listAccountDeleteRequestsByCustomer(
          createTestMikaId("customer", 1),
        ),
      ).resolves.toMatchObject({ items: [] });
    } finally {
      await harness.destroy();
    }
  });

  it("blocks account delete while a checkout is in progress", async () => {
    const harness = await createAccountServicesHarness();

    try {
      await harness.repositories.account.put(createCustomerDocument());
      await harness.repositories.session.put(
        createCartDocument({
          status: "checkout_pending",
          aggregate: {
            schemaVersion: 1,
            currency: TEST_CURRENCY,
            items: [],
            metadata: { checkoutSessionId: createTestMikaId("checkout", 1) },
          },
        }),
      );

      await expect(
        harness.api.account.delete(createTestRequestContext(), {}),
      ).resolves.toMatchObject({
        ok: false,
        status: 409,
        error: {
          code: "CONFLICT",
          fieldErrors: {
            cartId: "Complete or cancel the active checkout before account deletion.",
          },
        },
      });
      await expect(
        harness.repositories.ops.listAccountDeleteRequestsByCustomer(
          createTestMikaId("customer", 1),
        ),
      ).resolves.toMatchObject({ items: [] });
    } finally {
      await harness.destroy();
    }
  });

  it("completes queued account delete requests with safe local cleanup", async () => {
    const database = createTransactionTestMikaDb();
    const { db } = database;
    const accountCollection = createStorageCollection("account");
    const ledgerCollection = createStorageCollection("ledger");
    const opsCollection = createStorageCollection("ops");
    const repositories = {
      ...createTestBackendRepositories(),
      account: new AccountRepository(accountCollection),
      ledger: new LedgerRepository(ledgerCollection),
      ops: new OpsRepository(opsCollection),
      stock: new StockRepository(db),
      ephemeral: new EphemeralRepository(db),
    } satisfies MikaBackendRepositories;
    const dependencies = createIncrementingBackendDependencies({ repositories });
    const api = createMikaBackendApi(dependencies);
    const service = createMikaStockLifecycleService(dependencies);
    const clock = createTestClock();
    const customer = createCustomerDocument();
    const order = createOrderDocument();
    const license = createLicenseDocument({ customerId: customer.customerId });
    const stockItem = createStockRecord({ quantityOnHand: 4, quantityReserved: 0 });
    const email = createEmailDocument({
      id: createTestMikaId("email", 1),
      record: {
        id: createTestMikaId("email", 1),
        kind: "magic_link",
        templateKey: "magic_link",
        customerId: customer.customerId,
        toEmail: "Subscriber@Example.test",
        metadata: { link: "https://shop.example.test/account/delete/confirm?token=secret" },
      },
    });

    try {
      await mikaInitialMigration.up(db);
      await repositories.account.put(customer);
      await repositories.account.put(license);
      await repositories.ledger.put(order);
      await repositories.stock.putItem(stockItem);
      await service.reserve({
        stockItemId: stockItem.id,
        quantity: 2,
        customerId: customer.customerId,
        expiresAt: clock.isoAt(15 * 60_000),
      });
      await repositories.ephemeral.put({
        key: "customer_download_token",
        kind: "token",
        subjectHash: customer.customerId,
        status: "pending",
        count: 0,
        expiresAt: clock.isoAt(15 * 60_000),
        version: 1,
        createdAt: TEST_NOW,
        updatedAt: TEST_NOW,
      });
      await repositories.ephemeral.put({
        key: "customer_export_token",
        kind: "token",
        subjectHash: formatSubjectRef({ kind: "customer", id: customer.customerId }),
        status: "pending",
        count: 0,
        expiresAt: clock.isoAt(15 * 60_000),
        version: 1,
        createdAt: TEST_NOW,
        updatedAt: TEST_NOW,
      });
      await repositories.ephemeral.put({
        key: "user_download_token",
        kind: "token",
        subjectHash: formatSubjectRef({ kind: "user", id: "user_1" }),
        status: "pending",
        count: 0,
        expiresAt: clock.isoAt(15 * 60_000),
        version: 1,
        createdAt: TEST_NOW,
        updatedAt: TEST_NOW,
      });
      await repositories.ephemeral.put({
        key: "email_download_token",
        kind: "token",
        subjectHash: formatSubjectRef({
          kind: "email",
          id: createTestHash("email:subscriber@example.test"),
        }),
        status: "pending",
        count: 0,
        expiresAt: clock.isoAt(15 * 60_000),
        version: 1,
        createdAt: TEST_NOW,
        updatedAt: TEST_NOW,
      });
      await repositories.ephemeral.put({
        key: "legacy_email_token",
        kind: "token",
        subjectHash: createTestHash("email:subscriber@example.test"),
        status: "pending",
        count: 0,
        expiresAt: clock.isoAt(15 * 60_000),
        version: 1,
        createdAt: TEST_NOW,
        updatedAt: TEST_NOW,
      });
      await repositories.ephemeral.put({
        key: "customer_rate_limit",
        kind: "rate_limit",
        subjectHash: customer.customerId,
        status: "active",
        count: 1,
        expiresAt: clock.isoAt(15 * 60_000),
        version: 1,
        createdAt: TEST_NOW,
        updatedAt: TEST_NOW,
      });
      await repositories.ops.put(email);

      await expect(api.account.delete(createTestRequestContext(), {})).resolves.toMatchObject({
        ok: true,
        status: 202,
      });

      const runner = createMikaMaintenanceRunner({ repositories });
      await expect(runner.runOnce({ now: clock.isoAt(60_000) })).resolves.toMatchObject({
        accountDeleteRequests: {
          status: "completed",
          result: {
            scanned: 1,
            completed: 1,
            failed: 0,
            items: [
              {
                requestId: "account_delete_request_1",
                status: "completed",
                tokensDeleted: 5,
                reservationsReleased: 1,
                emailsRedacted: 1,
                licensesAnonymized: 1,
              },
            ],
          },
        },
      });

      const request = await repositories.ops.findAccountDeleteRequest(
        createTestMikaId("account_delete_request", 1),
      );
      expect(request).toMatchObject({
        status: "completed",
        customerId: customer.customerId,
        record: {
          status: "completed",
          completedAt: clock.isoAt(60_000),
          metadata: {
            maintenance: {
              tokensDeleted: 5,
              reservationsReleased: 1,
              emailsRedacted: 1,
              licensesAnonymized: 1,
            },
          },
        },
      });
      expect(request?.userId).toBeUndefined();
      expect(request?.emailHash).toBeUndefined();
      expect(request?.record.confirmTokenHash).toBeUndefined();
      await expect(repositories.ephemeral.get("customer_download_token")).resolves.toBeNull();
      await expect(repositories.ephemeral.get("customer_export_token")).resolves.toBeNull();
      await expect(repositories.ephemeral.get("user_download_token")).resolves.toBeNull();
      await expect(repositories.ephemeral.get("email_download_token")).resolves.toBeNull();
      await expect(repositories.ephemeral.get("legacy_email_token")).resolves.toBeNull();
      await expect(repositories.ephemeral.get("customer_rate_limit")).resolves.toMatchObject({
        kind: "rate_limit",
      });
      await expect(
        repositories.stock.findBySellableId(stockItem.sellableId),
      ).resolves.toMatchObject({
        quantityOnHand: 4,
        quantityReserved: 0,
      });
      const retainedOrder = await repositories.ledger.findOrderById(order.id);
      expect(retainedOrder?.customerId).toBe(order.customerId);
      expect(retainedOrder?.totalAmount).toBe(order.totalAmount);
      expect(retainedOrder?.status).toBe(order.status);
      expect(retainedOrder?.aggregate.lines).toEqual(order.aggregate.lines);
      expect(retainedOrder?.aggregate.totals).toEqual(order.aggregate.totals);
      expect(retainedOrder?.emailHash).toBe(`account-deleted:${customer.customerId}`);
      expect(retainedOrder?.aggregate.customer.emailHash).toBe(
        `account-deleted:${customer.customerId}`,
      );
      expect(retainedOrder?.aggregate.customer.email).toBeUndefined();
      expect(retainedOrder?.aggregate.customer.name).toBeUndefined();
      await expect(repositories.account.findLicenseById(license.id)).resolves.toMatchObject({
        status: "revoked",
        customerId: undefined,
        record: {
          status: "revoked",
          licenseKeyHash: `account-deleted:${customer.customerId}:license-redacted`,
          displayKeySuffix: "redacted",
          revokedAt: clock.isoAt(60_000),
          metadata: { anonymizedAt: clock.isoAt(60_000) },
        },
      });
      expect(
        (await repositories.account.listLicensesByCustomer(customer.customerId)).items,
      ).toHaveLength(0);
      await expect(repositories.ops.findEmail(email.id)).resolves.toMatchObject({
        status: "skipped",
        nextAttemptAt: undefined,
        tokenId: undefined,
        orderId: undefined,
        record: {
          toEmail: "redacted-email_1@redacted.invalid",
          subject: "Redacted email",
          status: "skipped",
          lastError: "Redacted after account deletion.",
          metadata: { redactedAt: clock.isoAt(60_000) },
        },
      });
    } finally {
      await rollbackMikaInitialMigration(db);
      await database.destroy();
    }
  });

  it("formats and parses typed token subject references", () => {
    const subjects = [
      { kind: "customer" as const, id: createTestMikaId("customer", 1) },
      { kind: "user" as const, id: "user_1" },
      { kind: "email" as const, id: createTestHash("email:subscriber@example.test") },
      { kind: "session" as const, id: "session_1" },
    ];

    for (const subject of subjects) {
      expect(parseSubjectRef(formatSubjectRef(subject))).toEqual(subject);
    }

    expect(parseSubjectRef(createTestHash("email:subscriber@example.test"))).toBeNull();
    expect(parseSubjectRef("customer:")).toBeNull();
    expect(parseSubjectRef("unknown:value")).toBeNull();
    expect(
      subjectHashCandidates({
        customerId: createTestMikaId("customer", 1),
        userId: "user_1",
        emailHash: createTestHash("email:subscriber@example.test"),
      }),
    ).toEqual([
      createTestMikaId("customer", 1),
      formatSubjectRef({ kind: "customer", id: createTestMikaId("customer", 1) }),
      formatSubjectRef({ kind: "user", id: "user_1" }),
      createTestHash("email:subscriber@example.test"),
      formatSubjectRef({ kind: "email", id: createTestHash("email:subscriber@example.test") }),
    ]);
  });

  it("re-keys a userId-only entitlement on account delete (no customer doc, no emailHash)", async () => {
    const database = createTransactionTestMikaDb();
    const { db } = database;
    const accountCollection = createStorageCollection("account");
    const ledgerCollection = createStorageCollection("ledger");
    const opsCollection = createStorageCollection("ops");
    const repositories = {
      ...createTestBackendRepositories(),
      account: new AccountRepository(accountCollection),
      ledger: new LedgerRepository(ledgerCollection),
      ops: new OpsRepository(opsCollection),
      stock: new StockRepository(db),
      ephemeral: new EphemeralRepository(db),
    } satisfies MikaBackendRepositories;
    const api = createMikaBackendApi(createIncrementingBackendDependencies({ repositories }));
    const clock = createTestClock();
    const sentinel = "account-deleted-user:user_only";

    try {
      await mikaInitialMigration.up(db);
      const baseGrant = createEntitlementDocument();
      await repositories.account.put({
        ...baseGrant,
        customerId: undefined,
        emailHash: undefined,
        userId: "user_only",
        record: {
          ...baseGrant.record,
          customerId: undefined,
          emailHash: undefined,
          userId: "user_only",
        },
      });
      const userCtx = createTestRequestContext({ customerId: false, userId: "user_only" });

      expect((await repositories.account.listEntitlementsByUser("user_only")).items).toHaveLength(
        1,
      );
      await expect(api.account.delete(userCtx, {})).resolves.toMatchObject({
        ok: true,
        status: 202,
      });

      await expect(
        createMikaMaintenanceRunner({ repositories }).runOnce({ now: clock.isoAt(60_000) }),
      ).resolves.toMatchObject({
        accountDeleteRequests: {
          status: "completed",
          result: { items: [{ status: "completed", entitlementsAnonymized: 1 }] },
        },
      });

      expect((await repositories.account.listEntitlementsByUser("user_only")).items).toHaveLength(
        0,
      );
      expect((await repositories.account.listEntitlementsByUser(sentinel)).items).toHaveLength(1);
      await expect(
        api.account.get(createTestRequestContext({ customerId: false, userId: "user_only" })),
      ).resolves.toMatchObject({ ok: false, status: 401, error: { code: "AUTH_REQUIRED" } });
    } finally {
      await rollbackMikaInitialMigration(db);
      await database.destroy();
    }
  });

  it("anonymizes the customer identity record when completing an account delete request", async () => {
    const database = createTransactionTestMikaDb();
    const { db } = database;
    const accountCollection = createStorageCollection("account");
    const ledgerCollection = createStorageCollection("ledger");
    const opsCollection = createStorageCollection("ops");
    const repositories = {
      ...createTestBackendRepositories(),
      account: new AccountRepository(accountCollection),
      ledger: new LedgerRepository(ledgerCollection),
      ops: new OpsRepository(opsCollection),
      stock: new StockRepository(db),
      ephemeral: new EphemeralRepository(db),
    } satisfies MikaBackendRepositories;
    const dependencies = createIncrementingBackendDependencies({ repositories });
    const api = createMikaBackendApi(dependencies);
    const clock = createTestClock();
    const customer = createCustomerDocument();
    const originalEmailHash = createTestHash("email:subscriber@example.test");
    const sentinel = `account-deleted:${customer.customerId}`;

    try {
      await mikaInitialMigration.up(db);
      await repositories.account.put(customer);

      await expect(
        repositories.account.findCustomerByEmailHash(originalEmailHash),
      ).resolves.toMatchObject({
        customerId: customer.customerId,
        aggregate: { name: "Subscriber One" },
      });

      await expect(api.account.delete(createTestRequestContext(), {})).resolves.toMatchObject({
        ok: true,
        status: 202,
      });

      const runner = createMikaMaintenanceRunner({ repositories });
      await expect(runner.runOnce({ now: clock.isoAt(60_000) })).resolves.toMatchObject({
        accountDeleteRequests: {
          status: "completed",
          result: {
            scanned: 1,
            completed: 1,
            failed: 0,
            items: [
              {
                requestId: "account_delete_request_1",
                status: "completed",
                customerAnonymized: true,
              },
            ],
          },
        },
      });

      const anonymized = await repositories.account.findCustomerById(customer.customerId);
      expect(anonymized?.aggregate.email).toBeUndefined();
      expect(anonymized?.aggregate.name).toBeUndefined();
      expect(anonymized?.aggregate.company).toBeUndefined();
      expect(anonymized?.aggregate.vatId).toBeUndefined();
      expect(anonymized?.aggregate.emailHash).toBe(sentinel);
      expect(anonymized?.emailHash).toBe(sentinel);
      expect(anonymized?.customerId).toBe(customer.customerId);
      expect(anonymized?.userId).toBe(sentinel);
      expect(anonymized?.aggregate.metadata?.["anonymizedAt"]).toBe(clock.isoAt(60_000));
      expect(anonymized?.updatedAt).toBe(clock.isoAt(60_000));

      await expect(
        repositories.account.findCustomerByEmailHash(originalEmailHash),
      ).resolves.toBeNull();
      await expect(
        repositories.account.findCustomerByUserId(customer.userId as string),
      ).resolves.toBeNull();

      const request = await repositories.ops.findAccountDeleteRequest(
        createTestMikaId("account_delete_request", 1),
      );
      expect(request).toMatchObject({
        status: "completed",
        record: {
          status: "completed",
          metadata: {
            maintenance: {
              customerAnonymized: true,
            },
          },
        },
      });
    } finally {
      await rollbackMikaInitialMigration(db);
      await database.destroy();
    }
  });

  it("severs re-auth and pre-delete-session access to a deleted customer's retained records", async () => {
    const database = createTransactionTestMikaDb();
    const { db } = database;
    const accountCollection = createStorageCollection("account");
    const ledgerCollection = createStorageCollection("ledger");
    const opsCollection = createStorageCollection("ops");
    const repositories = {
      ...createTestBackendRepositories(),
      account: new AccountRepository(accountCollection),
      ledger: new LedgerRepository(ledgerCollection),
      ops: new OpsRepository(opsCollection),
      stock: new StockRepository(db),
      ephemeral: new EphemeralRepository(db),
    } satisfies MikaBackendRepositories;
    const dependencies = createIncrementingBackendDependencies({ repositories });
    const api = createMikaBackendApi(dependencies);
    const clock = createTestClock();
    const customer = createCustomerDocument();
    const originalEmailHash = createTestHash("email:subscriber@example.test");
    const sentinel = `account-deleted:${customer.customerId}`;
    const order = createOrderDocument({ emailHash: originalEmailHash });
    const entitlement = createEntitlementDocument();

    try {
      await mikaInitialMigration.up(db);
      await repositories.account.put(customer);
      await repositories.account.put(entitlement);
      await repositories.ledger.put(order);

      expect(
        (await repositories.ledger.listOrdersByEmailHash(originalEmailHash)).items,
      ).toHaveLength(1);
      expect(
        (await repositories.account.listEntitlementsByEmailHash(originalEmailHash)).items,
      ).toHaveLength(1);

      await expect(api.account.delete(createTestRequestContext(), {})).resolves.toMatchObject({
        ok: true,
        status: 202,
      });

      const runner = createMikaMaintenanceRunner({ repositories });
      await expect(runner.runOnce({ now: clock.isoAt(60_000) })).resolves.toMatchObject({
        accountDeleteRequests: {
          status: "completed",
          result: {
            completed: 1,
            failed: 0,
            items: [
              {
                requestId: "account_delete_request_1",
                status: "completed",
                customerAnonymized: true,
                ordersAnonymized: 1,
                entitlementsAnonymized: 1,
              },
            ],
          },
        },
      });

      expect(
        (await repositories.ledger.listOrdersByEmailHash(originalEmailHash)).items,
      ).toHaveLength(0);
      expect(
        (await repositories.account.listEntitlementsByEmailHash(originalEmailHash)).items,
      ).toHaveLength(0);
      const retainedOrders = (await repositories.ledger.listOrdersByEmailHash(sentinel)).items;
      expect(retainedOrders).toHaveLength(1);
      expect(retainedOrders[0]?.data.totalAmount).toBe(order.totalAmount);
      expect(retainedOrders[0]?.data.aggregate.lines).toEqual(order.aggregate.lines);
      expect(retainedOrders[0]?.data.aggregate.customer.email).toBeUndefined();
      expect(retainedOrders[0]?.data.aggregate.customer.emailHash).toBe(sentinel);
      const retainedEntitlements = (
        await repositories.account.listEntitlementsByEmailHash(sentinel)
      ).items;
      expect(retainedEntitlements).toHaveLength(1);
      expect(retainedEntitlements[0]?.data.record.emailHash).toBe(sentinel);
      expect(retainedEntitlements[0]?.data.entitlementKey).toBe(entitlement.entitlementKey);

      const originalUserId = customer.userId as string;
      await expect(repositories.account.findCustomerByUserId(originalUserId)).resolves.toBeNull();
      expect(
        (await repositories.account.listEntitlementsByUser(originalUserId)).items,
      ).toHaveLength(0);

      const guestCtx = createTestRequestContext({ customerId: false, userId: false });
      await expect(
        api.magicLink.request(guestCtx, { email: "subscriber@example.test" }),
      ).resolves.toMatchObject({ ok: true });
      await expect(
        api.magicLink.verify(guestCtx, { token: "magic_link_token_1" }),
      ).resolves.toMatchObject({ ok: true });
      expect(await api.account.get(guestCtx)).toMatchObject({
        ok: false,
        status: 401,
        error: { code: "AUTH_REQUIRED" },
      });

      const staleSessionCtx = createTestRequestContext({ customerId: false, userId: false });
      staleSessionCtx.session?.set("mika.customerId", customer.customerId);
      expect(await api.account.get(staleSessionCtx)).toMatchObject({
        ok: false,
        status: 401,
        error: { code: "AUTH_REQUIRED" },
      });

      await expect(
        repositories.account.findCustomerById(customer.customerId),
      ).resolves.toMatchObject({ customerId: customer.customerId, emailHash: sentinel });
    } finally {
      await rollbackMikaInitialMigration(db);
      await database.destroy();
    }
  });

  it("re-keys a guest's email-hash-keyed orders and entitlements on account delete (no customer doc)", async () => {
    const database = createTransactionTestMikaDb();
    const { db } = database;
    const accountCollection = createStorageCollection("account");
    const ledgerCollection = createStorageCollection("ledger");
    const opsCollection = createStorageCollection("ops");
    const repositories = {
      ...createTestBackendRepositories(),
      account: new AccountRepository(accountCollection),
      ledger: new LedgerRepository(ledgerCollection),
      ops: new OpsRepository(opsCollection),
      stock: new StockRepository(db),
      ephemeral: new EphemeralRepository(db),
    } satisfies MikaBackendRepositories;
    const dependencies = createIncrementingBackendDependencies({ repositories });
    const api = createMikaBackendApi(dependencies);
    const clock = createTestClock();

    const guestEmail = "guest@example.test";
    const guestHash = createTestHash("email:guest@example.test");
    const sentinel = `account-deleted-email:${guestHash}`;
    const baseOrder = createOrderDocument();
    const guestOrder = createOrderDocument({
      orderNumber: "M-2001",
      customerId: undefined,
      emailHash: guestHash,
      aggregate: {
        ...baseOrder.aggregate,
        customer: {
          ...baseOrder.aggregate.customer,
          customerId: undefined,
          userId: undefined,
          email: guestEmail,
          emailHash: guestHash,
        },
      },
    });
    const baseEntitlement = createEntitlementDocument();
    const guestEntitlement = {
      ...baseEntitlement,
      customerId: undefined,
      userId: undefined,
      emailHash: guestHash,
      entitlementKey: "downloads.guest",
      record: {
        ...baseEntitlement.record,
        customerId: undefined,
        userId: undefined,
        emailHash: guestHash,
        entitlementKey: "downloads.guest",
      },
    } satisfies EntitlementDocument;

    try {
      await mikaInitialMigration.up(db);
      await repositories.ledger.put(guestOrder);
      await repositories.account.put(guestEntitlement);

      expect((await repositories.ledger.listOrdersByEmailHash(guestHash)).items).toHaveLength(1);
      expect(
        (await repositories.account.listEntitlementsByEmailHash(guestHash)).items,
      ).toHaveLength(1);

      const guestCtx = createTestRequestContext({ customerId: false, userId: false });
      await guestCtx.session?.set("mika.emailHash", guestHash);
      const preDeleteAccount = await api.account.get(guestCtx);
      if (!preDeleteAccount.ok) throw new Error("Expected pre-delete guest account access.");
      const preDeleteDownloadToken = preDeleteAccount.data.downloads[0]?.href.split("/").pop();
      expect(preDeleteDownloadToken).toBe("download_token_1");
      await issueDownloadToken(repositories, {
        token: "legacy_guest_download_token",
        expiresAt: clock.isoAt(15 * 60_000),
        data: {
          downloadRef: "download:order_1:order_line_1",
          orderId: guestOrder.id,
          orderLineId: createTestMikaId("order_line", 1),
          redirectUrl: "download:order_1:order_line_1",
          title: "Legacy guest download",
        },
      });

      await expect(api.account.delete(guestCtx, {})).resolves.toMatchObject({
        ok: true,
        status: 202,
      });

      const queuedRequest = await repositories.ops.findAccountDeleteRequest(
        createTestMikaId("account_delete_request", 1),
      );
      expect(queuedRequest?.customerId).toBeUndefined();
      expect(queuedRequest?.userId).toBeUndefined();
      expect(queuedRequest?.emailHash).toBe(guestHash);

      const runner = createMikaMaintenanceRunner({ repositories });
      await expect(runner.runOnce({ now: clock.isoAt(60_000) })).resolves.toMatchObject({
        accountDeleteRequests: {
          status: "completed",
          result: {
            completed: 1,
            failed: 0,
            items: [
              {
                requestId: "account_delete_request_1",
                status: "completed",
                customerAnonymized: false,
                ordersAnonymized: 1,
                entitlementsAnonymized: 1,
              },
            ],
          },
        },
      });

      expect((await repositories.ledger.listOrdersByEmailHash(guestHash)).items).toHaveLength(0);
      expect(
        (await repositories.account.listEntitlementsByEmailHash(guestHash)).items,
      ).toHaveLength(0);
      expect((await repositories.ledger.listOrdersByEmailHash(sentinel)).items).toHaveLength(1);
      expect((await repositories.account.listEntitlementsByEmailHash(sentinel)).items).toHaveLength(
        1,
      );
      await expect(
        api.download.confirm({ token: preDeleteDownloadToken ?? "" }),
      ).resolves.toMatchObject({
        ok: false,
        status: 400,
        error: { code: "TOKEN_INVALID" },
      });
      await expect(
        api.download.confirm({ token: "legacy_guest_download_token" }),
      ).resolves.toMatchObject({
        ok: false,
        status: 410,
        error: { code: "DOWNLOAD_REVOKED" },
      });

      const freshCtx = createTestRequestContext({ customerId: false, userId: false });
      await expect(api.magicLink.request(freshCtx, { email: guestEmail })).resolves.toMatchObject({
        ok: true,
      });
      await expect(
        api.magicLink.verify(freshCtx, { token: "magic_link_token_1" }),
      ).resolves.toMatchObject({ ok: true });
      expect(await api.account.get(freshCtx)).toMatchObject({
        ok: false,
        status: 401,
        error: { code: "AUTH_REQUIRED" },
      });
    } finally {
      await rollbackMikaInitialMigration(db);
      await database.destroy();
    }
  });

  it("severs the userId re-auth path and neutralizes the userId index on account delete", async () => {
    const database = createTransactionTestMikaDb();
    const { db } = database;
    const accountCollection = createStorageCollection("account");
    const ledgerCollection = createStorageCollection("ledger");
    const opsCollection = createStorageCollection("ops");
    const repositories = {
      ...createTestBackendRepositories(),
      account: new AccountRepository(accountCollection),
      ledger: new LedgerRepository(ledgerCollection),
      ops: new OpsRepository(opsCollection),
      stock: new StockRepository(db),
      ephemeral: new EphemeralRepository(db),
    } satisfies MikaBackendRepositories;
    const dependencies = createIncrementingBackendDependencies({ repositories });
    const api = createMikaBackendApi(dependencies);
    const clock = createTestClock();
    const customer = createCustomerDocument();
    const originalUserId = customer.userId as string;
    const order = createOrderDocument();
    const entitlement = createEntitlementDocument();
    const userIdCtx = () => createTestRequestContext({ customerId: false, userId: originalUserId });

    try {
      await mikaInitialMigration.up(db);
      await repositories.account.put(customer);
      await repositories.account.put(entitlement);
      await repositories.ledger.put(order);

      await expect(api.account.get(userIdCtx())).resolves.toMatchObject({
        ok: true,
        status: 200,
        data: {
          customer: { id: customer.customerId, userId: originalUserId },
          orders: [{ id: order.id }],
          entitlements: [{ key: entitlement.entitlementKey }],
        },
      });
      expect(
        (await repositories.account.listEntitlementsByUser(originalUserId)).items,
      ).toHaveLength(1);

      await expect(api.account.delete(createTestRequestContext(), {})).resolves.toMatchObject({
        ok: true,
        status: 202,
      });

      const runner = createMikaMaintenanceRunner({ repositories });
      await expect(runner.runOnce({ now: clock.isoAt(60_000) })).resolves.toMatchObject({
        accountDeleteRequests: {
          status: "completed",
          result: {
            completed: 1,
            failed: 0,
            items: [
              {
                requestId: "account_delete_request_1",
                status: "completed",
                customerAnonymized: true,
                entitlementsAnonymized: 1,
              },
            ],
          },
        },
      });

      await expect(repositories.account.findCustomerByUserId(originalUserId)).resolves.toBeNull();
      expect(
        (await repositories.account.listEntitlementsByUser(originalUserId)).items,
      ).toHaveLength(0);

      expect(await api.account.get(userIdCtx())).toMatchObject({
        ok: false,
        status: 401,
        error: { code: "AUTH_REQUIRED" },
      });

      await expect(
        repositories.account.findCustomerById(customer.customerId),
      ).resolves.toMatchObject({ customerId: customer.customerId });
    } finally {
      await rollbackMikaInitialMigration(db);
      await database.destroy();
    }
  });

  it("marks queued account delete requests failed when cleanup fails", async () => {
    const repositories = {
      ...createTestBackendRepositories(),
      ephemeral: {
        async get() {
          return null;
        },
        async put() {
          return undefined;
        },
        async incrementCounter() {
          throw new Error("not used");
        },
        async tryAcquireLock() {
          throw new Error("not used");
        },
        async releaseLock() {
          return false;
        },
        async consumeToken() {
          return false;
        },
        async restoreToken() {
          return false;
        },
        async purgeExpired() {
          return 0;
        },
        async deleteTokensBySubjectHashes() {
          throw new Error("token cleanup failed");
        },
      } satisfies MikaEphemeralRepositoryPort,
    } satisfies MikaBackendRepositories;
    const record = {
      id: createTestMikaId("account_delete_request", 1),
      customerId: createTestMikaId("customer", 1),
      userId: "user_1",
      emailHash: createTestHash("email:subscriber@example.test"),
      status: "queued" as const,
      requestedAt: TEST_NOW,
    };

    await repositories.ops.put({
      id: record.id,
      type: "accountDeleteRequest",
      schemaVersion: 1,
      customerId: record.customerId,
      userId: record.userId,
      emailHash: record.emailHash,
      status: record.status,
      record,
      createdAt: TEST_NOW,
      updatedAt: TEST_NOW,
    });

    await expect(createMikaMaintenanceRunner({ repositories }).runOnce()).resolves.toMatchObject({
      accountDeleteRequests: {
        status: "completed",
        result: {
          scanned: 1,
          completed: 0,
          failed: 1,
          items: [
            {
              requestId: "account_delete_request_1",
              status: "failed",
              error: "token cleanup failed",
            },
          ],
        },
      },
    });
    await expect(repositories.ops.findAccountDeleteRequest(record.id)).resolves.toMatchObject({
      status: "failed",
      record: {
        status: "failed",
        lastError: "token cleanup failed",
      },
    });
  });

  it("resumes account delete maintenance after final completion fails", async () => {
    const database = createTransactionTestMikaDb();
    const { db } = database;
    const accountCollection = createStorageCollection("account");
    const ledgerCollection = createStorageCollection("ledger");
    const opsCollection = createStorageCollection("ops");
    const repositories = {
      ...createTestBackendRepositories(),
      account: new AccountRepository(accountCollection),
      ledger: new LedgerRepository(ledgerCollection),
      ops: new OpsRepository(opsCollection),
      stock: new StockRepository(db),
      ephemeral: new EphemeralRepository(db),
    } satisfies MikaBackendRepositories;
    const dependencies = createIncrementingBackendDependencies({ repositories });
    const api = createMikaBackendApi(dependencies);
    const service = createMikaStockLifecycleService(dependencies);
    const clock = createTestClock();
    const customer = createCustomerDocument();
    const order = createOrderDocument();
    const entitlement = createEntitlementDocument();
    const license = createLicenseDocument({ customerId: customer.customerId });
    const stockItem = createStockRecord({ quantityOnHand: 4, quantityReserved: 0 });
    const email = createEmailDocument({
      id: createTestMikaId("email", 1),
      record: {
        id: createTestMikaId("email", 1),
        kind: "magic_link",
        templateKey: "magic_link",
        customerId: customer.customerId,
        toEmail: "Subscriber@Example.test",
        metadata: { link: "https://shop.example.test/account/delete/confirm?token=secret" },
      },
    });
    const calls = {
      tokens: 0,
      reservations: 0,
      emails: 0,
      orders: 0,
      entitlements: 0,
      licenses: 0,
      customer: 0,
      complete: 0,
    };
    const deleteTokensBySubjectHashes = repositories.ephemeral.deleteTokensBySubjectHashes.bind(
      repositories.ephemeral,
    );
    repositories.ephemeral.deleteTokensBySubjectHashes = async (subjectHashes) => {
      calls.tokens += 1;

      return deleteTokensBySubjectHashes(subjectHashes);
    };
    const releaseActiveReservationsByCustomer =
      repositories.stock.releaseActiveReservationsByCustomer.bind(repositories.stock);
    repositories.stock.releaseActiveReservationsByCustomer = async (releaseInput) => {
      calls.reservations += 1;

      return releaseActiveReservationsByCustomer(releaseInput);
    };
    const redactQueuedFailedEmailsForAccountDelete =
      repositories.ops.redactQueuedFailedEmailsForAccountDelete.bind(repositories.ops);
    repositories.ops.redactQueuedFailedEmailsForAccountDelete = async (redactInput) => {
      calls.emails += 1;

      return redactQueuedFailedEmailsForAccountDelete(redactInput);
    };
    const anonymizeOrdersForAccountDelete =
      repositories.ledger.anonymizeOrdersForAccountDelete.bind(repositories.ledger);
    repositories.ledger.anonymizeOrdersForAccountDelete = async (anonymizeInput) => {
      calls.orders += 1;

      return anonymizeOrdersForAccountDelete(anonymizeInput);
    };
    const anonymizeEntitlementsForAccountDelete =
      repositories.account.anonymizeEntitlementsForAccountDelete.bind(repositories.account);
    repositories.account.anonymizeEntitlementsForAccountDelete = async (anonymizeInput) => {
      calls.entitlements += 1;

      return anonymizeEntitlementsForAccountDelete(anonymizeInput);
    };
    const anonymizeLicensesForAccountDelete =
      repositories.account.anonymizeLicensesForAccountDelete.bind(repositories.account);
    repositories.account.anonymizeLicensesForAccountDelete = async (anonymizeInput) => {
      calls.licenses += 1;

      return anonymizeLicensesForAccountDelete(anonymizeInput);
    };
    const anonymizeCustomerForAccountDelete =
      repositories.account.anonymizeCustomerForAccountDelete.bind(repositories.account);
    repositories.account.anonymizeCustomerForAccountDelete = async (anonymizeInput) => {
      calls.customer += 1;

      return anonymizeCustomerForAccountDelete(anonymizeInput);
    };
    const completeAccountDeleteRequest = repositories.ops.completeAccountDeleteRequest.bind(
      repositories.ops,
    );
    repositories.ops.completeAccountDeleteRequest = async (completeInput) => {
      calls.complete += 1;
      if (calls.complete === 1) return null;

      return completeAccountDeleteRequest(completeInput);
    };

    try {
      await mikaInitialMigration.up(db);
      await repositories.account.put(customer);
      await repositories.account.put(entitlement);
      await repositories.account.put(license);
      await repositories.ledger.put(order);
      await repositories.ops.put(email);
      await repositories.stock.putItem(stockItem);
      await service.reserve({
        stockItemId: stockItem.id,
        quantity: 2,
        customerId: customer.customerId,
        expiresAt: clock.isoAt(15 * 60_000),
      });
      await repositories.ephemeral.put({
        key: "customer_download_token",
        kind: "token",
        subjectHash: customer.customerId,
        status: "pending",
        count: 0,
        expiresAt: clock.isoAt(15 * 60_000),
        version: 1,
        createdAt: TEST_NOW,
        updatedAt: TEST_NOW,
      });

      await expect(api.account.delete(createTestRequestContext(), {})).resolves.toMatchObject({
        ok: true,
        status: 202,
      });
      const runner = createMikaMaintenanceRunner({ repositories });

      await expect(runner.runOnce({ now: clock.isoAt(60_000) })).resolves.toMatchObject({
        accountDeleteRequests: {
          status: "completed",
          result: {
            scanned: 1,
            completed: 0,
            failed: 1,
            items: [
              {
                requestId: "account_delete_request_1",
                status: "failed",
                error: "Account delete request 'account_delete_request_1' could not be completed.",
              },
            ],
          },
        },
      });
      expect(calls).toEqual({
        tokens: 1,
        reservations: 1,
        emails: 1,
        orders: 1,
        entitlements: 1,
        licenses: 1,
        customer: 1,
        complete: 1,
      });
      await expect(
        repositories.ops.findAccountDeleteRequest(createTestMikaId("account_delete_request", 1)),
      ).resolves.toMatchObject({
        status: "queued",
        record: {
          status: "queued",
          lastError: "Account delete request 'account_delete_request_1' could not be completed.",
          metadata: {
            maintenance: {
              steps: {
                tokensDeleted: { status: "completed", result: { value: 1 } },
                reservationsReleased: { status: "completed", result: { value: 1 } },
                emailsRedacted: { status: "completed", result: { value: 1 } },
                ordersAnonymized: { status: "completed", result: { value: 1 } },
                entitlementsAnonymized: { status: "completed", result: { value: 1 } },
                licensesAnonymized: { status: "completed", result: { value: 1 } },
                customerAnonymized: { status: "completed", result: { value: true } },
              },
            },
          },
        },
      });

      await expect(runner.runOnce({ now: clock.isoAt(120_000) })).resolves.toMatchObject({
        accountDeleteRequests: {
          status: "completed",
          result: {
            scanned: 1,
            completed: 1,
            failed: 0,
            items: [
              {
                requestId: "account_delete_request_1",
                status: "completed",
                tokensDeleted: 1,
                reservationsReleased: 1,
                emailsRedacted: 1,
                customerAnonymized: true,
                ordersAnonymized: 1,
                entitlementsAnonymized: 1,
                licensesAnonymized: 1,
              },
            ],
          },
        },
      });
      expect(calls).toEqual({
        tokens: 1,
        reservations: 1,
        emails: 1,
        orders: 1,
        entitlements: 1,
        licenses: 1,
        customer: 1,
        complete: 2,
      });
      await expect(
        repositories.ops.findAccountDeleteRequest(createTestMikaId("account_delete_request", 1)),
      ).resolves.toMatchObject({
        status: "completed",
        record: {
          status: "completed",
          completedAt: clock.isoAt(120_000),
          metadata: {
            maintenance: {
              tokensDeleted: 1,
              reservationsReleased: 1,
              emailsRedacted: 1,
              customerAnonymized: true,
              ordersAnonymized: 1,
              entitlementsAnonymized: 1,
              licensesAnonymized: 1,
              steps: {
                tokensDeleted: { status: "completed", result: { value: 1 } },
                reservationsReleased: { status: "completed", result: { value: 1 } },
                emailsRedacted: { status: "completed", result: { value: 1 } },
                ordersAnonymized: { status: "completed", result: { value: 1 } },
                entitlementsAnonymized: { status: "completed", result: { value: 1 } },
                licensesAnonymized: { status: "completed", result: { value: 1 } },
                customerAnonymized: { status: "completed", result: { value: true } },
              },
            },
          },
        },
      });

      await expect(runner.runOnce({ now: clock.isoAt(180_000) })).resolves.toMatchObject({
        accountDeleteRequests: {
          status: "completed",
          result: {
            scanned: 0,
            completed: 0,
            failed: 0,
          },
        },
      });
      expect(calls).toEqual({
        tokens: 1,
        reservations: 1,
        emails: 1,
        orders: 1,
        entitlements: 1,
        licenses: 1,
        customer: 1,
        complete: 2,
      });
    } finally {
      await rollbackMikaInitialMigration(db);
      await database.destroy();
    }
  });

  it("creates a provider portal session for a known provider account", async () => {
    const accountCollection = createStorageCollection("account");
    const repositories = {
      ...createTestBackendRepositories(),
      account: new AccountRepository(accountCollection),
    } satisfies MikaBackendRepositories;
    const fake = createFakeMikaProvider({
      optionalMethods: ["createPortalSession"],
    });
    const api = createMikaBackendApi(
      createTestBackendDependencies({
        repositories,
        providers: createMikaProviderRegistry([fake.provider]),
      }),
    );

    await repositories.account.put(createCustomerDocument());
    await repositories.account.put(createProviderAccountDocument());

    await expect(
      api.account.portal(createTestRequestContext({ url: "https://shop.example.test/current" }), {
        returnTo: "/account",
      }),
    ).resolves.toEqual({
      ok: true,
      status: 200,
      data: { redirectUrl: "https://portal.example.test/session/portal_fake" },
    });
    expect(fake.getCalls().createPortalSession).toEqual([
      {
        providerCustomerId: "provider_customer_1",
        returnUrl: "https://shop.example.test/account",
      },
    ]);
  });

  it("normalizes unsafe provider portal return targets", async () => {
    const accountCollection = createStorageCollection("account");
    const repositories = {
      ...createTestBackendRepositories(),
      account: new AccountRepository(accountCollection),
    } satisfies MikaBackendRepositories;
    const fake = createFakeMikaProvider({
      optionalMethods: ["createPortalSession"],
    });
    const api = createMikaBackendApi(
      createTestBackendDependencies({
        repositories,
        providers: createMikaProviderRegistry([fake.provider]),
      }),
    );

    await repositories.account.put(createCustomerDocument());
    await repositories.account.put(createProviderAccountDocument());

    await expect(
      api.account.portal(
        createTestRequestContext({ url: "https://shop.example.test/account?tab=billing" }),
        { returnTo: "//evil.test/portal" },
      ),
    ).resolves.toMatchObject({
      ok: true,
      status: 200,
    });
    expect(fake.getCalls().createPortalSession).toEqual([
      {
        providerCustomerId: "provider_customer_1",
        returnUrl: "https://shop.example.test/account?tab=billing",
      },
    ]);
  });

  it("returns provider unsupported when portal adapter support is unavailable", async () => {
    const missingAdapterRepositories = createTestBackendRepositories();
    await missingAdapterRepositories.account.put(createCustomerDocument());
    await missingAdapterRepositories.account.put(
      createProviderAccountDocument({ provider: createTestProviderName("missing") }),
    );
    const missingAdapterApi = createMikaBackendApi(
      createTestBackendDependencies({
        repositories: missingAdapterRepositories,
        providers: createMikaProviderRegistry([]),
      }),
    );

    await expect(
      missingAdapterApi.account.portal(createTestRequestContext(), {}),
    ).resolves.toMatchObject({
      ok: false,
      status: 409,
      error: { code: "PROVIDER_UNSUPPORTED" },
    });

    const missingMethodRepositories = createTestBackendRepositories();
    const fake = createFakeMikaProvider({ optionalMethods: "none" });
    await missingMethodRepositories.account.put(createCustomerDocument());
    await missingMethodRepositories.account.put(createProviderAccountDocument());
    const missingMethodApi = createMikaBackendApi(
      createTestBackendDependencies({
        repositories: missingMethodRepositories,
        providers: createMikaProviderRegistry([fake.provider]),
      }),
    );

    await expect(
      missingMethodApi.account.portal(createTestRequestContext(), {}),
    ).resolves.toMatchObject({
      ok: false,
      status: 409,
      error: { code: "PROVIDER_UNSUPPORTED" },
    });
    expect(fake.getCalls().createPortalSession).toEqual([]);
  });

  it("returns provider failed when portal session creation fails", async () => {
    const repositories = createTestBackendRepositories();
    const fake = createFakeMikaProvider({
      optionalMethods: ["createPortalSession"],
      overrides: {
        createPortalSession: async () => {
          throw new Error("Portal session failed.");
        },
      },
    });
    const api = createMikaBackendApi(
      createTestBackendDependencies({
        repositories,
        providers: createMikaProviderRegistry([fake.provider]),
      }),
    );

    await repositories.account.put(createCustomerDocument());
    await repositories.account.put(createProviderAccountDocument());

    await expect(api.account.portal(createTestRequestContext(), {})).resolves.toMatchObject({
      ok: false,
      status: 502,
      error: {
        code: "PROVIDER_FAILED",
        message: "Portal session failed.",
      },
    });
  });

  it("returns provider unsupported for subscription actions without mutating the subscription", async () => {
    const repositories = createTestBackendRepositories();
    const fake = createFakeMikaProvider({ optionalMethods: "none" });
    const subscription = createSubscriptionDocument();
    const api = createMikaBackendApi(
      createIncrementingBackendDependencies({
        repositories,
        providers: createMikaProviderRegistry([fake.provider]),
      }),
    );

    await repositories.account.put(createCustomerDocument());
    await repositories.account.put(subscription);

    await expect(
      api.subscription.cancel(createTestRequestContext(), { subscriptionId: subscription.id }),
    ).resolves.toMatchObject({
      ok: false,
      status: 409,
      error: { code: "PROVIDER_UNSUPPORTED" },
    });

    expect(fake.getCalls().cancelSubscription).toEqual([]);
    await expect(repositories.account.findSubscriptionById(subscription.id)).resolves.toEqual(
      subscription,
    );
    await expect(
      repositories.ops.findAdminAudit(createTestMikaId("admin_audit", 1)),
    ).resolves.toBeNull();
  });

  it("normalizes subscription provider failures and records failed audit state", async () => {
    const repositories = createTestBackendRepositories();
    const fake = createFakeMikaProvider({
      optionalMethods: ["cancelSubscription"],
      overrides: {
        cancelSubscription: async () => {
          throw new Error("Provider cancel failed.");
        },
      },
    });
    const subscription = createSubscriptionDocument();
    const api = createMikaBackendApi(
      createIncrementingBackendDependencies({
        repositories,
        providers: createMikaProviderRegistry([fake.provider]),
      }),
    );

    await repositories.account.put(createCustomerDocument());
    await repositories.account.put(subscription);

    await expect(
      api.subscription.cancel(createTestRequestContext(), { subscriptionId: subscription.id }),
    ).resolves.toMatchObject({
      ok: false,
      status: 502,
      error: {
        code: "PROVIDER_FAILED",
        message: "Provider cancel failed.",
      },
    });

    expect(fake.getCalls().cancelSubscription).toEqual([
      {
        subscriptionId: subscription.id,
        providerSubscriptionId: "provider_subscription_1",
      },
    ]);
    await expect(repositories.account.findSubscriptionById(subscription.id)).resolves.toEqual(
      subscription,
    );
    await expect(
      repositories.ops.findAdminAudit(createTestMikaId("admin_audit", 1)),
    ).resolves.toMatchObject({
      status: "failed",
      record: {
        action: "subscription.cancel",
        targetType: "subscription",
        targetId: subscription.id,
        status: "failed",
        metadata: {
          provider: TEST_PROVIDER,
          subscriptionId: subscription.id,
          providerSubscriptionId: "provider_subscription_1",
          error: "Provider cancel failed.",
        },
      },
    });
  });

  it("rejects cancel/change/renew on a terminal (cancelled/expired) subscription without reviving it", async () => {
    const terminalCases = [
      {
        status: "cancelled" as const,
        action: "renew" as const,
        method: "renewSubscription" as const,
      },
      {
        status: "cancelled" as const,
        action: "cancel" as const,
        method: "cancelSubscription" as const,
      },
      {
        status: "expired" as const,
        action: "renew" as const,
        method: "renewSubscription" as const,
      },
      {
        status: "expired" as const,
        action: "change" as const,
        method: "changeSubscription" as const,
      },
    ];

    for (const terminal of terminalCases) {
      const repositories = createTestBackendRepositories();
      const fake = createFakeMikaProvider({
        optionalMethods: ["cancelSubscription", "changeSubscription", "renewSubscription"],
      });
      const subscription = createSubscriptionDocument({
        status: terminal.status,
        aggregate: {
          ...createSubscriptionDocument().aggregate,
          status: terminal.status,
        },
      });
      const api = createMikaBackendApi(
        createIncrementingBackendDependencies({
          repositories,
          providers: createMikaProviderRegistry([fake.provider]),
        }),
      );

      await repositories.account.put(createCustomerDocument());
      await repositories.account.put(subscription);

      await expect(
        api.subscription[terminal.action](createTestRequestContext(), {
          subscriptionId: subscription.id,
        }),
      ).resolves.toMatchObject({
        ok: false,
        status: 409,
        error: {
          code: "CONFLICT",
          message: `Subscription '${subscription.id}' is ${terminal.status} and cannot be modified.`,
        },
      });

      expect(fake.getCalls()[terminal.method]).toEqual([]);
      await expect(repositories.account.findSubscriptionById(subscription.id)).resolves.toEqual(
        subscription,
      );
    }
  });

  it("does not mutate subscription state when the provider returns a non-throwing failure", async () => {
    const repositories = createTestBackendRepositories();
    const fake = createFakeMikaProvider({
      optionalMethods: ["cancelSubscription"],
      overrides: {
        cancelSubscription: async () => ({
          status: "unsupported" as const,
          message: "Subscription is not linked to the billing provider.",
        }),
      },
    });
    const subscription = createSubscriptionDocument();
    const api = createMikaBackendApi(
      createIncrementingBackendDependencies({
        repositories,
        providers: createMikaProviderRegistry([fake.provider]),
      }),
    );

    await repositories.account.put(createCustomerDocument());
    await repositories.account.put(subscription);

    await expect(
      api.subscription.cancel(createTestRequestContext(), { subscriptionId: subscription.id }),
    ).resolves.toMatchObject({
      ok: false,
      status: 502,
      error: {
        code: "PROVIDER_FAILED",
        message: "Subscription is not linked to the billing provider.",
      },
    });

    await expect(repositories.account.findSubscriptionById(subscription.id)).resolves.toEqual(
      subscription,
    );
    await expect(
      repositories.ops.findAdminAudit(createTestMikaId("admin_audit", 1)),
    ).resolves.toMatchObject({
      status: "failed",
      record: { action: "subscription.cancel", status: "failed" },
    });
  });

  it("normalizes subscription change and renew provider failures with failed audit state", async () => {
    const cases = [
      {
        action: "change" as const,
        optionalMethod: "changeSubscription" as const,
        message: "Provider change failed.",
        priceId: createTestMikaId("price", 2),
        expectedProviderPriceId: "price_failure",
        seed: async (repositories: MikaBackendRepositories) => {
          await repositories.catalog.put(
            createCatalogItemDocument({
              contentRef: createTestContentRef(),
              sellables: [
                createSellableDefinition({
                  prices: [
                    createPriceDefinition({
                      id: createTestMikaId("price", 2),
                      mode: "subscription",
                      providerRefs: [
                        {
                          provider: TEST_PROVIDER,
                          productId: "prod_failure",
                          priceId: "price_failure",
                        },
                      ],
                    }),
                  ],
                }),
              ],
            }),
          );
        },
        run: (api: MikaApi, subscriptionId: MikaId, priceId?: MikaId) =>
          api.subscription.change(createTestRequestContext(), { subscriptionId, priceId }),
        calls: (fake: ReturnType<typeof createFakeMikaProvider>) =>
          fake.getCalls().changeSubscription,
      },
      {
        action: "renew" as const,
        optionalMethod: "renewSubscription" as const,
        message: "Provider renew failed.",
        seed: async () => {},
        run: (api: MikaApi, subscriptionId: MikaId) =>
          api.subscription.renew(createTestRequestContext(), { subscriptionId }),
        calls: (fake: ReturnType<typeof createFakeMikaProvider>) =>
          fake.getCalls().renewSubscription,
      },
    ];

    for (const failureCase of cases) {
      const repositories = createTestBackendRepositories();
      const fake = createFakeMikaProvider({
        optionalMethods: [failureCase.optionalMethod],
        overrides: {
          [failureCase.optionalMethod]: async () => {
            throw new Error(failureCase.message);
          },
        },
      });
      const subscription = createSubscriptionDocument();
      const api = createMikaBackendApi(
        createIncrementingBackendDependencies({
          repositories,
          providers: createMikaProviderRegistry([fake.provider]),
        }),
      );

      await repositories.account.put(createCustomerDocument());
      await repositories.account.put(subscription);
      await failureCase.seed(repositories);

      await expect(
        failureCase.run(api, subscription.id, failureCase.priceId),
      ).resolves.toMatchObject({
        ok: false,
        status: 502,
        error: {
          code: "PROVIDER_FAILED",
          message: failureCase.message,
        },
      });

      expect(failureCase.calls(fake)).toEqual([
        {
          subscriptionId: subscription.id,
          providerSubscriptionId: "provider_subscription_1",
          ...(failureCase.priceId ? { priceId: failureCase.priceId } : {}),
          ...(failureCase.expectedProviderPriceId
            ? { providerPriceId: failureCase.expectedProviderPriceId }
            : {}),
        },
      ]);
      await expect(repositories.account.findSubscriptionById(subscription.id)).resolves.toEqual(
        subscription,
      );
      await expect(
        repositories.ops.findAdminAudit(createTestMikaId("admin_audit", 1)),
      ).resolves.toMatchObject({
        status: "failed",
        record: {
          action: `subscription.${failureCase.action}`,
          targetType: "subscription",
          targetId: subscription.id,
          status: "failed",
          metadata: {
            provider: TEST_PROVIDER,
            subscriptionId: subscription.id,
            providerSubscriptionId: "provider_subscription_1",
            ...(failureCase.priceId ? { priceId: failureCase.priceId } : {}),
            ...(failureCase.expectedProviderPriceId
              ? { providerPriceId: failureCase.expectedProviderPriceId }
              : {}),
            error: failureCase.message,
          },
        },
      });
    }
  });

  it("replays subscription actions by request idempotency key", async () => {
    const repositories = createTestBackendRepositories();
    const fake = createFakeMikaProvider({ optionalMethods: ["cancelSubscription"] });
    const subscription = createSubscriptionDocument();
    const api = createMikaBackendApi(
      createIncrementingBackendDependencies({
        repositories,
        providers: createMikaProviderRegistry([fake.provider]),
      }),
    );
    const ctx = createTestRequestContext({ idempotencyKey: "subscription_cancel_1" });
    const input = { subscriptionId: subscription.id };

    await repositories.account.put(createCustomerDocument());
    await repositories.account.put(subscription);

    const first = await api.subscription.cancel(ctx, input);
    expect(first).toMatchObject({
      ok: true,
      status: 200,
      data: {
        subscriptions: [
          {
            id: subscription.id,
            status: "cancel_at_period_end",
          },
        ],
      },
    });

    const replay = await api.subscription.cancel(ctx, input);
    expect(replay).toMatchObject({
      ok: true,
      status: 200,
      data: {
        subscriptions: [
          {
            id: subscription.id,
            status: "cancel_at_period_end",
          },
        ],
      },
    });
    expect(fake.getCalls().cancelSubscription).toEqual([
      {
        subscriptionId: subscription.id,
        providerSubscriptionId: "provider_subscription_1",
      },
    ]);
    await expect(
      repositories.ops.findAdminAudit(createTestMikaId("admin_audit", 2)),
    ).resolves.toBeNull();
  });

  it("runs subscription provider actions and updates stored subscription state", async () => {
    const contentRef = createTestContentRef();
    const replacementPrice = createPriceDefinition({
      id: createTestMikaId("price", 2),
      titleSnapshot: "Pro subscription",
      providerRefs: [{ provider: TEST_PROVIDER, productId: "prod_sub", priceId: "price_pro" }],
      mode: "subscription",
      fulfillmentKind: "entitlement",
    });
    const sellable = createSellableDefinition({
      prices: [
        createPriceDefinition({
          providerRefs: [
            { provider: TEST_PROVIDER, productId: "prod_sub", priceId: "price_basic" },
          ],
          mode: "subscription",
          fulfillmentKind: "entitlement",
        }),
        replacementPrice,
      ],
    });
    const repositories = createTestBackendRepositories();
    const fake = createFakeMikaProvider({
      optionalMethods: ["cancelSubscription", "changeSubscription", "renewSubscription"],
    });
    const baseSubscription = createSubscriptionDocument();
    const subscription: SubscriptionDocument = {
      ...baseSubscription,
      aggregate: {
        ...baseSubscription.aggregate,
        providerRef: {
          ...baseSubscription.aggregate.providerRef,
          priceId: "price_basic",
        },
      },
    };
    const api = createMikaBackendApi(
      createIncrementingBackendDependencies({
        repositories,
        providers: createMikaProviderRegistry([fake.provider]),
      }),
    );

    await repositories.catalog.put(
      createCatalogItemDocument({ contentRef, sellables: [sellable] }),
    );
    await repositories.account.put(createCustomerDocument());
    await repositories.account.put(subscription);

    await expect(
      api.subscription.cancel(createTestRequestContext(), { subscriptionId: subscription.id }),
    ).resolves.toMatchObject({
      ok: true,
      status: 200,
      data: {
        subscriptions: [
          {
            id: subscription.id,
            status: "cancel_at_period_end",
            cancelAtPeriodEnd: true,
          },
        ],
      },
    });
    expect(fake.getCalls().cancelSubscription).toEqual([
      {
        subscriptionId: subscription.id,
        providerSubscriptionId: "provider_subscription_1",
        providerPriceId: "price_basic",
      },
    ]);

    await expect(
      api.subscription.renew(createTestRequestContext(), { subscriptionId: subscription.id }),
    ).resolves.toMatchObject({
      ok: true,
      data: {
        subscriptions: [
          {
            id: subscription.id,
            status: "active",
            cancelAtPeriodEnd: false,
          },
        ],
      },
    });
    expect(fake.getCalls().renewSubscription).toEqual([
      {
        subscriptionId: subscription.id,
        providerSubscriptionId: "provider_subscription_1",
        providerPriceId: "price_basic",
      },
    ]);

    await expect(
      api.subscription.change(createTestRequestContext(), {
        subscriptionId: subscription.id,
        priceId: replacementPrice.id,
      }),
    ).resolves.toMatchObject({
      ok: true,
      data: {
        subscriptions: [
          {
            id: subscription.id,
            title: "Pro subscription",
            status: "active",
          },
        ],
      },
    });
    expect(fake.getCalls().changeSubscription).toEqual([
      {
        subscriptionId: subscription.id,
        providerSubscriptionId: "provider_subscription_1",
        priceId: replacementPrice.id,
        providerPriceId: "price_pro",
      },
    ]);
    await expect(repositories.account.findSubscriptionById(subscription.id)).resolves.toMatchObject(
      {
        status: "active",
        aggregate: {
          sellable: {
            priceId: replacementPrice.id,
            titleSnapshot: "Pro subscription",
          },
          providerRef: {
            priceId: "price_pro",
          },
        },
      },
    );
    await expect(
      repositories.ops.findAdminAudit(createTestMikaId("admin_audit", 1)),
    ).resolves.toMatchObject({
      status: "completed",
      record: {
        action: "subscription.cancel",
        status: "completed",
        metadata: {
          provider: TEST_PROVIDER,
          subscriptionId: subscription.id,
          providerSubscriptionId: "provider_subscription_1",
          providerPriceId: "price_basic",
        },
      },
    });
    await expect(
      repositories.ops.findAdminAudit(createTestMikaId("admin_audit", 2)),
    ).resolves.toMatchObject({
      status: "completed",
      record: {
        action: "subscription.renew",
        status: "completed",
        metadata: {
          provider: TEST_PROVIDER,
          subscriptionId: subscription.id,
          providerSubscriptionId: "provider_subscription_1",
          providerPriceId: "price_basic",
        },
      },
    });
    await expect(
      repositories.ops.findAdminAudit(createTestMikaId("admin_audit", 3)),
    ).resolves.toMatchObject({
      status: "completed",
      record: {
        action: "subscription.change",
        status: "completed",
        metadata: {
          provider: TEST_PROVIDER,
          subscriptionId: subscription.id,
          priceId: replacementPrice.id,
          providerPriceId: "price_pro",
        },
      },
    });
  });

  it("rejects a subscription change to a price outside the current plan (different sellable, one-time, or foreign currency)", async () => {
    const contentRef = createTestContentRef();
    const ownSellable = createSellableDefinition({
      id: createTestMikaId("sellable", 1),
      prices: [
        createPriceDefinition({
          id: createTestMikaId("price", 1),
          mode: "subscription",
          fulfillmentKind: "entitlement",
          providerRefs: [{ provider: TEST_PROVIDER, productId: "prod_sub", priceId: "price_self" }],
        }),
        createPriceDefinition({
          id: createTestMikaId("price", 3),
          mode: "payment",
          providerRefs: [
            { provider: TEST_PROVIDER, productId: "prod_sub", priceId: "price_onetime" },
          ],
        }),
        createPriceDefinition({
          id: createTestMikaId("price", 4),
          mode: "subscription",
          fulfillmentKind: "entitlement",
          currency: createCurrencyCode("USD"),
          providerRefs: [{ provider: TEST_PROVIDER, productId: "prod_sub", priceId: "price_usd" }],
        }),
      ],
    });
    const crossSellable = createSellableDefinition({
      id: createTestMikaId("sellable", 2),
      prices: [
        createPriceDefinition({
          id: createTestMikaId("price", 2),
          mode: "subscription",
          fulfillmentKind: "entitlement",
          providerRefs: [
            { provider: TEST_PROVIDER, productId: "prod_other", priceId: "price_cross" },
          ],
        }),
      ],
    });

    const cases = [
      { label: "different sellable (cross-product)", priceId: createTestMikaId("price", 2) },
      { label: "one-time payment-mode price", priceId: createTestMikaId("price", 3) },
      { label: "foreign-currency price", priceId: createTestMikaId("price", 4) },
    ];

    for (const target of cases) {
      const repositories = createTestBackendRepositories();
      const fake = createFakeMikaProvider({ optionalMethods: ["changeSubscription"] });
      const subscription = createSubscriptionDocument();
      const api = createMikaBackendApi(
        createIncrementingBackendDependencies({
          repositories,
          providers: createMikaProviderRegistry([fake.provider]),
        }),
      );

      await repositories.catalog.put(
        createCatalogItemDocument({ contentRef, sellables: [ownSellable, crossSellable] }),
      );
      await repositories.account.put(createCustomerDocument());
      await repositories.account.put(subscription);

      await expect(
        api.subscription.change(createTestRequestContext(), {
          subscriptionId: subscription.id,
          priceId: target.priceId,
        }),
        `${target.label} must be rejected`,
      ).resolves.toMatchObject({
        ok: false,
        status: 422,
        error: {
          code: "VALIDATION_FAILED",
          fieldErrors: {
            priceId: `Price '${target.priceId}' is not a valid change target for this subscription.`,
          },
        },
      });

      expect(fake.getCalls().changeSubscription).toEqual([]);
      await expect(repositories.account.findSubscriptionById(subscription.id)).resolves.toEqual(
        subscription,
      );
    }
  });

  it("checks provider health with adapter health and capability fallback", async () => {
    const stripe = createTestProviderName("stripe");
    const healthProvider = createFakeMikaProvider({
      id: stripe,
      optionalMethods: ["health"],
      capabilities: ["hosted_checkout", "product_sync"],
    });
    const fallbackProvider = createFakeMikaProvider({
      id: "fallback",
      optionalMethods: "none",
      capabilities: ["payments", "stock_sync"],
    });
    const api = createMikaBackendApi(
      createIncrementingBackendDependencies({
        providers: createMikaProviderRegistry([healthProvider.provider, fallbackProvider.provider]),
      }),
    );

    await expect(api.admin.providerHealth({ provider: stripe })).resolves.toEqual({
      ok: true,
      status: 200,
      data: {
        provider: stripe,
        ok: true,
        capabilities: ["hosted_checkout", "product_sync"],
        checkedAt: "2026-01-01T00:00:00.000Z",
      },
    });
    expect(healthProvider.getCalls().health).toEqual([undefined]);
    expect(healthProvider.getCalls().capabilities).toEqual([]);

    await expect(
      api.admin.providerHealth({ provider: createTestProviderName("fallback") }),
    ).resolves.toEqual({
      ok: true,
      status: 200,
      data: {
        provider: "fallback",
        ok: true,
        capabilities: ["payments", "stock_sync"],
        checkedAt: TEST_NOW,
      },
    });
    expect(fallbackProvider.getCalls().health).toEqual([]);
    expect(fallbackProvider.getCalls().capabilities).toEqual([undefined]);
  });

  it("runs provider sync in dry-run mode without catalog or stock mutation", async () => {
    const contentRef = createTestContentRef();
    const sellable = createSellableDefinition();
    const stock = createStockRecord({
      sellableId: sellable.id,
      quantityOnHand: 4,
      quantityReserved: 1,
    });
    const repositories = createTestBackendRepositories({
      stockBySellableId: new Map([[sellable.id, stock]]),
    });
    const catalogPutCalls: unknown[] = [];
    const stockPutCalls: StockItemRecord[] = [];
    const catalogPut = repositories.catalog.put.bind(repositories.catalog);
    const stockPutItem = repositories.stock.putItem.bind(repositories.stock);
    repositories.catalog.put = async (document) => {
      catalogPutCalls.push(document);
      await catalogPut(document);
    };
    repositories.stock.putItem = async (record) => {
      stockPutCalls.push(record);
      await stockPutItem(record);
    };
    const fake = createFakeMikaProvider({
      optionalMethods: ["syncCatalog"],
    });
    const catalog = createCatalogItemDocument({ contentRef, sellables: [sellable] });
    await repositories.catalog.put(catalog);
    catalogPutCalls.length = 0;
    stockPutCalls.length = 0;
    const api = createMikaBackendApi(
      createIncrementingBackendDependencies({
        repositories,
        providers: createMikaProviderRegistry([fake.provider]),
      }),
    );

    await expect(api.admin.providerSync({ mode: "dry_run" })).resolves.toEqual({
      ok: true,
      status: 200,
      data: {
        id: "catalog_sync",
        status: "completed",
      },
    });

    expect(fake.getCalls().syncCatalog).toEqual([{ mode: "dry_run" }]);
    expect(catalogPutCalls).toEqual([]);
    expect(stockPutCalls).toEqual([]);
    await expect(repositories.catalog.findItemByContent(contentRef)).resolves.toEqual(catalog);
    await expect(repositories.stock.findBySellableId(sellable.id)).resolves.toEqual(stock);
    await expect(
      repositories.ops.findAdminAudit(createTestMikaId("admin_audit", 1)),
    ).resolves.toMatchObject({
      id: createTestMikaId("admin_audit", 1),
      type: "adminAudit",
      schemaVersion: 1,
      action: "provider.syncCatalog",
      status: "completed",
      createdAt: TEST_NOW,
      updatedAt: TEST_NOW,
      record: {
        id: createTestMikaId("admin_audit", 1),
        action: "provider.syncCatalog",
        status: "completed",
        createdAt: TEST_NOW,
        metadata: {
          provider: TEST_PROVIDER,
          mode: "dry_run",
        },
      },
    });
  });

  it("deduplicates provider sync by idempotency key", async () => {
    const fake = createFakeMikaProvider({
      optionalMethods: ["syncCatalog"],
    });
    const repositories = createTestBackendRepositories();
    const api = createMikaBackendApi(
      createIncrementingBackendDependencies({
        repositories,
        providers: createMikaProviderRegistry([fake.provider]),
      }),
    );
    const syncInput = {
      mode: "apply" as const,
      idempotencyKey: "provider_sync_idem_1",
    };

    const first = await api.admin.providerSync(syncInput);
    expect(first).toMatchObject({
      ok: true,
      status: 200,
      data: { id: "catalog_sync", status: "completed" },
    });

    const second = await api.admin.providerSync(syncInput);
    expect(second).toMatchObject({
      ok: true,
      status: 200,
      data: { id: "catalog_sync", status: "completed" },
    });

    expect(fake.getCalls().syncCatalog).toEqual([{ mode: "apply" }]);
    await expect(
      repositories.ops.findAdminAudit(createTestMikaId("admin_audit", 1)),
    ).resolves.toMatchObject({
      action: "provider.syncCatalog",
      status: "completed",
      record: {
        idempotencyKey: "provider_sync_idem_1",
        metadata: {
          provider: TEST_PROVIDER,
          mode: "apply",
        },
      },
    });
    await expect(
      repositories.ops.findAdminAudit(createTestMikaId("admin_audit", 2)),
    ).resolves.toBeNull();
  });

  it("passes entry-scoped provider sync input to adapters and audit metadata", async () => {
    const contentRef = createTestContentRef({ id: "ring" });
    const fake = createFakeMikaProvider({
      optionalMethods: ["syncCatalog"],
    });
    const repositories = createTestBackendRepositories();
    const api = createMikaBackendApi(
      createIncrementingBackendDependencies({
        repositories,
        providers: createMikaProviderRegistry([fake.provider]),
      }),
    );

    await expect(
      api.admin.providerSync({
        mode: "apply",
        scope: "entry",
        contentRef,
      }),
    ).resolves.toEqual({
      ok: true,
      status: 200,
      data: {
        id: "catalog_sync",
        status: "completed",
      },
    });

    expect(fake.getCalls().syncCatalog).toEqual([
      {
        mode: "apply",
        scope: "entry",
        contentRef,
      },
    ]);
    await expect(
      repositories.ops.findAdminAudit(createTestMikaId("admin_audit", 1)),
    ).resolves.toMatchObject({
      status: "completed",
      record: {
        action: "provider.syncCatalog",
        status: "completed",
        metadata: {
          provider: TEST_PROVIDER,
          mode: "apply",
          scope: "entry",
          contentRef,
        },
      },
    });
  });

  it("rejects entry-scoped provider sync without contentRef", async () => {
    const fake = createFakeMikaProvider({
      optionalMethods: ["syncCatalog"],
    });
    const api = createMikaBackendApi(
      createIncrementingBackendDependencies({
        providers: createMikaProviderRegistry([fake.provider]),
      }),
    );

    await expect(api.admin.providerSync({ scope: "entry" })).resolves.toEqual({
      ok: false,
      status: 422,
      error: {
        code: "VALIDATION_FAILED",
        message: "Mika input validation failed.",
        fieldErrors: {
          contentRef: "Entry-scoped provider sync requires contentRef.",
        },
      },
    });
    expect(fake.getCalls().syncCatalog).toEqual([]);
  });

  it("returns provider unsupported for missing provider health or sync support", async () => {
    const fake = createFakeMikaProvider({ optionalMethods: "none" });
    const api = createMikaBackendApi(
      createIncrementingBackendDependencies({
        providers: createMikaProviderRegistry([fake.provider]),
      }),
    );

    await expect(
      api.admin.providerHealth({ provider: createTestProviderName("missing") }),
    ).resolves.toEqual({
      ok: false,
      status: 409,
      error: {
        code: "PROVIDER_UNSUPPORTED",
        message: "Provider 'missing' is not configured.",
      },
    });

    await expect(api.admin.providerSync({ provider: fake.provider.id })).resolves.toEqual({
      ok: false,
      status: 409,
      error: {
        code: "PROVIDER_UNSUPPORTED",
        message: "Provider 'fake' does not support catalog sync.",
      },
    });
    expect(fake.getCalls().syncCatalog).toEqual([]);
    await expect(
      api.admin.providerSync({ provider: createTestProviderName("missing") }),
    ).resolves.toEqual({
      ok: false,
      status: 409,
      error: {
        code: "PROVIDER_UNSUPPORTED",
        message: "Provider 'missing' is not configured.",
      },
    });
    await expect(
      createMikaBackendApi(
        createIncrementingBackendDependencies({
          providers: createMikaProviderRegistry([]),
          defaults: {},
        }),
      ).admin.providerSync({}),
    ).resolves.toEqual({
      ok: false,
      status: 409,
      error: {
        code: "PROVIDER_UNSUPPORTED",
        message: "No provider is configured.",
      },
    });
  });

  it("normalizes provider health failures", async () => {
    const fake = createFakeMikaProvider({
      optionalMethods: ["health"],
      overrides: {
        health: async () => {
          throw new Error("Provider health failed.");
        },
      },
    });
    const api = createMikaBackendApi(
      createIncrementingBackendDependencies({
        providers: createMikaProviderRegistry([fake.provider]),
      }),
    );

    await expect(api.admin.providerHealth({})).resolves.toMatchObject({
      ok: false,
      status: 502,
      error: {
        code: "PROVIDER_FAILED",
        message: "Provider health failed.",
      },
    });
    expect(fake.getCalls().health).toEqual([undefined]);
  });

  it("normalizes provider sync failures and records failed audit state", async () => {
    const repositories = createTestBackendRepositories();
    const fake = createFakeMikaProvider({
      optionalMethods: ["syncCatalog"],
      overrides: {
        syncCatalog: async () => {
          throw new Error("Provider sync failed.");
        },
      },
    });
    const api = createMikaBackendApi(
      createIncrementingBackendDependencies({
        repositories,
        providers: createMikaProviderRegistry([fake.provider]),
      }),
    );

    expectMikaError(await api.admin.providerSync({ mode: "apply" }), {
      status: 502,
      code: "PROVIDER_FAILED",
      message: "Provider sync failed.",
    });

    expect(fake.getCalls().syncCatalog).toEqual([{ mode: "apply" }]);
    await expect(
      repositories.ops.findAdminAudit(createTestMikaId("admin_audit", 1)),
    ).resolves.toMatchObject({
      id: createTestMikaId("admin_audit", 1),
      type: "adminAudit",
      schemaVersion: 1,
      action: "provider.syncCatalog",
      status: "failed",
      createdAt: TEST_NOW,
      updatedAt: TEST_NOW,
      record: {
        id: createTestMikaId("admin_audit", 1),
        action: "provider.syncCatalog",
        status: "failed",
        createdAt: TEST_NOW,
        metadata: {
          provider: TEST_PROVIDER,
          mode: "apply",
          error: "Provider sync failed.",
        },
      },
    });
  });

  it("resolves order invoices from stored ledger URLs without provider calls", async () => {
    const repositories = createTestBackendRepositories();
    const fake = createFakeMikaProvider({
      capabilities: ["hosted_checkout", "invoice_url"],
      optionalMethods: ["getInvoiceUrl"],
    });
    const order = createOrderDocument();
    const api = createMikaBackendApi(
      createIncrementingBackendDependencies({
        repositories,
        providers: createMikaProviderRegistry([fake.provider]),
      }),
    );
    const ctx = createTestRequestContext();

    await repositories.account.put(createCustomerDocument());
    await repositories.ledger.put(order);

    await expect(api.order.invoice(ctx, { orderId: order.id })).resolves.toEqual({
      ok: true,
      status: 200,
      data: {
        orderId: order.id,
        href: "https://invoice.example.test/order_1",
      },
    });

    expect(fake.getCalls().getInvoiceUrl).toEqual([]);
  });

  it("resolves order invoices through provider adapters when no ledger URL exists", async () => {
    const repositories = createTestBackendRepositories();
    const fake = createFakeMikaProvider({
      capabilities: ["hosted_checkout", "invoice_url"],
      optionalMethods: ["getInvoiceUrl"],
    });
    const { invoiceUrl: _invoiceUrl, ...aggregateWithoutInvoiceUrl } =
      createOrderDocument().aggregate;
    const order = createOrderDocument({ aggregate: aggregateWithoutInvoiceUrl });
    const api = createMikaBackendApi(
      createIncrementingBackendDependencies({
        repositories,
        providers: createMikaProviderRegistry([fake.provider]),
      }),
    );
    const ctx = createTestRequestContext();

    await repositories.account.put(createCustomerDocument());
    await repositories.ledger.put(order);

    await expect(
      api.order.invoice(ctx, { orderId: order.id, returnTo: "/account/orders" }),
    ).resolves.toEqual({
      ok: true,
      status: 200,
      data: {
        orderId: order.id,
        href: "https://invoice.example.test/order/invoice_fake",
        expiresAt: createISODateTime("2026-01-01T01:00:00.000Z"),
      },
    });

    expect(fake.getCalls().getInvoiceUrl).toEqual([
      {
        orderId: order.id,
        providerPaymentId: "payment_1",
        providerOrderId: "provider_order_1",
      },
    ]);
  });

  it("normalizes order invoice provider failures", async () => {
    const repositories = createTestBackendRepositories();
    const fake = createFakeMikaProvider({
      capabilities: ["hosted_checkout", "invoice_url"],
      optionalMethods: ["getInvoiceUrl"],
      overrides: {
        getInvoiceUrl: async () => {
          throw new Error("Provider invoice failed.");
        },
      },
    });
    const { invoiceUrl: _invoiceUrl, ...aggregateWithoutInvoiceUrl } =
      createOrderDocument().aggregate;
    const order = createOrderDocument({ aggregate: aggregateWithoutInvoiceUrl });
    const api = createMikaBackendApi(
      createIncrementingBackendDependencies({
        repositories,
        providers: createMikaProviderRegistry([fake.provider]),
      }),
    );
    const ctx = createTestRequestContext();

    await repositories.account.put(createCustomerDocument());
    await repositories.ledger.put(order);

    await expect(api.order.invoice(ctx, { orderId: order.id })).resolves.toMatchObject({
      ok: false,
      status: 502,
      error: {
        code: "PROVIDER_FAILED",
        message: "Provider invoice lookup failed.",
      },
    });

    expect(fake.getCalls().getInvoiceUrl).toEqual([
      {
        orderId: order.id,
        providerPaymentId: "payment_1",
        providerOrderId: "provider_order_1",
      },
    ]);
  });

  it("rejects order invoice lookups for other customers before provider calls", async () => {
    const repositories = createTestBackendRepositories();
    const fake = createFakeMikaProvider({
      capabilities: ["hosted_checkout", "invoice_url"],
      optionalMethods: ["getInvoiceUrl"],
    });
    const order = createOrderDocument();
    const api = createMikaBackendApi(
      createIncrementingBackendDependencies({
        repositories,
        providers: createMikaProviderRegistry([fake.provider]),
      }),
    );
    const otherCustomerId = createTestMikaId("customer", 2);
    const otherCtx = createTestRequestContext({ customerId: otherCustomerId, userId: "user_2" });

    await repositories.account.put(
      createCustomerDocument({
        customerId: otherCustomerId,
        userId: "user_2",
        aggregate: {
          ...createCustomerDocument().aggregate,
          email: "Other@Example.test",
        },
      }),
    );
    await repositories.ledger.put(order);

    await expect(api.order.invoice(otherCtx, { orderId: order.id })).resolves.toMatchObject({
      ok: false,
      status: 403,
      error: { code: "FORBIDDEN" },
    });
    expect(fake.getCalls().getInvoiceUrl).toEqual([]);
  });

  it("allows order invoice tokens minted through account projections", async () => {
    const repositories = createTestBackendRepositories();
    const fake = createFakeMikaProvider({
      capabilities: ["hosted_checkout", "invoice_url"],
      optionalMethods: ["getInvoiceUrl"],
    });
    const order = createOrderDocument();
    const api = createMikaBackendApi(
      createIncrementingBackendDependencies({
        repositories,
        providers: createMikaProviderRegistry([fake.provider]),
      }),
    );
    const ownerCtx = createTestRequestContext();
    const anonymousCtx = createTestRequestContext({
      sessionId: false,
      customerId: false,
      userId: false,
    });

    await repositories.account.put(createCustomerDocument());
    await repositories.ledger.put(order);
    const account = await api.account.get(ownerCtx);
    if (!account.ok) throw new Error("Expected account.get to succeed.");
    const invoiceHref = account.data.orders[0]?.invoiceHref;
    if (!invoiceHref) throw new Error("Expected invoiceHref.");
    const token = new URL(invoiceHref, "https://shop.example.test").searchParams.get("token");
    if (!token) throw new Error("Expected invoice token.");

    await expect(
      api.order.invoice(anonymousCtx, { orderId: order.id, token }),
    ).resolves.toMatchObject({
      ok: true,
      status: 200,
      data: {
        orderId: order.id,
        href: "https://invoice.example.test/order_1",
      },
    });
  });

  it("binds guest order invoice tokens to the email-hash subject and revokes them after account delete", async () => {
    const repositories = createTestBackendRepositories();
    const fake = createFakeMikaProvider({
      capabilities: ["hosted_checkout", "invoice_url"],
      optionalMethods: ["getInvoiceUrl"],
    });
    const emailHash = createTestHash("email:guest@example.test");
    const baseOrder = createOrderDocument();
    const order = createOrderDocument({
      customerId: undefined,
      emailHash,
      aggregate: {
        ...baseOrder.aggregate,
        customer: {
          email: "guest@example.test",
          emailHash,
        },
      },
    });
    const api = createMikaBackendApi(
      createIncrementingBackendDependencies({
        repositories,
        providers: createMikaProviderRegistry([fake.provider]),
      }),
    );
    const ctx = createTestRequestContext({
      sessionId: "session_guest_invoice",
      customerId: false,
      userId: false,
    });
    await ctx.session?.set("mika.emailHash", emailHash);
    const anonymousCtx = createTestRequestContext({
      sessionId: false,
      customerId: false,
      userId: false,
    });

    await repositories.ledger.put(order);
    const account = await api.account.get(ctx);
    if (!account.ok) throw new Error("Expected account.get to succeed.");
    const invoiceHref = account.data.orders[0]?.invoiceHref;
    if (!invoiceHref) throw new Error("Expected invoiceHref.");
    const token = new URL(invoiceHref, "https://shop.example.test").searchParams.get("token");
    if (!token) throw new Error("Expected invoice token.");

    await expect(
      api.order.invoice(anonymousCtx, { orderId: order.id, token }),
    ).resolves.toMatchObject({
      ok: true,
      status: 200,
      data: { href: "https://invoice.example.test/order_1" },
    });

    await repositories.ledger.put({
      ...order,
      emailHash: "account-deleted:guest",
      aggregate: {
        ...order.aggregate,
        customer: {
          ...order.aggregate.customer,
          emailHash: "account-deleted:guest",
        },
      },
    });

    await expect(
      api.order.invoice(anonymousCtx, { orderId: order.id, token }),
    ).resolves.toMatchObject({
      ok: false,
      status: 410,
      error: { code: "DOWNLOAD_REVOKED" },
    });
  });

  it("returns stable errors for missing orders without provider calls", async () => {
    const repositories = createTestBackendRepositories();
    const fake = createFakeMikaProvider({
      optionalMethods: ["getInvoiceUrl", "refundPayment", "cancelOrder"],
    });
    const api = createMikaBackendApi(
      createIncrementingBackendDependencies({
        repositories,
        providers: createMikaProviderRegistry([fake.provider]),
      }),
    );

    await expect(
      api.admin.orderRefund({ orderId: createTestMikaId("order", 404) }),
    ).resolves.toMatchObject({
      ok: false,
      status: 404,
      error: {
        code: "NOT_FOUND",
        fieldErrors: { orderId: "Order was not found." },
      },
    });
    await expect(
      api.admin.orderCancel({ orderId: createTestMikaId("order", 404) }),
    ).resolves.toMatchObject({
      ok: false,
      status: 404,
      error: {
        code: "NOT_FOUND",
        fieldErrors: { orderId: "Order was not found." },
      },
    });
    await expect(
      api.order.invoice(createTestRequestContext(), { orderId: createTestMikaId("order", 404) }),
    ).resolves.toMatchObject({
      ok: false,
      status: 404,
      error: {
        code: "NOT_FOUND",
        fieldErrors: { orderId: "Order was not found." },
      },
    });

    expect(fake.getCalls().getInvoiceUrl).toEqual([]);
    expect(fake.getCalls().refundPayment).toEqual([]);
    expect(fake.getCalls().cancelOrder).toEqual([]);
    await expect(
      repositories.ops.findAdminAudit(createTestMikaId("admin_audit", 1)),
    ).resolves.toBeNull();
  });

  it("returns provider unsupported for order actions without mutating the order", async () => {
    const repositories = createTestBackendRepositories();
    const fake = createFakeMikaProvider({ optionalMethods: "none" });
    const order = createOrderDocument();
    const api = createMikaBackendApi(
      createIncrementingBackendDependencies({
        repositories,
        providers: createMikaProviderRegistry([fake.provider]),
      }),
    );

    await repositories.ledger.put(order);

    await expect(api.admin.orderRefund({ orderId: order.id, amount: 500 })).resolves.toMatchObject({
      ok: false,
      status: 409,
      error: { code: "PROVIDER_UNSUPPORTED" },
    });
    await expect(api.admin.orderCancel({ orderId: order.id })).resolves.toMatchObject({
      ok: false,
      status: 409,
      error: { code: "PROVIDER_UNSUPPORTED" },
    });

    expect(fake.getCalls().refundPayment).toEqual([]);
    expect(fake.getCalls().cancelOrder).toEqual([]);
    await expect(repositories.ledger.findOrderById(order.id)).resolves.toEqual(order);
    await expect(
      repositories.ops.findAdminAudit(createTestMikaId("admin_audit", 1)),
    ).resolves.toBeNull();
  });

  it("normalizes order provider failures and records failed audit state", async () => {
    const repositories = createTestBackendRepositories();
    const fake = createFakeMikaProvider({
      optionalMethods: ["refundPayment"],
      overrides: {
        refundPayment: async () => {
          throw new Error("Provider refund failed.");
        },
      },
    });
    const order = createOrderDocument();
    const api = createMikaBackendApi(
      createIncrementingBackendDependencies({
        repositories,
        providers: createMikaProviderRegistry([fake.provider]),
      }),
    );

    await repositories.ledger.put(order);

    await expect(
      api.admin.orderRefund({ orderId: order.id, amount: 500, reason: "customer_request" }),
    ).resolves.toMatchObject({
      ok: false,
      status: 502,
      error: {
        code: "PROVIDER_FAILED",
        message: "Provider refund failed.",
      },
    });

    expect(fake.getCalls().refundPayment).toEqual([
      {
        orderId: order.id,
        providerPaymentId: "payment_1",
        amount: 500,
        reason: "customer_request",
      },
    ]);
    await expect(repositories.ledger.findOrderById(order.id)).resolves.toEqual(order);
    await expect(
      repositories.ops.findAdminAudit(createTestMikaId("admin_audit", 1)),
    ).resolves.toMatchObject({
      status: "failed",
      record: {
        action: "order.refund",
        targetType: "order",
        targetId: order.id,
        status: "failed",
        metadata: {
          provider: TEST_PROVIDER,
          orderId: order.id,
          providerPaymentId: "payment_1",
          amount: 500,
          reason: "customer_request",
          error: "Provider refund failed.",
        },
      },
    });
  });

  it("normalizes order cancellation provider failures and records failed audit state", async () => {
    const repositories = createTestBackendRepositories();
    const fake = createFakeMikaProvider({
      optionalMethods: ["cancelOrder"],
      overrides: {
        cancelOrder: async () => {
          throw new Error("Provider cancel order failed.");
        },
      },
    });
    const order = createOrderDocument();
    const api = createMikaBackendApi(
      createIncrementingBackendDependencies({
        repositories,
        providers: createMikaProviderRegistry([fake.provider]),
      }),
    );

    await repositories.ledger.put(order);

    await expect(
      api.admin.orderCancel({ orderId: order.id, reason: "customer_request" }),
    ).resolves.toMatchObject({
      ok: false,
      status: 502,
      error: {
        code: "PROVIDER_FAILED",
        message: "Provider cancel order failed.",
      },
    });

    expect(fake.getCalls().cancelOrder).toEqual([
      {
        orderId: order.id,
        providerPaymentId: "payment_1",
        providerOrderId: "provider_order_1",
        reason: "customer_request",
      },
    ]);
    await expect(repositories.ledger.findOrderById(order.id)).resolves.toEqual(order);
    await expect(
      repositories.ops.findAdminAudit(createTestMikaId("admin_audit", 1)),
    ).resolves.toMatchObject({
      status: "failed",
      record: {
        action: "order.cancel",
        targetType: "order",
        targetId: order.id,
        status: "failed",
        metadata: {
          provider: TEST_PROVIDER,
          orderId: order.id,
          providerPaymentId: "payment_1",
          providerOrderId: "provider_order_1",
          reason: "customer_request",
          error: "Provider cancel order failed.",
        },
      },
    });
  });

  it("runs order refund and cancel actions and updates ledger audit state", async () => {
    const repositories = createTestBackendRepositories();
    const fake = createFakeMikaProvider({
      optionalMethods: ["refundPayment", "cancelOrder"],
    });
    const refundOrder = createOrderDocument();
    const cancelTarget = createOrderDocument({
      id: createTestMikaId("order", 2),
      orderNumber: "M-1002",
      providerPaymentId: "payment_cancel",
      providerOrderId: "provider_order_cancel",
    });
    const api = createMikaBackendApi(
      createIncrementingBackendDependencies({
        repositories,
        providers: createMikaProviderRegistry([fake.provider]),
      }),
    );

    await repositories.ledger.put(refundOrder);
    await repositories.ledger.put(cancelTarget);

    await expect(
      api.admin.orderRefund({ orderId: refundOrder.id, amount: 500, reason: "duplicate" }),
    ).resolves.toMatchObject({
      ok: true,
      status: 200,
      data: {
        status: "completed",
      },
    });
    await expect(
      api.admin.orderCancel({ orderId: cancelTarget.id, reason: "customer_request" }),
    ).resolves.toMatchObject({
      ok: true,
      status: 200,
      data: {
        status: "completed",
      },
    });

    expect(fake.getCalls().refundPayment).toEqual([
      {
        orderId: refundOrder.id,
        providerPaymentId: "payment_1",
        amount: 500,
        reason: "duplicate",
      },
    ]);
    expect(fake.getCalls().cancelOrder).toEqual([
      {
        orderId: cancelTarget.id,
        providerPaymentId: "payment_cancel",
        providerOrderId: "provider_order_cancel",
        reason: "customer_request",
      },
    ]);
    await expect(repositories.ledger.findOrderById(refundOrder.id)).resolves.toMatchObject({
      status: "partially_refunded",
      paymentStatus: "partially_refunded",
      aggregate: {
        metadata: {
          lastAdminAction: "order.refund",
          refundAmount: 500,
          refundReason: "duplicate",
        },
      },
    });
    await expect(repositories.ledger.findOrderById(cancelTarget.id)).resolves.toMatchObject({
      status: "cancelled",
      paymentStatus: "paid",
      aggregate: {
        metadata: {
          lastAdminAction: "order.cancel",
          cancelReason: "customer_request",
        },
      },
    });
    await expect(
      repositories.ops.findAdminAudit(createTestMikaId("admin_audit", 1)),
    ).resolves.toMatchObject({
      status: "completed",
      record: {
        action: "order.refund",
        status: "completed",
        metadata: {
          provider: TEST_PROVIDER,
          orderId: refundOrder.id,
          providerPaymentId: "payment_1",
          amount: 500,
          reason: "duplicate",
        },
      },
    });
    await expect(
      repositories.ops.findAdminAudit(createTestMikaId("admin_audit", 2)),
    ).resolves.toMatchObject({
      status: "completed",
      record: {
        action: "order.cancel",
        status: "completed",
        metadata: {
          provider: TEST_PROVIDER,
          orderId: cancelTarget.id,
          providerPaymentId: "payment_cancel",
          providerOrderId: "provider_order_cancel",
          reason: "customer_request",
        },
      },
    });
  });

  it("forwards the admin idempotency key to the provider refund call", async () => {
    const repositories = createTestBackendRepositories();
    const fake = createFakeMikaProvider({ optionalMethods: ["refundPayment"] });
    const order = createOrderDocument();
    const api = createMikaBackendApi(
      createIncrementingBackendDependencies({
        repositories,
        providers: createMikaProviderRegistry([fake.provider]),
      }),
    );
    await repositories.ledger.put(order);

    await expect(
      api.admin.orderRefund({
        orderId: order.id,
        amount: 500,
        reason: "duplicate",
        idempotencyKey: "refund-1",
      }),
    ).resolves.toMatchObject({ ok: true, status: 200, data: { status: "completed" } });

    expect(fake.getCalls().refundPayment).toEqual([
      {
        orderId: order.id,
        providerPaymentId: "payment_1",
        amount: 500,
        reason: "duplicate",
        idempotencyKey: "refund-1",
      },
    ]);
  });

  it("retries a refund with the same provider idempotency key after a ledger persistence failure", async () => {
    const repositories = createTestBackendRepositories();
    const ledgerPut = repositories.ledger.put.bind(repositories.ledger);
    let failNextOrderPut = false;
    repositories.ledger.put = async (document) => {
      if (failNextOrderPut) {
        failNextOrderPut = false;
        throw new Error("ledger storage error");
      }
      await ledgerPut(document);
    };
    const fake = createFakeMikaProvider({ optionalMethods: ["refundPayment"] });
    const order = createOrderDocument();
    const api = createMikaBackendApi(
      createIncrementingBackendDependencies({
        repositories,
        providers: createMikaProviderRegistry([fake.provider]),
      }),
    );
    await repositories.ledger.put(order);

    failNextOrderPut = true;
    const first = await api.admin.orderRefund({
      orderId: order.id,
      amount: 500,
      reason: "duplicate",
      idempotencyKey: "refund_retry_1",
    });
    expect(first.ok).toBe(false);

    const second = await api.admin.orderRefund({
      orderId: order.id,
      amount: 500,
      reason: "duplicate",
      idempotencyKey: "refund_retry_1",
    });
    expect(second).toMatchObject({ ok: true, status: 200, data: { status: "completed" } });

    expect(fake.getCalls().refundPayment).toEqual([
      {
        orderId: order.id,
        providerPaymentId: "payment_1",
        amount: 500,
        reason: "duplicate",
        idempotencyKey: "refund_retry_1",
      },
      {
        orderId: order.id,
        providerPaymentId: "payment_1",
        amount: 500,
        reason: "duplicate",
        idempotencyKey: "refund_retry_1",
      },
    ]);
  });

  it("cumulates successive partial refunds and reaches refunded when the total is covered", async () => {
    const repositories = createTestBackendRepositories();
    const fake = createFakeMikaProvider({ optionalMethods: ["refundPayment"] });
    const order = createOrderDocument();
    const api = createMikaBackendApi(
      createIncrementingBackendDependencies({
        repositories,
        providers: createMikaProviderRegistry([fake.provider]),
      }),
    );
    await repositories.ledger.put(order);

    await expect(api.admin.orderRefund({ orderId: order.id, amount: 700 })).resolves.toMatchObject({
      ok: true,
    });
    await expect(repositories.ledger.findOrderById(order.id)).resolves.toMatchObject({
      status: "partially_refunded",
      aggregate: { metadata: { refundAmount: 700 } },
    });

    await expect(api.admin.orderRefund({ orderId: order.id, amount: 500 })).resolves.toMatchObject({
      ok: true,
    });
    await expect(repositories.ledger.findOrderById(order.id)).resolves.toMatchObject({
      status: "refunded",
      paymentStatus: "refunded",
      aggregate: { metadata: { refundAmount: 1200 } },
    });
  });

  it("rejects refund amounts above the remaining refundable order total before provider calls", async () => {
    const repositories = createTestBackendRepositories();
    const fake = createFakeMikaProvider({ optionalMethods: ["refundPayment"] });
    const order = createOrderDocument({
      status: "partially_refunded",
      paymentStatus: "partially_refunded",
      aggregate: {
        ...createOrderDocument().aggregate,
        metadata: { refundAmount: 700 },
      },
    });
    const api = createMikaBackendApi(
      createIncrementingBackendDependencies({
        repositories,
        providers: createMikaProviderRegistry([fake.provider]),
      }),
    );
    await repositories.ledger.put(order);

    await expect(api.admin.orderRefund({ orderId: order.id, amount: 600 })).resolves.toMatchObject({
      ok: false,
      status: 422,
      error: {
        code: "VALIDATION_FAILED",
        fieldErrors: {
          amount: `Refund amount exceeds the remaining refundable amount for order '${order.id}'.`,
        },
      },
    });

    expect(fake.getCalls().refundPayment).toEqual([]);
    await expect(repositories.ledger.findOrderById(order.id)).resolves.toEqual(order);
  });

  function createFulfilledRefundOrder(): {
    order: OrderDocument;
    entitlement: EntitlementDocument;
    license: LicenseDocument;
  } {
    const base = createOrderDocument();
    const order: OrderDocument = {
      ...base,
      aggregate: {
        ...base.aggregate,
        lines: [
          {
            id: createTestMikaId("order_line", 1),
            item: createPurchasableSnapshot({ fulfillmentKind: "entitlement" }),
            quantity: 1,
            subtotalAmount: 600,
            totalAmount: 600,
            entitlementId: createMikaId("entitlement_order_1_order_line_1"),
          },
          {
            id: createTestMikaId("order_line", 2),
            item: createPurchasableSnapshot({
              fulfillmentKind: "license",
              sellableId: createTestMikaId("sellable", 2),
            }),
            quantity: 1,
            subtotalAmount: 600,
            totalAmount: 600,
            licenseKeySuffix: "ABC123",
          },
        ],
      },
    };
    const entitlement = createEntitlementDocument({
      id: createMikaId("entitlement_order_1_order_line_1"),
    });
    const license = createLicenseDocument({
      id: createMikaId("license_order_1_order_line_2"),
      orderLineId: createTestMikaId("order_line", 2),
    });
    return { order, entitlement, license };
  }

  it("revokes order-line entitlements and licenses when an order is fully refunded", async () => {
    const repositories = createTestBackendRepositories();
    const fake = createFakeMikaProvider({ optionalMethods: ["refundPayment"] });
    const { order, entitlement, license } = createFulfilledRefundOrder();
    const api = createMikaBackendApi(
      createIncrementingBackendDependencies({
        repositories,
        providers: createMikaProviderRegistry([fake.provider]),
      }),
    );

    await repositories.ledger.put(order);
    await repositories.account.put(entitlement);
    await repositories.account.put(license);

    await expect(api.admin.orderRefund({ orderId: order.id })).resolves.toMatchObject({
      ok: true,
      status: 200,
      data: { status: "completed" },
    });

    await expect(repositories.ledger.findOrderById(order.id)).resolves.toMatchObject({
      status: "refunded",
      paymentStatus: "refunded",
    });
    await expect(
      repositories.account.findEntitlementById(createMikaId("entitlement_order_1_order_line_1")),
    ).resolves.toMatchObject({
      status: "revoked",
      record: {
        status: "revoked",
        revokedAt: TEST_NOW,
        metadata: { revokeReason: "order_refunded" },
      },
    });
    await expect(
      repositories.account.findLicenseById(createMikaId("license_order_1_order_line_2")),
    ).resolves.toMatchObject({
      status: "revoked",
      record: {
        status: "revoked",
        revokedAt: TEST_NOW,
        metadata: { revokeReason: "order_refunded" },
      },
    });
  });

  it("leaves order-line entitlements and licenses active on a partial refund", async () => {
    const repositories = createTestBackendRepositories();
    const fake = createFakeMikaProvider({ optionalMethods: ["refundPayment"] });
    const { order, entitlement, license } = createFulfilledRefundOrder();
    const api = createMikaBackendApi(
      createIncrementingBackendDependencies({
        repositories,
        providers: createMikaProviderRegistry([fake.provider]),
      }),
    );

    await repositories.ledger.put(order);
    await repositories.account.put(entitlement);
    await repositories.account.put(license);

    await expect(api.admin.orderRefund({ orderId: order.id, amount: 500 })).resolves.toMatchObject({
      ok: true,
      data: { status: "completed" },
    });

    await expect(repositories.ledger.findOrderById(order.id)).resolves.toMatchObject({
      status: "partially_refunded",
    });
    await expect(
      repositories.account.findEntitlementById(createMikaId("entitlement_order_1_order_line_1")),
    ).resolves.toMatchObject({ status: "active", record: { status: "active" } });
    await expect(
      repositories.account.findLicenseById(createMikaId("license_order_1_order_line_2")),
    ).resolves.toMatchObject({ status: "active", record: { status: "active" } });
  });

  it("revokes order-line entitlements and licenses when an order is cancelled", async () => {
    const repositories = createTestBackendRepositories();
    const fake = createFakeMikaProvider({ optionalMethods: ["cancelOrder"] });
    const { order, entitlement, license } = createFulfilledRefundOrder();
    const api = createMikaBackendApi(
      createIncrementingBackendDependencies({
        repositories,
        providers: createMikaProviderRegistry([fake.provider]),
      }),
    );

    await repositories.ledger.put(order);
    await repositories.account.put(entitlement);
    await repositories.account.put(license);

    await expect(api.admin.orderCancel({ orderId: order.id })).resolves.toMatchObject({
      ok: true,
      status: 200,
      data: { status: "completed" },
    });

    await expect(
      repositories.account.findEntitlementById(createMikaId("entitlement_order_1_order_line_1")),
    ).resolves.toMatchObject({
      status: "revoked",
      record: { status: "revoked", metadata: { revokeReason: "order_cancelled" } },
    });
    await expect(
      repositories.account.findLicenseById(createMikaId("license_order_1_order_line_2")),
    ).resolves.toMatchObject({
      status: "revoked",
      record: { status: "revoked", metadata: { revokeReason: "order_cancelled" } },
    });
  });

  it("expires checkout reservations from a provider checkout.session.expired webhook", async () => {
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
      id: TEST_PROVIDER,
      overrides: {
        verifyWebhook: async (webhookInput) =>
          createVerifiedWebhookPayload(webhookInput, {
            payloadHash: "checkout_session_expired_hash",
            parsed: { delivery: "event_checkout_session_expired" },
          }),
        parseWebhookEvent: async (verified) =>
          createPaymentWebhookEvent(verified, {
            providerEventId: "event_checkout_session_expired",
            type: "checkout.session.expired",
            providerCheckoutId: "provider_checkout_fake",
            paymentStatus: "failed",
            customer: { email: "Expired@Example.test" },
          }),
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
    const ctx = createTestRequestContext();

    const cart = await api.cart.add(ctx, { sellableId: sellable.id, quantity: 2 });
    if (!cart.ok) throw new Error("Expected cart.add to succeed.");
    const checkout = await api.checkout.start(ctx, { cartId: cart.data.id });
    if (!checkout.ok) throw new Error("Expected checkout.start to succeed.");
    await expect(repositories.stock.findBySellableId(sellable.id)).resolves.toMatchObject({
      quantityReserved: 2,
    });

    await expect(receiveWebhook(api, "checkout-session-expired")).resolves.toMatchObject({
      ok: true,
      status: 200,
    });

    await expect(repositories.session.findCheckoutById(checkout.data.id)).resolves.toMatchObject({
      status: "expired",
      providerStatus: "expired",
      customerId: "customer_1",
    });
    await expect(
      repositories.stock.findEventById(createTestMikaId("stock_event", 1)),
    ).resolves.toMatchObject({
      status: "expired",
    });
    await expect(repositories.stock.findBySellableId(sellable.id)).resolves.toMatchObject({
      quantityReserved: 0,
    });
    await expect(
      repositories.ops.findWebhookById(createTestMikaId("webhook", 1)),
    ).resolves.toMatchObject({
      status: "processed",
      record: {
        providerEventId: "event_checkout_session_expired",
        relatedCustomerId: "customer_1",
      },
    });
  });

  it("uses checkout-start customer details for delegated payment webhooks without customer email", async () => {
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
      id: TEST_PROVIDER,
      overrides: {
        createCheckoutSession: async (input) => ({
          id: createMikaId("pi_delegated_customer"),
          status: "completed",
          mode: input.mode,
          provider: input.provider,
          providerCheckoutId: "pi_delegated_customer",
        }),
        verifyWebhook: async (webhookInput) =>
          createVerifiedWebhookPayload(webhookInput, {
            payloadHash: "delegated_customer_paid_hash",
            parsed: { delivery: "event_delegated_customer_paid" },
          }),
        parseWebhookEvent: async (verified) =>
          createPaymentWebhookEvent(verified, {
            providerEventId: "event_delegated_customer_paid",
            type: "payment_intent.succeeded",
            providerCheckoutId: "pi_delegated_customer",
            providerPaymentId: "pi_delegated_customer",
            providerOrderId: "pi_delegated_customer",
            paymentStatus: "paid",
          }),
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

    const cart = await api.cart.add(ctx, { sellableId: sellable.id, quantity: 1 });
    if (!cart.ok) throw new Error("Expected cart.add to succeed.");
    const checkout = await api.checkout.start(ctx, {
      cartId: cart.data.id,
      customer: { email: "Ada@Example.test", name: "Ada Buyer" },
    });
    if (!checkout.ok) throw new Error("Expected checkout.start to succeed.");
    await expect(repositories.session.findCheckoutById(checkout.data.id)).resolves.toMatchObject({
      aggregate: {
        metadata: {
          checkoutCustomerEmail: "Ada@Example.test",
          checkoutCustomerName: "Ada Buyer",
        },
      },
    });

    await expect(receiveWebhook(api, "delegated-customer-paid")).resolves.toMatchObject({
      ok: true,
      status: 200,
    });

    await expect(
      repositories.ledger.findOrderByProviderPayment(TEST_PROVIDER, "pi_delegated_customer"),
    ).resolves.toMatchObject({
      emailHash: createTestHash("email:ada@example.test"),
      aggregate: {
        customer: {
          email: "Ada@Example.test",
          emailHash: createTestHash("email:ada@example.test"),
          name: "Ada Buyer",
        },
      },
    });
  });

  it("downgrades a paid order to refunded and revokes access on a provider refund/chargeback webhook", async () => {
    const repositories = createTestBackendRepositories();
    const { order, entitlement, license } = createFulfilledRefundOrder();
    const fake = createFakeMikaProvider({
      id: TEST_PROVIDER,
      overrides: {
        verifyWebhook: async (webhookInput) =>
          createVerifiedWebhookPayload(webhookInput, {
            payloadHash: "charge_refunded_hash",
            parsed: { delivery: "event_charge_refunded" },
          }),
        parseWebhookEvent: async (verified) =>
          createPaymentWebhookEvent(verified, {
            providerEventId: "event_charge_refunded",
            type: "charge.refunded",
            providerPaymentId: "payment_1",
            providerOrderId: "provider_order_1",
            paymentStatus: "refunded",
          }),
      },
    });
    const api = createMikaBackendApi(
      createIncrementingBackendDependencies({
        repositories,
        providers: createMikaProviderRegistry([fake.provider]),
      }),
    );

    await repositories.ledger.put(order);
    await repositories.account.put(entitlement);
    await repositories.account.put(license);

    await expect(receiveWebhook(api, "charge-refunded")).resolves.toMatchObject({
      ok: true,
      status: 200,
    });

    await expect(repositories.ledger.findOrderById(order.id)).resolves.toMatchObject({
      status: "refunded",
      paymentStatus: "refunded",
    });
    await expect(
      repositories.account.findEntitlementById(createMikaId("entitlement_order_1_order_line_1")),
    ).resolves.toMatchObject({
      status: "revoked",
      record: { status: "revoked", metadata: { revokeReason: "order_refunded" } },
    });
    await expect(
      repositories.account.findLicenseById(createMikaId("license_order_1_order_line_2")),
    ).resolves.toMatchObject({ status: "revoked", record: { status: "revoked" } });
  });

  it("finishes revocation when a provider refund webhook is redelivered after a revoke failure", async () => {
    const repositories = createTestBackendRepositories();
    const { order, entitlement, license } = createFulfilledRefundOrder();
    const baseAccountPut = repositories.account.put.bind(repositories.account);
    let revokeFailures = 0;
    repositories.account.put = async (document) => {
      if (
        document.type === "entitlement" &&
        document.status === "revoked" &&
        revokeFailures === 0
      ) {
        revokeFailures += 1;
        throw new Error("Simulated entitlement revocation failure.");
      }
      return baseAccountPut(document);
    };
    const fake = createFakeMikaProvider({
      id: TEST_PROVIDER,
      overrides: {
        verifyWebhook: async (webhookInput) =>
          createVerifiedWebhookPayload(webhookInput, {
            payloadHash: "charge_refunded_revoke_retry_hash",
            parsed: { delivery: "event_charge_refunded_revoke_retry" },
          }),
        parseWebhookEvent: async (verified) =>
          createPaymentWebhookEvent(verified, {
            providerEventId: "event_charge_refunded_revoke_retry",
            type: "charge.refunded",
            providerPaymentId: "payment_1",
            providerOrderId: "provider_order_1",
            paymentStatus: "refunded",
          }),
      },
    });
    const api = createMikaBackendApi(
      createIncrementingBackendDependencies({
        repositories,
        providers: createMikaProviderRegistry([fake.provider]),
      }),
    );

    await repositories.ledger.put(order);
    await repositories.account.put(entitlement);
    await repositories.account.put(license);

    await receiveWebhook(api, "charge-refunded-revoke-fails").catch(() => undefined);
    expect(revokeFailures).toBe(1);
    await expect(repositories.ledger.findOrderById(order.id)).resolves.toMatchObject({
      status: "refunded",
      paymentStatus: "refunded",
    });
    await expect(
      repositories.account.findEntitlementById(createMikaId("entitlement_order_1_order_line_1")),
    ).resolves.toMatchObject({ status: "active" });

    await expect(receiveWebhook(api, "charge-refunded-redelivery")).resolves.toMatchObject({
      ok: true,
      status: 200,
    });
    await expect(
      repositories.account.findEntitlementById(createMikaId("entitlement_order_1_order_line_1")),
    ).resolves.toMatchObject({
      status: "revoked",
      record: { status: "revoked", metadata: { revokeReason: "order_refunded" } },
    });
    await expect(
      repositories.account.findLicenseById(createMikaId("license_order_1_order_line_2")),
    ).resolves.toMatchObject({ status: "revoked", record: { status: "revoked" } });
  });

  it("partially refunds an order and retains access on a partial provider refund webhook", async () => {
    const repositories = createTestBackendRepositories();
    const { order, entitlement, license } = createFulfilledRefundOrder();
    const fake = createFakeMikaProvider({
      id: TEST_PROVIDER,
      overrides: {
        verifyWebhook: async (webhookInput) =>
          createVerifiedWebhookPayload(webhookInput, {
            payloadHash: "charge_partial_refund_hash",
            parsed: { delivery: "event_charge_partial_refund" },
          }),
        parseWebhookEvent: async (verified) => ({
          ...createPaymentWebhookEvent(verified, {
            providerEventId: "event_charge_partial_refund",
            type: "charge.refunded",
            providerPaymentId: "payment_1",
            providerOrderId: "provider_order_1",
            paymentStatus: "partially_refunded",
          }),
          totals: { total: { amount: 500, currency: TEST_CURRENCY } },
        }),
      },
    });
    const api = createMikaBackendApi(
      createIncrementingBackendDependencies({
        repositories,
        providers: createMikaProviderRegistry([fake.provider]),
      }),
    );

    await repositories.ledger.put(order);
    await repositories.account.put(entitlement);
    await repositories.account.put(license);

    await expect(receiveWebhook(api, "charge-partial-refund")).resolves.toMatchObject({
      ok: true,
      status: 200,
    });

    await expect(repositories.ledger.findOrderById(order.id)).resolves.toMatchObject({
      status: "partially_refunded",
      paymentStatus: "partially_refunded",
      aggregate: { metadata: { refundAmount: 500 } },
    });
    await expect(
      repositories.account.findEntitlementById(createMikaId("entitlement_order_1_order_line_1")),
    ).resolves.toMatchObject({ status: "active", record: { status: "active" } });
    await expect(
      repositories.account.findLicenseById(createMikaId("license_order_1_order_line_2")),
    ).resolves.toMatchObject({ status: "active", record: { status: "active" } });
  });

  it("fails partial refund webhooks that omit cumulative refund totals", async () => {
    const repositories = createTestBackendRepositories();
    const { order, entitlement, license } = createFulfilledRefundOrder();
    const fake = createFakeMikaProvider({
      id: TEST_PROVIDER,
      overrides: {
        verifyWebhook: async (webhookInput) =>
          createVerifiedWebhookPayload(webhookInput, {
            payloadHash: "charge_partial_refund_missing_totals_hash",
            parsed: { delivery: "event_charge_partial_refund_missing_totals" },
          }),
        parseWebhookEvent: async (verified) =>
          createPaymentWebhookEvent(verified, {
            providerEventId: "event_charge_partial_refund_missing_totals",
            type: "charge.refunded",
            providerPaymentId: "payment_1",
            providerOrderId: "provider_order_1",
            paymentStatus: "partially_refunded",
          }),
      },
    });
    const api = createMikaBackendApi(
      createIncrementingBackendDependencies({
        repositories,
        providers: createMikaProviderRegistry([fake.provider]),
      }),
    );

    await repositories.ledger.put(order);
    await repositories.account.put(entitlement);
    await repositories.account.put(license);

    await expect(
      receiveWebhook(api, "charge-partial-refund-missing-totals"),
    ).resolves.toMatchObject({
      ok: false,
      status: 502,
      error: {
        code: "PROVIDER_FAILED",
        message: "Partial refund webhook is missing cumulative refund totals.",
      },
    });

    await expect(repositories.ledger.findOrderById(order.id)).resolves.toMatchObject({
      status: "paid",
      paymentStatus: "paid",
    });
    await expect(
      repositories.account.findEntitlementById(createMikaId("entitlement_order_1_order_line_1")),
    ).resolves.toMatchObject({ status: "active" });
    await expect(
      repositories.ops.findWebhookById(createTestMikaId("webhook", 1)),
    ).resolves.toMatchObject({
      status: "failed",
      record: { lastError: "Partial refund webhook is missing cumulative refund totals." },
    });
  });

  it("allows download tokens after a partial refund while fulfillment access remains active", async () => {
    const repositories = createTestBackendRepositories();
    const base = createOrderDocument();
    const line = base.aggregate.lines[0]!;
    const order = createOrderDocument({
      status: "partially_refunded",
      paymentStatus: "partially_refunded",
      aggregate: {
        ...base.aggregate,
        metadata: { refundAmount: 300 },
        lines: [
          {
            ...line,
            entitlementId: createTestMikaId("entitlement", 1),
            downloadRefs: ["download:partial-refund"],
          },
        ],
      },
    });
    const entitlement = createEntitlementDocument({
      id: createTestMikaId("entitlement", 1),
      orderId: order.id,
      record: {
        ...createEntitlementDocument().record,
        orderId: order.id,
      },
    });
    const api = createMikaBackendApi(createIncrementingBackendDependencies({ repositories }));

    await repositories.ledger.put(order);
    await repositories.account.put(entitlement);
    await issueDownloadToken(repositories, {
      token: "partial_refund_download_token",
      expiresAt: createTestClock().isoAt(15 * 60_000),
      data: {
        downloadRef: "download:partial-refund",
        orderId: order.id,
        orderLineId: line.id,
        entitlementId: entitlement.id,
      },
    });

    await expect(
      api.download.resolve({ token: "partial_refund_download_token" }),
    ).resolves.toMatchObject({
      ok: true,
      status: 200,
      data: { redirectUrl: "download:partial-refund" },
    });
  });

  it("retries an out-of-order provider reversal until the paid order exists", async () => {
    const repositories = createTestBackendRepositories();
    const sellable = createSellableDefinition();
    const deliveries = [
      {
        payloadHash: "refund_before_order_hash",
        providerEventId: "event_refund_before_order",
        paymentStatus: "refunded" as const,
        type: "charge.refunded",
      },
      {
        payloadHash: "paid_after_refund_hash",
        providerEventId: "event_paid_after_refund",
        paymentStatus: "paid" as const,
        type: "payment.completed",
      },
      {
        payloadHash: "refund_before_order_hash",
        providerEventId: "event_refund_before_order",
        paymentStatus: "refunded" as const,
        type: "charge.refunded",
      },
    ];
    const fake = createFakeMikaProvider({
      id: TEST_PROVIDER,
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

          return createPaymentWebhookEvent(verified, {
            providerEventId: delivery.providerEventId,
            type: delivery.type,
            providerCheckoutId: "provider_checkout_fake",
            providerPaymentId: "payment_out_of_order",
            providerOrderId: "provider_order_out_of_order",
            paymentStatus: delivery.paymentStatus,
            customer: { email: "OutOfOrder@Example.test" },
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
    const ctx = createTestRequestContext({
      sessionId: "session_out_of_order",
      customerId: false,
      userId: false,
      idempotencyKey: "checkout_out_of_order",
    });
    const cart = await api.cart.add(ctx, { sellableId: sellable.id, quantity: 1 });
    if (!cart.ok) throw new Error("Expected cart.add to succeed.");
    const checkout = await api.checkout.start(ctx, {
      cartId: cart.data.id,
      provider: TEST_PROVIDER,
    });
    if (!checkout.ok) throw new Error("Expected checkout.start to succeed.");

    await expect(receiveWebhook(api, "refund-before-order")).resolves.toMatchObject({
      ok: false,
      status: 502,
      error: {
        code: "PROVIDER_FAILED",
        message: "Refund webhook could not be linked to an order.",
      },
    });
    await expect(
      repositories.ledger.findOrderByProviderPayment(TEST_PROVIDER, "payment_out_of_order"),
    ).resolves.toBeNull();

    await expect(receiveWebhook(api, "paid-after-refund")).resolves.toMatchObject({
      ok: true,
      status: 200,
      data: { id: "webhook_2", status: "received" },
    });
    await expect(
      repositories.ledger.findOrderByProviderPayment(TEST_PROVIDER, "payment_out_of_order"),
    ).resolves.toMatchObject({ status: "paid", paymentStatus: "paid" });

    await expect(receiveWebhook(api, "refund-redelivery")).resolves.toMatchObject({
      ok: true,
      status: 200,
      data: { id: "webhook_1", status: "received", replayable: true },
    });
    await expect(
      repositories.ledger.findOrderByProviderPayment(TEST_PROVIDER, "payment_out_of_order"),
    ).resolves.toMatchObject({ status: "refunded", paymentStatus: "refunded" });
    await expect(
      repositories.ops.findWebhookById(createTestMikaId("webhook", 1)),
    ).resolves.toMatchObject({
      status: "processed",
      record: { relatedOrderId: "order_1" },
    });
  });

  it("deduplicates a retried order refund by idempotency key without refunding twice", async () => {
    const repositories = createTestBackendRepositories();
    const fake = createFakeMikaProvider({
      optionalMethods: ["refundPayment"],
    });
    const order = createOrderDocument();
    const api = createMikaBackendApi(
      createIncrementingBackendDependencies({
        repositories,
        providers: createMikaProviderRegistry([fake.provider]),
      }),
    );

    await repositories.ledger.put(order);

    const refundArgs = {
      orderId: order.id,
      amount: 500,
      reason: "duplicate",
      idempotencyKey: "refund_invocation_1",
    };

    const first = await api.admin.orderRefund(refundArgs);
    expect(first).toMatchObject({ ok: true, status: 200, data: { status: "completed" } });

    const second = await api.admin.orderRefund(refundArgs);
    expect(second).toMatchObject({ ok: true, status: 200, data: { status: "completed" } });

    expect(fake.getCalls().refundPayment).toEqual([
      {
        orderId: order.id,
        providerPaymentId: "payment_1",
        amount: 500,
        reason: "duplicate",
        idempotencyKey: "refund_invocation_1",
      },
    ]);

    await expect(
      repositories.ops.findAdminAudit(createTestMikaId("admin_audit", 1)),
    ).resolves.toMatchObject({ status: "completed", record: { action: "order.refund" } });
    await expect(
      repositories.ops.findAdminAudit(createTestMikaId("admin_audit", 2)),
    ).resolves.toBeNull();
  });

  it("replays a completed legacy admin audit without a top-level action", async () => {
    const repositories = createTestBackendRepositories();
    const fake = createFakeMikaProvider({
      optionalMethods: ["refundPayment"],
    });
    const order = createOrderDocument();
    const api = createMikaBackendApi(
      createIncrementingBackendDependencies({
        repositories,
        providers: createMikaProviderRegistry([fake.provider]),
      }),
    );
    const refundArgs = {
      orderId: order.id,
      amount: 500,
      reason: "legacy",
      idempotencyKey: "refund_legacy_key",
    };

    await repositories.ledger.put(order);
    await expect(api.admin.orderRefund(refundArgs)).resolves.toMatchObject({
      ok: true,
      status: 200,
      data: { status: "completed" },
    });
    const audit = await repositories.ops.findAdminAudit(createTestMikaId("admin_audit", 1));
    if (!audit) throw new Error("Expected completed admin audit.");
    const { action: _legacyAction, ...legacyAudit } = audit;
    await repositories.ops.writeAudit(legacyAudit as AdminAuditDocument);

    await expect(api.admin.orderRefund(refundArgs)).resolves.toMatchObject({
      ok: true,
      status: 200,
      data: { status: "completed" },
    });

    expect(fake.getCalls().refundPayment).toEqual([
      {
        orderId: order.id,
        providerPaymentId: "payment_1",
        amount: 500,
        reason: "legacy",
        idempotencyKey: "refund_legacy_key",
      },
    ]);
    await expect(
      repositories.ops.findAdminAudit(createTestMikaId("admin_audit", 2)),
    ).resolves.toBeNull();
  });

  it("rejects a reused refund idempotency key carrying different input", async () => {
    const repositories = createTestBackendRepositories();
    const fake = createFakeMikaProvider({
      optionalMethods: ["refundPayment"],
    });
    const orderA = createOrderDocument();
    const orderB = createOrderDocument({
      id: createTestMikaId("order", 2),
      orderNumber: "M-1002",
      providerPaymentId: "payment_2",
      providerOrderId: "provider_order_2",
    });
    const api = createMikaBackendApi(
      createIncrementingBackendDependencies({
        repositories,
        providers: createMikaProviderRegistry([fake.provider]),
      }),
    );

    await repositories.ledger.put(orderA);
    await repositories.ledger.put(orderB);

    const first = await api.admin.orderRefund({
      orderId: orderA.id,
      amount: 500,
      idempotencyKey: "refund_shared_key",
    });
    expect(first).toMatchObject({ ok: true, status: 200, data: { status: "completed" } });

    const differentTarget = await api.admin.orderRefund({
      orderId: orderB.id,
      amount: 500,
      idempotencyKey: "refund_shared_key",
    });
    expect(differentTarget).toMatchObject({
      ok: false,
      status: 409,
      error: { code: "CONFLICT" },
    });

    const differentAmount = await api.admin.orderRefund({
      orderId: orderA.id,
      amount: 700,
      idempotencyKey: "refund_shared_key",
    });
    expect(differentAmount).toMatchObject({
      ok: false,
      status: 409,
      error: { code: "CONFLICT" },
    });

    expect(fake.getCalls().refundPayment).toEqual([
      {
        orderId: orderA.id,
        providerPaymentId: "payment_1",
        amount: 500,
        idempotencyKey: "refund_shared_key",
      },
    ]);
    await expect(repositories.ledger.findOrderById(orderB.id)).resolves.toMatchObject({
      status: orderB.status,
      paymentStatus: orderB.paymentStatus,
    });
  });

  it("replays an entitlement grant retried with the same idempotency key and input", async () => {
    const repositories = createTestBackendRepositories();
    const api = createMikaBackendApi(createIncrementingBackendDependencies({ repositories }));

    const grantArgs = {
      entitlementKey: "course.pro",
      customerId: createTestMikaId("customer", 1),
      idempotencyKey: "grant_shared_key",
    };

    const first = await api.admin.entitlementGrant(grantArgs);
    expect(first).toMatchObject({
      ok: true,
      status: 200,
      data: {
        id: createTestMikaId("entitlement", 1),
        status: "completed",
        affected: { entitlements: 1 },
      },
    });

    const second = await api.admin.entitlementGrant(grantArgs);
    expect(second).toMatchObject({
      ok: true,
      status: 200,
      data: { id: createTestMikaId("entitlement", 1), status: "completed" },
    });

    await expect(
      repositories.account.findEntitlementById(createTestMikaId("entitlement", 2)),
    ).resolves.toBeNull();
    await expect(
      repositories.ops.findAdminAudit(createTestMikaId("admin_audit", 2)),
    ).resolves.toBeNull();
  });

  it("refuses to replay a completed admin action whose result snapshot has no trusted schema version", async () => {
    // adminAuditReplayResult previously cast whatever JSON was stored (`snapshot as TData`) with
    // no check that it matches the caller's current result shape. A stale snapshot — written by
    // an older code version whose result DTO had a different shape, or one lacking the version
    // tag entirely — must not be replayed as a typed success; the caller should be told to retry
    // with a fresh idempotency key instead of receiving a shape-mismatched payload.
    const repositories = createTestBackendRepositories();
    const api = createMikaBackendApi(createIncrementingBackendDependencies({ repositories }));

    const grantArgs = {
      entitlementKey: "course.pro",
      customerId: createTestMikaId("customer", 1),
      idempotencyKey: "grant_untrusted_snapshot",
    };
    const first = await api.admin.entitlementGrant(grantArgs);
    expect(first).toMatchObject({ ok: true, status: 200 });

    const auditId = createTestMikaId("admin_audit", 1);
    const completedAudit = await repositories.ops.findAdminAudit(auditId);
    if (!completedAudit) throw new Error("Expected the admin audit to be persisted.");
    const { resultSchemaVersion: _drop, ...metadataWithoutVersion } =
      completedAudit.record.metadata ?? {};
    await repositories.ops.writeAudit({
      ...completedAudit,
      record: { ...completedAudit.record, metadata: metadataWithoutVersion },
    });

    await expect(api.admin.entitlementGrant(grantArgs)).resolves.toMatchObject({
      ok: false,
      status: 409,
      error: {
        code: "CONFLICT",
        message: expect.stringContaining("cannot be safely replayed"),
      },
    });
  });

  it("replays an admin action when the same idempotency key was also used by another action", async () => {
    const repositories = createTestBackendRepositories();
    const api = createMikaBackendApi(createIncrementingBackendDependencies({ repositories }));
    const customerId = createTestMikaId("customer", 1);
    const idempotencyKey = "shared_admin_action_key";

    const grant = await api.admin.entitlementGrant({
      entitlementKey: "course.pro",
      customerId,
      idempotencyKey,
    });
    expect(grant).toMatchObject({
      ok: true,
      status: 200,
      data: { id: createTestMikaId("entitlement", 1), status: "completed" },
    });

    const revokeInput = {
      entitlementId: createTestMikaId("entitlement", 1),
      reason: "policy",
      idempotencyKey,
    };
    const firstRevoke = await api.admin.entitlementRevoke(revokeInput);
    expect(firstRevoke).toMatchObject({
      ok: true,
      status: 200,
      data: { status: "completed", affected: { entitlements: 1 } },
    });

    const replayedRevoke = await api.admin.entitlementRevoke(revokeInput);
    expect(replayedRevoke).toMatchObject({
      ok: true,
      status: 200,
      data: { status: "completed", affected: { entitlements: 1 } },
    });
    await expect(
      repositories.ops.findAdminAudit(createTestMikaId("admin_audit", 3)),
    ).resolves.toBeNull();
  });

  it("revokes every active entitlement for a customer and entitlement key", async () => {
    const repositories = createTestBackendRepositories();
    const api = createMikaBackendApi(createIncrementingBackendDependencies({ repositories }));
    const customerId = createTestMikaId("customer", 1);
    const entitlementKey = "downloads.duplicate";
    const first = createEntitlementDocument({
      id: createTestMikaId("entitlement", 1),
      customerId,
      entitlementKey,
      record: { customerId, entitlementKey },
    });
    const second = createEntitlementDocument({
      id: createTestMikaId("entitlement", 2),
      customerId,
      entitlementKey,
      record: { customerId, entitlementKey },
    });
    const unrelated = createEntitlementDocument({
      id: createTestMikaId("entitlement", 3),
      customerId,
      entitlementKey: "downloads.other",
      record: { customerId, entitlementKey: "downloads.other" },
    });
    await repositories.account.put(first);
    await repositories.account.put(second);
    await repositories.account.put(unrelated);

    await expect(
      api.admin.entitlementRevoke({
        customerId,
        entitlementKey,
        reason: "policy",
      }),
    ).resolves.toMatchObject({
      ok: true,
      status: 200,
      data: {
        status: "completed",
        affected: { entitlements: 2 },
      },
    });

    await expect(repositories.account.findEntitlementById(first.id)).resolves.toMatchObject({
      status: "revoked",
      record: { status: "revoked", metadata: { revokeReason: "policy" } },
    });
    await expect(repositories.account.findEntitlementById(second.id)).resolves.toMatchObject({
      status: "revoked",
      record: { status: "revoked", metadata: { revokeReason: "policy" } },
    });
    await expect(repositories.account.findEntitlementById(unrelated.id)).resolves.toMatchObject({
      status: "active",
    });
  });

  it("replays a download issue retried with the same input after the clock advances", async () => {
    const repositories = createTestBackendRepositories();
    const clock = createTestClock();
    let offsetMs = 0;
    const api = createMikaBackendApi(
      createIncrementingBackendDependencies({
        repositories,
        now: () => new Date(clock.now.getTime() + offsetMs),
        isoNow: () => clock.isoAt(offsetMs),
      }),
    );

    const baseOrder = createOrderDocument();
    const baseLine = baseOrder.aggregate.lines[0]!;
    const order = createOrderDocument({
      aggregate: {
        ...baseOrder.aggregate,
        lines: [
          { ...baseLine, entitlementId: createTestMikaId("entitlement", 2), downloadRefs: [] },
        ],
      },
    });
    const baseEntitlement = createEntitlementDocument({ id: createTestMikaId("entitlement", 2) });
    const entitlement = createEntitlementDocument({
      id: createTestMikaId("entitlement", 2),
      orderId: order.id,
      record: { ...baseEntitlement.record, orderId: order.id },
    });
    await repositories.ledger.put(order);
    await repositories.account.put(entitlement);

    const issueArgs = {
      entitlementId: entitlement.id,
      orderId: order.id,
      orderLineId: createTestMikaId("order_line", 1),
      idempotencyKey: "download_shared_key",
    };

    const first = await api.admin.downloadIssue(issueArgs);
    expect(first).toMatchObject({
      ok: true,
      status: 200,
      data: { id: "download:order_1:order_line_1", status: "completed" },
    });

    offsetMs = 600_000;
    const second = await api.admin.downloadIssue(issueArgs);
    expect(second).toMatchObject({
      ok: true,
      status: 200,
      data: { id: "download:order_1:order_line_1", status: "completed" },
    });
    await expect(
      repositories.ops.findAdminAudit(createTestMikaId("admin_audit", 2)),
    ).resolves.toBeNull();
  });

  it("does not commit refund or cancel state when the provider returns a non-throwing failure", async () => {
    const repositories = createTestBackendRepositories();
    const fake = createFakeMikaProvider({
      optionalMethods: ["refundPayment", "cancelOrder"],
      overrides: {
        refundPayment: async () => ({ status: "failed", message: "Refund declined." }),
        cancelOrder: async () => ({ status: "failed", message: "Cancel declined." }),
      },
    });
    const refundTarget = createOrderDocument();
    const cancelTarget = createOrderDocument({
      id: createTestMikaId("order", 2),
      orderNumber: "M-1002",
      providerPaymentId: "payment_cancel",
      providerOrderId: "provider_order_cancel",
    });
    const api = createMikaBackendApi(
      createIncrementingBackendDependencies({
        repositories,
        providers: createMikaProviderRegistry([fake.provider]),
      }),
    );

    await repositories.ledger.put(refundTarget);
    await repositories.ledger.put(cancelTarget);

    await expect(
      api.admin.orderRefund({ orderId: refundTarget.id, amount: 500 }),
    ).resolves.toMatchObject({
      ok: false,
      status: 502,
      error: { code: "PROVIDER_FAILED", message: "Refund declined." },
    });
    await expect(api.admin.orderCancel({ orderId: cancelTarget.id })).resolves.toMatchObject({
      ok: false,
      status: 502,
      error: { code: "PROVIDER_FAILED", message: "Cancel declined." },
    });

    await expect(repositories.ledger.findOrderById(refundTarget.id)).resolves.toMatchObject({
      status: refundTarget.status,
      paymentStatus: refundTarget.paymentStatus,
    });
    await expect(repositories.ledger.findOrderById(cancelTarget.id)).resolves.toMatchObject({
      status: cancelTarget.status,
      paymentStatus: cancelTarget.paymentStatus,
    });
    await expect(
      repositories.ops.findAdminAudit(createTestMikaId("admin_audit", 1)),
    ).resolves.toMatchObject({
      status: "failed",
      record: { action: "order.refund", status: "failed" },
    });
    await expect(
      repositories.ops.findAdminAudit(createTestMikaId("admin_audit", 2)),
    ).resolves.toMatchObject({
      status: "failed",
      record: { action: "order.cancel", status: "failed" },
    });
  });

  it("runs repository-backed admin actions and records audit state", async () => {
    const db = createTestMikaDb();
    await mikaInitialMigration.up(db);
    const repositories = {
      ...createTestBackendRepositories(),
      ephemeral: new EphemeralRepository(db),
    } satisfies MikaBackendRepositories;
    const baseOrder = createOrderDocument();
    const baseLine = baseOrder.aggregate.lines[0]!;
    const baseEntitlement = createEntitlementDocument({ id: createTestMikaId("entitlement", 2) });
    const baseLicense = createLicenseDocument({ entitlementId: baseEntitlement.id });
    const baseEmail = createEmailDocument();
    const order = createOrderDocument({
      aggregate: {
        ...baseOrder.aggregate,
        lines: [
          {
            ...baseLine,
            entitlementId: createTestMikaId("entitlement", 2),
            downloadRefs: [],
          },
        ],
      },
    });
    const entitlement = createEntitlementDocument({
      id: createTestMikaId("entitlement", 2),
      orderId: order.id,
      record: {
        ...baseEntitlement.record,
        orderId: order.id,
      },
    });
    const license = createLicenseDocument({
      entitlementId: entitlement.id,
      record: {
        ...baseLicense.record,
        entitlementId: entitlement.id,
      },
    });
    const email = createEmailDocument({
      status: "failed",
      record: {
        ...baseEmail.record,
        status: "failed",
        lastError: "SMTP failed.",
      },
    });
    const notificationIntents: MikaNotificationIntent[] = [];
    const api = createMikaBackendApi(
      createIncrementingBackendDependencies({
        repositories,
        notifications: {
          handle: (intent) => {
            notificationIntents.push(intent);
          },
        },
      }),
    );

    await repositories.ledger.put(order);
    await repositories.account.put(entitlement);
    await repositories.account.put(license);
    await repositories.ops.put(email);

    await expect(
      api.admin.entitlementGrant({
        entitlementKey: "downloads.vip",
        customerId: createTestMikaId("customer", 1),
        email: "VIP@Example.test",
      }),
    ).resolves.toMatchObject({
      ok: true,
      status: 200,
      data: {
        id: createTestMikaId("entitlement", 1),
        status: "completed",
        affected: { entitlements: 1 },
      },
    });
    const downloadIssueResult = await api.admin.downloadIssue({
      entitlementId: entitlement.id,
      orderId: order.id,
      orderLineId: createTestMikaId("order_line", 1),
    });
    expect(downloadIssueResult).toMatchObject({
      ok: true,
      status: 200,
      data: {
        id: "download:order_1:order_line_1",
        status: "completed",
        affected: {
          downloads: 1,
          tokens: 1,
        },
      },
    });
    await expect(
      api.admin.entitlementRevoke({
        entitlementId: entitlement.id,
        reason: "manual_review",
      }),
    ).resolves.toMatchObject({
      ok: true,
      status: 200,
      data: {
        id: entitlement.id,
        status: "completed",
        affected: { entitlements: 1 },
      },
    });
    await expect(api.admin.emailResend({ emailId: email.id })).resolves.toMatchObject({
      ok: true,
      status: 200,
      data: {
        id: email.id,
        status: "completed",
        affected: { emails: 1 },
      },
    });
    await expect(
      api.admin.licenseRevoke({ licenseId: license.id, reason: "fraud" }),
    ).resolves.toMatchObject({
      ok: true,
      status: 200,
      data: {
        id: license.id,
        status: "completed",
        affected: { licenses: 1 },
      },
    });

    await expect(
      repositories.account.findEntitlementById(createTestMikaId("entitlement", 1)),
    ).resolves.toMatchObject({
      status: "active",
      entitlementKey: "downloads.vip",
      emailHash: createTestHash("email:vip@example.test"),
    });
    await expect(repositories.account.findEntitlementById(entitlement.id)).resolves.toMatchObject({
      status: "revoked",
      record: {
        status: "revoked",
        revokedAt: TEST_NOW,
        metadata: {
          revokeReason: "manual_review",
        },
      },
    });
    await expect(repositories.ops.findEmail(email.id)).resolves.toMatchObject({
      status: "queued",
      nextAttemptAt: TEST_NOW,
      record: {
        status: "queued",
        nextAttemptAt: TEST_NOW,
        metadata: {
          resentAt: TEST_NOW,
          adminAuditId: createTestMikaId("admin_audit", 4),
        },
      },
    });
    await expect(repositories.account.findLicenseById(license.id)).resolves.toMatchObject({
      status: "revoked",
      record: {
        status: "revoked",
        revokedAt: TEST_NOW,
        metadata: {
          revokeReason: "fraud",
        },
      },
    });
    await expect(repositories.ledger.findOrderById(order.id)).resolves.toMatchObject({
      aggregate: {
        lines: [
          {
            downloadRefs: ["download:order_1:order_line_1"],
          },
        ],
        metadata: {
          lastAdminAction: "download.issue",
        },
      },
    });
    await expect(
      repositories.ephemeral.get(createTestHash("download-token:download_token_1")),
    ).resolves.toMatchObject({
      status: "pending",
      data: {
        purpose: "download",
        orderId: order.id,
        orderLineId: createTestMikaId("order_line", 1),
        entitlementId: entitlement.id,
        downloadRef: "download:order_1:order_line_1",
        adminAuditId: createTestMikaId("admin_audit", 2),
      },
    });
    expect(notificationIntents).toEqual([
      expect.objectContaining({
        kind: "download.ready",
        occurredAt: TEST_NOW,
        context: {
          toEmail: "Subscriber@Example.test",
          customerId: "customer_1",
          userId: "user_1",
          emailHash: createTestHash("email:subscriber@example.test"),
          downloadRef: "download:order_1:order_line_1",
          orderId: order.id,
          orderLineId: createTestMikaId("order_line", 1),
          title: "Test download",
          tokenId: "download_token_1",
          expiresAt: "2026-01-01T00:15:00.000Z",
          entitlementId: entitlement.id,
          licenseId: license.id,
        },
      }),
    ]);

    for (const [auditId, action] of [
      [createTestMikaId("admin_audit", 1), "entitlement.grant"],
      [createTestMikaId("admin_audit", 2), "download.issue"],
      [createTestMikaId("admin_audit", 3), "entitlement.revoke"],
      [createTestMikaId("admin_audit", 4), "email.resend"],
      [createTestMikaId("admin_audit", 5), "license.revoke"],
    ] as const) {
      await expect(repositories.ops.findAdminAudit(auditId)).resolves.toMatchObject({
        status: "completed",
        record: {
          action,
          status: "completed",
        },
      });
    }

    await db.destroy();
  });

  it("returns stable missing target errors for repository-backed admin actions", async () => {
    const repositories = createTestBackendRepositories();
    const api = createMikaBackendApi(createIncrementingBackendDependencies({ repositories }));

    await expect(
      api.admin.entitlementRevoke({ entitlementId: createTestMikaId("entitlement", 404) }),
    ).resolves.toMatchObject({
      ok: false,
      status: 404,
      error: {
        code: "NOT_FOUND",
        fieldErrors: { entitlementId: "Entitlement was not found." },
      },
    });
    await expect(
      api.admin.emailResend({ emailId: createTestMikaId("email", 404) }),
    ).resolves.toMatchObject({
      ok: false,
      status: 404,
      error: {
        code: "NOT_FOUND",
        fieldErrors: { emailId: "Email was not found." },
      },
    });
    await expect(
      api.admin.licenseRevoke({ licenseId: createTestMikaId("license", 404) }),
    ).resolves.toMatchObject({
      ok: false,
      status: 404,
      error: {
        code: "NOT_FOUND",
        fieldErrors: { licenseId: "License was not found." },
      },
    });
    await expect(
      api.admin.downloadIssue({ orderId: createTestMikaId("order", 404) }),
    ).resolves.toMatchObject({
      ok: false,
      status: 404,
      error: {
        code: "NOT_FOUND",
        fieldErrors: { orderId: "Download was not found." },
      },
    });

    for (const [auditId, action] of [
      [createTestMikaId("admin_audit", 1), "entitlement.revoke"],
      [createTestMikaId("admin_audit", 2), "email.resend"],
      [createTestMikaId("admin_audit", 3), "license.revoke"],
      [createTestMikaId("admin_audit", 4), "download.issue"],
    ] as const) {
      await expect(repositories.ops.findAdminAudit(auditId)).resolves.toMatchObject({
        status: "failed",
        record: {
          action,
          status: "failed",
        },
      });
    }
  });

  it("returns stable magic link token errors for invalid and expired tokens", async () => {
    const harness = await createMagicLinkHarness({ ttlMs: 1 });

    try {
      await expect(
        harness.api.magicLink.verify(createTestRequestContext(), { token: "missing" }),
      ).resolves.toMatchObject({
        ok: false,
        status: 400,
        error: { code: "TOKEN_INVALID" },
      });

      await harness.api.magicLink.request(createTestRequestContext(), {
        email: "subscriber@example.test",
      });
      await expect(
        harness.api.magicLink.verify(createTestRequestContext({ now: createTestClock().at(2) }), {
          token: "magic_link_token_1",
        }),
      ).resolves.toMatchObject({
        ok: false,
        status: 410,
        error: { code: "TOKEN_EXPIRED" },
      });
      await expect(
        harness.repositories.ephemeral.get(createTestHash("magic-link-token:magic_link_token_1")),
      ).resolves.toMatchObject({
        status: "pending",
      });
    } finally {
      await harness.destroy();
    }
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
        rawPayloadJson: {
          providerPayload: { payloadHash: "hash_1" },
          normalizedEvent: {
            kind: "unknown",
            provider: TEST_PROVIDER,
            providerEventId: "event_1",
            type: "payment.completed",
          },
        },
      },
    });
    expect(fake.getCalls()).toMatchObject({
      verifyWebhook: [expect.any(Object), expect.any(Object), expect.any(Object)],
      parseWebhookEvent: [expect.any(Object), expect.any(Object), expect.any(Object)],
    });
  });

  it("returns non-replayable duplicate responses for already processed webhooks", async () => {
    const opsCollection = createStorageCollection("ops");
    const repositories = {
      ...createTestBackendRepositories(),
      ops: new OpsRepository(opsCollection),
    };
    const fake = createFakeMikaProvider({
      id: TEST_PROVIDER,
      overrides: {
        verifyWebhook: async (webhookInput) =>
          createVerifiedWebhookPayload(webhookInput, {
            payloadHash: "processed_duplicate_hash",
            parsed: { delivery: "processed-duplicate" },
          }),
        parseWebhookEvent: async (verified) =>
          createWebhookEvent(verified, {
            providerEventId: "event_processed_duplicate",
            type: "test.processed-duplicate",
          }),
      },
    });
    const api = createMikaBackendApi(
      createIncrementingBackendDependencies({
        repositories,
        providers: createMikaProviderRegistry([fake.provider]),
      }),
    );

    await expect(receiveWebhook(api, "processed-duplicate-first")).resolves.toMatchObject({
      ok: true,
      status: 200,
      data: { id: "webhook_1", status: "received", replayable: true },
    });
    const webhook = await repositories.ops.findWebhookById(createTestMikaId("webhook", 1));
    if (!webhook) throw new Error("Expected processed duplicate webhook fixture.");
    await repositories.ops.put({
      ...webhook,
      status: "processed",
      record: {
        ...webhook.record,
        status: "processed",
      },
    });

    const duplicate = await receiveWebhook(api, "processed-duplicate-second");
    expect(duplicate).toMatchObject({
      ok: true,
      status: 200,
      data: { id: "webhook_1", status: "duplicate" },
    });
    if (!duplicate.ok) throw new Error("Expected duplicate webhook result.");
    expect(duplicate.data.replayable).toBeUndefined();
    await expect(opsCollection.count({ type: "webhook" })).resolves.toBe(1);
    await expect(opsCollection.get("webhook_1")).resolves.toMatchObject({
      status: "processed",
      record: { status: "processed" },
    });
  });

  it("deduplicates webhook replay by idempotency key", async () => {
    const repositories = createTestBackendRepositories();
    const api = createMikaBackendApi(createIncrementingBackendDependencies({ repositories }));
    await repositories.ops.put(
      createWebhookDocument({
        status: "processed",
        record: {
          status: "processed",
          processedAt: TEST_NOW,
        },
      }),
    );
    const replayInput = {
      webhookId: createTestMikaId("webhook", 1),
      idempotencyKey: "webhook_replay_idem_1",
    };

    const first = await api.admin.webhookReplay(replayInput);
    expect(first).toMatchObject({
      ok: true,
      status: 200,
      data: {
        id: "webhook_1",
        status: "completed",
        affected: { processed: 0, failed: 0 },
      },
    });

    const second = await api.admin.webhookReplay(replayInput);
    expect(second).toMatchObject({
      ok: true,
      status: 200,
      data: {
        id: "webhook_1",
        status: "completed",
        affected: { processed: 0, failed: 0 },
      },
    });

    await expect(
      repositories.ops.findAdminAudit(createTestMikaId("admin_audit", 1)),
    ).resolves.toMatchObject({
      action: "webhook.replay",
      status: "completed",
      record: {
        targetType: "webhook",
        targetId: "webhook_1",
        idempotencyKey: "webhook_replay_idem_1",
      },
    });
    await expect(
      repositories.ops.findAdminAudit(createTestMikaId("admin_audit", 2)),
    ).resolves.toBeNull();
  });

  it("rejects non-paid provider payment events before paid-order fulfillment", async () => {
    const sessionCollection = createStorageCollection("session");
    const ledgerCollection = createStorageCollection("ledger");
    const opsCollection = createStorageCollection("ops");
    const repositories = {
      ...createTestBackendRepositories(),
      session: new SessionRepository(sessionCollection),
      ledger: new LedgerRepository(ledgerCollection),
      ops: new OpsRepository(opsCollection),
    };
    await repositories.session.put(
      createCheckoutDocument({
        providerCheckoutId: "provider_checkout_malformed",
      }),
    );

    const fake = createFakeMikaProvider({
      id: TEST_PROVIDER,
      overrides: {
        verifyWebhook: async (webhookInput) =>
          createVerifiedWebhookPayload(webhookInput, {
            payloadHash: "malformed_payment_hash",
            parsed: { delivery: "event_payment_malformed" },
          }),
        parseWebhookEvent: async (verified) =>
          createPaymentWebhookEvent(verified, {
            providerEventId: "event_payment_malformed",
            providerCheckoutId: "provider_checkout_malformed",
            providerPaymentId: "payment_malformed",
            paymentStatus: "failed",
          }),
      },
    });
    const notificationIntents: MikaNotificationIntent[] = [];
    const api = createMikaBackendApi(
      createIncrementingBackendDependencies({
        repositories,
        providers: createMikaProviderRegistry([fake.provider]),
        notifications: {
          handle: (intent) => {
            notificationIntents.push(intent);
          },
        },
      }),
    );

    await expect(receiveWebhook(api, "malformed-payment")).resolves.toMatchObject({
      ok: true,
      status: 200,
      data: { id: "webhook_1", status: "failed", replayable: true },
    });
    await expect(ledgerCollection.count({ type: "order" })).resolves.toBe(0);
    await expect(opsCollection.get("webhook_1")).resolves.toMatchObject({
      status: "failed",
      record: {
        status: "failed",
        lastError: "Payment webhook is not in a paid state.",
        rawPayloadJson: {
          normalizedEvent: expect.not.objectContaining({ paymentStatus: "paid" }),
        },
      },
    });
    expect(notificationIntents).toEqual([
      expect.objectContaining({
        kind: "ops.webhook_failed",
        occurredAt: TEST_NOW,
        context: {
          webhookId: "webhook_1",
          provider: TEST_PROVIDER,
          eventType: "payment.completed",
          providerEventId: "event_payment_malformed",
          payloadHash: "malformed_payment_hash",
          lastError: "Payment webhook is not in a paid state.",
        },
      }),
      expect.objectContaining({
        kind: "checkout.payment_failed",
        occurredAt: TEST_NOW,
        context: {
          checkoutId: "checkout_1",
          provider: TEST_PROVIDER,
          providerCheckoutId: "provider_checkout_malformed",
          providerPaymentId: "payment_malformed",
          paymentStatus: "failed",
          eventType: "payment.completed",
          webhookId: "webhook_1",
          error: "Payment webhook is not in a paid state.",
        },
      }),
    ]);
  });

  it("replays failed payment notifications after the notification hook fails", async () => {
    const sessionCollection = createStorageCollection("session");
    const ledgerCollection = createStorageCollection("ledger");
    const opsCollection = createStorageCollection("ops");
    const repositories = {
      ...createTestBackendRepositories(),
      session: new SessionRepository(sessionCollection),
      ledger: new LedgerRepository(ledgerCollection),
      ops: new OpsRepository(opsCollection),
    };
    await repositories.session.put(
      createCheckoutDocument({
        providerCheckoutId: "provider_checkout_failed_hook",
      }),
    );

    const fake = createFakeMikaProvider({
      id: TEST_PROVIDER,
      overrides: {
        verifyWebhook: async (webhookInput) =>
          createVerifiedWebhookPayload(webhookInput, {
            payloadHash: "failed_hook_payment_hash",
            parsed: { delivery: "event_payment_failed_hook" },
          }),
        parseWebhookEvent: async (verified) =>
          createPaymentWebhookEvent(verified, {
            providerEventId: "event_payment_failed_hook",
            providerCheckoutId: "provider_checkout_failed_hook",
            providerPaymentId: "payment_failed_hook",
            paymentStatus: "failed",
          }),
      },
    });
    const notificationIntents: MikaNotificationIntent[] = [];
    let failPaymentNotification = true;
    const api = createMikaBackendApi(
      createIncrementingBackendDependencies({
        repositories,
        providers: createMikaProviderRegistry([fake.provider]),
        notifications: {
          handle: (intent) => {
            notificationIntents.push(intent);
            if (intent.kind === "checkout.payment_failed" && failPaymentNotification) {
              failPaymentNotification = false;
              throw new Error("payment notification unavailable");
            }
          },
        },
      }),
    );

    await expect(receiveWebhook(api, "failed-payment-hook")).resolves.toMatchObject({
      ok: true,
      status: 200,
      data: { id: "webhook_1", status: "failed", replayable: true },
    });
    await expect(ledgerCollection.count({ type: "order" })).resolves.toBe(0);
    await expect(opsCollection.get("webhook_1")).resolves.toMatchObject({
      status: "failed",
      record: {
        status: "failed",
        lastError: "Payment webhook is not in a paid state.",
      },
    });

    await expect(
      api.admin.webhookReplay({ webhookId: createTestMikaId("webhook", 1) }),
    ).resolves.toMatchObject({
      ok: true,
      status: 200,
      data: {
        id: "webhook_1",
        status: "failed",
        affected: {
          processed: 0,
          failed: 1,
        },
      },
    });
    expect(
      notificationIntents.filter((intent) => intent.kind === "checkout.payment_failed"),
    ).toEqual([
      expect.objectContaining({
        kind: "checkout.payment_failed",
        context: expect.objectContaining({
          checkoutId: "checkout_1",
          providerCheckoutId: "provider_checkout_failed_hook",
          providerPaymentId: "payment_failed_hook",
          paymentStatus: "failed",
          webhookId: "webhook_1",
        }),
      }),
      expect.objectContaining({
        kind: "checkout.payment_failed",
        context: expect.objectContaining({
          checkoutId: "checkout_1",
          providerCheckoutId: "provider_checkout_failed_hook",
          providerPaymentId: "payment_failed_hook",
          paymentStatus: "failed",
          webhookId: "webhook_1",
        }),
      }),
    ]);
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
    await expect(opsCollection.get("workflow_webhook_1_payment")).resolves.toMatchObject({
      type: "workflow",
      kind: "payment_webhook_fulfillment",
      status: "completed",
      subjectType: "webhook",
      subjectId: "webhook_1",
      record: {
        status: "completed",
        steps: [
          { name: "link_checkout", status: "completed" },
          { name: "persist_order", status: "completed" },
          { name: "complete_checkout", status: "completed" },
          { name: "fulfill_order", status: "completed" },
          { name: "mark_webhook", status: "completed" },
        ],
      },
    });
  });

  it("does not queue Mika's default order-confirmation email when the hook handles it", async () => {
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
      { payloadHash: "payment_handled_hash_1", providerEventId: "event_payment_handled_1" },
      { payloadHash: "payment_handled_hash_2", providerEventId: "event_payment_handled_2" },
      { payloadHash: "payment_handled_hash_2", providerEventId: "event_payment_handled_2" },
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
            providerPaymentId: "payment_handled",
            providerOrderId: "provider_order_handled",
            customer: { email: "Shopper@Example.test", name: "Shopper One" },
          });
        },
      },
    });
    await repositories.catalog.put(
      createCatalogItemDocument({ contentRef: createTestContentRef(), sellables: [sellable] }),
    );
    const notificationIntents: MikaNotificationIntent[] = [];
    let resolveNotificationStarted: () => void = () => {};
    let releaseNotification: () => void = () => {};
    const notificationStarted = new Promise<void>((resolve) => {
      resolveNotificationStarted = resolve;
    });
    const notificationReleased = new Promise<void>((resolve) => {
      releaseNotification = resolve;
    });
    const api = createMikaBackendApi(
      createIncrementingBackendDependencies({
        repositories,
        providers: createMikaProviderRegistry([fake.provider]),
        notifications: {
          handle: async (intent) => {
            notificationIntents.push(intent);
            resolveNotificationStarted();
            await notificationReleased;
            return { handled: true };
          },
        },
      }),
    );
    const shopperCtx = createTestRequestContext({
      sessionId: "session_payment_handled",
      customerId: createTestMikaId("customer", 1),
      userId: "user_payment_handled",
      idempotencyKey: "checkout_payment_handled",
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

    const firstWebhook = receiveWebhook(api, "payment-handled", stripe);
    await notificationStarted;
    const secondWebhook = receiveWebhook(api, "payment-handled-replay", stripe);
    releaseNotification();

    await expect(firstWebhook).resolves.toMatchObject({
      ok: true,
      status: 200,
      data: {
        id: "webhook_1",
        status: "received",
        replayable: true,
      },
    });
    await expect(secondWebhook).resolves.toMatchObject({
      ok: false,
      status: 409,
      error: {
        code: "CONFLICT",
        message:
          "Webhook 'webhook_2' is awaiting fulfillment and was not processed; retry delivery.",
      },
    });
    await expect(receiveWebhook(api, "payment-handled-replay", stripe)).resolves.toMatchObject({
      ok: true,
      status: 200,
      data: {
        id: "webhook_2",
        status: "received",
        replayable: true,
      },
    });

    expect(notificationIntents).toHaveLength(1);
    expect(notificationIntents[0]).toMatchObject({
      kind: "order.confirmed",
      context: {
        toEmail: "Shopper@Example.test",
        orderId: "order_1",
        orderNumber: "order_1",
        fulfillmentKinds: ["none"],
      },
    });
    await expect(ledgerCollection.count({ type: "order" })).resolves.toBe(1);
    await expect(opsCollection.count({ type: "email" })).resolves.toBe(0);
    await expect(
      opsCollection.get("workflow_order_1_notification_order_confirmed"),
    ).resolves.toMatchObject({
      type: "workflow",
      kind: "notification.order.confirmed",
      status: "completed",
      subjectType: "order",
      subjectId: "order_1",
      idempotencyKey: "order.confirmed:order_1",
    });
    await expect(opsCollection.get("workflow_webhook_1_payment")).resolves.toMatchObject({
      status: "completed",
      record: {
        steps: expect.arrayContaining([
          expect.objectContaining({ name: "fulfill_order", status: "completed" }),
        ]),
      },
    });
  });

  it("addresses the paid-order confirmation to the canonical account email, not the provider event email", async () => {
    const stripe = createProviderName("stripe");
    const sessionCollection = createStorageCollection("session");
    const ledgerCollection = createStorageCollection("ledger");
    const opsCollection = createStorageCollection("ops");
    const accountCollection = createStorageCollection("account");
    const repositories = {
      ...createTestBackendRepositories(),
      session: new SessionRepository(sessionCollection),
      ledger: new LedgerRepository(ledgerCollection),
      ops: new OpsRepository(opsCollection),
      account: new AccountRepository(accountCollection),
    };
    const sellable = createSellableDefinition({
      prices: [
        createPriceDefinition({
          providerRefs: [{ provider: stripe, productId: "prod_payment", priceId: "price_payment" }],
        }),
      ],
    });
    const fake = createFakeMikaProvider({
      id: stripe,
      overrides: {
        verifyWebhook: async (webhookInput) =>
          createVerifiedWebhookPayload(webhookInput, {
            payloadHash: "payment_canonical_hash",
            parsed: { delivery: "event_payment_canonical" },
          }),
        parseWebhookEvent: async (verified) =>
          createPaymentWebhookEvent(verified, {
            providerEventId: "event_payment_canonical",
            providerCheckoutId: "provider_checkout_fake",
            providerPaymentId: "payment_1",
            providerOrderId: "provider_order_1",
            customer: { email: "Typed@Hosted.test", name: "Typed Buyer" },
          }),
      },
    });
    await repositories.catalog.put(
      createCatalogItemDocument({ contentRef: createTestContentRef(), sellables: [sellable] }),
    );
    await repositories.account.put(createCustomerDocument());
    const api = createMikaBackendApi(
      createIncrementingBackendDependencies({
        repositories,
        providers: createMikaProviderRegistry([fake.provider]),
      }),
    );
    const shopperCtx = createTestRequestContext({
      sessionId: "session_payment",
      customerId: createTestMikaId("customer", 1),
      userId: "user_1",
      idempotencyKey: "checkout_payment_canonical",
    });

    const cart = await api.cart.add(shopperCtx, { sellableId: sellable.id, quantity: 1 });
    if (!cart.ok) throw new Error("Expected cart.add to succeed.");
    const checkout = await api.checkout.start(shopperCtx, {
      cartId: cart.data.id,
      provider: stripe,
    });
    if (!checkout.ok) throw new Error("Expected checkout.start to succeed.");

    await receiveWebhook(api, "payment", stripe);

    const order = await repositories.ledger.findOrderByProviderPayment(stripe, "payment_1");
    expect(order?.aggregate.customer).toMatchObject({
      customerId: "customer_1",
      email: "Subscriber@Example.test",
      emailHash: createTestHash("email:subscriber@example.test"),
    });
    const confirmationEmail = await opsCollection.get("email_order_1_order_confirmation");
    expect(confirmationEmail).toMatchObject({
      record: { toEmail: "Subscriber@Example.test" },
    });
  });

  it("does not attach paid webhook orders to an anonymized checkout customer", async () => {
    const stripe = createProviderName("stripe");
    const sessionCollection = createStorageCollection("session");
    const ledgerCollection = createStorageCollection("ledger");
    const opsCollection = createStorageCollection("ops");
    const accountCollection = createStorageCollection("account");
    const repositories = {
      ...createTestBackendRepositories(),
      session: new SessionRepository(sessionCollection),
      ledger: new LedgerRepository(ledgerCollection),
      ops: new OpsRepository(opsCollection),
      account: new AccountRepository(accountCollection),
    };
    const customer = createCustomerDocument({
      aggregate: {
        ...createCustomerDocument().aggregate,
        metadata: { anonymizedAt: TEST_NOW },
      },
    });
    const fake = createFakeMikaProvider({
      id: stripe,
      overrides: {
        verifyWebhook: async (webhookInput) =>
          createVerifiedWebhookPayload(webhookInput, {
            payloadHash: "payment_deleted_customer_hash",
            parsed: { delivery: "event_payment_deleted_customer" },
          }),
        parseWebhookEvent: async (verified) =>
          createPaymentWebhookEvent(verified, {
            providerEventId: "event_payment_deleted_customer",
            providerCheckoutId: "provider_checkout_deleted_customer",
            providerPaymentId: "payment_deleted_customer",
            providerOrderId: "provider_order_deleted_customer",
            customer: { email: "Deleted@Example.test", name: "Deleted Buyer" },
          }),
      },
    });
    await repositories.account.put(customer);
    const checkoutDocument = createCheckoutDocument({
      customerId: customer.customerId,
      providerCheckoutId: "provider_checkout_deleted_customer",
    });
    await repositories.session.put({
      ...checkoutDocument,
      provider: stripe,
      aggregate: {
        ...checkoutDocument.aggregate,
        binding: {
          ...checkoutDocument.aggregate.binding,
          provider: stripe,
        },
      },
    });
    const api = createMikaBackendApi(
      createIncrementingBackendDependencies({
        repositories,
        providers: createMikaProviderRegistry([fake.provider]),
      }),
    );

    await expect(receiveWebhook(api, "payment-deleted-customer", stripe)).resolves.toMatchObject({
      ok: true,
      status: 200,
    });
    const order = await repositories.ledger.findOrderByProviderPayment(
      stripe,
      "payment_deleted_customer",
    );
    expect(order).toMatchObject({
      customerId: undefined,
      emailHash: createTestHash("email:deleted@example.test"),
      aggregate: {
        customer: {
          email: "Deleted@Example.test",
          emailHash: createTestHash("email:deleted@example.test"),
        },
      },
    });
    expect(order?.aggregate.customer).not.toHaveProperty("customerId");
  });

  it("promotes a guest checkout to the matching registered customer at payment fulfillment", async () => {
    const stripe = createProviderName("stripe");
    const sessionCollection = createStorageCollection("session");
    const ledgerCollection = createStorageCollection("ledger");
    const accountCollection = createStorageCollection("account");
    const repositories = {
      ...createTestBackendRepositories(),
      session: new SessionRepository(sessionCollection),
      ledger: new LedgerRepository(ledgerCollection),
      account: new AccountRepository(accountCollection),
    };
    const sellable = createSellableDefinition({
      prices: [
        createPriceDefinition({
          fulfillmentKind: "entitlement",
          entitlementKey: "course:guest-promotion",
          providerRefs: [{ provider: stripe, productId: "prod_payment", priceId: "price_payment" }],
        }),
      ],
    });
    const fake = createFakeMikaProvider({
      id: stripe,
      overrides: {
        verifyWebhook: async (webhookInput) =>
          createVerifiedWebhookPayload(webhookInput, {
            payloadHash: "payment_guest_promotion_hash",
            parsed: { delivery: "event_payment_guest_promotion" },
          }),
        parseWebhookEvent: async (verified) =>
          createPaymentWebhookEvent(verified, {
            providerEventId: "event_payment_guest_promotion",
            providerCheckoutId: "provider_checkout_fake",
            providerPaymentId: "payment_1",
            providerOrderId: "provider_order_1",
            customer: { email: "Subscriber@Example.test", name: "Guest Buyer" },
          }),
      },
    });
    await repositories.catalog.put(
      createCatalogItemDocument({ contentRef: createTestContentRef(), sellables: [sellable] }),
    );
    await repositories.account.put(createCustomerDocument());
    const api = createMikaBackendApi(
      createIncrementingBackendDependencies({
        repositories,
        providers: createMikaProviderRegistry([fake.provider]),
      }),
    );
    const guestCtx = createTestRequestContext({
      sessionId: "session_guest_promotion",
      customerId: false,
      userId: false,
      idempotencyKey: "checkout_guest_promotion",
    });

    const cart = await api.cart.add(guestCtx, { sellableId: sellable.id, quantity: 1 });
    if (!cart.ok) throw new Error("Expected cart.add to succeed.");
    const checkout = await api.checkout.start(guestCtx, {
      cartId: cart.data.id,
      provider: stripe,
    });
    if (!checkout.ok) throw new Error("Expected checkout.start to succeed.");

    await receiveWebhook(api, "payment", stripe);

    const order = await repositories.ledger.findOrderByProviderPayment(stripe, "payment_1");
    expect(order).toMatchObject({
      customerId: "customer_1",
      emailHash: createTestHash("email:subscriber@example.test"),
      aggregate: {
        customer: {
          customerId: "customer_1",
          email: "Subscriber@Example.test",
          emailHash: createTestHash("email:subscriber@example.test"),
        },
      },
    });
    await expect(accountCollection.get("entitlement_order_1_order_line_1")).resolves.toMatchObject({
      type: "entitlement",
      customerId: "customer_1",
    });
  });

  it("returns a retryable conflict and runs no payment webhook side effects without the workflow lease", async () => {
    const stripe = createProviderName("stripe");
    const clock = createTestClock();
    const ledgerCollection = createStorageCollection("ledger");
    const opsCollection = createStorageCollection("ops");
    const repositories = {
      ...createTestBackendRepositories(),
      ledger: new LedgerRepository(ledgerCollection),
      ops: new OpsRepository(opsCollection),
    };
    const activeLeaseExpiresAt = clock.isoAt(300_000);
    await repositories.ops.put(
      createWorkflowDocument({
        id: createMikaId("workflow_webhook_1_payment"),
        status: "running",
        nextAttemptAt: undefined,
        subjectId: createTestMikaId("webhook", 1),
        idempotencyKey: "event_payment_lease",
        leaseKey: "worker_active",
        leasedAt: TEST_NOW,
        leaseExpiresAt: activeLeaseExpiresAt,
      }),
    );
    const fake = createFakeMikaProvider({
      id: stripe,
      overrides: {
        verifyWebhook: async (webhookInput) =>
          createVerifiedWebhookPayload(webhookInput, {
            payloadHash: "payment_lease_hash",
            parsed: { delivery: "event_payment_lease" },
          }),
        parseWebhookEvent: async (verified) =>
          createPaymentWebhookEvent(verified, {
            providerEventId: "event_payment_lease",
            providerPaymentId: "payment_lease",
          }),
      },
    });
    const api = createMikaBackendApi(
      createIncrementingBackendDependencies({
        repositories,
        providers: createMikaProviderRegistry([fake.provider]),
      }),
    );

    await expect(receiveWebhook(api, "payment-active-lease", stripe)).resolves.toMatchObject({
      ok: false,
      status: 409,
      error: { code: "CONFLICT" },
    });

    await expect(ledgerCollection.count({ type: "order" })).resolves.toBe(0);
    await expect(opsCollection.get("webhook_1")).resolves.toMatchObject({
      status: "received",
      record: { status: "received" },
    });
    await expect(opsCollection.get("workflow_webhook_1_payment")).resolves.toMatchObject({
      status: "running",
      leaseExpiresAt: activeLeaseExpiresAt,
      record: {
        status: "running",
        leaseKey: "worker_active",
        leaseExpiresAt: activeLeaseExpiresAt,
        steps: expect.arrayContaining([
          expect.objectContaining({ name: "link_checkout", status: "queued" }),
        ]),
      },
    });
    await expect(
      api.admin.webhookReplay({ webhookId: createTestMikaId("webhook", 1) }),
    ).resolves.toMatchObject({
      ok: true,
      status: 200,
      data: {
        id: "webhook_1",
        status: "running",
        affected: {
          processed: 0,
          failed: 0,
        },
      },
    });
    await expect(ledgerCollection.count({ type: "order" })).resolves.toBe(0);
  });

  it("does not swallow payment webhook terminal persistence failures", async () => {
    const stripe = createProviderName("stripe");
    const opsCollection = createStorageCollection("ops");
    const repositories = {
      ...createTestBackendRepositories(),
      ops: new FailingTerminalWebhookOpsRepository(opsCollection),
    };
    const fake = createFakeMikaProvider({
      id: stripe,
      overrides: {
        verifyWebhook: async (webhookInput) =>
          createVerifiedWebhookPayload(webhookInput, {
            payloadHash: "payment_terminal_hash",
            parsed: { delivery: "event_payment_terminal" },
          }),
        parseWebhookEvent: async (verified) =>
          createPaymentWebhookEvent(verified, {
            providerEventId: "event_payment_terminal",
            providerPaymentId: "payment_terminal",
          }),
      },
    });
    const api = createMikaBackendApi(
      createIncrementingBackendDependencies({
        repositories,
        providers: createMikaProviderRegistry([fake.provider]),
      }),
    );

    await expect(receiveWebhook(api, "payment-terminal-failure", stripe)).rejects.toThrow(
      "Webhook 'webhook_1' status could not be persisted.",
    );
    await expect(opsCollection.get("webhook_1")).resolves.toMatchObject({
      status: "received",
      record: { status: "received" },
    });
    await expect(opsCollection.get("workflow_webhook_1_payment")).resolves.toMatchObject({
      status: "failed",
      record: {
        status: "failed",
        steps: expect.arrayContaining([
          expect.objectContaining({ name: "link_checkout", status: "completed" }),
          expect.objectContaining({ name: "mark_webhook", status: "failed" }),
          expect.objectContaining({ name: "persist_order", status: "queued" }),
        ]),
      },
    });

    const replayApi = createMikaBackendApi(
      createIncrementingBackendDependencies({
        repositories: {
          ...repositories,
          ops: new OpsRepository(opsCollection),
        },
        providers: createMikaProviderRegistry([fake.provider]),
      }),
    );
    await expect(
      replayApi.admin.webhookReplay({ webhookId: createTestMikaId("webhook", 1) }),
    ).resolves.toMatchObject({
      ok: true,
      status: 200,
      data: {
        id: "webhook_1",
        status: "failed",
        affected: {
          processed: 0,
          failed: 1,
        },
      },
    });
    await expect(opsCollection.get("webhook_1")).resolves.toMatchObject({
      status: "failed",
      record: { status: "failed" },
    });
  });

  it("does not swallow subscription webhook terminal persistence failures", async () => {
    const stripe = createProviderName("stripe");
    const opsCollection = createStorageCollection("ops");
    const repositories = {
      ...createTestBackendRepositories(),
      ops: new FailingTerminalWebhookOpsRepository(opsCollection),
    };
    const fake = createFakeMikaProvider({
      id: stripe,
      overrides: {
        verifyWebhook: async (webhookInput) =>
          createVerifiedWebhookPayload(webhookInput, {
            payloadHash: "subscription_terminal_hash",
            parsed: { delivery: "event_subscription_terminal" },
          }),
        parseWebhookEvent: async (verified) =>
          createSubscriptionWebhookEvent(verified, {
            providerEventId: "event_subscription_terminal",
            providerSubscriptionId: "provider_subscription_terminal",
            providerCustomerId: "provider_customer_terminal",
            providerPriceId: "price_terminal",
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

    await expect(receiveWebhook(api, "subscription-terminal-failure", stripe)).rejects.toThrow(
      "Webhook 'webhook_1' status could not be persisted.",
    );
    await expect(opsCollection.get("webhook_1")).resolves.toMatchObject({
      status: "received",
      record: { status: "received" },
    });
  });

  it("replays failed payment webhooks after missing checkout state is restored", async () => {
    const stripe = TEST_PROVIDER;
    const sessionCollection = createStorageCollection("session");
    const ledgerCollection = createStorageCollection("ledger");
    const opsCollection = createStorageCollection("ops");
    const repositories = {
      ...createTestBackendRepositories(),
      session: new SessionRepository(sessionCollection),
      ledger: new LedgerRepository(ledgerCollection),
      ops: new OpsRepository(opsCollection),
    };
    const fake = createFakeMikaProvider({
      id: stripe,
      overrides: {
        verifyWebhook: async (webhookInput) =>
          createVerifiedWebhookPayload(webhookInput, {
            payloadHash: "payment_replay_hash",
            parsed: { delivery: "event_payment_replay" },
          }),
        parseWebhookEvent: async (verified) =>
          createPaymentWebhookEvent(verified, {
            providerEventId: "event_payment_replay",
            providerCheckoutId: "provider_checkout_replay",
            providerPaymentId: "payment_replay",
            providerOrderId: "provider_order_replay",
          }),
      },
    });
    const api = createMikaBackendApi(
      createIncrementingBackendDependencies({
        repositories,
        providers: createMikaProviderRegistry([fake.provider]),
      }),
    );

    await expect(receiveWebhook(api, "payment-replay-failed", stripe)).resolves.toMatchObject({
      ok: true,
      status: 200,
      data: { id: "webhook_1", status: "failed", replayable: true },
    });
    await expect(opsCollection.get("workflow_webhook_1_payment")).resolves.toMatchObject({
      status: "failed",
      record: {
        status: "failed",
        nextAttemptAt: createTestClock().isoAt(60_000),
        steps: expect.arrayContaining([
          expect.objectContaining({ name: "link_checkout", status: "completed" }),
          expect.objectContaining({ name: "mark_webhook", status: "completed" }),
          expect.objectContaining({ name: "persist_order", status: "queued" }),
        ]),
      },
    });

    await repositories.session.put(
      createCheckoutDocument({
        providerCheckoutId: "provider_checkout_replay",
      }),
    );

    await expect(
      api.admin.webhookReplay({ webhookId: createTestMikaId("webhook", 1) }),
    ).resolves.toMatchObject({
      ok: true,
      status: 200,
      data: {
        id: "webhook_1",
        status: "completed",
        affected: {
          processed: 1,
          failed: 0,
        },
      },
    });
    await expect(ledgerCollection.count({ type: "order" })).resolves.toBe(1);
    await expect(opsCollection.get("webhook_1")).resolves.toMatchObject({
      status: "processed",
      record: { status: "processed", relatedOrderId: "order_1" },
    });
    await expect(opsCollection.get("workflow_webhook_1_payment")).resolves.toMatchObject({
      status: "completed",
      record: {
        status: "completed",
        steps: expect.arrayContaining([
          expect.objectContaining({ name: "persist_order", status: "completed" }),
          expect.objectContaining({ name: "complete_checkout", status: "completed" }),
          expect.objectContaining({ name: "fulfill_order", status: "completed" }),
        ]),
      },
    });
  });

  it("reprocesses a failed payment webhook on provider retry without manual replay", async () => {
    const stripe = TEST_PROVIDER;
    const sessionCollection = createStorageCollection("session");
    const ledgerCollection = createStorageCollection("ledger");
    const opsCollection = createStorageCollection("ops");
    const repositories = {
      ...createTestBackendRepositories(),
      session: new SessionRepository(sessionCollection),
      ledger: new LedgerRepository(ledgerCollection),
      ops: new OpsRepository(opsCollection),
    };
    const fake = createFakeMikaProvider({
      id: stripe,
      overrides: {
        verifyWebhook: async (webhookInput) =>
          createVerifiedWebhookPayload(webhookInput, {
            payloadHash: "payment_retry_hash",
            parsed: { delivery: "event_payment_retry" },
          }),
        parseWebhookEvent: async (verified) =>
          createPaymentWebhookEvent(verified, {
            providerEventId: "event_payment_retry",
            providerCheckoutId: "provider_checkout_retry",
            providerPaymentId: "payment_retry",
            providerOrderId: "provider_order_retry",
          }),
      },
    });
    const api = createMikaBackendApi(
      createIncrementingBackendDependencies({
        repositories,
        providers: createMikaProviderRegistry([fake.provider]),
      }),
    );

    await expect(receiveWebhook(api, "payment-retry-failed", stripe)).resolves.toMatchObject({
      ok: true,
      status: 200,
      data: { id: "webhook_1", status: "failed", replayable: true },
    });
    await expect(opsCollection.get("webhook_1")).resolves.toMatchObject({ status: "failed" });
    await expect(ledgerCollection.count({ type: "order" })).resolves.toBe(0);

    await repositories.session.put(
      createCheckoutDocument({
        providerCheckoutId: "provider_checkout_retry",
      }),
    );

    await expect(receiveWebhook(api, "payment-retry-redelivery", stripe)).resolves.toMatchObject({
      ok: true,
      status: 200,
      data: { id: "webhook_1", status: "received", replayable: true },
    });
    await expect(ledgerCollection.count({ type: "order" })).resolves.toBe(1);
    await expect(opsCollection.get("webhook_1")).resolves.toMatchObject({
      status: "processed",
      record: { status: "processed", relatedOrderId: "order_1" },
    });
  });

  it("recovers a payment webhook stuck in received once a lost workflow lease expires", async () => {
    const stripe = TEST_PROVIDER;
    const clock = createTestClock();
    const sessionCollection = createStorageCollection("session");
    const ledgerCollection = createStorageCollection("ledger");
    const opsCollection = createStorageCollection("ops");
    const repositories = {
      ...createTestBackendRepositories(),
      session: new SessionRepository(sessionCollection),
      ledger: new LedgerRepository(ledgerCollection),
      ops: new OpsRepository(opsCollection),
    };
    const fake = createFakeMikaProvider({
      id: stripe,
      overrides: {
        verifyWebhook: async (webhookInput) =>
          createVerifiedWebhookPayload(webhookInput, {
            payloadHash: "payment_stuck_hash",
            parsed: { delivery: "event_payment_stuck" },
          }),
        parseWebhookEvent: async (verified) =>
          createPaymentWebhookEvent(verified, {
            providerEventId: "event_payment_stuck",
            providerCheckoutId: "provider_checkout_stuck",
            providerPaymentId: "payment_stuck",
            providerOrderId: "provider_order_stuck",
          }),
      },
    });
    const api = createMikaBackendApi(
      createIncrementingBackendDependencies({
        repositories,
        providers: createMikaProviderRegistry([fake.provider]),
      }),
    );

    await repositories.session.put(
      createCheckoutDocument({ providerCheckoutId: "provider_checkout_stuck" }),
    );
    await repositories.ops.put(
      createWorkflowDocument({
        id: createMikaId("workflow_webhook_1_payment"),
        subjectId: createMikaId("webhook_1"),
        idempotencyKey: "event_payment_stuck",
        status: "running",
        nextAttemptAt: clock.isoAt(0),
        leaseExpiresAt: clock.isoAt(300_000),
        leaseKey: "crashed_worker",
        leasedAt: clock.isoAt(0),
      }),
    );

    await expect(receiveWebhook(api, "payment-stuck-first", stripe)).resolves.toMatchObject({
      ok: false,
      status: 409,
      error: { code: "CONFLICT" },
    });
    await expect(opsCollection.get("webhook_1")).resolves.toMatchObject({ status: "received" });
    await expect(ledgerCollection.count({ type: "order" })).resolves.toBe(0);

    const redelivery = await api.webhook.receive(
      createTestRequestContext({
        request: createWebhookRequest(JSON.stringify({ marker: "payment-stuck-redelivery" })),
        sessionId: false,
        customerId: false,
        userId: false,
        idempotencyKey: false,
        now: new Date(clock.isoAt(600_000)),
      }),
      { provider: stripe },
    );
    expect(redelivery).toMatchObject({
      ok: true,
      status: 200,
      data: { id: "webhook_1", status: "received" },
    });
    await expect(ledgerCollection.count({ type: "order" })).resolves.toBe(1);
    await expect(opsCollection.get("webhook_1")).resolves.toMatchObject({ status: "processed" });
  });

  it("does not regress refunded or cancelled orders to paid from late payment webhooks", async () => {
    const stripe = createProviderName("stripe");
    const cases = [
      {
        name: "refunded",
        order: createOrderDocument({
          status: "refunded",
          paymentStatus: "refunded",
          provider: stripe,
          providerPaymentId: "payment_refunded",
          providerOrderId: "provider_order_refunded",
        }),
      },
      {
        name: "cancelled",
        order: createOrderDocument({
          id: createTestMikaId("order", 2),
          orderNumber: "M-1002",
          status: "cancelled",
          paymentStatus: "paid",
          provider: stripe,
          providerPaymentId: "payment_cancelled",
          providerOrderId: "provider_order_cancelled",
        }),
      },
    ];

    for (const testCase of cases) {
      const ledgerCollection = createStorageCollection("ledger");
      const opsCollection = createStorageCollection("ops");
      const repositories = {
        ...createTestBackendRepositories(),
        ledger: new LedgerRepository(ledgerCollection),
        ops: new OpsRepository(opsCollection),
      };
      const fake = createFakeMikaProvider({
        id: stripe,
        overrides: {
          parseWebhookEvent: async (verified) =>
            createPaymentWebhookEvent(verified, {
              providerEventId: `event_late_${testCase.name}`,
              providerPaymentId: testCase.order.providerPaymentId,
              providerOrderId: testCase.order.providerOrderId,
              invoiceUrl: `https://invoice.example.test/late-${testCase.name}`,
            }),
        },
      });
      const api = createMikaBackendApi(
        createIncrementingBackendDependencies({
          repositories,
          providers: createMikaProviderRegistry([fake.provider]),
        }),
      );
      await repositories.ledger.put(testCase.order);

      await expect(receiveWebhook(api, `late-${testCase.name}`, stripe)).resolves.toMatchObject({
        ok: true,
        status: 200,
        data: {
          id: "webhook_1",
          status: "received",
          replayable: true,
        },
      });

      await expect(repositories.ledger.findOrderById(testCase.order.id)).resolves.toMatchObject({
        status: testCase.order.status,
        paymentStatus: testCase.order.paymentStatus,
        paidAt: TEST_NOW,
        aggregate: {
          invoiceUrl: `https://invoice.example.test/late-${testCase.name}`,
          providerRefs: expect.arrayContaining([
            expect.objectContaining({
              provider: stripe,
              paymentId: testCase.order.providerPaymentId,
              orderId: testCase.order.providerOrderId,
            }),
          ]),
        },
      });
      await expect(opsCollection.get("workflow_webhook_1_payment")).resolves.toMatchObject({
        status: "completed",
        record: {
          status: "completed",
          resumeState: {
            webhookStatus: "processed",
            relatedOrderId: testCase.order.id,
          },
        },
      });
      const workflow = await opsCollection.get("workflow_webhook_1_payment");
      const steps = (
        workflow as {
          readonly record: { readonly steps: ReadonlyArray<{ name: string; status: string }> };
        }
      ).record.steps;
      const stepStatus = (name: string): string | undefined =>
        steps.find((step) => step.name === name)?.status;
      expect(stepStatus("complete_checkout")).toBe("skipped");
      expect(stepStatus("fulfill_order")).toBe("skipped");
      await expect(opsCollection.count({ type: "email" })).resolves.toBe(0);
    }
  });

  it("preserves partially refunded payment state while fulfilling missing line access", async () => {
    const stripe = createProviderName("stripe");
    const ledgerCollection = createStorageCollection("ledger");
    const opsCollection = createStorageCollection("ops");
    const repositories = {
      ...createTestBackendRepositories(),
      ledger: new LedgerRepository(ledgerCollection),
      ops: new OpsRepository(opsCollection),
    };
    const baseOrder = createOrderDocument({
      status: "partially_refunded",
      paymentStatus: "partially_refunded",
      provider: stripe,
      providerPaymentId: "payment_partial_replay",
      providerOrderId: "provider_order_partial_replay",
    });
    const partiallyRefundedOrder: OrderDocument = {
      ...baseOrder,
      aggregate: {
        ...baseOrder.aggregate,
        lines: baseOrder.aggregate.lines.map((line) => {
          const { downloadRefs: _downloadRefs, ...lineWithoutRefs } = line;
          return lineWithoutRefs;
        }),
        metadata: {
          ...baseOrder.aggregate.metadata,
          refundAmount: 300,
        },
        providerRefs: [
          {
            provider: stripe,
            paymentId: "payment_partial_replay",
            orderId: "provider_order_partial_replay",
          },
        ],
      },
    };
    const fake = createFakeMikaProvider({
      id: stripe,
      overrides: {
        verifyWebhook: async (webhookInput) =>
          createVerifiedWebhookPayload(webhookInput, {
            payloadHash: "partial_replay_paid_hash",
            parsed: { delivery: "event_partial_replay_paid" },
          }),
        parseWebhookEvent: async (verified) =>
          createPaymentWebhookEvent(verified, {
            providerEventId: "event_partial_replay_paid",
            providerPaymentId: "payment_partial_replay",
            providerOrderId: "provider_order_partial_replay",
            invoiceUrl: "https://invoice.example.test/partial-replay",
          }),
      },
    });
    const notificationIntents: MikaNotificationIntent[] = [];
    const api = createMikaBackendApi(
      createIncrementingBackendDependencies({
        repositories,
        providers: createMikaProviderRegistry([fake.provider]),
        notifications: {
          handle: (intent) => {
            notificationIntents.push(intent);
          },
        },
      }),
    );
    await repositories.ledger.put(partiallyRefundedOrder);

    await expect(receiveWebhook(api, "partial-replay-paid", stripe)).resolves.toMatchObject({
      ok: true,
      status: 200,
      data: { id: "webhook_1", status: "received" },
    });

    await expect(
      repositories.ledger.findOrderById(partiallyRefundedOrder.id),
    ).resolves.toMatchObject({
      status: "partially_refunded",
      paymentStatus: "partially_refunded",
      aggregate: {
        invoiceUrl: "https://invoice.example.test/partial-replay",
        lines: [
          {
            id: "order_line_1",
            downloadRefs: ["download:order_1:order_line_1"],
          },
        ],
        metadata: {
          refundAmount: 300,
          fulfilledAt: TEST_NOW,
        },
      },
    });
    expect(notificationIntents.filter((intent) => intent.kind === "download.ready")).toHaveLength(
      1,
    );
    await expect(opsCollection.get("workflow_webhook_1_payment")).resolves.toMatchObject({
      status: "completed",
      record: {
        resumeState: {
          relatedOrderId: "order_1",
          webhookStatus: "processed",
        },
      },
    });
  });

  it("persists forward progress when a later line fails mid-fulfillment", async () => {
    const stripe = createProviderName("stripe");
    const accountCollection = createStorageCollection("account");
    const sessionCollection = createStorageCollection("session");
    const ledgerCollection = createStorageCollection("ledger");
    const opsCollection = createStorageCollection("ops");
    const firstSellable = createSellableDefinition({
      id: createTestMikaId("sellable", 1),
      prices: [
        createPriceDefinition({
          id: createTestMikaId("price", 1),
          fulfillmentKind: "entitlement",
          entitlementKey: "course:first",
          providerRefs: [{ provider: stripe, productId: "prod_first", priceId: "price_first" }],
        }),
      ],
    });
    const secondSellable = createSellableDefinition({
      id: createTestMikaId("sellable", 2),
      prices: [
        createPriceDefinition({
          id: createTestMikaId("price", 2),
          fulfillmentKind: "entitlement",
          entitlementKey: "course:second",
          providerRefs: [{ provider: stripe, productId: "prod_second", priceId: "price_second" }],
        }),
      ],
    });
    const stockRepository = createTestStockRepository(
      new Map([
        [
          firstSellable.id,
          createStockRecord({
            id: createTestMikaId("stock", 1),
            sellableId: firstSellable.id,
            quantityOnHand: 5,
            quantityReserved: 0,
          }),
        ],
        [
          secondSellable.id,
          createStockRecord({
            id: createTestMikaId("stock", 2),
            sellableId: secondSellable.id,
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
    const baseAccountPut = repositories.account.put.bind(repositories.account);
    repositories.account.put = async (document) => {
      if (document.id === "entitlement_order_1_order_line_2") {
        throw new Error("Simulated entitlement persistence failure for order_line_2.");
      }
      return baseAccountPut(document);
    };
    const fake = createFakeMikaProvider({
      id: stripe,
      overrides: {
        verifyWebhook: async (webhookInput) =>
          createVerifiedWebhookPayload(webhookInput, {
            payloadHash: "partial_fulfillment_hash",
            parsed: { delivery: "event_partial_fulfillment" },
          }),
        parseWebhookEvent: async (verified) =>
          createPaymentWebhookEvent(verified, {
            providerEventId: "event_partial_fulfillment",
            providerCheckoutId: "provider_checkout_fake",
            providerPaymentId: "payment_partial_1",
            providerOrderId: "provider_order_partial_1",
            customer: { email: "Partial@Example.test", name: "Partial Shopper" },
          }),
      },
    });
    await repositories.catalog.put(
      createCatalogItemDocument({
        contentRef: createTestContentRef(),
        sellables: [firstSellable, secondSellable],
      }),
    );
    const api = createMikaBackendApi(
      createIncrementingBackendDependencies({
        repositories,
        providers: createMikaProviderRegistry([fake.provider]),
      }),
    );
    const shopperCtx = createTestRequestContext({
      sessionId: "session_partial",
      customerId: createTestMikaId("customer", 1),
      userId: "user_partial",
      idempotencyKey: "checkout_partial_1",
    });

    const firstCart = await api.cart.add(shopperCtx, { sellableId: firstSellable.id, quantity: 1 });
    if (!firstCart.ok) throw new Error("Expected first cart.add to succeed.");
    const cart = await api.cart.add(shopperCtx, { sellableId: secondSellable.id, quantity: 1 });
    if (!cart.ok) throw new Error("Expected second cart.add to succeed.");
    const checkout = await api.checkout.start(shopperCtx, {
      cartId: cart.data.id,
      provider: stripe,
    });
    if (!checkout.ok) throw new Error("Expected checkout.start to succeed.");

    await receiveWebhook(api, "partial-fulfillment", stripe).catch(() => undefined);

    const persistedOrder = await ledgerCollection.get("order_1");
    if (!persistedOrder) throw new Error("Expected order_1 to be persisted by forward progress.");
    const [line1, line2] = persistedOrder.aggregate.lines;
    expect(line1?.id).toBe("order_line_1");
    expect(line1?.entitlementId).toBe("entitlement_order_1_order_line_1");
    expect(line2?.id).toBe("order_line_2");
    expect(line2?.entitlementId).toBeUndefined();
    expect(persistedOrder.aggregate.metadata?.["fulfilledAt"]).toBeUndefined();
    expect(persistedOrder.status).toBe("paid");
    await expect(accountCollection.get("entitlement_order_1_order_line_1")).resolves.toMatchObject({
      type: "entitlement",
      status: "active",
    });
  });

  it("persists line progress before a final fulfilled-order ledger write failure", async () => {
    const stripe = createProviderName("stripe");
    const accountCollection = createStorageCollection("account");
    const sessionCollection = createStorageCollection("session");
    const ledgerCollection = createStorageCollection("ledger");
    const opsCollection = createStorageCollection("ops");
    const sellable = createSellableDefinition({
      id: createTestMikaId("sellable", 1),
      prices: [
        createPriceDefinition({
          id: createTestMikaId("price", 1),
          fulfillmentKind: "entitlement",
          entitlementKey: "course:final-write",
          providerRefs: [{ provider: stripe, productId: "prod_final", priceId: "price_final" }],
        }),
      ],
    });
    const repositories = {
      ...createTestBackendRepositories(),
      account: new AccountRepository(accountCollection),
      session: new SessionRepository(sessionCollection),
      ledger: new LedgerRepository(ledgerCollection),
      ops: new OpsRepository(opsCollection),
      stock: createTestStockRepository(
        new Map([
          [
            sellable.id,
            createStockRecord({
              id: createTestMikaId("stock", 1),
              sellableId: sellable.id,
              quantityOnHand: 5,
              quantityReserved: 0,
            }),
          ],
        ]),
      ),
    };
    const baseLedgerPut = repositories.ledger.put.bind(repositories.ledger);
    let finalWriteFailures = 0;
    repositories.ledger.put = async (document) => {
      const finalFulfilledOrderWrite =
        document.type === "order" &&
        document.id === "order_1" &&
        typeof document.aggregate.metadata?.["fulfilledAt"] === "string";
      if (finalFulfilledOrderWrite && finalWriteFailures === 0) {
        finalWriteFailures += 1;
        throw new Error("Simulated final fulfilled-order ledger write failure.");
      }
      return baseLedgerPut(document);
    };
    const fake = createFakeMikaProvider({
      id: stripe,
      overrides: {
        verifyWebhook: async (webhookInput) =>
          createVerifiedWebhookPayload(webhookInput, {
            payloadHash: "final_fulfillment_hash",
            parsed: { delivery: "event_final_fulfillment" },
          }),
        parseWebhookEvent: async (verified) =>
          createPaymentWebhookEvent(verified, {
            providerEventId: "event_final_fulfillment",
            providerCheckoutId: "provider_checkout_fake",
            providerPaymentId: "payment_final_1",
            providerOrderId: "provider_order_final_1",
            customer: { email: "Final@Example.test", name: "Final Shopper" },
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
      sessionId: "session_final",
      customerId: createTestMikaId("customer", 1),
      userId: "user_final",
      idempotencyKey: "checkout_final_1",
    });

    const cart = await api.cart.add(shopperCtx, { sellableId: sellable.id, quantity: 1 });
    if (!cart.ok) throw new Error("Expected cart.add to succeed.");
    const checkout = await api.checkout.start(shopperCtx, {
      cartId: cart.data.id,
      provider: stripe,
    });
    if (!checkout.ok) throw new Error("Expected checkout.start to succeed.");

    await receiveWebhook(api, "final-fulfillment", stripe).catch(() => undefined);

    expect(finalWriteFailures).toBe(1);
    const persistedOrder = await ledgerCollection.get("order_1");
    if (!persistedOrder) throw new Error("Expected order_1 to be persisted.");
    const [line] = persistedOrder.aggregate.lines;
    expect(line?.entitlementId).toBe("entitlement_order_1_order_line_1");
    expect(persistedOrder.aggregate.metadata?.["fulfilledAt"]).toBeUndefined();
    await expect(opsCollection.count({ type: "email" })).resolves.toBe(0);
    await expect(accountCollection.get("entitlement_order_1_order_line_1")).resolves.toMatchObject({
      type: "entitlement",
      status: "active",
    });
  });

  it("retries download-ready notifications after an order was already marked fulfilled", async () => {
    const stripe = createProviderName("stripe");
    const sessionCollection = createStorageCollection("session");
    const ledgerCollection = createStorageCollection("ledger");
    const opsCollection = createStorageCollection("ops");
    const sellable = createSellableDefinition({
      id: createTestMikaId("sellable", 1),
      prices: [
        createPriceDefinition({
          id: createTestMikaId("price", 1),
          fulfillmentKind: "download",
          providerRefs: [
            { provider: stripe, productId: "prod_download", priceId: "price_download" },
          ],
        }),
      ],
    });
    const repositories = {
      ...createTestBackendRepositories(),
      session: new SessionRepository(sessionCollection),
      ledger: new LedgerRepository(ledgerCollection),
      ops: new OpsRepository(opsCollection),
      stock: createTestStockRepository(
        new Map([
          [
            sellable.id,
            createStockRecord({
              id: createTestMikaId("stock", 1),
              sellableId: sellable.id,
              quantityOnHand: 5,
              quantityReserved: 0,
            }),
          ],
        ]),
      ),
    };
    const fake = createFakeMikaProvider({
      id: stripe,
      overrides: {
        verifyWebhook: async (webhookInput) =>
          createVerifiedWebhookPayload(webhookInput, {
            payloadHash: "download_ready_retry_hash",
            parsed: { delivery: "event_download_ready_retry" },
          }),
        parseWebhookEvent: async (verified) =>
          createPaymentWebhookEvent(verified, {
            providerEventId: "event_download_ready_retry",
            providerCheckoutId: "provider_checkout_fake",
            providerPaymentId: "payment_download_ready_retry",
            providerOrderId: "provider_order_download_ready_retry",
            customer: { email: "DownloadReady@Example.test", name: "Download Ready" },
          }),
      },
    });
    await repositories.catalog.put(
      createCatalogItemDocument({ contentRef: createTestContentRef(), sellables: [sellable] }),
    );
    const notificationIntents: MikaNotificationIntent[] = [];
    let failFirstDownloadReady = true;
    const api = createMikaBackendApi(
      createIncrementingBackendDependencies({
        repositories,
        providers: createMikaProviderRegistry([fake.provider]),
        notifications: {
          handle: (intent) => {
            notificationIntents.push(intent);
            if (intent.kind === "download.ready" && failFirstDownloadReady) {
              failFirstDownloadReady = false;
              throw new Error("download notification unavailable");
            }
          },
        },
      }),
    );
    const shopperCtx = createTestRequestContext({
      sessionId: "session_download_ready_retry",
      customerId: createTestMikaId("customer", 1),
      userId: "user_download_ready_retry",
      idempotencyKey: "checkout_download_ready_retry",
    });
    const cart = await api.cart.add(shopperCtx, { sellableId: sellable.id, quantity: 1 });
    if (!cart.ok) throw new Error("Expected cart.add to succeed.");
    const checkout = await api.checkout.start(shopperCtx, {
      cartId: cart.data.id,
      provider: stripe,
    });
    if (!checkout.ok) throw new Error("Expected checkout.start to succeed.");

    await expect(receiveWebhook(api, "download-ready-fails", stripe)).resolves.toMatchObject({
      ok: true,
      status: 200,
      data: { id: "webhook_1", status: "received" },
    });
    await expect(
      repositories.ledger.findOrderById(createTestMikaId("order", 1)),
    ).resolves.toMatchObject({
      aggregate: {
        lines: [{ downloadRefs: ["download:order_1:order_line_1"] }],
        metadata: { fulfilledAt: TEST_NOW },
      },
    });
    await expect(
      opsCollection.get("workflow_download_order_1_order_line_1_notification_download_ready"),
    ).resolves.toMatchObject({
      status: "completed",
      record: { lastError: undefined },
    });

    await expect(receiveWebhook(api, "download-ready-redelivery", stripe)).resolves.toMatchObject({
      ok: true,
      status: 200,
      data: { id: "webhook_1", status: "duplicate" },
    });

    expect(notificationIntents.filter((intent) => intent.kind === "download.ready")).toHaveLength(
      1,
    );
    await expect(
      opsCollection.get("workflow_download_order_1_order_line_1_notification_download_ready"),
    ).resolves.toMatchObject({
      status: "completed",
      idempotencyKey: "download.ready:download:order_1:order_line_1",
    });
    await expect(opsCollection.count({ type: "email" })).resolves.toBe(1);

    await expect(
      receiveWebhook(api, "download-ready-third-delivery", stripe),
    ).resolves.toMatchObject({
      ok: true,
      status: 200,
      data: { id: "webhook_1", status: "duplicate" },
    });
    expect(notificationIntents.filter((intent) => intent.kind === "download.ready")).toHaveLength(
      1,
    );
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
    const notificationIntents: MikaNotificationIntent[] = [];
    const api = createMikaBackendApi(
      createIncrementingBackendDependencies({
        repositories,
        providers: createMikaProviderRegistry([fake.provider]),
        notifications: {
          handle: (intent) => {
            notificationIntents.push(intent);
          },
        },
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
    expect(notificationIntents).toHaveLength(3);
    expect(notificationIntents[0]).toMatchObject({
      kind: "license.issued",
      occurredAt: TEST_NOW,
      context: {
        toEmail: "Fulfillment@Example.test",
        licenseId: "license_order_1_order_line_2",
        orderId: "order_1",
        orderLineId: "order_line_2",
        customerId: "customer_1",
        displayKeySuffix: expect.any(String),
        sellableId: licenseSellable.id,
        fulfillmentKind: "license",
      },
    });
    expect(notificationIntents[1]).toMatchObject({
      kind: "order.confirmed",
      occurredAt: TEST_NOW,
      context: {
        toEmail: "Fulfillment@Example.test",
        orderId: "order_1",
        orderNumber: "order_1",
        customerId: "customer_1",
        provider: stripe,
        providerPaymentId: "payment_fulfillment_1",
        providerOrderId: "provider_order_fulfillment_1",
        checkoutSessionId: "checkout_1",
        total: { amount: 3600, currency: TEST_CURRENCY },
        fulfillmentKinds: ["entitlement", "license", "download"],
        fulfilledLines: [
          {
            lineId: "order_line_1",
            quantity: 1,
            fulfillmentKind: "entitlement",
            entitlementId: "entitlement_order_1_order_line_1",
            stockMovementId: "stock_event_1",
          },
          {
            lineId: "order_line_2",
            quantity: 1,
            fulfillmentKind: "license",
            licenseKeySuffix: expect.any(String),
            stockMovementId: "stock_event_2",
          },
          {
            lineId: "order_line_3",
            quantity: 1,
            fulfillmentKind: "download",
            downloadRefs: ["download:order_1:order_line_3"],
            stockMovementId: "stock_event_3",
          },
        ],
      },
    });
    expect(notificationIntents[2]).toMatchObject({
      kind: "download.ready",
      occurredAt: TEST_NOW,
      context: {
        toEmail: "Fulfillment@Example.test",
        downloadRef: "download:order_1:order_line_3",
        orderId: "order_1",
        orderLineId: "order_line_3",
        customerId: "customer_1",
        title: "Test sellable",
      },
    });
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

  it("routes license.issued and download.ready through exactly-once notification markers", async () => {
    const stripe = createProviderName("stripe");
    const accountCollection = createStorageCollection("account");
    const sessionCollection = createStorageCollection("session");
    const ledgerCollection = createStorageCollection("ledger");
    const opsCollection = createStorageCollection("ops");
    const licenseSellable = createSellableDefinition({
      id: createTestMikaId("sellable", 1),
      prices: [
        createPriceDefinition({
          id: createTestMikaId("price", 1),
          fulfillmentKind: "license",
          providerRefs: [{ provider: stripe, productId: "prod_license", priceId: "price_license" }],
        }),
      ],
    });
    const downloadSellable = createSellableDefinition({
      id: createTestMikaId("sellable", 2),
      prices: [
        createPriceDefinition({
          id: createTestMikaId("price", 2),
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
          licenseSellable.id,
          createStockRecord({
            id: createTestMikaId("stock", 1),
            sellableId: licenseSellable.id,
            quantityOnHand: 5,
            quantityReserved: 0,
          }),
        ],
        [
          downloadSellable.id,
          createStockRecord({
            id: createTestMikaId("stock", 2),
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
    const fake = createFakeMikaProvider({
      id: stripe,
      overrides: {
        verifyWebhook: async (webhookInput) =>
          createVerifiedWebhookPayload(webhookInput, {
            payloadHash: "license_marker_hash",
            parsed: { delivery: "event_license_marker" },
          }),
        parseWebhookEvent: async (verified) =>
          createPaymentWebhookEvent(verified, {
            providerEventId: "event_license_marker",
            providerCheckoutId: "provider_checkout_fake",
            providerPaymentId: "payment_license_marker",
            providerOrderId: "provider_order_license_marker",
            customer: { email: "Fulfillment@Example.test", name: "Fulfillment Shopper" },
          }),
      },
    });
    await repositories.catalog.put(
      createCatalogItemDocument({
        contentRef: createTestContentRef(),
        sellables: [licenseSellable, downloadSellable],
      }),
    );
    const notificationIntents: MikaNotificationIntent[] = [];
    const api = createMikaBackendApi(
      createIncrementingBackendDependencies({
        repositories,
        providers: createMikaProviderRegistry([fake.provider]),
        notifications: {
          handle: (intent) => {
            notificationIntents.push(intent);
          },
        },
      }),
    );
    const shopperCtx = createTestRequestContext({
      sessionId: "session_license_marker",
      customerId: createTestMikaId("customer", 1),
      userId: "user_license_marker",
      idempotencyKey: "checkout_license_marker",
    });
    const licenseCart = await api.cart.add(shopperCtx, {
      sellableId: licenseSellable.id,
      quantity: 1,
    });
    if (!licenseCart.ok) throw new Error("Expected license cart.add to succeed.");
    const cart = await api.cart.add(shopperCtx, { sellableId: downloadSellable.id, quantity: 1 });
    if (!cart.ok) throw new Error("Expected download cart.add to succeed.");
    const checkout = await api.checkout.start(shopperCtx, {
      cartId: cart.data.id,
      provider: stripe,
    });
    if (!checkout.ok) throw new Error("Expected checkout.start to succeed.");

    await expect(receiveWebhook(api, "license-marker", stripe)).resolves.toMatchObject({
      ok: true,
      status: 200,
      data: { status: "received" },
    });

    await expect(accountCollection.get("license_order_1_order_line_1")).resolves.toMatchObject({
      type: "license",
      status: "active",
    });
    expect(notificationIntents.filter((intent) => intent.kind === "license.issued")).toHaveLength(
      1,
    );
    await expect(
      opsCollection.get("workflow_order_1_order_line_1_notification_license_issued"),
    ).resolves.toMatchObject({
      type: "workflow",
      status: "completed",
      kind: "notification.license.issued",
      idempotencyKey: "license.issued:order_1:order_line_1",
    });
    expect(notificationIntents.filter((intent) => intent.kind === "download.ready")).toHaveLength(
      1,
    );
    await expect(
      opsCollection.get("workflow_download_order_1_order_line_2_notification_download_ready"),
    ).resolves.toMatchObject({
      type: "workflow",
      status: "completed",
      kind: "notification.download.ready",
      idempotencyKey: "download.ready:download:order_1:order_line_2",
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
      findOrderByDownloadRef: (downloadRef) => baseLedger.findOrderByDownloadRef(downloadRef),
      listOrdersByCustomer: (customerId, limit) =>
        baseLedger.listOrdersByCustomer(customerId, limit),
      listOrdersByEmailHash: (emailHash, limit) =>
        baseLedger.listOrdersByEmailHash(emailHash, limit),
      anonymizeOrdersForAccountDelete: (anonymizeInput) =>
        baseLedger.anonymizeOrdersForAccountDelete(anonymizeInput),
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

  it("defers concurrent payment webhooks for the same provider payment", async () => {
    const stripe = createProviderName("stripe");
    const ledgerCollection = createStorageCollection("ledger");
    const opsCollection = createStorageCollection("ops");
    const ledger = new LedgerRepository(ledgerCollection);
    const originalLedgerPut = ledger.put.bind(ledger);
    let holdOrderUpdate = false;
    let releaseOrderUpdate!: () => void;
    let enterOrderUpdate!: () => void;
    const orderUpdateEntered = new Promise<void>((resolve) => {
      enterOrderUpdate = resolve;
    });
    const orderUpdateRelease = new Promise<void>((resolve) => {
      releaseOrderUpdate = resolve;
    });
    ledger.put = async (document) => {
      if (
        holdOrderUpdate &&
        document.type === "order" &&
        document.providerPaymentId === "payment_lock"
      ) {
        holdOrderUpdate = false;
        enterOrderUpdate();
        await orderUpdateRelease;
      }

      await originalLedgerPut(document);
    };
    const repositories = {
      ...createTestBackendRepositories(),
      ledger,
      ops: new OpsRepository(opsCollection),
    };
    const fake = createFakeMikaProvider({
      id: stripe,
      overrides: {
        verifyWebhook: async (webhookInput) => {
          const marker = webhookMarkerFromRawBody(webhookInput.rawBody);

          return createVerifiedWebhookPayload(webhookInput, {
            payloadHash: `hash_${marker}`,
            parsed: { marker },
          });
        },
        parseWebhookEvent: async (verified) => {
          const marker =
            isJsonObject(verified.parsed) && typeof verified.parsed["marker"] === "string"
              ? verified.parsed["marker"]
              : "unknown";

          return createPaymentWebhookEvent(verified, {
            providerEventId: `event_${marker}`,
            providerPaymentId: "payment_lock",
            providerOrderId: "provider_order_lock",
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
    await repositories.ledger.put(
      createOrderDocument({
        provider: stripe,
        providerPaymentId: "payment_lock",
        providerOrderId: "provider_order_lock",
      }),
    );
    holdOrderUpdate = true;

    const first = receiveWebhook(api, "payment-lock-first", stripe);
    await orderUpdateEntered;

    await expect(receiveWebhook(api, "payment-lock-second", stripe)).resolves.toMatchObject({
      ok: false,
      status: 409,
      error: {
        code: "CONFLICT",
        message:
          "Webhook 'webhook_2' is awaiting fulfillment and was not processed; retry delivery.",
      },
    });
    await expect(opsCollection.get("webhook_2")).resolves.toMatchObject({
      status: "received",
      record: { status: "received" },
    });

    releaseOrderUpdate();
    await expect(first).resolves.toMatchObject({
      ok: true,
      status: 200,
      data: { id: "webhook_1", status: "received" },
    });
    await expect(opsCollection.get("webhook_1")).resolves.toMatchObject({
      status: "processed",
      record: { status: "processed", relatedOrderId: "order_1" },
    });

    await expect(receiveWebhook(api, "payment-lock-second", stripe)).resolves.toMatchObject({
      ok: true,
      status: 200,
      data: { id: "webhook_2", status: "received" },
    });
    await expect(opsCollection.get("webhook_2")).resolves.toMatchObject({
      status: "processed",
      record: { status: "processed", relatedOrderId: "order_1" },
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
    const notificationIntents: MikaNotificationIntent[] = [];
    const api = createMikaBackendApi(
      createIncrementingBackendDependencies({
        repositories,
        providers: createMikaProviderRegistry([fake.provider]),
        notifications: {
          handle: (intent) => {
            notificationIntents.push(intent);
          },
        },
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
    expect(notificationIntents).toEqual([
      expect.objectContaining({
        kind: "subscription.started",
        occurredAt: TEST_NOW,
        context: expect.objectContaining({
          toEmail: "Subscriber@Example.test",
          subscriptionId: "subscription_1",
          status: "active",
          provider: stripe,
          providerCustomerId: "provider_customer_1",
          providerSubscriptionId: "provider_subscription_1",
          providerPriceId: "price_sub",
          currentPeriodEnd: "2026-02-01T00:00:00.000Z",
          sellableId: subscriptionSellable.id,
          entitlementId: "entitlement_subscription_1_subscription",
          eventType: "customer.subscription.updated",
        }),
      }),
      expect.objectContaining({
        kind: "subscription.updated",
        occurredAt: TEST_NOW,
        context: expect.objectContaining({
          subscriptionId: "subscription_1",
          status: "cancel_at_period_end",
          previousStatus: "active",
          provider: stripe,
          currentPeriodEnd: "2026-03-01T00:00:00.000Z",
          cancelAtPeriodEnd: true,
        }),
      }),
    ]);
  });

  it("defers concurrent subscription webhooks for the same provider subscription", async () => {
    const stripe = createProviderName("stripe");
    const accountCollection = createStorageCollection("account");
    const opsCollection = createStorageCollection("ops");
    const account = new AccountRepository(accountCollection);
    const originalAccountPut = account.put.bind(account);
    let holdSubscriptionWrite = false;
    let releaseSubscriptionWrite!: () => void;
    let enterSubscriptionWrite!: () => void;
    const subscriptionWriteEntered = new Promise<void>((resolve) => {
      enterSubscriptionWrite = resolve;
    });
    const subscriptionWriteRelease = new Promise<void>((resolve) => {
      releaseSubscriptionWrite = resolve;
    });
    account.put = async (document) => {
      if (
        holdSubscriptionWrite &&
        document.type === "subscription" &&
        document.providerSubscriptionId === "provider_subscription_lock"
      ) {
        holdSubscriptionWrite = false;
        enterSubscriptionWrite();
        await subscriptionWriteRelease;
      }

      await originalAccountPut(document);
    };
    const subscriptionSellable = createSellableDefinition({
      prices: [
        createPriceDefinition({
          id: createTestMikaId("price", 1),
          mode: "subscription",
          fulfillmentKind: "entitlement",
          entitlementKey: "course:subscription-lock",
          providerRefs: [{ provider: stripe, productId: "prod_sub", priceId: "price_sub" }],
        }),
      ],
    });
    const repositories = {
      ...createTestBackendRepositories(),
      account,
      ops: new OpsRepository(opsCollection),
    };
    const fake = createFakeMikaProvider({
      id: stripe,
      overrides: {
        verifyWebhook: async (webhookInput) => {
          const marker = webhookMarkerFromRawBody(webhookInput.rawBody);

          return createVerifiedWebhookPayload(webhookInput, {
            payloadHash: `hash_${marker}`,
            parsed: { marker },
          });
        },
        parseWebhookEvent: async (verified) => {
          const marker =
            isJsonObject(verified.parsed) && typeof verified.parsed["marker"] === "string"
              ? verified.parsed["marker"]
              : "unknown";
          const second = marker === "subscription-lock-second";

          return createSubscriptionWebhookEvent(verified, {
            providerEventId: `event_${marker}`,
            providerSubscriptionId: "provider_subscription_lock",
            providerCustomerId: "provider_customer_1",
            providerPriceId: "price_sub",
            status: second ? "cancel_at_period_end" : "active",
            currentPeriodStart: createISODateTime(
              second ? "2026-02-01T00:00:00.000Z" : "2026-01-01T00:00:00.000Z",
            ),
            currentPeriodEnd: createISODateTime(
              second ? "2026-03-01T00:00:00.000Z" : "2026-02-01T00:00:00.000Z",
            ),
            cancelAtPeriodEnd: second ? true : undefined,
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
    holdSubscriptionWrite = true;

    const first = receiveWebhook(api, "subscription-lock-first", stripe);
    await subscriptionWriteEntered;

    await expect(receiveWebhook(api, "subscription-lock-second", stripe)).resolves.toMatchObject({
      ok: false,
      status: 409,
      error: {
        code: "CONFLICT",
        message:
          "Webhook 'webhook_2' is awaiting fulfillment and was not processed; retry delivery.",
      },
    });
    await expect(opsCollection.get("webhook_2")).resolves.toMatchObject({
      status: "received",
      record: { status: "received" },
    });

    releaseSubscriptionWrite();
    await expect(first).resolves.toMatchObject({
      ok: true,
      status: 200,
      data: { id: "webhook_1", status: "received" },
    });
    await expect(accountCollection.get("subscription_1")).resolves.toMatchObject({
      status: "active",
      currentPeriodEnd: "2026-02-01T00:00:00.000Z",
    });

    await expect(receiveWebhook(api, "subscription-lock-second", stripe)).resolves.toMatchObject({
      ok: true,
      status: 200,
      data: { id: "webhook_2", status: "received" },
    });
    await expect(accountCollection.get("subscription_1")).resolves.toMatchObject({
      status: "cancel_at_period_end",
      currentPeriodEnd: "2026-03-01T00:00:00.000Z",
      aggregate: {
        status: "cancel_at_period_end",
        cancelAtPeriodEnd: true,
      },
    });
    await expect(opsCollection.get("webhook_2")).resolves.toMatchObject({
      status: "processed",
      record: { status: "processed", relatedSubscriptionId: "subscription_1" },
    });
  });

  it("ignores a stale out-of-order subscription event so a cancelled sub is not re-activated", async () => {
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
        payloadHash: "sub_active_hash",
        providerEventId: "event_active",
        status: "active" as const,
        currentPeriodStart: createISODateTime("2026-02-01T00:00:00.000Z"),
        currentPeriodEnd: createISODateTime("2026-03-01T00:00:00.000Z"),
      },
      {
        payloadHash: "sub_cancelled_hash",
        providerEventId: "event_cancelled",
        status: "cancelled" as const,
        currentPeriodStart: createISODateTime("2026-02-01T00:00:00.000Z"),
        currentPeriodEnd: createISODateTime("2026-03-01T00:00:00.000Z"),
      },
      {
        payloadHash: "sub_stale_active_hash",
        providerEventId: "event_stale_active",
        status: "active" as const,
        currentPeriodStart: createISODateTime("2026-01-01T00:00:00.000Z"),
        currentPeriodEnd: createISODateTime("2026-02-01T00:00:00.000Z"),
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

    await receiveWebhook(api, "subscription-active", stripe);
    await receiveWebhook(api, "subscription-cancelled", stripe);
    await expect(accountCollection.get("subscription_1")).resolves.toMatchObject({
      status: "cancelled",
    });
    await expect(
      accountCollection.get("entitlement_subscription_1_subscription"),
    ).resolves.toMatchObject({ status: "expired" });

    await receiveWebhook(api, "subscription-stale-active", stripe);
    await expect(accountCollection.get("subscription_1")).resolves.toMatchObject({
      status: "cancelled",
    });
    await expect(
      accountCollection.get("entitlement_subscription_1_subscription"),
    ).resolves.toMatchObject({ status: "expired" });
  });

  it("keeps a locally-applied cancel_at_period_end against an equal-period active webhook", async () => {
    const accountCollection = createStorageCollection("account");
    const repositories = {
      ...createTestBackendRepositories(),
      account: new AccountRepository(accountCollection),
    };
    const periodStart = createISODateTime("2026-02-01T00:00:00.000Z");
    const periodEnd = createISODateTime("2026-03-01T00:00:00.000Z");
    const baseSubscription = createSubscriptionDocument();
    const subscription: SubscriptionDocument = {
      ...baseSubscription,
      status: "cancel_at_period_end",
      aggregate: {
        ...baseSubscription.aggregate,
        status: "cancel_at_period_end",
        cancelAtPeriodEnd: true,
        currentPeriodStart: periodStart,
        currentPeriodEnd: periodEnd,
      },
    };
    const deliveries = [
      { payloadHash: "sub_replay_hash", providerEventId: "event_replay", cancelAtPeriodEnd: false },
      { payloadHash: "sub_echo_hash", providerEventId: "event_echo", cancelAtPeriodEnd: true },
    ];
    const fake = createFakeMikaProvider({
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
            status: "active",
            currentPeriodStart: periodStart,
            currentPeriodEnd: periodEnd,
            cancelAtPeriodEnd: delivery.cancelAtPeriodEnd,
          });
        },
      },
    });
    await repositories.account.put(createCustomerDocument());
    await repositories.account.put(subscription);
    const api = createMikaBackendApi(
      createIncrementingBackendDependencies({
        repositories,
        providers: createMikaProviderRegistry([fake.provider]),
      }),
    );

    await expect(receiveWebhook(api, "subscription-cancel-replay")).resolves.toMatchObject({
      ok: true,
      status: 200,
      data: { status: "received" },
    });
    await expect(accountCollection.get("subscription_1")).resolves.toMatchObject({
      type: "subscription",
      status: "cancel_at_period_end",
      aggregate: {
        status: "cancel_at_period_end",
        cancelAtPeriodEnd: true,
        currentPeriodStart: "2026-02-01T00:00:00.000Z",
      },
    });

    await expect(receiveWebhook(api, "subscription-cancel-echo")).resolves.toMatchObject({
      ok: true,
      status: 200,
      data: { status: "received" },
    });
    await expect(accountCollection.get("subscription_1")).resolves.toMatchObject({
      type: "subscription",
      status: "cancel_at_period_end",
      aggregate: { status: "cancel_at_period_end", cancelAtPeriodEnd: true },
    });
  });

  it("reactivates a cancel_at_period_end subscription when a newer-period active webhook arrives", async () => {
    const accountCollection = createStorageCollection("account");
    const repositories = {
      ...createTestBackendRepositories(),
      account: new AccountRepository(accountCollection),
    };
    const baseSubscription = createSubscriptionDocument();
    const subscription: SubscriptionDocument = {
      ...baseSubscription,
      status: "cancel_at_period_end",
      aggregate: {
        ...baseSubscription.aggregate,
        status: "cancel_at_period_end",
        cancelAtPeriodEnd: true,
        currentPeriodStart: createISODateTime("2026-02-01T00:00:00.000Z"),
        currentPeriodEnd: createISODateTime("2026-03-01T00:00:00.000Z"),
      },
    };
    const fake = createFakeMikaProvider({
      overrides: {
        verifyWebhook: async (webhookInput) =>
          createVerifiedWebhookPayload(webhookInput, {
            payloadHash: "sub_renewal_hash",
            parsed: { delivery: "event_renewal" },
          }),
        parseWebhookEvent: async (verified) =>
          createSubscriptionWebhookEvent(verified, {
            providerEventId: "event_renewal",
            providerSubscriptionId: "provider_subscription_1",
            providerCustomerId: "provider_customer_1",
            status: "active",
            currentPeriodStart: createISODateTime("2026-03-01T00:00:00.000Z"),
            currentPeriodEnd: createISODateTime("2026-04-01T00:00:00.000Z"),
            cancelAtPeriodEnd: false,
          }),
      },
    });
    await repositories.account.put(createCustomerDocument());
    await repositories.account.put(subscription);
    const api = createMikaBackendApi(
      createIncrementingBackendDependencies({
        repositories,
        providers: createMikaProviderRegistry([fake.provider]),
      }),
    );

    await expect(receiveWebhook(api, "subscription-renewal")).resolves.toMatchObject({
      ok: true,
      status: 200,
      data: { status: "received" },
    });
    await expect(accountCollection.get("subscription_1")).resolves.toMatchObject({
      type: "subscription",
      status: "active",
      aggregate: {
        status: "active",
        cancelAtPeriodEnd: false,
        currentPeriodStart: "2026-03-01T00:00:00.000Z",
      },
    });
  });

  it("keeps terminal and renewed subscription state against equal-period active webhook echoes", async () => {
    const periodStart = createISODateTime("2026-02-01T00:00:00.000Z");
    const periodEnd = createISODateTime("2026-03-01T00:00:00.000Z");

    const cases = [
      {
        name: "terminal-cancelled",
        subscription: (() => {
          const base = createSubscriptionDocument();
          return {
            ...base,
            status: "cancelled" as const,
            aggregate: {
              ...base.aggregate,
              status: "cancelled" as const,
              currentPeriodStart: periodStart,
              currentPeriodEnd: periodEnd,
            },
          };
        })(),
        seed: async () => {},
        expected: { status: "cancelled", cancelAtPeriodEnd: false },
      },
      {
        name: "renew-cleared-cancel",
        subscription: (() => {
          const base = createSubscriptionDocument();
          return {
            ...base,
            status: "active" as const,
            aggregate: {
              ...base.aggregate,
              status: "active" as const,
              cancelAtPeriodEnd: false,
              currentPeriodStart: periodStart,
              currentPeriodEnd: periodEnd,
              metadata: { lastAdminAction: "subscription.renew" },
            },
          };
        })(),
        seed: async () => {},
        expected: { status: "active", cancelAtPeriodEnd: false },
      },
    ];

    for (const testCase of cases) {
      const accountCollection = createStorageCollection("account");
      const repositories = {
        ...createTestBackendRepositories(),
        account: new AccountRepository(accountCollection),
      };
      const fake = createFakeMikaProvider({
        overrides: {
          verifyWebhook: async (webhookInput) =>
            createVerifiedWebhookPayload(webhookInput, {
              payloadHash: `${testCase.name}_subscription_echo_hash`,
              parsed: { delivery: `${testCase.name}_event` },
            }),
          parseWebhookEvent: async (verified) =>
            createSubscriptionWebhookEvent(verified, {
              providerEventId: `${testCase.name}_event`,
              providerSubscriptionId: "provider_subscription_1",
              providerCustomerId: "provider_customer_1",
              status: "active",
              currentPeriodStart: periodStart,
              currentPeriodEnd: periodEnd,
              cancelAtPeriodEnd: true,
            }),
        },
      });
      const api = createMikaBackendApi(
        createIncrementingBackendDependencies({
          repositories,
          providers: createMikaProviderRegistry([fake.provider]),
        }),
      );

      await repositories.account.put(createCustomerDocument());
      await repositories.account.put(testCase.subscription);
      await testCase.seed();

      await expect(receiveWebhook(api, testCase.name)).resolves.toMatchObject({
        ok: true,
        status: 200,
        data: { status: "received" },
      });
      await expect(accountCollection.get("subscription_1")).resolves.toMatchObject({
        type: "subscription",
        status: testCase.expected.status,
        aggregate: {
          status: testCase.expected.status,
          cancelAtPeriodEnd: testCase.expected.cancelAtPeriodEnd,
          currentPeriodStart: "2026-02-01T00:00:00.000Z",
        },
      });
    }
  });

  it("resnapshots subscription sellable state when webhook price changes", async () => {
    const stripe = createProviderName("stripe");
    const accountCollection = createStorageCollection("account");
    const repositories = {
      ...createTestBackendRepositories(),
      account: new AccountRepository(accountCollection),
    };
    const basicPrice = createPriceDefinition({
      id: createTestMikaId("price", 1),
      titleSnapshot: "Basic subscription",
      mode: "subscription",
      fulfillmentKind: "entitlement",
      entitlementKey: "course:basic",
      providerRefs: [{ provider: stripe, productId: "prod_sub", priceId: "price_basic" }],
    });
    const proPrice = createPriceDefinition({
      id: createTestMikaId("price", 2),
      titleSnapshot: "Pro subscription",
      mode: "subscription",
      fulfillmentKind: "entitlement",
      entitlementKey: "course:pro",
      providerRefs: [{ provider: stripe, productId: "prod_sub", priceId: "price_pro" }],
    });
    const sellable = createSellableDefinition({
      prices: [basicPrice, proPrice],
    });
    const baseSubscription = createSubscriptionDocument({ provider: stripe });
    const subscription: SubscriptionDocument = {
      ...baseSubscription,
      provider: stripe,
      aggregate: {
        ...baseSubscription.aggregate,
        sellable: createPurchasableSnapshot({
          titleSnapshot: "Basic subscription",
          mode: "subscription",
          fulfillmentKind: "entitlement",
          entitlementKey: "course:basic",
          priceId: basicPrice.id,
        }),
        providerRef: {
          ...baseSubscription.aggregate.providerRef,
          provider: stripe,
          priceId: "price_basic",
        },
      },
    };
    const fake = createFakeMikaProvider({
      id: stripe,
      overrides: {
        verifyWebhook: async (webhookInput) =>
          createVerifiedWebhookPayload(webhookInput, {
            payloadHash: "subscription_price_changed_hash",
            parsed: { delivery: "event_subscription_price_changed" },
          }),
        parseWebhookEvent: async (verified) =>
          createSubscriptionWebhookEvent(verified, {
            providerEventId: "event_subscription_price_changed",
            providerSubscriptionId: "provider_subscription_1",
            providerCustomerId: "provider_customer_1",
            providerPriceId: "price_pro",
            status: "active",
          }),
      },
    });
    await repositories.catalog.put(
      createCatalogItemDocument({ contentRef: createTestContentRef(), sellables: [sellable] }),
    );
    await repositories.account.put(createCustomerDocument());
    await repositories.account.put(subscription);
    const api = createMikaBackendApi(
      createIncrementingBackendDependencies({
        repositories,
        providers: createMikaProviderRegistry([fake.provider]),
      }),
    );

    await expect(receiveWebhook(api, "subscription-price-changed", stripe)).resolves.toMatchObject({
      ok: true,
      status: 200,
      data: { status: "received" },
    });

    await expect(accountCollection.get("subscription_1")).resolves.toMatchObject({
      type: "subscription",
      aggregate: {
        sellable: {
          priceId: proPrice.id,
          titleSnapshot: "Pro subscription",
          entitlementKey: "course:pro",
        },
        providerRef: { priceId: "price_pro" },
      },
    });
    await expect(
      accountCollection.get("entitlement_subscription_1_subscription"),
    ).resolves.toMatchObject({
      type: "entitlement",
      entitlementKey: "course:pro",
      record: { entitlementKey: "course:pro" },
    });
  });

  it("emits subscription renewal-failed notifications from past-due webhooks", async () => {
    const stripe = createProviderName("stripe");
    const accountCollection = createStorageCollection("account");
    const opsCollection = createStorageCollection("ops");
    const repositories = {
      ...createTestBackendRepositories(),
      account: new AccountRepository(accountCollection),
      ops: new OpsRepository(opsCollection),
    };
    const activeSubscription = createSubscriptionDocument({
      provider: stripe,
      providerCustomerId: "provider_customer_renewal",
      providerSubscriptionId: "provider_subscription_renewal",
      aggregate: {
        ...createSubscriptionDocument().aggregate,
        providerRef: {
          provider: stripe,
          customerId: "provider_customer_renewal",
          subscriptionId: "provider_subscription_renewal",
          priceId: "price_sub",
        },
      },
    });
    const fake = createFakeMikaProvider({
      id: stripe,
      overrides: {
        verifyWebhook: async (webhookInput) =>
          createVerifiedWebhookPayload(webhookInput, {
            payloadHash: "subscription_renewal_failed_hash",
            parsed: { delivery: "event_subscription_renewal_failed" },
          }),
        parseWebhookEvent: async (verified) =>
          createSubscriptionWebhookEvent(verified, {
            providerEventId: "event_subscription_renewal_failed",
            providerSubscriptionId: "provider_subscription_renewal",
            providerCustomerId: "provider_customer_renewal",
            providerPriceId: "price_sub",
            status: "past_due",
            currentPeriodEnd: createISODateTime("2026-02-01T00:00:00.000Z"),
          }),
      },
    });
    await repositories.account.put(activeSubscription);
    const notificationIntents: MikaNotificationIntent[] = [];
    const api = createMikaBackendApi(
      createIncrementingBackendDependencies({
        repositories,
        providers: createMikaProviderRegistry([fake.provider]),
        notifications: {
          handle: (intent) => {
            notificationIntents.push(intent);
          },
        },
      }),
    );

    await expect(receiveWebhook(api, "subscription-renewal-failed", stripe)).resolves.toMatchObject(
      {
        ok: true,
        status: 200,
        data: { id: "webhook_1", status: "received" },
      },
    );

    await expect(accountCollection.get("subscription_1")).resolves.toMatchObject({
      status: "past_due",
      currentPeriodEnd: "2026-02-01T00:00:00.000Z",
    });
    await expect(
      accountCollection.get("entitlement_subscription_1_subscription"),
    ).resolves.toMatchObject({
      type: "entitlement",
      status: "active",
      record: { sourceStatus: "past_due", status: "active" },
    });
    expect(notificationIntents).toEqual([
      expect.objectContaining({
        kind: "subscription.renewal_failed",
        occurredAt: TEST_NOW,
        context: expect.objectContaining({
          toEmail: "Subscriber@Example.test",
          subscriptionId: "subscription_1",
          status: "past_due",
          previousStatus: "active",
          provider: stripe,
          providerCustomerId: "provider_customer_renewal",
          providerSubscriptionId: "provider_subscription_renewal",
          providerPriceId: "price_sub",
          currentPeriodEnd: "2026-02-01T00:00:00.000Z",
        }),
      }),
    ]);
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
    await expect(
      receiveWebhook(api, "subscription-unknown-duplicate", stripe),
    ).resolves.toMatchObject({
      ok: true,
      status: 200,
      data: { id: "webhook_1", status: "duplicate", replayable: true },
    });

    await expect(accountCollection.count({ type: "subscription" })).resolves.toBe(0);
    await expect(accountCollection.count({ type: "entitlement" })).resolves.toBe(0);
    await expect(opsCollection.count({ type: "webhook" })).resolves.toBe(1);
    await expect(opsCollection.get("webhook_1")).resolves.toMatchObject({
      status: "failed",
      record: {
        status: "failed",
        lastError: "Subscription event could not be linked to a subscription.",
      },
    });
  });

  it("does not refresh subscription entitlements for anonymized customers", async () => {
    const stripe = createProviderName("stripe");
    const accountCollection = createStorageCollection("account");
    const opsCollection = createStorageCollection("ops");
    const repositories = {
      ...createTestBackendRepositories(),
      account: new AccountRepository(accountCollection),
      ops: new OpsRepository(opsCollection),
    };
    const customer = createCustomerDocument({
      aggregate: {
        ...createCustomerDocument().aggregate,
        metadata: { anonymizedAt: TEST_NOW },
      },
    });
    const subscription = createSubscriptionDocument({
      provider: stripe,
      providerCustomerId: "provider_customer_deleted",
      providerSubscriptionId: "provider_subscription_deleted",
      aggregate: {
        ...createSubscriptionDocument().aggregate,
        providerRef: {
          provider: stripe,
          customerId: "provider_customer_deleted",
          subscriptionId: "provider_subscription_deleted",
          priceId: "price_sub",
        },
      },
    });
    const fake = createFakeMikaProvider({
      id: stripe,
      overrides: {
        verifyWebhook: async (webhookInput) =>
          createVerifiedWebhookPayload(webhookInput, {
            payloadHash: "subscription_deleted_customer_hash",
            parsed: { delivery: "event_subscription_deleted_customer" },
          }),
        parseWebhookEvent: async (verified) =>
          createSubscriptionWebhookEvent(verified, {
            providerEventId: "event_subscription_deleted_customer",
            providerSubscriptionId: "provider_subscription_deleted",
            providerCustomerId: "provider_customer_deleted",
            providerPriceId: "price_sub",
            status: "active",
          }),
      },
    });
    await repositories.account.put(customer);
    await repositories.account.put(subscription);
    const api = createMikaBackendApi(
      createIncrementingBackendDependencies({
        repositories,
        providers: createMikaProviderRegistry([fake.provider]),
      }),
    );

    await expect(
      receiveWebhook(api, "subscription-deleted-customer", stripe),
    ).resolves.toMatchObject({
      ok: true,
      status: 200,
      data: { status: "received" },
    });

    await expect(accountCollection.count({ type: "entitlement" })).resolves.toBe(0);
    await expect(accountCollection.get("subscription_1")).resolves.toEqual(subscription);
    await expect(opsCollection.get("webhook_1")).resolves.toMatchObject({
      status: "processed",
      record: {
        status: "processed",
        relatedCustomerId: "customer_1",
        relatedSubscriptionId: "subscription_1",
      },
    });
  });

  it("keeps manually revoked subscription entitlements revoked across webhook refreshes", async () => {
    const stripe = createProviderName("stripe");
    const accountCollection = createStorageCollection("account");
    const repositories = {
      ...createTestBackendRepositories(),
      account: new AccountRepository(accountCollection),
    };
    const entitlementId = createMikaId("entitlement_subscription_1_subscription");
    const subscription = createSubscriptionDocument({
      provider: stripe,
      providerCustomerId: "provider_customer_1",
      providerSubscriptionId: "provider_subscription_1",
      aggregate: {
        ...createSubscriptionDocument().aggregate,
        entitlementId,
      },
    });
    const entitlement = createEntitlementDocument({
      id: entitlementId,
      status: "revoked",
      subscriptionId: subscription.id,
      orderId: undefined,
      record: {
        id: entitlementId,
        subscriptionId: subscription.id,
        orderId: undefined,
        status: "revoked",
      },
    });
    const fake = createFakeMikaProvider({
      id: stripe,
      overrides: {
        verifyWebhook: async (webhookInput) =>
          createVerifiedWebhookPayload(webhookInput, {
            payloadHash: "subscription_revoked_entitlement_hash",
            parsed: { delivery: "event_subscription_revoked_entitlement" },
          }),
        parseWebhookEvent: async (verified) =>
          createSubscriptionWebhookEvent(verified, {
            providerEventId: "event_subscription_revoked_entitlement",
            providerSubscriptionId: "provider_subscription_1",
            providerCustomerId: "provider_customer_1",
            status: "active",
          }),
      },
    });
    await repositories.account.put(createCustomerDocument());
    await repositories.account.put(subscription);
    await repositories.account.put(entitlement);
    const api = createMikaBackendApi(
      createIncrementingBackendDependencies({
        repositories,
        providers: createMikaProviderRegistry([fake.provider]),
      }),
    );

    await expect(
      receiveWebhook(api, "subscription-revoked-entitlement", stripe),
    ).resolves.toMatchObject({
      ok: true,
      status: 200,
      data: { status: "received" },
    });

    await expect(
      accountCollection.get("entitlement_subscription_1_subscription"),
    ).resolves.toMatchObject({
      type: "entitlement",
      status: "revoked",
      record: { status: "revoked", sourceStatus: "active" },
    });
  });

  it("replays failed webhooks through the idempotent processing path", async () => {
    const stripe = createProviderName("stripe");
    const accountCollection = createStorageCollection("account");
    const opsCollection = createStorageCollection("ops");
    const subscriptionSellable = createSellableDefinition({
      prices: [
        createPriceDefinition({
          id: createTestMikaId("price", 1),
          mode: "subscription",
          fulfillmentKind: "entitlement",
          entitlementKey: "course:replay-product",
          providerRefs: [{ provider: stripe, productId: "prod_replay", priceId: "price_replay" }],
        }),
      ],
    });
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
            payloadHash: "subscription_replay_hash",
            parsed: { delivery: "event_subscription_replay" },
          }),
        parseWebhookEvent: async (verified) =>
          ({
            ...createSubscriptionWebhookEvent(verified, {
              providerEventId: "event_subscription_replay",
              providerSubscriptionId: "provider_subscription_replay",
              providerCustomerId: "provider_customer_replay",
              providerPriceId: "price_replay",
              status: "active",
            }),
            raw: { providerPayload: { secret: "raw-provider-replay-data" } },
          }) satisfies MikaProviderWebhookEvent,
      },
    });
    const api = createMikaBackendApi(
      createIncrementingBackendDependencies({
        repositories,
        providers: createMikaProviderRegistry([fake.provider]),
      }),
    );

    await expect(receiveWebhook(api, "subscription-replay-failed", stripe)).resolves.toMatchObject({
      ok: true,
      status: 200,
      data: { id: "webhook_1", status: "failed", replayable: true },
    });
    await expect(opsCollection.get("webhook_1")).resolves.toMatchObject({
      status: "failed",
      record: {
        attemptCount: 1,
        normalizedPayloadJson: {
          kind: "subscription",
          provider: "stripe",
          providerEventId: "event_subscription_replay",
          providerSubscriptionId: "provider_subscription_replay",
          providerCustomerId: "provider_customer_replay",
          providerPriceId: "price_replay",
        },
        rawPayloadJson: {
          normalizedEvent: {
            kind: "subscription",
            provider: "stripe",
            providerEventId: "event_subscription_replay",
            providerSubscriptionId: "provider_subscription_replay",
            providerCustomerId: "provider_customer_replay",
            providerPriceId: "price_replay",
            raw: { providerPayload: { secret: "raw-provider-replay-data" } },
          },
        },
      },
    });
    const failedWebhook = await opsCollection.get("webhook_1");
    if (!failedWebhook || failedWebhook.type !== "webhook") {
      throw new Error("Expected failed replay webhook fixture.");
    }
    expect(failedWebhook.record.normalizedPayloadJson).not.toHaveProperty("raw");

    await expect(repositories.ops.purgeWebhookRawPayloads(TEST_NOW, TEST_NOW)).resolves.toEqual({
      scanned: 1,
      purged: 1,
    });
    await expect(opsCollection.get("webhook_1")).resolves.toMatchObject({
      status: "failed",
      record: {
        rawPayloadJson: undefined,
        normalizedPayloadJson: {
          kind: "subscription",
          provider: "stripe",
          providerEventId: "event_subscription_replay",
          providerSubscriptionId: "provider_subscription_replay",
          providerCustomerId: "provider_customer_replay",
          providerPriceId: "price_replay",
        },
        rawPayloadPurgedAt: TEST_NOW,
      },
    });
    const purgedWebhook = await opsCollection.get("webhook_1");
    if (!purgedWebhook || purgedWebhook.type !== "webhook") {
      throw new Error("Expected purged replay webhook fixture.");
    }
    expect(purgedWebhook.record.normalizedPayloadJson).not.toHaveProperty("raw");

    await repositories.catalog.put(
      createCatalogItemDocument({
        contentRef: createTestContentRef(),
        sellables: [subscriptionSellable],
      }),
    );
    await repositories.account.put(createCustomerDocument());
    await repositories.account.put(
      createProviderAccountDocument({
        provider: stripe,
        providerCustomerId: "provider_customer_replay",
      }),
    );

    await expect(
      api.admin.webhookReplay({ webhookId: createTestMikaId("webhook", 1) }),
    ).resolves.toMatchObject({
      ok: true,
      status: 200,
      data: {
        id: "webhook_1",
        status: "completed",
        affected: {
          processed: 1,
          failed: 0,
        },
      },
    });
    await expect(accountCollection.count({ type: "subscription" })).resolves.toBe(1);
    await expect(accountCollection.count({ type: "entitlement" })).resolves.toBe(1);
    await expect(opsCollection.get("webhook_1")).resolves.toMatchObject({
      status: "processed",
      record: {
        status: "processed",
        attemptCount: 2,
        relatedCustomerId: "customer_1",
        relatedSubscriptionId: "subscription_1",
      },
    });

    await expect(
      api.admin.webhookReplay({ webhookId: createTestMikaId("webhook", 1) }),
    ).resolves.toMatchObject({
      ok: true,
      status: 200,
      data: {
        id: "webhook_1",
        status: "completed",
        affected: {
          processed: 0,
          failed: 0,
        },
      },
    });
    await expect(accountCollection.count({ type: "subscription" })).resolves.toBe(1);
    await expect(accountCollection.count({ type: "entitlement" })).resolves.toBe(1);
  });

  it("applies webhook replay eligibility by stored status", async () => {
    const opsCollection = createStorageCollection("ops");
    const repositories = {
      ...createTestBackendRepositories(),
      ops: new OpsRepository(opsCollection),
    };
    const fake = createFakeMikaProvider({
      id: TEST_PROVIDER,
      overrides: {
        verifyWebhook: async (webhookInput) =>
          createVerifiedWebhookPayload(webhookInput, {
            payloadHash: "replay_status_hash",
            parsed: { delivery: "replay-status" },
          }),
        parseWebhookEvent: async (verified) =>
          createWebhookEvent(verified, {
            providerEventId: "event_replay_status",
            type: "test.replay-status",
          }),
      },
    });
    const api = createMikaBackendApi(
      createIncrementingBackendDependencies({
        repositories,
        providers: createMikaProviderRegistry([fake.provider]),
      }),
    );

    await expect(receiveWebhook(api, "replay-status")).resolves.toMatchObject({
      ok: true,
      status: 200,
      data: { id: "webhook_1", status: "received", replayable: true },
    });
    const webhook = await repositories.ops.findWebhookById(createTestMikaId("webhook", 1));
    if (!webhook) throw new Error("Expected webhook replay status fixture.");

    const cases = [
      {
        status: "received" as const,
        expected: { status: "completed", affected: { processed: 1, failed: 0 } },
        storedStatus: "received" as const,
      },
      {
        status: "failed" as const,
        expected: { status: "failed", affected: { processed: 0, failed: 1 } },
        storedStatus: "failed" as const,
      },
      {
        status: "processing" as const,
        expected: { status: "completed", affected: { processed: 1, failed: 0 } },
        storedStatus: "processing" as const,
      },
      {
        status: "processed" as const,
        expected: {
          status: "completed",
          message: `Webhook '${webhook.id}' is not eligible for replay.`,
          affected: { processed: 0, failed: 0 },
        },
        storedStatus: "processed" as const,
      },
    ];

    for (const replayCase of cases) {
      await repositories.ops.put({
        ...webhook,
        status: replayCase.status,
        record: {
          ...webhook.record,
          status: replayCase.status,
        },
      });

      await expect(
        api.admin.webhookReplay({ webhookId: createTestMikaId("webhook", 1) }),
      ).resolves.toMatchObject({
        ok: true,
        status: 200,
        data: replayCase.expected,
      });
      await expect(opsCollection.get("webhook_1")).resolves.toMatchObject({
        status: replayCase.storedStatus,
        record: { status: replayCase.storedStatus },
      });
    }
  });

  it("fails webhook replay when stored payload cannot be reconstructed", async () => {
    const accountCollection = createStorageCollection("account");
    const ledgerCollection = createStorageCollection("ledger");
    const opsCollection = createStorageCollection("ops");
    const repositories = {
      ...createTestBackendRepositories(),
      account: new AccountRepository(accountCollection),
      ledger: new LedgerRepository(ledgerCollection),
      ops: new OpsRepository(opsCollection),
    };
    const fake = createFakeMikaProvider({
      id: TEST_PROVIDER,
      overrides: {
        verifyWebhook: async (webhookInput) =>
          createVerifiedWebhookPayload(webhookInput, {
            payloadHash: "malformed_replay_hash",
            parsed: { delivery: "malformed-replay" },
          }),
        parseWebhookEvent: async (verified) =>
          createWebhookEvent(verified, {
            providerEventId: "event_malformed_replay",
            type: "test.malformed-replay",
          }),
      },
    });
    const api = createMikaBackendApi(
      createIncrementingBackendDependencies({
        repositories,
        providers: createMikaProviderRegistry([fake.provider]),
      }),
    );

    await expect(receiveWebhook(api, "malformed-replay")).resolves.toMatchObject({
      ok: true,
      status: 200,
      data: { id: "webhook_1", status: "received" },
    });
    const webhook = await repositories.ops.findWebhookById(createTestMikaId("webhook", 1));
    if (!webhook) throw new Error("Expected malformed replay webhook fixture.");
    await repositories.ops.put({
      ...webhook,
      status: "failed",
      record: {
        ...webhook.record,
        status: "failed",
        rawPayloadJson: { providerPayload: { delivery: "malformed-replay" } },
        normalizedPayloadJson: undefined,
      },
    });

    await expect(
      api.admin.webhookReplay({ webhookId: createTestMikaId("webhook", 1) }),
    ).resolves.toMatchObject({
      ok: true,
      status: 200,
      data: {
        id: "webhook_1",
        status: "failed",
        message: "Webhook payload could not be reconstructed for replay.",
        affected: {
          processed: 0,
          failed: 1,
        },
      },
    });
    await expect(opsCollection.get("webhook_1")).resolves.toMatchObject({
      status: "failed",
      record: {
        status: "failed",
        attemptCount: 1,
        lastError: "Webhook payload could not be reconstructed for replay.",
      },
    });
    await expect(accountCollection.count()).resolves.toBe(0);
    await expect(ledgerCollection.count()).resolves.toBe(0);
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

  it("sums quantity across split price lines of the same sellable for stock checks", async () => {
    const contentRef = createTestContentRef();
    const sellable = createSellableDefinition({
      prices: [
        createPriceDefinition({ id: createTestMikaId("price", 1) }),
        createPriceDefinition({ id: createTestMikaId("price", 2) }),
      ],
    });
    const repositories = createTestBackendRepositories({
      stockBySellableId: new Map([
        [
          sellable.id,
          createStockRecord({
            sellableId: sellable.id,
            quantityOnHand: 5,
            quantityReserved: 3,
          }),
        ],
      ]),
    });
    await repositories.catalog.put(
      createCatalogItemDocument({ contentRef, sellables: [sellable] }),
    );
    const api = createMikaBackendApi(createIncrementingBackendDependencies({ repositories }));
    const ctx = createTestRequestContext({
      customerId: false,
      userId: false,
      sessionId: "session_split_stock",
    });

    await expect(
      api.cart.add(ctx, {
        sellableId: sellable.id,
        priceId: createTestMikaId("price", 1),
        quantity: 2,
      }),
    ).resolves.toMatchObject({ ok: true, status: 200 });

    await expect(
      api.cart.add(ctx, {
        sellableId: sellable.id,
        priceId: createTestMikaId("price", 2),
        quantity: 1,
      }),
    ).resolves.toMatchObject({
      ok: false,
      status: 409,
      error: { code: "OUT_OF_STOCK" },
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
    await repositories.catalog.put(
      createCatalogItemDocument({
        contentRef: createTestContentRef(),
        sellables: cases.map((testCase) => createSellableDefinition({ id: testCase.id })),
      }),
    );
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
    await repositories.catalog.put(
      createCatalogItemDocument({
        contentRef: createTestContentRef(),
        sellables: [
          createSellableDefinition({ id: forcedOut }),
          createSellableDefinition({ id: forcedAvailable }),
        ],
      }),
    );
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

  it("returns not found for an inactive (delisted) sellable on public availability", async () => {
    const sellableId = createTestMikaId("sellable", 1);
    const repositories = createTestBackendRepositories({
      stockBySellableId: new Map([
        [sellableId, createStockRecord({ sellableId, quantityOnHand: 9, quantityReserved: 0 })],
      ]),
    });
    await repositories.catalog.put(
      createCatalogItemDocument({
        contentRef: createTestContentRef(),
        sellables: [createSellableDefinition({ id: sellableId, active: false })],
      }),
    );
    const api = createMikaBackendApi(createTestBackendDependencies({ repositories }));

    await expect(api.stock.availability({ sellableId })).resolves.toMatchObject({
      ok: false,
      status: 404,
      error: { code: "SELLABLE_NOT_FOUND" },
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

  it("rejects a concurrent cart write instead of silently discarding it (CAS, not blind put)", async () => {
    const contentRef = createTestContentRef();
    const sellableA = createSellableDefinition({ id: createTestMikaId("sellable", 1) });
    const sellableB = createSellableDefinition({ id: createTestMikaId("sellable", 2) });
    const repositories = createTestBackendRepositories({
      stockBySellableId: new Map([
        [
          sellableA.id,
          createStockRecord({ sellableId: sellableA.id, quantityOnHand: 5, quantityReserved: 0 }),
        ],
        [
          sellableB.id,
          createStockRecord({ sellableId: sellableB.id, quantityOnHand: 5, quantityReserved: 0 }),
        ],
      ]),
    });
    await repositories.catalog.put(
      createCatalogItemDocument({ contentRef, sellables: [sellableA, sellableB] }),
    );
    const seedApi = createMikaBackendApi(createIncrementingBackendDependencies({ repositories }));
    const ctx = createTestRequestContext({ customerId: false, userId: false });
    // Two tabs are two separate requests, each stamped with its own receipt time. Both must differ
    // from the seed write's timestamp too — otherwise the first of the two concurrent writes would
    // (coincidentally) restamp the cart with the exact same updatedAt it already had, and the CAS
    // check on the second write would vacuously pass regardless of whether it's implemented right.
    const ctxUpdate = createTestRequestContext({
      customerId: false,
      userId: false,
      now: createTestClock().at(1000),
    });
    const ctxAdd = createTestRequestContext({
      customerId: false,
      userId: false,
      now: createTestClock().at(2000),
    });

    const seeded = await seedApi.cart.add(ctx, { sellableId: sellableA.id, quantity: 1 });
    if (!seeded.ok) throw new Error("Expected seed cart.add to succeed.");
    const seededLineId = seeded.data.items[0]!.id;

    // Whichever call's write reaches putCartIfUnchanged first is let through immediately; the
    // second is held until the first fully commits, so its captured expectedVersion is
    // guaranteed stale — deterministically reproducing "two tabs write the same cart" without
    // relying on incidental Promise scheduling order.
    let firstWrite: Promise<CartDocument | null> | undefined;
    const gatedSession = new Proxy(repositories.session, {
      get(target, property, receiver) {
        if (property === "putCartIfUnchanged") {
          return async (cart: CartDocument, expectedVersion: number) => {
            if (!firstWrite) {
              firstWrite = target.putCartIfUnchanged(cart, expectedVersion);
              return firstWrite;
            }
            await firstWrite;
            return target.putCartIfUnchanged(cart, expectedVersion);
          };
        }
        const value = Reflect.get(target, property, receiver);

        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const api = createMikaBackendApi(
      createIncrementingBackendDependencies({
        repositories: { ...repositories, session: gatedSession },
      }),
    );

    const [updateResult, addResult] = await Promise.all([
      api.cart.update(ctxUpdate, { lineId: seededLineId, quantity: 3 }),
      api.cart.add(ctxAdd, { sellableId: sellableB.id, quantity: 1 }),
    ]);

    const results = [updateResult, addResult];
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    const conflicts = results.filter((result) => !result.ok);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]).toMatchObject({ ok: false, status: 409, error: { code: "CONFLICT" } });

    const finalCart = await api.cart.get(ctx);
    if (!finalCart.ok) throw new Error("Expected cart.get to succeed.");
    if (updateResult.ok) {
      // The update won: quantity changed, sellableB was never added — not silently merged in.
      expect(finalCart.data.items).toEqual([
        expect.objectContaining({ sellableId: sellableA.id, quantity: 3 }),
      ]);
    } else {
      // The add won: original line untouched, sellableB present — not silently discarded.
      expect(finalCart.data.items).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ sellableId: sellableA.id, quantity: 1 }),
          expect.objectContaining({ sellableId: sellableB.id, quantity: 1 }),
        ]),
      );
      expect(finalCart.data.items).toHaveLength(2);
    }
  });

  it("serializes 3-way concurrent cart writes by version, not by timestamp (which can collide)", async () => {
    // updatedAt is a millisecond-resolution wall-clock string: two writers processed within the
    // same millisecond legitimately share the same ctx.now. If the CAS check compared updatedAt
    // alone, a third writer reading the same pre-write state as a second writer could have its
    // stale check vacuously pass once the second writer commits — its write would still carry the
    // same timestamp value, so nothing would look "changed". version is a counter incremented on
    // every write, so it can never collide like this even when writers share a timestamp.
    const contentRef = createTestContentRef();
    const sellableA = createSellableDefinition({ id: createTestMikaId("sellable", 1) });
    const sellableB = createSellableDefinition({ id: createTestMikaId("sellable", 2) });
    const sellableC = createSellableDefinition({ id: createTestMikaId("sellable", 3) });
    const repositories = createTestBackendRepositories({
      stockBySellableId: new Map([
        [
          sellableA.id,
          createStockRecord({ sellableId: sellableA.id, quantityOnHand: 5, quantityReserved: 0 }),
        ],
        [
          sellableB.id,
          createStockRecord({ sellableId: sellableB.id, quantityOnHand: 5, quantityReserved: 0 }),
        ],
        [
          sellableC.id,
          createStockRecord({ sellableId: sellableC.id, quantityOnHand: 5, quantityReserved: 0 }),
        ],
      ]),
    });
    await repositories.catalog.put(
      createCatalogItemDocument({ contentRef, sellables: [sellableA, sellableB, sellableC] }),
    );
    const seedApi = createMikaBackendApi(createIncrementingBackendDependencies({ repositories }));
    // One shared ctx (and so one shared ctx.now) for the seed and all three concurrent writers —
    // deliberately the opposite of the staggered-timestamp setup above, to isolate version as the
    // thing actually preventing the collision rather than incidentally-distinct timestamps.
    const ctx = createTestRequestContext({ customerId: false, userId: false });

    const seeded = await seedApi.cart.add(ctx, { sellableId: sellableA.id, quantity: 1 });
    if (!seeded.ok) throw new Error("Expected seed cart.add to succeed.");

    // All three writers reach putCartIfUnchanged in strict, deterministic order (first through
    // immediately, each next held until the previous fully commits) — every one of them still
    // captured its expectedVersion from the same pre-write read, exactly as three genuinely
    // concurrent requests processed in the same millisecond would.
    const writeQueue: Promise<CartDocument | null>[] = [];
    const gatedSession = new Proxy(repositories.session, {
      get(target, property, receiver) {
        if (property === "putCartIfUnchanged") {
          return async (cart: CartDocument, expectedVersion: number) => {
            const ahead = Promise.all(writeQueue);
            const write = ahead.then(() => target.putCartIfUnchanged(cart, expectedVersion));
            writeQueue.push(write);

            return write;
          };
        }
        const value = Reflect.get(target, property, receiver);

        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const api = createMikaBackendApi(
      createIncrementingBackendDependencies({
        repositories: { ...repositories, session: gatedSession },
      }),
    );

    const results = await Promise.all([
      api.cart.add(ctx, { sellableId: sellableB.id, quantity: 1 }),
      api.cart.add(ctx, { sellableId: sellableC.id, quantity: 1 }),
    ]);

    // Exactly one of the two concurrent adds must lose to a 409 — none may silently vanish.
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    const conflicts = results.filter((result) => !result.ok);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]).toMatchObject({ ok: false, status: 409, error: { code: "CONFLICT" } });

    const finalCart = await api.cart.get(ctx);
    if (!finalCart.ok) throw new Error("Expected cart.get to succeed.");
    // The seed line plus exactly whichever of B/C actually won — never both silently merged in,
    // and never neither (which would mean the winner's own write vanished too).
    expect(finalCart.data.items).toHaveLength(2);
    expect(finalCart.data.items).toEqual(
      expect.arrayContaining([expect.objectContaining({ sellableId: sellableA.id, quantity: 1 })]),
    );
  });

  it("writes a legacy cart persisted before `version` existed, instead of permanently 409ing it", async () => {
    // A cart written before `version` was introduced has no such field at runtime, despite the
    // type declaring it required. version + 1 on `undefined` would be NaN, and NaN !== NaN is
    // always true — so a naive CAS check would reject every subsequent write to this cart
    // forever. The repository must treat a missing version as "nothing to compare" and allow the
    // write, and nextCartVersion must recover a real counter (1) rather than propagating NaN.
    const contentRef = createTestContentRef();
    const sellable = createSellableDefinition({ id: createTestMikaId("sellable", 1) });
    const repositories = createTestBackendRepositories({
      stockBySellableId: new Map([
        [
          sellable.id,
          createStockRecord({ sellableId: sellable.id, quantityOnHand: 5, quantityReserved: 0 }),
        ],
      ]),
    });
    await repositories.catalog.put(
      createCatalogItemDocument({ contentRef, sellables: [sellable] }),
    );
    const api = createMikaBackendApi(createIncrementingBackendDependencies({ repositories }));
    const ctx = createTestRequestContext({ customerId: false, userId: false });

    const seeded = await api.cart.add(ctx, { sellableId: sellable.id, quantity: 1 });
    if (!seeded.ok) throw new Error("Expected seed cart.add to succeed.");
    const cartId = seeded.data.id;

    const stored = await repositories.session.findById(cartId);
    if (!stored || stored.type !== "cart") throw new Error("Expected a stored cart document.");
    const { version: _version, ...legacyCart } = stored;
    await repositories.session.put(legacyCart as unknown as CartDocument);
    const restored = await repositories.session.findById(cartId);
    expect(restored && "version" in restored ? restored.version : undefined).toBeUndefined();

    const added = await api.cart.add(ctx, { sellableId: sellable.id, quantity: 1 });
    expect(added).toMatchObject({ ok: true });
    if (!added.ok) throw new Error("unreachable");
    expect(added.data.items).toEqual([
      expect.objectContaining({ sellableId: sellable.id, quantity: 2 }),
    ]);

    // The write must also recover a real version counter, not carry NaN forward — otherwise this
    // cart would be writable exactly once more before NaN !== NaN bricks it again.
    await expect(repositories.session.findById(cartId)).resolves.toMatchObject({ version: 1 });
  });

  it("starts checkout on a legacy cart whose version was never skipped-and-then-rejected", async () => {
    // startCheckout used to only call claimCartForCheckout when resolved.cartVersion !== undefined
    // — for a cart persisted before `version` existed, that skipped the claim entirely (claimedCart
    // stayed null), which then tripped the very next check (`resolved.cart && !claimedCart` ->
    // 409), making every pre-existing cart permanently uncheckoutable with zero concurrency
    // involved. The claim must always be attempted; the repository handles the undefined version.
    const contentRef = createTestContentRef();
    const sellable = createSellableDefinition({ id: createTestMikaId("sellable", 1) });
    const repositories = createTestBackendRepositories({
      stockBySellableId: new Map([
        [
          sellable.id,
          createStockRecord({ sellableId: sellable.id, quantityOnHand: 5, quantityReserved: 0 }),
        ],
      ]),
    });
    await repositories.catalog.put(
      createCatalogItemDocument({ contentRef, sellables: [sellable] }),
    );
    const api = createMikaBackendApi(createIncrementingBackendDependencies({ repositories }));
    const ctx = createTestRequestContext({ customerId: false, userId: false });

    const seeded = await api.cart.add(ctx, { sellableId: sellable.id, quantity: 1 });
    if (!seeded.ok) throw new Error("Expected seed cart.add to succeed.");
    const cartId = seeded.data.id;

    const stored = await repositories.session.findById(cartId);
    if (!stored || stored.type !== "cart") throw new Error("Expected a stored cart document.");
    const { version: _version, ...legacyCart } = stored;
    await repositories.session.put(legacyCart as unknown as CartDocument);

    const checkout = await api.checkout.start(ctx, { cartId });
    expect(checkout).toMatchObject({ ok: true });
  });

  it("does not orphan a line into an invisible duplicate cart on concurrent first-adds", async () => {
    // Two simultaneous first-add requests (e.g. a double click before any cart exists yet) both
    // see no existing cart via findOpenCart. Without serializing the create, each would blind-put
    // its own new cart document; findOpenCartBySession only ever returns one of them afterward, so
    // whichever line landed in the other document becomes invisible to the caller.
    const contentRef = createTestContentRef();
    const sellableA = createSellableDefinition({ id: createTestMikaId("sellable", 1) });
    const sellableB = createSellableDefinition({ id: createTestMikaId("sellable", 2) });
    const repositories = createTestBackendRepositories({
      stockBySellableId: new Map([
        [
          sellableA.id,
          createStockRecord({ sellableId: sellableA.id, quantityOnHand: 5, quantityReserved: 0 }),
        ],
        [
          sellableB.id,
          createStockRecord({ sellableId: sellableB.id, quantityOnHand: 5, quantityReserved: 0 }),
        ],
      ]),
    });
    await repositories.catalog.put(
      createCatalogItemDocument({ contentRef, sellables: [sellableA, sellableB] }),
    );

    // Whichever call's lock attempt reaches tryAcquireLock first is let through immediately; the
    // second is held until the first's real attempt resolves, so it deterministically observes
    // the lock as already held (rather than hoping incidental Promise scheduling produces that).
    let firstLockAttempt: Promise<EphemeralRecord | null> | undefined;
    const gatedEphemeral = new Proxy(repositories.ephemeral, {
      get(target, property, receiver) {
        if (property === "tryAcquireLock") {
          return async (lockInput: {
            readonly key: string;
            readonly owner: string;
            readonly subjectHash?: string;
            readonly expiresAt: ISODateTime;
            readonly now: ISODateTime;
          }) => {
            if (!firstLockAttempt) {
              firstLockAttempt = target.tryAcquireLock(lockInput);
              return firstLockAttempt;
            }
            await firstLockAttempt;
            return target.tryAcquireLock(lockInput);
          };
        }
        const value = Reflect.get(target, property, receiver);

        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const api = createMikaBackendApi(
      createIncrementingBackendDependencies({
        repositories: { ...repositories, ephemeral: gatedEphemeral },
      }),
    );
    const ctx = createTestRequestContext({ customerId: false, userId: false });

    const [resultA, resultB] = await Promise.all([
      api.cart.add(ctx, { sellableId: sellableA.id, quantity: 1 }),
      api.cart.add(ctx, { sellableId: sellableB.id, quantity: 1 }),
    ]);

    expect(resultA).toMatchObject({ ok: true });
    expect(resultB).toMatchObject({ ok: true });

    const cart = await api.cart.get(ctx);
    if (!cart.ok) throw new Error("Expected cart.get to succeed.");
    expect(cart.data.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ sellableId: sellableA.id, quantity: 1 }),
        expect.objectContaining({ sellableId: sellableB.id, quantity: 1 }),
      ]),
    );
    expect(cart.data.items).toHaveLength(2);
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
        code: "NOT_FOUND",
        fieldErrors: { lineId: "Cart line was not found." },
      },
    });
    await expect(
      api.cart.remove(ctx, { lineId: createTestMikaId("line", 404) }),
    ).resolves.toMatchObject({
      ok: false,
      status: 404,
      error: {
        code: "NOT_FOUND",
        fieldErrors: { lineId: "Cart line was not found." },
      },
    });
  });

  it("rejects cart updates when the stored line sellable is no longer in the catalog", async () => {
    const contentRef = createTestContentRef();
    const sellable = createSellableDefinition({ maxPerOrder: 5 });
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
    await repositories.catalog.put(createCatalogItemDocument({ contentRef, sellables: [] }));

    await expect(
      api.cart.update(ctx, { lineId: added.data.items[0]!.id, quantity: 999999999 }),
    ).resolves.toMatchObject({
      ok: false,
      status: 404,
      error: { code: "SELLABLE_NOT_FOUND" },
    });
    await expect(api.cart.get(ctx)).resolves.toMatchObject({
      ok: true,
      data: { items: [{ sellableId: sellable.id, quantity: 2 }] },
    });
  });

  it("merges the caller's own guest cart into their cart on login handoff", async () => {
    const contentRef = createTestContentRef();
    const sellable = createSellableDefinition({ maxPerOrder: 5 });
    const repositories = createTestBackendRepositories();
    await repositories.catalog.put(
      createCatalogItemDocument({ contentRef, sellables: [sellable] }),
    );
    const api = createMikaBackendApi(createIncrementingBackendDependencies({ repositories }));
    const guestCtx = createTestRequestContext({
      customerId: false,
      userId: false,
      sessionId: "session_handoff",
    });
    const priorCustomerCtx = createTestRequestContext({
      customerId: "customer_1",
      userId: "user_1",
      sessionId: "session_prior",
    });
    const callerCtx = createTestRequestContext({
      customerId: "customer_1",
      userId: "user_1",
      sessionId: "session_handoff",
    });

    await api.cart.add(guestCtx, {
      sellableId: sellable.id,
      priceId: createTestMikaId("price", 1),
      quantity: 2,
    });
    const customerCart = await api.cart.add(priorCustomerCtx, {
      sellableId: sellable.id,
      priceId: createTestMikaId("price", 1),
      quantity: 1,
    });
    if (!customerCart.ok) throw new Error("expected customer cart");

    await expect(
      api.cart.merge(callerCtx, {
        targetCartId: customerCart.data.id,
        sourceSessionId: "session_handoff",
      }),
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
      repositories.session.findOpenCartBySession("session_handoff", TEST_CURRENCY),
    ).resolves.toBeNull();
  });

  it("rejects a cart.merge that would silently discard a concurrent cart.update on the target", async () => {
    const contentRef = createTestContentRef();
    const sellable = createSellableDefinition({ maxPerOrder: 50 });
    const repositories = createTestBackendRepositories();
    await repositories.catalog.put(
      createCatalogItemDocument({ contentRef, sellables: [sellable] }),
    );
    const seedApi = createMikaBackendApi(createIncrementingBackendDependencies({ repositories }));
    const guestCtx = createTestRequestContext({
      customerId: false,
      userId: false,
      sessionId: "session_handoff",
    });
    const priorCustomerCtx = createTestRequestContext({
      customerId: "customer_1",
      userId: "user_1",
      sessionId: "session_prior",
    });

    await seedApi.cart.add(guestCtx, { sellableId: sellable.id, quantity: 1 });
    const customerCart = await seedApi.cart.add(priorCustomerCtx, {
      sellableId: sellable.id,
      quantity: 1,
    });
    if (!customerCart.ok) throw new Error("Expected seed cart.add to succeed.");
    const targetLineId = customerCart.data.items[0]!.id;

    // A concurrent request on the SAME customer (e.g. another tab, or an admin action) updates
    // the target cart's quantity while a login-handoff merge is also in flight for that cart.
    const callerCtx = createTestRequestContext({
      customerId: "customer_1",
      userId: "user_1",
      sessionId: "session_handoff",
      now: createTestClock().at(1000),
    });
    const updateCtx = createTestRequestContext({
      customerId: "customer_1",
      userId: "user_1",
      sessionId: "session_prior",
      now: createTestClock().at(2000),
    });

    let firstWrite: Promise<CartDocument | null> | undefined;
    const gatedSession = new Proxy(repositories.session, {
      get(target, property, receiver) {
        if (property === "putCartIfUnchanged") {
          return async (cart: CartDocument, expectedVersion: number) => {
            if (!firstWrite) {
              firstWrite = target.putCartIfUnchanged(cart, expectedVersion);
              return firstWrite;
            }
            await firstWrite;
            return target.putCartIfUnchanged(cart, expectedVersion);
          };
        }
        const value = Reflect.get(target, property, receiver);

        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const api = createMikaBackendApi(
      createIncrementingBackendDependencies({
        repositories: { ...repositories, session: gatedSession },
      }),
    );

    const [mergeResult, updateResult] = await Promise.all([
      api.cart.merge(callerCtx, {
        targetCartId: customerCart.data.id,
        sourceSessionId: "session_handoff",
      }),
      api.cart.update(updateCtx, { lineId: targetLineId, quantity: 9 }),
    ]);

    const results = [mergeResult, updateResult];
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    const conflicts = results.filter((result) => !result.ok);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]).toMatchObject({ ok: false, status: 409, error: { code: "CONFLICT" } });

    if (updateResult.ok) {
      // The update won: quantity 9 must survive, not get silently reverted by merge's write.
      const finalCart = await repositories.session.findById(customerCart.data.id);
      if (!finalCart || finalCart.type !== "cart") throw new Error("Expected a cart document.");
      expect(finalCart.aggregate.items).toEqual([expect.objectContaining({ quantity: 9 })]);
    }
  });

  it("recovers a line added to the merge source concurrently, instead of stranding it", async () => {
    // A line added to the guest cart between cart.merge reading it and abandoning it must not be
    // silently left behind on a session id the caller may never revisit again (e.g. login
    // regenerates the session id, so there's no natural "merge again later").
    const contentRef = createTestContentRef();
    const sellableA = createSellableDefinition({ id: createTestMikaId("sellable", 1) });
    const sellableB = createSellableDefinition({ id: createTestMikaId("sellable", 2) });
    const sellableC = createSellableDefinition({ id: createTestMikaId("sellable", 3) });
    const repositories = createTestBackendRepositories();
    await repositories.catalog.put(
      createCatalogItemDocument({ contentRef, sellables: [sellableA, sellableB, sellableC] }),
    );
    // One shared dependencies object (one id-factory counter) for both the seed and gated api
    // instances below — otherwise two separately-constructed incrementing id factories would each
    // restart from 1, and a coincidentally-reused line id would defeat the "already merged vs.
    // new" check this test exists to exercise.
    const dependencies = createIncrementingBackendDependencies({ repositories });
    const seedApi = createMikaBackendApi(dependencies);
    const guestCtx = createTestRequestContext({
      customerId: false,
      userId: false,
      sessionId: "session_handoff_recover",
    });
    const priorCustomerCtx = createTestRequestContext({
      customerId: "customer_1",
      userId: "user_1",
      sessionId: "session_prior_recover",
    });
    const callerCtx = createTestRequestContext({
      customerId: "customer_1",
      userId: "user_1",
      sessionId: "session_handoff_recover",
    });
    const concurrentAddCtx = createTestRequestContext({
      customerId: false,
      userId: false,
      sessionId: "session_handoff_recover",
    });

    await seedApi.cart.add(guestCtx, { sellableId: sellableB.id, quantity: 1 });
    const customerCart = await seedApi.cart.add(priorCustomerCtx, {
      sellableId: sellableA.id,
      quantity: 1,
    });
    if (!customerCart.ok) throw new Error("Expected seed cart.add to succeed.");

    let targetWriteEntered: (() => void) | undefined;
    const targetWriteEnteredPromise = new Promise<void>((resolve) => {
      targetWriteEntered = resolve;
    });
    let releaseTargetWrite: (() => void) | undefined;
    const releaseTargetWritePromise = new Promise<void>((resolve) => {
      releaseTargetWrite = resolve;
    });
    let gated = false;
    const gatedSession = new Proxy(repositories.session, {
      get(target, property, receiver) {
        if (property === "putCartIfUnchanged") {
          return async (cart: CartDocument, expectedVersion: number) => {
            if (!gated && cart.id === customerCart.data.id) {
              gated = true;
              targetWriteEntered?.();
              await releaseTargetWritePromise;
            }
            return target.putCartIfUnchanged(cart, expectedVersion);
          };
        }
        const value = Reflect.get(target, property, receiver);

        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const api = createMikaBackendApi({
      ...dependencies,
      repositories: { ...repositories, session: gatedSession },
    });

    const mergePromise = api.cart.merge(callerCtx, {
      targetCartId: customerCart.data.id,
      sourceSessionId: "session_handoff_recover",
    });
    await targetWriteEnteredPromise;
    // While merge is paused right before writing the target (having already read the source as
    // just [B]), a concurrent add lands sellable C on that same source cart.
    await expect(
      api.cart.add(concurrentAddCtx, { sellableId: sellableC.id, quantity: 1 }),
    ).resolves.toMatchObject({ ok: true });
    releaseTargetWrite?.();

    const merged = await mergePromise;
    expect(merged).toMatchObject({ ok: true, status: 200 });
    if (!merged.ok) throw new Error("Expected cart.merge to succeed.");
    // All three lines present — C was recovered by the retry, not stranded on the source.
    expect(merged.data.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ sellableId: sellableA.id, quantity: 1 }),
        expect.objectContaining({ sellableId: sellableB.id, quantity: 1 }),
        expect.objectContaining({ sellableId: sellableC.id, quantity: 1 }),
      ]),
    );
    expect(merged.data.items).toHaveLength(3);
    await expect(
      repositories.session.findOpenCartBySession("session_handoff_recover", TEST_CURRENCY),
    ).resolves.toBeNull();
  });

  it("recovers a quantity bump on an already-merged line, instead of dropping it", async () => {
    // A line present at merge-read time whose quantity is bumped concurrently (e.g. a racing
    // cart.update) is a different case from a brand-new line: it's already in target's merged
    // items at its original quantity, so the retry must merge only the *increase*, not the new
    // total (which would double count) and not nothing (which would silently drop the increase).
    const contentRef = createTestContentRef();
    const sellableA = createSellableDefinition({ id: createTestMikaId("sellable", 1) });
    const sellableB = createSellableDefinition({ id: createTestMikaId("sellable", 2) });
    const repositories = createTestBackendRepositories({
      stockBySellableId: new Map([
        [
          sellableB.id,
          createStockRecord({ sellableId: sellableB.id, quantityOnHand: 10, quantityReserved: 0 }),
        ],
      ]),
    });
    await repositories.catalog.put(
      createCatalogItemDocument({ contentRef, sellables: [sellableA, sellableB] }),
    );
    // One shared dependencies object (one id-factory counter) for both the seed and gated api
    // instances below — see the sibling test above for why this matters.
    const dependencies = createIncrementingBackendDependencies({ repositories });
    const seedApi = createMikaBackendApi(dependencies);
    const guestCtx = createTestRequestContext({
      customerId: false,
      userId: false,
      sessionId: "session_handoff_qty",
    });
    const priorCustomerCtx = createTestRequestContext({
      customerId: "customer_1",
      userId: "user_1",
      sessionId: "session_prior_qty",
    });
    const callerCtx = createTestRequestContext({
      customerId: "customer_1",
      userId: "user_1",
      sessionId: "session_handoff_qty",
    });
    const concurrentUpdateCtx = createTestRequestContext({
      customerId: false,
      userId: false,
      sessionId: "session_handoff_qty",
    });

    const guestCart = await seedApi.cart.add(guestCtx, { sellableId: sellableB.id, quantity: 1 });
    if (!guestCart.ok) throw new Error("Expected seed cart.add to succeed.");
    const guestLineId = guestCart.data.items[0]?.id;
    if (!guestLineId) throw new Error("Expected a seeded guest cart line.");
    const customerCart = await seedApi.cart.add(priorCustomerCtx, {
      sellableId: sellableA.id,
      quantity: 1,
    });
    if (!customerCart.ok) throw new Error("Expected seed cart.add to succeed.");

    let targetWriteEntered: (() => void) | undefined;
    const targetWriteEnteredPromise = new Promise<void>((resolve) => {
      targetWriteEntered = resolve;
    });
    let releaseTargetWrite: (() => void) | undefined;
    const releaseTargetWritePromise = new Promise<void>((resolve) => {
      releaseTargetWrite = resolve;
    });
    let gated = false;
    const gatedSession = new Proxy(repositories.session, {
      get(target, property, receiver) {
        if (property === "putCartIfUnchanged") {
          return async (cart: CartDocument, expectedVersion: number) => {
            if (!gated && cart.id === customerCart.data.id) {
              gated = true;
              targetWriteEntered?.();
              await releaseTargetWritePromise;
            }
            return target.putCartIfUnchanged(cart, expectedVersion);
          };
        }
        const value = Reflect.get(target, property, receiver);

        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const api = createMikaBackendApi({
      ...dependencies,
      repositories: { ...repositories, session: gatedSession },
    });

    const mergePromise = api.cart.merge(callerCtx, {
      targetCartId: customerCart.data.id,
      sourceSessionId: "session_handoff_qty",
    });
    await targetWriteEnteredPromise;
    // While merge is paused right before writing the target (having already read the source as
    // [B qty 1]), a concurrent update bumps B's quantity to 4 on that same source cart.
    await expect(
      api.cart.update(concurrentUpdateCtx, { lineId: guestLineId, quantity: 4 }),
    ).resolves.toMatchObject({ ok: true });
    releaseTargetWrite?.();

    const merged = await mergePromise;
    expect(merged).toMatchObject({ ok: true, status: 200 });
    if (!merged.ok) throw new Error("Expected cart.merge to succeed.");
    // B's full post-bump quantity (4) survives — the original 1 merged normally, and the retry
    // recovered the +3 increase rather than double-counting to 5 or dropping it back to 1.
    expect(merged.data.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ sellableId: sellableA.id, quantity: 1 }),
        expect.objectContaining({ sellableId: sellableB.id, quantity: 4 }),
      ]),
    );
    expect(merged.data.items).toHaveLength(2);
    await expect(
      repositories.session.findOpenCartBySession("session_handoff_qty", TEST_CURRENCY),
    ).resolves.toBeNull();
  });

  it("recovers a quantity decrease on an already-merged line, instead of leaving target stale-high", async () => {
    // Symmetric to the quantity-bump case above: a line whose quantity shrinks concurrently must
    // have that decrease applied against target too. Leaving target at the higher, pre-decrease
    // quantity isn't "nothing to recover" — it's target silently holding more than the customer
    // actually asked for, and it becomes permanent once source is marked "abandoned".
    const contentRef = createTestContentRef();
    const sellableA = createSellableDefinition({ id: createTestMikaId("sellable", 1) });
    const sellableB = createSellableDefinition({ id: createTestMikaId("sellable", 2) });
    const repositories = createTestBackendRepositories({
      stockBySellableId: new Map([
        [
          sellableB.id,
          createStockRecord({ sellableId: sellableB.id, quantityOnHand: 10, quantityReserved: 0 }),
        ],
      ]),
    });
    await repositories.catalog.put(
      createCatalogItemDocument({ contentRef, sellables: [sellableA, sellableB] }),
    );
    const dependencies = createIncrementingBackendDependencies({ repositories });
    const seedApi = createMikaBackendApi(dependencies);
    const guestCtx = createTestRequestContext({
      customerId: false,
      userId: false,
      sessionId: "session_handoff_qty_dec",
    });
    const priorCustomerCtx = createTestRequestContext({
      customerId: "customer_1",
      userId: "user_1",
      sessionId: "session_prior_qty_dec",
    });
    const callerCtx = createTestRequestContext({
      customerId: "customer_1",
      userId: "user_1",
      sessionId: "session_handoff_qty_dec",
    });
    const concurrentUpdateCtx = createTestRequestContext({
      customerId: false,
      userId: false,
      sessionId: "session_handoff_qty_dec",
    });

    const guestCart = await seedApi.cart.add(guestCtx, { sellableId: sellableB.id, quantity: 5 });
    if (!guestCart.ok) throw new Error("Expected seed cart.add to succeed.");
    const guestLineId = guestCart.data.items[0]?.id;
    if (!guestLineId) throw new Error("Expected a seeded guest cart line.");
    const customerCart = await seedApi.cart.add(priorCustomerCtx, {
      sellableId: sellableA.id,
      quantity: 1,
    });
    if (!customerCart.ok) throw new Error("Expected seed cart.add to succeed.");

    let targetWriteEntered: (() => void) | undefined;
    const targetWriteEnteredPromise = new Promise<void>((resolve) => {
      targetWriteEntered = resolve;
    });
    let releaseTargetWrite: (() => void) | undefined;
    const releaseTargetWritePromise = new Promise<void>((resolve) => {
      releaseTargetWrite = resolve;
    });
    let gated = false;
    const gatedSession = new Proxy(repositories.session, {
      get(target, property, receiver) {
        if (property === "putCartIfUnchanged") {
          return async (cart: CartDocument, expectedVersion: number) => {
            if (!gated && cart.id === customerCart.data.id) {
              gated = true;
              targetWriteEntered?.();
              await releaseTargetWritePromise;
            }
            return target.putCartIfUnchanged(cart, expectedVersion);
          };
        }
        const value = Reflect.get(target, property, receiver);

        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const api = createMikaBackendApi({
      ...dependencies,
      repositories: { ...repositories, session: gatedSession },
    });

    const mergePromise = api.cart.merge(callerCtx, {
      targetCartId: customerCart.data.id,
      sourceSessionId: "session_handoff_qty_dec",
    });
    await targetWriteEnteredPromise;
    // While merge is paused right before writing the target (having already read the source as
    // [B qty 5]), a concurrent update shrinks B's quantity to 2 on that same source cart.
    await expect(
      api.cart.update(concurrentUpdateCtx, { lineId: guestLineId, quantity: 2 }),
    ).resolves.toMatchObject({ ok: true });
    releaseTargetWrite?.();

    const merged = await mergePromise;
    expect(merged).toMatchObject({ ok: true, status: 200 });
    if (!merged.ok) throw new Error("Expected cart.merge to succeed.");
    // B's true post-decrease quantity (2) survives — not the stale pre-decrease 5.
    expect(merged.data.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ sellableId: sellableA.id, quantity: 1 }),
        expect.objectContaining({ sellableId: sellableB.id, quantity: 2 }),
      ]),
    );
    expect(merged.data.items).toHaveLength(2);
    await expect(
      repositories.session.findOpenCartBySession("session_handoff_qty_dec", TEST_CURRENCY),
    ).resolves.toBeNull();
  });

  it("recovers a concurrent removal of an already-merged line, instead of leaving it behind", async () => {
    // A line removed entirely from source concurrently is the extreme case of a decrease: target
    // must drop it too, not keep the stale quantity the customer explicitly deleted.
    const contentRef = createTestContentRef();
    const sellableA = createSellableDefinition({ id: createTestMikaId("sellable", 1) });
    const sellableB = createSellableDefinition({ id: createTestMikaId("sellable", 2) });
    const repositories = createTestBackendRepositories({
      stockBySellableId: new Map([
        [
          sellableB.id,
          createStockRecord({ sellableId: sellableB.id, quantityOnHand: 10, quantityReserved: 0 }),
        ],
      ]),
    });
    await repositories.catalog.put(
      createCatalogItemDocument({ contentRef, sellables: [sellableA, sellableB] }),
    );
    const dependencies = createIncrementingBackendDependencies({ repositories });
    const seedApi = createMikaBackendApi(dependencies);
    const guestCtx = createTestRequestContext({
      customerId: false,
      userId: false,
      sessionId: "session_handoff_qty_rm",
    });
    const priorCustomerCtx = createTestRequestContext({
      customerId: "customer_1",
      userId: "user_1",
      sessionId: "session_prior_qty_rm",
    });
    const callerCtx = createTestRequestContext({
      customerId: "customer_1",
      userId: "user_1",
      sessionId: "session_handoff_qty_rm",
    });
    const concurrentRemoveCtx = createTestRequestContext({
      customerId: false,
      userId: false,
      sessionId: "session_handoff_qty_rm",
    });

    const guestCart = await seedApi.cart.add(guestCtx, { sellableId: sellableB.id, quantity: 1 });
    if (!guestCart.ok) throw new Error("Expected seed cart.add to succeed.");
    const guestLineId = guestCart.data.items[0]?.id;
    if (!guestLineId) throw new Error("Expected a seeded guest cart line.");
    const customerCart = await seedApi.cart.add(priorCustomerCtx, {
      sellableId: sellableA.id,
      quantity: 1,
    });
    if (!customerCart.ok) throw new Error("Expected seed cart.add to succeed.");

    let targetWriteEntered: (() => void) | undefined;
    const targetWriteEnteredPromise = new Promise<void>((resolve) => {
      targetWriteEntered = resolve;
    });
    let releaseTargetWrite: (() => void) | undefined;
    const releaseTargetWritePromise = new Promise<void>((resolve) => {
      releaseTargetWrite = resolve;
    });
    let gated = false;
    const gatedSession = new Proxy(repositories.session, {
      get(target, property, receiver) {
        if (property === "putCartIfUnchanged") {
          return async (cart: CartDocument, expectedVersion: number) => {
            if (!gated && cart.id === customerCart.data.id) {
              gated = true;
              targetWriteEntered?.();
              await releaseTargetWritePromise;
            }
            return target.putCartIfUnchanged(cart, expectedVersion);
          };
        }
        const value = Reflect.get(target, property, receiver);

        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const api = createMikaBackendApi({
      ...dependencies,
      repositories: { ...repositories, session: gatedSession },
    });

    const mergePromise = api.cart.merge(callerCtx, {
      targetCartId: customerCart.data.id,
      sourceSessionId: "session_handoff_qty_rm",
    });
    await targetWriteEnteredPromise;
    // While merge is paused right before writing the target (having already read the source as
    // [B qty 1]), a concurrent remove deletes B entirely from that same source cart.
    await expect(
      api.cart.remove(concurrentRemoveCtx, { lineId: guestLineId }),
    ).resolves.toMatchObject({ ok: true });
    releaseTargetWrite?.();

    const merged = await mergePromise;
    expect(merged).toMatchObject({ ok: true, status: 200 });
    if (!merged.ok) throw new Error("Expected cart.merge to succeed.");
    // Only A remains — B was removed from source before the merge landed, so it must not survive
    // in target either.
    expect(merged.data.items).toEqual([
      expect.objectContaining({ sellableId: sellableA.id, quantity: 1 }),
    ]);
    await expect(
      repositories.session.findOpenCartBySession("session_handoff_qty_rm", TEST_CURRENCY),
    ).resolves.toBeNull();
  });

  it("does not orphan a checkout_pending cart's reservation when its owner triggers a cart.merge", async () => {
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
    const fake = createFakeMikaProvider({
      overrides: {
        createCheckoutSession: async () => ({
          id: createMikaId("checkout_fake"),
          status: "created",
          mode: "payment",
          provider: TEST_PROVIDER,
          redirectUrl: "https://checkout.example.test/session/pending",
          expiresAt: createTestClock().isoAt(60 * 60_000),
          providerCheckoutId: "provider_checkout_pending",
        }),
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
    const customerId = createTestMikaId("customer", 1);
    const sourceCtx = createTestRequestContext({
      sessionId: "session_source",
      customerId,
      userId: false,
    });

    const added = await api.cart.add(sourceCtx, { sellableId: sellable.id, quantity: 2 });
    if (!added.ok) throw new Error("Expected cart.add to succeed.");
    const cartId = added.data.id;
    const checkout = await api.checkout.start(sourceCtx, { cartId });
    if (!checkout.ok) throw new Error("Expected checkout.start to succeed.");
    await expect(repositories.session.findById(cartId)).resolves.toMatchObject({
      status: "checkout_pending",
    });
    await expect(repositories.stock.findBySellableId(sellable.id)).resolves.toMatchObject({
      quantityReserved: 2,
    });

    const callerCtx = createTestRequestContext({
      sessionId: "session_caller",
      customerId,
      userId: false,
    });
    const merged = await api.cart.merge(callerCtx, { sourceSessionId: "session_source" });
    expect(merged).toEqual({
      ok: false,
      status: 409,
      error: {
        code: "CONFLICT",
        message: `Cart '${cartId}' is locked by an active checkout.`,
        fieldErrors: { cartId: "Cart is locked by an active checkout." },
      },
    });

    await expect(repositories.session.findById(cartId)).resolves.toMatchObject({
      status: "checkout_pending",
    });
    await expect(repositories.stock.findBySellableId(sellable.id)).resolves.toMatchObject({
      quantityReserved: 2,
    });
  });

  it("refuses to merge a source cart the caller does not own (cross-session IDOR)", async () => {
    const contentRef = createTestContentRef();
    const sellable = createSellableDefinition({ maxPerOrder: 5 });
    const repositories = createTestBackendRepositories();
    await repositories.catalog.put(
      createCatalogItemDocument({ contentRef, sellables: [sellable] }),
    );
    const api = createMikaBackendApi(createIncrementingBackendDependencies({ repositories }));
    const victimCtx = createTestRequestContext({
      customerId: false,
      userId: false,
      sessionId: "session_victim",
    });
    const attackerCtx = createTestRequestContext({
      customerId: false,
      userId: false,
      sessionId: "session_attacker",
    });

    await api.cart.add(victimCtx, {
      sellableId: sellable.id,
      priceId: createTestMikaId("price", 1),
      quantity: 2,
    });
    await api.cart.add(attackerCtx, {
      sellableId: sellable.id,
      priceId: createTestMikaId("price", 1),
      quantity: 1,
    });

    const merged = await api.cart.merge(attackerCtx, { sourceSessionId: "session_victim" });
    expect(merged).toMatchObject({
      ok: true,
      status: 200,
      data: { items: [{ sellableId: sellable.id, quantity: 1 }] },
    });

    const victimCart = await repositories.session.findOpenCartBySession(
      "session_victim",
      TEST_CURRENCY,
    );
    expect(victimCart?.status).toBe("open");
    expect(victimCart?.aggregate.items).toHaveLength(1);
    expect(victimCart?.aggregate.items[0]?.quantity).toBe(2);
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

  it("rejects coupon codes when no coupon resolver is configured", async () => {
    const contentRef = createTestContentRef();
    const sellable = createSellableDefinition();
    const repositories = createTestBackendRepositories();
    await repositories.catalog.put(
      createCatalogItemDocument({ contentRef, sellables: [sellable] }),
    );
    const api = createMikaBackendApi(
      createIncrementingBackendDependencies({ repositories, config: {} }),
    );
    const ctx = createTestRequestContext({
      customerId: false,
      userId: false,
    });

    await api.cart.add(ctx, { sellableId: sellable.id, quantity: 2 });

    await expect(api.cart.applyCoupon(ctx, { code: "save10" })).resolves.toMatchObject({
      ok: false,
      status: 422,
      error: {
        code: "VALIDATION_FAILED",
        fieldErrors: { code: "Coupon codes are not supported." },
      },
    });
  });

  it("rejects coupon codes the resolver declines and honors resolved terms", async () => {
    const contentRef = createTestContentRef();
    const sellable = createSellableDefinition();
    const repositories = createTestBackendRepositories();
    await repositories.catalog.put(
      createCatalogItemDocument({ contentRef, sellables: [sellable] }),
    );
    const api = createMikaBackendApi(
      createIncrementingBackendDependencies({
        repositories,
        config: {
          coupons: {
            resolver: ({ code }) =>
              code === "QUARTER" ? { label: "Quarter Off", rate: 0.25 } : null,
          },
        },
      }),
    );
    const ctx = createTestRequestContext({
      customerId: false,
      userId: false,
    });

    await api.cart.add(ctx, { sellableId: sellable.id, quantity: 2 });

    await expect(api.cart.applyCoupon(ctx, { code: "save10" })).resolves.toMatchObject({
      ok: false,
      status: 422,
      error: {
        code: "VALIDATION_FAILED",
        fieldErrors: { code: "Coupon code 'SAVE10' is not valid." },
      },
    });
    await expect(api.cart.applyCoupon(ctx, { code: " quarter " })).resolves.toMatchObject({
      ok: true,
      data: {
        coupon: {
          label: "Quarter Off",
          discount: { amount: 600, currency: TEST_CURRENCY },
        },
        subtotal: { amount: 2400, currency: TEST_CURRENCY },
        total: { amount: 1800, currency: TEST_CURRENCY },
      },
    });

    // Re-quoting the applied code compares by code hash, so a custom resolver label
    // ("Quarter Off" vs "QUARTER") must not report the quote as changed.
    await expect(api.cart.quote(ctx, { couponCode: "quarter" })).resolves.toMatchObject({
      ok: true,
      data: {
        status: "valid",
        discount: { amount: 600, currency: TEST_CURRENCY },
        total: { amount: 1800, currency: TEST_CURRENCY },
      },
    });
  });

  it("flags unresolvable quote couponCodes without applying a discount", async () => {
    const contentRef = createTestContentRef();
    const sellable = createSellableDefinition();
    const repositories = createTestBackendRepositories();
    await repositories.catalog.put(
      createCatalogItemDocument({ contentRef, sellables: [sellable] }),
    );
    const api = createMikaBackendApi(
      createIncrementingBackendDependencies({
        repositories,
        config: {
          coupons: {
            resolver: ({ code }) => (code === "QUARTER" ? { rate: 0.25 } : null),
          },
        },
      }),
    );
    const ctx = createTestRequestContext({
      customerId: false,
      userId: false,
    });

    await api.cart.add(ctx, { sellableId: sellable.id, quantity: 2 });

    const quote = await api.cart.quote(ctx, { couponCode: "nope" });
    expect(quote).toMatchObject({
      ok: true,
      data: {
        status: "unavailable",
        discount: undefined,
        subtotal: { amount: 2400, currency: TEST_CURRENCY },
        total: { amount: 2400, currency: TEST_CURRENCY },
        errors: [
          {
            code: "VALIDATION_FAILED",
            fieldErrors: { couponCode: "Coupon code 'NOPE' is not valid." },
          },
        ],
      },
    });
  });

  it("passes the applied cart coupon discount to the checkout provider", async () => {
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
    if (!added.ok) throw new Error("Expected cart.add to succeed.");
    await expect(api.cart.applyCoupon(ctx, { code: "SAVE10" })).resolves.toMatchObject({
      ok: true,
      data: {
        subtotal: { amount: 2400 },
        discount: { amount: 240, currency: TEST_CURRENCY },
        total: { amount: 2160 },
      },
    });

    const checkout = await api.checkout.start(ctx, { cartId: added.data.id });
    if (!checkout.ok) throw new Error("Expected checkout.start to succeed.");

    const call = fake.getCalls().createCheckoutSession[0];
    expect(call?.discount).toMatchObject({ amount: 240, currency: TEST_CURRENCY });
    const lineSubtotal = (call?.lines ?? []).reduce(
      (sum, line) => sum + line.unitAmount * line.quantity,
      0,
    );
    expect(lineSubtotal).toBe(2400);
    expect(lineSubtotal - (call?.discount?.amount ?? 0)).toBe(2160);
    // The backend hands the provider its authoritative charge total so direct-charge
    // adapters (delegated payments) never have to recompute it from lines.
    expect(call?.total).toMatchObject({ amount: 2160, currency: TEST_CURRENCY });
  });

  it("serializes concurrent checkout starts on the same cart before provider handoff", async () => {
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
    let providerStarted: (() => void) | undefined;
    let releaseProvider: (() => void) | undefined;
    const providerStartedPromise = new Promise<void>((resolve) => {
      providerStarted = resolve;
    });
    const providerReleasePromise = new Promise<void>((resolve) => {
      releaseProvider = resolve;
    });
    const fake = createFakeMikaProvider({
      overrides: {
        createCheckoutSession: async () => {
          providerStarted?.();
          await providerReleasePromise;

          return {
            id: createTestMikaId("checkout_fake", 1),
            status: "created",
            mode: "payment",
            provider: TEST_PROVIDER,
            redirectUrl: "https://checkout.example.test/session/checkout_fake",
            expiresAt: createISODateTime("2026-01-01T01:00:00.000Z"),
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
    const ctx = createTestRequestContext({ customerId: false, userId: false });
    const added = await api.cart.add(ctx, { sellableId: sellable.id, quantity: 1 });
    if (!added.ok) throw new Error("Expected cart.add to succeed.");

    const first = api.checkout.start(ctx, { cartId: added.data.id });
    await providerStartedPromise;
    // The claimed cart is no longer an open cart, so the concurrent start sees NOT_FOUND.
    await expect(api.checkout.start(ctx, { cartId: added.data.id })).resolves.toMatchObject({
      ok: false,
      error: { code: "NOT_FOUND" },
    });
    expect(fake.getCalls().createCheckoutSession).toHaveLength(1);

    releaseProvider?.();
    await expect(first).resolves.toMatchObject({
      ok: true,
      status: 200,
      data: { id: "checkout_1" },
    });
    expect(fake.getCalls().createCheckoutSession).toHaveLength(1);
    await expect(repositories.session.findById(added.data.id)).resolves.toMatchObject({
      type: "cart",
      status: "checkout_pending",
      aggregate: { metadata: { checkoutSessionId: "checkout_1" } },
    });
  });

  it("applies a checkout.start couponCode to the provider discount and checkout coupon", async () => {
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
    if (!added.ok) throw new Error("Expected cart.add to succeed.");

    const checkout = await api.checkout.start(ctx, {
      cartId: added.data.id,
      couponCode: "SAVE10",
    });
    if (!checkout.ok) throw new Error("Expected checkout.start to succeed.");

    const call = fake.getCalls().createCheckoutSession[0];
    expect(call?.discount).toMatchObject({ amount: 240, currency: TEST_CURRENCY });
    const lineSubtotal = (call?.lines ?? []).reduce(
      (sum, line) => sum + line.unitAmount * line.quantity,
      0,
    );
    expect(lineSubtotal - (call?.discount?.amount ?? 0)).toBe(2160);
    await expect(repositories.session.findCheckoutById(checkout.data.id)).resolves.toMatchObject({
      aggregate: { coupon: { label: "SAVE10" } },
    });
  });

  it("reports swallowed compensation failures to the onError observer", async () => {
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
    // Note: the proxy is not identity-equal to the SessionRepository instance, so WeakMap-keyed
    // internals (findSessionRepositoryOpenCartBySessionAnyCurrency) silently miss through it —
    // fine here because this flow never reaches cart.merge; don't reuse this pattern for merges.
    const failingSession = new Proxy(repositories.session, {
      get(target, property, receiver) {
        if (property === "releaseCartCheckoutClaim") {
          return async () => {
            throw new Error("release unavailable");
          };
        }
        const value = Reflect.get(target, property, receiver);

        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const fake = createFakeMikaProvider({
      overrides: {
        createCheckoutSession: async () => {
          throw new Error("provider unavailable");
        },
      },
    });
    await repositories.catalog.put(
      createCatalogItemDocument({ contentRef, sellables: [sellable] }),
    );
    const observed: string[] = [];
    const api = createMikaBackendApi(
      createIncrementingBackendDependencies({
        repositories: { ...repositories, session: failingSession },
        providers: createMikaProviderRegistry([fake.provider]),
        onError: (context) => {
          observed.push(context.scope);
        },
      }),
    );
    const ctx = createTestRequestContext({ customerId: false, userId: false });

    const added = await api.cart.add(ctx, { sellableId: sellable.id, quantity: 2 });
    if (!added.ok) throw new Error("Expected cart.add to succeed.");

    // The provider failure is reported to the caller; the claim-release failure it triggers is
    // swallowed by design and must surface through the observer instead.
    await expect(api.checkout.start(ctx, { cartId: added.data.id })).resolves.toMatchObject({
      ok: false,
      status: 502,
      error: { code: "PROVIDER_FAILED" },
    });

    expect(observed).toContain("checkout.releaseCartClaim");
  });

  it("does not persist checkout.start couponCode when checkout creation fails", async () => {
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
          throw new Error("provider unavailable");
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
    if (!added.ok) throw new Error("Expected cart.add to succeed.");

    await expect(
      api.checkout.start(ctx, {
        cartId: added.data.id,
        couponCode: "SAVE10",
      }),
    ).resolves.toMatchObject({
      ok: false,
      status: 502,
      error: { code: "PROVIDER_FAILED" },
    });

    await expect(repositories.session.findById(added.data.id)).resolves.toMatchObject({
      type: "cart",
      status: "open",
      aggregate: { coupon: undefined },
    });
    await expect(repositories.stock.findBySellableId(sellable.id)).resolves.toMatchObject({
      quantityReserved: 0,
    });
  });

  it("compensates reservations and cart claim when reservation extension fails after provider handoff", async () => {
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
    const originalExtendReservations = repositories.stock.extendReservations.bind(
      repositories.stock,
    );
    repositories.stock.extendReservations = async () => {
      throw new Error("stock extension unavailable");
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
    const ctx = createTestRequestContext({ customerId: false, userId: false });
    const added = await api.cart.add(ctx, { sellableId: sellable.id, quantity: 2 });
    if (!added.ok) throw new Error("Expected cart.add to succeed.");

    await expect(api.checkout.start(ctx, { cartId: added.data.id })).resolves.toMatchObject({
      ok: false,
      status: 409,
      error: { code: "CONFLICT" },
    });
    expect(fake.getCalls().createCheckoutSession).toHaveLength(1);
    await expect(repositories.session.findById(added.data.id)).resolves.toMatchObject({
      type: "cart",
      status: "open",
    });
    await expect(
      repositories.session.findCheckoutById(createTestMikaId("checkout", 1)),
    ).resolves.toBeNull();
    await expect(repositories.stock.findBySellableId(sellable.id)).resolves.toMatchObject({
      quantityReserved: 0,
    });

    repositories.stock.extendReservations = originalExtendReservations;
  });

  it("lets a checkout.start couponCode override the persisted cart coupon", async () => {
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
    if (!added.ok) throw new Error("Expected cart.add to succeed.");
    await expect(api.cart.applyCoupon(ctx, { code: "SAVE10" })).resolves.toMatchObject({
      ok: true,
    });

    const checkout = await api.checkout.start(ctx, {
      cartId: added.data.id,
      couponCode: "SAVE20",
    });
    if (!checkout.ok) throw new Error("Expected checkout.start to succeed.");

    await expect(repositories.session.findCheckoutById(checkout.data.id)).resolves.toMatchObject({
      aggregate: { coupon: { label: "SAVE20" } },
    });
    await expect(
      repositories.session.findCheckoutPendingCartBySession("session_1", TEST_CURRENCY),
    ).resolves.toMatchObject({ aggregate: { coupon: { label: "SAVE20" } } });
  });

  it("rejects checkout.start when both cartId and sellableId are supplied", async () => {
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
      }),
    );
    const ctx = createTestRequestContext({ customerId: false, userId: false });

    const added = await api.cart.add(ctx, { sellableId: sellable.id, quantity: 1 });
    if (!added.ok) throw new Error("Expected cart.add to succeed.");

    await expect(
      api.checkout.start(ctx, { cartId: added.data.id, sellableId: sellable.id, quantity: 1 }),
    ).resolves.toMatchObject({
      ok: false,
      status: 422,
      error: { code: "VALIDATION_FAILED" },
    });

    await expect(repositories.stock.findBySellableId(sellable.id)).resolves.toMatchObject({
      quantityReserved: 0,
    });
    expect(fake.getCalls().createCheckoutSession).toEqual([]);
  });

  it("omits a provider discount when no coupon is applied", async () => {
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
    if (!added.ok) throw new Error("Expected cart.add to succeed.");
    const checkout = await api.checkout.start(ctx, { cartId: added.data.id });
    if (!checkout.ok) throw new Error("Expected checkout.start to succeed.");

    expect(fake.getCalls().createCheckoutSession[0]?.discount).toBeUndefined();
  });

  it("recomputes a percentage coupon against the current subtotal after line changes", async () => {
    const contentRef = createTestContentRef();
    const sellable = createSellableDefinition();
    const repositories = createTestBackendRepositories();
    await repositories.catalog.put(
      createCatalogItemDocument({ contentRef, sellables: [sellable] }),
    );
    const api = createMikaBackendApi(createIncrementingBackendDependencies({ repositories }));
    const ctx = createTestRequestContext({ customerId: false, userId: false });

    const added = await api.cart.add(ctx, { sellableId: sellable.id, quantity: 2 });
    if (!added.ok) throw new Error("Expected cart.add to succeed.");
    const lineId = added.data.items[0]!.id;

    await expect(api.cart.applyCoupon(ctx, { code: "SAVE10" })).resolves.toMatchObject({
      ok: true,
      data: {
        subtotal: { amount: 2400 },
        discount: { amount: 240 },
        total: { amount: 2160 },
      },
    });

    await expect(api.cart.update(ctx, { lineId, quantity: 1 })).resolves.toMatchObject({
      ok: true,
      data: {
        subtotal: { amount: 1200 },
        discount: { amount: 120 },
        total: { amount: 1080 },
      },
    });
    await expect(api.cart.get(ctx)).resolves.toMatchObject({
      ok: true,
      data: {
        subtotal: { amount: 1200 },
        discount: { amount: 120 },
        total: { amount: 1080 },
      },
    });

    const quote = await api.cart.quote(ctx, { cartId: added.data.id });
    expect(quote).toMatchObject({
      ok: true,
      data: {
        subtotal: { amount: 1200 },
        discount: { amount: 120 },
        total: { amount: 1080 },
      },
    });
  });

  it("rejects open-cart coupon access from an unbound request context", async () => {
    const contentRef = createTestContentRef();
    const sellable = createSellableDefinition();
    const repositories = createTestBackendRepositories();
    await repositories.catalog.put(
      createCatalogItemDocument({ contentRef, sellables: [sellable] }),
    );
    const api = createMikaBackendApi(createIncrementingBackendDependencies({ repositories }));

    const victimCtx = createTestRequestContext({
      sessionId: "session_victim",
      customerId: false,
      userId: false,
    });
    const victimCart = await api.cart.add(victimCtx, { sellableId: sellable.id, quantity: 1 });
    if (!victimCart.ok) throw new Error("Expected cart.add to succeed.");

    const unboundCtx = createTestRequestContext({
      sessionId: false,
      customerId: false,
      userId: false,
    });

    await expect(
      api.cart.applyCoupon(unboundCtx, { cartId: victimCart.data.id, code: "SAVE10" }),
    ).resolves.toMatchObject({ ok: false, status: 404 });
    await expect(
      api.cart.removeCoupon(unboundCtx, { cartId: victimCart.data.id }),
    ).resolves.toMatchObject({ ok: false, status: 404 });
    await expect(
      api.cart.merge(unboundCtx, { targetCartId: victimCart.data.id }),
    ).resolves.toMatchObject({ ok: false, status: 404 });
  });

  it("rejects id-targeted cart and wishlist access when persisted documents are unbound", async () => {
    const contentRef = createTestContentRef();
    const sellable = createSellableDefinition();
    const repositories = createTestBackendRepositories();
    await repositories.catalog.put(
      createCatalogItemDocument({ contentRef, sellables: [sellable] }),
    );
    const api = createMikaBackendApi(createIncrementingBackendDependencies({ repositories }));
    const unboundCtx = createTestRequestContext({
      sessionId: false,
      customerId: false,
      userId: false,
    });

    const cart = await api.cart.add(unboundCtx, { sellableId: sellable.id, quantity: 1 });
    if (!cart.ok) throw new Error("Expected unbound cart.add fixture to succeed.");
    const wishlist = await api.wishlist.add(unboundCtx, { sellableId: sellable.id });
    if (!wishlist.ok) throw new Error("Expected unbound wishlist.add fixture to succeed.");

    await expect(
      api.cart.applyCoupon(unboundCtx, { cartId: cart.data.id, code: "SAVE10" }),
    ).resolves.toMatchObject({ ok: false, status: 404 });
    await expect(
      api.cart.removeCoupon(unboundCtx, { cartId: cart.data.id }),
    ).resolves.toMatchObject({ ok: false, status: 404 });
    await expect(api.cart.merge(unboundCtx, { targetCartId: cart.data.id })).resolves.toMatchObject(
      { ok: false, status: 404 },
    );
    await expect(
      api.wishlist.merge(unboundCtx, { targetWishlistId: wishlist.data.id }),
    ).resolves.toMatchObject({ ok: false, status: 404 });
  });

  it("resolves the customer-bound cart from a session-stored identity after login", async () => {
    const contentRef = createTestContentRef();
    const sellable = createSellableDefinition();
    const repositories = createTestBackendRepositories();
    await repositories.catalog.put(
      createCatalogItemDocument({ contentRef, sellables: [sellable] }),
    );
    const api = createMikaBackendApi(createIncrementingBackendDependencies({ repositories }));

    const customerId = createMikaId("customer_login");
    await repositories.account.put(createCustomerDocument({ customerId }));
    const customerCtx = createTestRequestContext({
      sessionId: false,
      customerId,
      userId: false,
    });
    const added = await api.cart.add(customerCtx, { sellableId: sellable.id, quantity: 2 });
    if (!added.ok) throw new Error("Expected cart.add to succeed.");

    const sessionCtx = createTestRequestContext({
      sessionId: "session_login",
      customerId: false,
      userId: false,
    });
    await sessionCtx.session?.set("mika.customerId", customerId);

    const resolved = await api.cart.get(sessionCtx);
    expect(resolved).toMatchObject({
      ok: true,
      data: {
        id: added.data.id,
        items: [{ sellableId: sellable.id, quantity: 2 }],
      },
    });
  });

  it("does not hydrate a session customerId that belongs to another host user", async () => {
    const contentRef = createTestContentRef();
    const sellable = createSellableDefinition();
    const repositories = createTestBackendRepositories();
    await repositories.catalog.put(
      createCatalogItemDocument({ contentRef, sellables: [sellable] }),
    );
    const api = createMikaBackendApi(createIncrementingBackendDependencies({ repositories }));

    const customerId = createMikaId("customer_desync");
    await repositories.account.put(
      createCustomerDocument({
        customerId,
        userId: "user_b",
      }),
    );
    const customerCtx = createTestRequestContext({
      sessionId: false,
      customerId,
      userId: "user_b",
    });
    const added = await api.cart.add(customerCtx, { sellableId: sellable.id, quantity: 1 });
    if (!added.ok) throw new Error("Expected cart.add to succeed.");

    const mismatchedCtx = createTestRequestContext({
      sessionId: "session_desync",
      customerId: false,
      userId: "user_a",
    });
    await mismatchedCtx.session?.set("mika.customerId", customerId);

    await expect(
      api.cart.applyCoupon(mismatchedCtx, { cartId: added.data.id, code: "SAVE10" }),
    ).resolves.toMatchObject({ ok: false, status: 404 });
    await expect(api.account.get(mismatchedCtx)).resolves.toMatchObject({
      ok: false,
      status: 401,
      error: { code: "AUTH_REQUIRED" },
    });
  });

  it("hydrates the session customerId onto the persisted checkout document", async () => {
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
      }),
    );

    const ctx = createTestRequestContext({
      sessionId: "session_checkout_login",
      customerId: false,
      userId: false,
    });
    const added = await api.cart.add(ctx, { sellableId: sellable.id, quantity: 2 });
    if (!added.ok) throw new Error("Expected cart.add to succeed.");

    const customerId = createMikaId("customer_checkout_login");
    await repositories.account.put(createCustomerDocument({ customerId }));
    await ctx.session?.set("mika.customerId", customerId);

    const checkout = await api.checkout.start(ctx, { cartId: added.data.id });
    if (!checkout.ok) throw new Error("Expected checkout.start to succeed.");

    await expect(repositories.session.findCheckoutById(checkout.data.id)).resolves.toMatchObject({
      customerId,
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

  it("marks cart quotes unavailable instead of appending a sellable when cartId is present", async () => {
    const contentRef = createTestContentRef();
    const sellable = createSellableDefinition();
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

    const quote = await api.cart.quote(ctx, {
      cartId: added.data.id,
      sellableId: sellable.id,
      quantity: 1,
    });

    expect(quote).toMatchObject({
      ok: true,
      status: 200,
      data: {
        status: "unavailable",
        subtotal: { amount: 2400, currency: TEST_CURRENCY },
        total: { amount: 2400, currency: TEST_CURRENCY },
        errors: [{ code: "VALIDATION_FAILED", fieldErrors: { sellableId: expect.any(String) } }],
      },
    });
    if (!quote.ok) {
      throw new Error("Expected cart.quote to return a quote DTO.");
    }
    expect(quote.data.items).toHaveLength(1);
  });

  it("clears persisted coupons from quotes when couponCode is explicitly empty", async () => {
    const contentRef = createTestContentRef();
    const sellable = createSellableDefinition();
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
    await expect(api.cart.applyCoupon(ctx, { code: "SAVE10" })).resolves.toMatchObject({
      ok: true,
      data: { discount: { amount: 240 }, total: { amount: 2160 } },
    });

    const quote = await api.cart.quote(ctx, { cartId: added.data.id, couponCode: "" });

    expect(quote).toMatchObject({
      ok: true,
      data: {
        status: "changed",
        subtotal: { amount: 2400, currency: TEST_CURRENCY },
        total: { amount: 2400, currency: TEST_CURRENCY },
      },
    });
    if (!quote.ok) {
      throw new Error("Expected cart.quote to return a quote DTO.");
    }
    expect(quote.data.coupon).toBeUndefined();
    expect(quote.data.discount).toBeUndefined();
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
    await expectCheckoutFailureInvariant({
      repositories,
      provider: fake,
      providerCheckoutCalls: 0,
      checkoutId: createTestMikaId("checkout", 1),
      checkoutStatus: null,
    });
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
    await expectCheckoutFailureInvariant({
      repositories,
      provider: fake,
      providerCheckoutCalls: 0,
      stockSellableId: sellable.id,
      quantityReserved: 1,
      checkoutId: createTestMikaId("checkout", 1),
      checkoutStatus: null,
    });
  });

  it("validates split cart lines against aggregate maxPerOrder at quote and checkout start", async () => {
    const contentRef = createTestContentRef();
    const prices = [
      createPriceDefinition({ id: createTestMikaId("price", 1) }),
      createPriceDefinition({ id: createTestMikaId("price", 2) }),
    ];
    const unrestrictedSellable = createSellableDefinition({ prices });
    const limitedSellable = { ...unrestrictedSellable, maxPerOrder: 5 };
    const repositories = createTestBackendRepositories();
    const fake = createFakeMikaProvider();
    await repositories.catalog.put(
      createCatalogItemDocument({ contentRef, sellables: [unrestrictedSellable] }),
    );
    const api = createMikaBackendApi(
      createIncrementingBackendDependencies({
        repositories,
        providers: createMikaProviderRegistry([fake.provider]),
      }),
    );
    const ctx = createTestRequestContext({ customerId: false, userId: false });

    const first = await api.cart.add(ctx, {
      sellableId: unrestrictedSellable.id,
      priceId: createTestMikaId("price", 1),
      quantity: 3,
    });
    if (!first.ok) {
      throw new Error("Expected first cart.add to succeed.");
    }
    await expect(
      api.cart.add(ctx, {
        sellableId: unrestrictedSellable.id,
        priceId: createTestMikaId("price", 2),
        quantity: 3,
      }),
    ).resolves.toMatchObject({ ok: true, status: 200 });
    await repositories.catalog.put(
      createCatalogItemDocument({ contentRef, sellables: [limitedSellable] }),
    );

    await expect(api.cart.quote(ctx, { cartId: first.data.id })).resolves.toMatchObject({
      ok: true,
      data: {
        status: "unavailable",
        items: [
          { warnings: [expect.stringContaining("allows at most 5")] },
          { warnings: [expect.stringContaining("allows at most 5")] },
        ],
      },
    });
    await expect(api.checkout.start(ctx, { cartId: first.data.id })).resolves.toMatchObject({
      ok: false,
      status: 409,
      error: { code: "MAX_PER_ORDER_EXCEEDED" },
    });
    expect(fake.getCalls().createCheckoutSession).toEqual([]);
  });

  it("extends checkout reservations to the persisted provider session expiry", async () => {
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
      }),
    );
    const ctx = createTestRequestContext({ customerId: false, userId: false });

    const added = await api.cart.add(ctx, { sellableId: sellable.id, quantity: 2 });
    if (!added.ok) throw new Error("Expected cart.add to succeed.");
    const checkout = await api.checkout.start(ctx, { cartId: added.data.id });
    if (!checkout.ok) throw new Error("Expected checkout.start to succeed.");

    const checkoutDocument = await repositories.session.findById(createTestMikaId("checkout", 1));
    expect(checkoutDocument).toMatchObject({
      expiresAt: createISODateTime("2026-01-01T01:00:00.000Z"),
    });
    const reservation = await repositories.stock.findEventById(createTestMikaId("stock_event", 1));
    expect(reservation).toMatchObject({
      kind: "reservation",
      status: "active",
      expiresAt: createISODateTime("2026-01-01T01:00:00.000Z"),
    });
  });

  it("expires checkout reservations when checkout status observes wall-clock expiry", async () => {
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
    let backendNow = createTestClock().now;
    const api = createMikaBackendApi(
      createIncrementingBackendDependencies({
        repositories,
        providers: createMikaProviderRegistry([fake.provider]),
        now: () => backendNow,
        isoNow: () => createISODateTime(backendNow.toISOString()),
      }),
    );
    const ctx = createTestRequestContext({ customerId: false, userId: false });

    const added = await api.cart.add(ctx, { sellableId: sellable.id, quantity: 2 });
    if (!added.ok) throw new Error("Expected cart.add to succeed.");
    const checkout = await api.checkout.start(ctx, { cartId: added.data.id });
    if (!checkout.ok) throw new Error("Expected checkout.start to succeed.");
    await expect(repositories.stock.findBySellableId(sellable.id)).resolves.toMatchObject({
      quantityReserved: 2,
    });

    backendNow = createTestClock().at(2 * 60 * 60_000);
    const expiredCtx = createTestRequestContext({
      customerId: false,
      userId: false,
      now: backendNow,
    });
    await expect(
      api.checkout.status(expiredCtx, { checkoutId: checkout.data.id }),
    ).resolves.toMatchObject({
      ok: false,
      status: 409,
      error: { code: "CHECKOUT_EXPIRED" },
    });

    await expect(repositories.session.findCheckoutById(checkout.data.id)).resolves.toMatchObject({
      status: "expired",
      providerStatus: "expired",
      updatedAt: "2026-01-01T02:00:00.000Z",
    });
    await expect(
      repositories.stock.findEventById(createTestMikaId("stock_event", 1)),
    ).resolves.toMatchObject({
      status: "expired",
      updatedAt: "2026-01-01T02:00:00.000Z",
    });
    await expect(repositories.stock.findBySellableId(sellable.id)).resolves.toMatchObject({
      quantityReserved: 0,
    });
  });

  it("reopens an abandoned checkout_pending cart so its items are not trapped", async () => {
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
    const fake = createFakeMikaProvider({
      overrides: {
        createCheckoutSession: async () => ({
          id: createMikaId("checkout_fake"),
          status: "created",
          mode: "payment",
          provider: TEST_PROVIDER,
          redirectUrl: "https://checkout.example.test/session/abandoned",
          expiresAt: createTestClock().isoAt(60 * 60_000),
          providerCheckoutId: "provider_checkout_abandoned",
        }),
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
      sessionId: "session_abandon",
      customerId: false,
      userId: false,
    });

    const added = await api.cart.add(ctx, { sellableId: sellable.id, quantity: 2 });
    if (!added.ok) throw new Error("Expected cart.add to succeed.");
    const cartId = added.data.id;

    const checkout = await api.checkout.start(ctx, { cartId });
    if (!checkout.ok) throw new Error("Expected checkout.start to succeed.");
    await expect(repositories.session.findById(cartId)).resolves.toMatchObject({
      status: "checkout_pending",
    });
    await expect(repositories.stock.findBySellableId(sellable.id)).resolves.toMatchObject({
      quantityReserved: 2,
    });

    const checkoutDoc = await repositories.session.findCheckoutById(createMikaId("checkout_1"));
    if (!checkoutDoc) throw new Error("Expected checkout document.");
    await repositories.session.put({ ...checkoutDoc, status: "failed" });

    const reopened = await api.cart.get(ctx);
    expect(reopened).toMatchObject({
      ok: true,
      data: { id: cartId, items: [{ sellableId: sellable.id, quantity: 2 }] },
    });
    await expect(repositories.session.findById(cartId)).resolves.toMatchObject({
      status: "open",
    });
    await expect(repositories.stock.findBySellableId(sellable.id)).resolves.toMatchObject({
      quantityReserved: 0,
    });
    await expect(
      repositories.stock.findEventById(createTestMikaId("stock_event", 1)),
    ).resolves.toMatchObject({
      status: "expired",
    });

    await expect(
      api.cart.add(ctx, { sellableId: sellable.id, quantity: 1 }),
    ).resolves.toMatchObject({ ok: true, data: { id: cartId } });
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
    await expectCheckoutFailureInvariant({
      repositories,
      provider: fake,
      providerCheckoutCalls: 0,
      stockSellableId: sellable.id,
      quantityReserved: 0,
      checkoutId: createTestMikaId("checkout", 1),
      checkoutStatus: null,
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
    const notificationIntents: MikaNotificationIntent[] = [];
    const api = createMikaBackendApi(
      createIncrementingBackendDependencies({
        repositories,
        providers: createMikaProviderRegistry([fake.provider]),
        notifications: {
          handle: (intent) => {
            notificationIntents.push(intent);
          },
        },
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
    await expectCheckoutFailureInvariant({
      repositories,
      provider: fake,
      providerCheckoutCalls: 1,
      stockSellableId: sellable.id,
      quantityReserved: 0,
      cartId: added.data.id,
      cartStatus: "open",
      checkoutId: createTestMikaId("checkout", 1),
      checkoutStatus: null,
    });
    expect(notificationIntents).toEqual([
      expect.objectContaining({
        kind: "checkout.payment_failed",
        occurredAt: TEST_NOW,
        context: {
          provider: TEST_PROVIDER,
          status: "failed",
          error: "Checkout provider failed to create a session.",
          total: { amount: 2400, currency: TEST_CURRENCY },
        },
      }),
    ]);
  });

  it("releases prefix reservations when checkout reservation creation throws mid-loop", async () => {
    const contentRef = createTestContentRef();
    const sellableA = createSellableDefinition({
      id: createTestMikaId("sellable", 1),
      prices: [createPriceDefinition({ id: createTestMikaId("price", 1) })],
    });
    const sellableB = createSellableDefinition({
      id: createTestMikaId("sellable", 2),
      prices: [createPriceDefinition({ id: createTestMikaId("price", 2) })],
    });
    const repositories = createTestBackendRepositories({
      stockBySellableId: new Map([
        [
          sellableA.id,
          createStockRecord({
            id: createTestMikaId("stock", 1),
            sellableId: sellableA.id,
            quantityReserved: 0,
          }),
        ],
        [
          sellableB.id,
          createStockRecord({
            id: createTestMikaId("stock", 2),
            sellableId: sellableB.id,
            quantityReserved: 0,
          }),
        ],
      ]),
    });
    const reserve = repositories.stock.reserve.bind(repositories.stock);
    let reserveCalls = 0;
    repositories.stock.reserve = async (reservation) => {
      reserveCalls += 1;
      if (reserveCalls === 2) {
        throw new Error("reserve storage unavailable");
      }

      return reserve(reservation);
    };
    const fake = createFakeMikaProvider();
    await repositories.catalog.put(
      createCatalogItemDocument({ contentRef, sellables: [sellableA, sellableB] }),
    );
    const api = createMikaBackendApi(
      createIncrementingBackendDependencies({
        repositories,
        providers: createMikaProviderRegistry([fake.provider]),
      }),
    );
    const ctx = createTestRequestContext({ customerId: false, userId: false });

    const addedA = await api.cart.add(ctx, { sellableId: sellableA.id, quantity: 1 });
    if (!addedA.ok) throw new Error("Expected first cart.add to succeed.");
    const addedB = await api.cart.add(ctx, { sellableId: sellableB.id, quantity: 1 });
    if (!addedB.ok) throw new Error("Expected second cart.add to succeed.");

    await expect(api.checkout.start(ctx, { cartId: addedB.data.id })).rejects.toThrow(
      "reserve storage unavailable",
    );

    expect(fake.getCalls().createCheckoutSession).toEqual([]);
    await expect(repositories.stock.findBySellableId(sellableA.id)).resolves.toMatchObject({
      quantityReserved: 0,
    });
    await expect(repositories.stock.findBySellableId(sellableB.id)).resolves.toMatchObject({
      quantityReserved: 0,
    });
    await expect(
      repositories.stock.findEventById(createTestMikaId("stock_event", 1)),
    ).resolves.toMatchObject({ status: "released" });
    await expect(
      repositories.session.findById(createTestMikaId("checkout", 1)),
    ).resolves.toBeNull();
  });

  it("releases reservations when the checkout provider returns a failed session", async () => {
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
        createCheckoutSession: async () => ({
          id: createMikaId("checkout_failed_provider"),
          status: "failed",
          mode: "payment",
          provider: TEST_PROVIDER,
          providerCheckoutId: "provider_checkout_failed",
        }),
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
    if (!added.ok) throw new Error("Expected cart.add to succeed.");

    await expect(api.checkout.start(ctx, { cartId: added.data.id })).resolves.toMatchObject({
      ok: false,
      status: 502,
      error: {
        code: "PROVIDER_FAILED",
        message: "Checkout provider returned a failed session.",
      },
    });

    expect(fake.getCalls().createCheckoutSession).toHaveLength(1);
    await expect(repositories.stock.findBySellableId(sellable.id)).resolves.toMatchObject({
      quantityReserved: 0,
    });
    await expect(
      repositories.stock.findEventById(createTestMikaId("stock_event", 1)),
    ).resolves.toMatchObject({ status: "released" });
    await expect(repositories.session.findById(added.data.id)).resolves.toMatchObject({
      type: "cart",
      status: "open",
    });
    await expect(
      repositories.session.findById(createTestMikaId("checkout", 1)),
    ).resolves.toBeNull();
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
      successUrl:
        "https://shop.example.test/success?checkoutId=checkout_1&token=checkout_status_token_1",
      cancelUrl:
        "https://shop.example.test/cancel?checkoutId=checkout_1&token=checkout_status_token_1",
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

  it("surfaces a resumable checkout cart without creating a second open cart", async () => {
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
    const added = await api.cart.add(ctx, { sellableId: sellable.id, quantity: 1 });
    if (!added.ok) throw new Error("Expected cart.add to succeed.");

    await expect(api.checkout.start(ctx, { cartId: added.data.id })).resolves.toMatchObject({
      ok: true,
      status: 200,
    });

    await expect(api.cart.get(ctx)).resolves.toMatchObject({
      ok: true,
      status: 200,
      data: {
        id: added.data.id,
        status: "checkout_pending",
        items: [{ sellableId: sellable.id }],
      },
    });
    await expect(api.cart.add(ctx, { sellableId: sellable.id, quantity: 1 })).resolves.toEqual({
      ok: false,
      status: 409,
      error: {
        code: "CONFLICT",
        message: `Cart '${added.data.id}' is locked by an active checkout.`,
        fieldErrors: { cartId: "Cart is locked by an active checkout." },
      },
    });
    await expect(
      repositories.session.findOpenCartBySession("session_1", TEST_CURRENCY),
    ).resolves.toBeNull();
    await expect(repositories.session.findById(added.data.id)).resolves.toMatchObject({
      type: "cart",
      status: "checkout_pending",
      aggregate: { items: [{ quantity: 1 }] },
    });
  });

  it("strips internal Mika metadata keys from the provider checkout metadata", async () => {
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
    const added = await api.cart.add(ctx, { sellableId: sellable.id, quantity: 1 });
    if (!added.ok) {
      throw new Error("Expected cart.add to succeed.");
    }

    await expect(
      api.checkout.start(ctx, {
        cartId: added.data.id,
        customFields: { checkoutOrderId: "spoofed", promo: "summer" },
      }),
    ).resolves.toMatchObject({ ok: true, status: 200 });

    expect(fake.getCalls().createCheckoutSession[0]?.metadata).toEqual({ promo: "summer" });
  });

  it("normalizes unsafe checkout redirect overrides before provider handoff and storage", async () => {
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
    const added = await api.cart.add(ctx, { sellableId: sellable.id, quantity: 1 });
    if (!added.ok) {
      throw new Error("Expected cart.add to succeed.");
    }

    await expect(
      api.checkout.start(ctx, {
        cartId: added.data.id,
        successPath: "https://evil.test/success",
        cancelPath: "//evil.test/cancel",
        returnTo: "javascript:alert(1)",
      }),
    ).resolves.toMatchObject({
      ok: true,
      status: 200,
    });

    expect(fake.getCalls().createCheckoutSession).toHaveLength(1);
    expect(fake.getCalls().createCheckoutSession[0]).toMatchObject({
      successUrl:
        "https://shop.example.test/checkout/success?checkoutId=checkout_1&token=checkout_status_token_1",
      cancelUrl:
        "https://shop.example.test/checkout/cancel?checkoutId=checkout_1&token=checkout_status_token_1",
    });
    await expect(
      repositories.session.findById(createTestMikaId("checkout", 1)),
    ).resolves.toMatchObject({
      type: "checkout",
      aggregate: {
        binding: {
          returnPath: "/products/test-product?ref=test",
          successPath: "/checkout/success",
          cancelPath: "/checkout/cancel",
        },
      },
    });
  });

  it("does not redirect when the provider creates a cancelled checkout", async () => {
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
        createCheckoutSession: async () => ({
          id: createMikaId("checkout_fake"),
          status: "cancelled",
          mode: "payment",
          provider: TEST_PROVIDER,
          redirectUrl: "https://checkout.example.test/session/cancelled",
          expiresAt: createTestClock().isoAt(60 * 60_000),
          providerCheckoutId: "provider_checkout_cancelled",
        }),
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
    const added = await api.cart.add(ctx, { sellableId: sellable.id, quantity: 1 });
    if (!added.ok) {
      throw new Error("Expected cart.add to succeed.");
    }

    const checkout = await api.checkout.start(ctx, { cartId: added.data.id });
    expect(checkout).toMatchObject({
      ok: true,
      status: 200,
      data: {
        id: "checkout_1",
        status: "cancelled",
        mode: "payment",
        provider: TEST_PROVIDER,
      },
    });
    if (!checkout.ok) throw new Error("Expected checkout.start to succeed.");
    expect(checkout.data.redirectUrl).toBeUndefined();
    expect(checkout.effects).toBeUndefined();
  });

  it("cancels a hosted checkout without redirecting back to the provider", async () => {
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
    const added = await api.cart.add(ctx, { sellableId: sellable.id, quantity: 1 });
    if (!added.ok) {
      throw new Error("Expected cart.add to succeed.");
    }

    await expect(api.checkout.start(ctx, { cartId: added.data.id })).resolves.toMatchObject({
      ok: true,
      data: {
        id: "checkout_1",
        redirectUrl: "https://checkout.example.test/session/checkout_fake",
      },
      effects: [{ type: "redirect", url: "https://checkout.example.test/session/checkout_fake" }],
    });

    const cancelled = await api.checkout.cancel(ctx, {
      checkoutId: createTestMikaId("checkout", 1),
    });
    expect(cancelled).toMatchObject({
      ok: true,
      status: 200,
      data: {
        id: "checkout_1",
        status: "cancelled",
        mode: "payment",
        provider: TEST_PROVIDER,
      },
    });
    if (!cancelled.ok) throw new Error("Expected checkout.cancel to succeed.");
    expect(cancelled.data.redirectUrl).toBeUndefined();
    expect(cancelled.effects).toBeUndefined();
    await expect(repositories.stock.findBySellableId(sellable.id)).resolves.toMatchObject({
      quantityReserved: 0,
    });
    await expect(repositories.session.findById(added.data.id)).resolves.toMatchObject({
      type: "cart",
      status: "open",
    });
  });

  it("allows checkout cancel with the return URL status token when the session is absent", async () => {
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
    const startCtx = createTestRequestContext({ customerId: false, userId: false });
    const added = await api.cart.add(startCtx, { sellableId: sellable.id, quantity: 1 });
    if (!added.ok) {
      throw new Error("Expected cart.add to succeed.");
    }
    const checkout = await api.checkout.start(startCtx, { cartId: added.data.id });
    if (!checkout.ok) {
      throw new Error("Expected checkout.start to succeed.");
    }

    const returnCtx = createTestRequestContext({
      sessionId: false,
      customerId: false,
      userId: false,
    });
    await expect(
      api.checkout.cancel(returnCtx, {
        checkoutId: checkout.data.id,
        token: checkout.data.statusToken,
      }),
    ).resolves.toMatchObject({
      ok: true,
      status: 200,
      data: { id: checkout.data.id, status: "cancelled" },
    });
  });

  it("does not overwrite a checkout that completed before the cancel write", async () => {
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
    const added = await api.cart.add(ctx, { sellableId: sellable.id, quantity: 1 });
    if (!added.ok) {
      throw new Error("Expected cart.add to succeed.");
    }
    const checkout = await api.checkout.start(ctx, { cartId: added.data.id });
    if (!checkout.ok) {
      throw new Error("Expected checkout.start to succeed.");
    }

    const originalFindCheckoutById = repositories.session.findCheckoutById.bind(
      repositories.session,
    );
    let checkoutReads = 0;
    repositories.session.findCheckoutById = async (checkoutId) => {
      const document = await originalFindCheckoutById(checkoutId);
      if (checkoutId === checkout.data.id) {
        checkoutReads += 1;
      }
      if (checkoutId !== checkout.data.id || checkoutReads !== 2 || !document) {
        return document;
      }

      const completed: CheckoutDocument = {
        ...document,
        status: "completed",
        providerStatus: "completed",
        orderId: createTestMikaId("order", 1),
        updatedAt: ctx.now,
      };
      await repositories.session.put(completed);
      const cart = await repositories.session.findById(added.data.id);
      if (cart?.type === "cart") {
        await repositories.session.put({
          ...cart,
          status: "converted",
          updatedAt: ctx.now,
        });
      }

      return completed;
    };

    await expect(api.checkout.cancel(ctx, { checkoutId: checkout.data.id })).resolves.toMatchObject(
      {
        ok: true,
        status: 200,
        data: {
          id: checkout.data.id,
          status: "completed",
          orderId: "order_1",
        },
      },
    );
    await expect(repositories.session.findCheckoutById(checkout.data.id)).resolves.toMatchObject({
      status: "completed",
      orderId: "order_1",
    });
    await expect(repositories.session.findById(added.data.id)).resolves.toMatchObject({
      type: "cart",
      status: "converted",
    });
  });

  it("frees buy-now checkout reservations on cancel", async () => {
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

    const checkout = await api.checkout.start(ctx, { sellableId: sellable.id, quantity: 1 });
    if (!checkout.ok) throw new Error("Expected checkout.start to succeed.");
    const storedCheckout = await repositories.session.findCheckoutById(
      createTestMikaId("checkout", 1),
    );
    expect(storedCheckout?.cartId).toBeUndefined();
    await expect(repositories.stock.findBySellableId(sellable.id)).resolves.toMatchObject({
      quantityReserved: 1,
    });

    const cancelled = await api.checkout.cancel(ctx, {
      checkoutId: createTestMikaId("checkout", 1),
    });
    expect(cancelled).toMatchObject({ ok: true, data: { status: "cancelled" } });

    await expect(repositories.stock.findBySellableId(sellable.id)).resolves.toMatchObject({
      quantityReserved: 0,
    });
  });

  it("expires checkout reservations on cancel so a late paid webhook can still fulfill", async () => {
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
    const deps = createIncrementingBackendDependencies({
      repositories,
      providers: createMikaProviderRegistry([fake.provider]),
    });
    const api = createMikaBackendApi(deps);
    const ctx = createTestRequestContext({ customerId: false, userId: false });

    const cart = await api.cart.add(ctx, { sellableId: sellable.id, quantity: 1 });
    if (!cart.ok) throw new Error("Expected cart.add to succeed.");
    const checkout = await api.checkout.start(ctx, { cartId: cart.data.id });
    if (!checkout.ok) throw new Error("Expected checkout.start to succeed.");

    const reservationId = createTestMikaId("stock_event", 1);
    await api.checkout.cancel(ctx, { checkoutId: createTestMikaId("checkout", 1) });

    await expect(repositories.stock.findEventById(reservationId)).resolves.toMatchObject({
      status: "expired",
    });
    await expect(repositories.stock.findBySellableId(sellable.id)).resolves.toMatchObject({
      quantityReserved: 0,
    });

    await expect(
      createMikaStockLifecycleService(deps).consume({
        reservationEventId: reservationId,
        orderId: createTestMikaId("order", 1),
        orderLineId: createTestMikaId("order_line", 1),
      }),
    ).resolves.toMatchObject({ status: "consumed", event: { status: "consumed" } });
    await expect(repositories.stock.findBySellableId(sellable.id)).resolves.toMatchObject({
      quantityOnHand: 4,
      quantityReserved: 0,
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
    await expect(
      repositories.stock.findEventById(createTestMikaId("stock_event", 1)),
    ).resolves.toMatchObject({
      status: "active",
      quantityDelta: 2,
    });
    await expect(
      repositories.stock.findEventById(createTestMikaId("stock_event", 2)),
    ).resolves.toBeNull();
    await expect(repositories.session.findById(added.data.id)).resolves.toMatchObject({
      type: "cart",
      status: "checkout_pending",
    });
    await expect(
      repositories.session.findById(createTestMikaId("checkout", 2)),
    ).resolves.toBeNull();
    await expect(
      repositories.session.findCheckoutByIdempotencyKey("checkout_replay_1"),
    ).resolves.toMatchObject({
      id: "checkout_1",
    });
  });

  it("expires reservations during idempotent checkout start replay after expiry", async () => {
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
            throw new Error("expired idempotency replay should not call provider");
          }

          return {
            id: createMikaId("checkout_fake"),
            status: "created",
            mode: "payment",
            provider: TEST_PROVIDER,
            redirectUrl: "https://checkout.example.test/session/replay_expiry",
            expiresAt: createTestClock().isoAt(60 * 60_000),
            providerCheckoutId: "provider_checkout_replay_expiry",
          };
        },
      },
    });
    await repositories.catalog.put(
      createCatalogItemDocument({ contentRef, sellables: [sellable] }),
    );
    let backendNow = createTestClock().now;
    const api = createMikaBackendApi(
      createIncrementingBackendDependencies({
        repositories,
        providers: createMikaProviderRegistry([fake.provider]),
        now: () => backendNow,
        isoNow: () => createISODateTime(backendNow.toISOString()),
      }),
    );
    const ctx = createTestRequestContext({
      customerId: false,
      userId: false,
      idempotencyKey: "checkout_replay_expiry_1",
    });

    const cart = await api.cart.add(ctx, { sellableId: sellable.id, quantity: 2 });
    if (!cart.ok) throw new Error("Expected cart.add to succeed.");
    const started = await api.checkout.start(ctx, { cartId: cart.data.id });
    expect(started).toMatchObject({ ok: true, data: { id: "checkout_1" } });
    await expect(repositories.stock.findBySellableId(sellable.id)).resolves.toMatchObject({
      quantityReserved: 2,
    });

    backendNow = createTestClock().at(2 * 60 * 60_000);
    providerShouldFail = true;
    const replayCtx = createTestRequestContext({
      customerId: false,
      userId: false,
      idempotencyKey: "checkout_replay_expiry_1",
      now: backendNow,
    });
    await expect(api.checkout.start(replayCtx, { cartId: cart.data.id })).resolves.toMatchObject({
      ok: false,
      status: 409,
      error: { code: "CHECKOUT_EXPIRED" },
    });

    expect(fake.getCalls().createCheckoutSession).toHaveLength(1);
    await expect(
      repositories.session.findCheckoutById(createTestMikaId("checkout", 1)),
    ).resolves.toMatchObject({
      status: "expired",
      providerStatus: "expired",
    });
    await expect(
      repositories.stock.findEventById(createTestMikaId("stock_event", 1)),
    ).resolves.toMatchObject({
      status: "expired",
    });
    await expect(repositories.stock.findBySellableId(sellable.id)).resolves.toMatchObject({
      quantityReserved: 0,
    });
  });

  it("does not replay a checkout idempotency key across a different session", async () => {
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
        createCheckoutSession: async () => ({
          id: createMikaId("checkout_fake"),
          status: "created",
          mode: "payment",
          provider: TEST_PROVIDER,
          redirectUrl: "https://checkout.example.test/session/owner_only",
          expiresAt: createTestClock().isoAt(60 * 60_000),
          providerCheckoutId: "provider_checkout_owner_only",
        }),
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
    const sharedKey = "checkout_cross_session_1";
    const ownerCtx = createTestRequestContext({
      sessionId: "session_owner",
      customerId: false,
      userId: false,
      idempotencyKey: sharedKey,
    });
    const attackerCtx = createTestRequestContext({
      sessionId: "session_attacker",
      customerId: false,
      userId: false,
      idempotencyKey: sharedKey,
    });

    const owner = await api.checkout.start(ownerCtx, { sellableId: sellable.id, quantity: 1 });
    expect(owner).toMatchObject({
      ok: true,
      data: { id: "checkout_1", redirectUrl: "https://checkout.example.test/session/owner_only" },
    });

    const attacker = await api.checkout.start(attackerCtx, {
      sellableId: sellable.id,
      quantity: 1,
    });
    expect(attacker).toMatchObject({ ok: false, status: 409, error: { code: "CONFLICT" } });
    if (attacker.ok) throw new Error("Expected cross-session replay to be rejected.");
    await expect(
      repositories.session.findById(createTestMikaId("checkout", 2)),
    ).resolves.toBeNull();
  });

  it("rejects duplicate checkout starts that reuse an idempotency key with different input", async () => {
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
    let checkoutAttempt = 0;
    const fake = createFakeMikaProvider({
      overrides: {
        createCheckoutSession: async (input) => {
          checkoutAttempt += 1;
          return {
            id: createTestMikaId("checkout_fake", checkoutAttempt),
            status: "created",
            mode: input.mode ?? "payment",
            provider: input.provider,
            redirectUrl: `https://checkout.example.test/session/checkout_fake_${checkoutAttempt}`,
            expiresAt: createTestClock().isoAt(60 * 60_000),
            providerCheckoutId: `provider_checkout_fake_${checkoutAttempt}`,
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
      idempotencyKey: "checkout_replay_mismatch_1",
    });

    await expect(
      api.checkout.start(ctx, { sellableId: sellable.id, quantity: 1 }),
    ).resolves.toMatchObject({
      ok: true,
      data: {
        id: "checkout_1",
      },
    });
    await expect(
      api.checkout.start(ctx, { sellableId: sellable.id, quantity: 2 }),
    ).resolves.toEqual({
      ok: false,
      status: 409,
      error: {
        code: "CONFLICT",
        message: "Checkout idempotency key was reused with different input.",
      },
    });
    expect(fake.getCalls().createCheckoutSession).toHaveLength(1);
    await expect(repositories.stock.findBySellableId(sellable.id)).resolves.toMatchObject({
      quantityReserved: 1,
    });
  });

  it("rejects checkout start with a delegated payment token but no preview authorization", async () => {
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
    const ctx = createTestRequestContext({
      customerId: false,
      userId: false,
      idempotencyKey: false,
    });

    const cart = await api.cart.add(ctx, { sellableId: sellable.id, quantity: 1 });
    if (!cart.ok) throw new Error("Expected cart.add to succeed.");

    await expect(
      api.checkout.start(ctx, {
        cartId: cart.data.id,
        provider: TEST_PROVIDER,
        customFields: { acpPaymentToken: "spt_leaked_123" },
      }),
    ).resolves.toMatchObject({ ok: false, status: 403, error: { code: "FORBIDDEN" } });

    await expect(
      api.checkout.start(ctx, {
        cartId: cart.data.id,
        provider: TEST_PROVIDER,
        customFields: {
          acpPaymentToken: "spt_leaked_123",
          acpPaymentAuthorizationInputHash: "not_a_real_preview_hash",
        },
      }),
    ).resolves.toMatchObject({ ok: false, status: 403, error: { code: "FORBIDDEN" } });

    expect(fake.getCalls().createCheckoutSession).toEqual([]);
    await expect(repositories.stock.findBySellableId(sellable.id)).resolves.toMatchObject({
      quantityReserved: 0,
    });
  });

  it("allows checkout start with a delegated payment token authorized by a fresh preview", async () => {
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
      capabilities: ["hosted_checkout", "delegated_payment"],
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
      idempotencyKey: false,
    });

    const cart = await api.cart.add(ctx, { sellableId: sellable.id, quantity: 1 });
    if (!cart.ok) throw new Error("Expected cart.add to succeed.");

    const previewInput = {
      cartId: cart.data.id,
      provider: TEST_PROVIDER,
      customer: { email: "Delegated@Example.test", name: "Delegated Buyer" },
      customFields: { publicNote: "deliver after 5pm" },
      successPath: "/checkout/success/delegated",
      cancelPath: "/checkout/cancel/delegated",
      returnTo: "/products/delegated",
    };
    const preview = await api.checkout.preview(ctx, previewInput);
    if (!preview.ok) throw new Error("Expected checkout.preview to succeed.");
    const inputHash = preview.data.inputHash;
    if (!inputHash) throw new Error("Expected checkout.preview to return an input hash.");

    await expect(
      api.checkout.start(ctx, {
        ...previewInput,
        customFields: {
          publicNote: "changed after preview",
          acpPaymentToken: "spt_authorized_123",
          acpPaymentProvider: "stripe",
          acpPaymentAuthorizationId: "acp_payment_authorization_generated_after_preview",
          acpCheckoutSessionId: "checkout_session_acp_1",
          acpPaymentAuthorizationInputHash: inputHash,
        },
      }),
    ).resolves.toMatchObject({ ok: false, status: 403, error: { code: "FORBIDDEN" } });
    expect(fake.getCalls().createCheckoutSession).toHaveLength(0);
    expect(fake.getCalls().createDelegatedPayment).toHaveLength(0);

    const started = await api.checkout.start(ctx, {
      ...previewInput,
      customFields: {
        ...previewInput.customFields,
        acpPaymentToken: "spt_authorized_123",
        acpPaymentProvider: "stripe",
        acpPaymentAuthorizationId: "acp_payment_authorization_generated_after_preview",
        acpCheckoutSessionId: "checkout_session_acp_1",
        acpPaymentAuthorizationInputHash: inputHash,
      },
    });
    expect(started).toMatchObject({ ok: true });
    if (!started.ok) {
      throw new Error("Expected checkout start to succeed.");
    }
    expect(fake.getCalls().createCheckoutSession).toHaveLength(0);
    expect(fake.getCalls().createDelegatedPayment).toHaveLength(1);
    expect(fake.getCalls().createDelegatedPayment[0]).toMatchObject({
      mode: "payment",
      token: "spt_authorized_123",
      metadata: {
        publicNote: "deliver after 5pm",
      },
    });
    expect(fake.getCalls().createDelegatedPayment[0]?.metadata).not.toHaveProperty(
      "acpPaymentToken",
    );
    expect(fake.getCalls().createDelegatedPayment[0]?.metadata).not.toHaveProperty(
      "acpPaymentAuthorizationInputHash",
    );
    const persisted = await repositories.session.findById(started.data.id);
    if (!persisted || persisted.type !== "checkout") {
      throw new Error("Expected checkout document to be persisted.");
    }
    expect(persisted.aggregate.metadata).toMatchObject({
      publicNote: "deliver after 5pm",
    });
    expect(persisted.aggregate.metadata).not.toHaveProperty("acpPaymentToken");
    expect(persisted.aggregate.metadata).not.toHaveProperty("acpPaymentProvider");
    expect(persisted.aggregate.metadata).not.toHaveProperty("acpPaymentAuthorizationId");
    expect(persisted.aggregate.metadata).not.toHaveProperty("acpCheckoutSessionId");
    expect(persisted.aggregate.metadata).not.toHaveProperty("acpPaymentAuthorizationInputHash");
  });

  it("allows delegated checkout with a couponCode authorized by checkout preview", async () => {
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
      capabilities: ["hosted_checkout", "delegated_payment"],
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
      idempotencyKey: false,
    });

    const cart = await api.cart.add(ctx, { sellableId: sellable.id, quantity: 2 });
    if (!cart.ok) throw new Error("Expected cart.add to succeed.");

    const preview = await api.checkout.preview(ctx, {
      cartId: cart.data.id,
      provider: TEST_PROVIDER,
      couponCode: "SAVE10",
    });
    if (!preview.ok) throw new Error("Expected checkout.preview to succeed.");
    const inputHash = preview.data.inputHash;
    if (!inputHash) throw new Error("Expected checkout.preview to return an input hash.");

    const started = await api.checkout.start(ctx, {
      cartId: cart.data.id,
      provider: TEST_PROVIDER,
      couponCode: "SAVE10",
      customFields: {
        acpPaymentToken: "spt_coupon_authorized_123",
        acpPaymentAuthorizationInputHash: inputHash,
      },
    });

    expect(started).toMatchObject({ ok: true });
    if (!started.ok) throw new Error("Expected checkout.start to succeed.");
    const call = fake.getCalls().createDelegatedPayment[0];
    expect(call?.discount).toMatchObject({ amount: 240, currency: TEST_CURRENCY });
    await expect(repositories.session.findCheckoutById(started.data.id)).resolves.toMatchObject({
      aggregate: { coupon: { label: "SAVE10" } },
    });
  });

  it("ignores caller-controlled checkout metadata keys for idempotency replay", async () => {
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
    let checkoutAttempt = 0;
    const fake = createFakeMikaProvider({
      overrides: {
        createCheckoutSession: async (input) => {
          checkoutAttempt += 1;
          return {
            id: createTestMikaId("checkout_fake", checkoutAttempt),
            status: "created",
            mode: input.mode ?? "payment",
            provider: input.provider,
            redirectUrl: `https://checkout.example.test/session/checkout_fake_${checkoutAttempt}`,
            expiresAt: createTestClock().isoAt(60 * 60_000),
            providerCheckoutId: `provider_checkout_fake_${checkoutAttempt}`,
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
    const hijackedKey = "checkout_replay_hijack_1";
    const anonymousCtx = createTestRequestContext({
      customerId: false,
      userId: false,
      idempotencyKey: false,
    });

    await expect(
      api.checkout.start(anonymousCtx, {
        sellableId: sellable.id,
        quantity: 1,
        customFields: {
          publicNote: "keep",
          checkoutIdempotencyKey: hijackedKey,
          checkoutIdempotencyInputHash: "attacker_hash",
          checkoutProviderStatus: "completed",
          checkoutRedirectUrl: "https://evil.example.test",
          checkoutPersistenceFailed: true,
          checkoutOrderId: "order_999",
        },
      }),
    ).resolves.toMatchObject({
      ok: true,
      data: {
        id: "checkout_1",
        status: "created",
        redirectUrl: "https://checkout.example.test/session/checkout_fake_1",
      },
    });

    const stored = await repositories.session.findCheckoutById(createTestMikaId("checkout", 1));
    expect(stored?.aggregate.metadata).toMatchObject({
      publicNote: "keep",
      checkoutProviderStatus: "created",
      checkoutRedirectUrl: "https://checkout.example.test/session/checkout_fake_1",
    });
    expect(stored?.aggregate.metadata?.["checkoutIdempotencyKey"]).toBeUndefined();
    expect(stored?.aggregate.metadata?.["checkoutIdempotencyInputHash"]).toBeUndefined();
    expect(stored?.aggregate.metadata?.["checkoutPersistenceFailed"]).toBeUndefined();
    expect(stored?.aggregate.metadata?.["checkoutOrderId"]).toBeUndefined();
    await expect(
      repositories.session.findCheckoutByIdempotencyKey(hijackedKey),
    ).resolves.toBeNull();

    const idempotentCtx = createTestRequestContext({
      customerId: false,
      userId: false,
      idempotencyKey: hijackedKey,
    });
    await expect(
      api.checkout.start(idempotentCtx, { sellableId: sellable.id, quantity: 1 }),
    ).resolves.toMatchObject({
      ok: true,
      data: {
        id: "checkout_2",
      },
    });
    expect(fake.getCalls().createCheckoutSession).toHaveLength(2);
    await expect(repositories.stock.findBySellableId(sellable.id)).resolves.toMatchObject({
      quantityReserved: 2,
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
    expect(started.data.statusToken).toBe("checkout_status_token_1");
    await expect(repositories.session.findCheckoutById(started.data.id)).resolves.toMatchObject({
      id: "checkout_1",
      checkoutIdempotencyKey: "idem_1",
      providerStatus: "created",
      redirectUrl: "https://checkout.example.test/session/checkout_fake",
    });

    await expect(api.checkout.status(ctx, { checkoutId: started.data.id })).resolves.toMatchObject({
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
    const otherCtx = createTestRequestContext({
      sessionId: "session_2",
      customerId: false,
      userId: false,
    });
    await expect(
      api.checkout.status(otherCtx, { checkoutId: started.data.id }),
    ).resolves.toMatchObject({
      ok: false,
      status: 401,
      error: { code: "AUTH_REQUIRED" },
    });
    await expect(
      api.checkout.status(otherCtx, {
        checkoutId: started.data.id,
        token: started.data.statusToken,
      }),
    ).resolves.toMatchObject({
      ok: true,
      status: 200,
      data: {
        id: "checkout_1",
      },
    });
    expect(fake.getCalls().retrieveCheckoutSession).toEqual([]);
  });

  it("returns stable checkout status errors for missing, expired, and binding mismatch states", async () => {
    const repositories = createTestBackendRepositories();
    const api = createMikaBackendApi(createIncrementingBackendDependencies({ repositories }));

    await repositories.session.put(
      createCheckoutDocument({
        id: createTestMikaId("checkout", 1),
        sessionId: "session_1",
        expiresAt: createTestClock().isoAt(-1),
      }),
    );
    await repositories.session.put(
      createCheckoutDocument({
        id: createTestMikaId("checkout", 2),
        sessionId: "session_1",
        providerCheckoutId: "provider_checkout_actual",
        bindingProviderCheckoutId: "provider_checkout_stale",
      }),
    );

    await expect(
      api.checkout.status(createTestRequestContext(), {
        checkoutId: createTestMikaId("checkout", 404),
      }),
    ).resolves.toMatchObject({
      ok: false,
      status: 404,
      error: {
        code: "NOT_FOUND",
        fieldErrors: { checkoutId: "Checkout was not found." },
      },
    });
    await expect(
      api.checkout.status(createTestRequestContext(), {
        checkoutId: createTestMikaId("checkout", 1),
      }),
    ).resolves.toMatchObject({
      ok: false,
      status: 409,
      error: { code: "CHECKOUT_EXPIRED" },
    });
    await expect(
      api.checkout.status(createTestRequestContext(), {
        checkoutId: createTestMikaId("checkout", 2),
      }),
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
        sessionId: "session_1",
        providerCheckoutId: "provider_checkout_1",
        status: "completed",
        providerStatus: "completed",
        orderId: createTestMikaId("order", 1),
        redirectUrl: "https://checkout.example.test/complete",
        expiresAt: createTestClock().isoAt(-1),
        metadata: {
          checkoutProviderStatus: "pending",
          checkoutOrderId: "order_stale",
          checkoutRedirectUrl: "https://checkout.example.test/stale",
        },
      }),
    );
    await repositories.session.put(
      createCheckoutDocument({
        id: createTestMikaId("checkout", 2),
        sessionId: "session_1",
        providerCheckoutId: "provider_checkout_2",
        status: "failed",
        expiresAt: createTestClock().isoAt(-1),
        metadata: { checkoutProviderStatus: "failed" },
      }),
    );
    await repositories.session.put(
      createCheckoutDocument({
        id: createTestMikaId("checkout", 3),
        sessionId: "session_1",
        providerCheckoutId: "provider_checkout_3",
        status: "cancelled",
        redirectUrl: "https://checkout.example.test/cancelled",
        expiresAt: createTestClock().isoAt(-1),
        metadata: {
          checkoutProviderStatus: "cancelled",
          checkoutRedirectUrl: "https://checkout.example.test/cancelled-stale",
        },
      }),
    );

    await expect(
      api.checkout.status(createTestRequestContext(), {
        checkoutId: createTestMikaId("checkout", 1),
      }),
    ).resolves.toMatchObject({
      ok: true,
      status: 200,
      data: {
        id: "checkout_1",
        status: "completed",
        mode: "payment",
        provider: TEST_PROVIDER,
        redirectUrl: "https://checkout.example.test/complete",
        orderId: "order_1",
      },
      effects: [{ type: "redirect", url: "https://checkout.example.test/complete" }],
    });
    await expect(
      api.checkout.status(createTestRequestContext(), {
        checkoutId: createTestMikaId("checkout", 2),
      }),
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
      api.checkout.status(createTestRequestContext(), {
        checkoutId: createTestMikaId("checkout", 3),
      }),
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
    const cancelledStatus = await api.checkout.status(createTestRequestContext(), {
      checkoutId: createTestMikaId("checkout", 3),
    });
    expect(cancelledStatus).toMatchObject({
      ok: true,
      status: 200,
      data: {
        id: "checkout_3",
        status: "cancelled",
        mode: "payment",
        provider: TEST_PROVIDER,
      },
    });
    if (!cancelledStatus.ok) throw new Error("Expected cancelled checkout status to succeed.");
    expect(cancelledStatus.data.redirectUrl).toBeUndefined();
    expect(cancelledStatus.effects).toBeUndefined();

    const cancelledAgain = await api.checkout.cancel(createTestRequestContext(), {
      checkoutId: createTestMikaId("checkout", 3),
    });
    expect(cancelledAgain).toMatchObject({
      ok: true,
      status: 200,
      data: {
        id: "checkout_3",
        status: "cancelled",
        mode: "payment",
        provider: TEST_PROVIDER,
      },
    });
    if (!cancelledAgain.ok) throw new Error("Expected cancelled checkout cancel to succeed.");
    expect(cancelledAgain.data.redirectUrl).toBeUndefined();
    expect(cancelledAgain.effects).toBeUndefined();
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
    await expectCheckoutFailureInvariant({
      repositories,
      provider: fake,
      providerCheckoutCalls: 1,
      stockSellableId: sellable.id,
      quantityReserved: 0,
      cartId: added.data.id,
      cartStatus: "open",
      checkoutId: createTestMikaId("checkout", 1),
      checkoutStatus: "failed",
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
      customerId: "customer_1",
      userId: "user_1",
      sessionId: "session_gbp_source",
    });
    const usdApi = createMikaBackendApi({
      ...dependencies,
      defaults: { ...dependencies.defaults, currency: createTestCurrencyCode("USD") },
    });
    const gbpApi = createMikaBackendApi({
      ...dependencies,
      defaults: { ...dependencies.defaults, currency: createTestCurrencyCode("GBP") },
    });

    await expect(
      api.cart.merge(ctx, { targetCartId: createTestMikaId("cart", 404) }),
    ).resolves.toMatchObject({
      ok: false,
      status: 404,
      error: {
        code: "NOT_FOUND",
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

    await gbpApi.cart.get(sourceCtx);

    await expect(
      api.cart.merge(ctx, { sourceSessionId: "session_gbp_source" }),
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

  it("rejects omitted priceId when a sellable has multiple active prices in the cart currency", async () => {
    const firstPrice = createPriceDefinition({
      id: createTestMikaId("price", 1),
      amount: 1200,
    });
    const secondPrice = createPriceDefinition({
      id: createTestMikaId("price", 2),
      amount: 900,
    });
    const sellable = createSellableDefinition({
      prices: [firstPrice, secondPrice],
    });
    const repositories = createTestBackendRepositories();
    const api = createMikaBackendApi(createIncrementingBackendDependencies({ repositories }));
    const ctx = createTestRequestContext({
      customerId: false,
      userId: false,
      sessionId: "session_ambiguous_price",
    });

    await repositories.catalog.put(
      createCatalogItemDocument({
        contentRef: createTestContentRef(),
        sellables: [sellable],
      }),
    );

    await expect(api.cart.add(ctx, { sellableId: sellable.id })).resolves.toEqual({
      ok: false,
      status: 422,
      error: {
        code: "VALIDATION_FAILED",
        message: "Mika input validation failed.",
        fieldErrors: {
          priceId: `Sellable '${sellable.id}' has multiple active prices for currency '${TEST_CURRENCY}'; provide priceId.`,
        },
      },
    });

    await expect(
      api.cart.add(ctx, { sellableId: sellable.id, priceId: secondPrice.id }),
    ).resolves.toMatchObject({
      ok: true,
      status: 200,
      data: {
        items: [{ priceId: secondPrice.id, unitAmount: { amount: secondPrice.amount } }],
      },
    });
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
    const priorCustomerCtx = createTestRequestContext({
      customerId: "customer_1",
      userId: "user_1",
      sessionId: "session_prior",
    });
    const callerCtx = createTestRequestContext({
      customerId: "customer_1",
      userId: "user_1",
      sessionId: "session_wishlist_source",
    });

    await api.wishlist.add(sourceCtx, { sellableId: duplicateSellable.id });
    await api.wishlist.add(sourceCtx, { sellableId: sourceOnlySellable.id });
    const customerWishlist = await api.wishlist.add(priorCustomerCtx, {
      sellableId: duplicateSellable.id,
    });
    if (!customerWishlist.ok) {
      throw new Error("Expected customer wishlist.add to succeed.");
    }
    const sourceBeforeMerge = await api.wishlist.get(sourceCtx);
    if (!sourceBeforeMerge.ok) {
      throw new Error("Expected source wishlist.get to succeed.");
    }

    await expect(
      api.wishlist.merge(callerCtx, {
        targetWishlistId: customerWishlist.data.id,
        sourceSessionId: "session_wishlist_source",
      }),
    ).resolves.toMatchObject({
      ok: true,
      status: 200,
      data: {
        items: [{ sellableId: duplicateSellable.id }, { sellableId: sourceOnlySellable.id }],
      },
    });

    const merged = await api.wishlist.get(callerCtx);
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

  it("refuses to merge a source wishlist the caller does not own (cross-session IDOR)", async () => {
    const contentRef = createTestContentRef();
    const victimSellable = createSellableDefinition({ id: createTestMikaId("sellable", 1) });
    const attackerSellable = createSellableDefinition({
      id: createTestMikaId("sellable", 2),
      sku: "TEST-SKU-2",
      titleSnapshot: "Attacker sellable",
      prices: [createPriceDefinition({ id: createTestMikaId("price", 2) })],
    });
    const repositories = createTestBackendRepositories();
    await repositories.catalog.put(
      createCatalogItemDocument({ contentRef, sellables: [victimSellable, attackerSellable] }),
    );
    const api = createMikaBackendApi(createIncrementingBackendDependencies({ repositories }));
    const victimCtx = createTestRequestContext({
      customerId: false,
      userId: false,
      sessionId: "session_victim",
    });
    const attackerCtx = createTestRequestContext({
      customerId: false,
      userId: false,
      sessionId: "session_attacker",
    });

    await api.wishlist.add(victimCtx, { sellableId: victimSellable.id });
    await api.wishlist.add(attackerCtx, { sellableId: attackerSellable.id });

    const merged = await api.wishlist.merge(attackerCtx, { sourceSessionId: "session_victim" });
    if (!merged.ok) {
      throw new Error("Expected wishlist.merge to succeed without merging the foreign source.");
    }
    expect(merged.data.items).toHaveLength(1);
    expect(merged.data.items[0]?.sellableId).toBe(attackerSellable.id);

    const victimWishlist = await repositories.session.findWishlistBySession("session_victim");
    expect(victimWishlist?.status).toBe("active");
    expect(victimWishlist?.aggregate.items).toHaveLength(1);
    expect(victimWishlist?.aggregate.items[0]?.item.sellableId).toBe(victimSellable.id);
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
        code: "NOT_FOUND",
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
          "https://shop.example.test/_emdash/api/plugins/mika/checkout/status?checkoutId=checkout_1&token=checkout_status_token_1",
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

function createWorkflowDocument(
  overrides: Partial<WorkflowDocument> & {
    readonly attemptCount?: number;
    readonly maxAttempts?: number;
    readonly leaseKey?: string;
    readonly leasedAt?: ISODateTime;
  } = {},
): WorkflowDocument {
  const id = overrides.id ?? createTestMikaId("workflow", 1);
  const status = overrides.status ?? "queued";
  const subjectId = overrides.subjectId ?? createTestMikaId("webhook", 1);
  const idempotencyKey = overrides.idempotencyKey ?? "event_1";
  const nextAttemptAt = Object.hasOwn(overrides, "nextAttemptAt")
    ? overrides.nextAttemptAt
    : TEST_NOW;
  const leaseExpiresAt = Object.hasOwn(overrides, "leaseExpiresAt")
    ? overrides.leaseExpiresAt
    : undefined;
  const record = {
    id,
    kind: "payment_webhook_fulfillment" as const,
    status,
    subjectType: "webhook",
    subjectId,
    idempotencyKey,
    attemptCount: overrides.record?.attemptCount ?? overrides.attemptCount ?? 0,
    maxAttempts: overrides.record?.maxAttempts ?? overrides.maxAttempts ?? 5,
    nextAttemptAt,
    leaseKey: overrides.record?.leaseKey ?? overrides.leaseKey,
    leasedAt: overrides.record?.leasedAt ?? overrides.leasedAt,
    leaseExpiresAt,
    steps: overrides.record?.steps ?? [
      { name: "link_checkout", status: "queued" as const, attemptCount: 0 },
      { name: "persist_order", status: "queued" as const, attemptCount: 0 },
      { name: "complete_checkout", status: "queued" as const, attemptCount: 0 },
      { name: "fulfill_order", status: "queued" as const, attemptCount: 0 },
      { name: "mark_webhook", status: "queued" as const, attemptCount: 0 },
    ],
    resumeState: overrides.record?.resumeState,
    lastError: overrides.record?.lastError,
    createdAt: overrides.record?.createdAt ?? TEST_NOW,
    updatedAt: overrides.record?.updatedAt ?? TEST_NOW,
    metadata: overrides.record?.metadata,
  };

  return {
    id,
    type: "workflow",
    schemaVersion: 1,
    kind: record.kind,
    status,
    subjectType: record.subjectType,
    subjectId,
    idempotencyKey,
    nextAttemptAt,
    leaseExpiresAt,
    record,
    createdAt: TEST_NOW,
    updatedAt: TEST_NOW,
    ...overrides,
  };
}

function createWebhookDocument(
  overrides: Partial<Omit<WebhookDocument, "record">> & {
    readonly record?: Partial<WebhookDocument["record"]>;
  } = {},
): WebhookDocument {
  const recordOverrides = overrides.record ?? {};
  const id = recordOverrides.id ?? overrides.id ?? createTestMikaId("webhook", 1);
  const provider = recordOverrides.provider ?? overrides.provider ?? TEST_PROVIDER;
  const providerEventId = recordOverrides.providerEventId ?? overrides.providerEventId ?? "event_1";
  const eventType = recordOverrides.eventType ?? overrides.eventType ?? "payment.completed";
  const payloadHash = recordOverrides.payloadHash ?? overrides.payloadHash ?? "hash_1";
  const status = recordOverrides.status ?? overrides.status ?? "received";
  const nextAttemptAt = Object.hasOwn(recordOverrides, "nextAttemptAt")
    ? recordOverrides.nextAttemptAt
    : overrides.nextAttemptAt;
  const receivedAt = recordOverrides.receivedAt ?? overrides.receivedAt ?? TEST_NOW;
  const rawPayloadJson = Object.hasOwn(recordOverrides, "rawPayloadJson")
    ? recordOverrides.rawPayloadJson
    : { providerPayload: { marker: id } };
  const record = {
    id,
    provider,
    providerEventId,
    eventType,
    payloadHash,
    status,
    attemptCount: recordOverrides.attemptCount ?? 0,
    nextAttemptAt,
    receivedAt,
    processedAt: recordOverrides.processedAt,
    lastError: recordOverrides.lastError,
    rawPayloadJson,
    normalizedPayloadJson: recordOverrides.normalizedPayloadJson,
    rawPayloadPurgedAt: recordOverrides.rawPayloadPurgedAt,
    relatedCustomerId: recordOverrides.relatedCustomerId,
    relatedOrderId: recordOverrides.relatedOrderId,
    relatedSubscriptionId: recordOverrides.relatedSubscriptionId,
  };

  return {
    id,
    type: "webhook",
    schemaVersion: 1,
    provider,
    providerEventId,
    eventType,
    payloadHash,
    status,
    nextAttemptAt,
    receivedAt,
    record,
    createdAt: overrides.createdAt ?? receivedAt,
    updatedAt: overrides.updatedAt ?? receivedAt,
  };
}

function createFullyWiredTestApi(): MikaApi {
  return createMikaApi(
    Object.fromEntries(
      Object.entries(mikaApiMethodNames).map(([namespace, methods]) => [
        namespace,
        Object.fromEntries(
          methods.map((method) => [
            method,
            async () => ({
              ok: true,
              status: 200,
              data: {},
            }),
          ]),
        ),
      ]),
    ) as MikaApiOverrides,
  );
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
      coupons: {
        resolver: createMikaFixedRateCouponResolver(),
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

function createIncrementingIdFactory(
  namespacePrefix?: string,
): CreateMikaBackendApiInput["createId"] {
  const counts = new Map<string, number>();

  return (namespace) => {
    const resolvedNamespace = namespacePrefix ?? namespace;
    const count = (counts.get(resolvedNamespace) ?? 0) + 1;
    counts.set(resolvedNamespace, count);

    return createTestMikaId(resolvedNamespace, count);
  };
}

function createTestBackendRepositories(
  options: {
    readonly stockBySellableId?: ReadonlyMap<string, StockItemRecord>;
  } = {},
): MikaBackendRepositories {
  return {
    catalog: new CatalogRepository(createStorageCollection("catalog")),
    session: new SessionRepository(createStorageCollection("session")),
    account: new AccountRepository(createStorageCollection("account")),
    ledger: new LedgerRepository(createStorageCollection("ledger")),
    ops: new OpsRepository(createStorageCollection("ops")),
    stock: createTestStockRepository(options.stockBySellableId),
    ephemeral: createTestEphemeralRepository(),
  } satisfies MikaBackendRepositories;
}

function createTestEphemeralRepository(): MikaEphemeralRepositoryPort {
  const records = new Map<string, EphemeralRecord>();

  return {
    async get(key) {
      return records.get(key) ?? null;
    },
    async put(record) {
      records.set(record.key, record);
    },
    async incrementCounter(input) {
      const existing = records.get(input.key);
      const record: EphemeralRecord = {
        key: input.key,
        kind: input.kind,
        subjectHash: input.subjectHash,
        status: input.status ?? "active",
        count: (existing?.count ?? 0) + 1,
        expiresAt: input.expiresAt,
        version: (existing?.version ?? 0) + 1,
        createdAt: existing?.createdAt ?? input.now,
        updatedAt: input.now,
        data: input.data,
      };
      records.set(input.key, record);

      return record;
    },
    async tryAcquireLock(input) {
      const existing = records.get(input.key);
      if (
        existing &&
        existing.kind === "lock" &&
        existing.status === "held" &&
        existing.expiresAt > input.now &&
        existing.data?.["owner"] !== input.owner
      ) {
        return null;
      }
      const record: EphemeralRecord = {
        key: input.key,
        kind: "lock",
        subjectHash: input.subjectHash,
        status: "held",
        count: (existing?.count ?? 0) + 1,
        expiresAt: input.expiresAt,
        version: (existing?.version ?? 0) + 1,
        createdAt: existing?.createdAt ?? input.now,
        updatedAt: input.now,
        data: { owner: input.owner },
      };
      records.set(input.key, record);

      return record;
    },
    async releaseLock(input) {
      const existing = records.get(input.key);
      if (
        !existing ||
        existing.kind !== "lock" ||
        existing.status !== "held" ||
        existing.data?.["owner"] !== input.owner
      ) {
        return false;
      }
      records.set(input.key, {
        ...existing,
        status: "released",
        expiresAt: input.now,
        version: existing.version + 1,
        updatedAt: input.now,
      });

      return true;
    },
    async consumeToken(key, now) {
      const record = records.get(key);
      if (
        !record ||
        record.kind !== "token" ||
        record.status !== "pending" ||
        record.expiresAt <= now
      ) {
        return false;
      }
      records.set(key, {
        ...record,
        status: "consumed",
        version: record.version + 1,
        updatedAt: now,
      });

      return true;
    },
    async restoreToken(key, now) {
      const record = records.get(key);
      if (!record || record.kind !== "token" || record.status !== "consumed") {
        return false;
      }
      records.set(key, {
        ...record,
        status: "pending",
        version: record.version + 1,
        updatedAt: now,
      });

      return true;
    },
    async purgeExpired(now) {
      let purged = 0;
      for (const [key, record] of records) {
        if (record.expiresAt <= now) {
          records.delete(key);
          purged += 1;
        }
      }

      return purged;
    },
    async deleteTokensBySubjectHashes(subjectHashes) {
      const subjects = new Set(subjectHashes);
      let deleted = 0;
      for (const [key, record] of records) {
        if (
          (record.kind === "token" || record.kind === "cache_marker") &&
          record.subjectHash &&
          subjects.has(record.subjectHash)
        ) {
          records.delete(key);
          deleted += 1;
        }
      }

      return deleted;
    },
  };
}

class FailingTerminalWebhookOpsRepository extends OpsRepository {
  override async put(document: MikaStorageDocuments["ops"]): Promise<void> {
    if (document.type === "webhook" && document.status !== "received") {
      throw new Error("ops persistence unavailable");
    }

    await super.put(document);
  }
}

async function createMagicLinkHarness(
  options: {
    readonly ttlMs?: number;
    readonly verifyPath?: string;
    readonly notificationHook?: MikaNotificationHook;
  } = {},
): Promise<{
  readonly api: MikaApi;
  readonly repositories: MikaBackendRepositories;
  readonly accountCollection: StorageCollection<MikaStorageDocuments["account"]>;
  readonly opsCollection: StorageCollection<MikaStorageDocuments["ops"]>;
  readonly destroy: () => Promise<void>;
}> {
  const db = createTestMikaDb();
  const accountCollection = createStorageCollection("account");
  const opsCollection = createStorageCollection("ops");

  await mikaInitialMigration.up(db);

  const repositories = {
    ...createTestBackendRepositories(),
    account: new AccountRepository(accountCollection),
    ops: new OpsRepository(opsCollection),
    ephemeral: new EphemeralRepository(db),
  } satisfies MikaBackendRepositories;
  const api = createMikaBackendApi(
    createIncrementingBackendDependencies({
      repositories,
      config: {
        magicLink: {
          ttlMs: options.ttlMs,
          ...(options.verifyPath ? { verifyPath: options.verifyPath } : {}),
        },
      },
      ...(options.notificationHook ? { notifications: { handle: options.notificationHook } } : {}),
    }),
  );

  return {
    api,
    repositories,
    accountCollection,
    opsCollection,
    destroy: async () => {
      await rollbackMikaInitialMigration(db);
      await db.destroy();
    },
  };
}

async function createAccountServicesHarness(
  options: { readonly exportTtlMs?: number; readonly notificationHook?: MikaNotificationHook } = {},
): Promise<{
  readonly api: MikaApi;
  readonly repositories: MikaBackendRepositories;
  readonly accountCollection: StorageCollection<MikaStorageDocuments["account"]>;
  readonly ledgerCollection: StorageCollection<MikaStorageDocuments["ledger"]>;
  readonly opsCollection: StorageCollection<MikaStorageDocuments["ops"]>;
  readonly destroy: () => Promise<void>;
}> {
  const db = createTestMikaDb();
  const accountCollection = createStorageCollection("account");
  const ledgerCollection = createStorageCollection("ledger");
  const opsCollection = createStorageCollection("ops");

  await mikaInitialMigration.up(db);

  const repositories = {
    ...createTestBackendRepositories(),
    account: new AccountRepository(accountCollection),
    ledger: new LedgerRepository(ledgerCollection),
    ops: new OpsRepository(opsCollection),
    ephemeral: new EphemeralRepository(db),
  } satisfies MikaBackendRepositories;
  const api = createMikaBackendApi(
    createIncrementingBackendDependencies({
      repositories,
      config: {
        accountExport: {
          ttlMs: options.exportTtlMs,
        },
      },
      ...(options.notificationHook ? { notifications: { handle: options.notificationHook } } : {}),
    }),
  );

  return {
    api,
    repositories,
    accountCollection,
    ledgerCollection,
    opsCollection,
    destroy: async () => {
      await rollbackMikaInitialMigration(db);
      await db.destroy();
    },
  };
}

type StockRepositoryContractKind = "fake" | "real";

async function withStockRepositoryContractHarness(
  kind: StockRepositoryContractKind,
  stockItem: StockItemRecord,
  run: (harness: {
    readonly repository: MikaBackendRepositories["stock"];
    readonly service: ReturnType<typeof createMikaStockLifecycleService>;
  }) => Promise<void>,
): Promise<void> {
  if (kind === "fake") {
    const repository = createTestStockRepository(new Map([[stockItem.sellableId, stockItem]]));
    const service = createMikaStockLifecycleService(
      createIncrementingBackendDependencies({
        repositories: { ...createTestBackendRepositories(), stock: repository },
      }),
    );

    await run({ repository, service });
    return;
  }

  const database = createTransactionTestMikaDb();
  const { db } = database;
  const repository = new StockRepository(db);
  const service = createMikaStockLifecycleService(
    createIncrementingBackendDependencies({
      repositories: { ...createTestBackendRepositories(), stock: repository },
    }),
  );

  try {
    await mikaInitialMigration.up(db);
    await repository.putItem(stockItem);
    await run({ repository, service });
  } finally {
    await rollbackMikaInitialMigration(db);
    await database.destroy();
  }
}

function createTestStockRepository(
  stockBySellableId: ReadonlyMap<string, StockItemRecord> = new Map(),
): MikaBackendRepositories["stock"] {
  const stockItems =
    stockBySellableId instanceof Map ? stockBySellableId : new Map(stockBySellableId);
  const eventsById = new Map<string, StockEventRecord>();
  const eventsByIdempotencyKey = new Map<string, StockEventRecord>();
  async function transitionActiveReservation<TStatus extends "released" | "expired">(input: {
    readonly reservationEventId: MikaId;
    readonly now: ISODateTime;
    readonly targetStatus: TStatus;
  }) {
    const event = eventsById.get(input.reservationEventId);
    if (!event) return { status: "not_found" as const };

    const current =
      Array.from(stockItems.values()).find((stock) => stock.id === event.stockItemId) ?? null;
    if (event.status !== "active") {
      return { status: "not_active" as const, event, stock: current };
    }

    const transitionedEvent: StockEventRecord = {
      ...event,
      status: input.targetStatus,
      idempotencyKey: undefined,
      updatedAt: input.now,
    };
    const stock = current
      ? {
          ...current,
          quantityReserved: Math.max(0, current.quantityReserved - event.quantityDelta),
          updatedAt: input.now,
        }
      : null;
    eventsById.set(transitionedEvent.id, transitionedEvent);
    if (event.idempotencyKey) {
      eventsByIdempotencyKey.delete(event.idempotencyKey);
    }
    if (stock) {
      stockItems.set(stock.sellableId, stock);
    }

    return stock
      ? { status: input.targetStatus, event: transitionedEvent, stock }
      : { status: "not_active" as const, event: transitionedEvent, stock };
  }

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
    async putItemDefinition(stock) {
      const existing = stockItems.get(stock.sellableId);
      stockItems.set(stock.sellableId, {
        ...stock,
        quantityOnHand: existing?.quantityOnHand ?? stock.quantityOnHand,
        quantityReserved: existing?.quantityReserved ?? stock.quantityReserved,
      });
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
        current.policy !== "finite" ||
        current.allowBackorder ||
        reservation.quantity <= availableQuantity;
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
      return transitionActiveReservation({
        reservationEventId: release.reservationEventId,
        now: release.now,
        targetStatus: "released",
      });
    },
    async expire(expire) {
      return transitionActiveReservation({
        reservationEventId: expire.reservationEventId,
        now: expire.now,
        targetStatus: "expired",
      });
    },
    async consume(consume) {
      const event = eventsById.get(consume.reservationEventId);
      if (!event || event.kind !== "reservation") return { status: "not_found" };

      const current =
        Array.from(stockItems.values()).find((stock) => stock.id === event.stockItemId) ?? null;
      if (event.status !== "active" && event.status !== "expired") {
        return { status: "not_active", event, stock: current };
      }

      const fromActive = event.status === "active";
      if (
        !fromActive &&
        current &&
        current.policy === "finite" &&
        !current.allowBackorder &&
        current.quantityOnHand - current.quantityReserved < event.quantityDelta
      ) {
        throw new Error(
          `Reservation event '${event.id}' cannot be consumed: insufficient available stock to fulfill the expired reservation without overselling.`,
        );
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
            quantityOnHand:
              current.policy === "finite"
                ? Math.max(0, current.quantityOnHand - event.quantityDelta)
                : current.quantityOnHand,
            quantityReserved: fromActive
              ? Math.max(0, current.quantityReserved - event.quantityDelta)
              : current.quantityReserved,
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
    async releaseExpiredReservations(input) {
      let scannedCount = 0;
      let releasedCount = 0;
      const stockItemsAffected = new Set<MikaId>();

      for (const event of Array.from(eventsById.values())) {
        if (
          event.kind !== "reservation" ||
          event.status !== "active" ||
          !event.expiresAt ||
          event.expiresAt > input.now
        ) {
          continue;
        }

        scannedCount += 1;
        const expiredEvent: StockEventRecord = {
          ...event,
          status: "expired",
          idempotencyKey: undefined,
          updatedAt: input.now,
        };
        const current =
          Array.from(stockItems.values()).find((stock) => stock.id === event.stockItemId) ?? null;
        eventsById.set(expiredEvent.id, expiredEvent);
        if (event.idempotencyKey) {
          eventsByIdempotencyKey.delete(event.idempotencyKey);
        }
        if (!current) continue;

        const stock = {
          ...current,
          quantityReserved: Math.max(0, current.quantityReserved - event.quantityDelta),
          updatedAt: input.now,
        };
        stockItems.set(stock.sellableId, stock);
        stockItemsAffected.add(stock.id);
        releasedCount += 1;
      }

      return { scannedCount, releasedCount, stockItemsAffected: stockItemsAffected.size };
    },
    async releaseActiveReservationsByCustomer(input) {
      let scannedCount = 0;
      let releasedCount = 0;
      const stockItemsAffected = new Set<MikaId>();

      for (const event of Array.from(eventsById.values())) {
        if (
          event.kind !== "reservation" ||
          event.status !== "active" ||
          event.customerId !== input.customerId
        ) {
          continue;
        }

        scannedCount += 1;
        const releasedEvent: StockEventRecord = {
          ...event,
          status: "released",
          idempotencyKey: undefined,
          updatedAt: input.now,
        };
        const current =
          Array.from(stockItems.values()).find((stock) => stock.id === event.stockItemId) ?? null;
        eventsById.set(releasedEvent.id, releasedEvent);
        if (event.idempotencyKey) {
          eventsByIdempotencyKey.delete(event.idempotencyKey);
        }
        if (!current) continue;

        const stock = {
          ...current,
          quantityReserved: Math.max(0, current.quantityReserved - event.quantityDelta),
          updatedAt: input.now,
        };
        stockItems.set(stock.sellableId, stock);
        stockItemsAffected.add(stock.id);
        releasedCount += 1;
      }

      return { scannedCount, releasedCount, stockItemsAffected: stockItemsAffected.size };
    },
    async extendReservations(input) {
      for (const id of input.reservationEventIds) {
        const event = eventsById.get(id);
        if (!event || event.kind !== "reservation" || event.status !== "active") continue;
        if (event.expiresAt && event.expiresAt >= input.expiresAt) continue;

        const extended: StockEventRecord = {
          ...event,
          expiresAt: input.expiresAt,
          updatedAt: input.now,
        };
        eventsById.set(extended.id, extended);
        if (extended.idempotencyKey) {
          eventsByIdempotencyKey.set(extended.idempotencyKey, extended);
        }
      }
    },
    async adjustStock(adjustment) {
      if (!Number.isInteger(adjustment.quantityDelta) || adjustment.quantityDelta === 0) {
        throw new RangeError("Stock adjustment quantity must be a non-zero whole number.");
      }

      const replayed = adjustment.idempotencyKey
        ? eventsByIdempotencyKey.get(adjustment.idempotencyKey)
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
        Array.from(stockItems.values()).find((stock) => stock.id === adjustment.stockItemId) ??
        null;
      if (!current) return { status: "not_found" };

      const nextQuantityOnHand = current.quantityOnHand + adjustment.quantityDelta;
      if (nextQuantityOnHand < 0) {
        return { status: "would_go_negative", stock: current };
      }
      if (
        adjustment.quantityDelta < 0 &&
        current.policy === "finite" &&
        !current.allowBackorder &&
        nextQuantityOnHand < current.quantityReserved
      ) {
        return { status: "would_undercut_reserved", stock: current };
      }

      const stock: StockItemRecord = {
        ...current,
        quantityOnHand: nextQuantityOnHand,
        updatedAt: adjustment.now,
      };
      const event: StockEventRecord = {
        id: adjustment.movementEventId,
        stockItemId: adjustment.stockItemId,
        kind: "movement",
        status: "recorded",
        reason: adjustment.reason ?? "manual_adjustment",
        adminAuditId: adjustment.adminAuditId,
        idempotencyKey: adjustment.idempotencyKey,
        quantityDelta: adjustment.quantityDelta,
        createdAt: adjustment.now,
        updatedAt: adjustment.now,
        metadata: adjustment.metadata,
      };
      stockItems.set(stock.sellableId, stock);
      eventsById.set(event.id, event);
      if (event.idempotencyKey) {
        eventsByIdempotencyKey.set(event.idempotencyKey, event);
      }

      return { status: "adjusted", event, stock };
    },
  };
}

function createStorageCollection<TName extends keyof MikaStorageDocuments>(
  name: TName,
): StorageCollection<MikaStorageDocuments[TName]> {
  return createMemoryStorageCollectionWithConfig<MikaStorageDocuments[TName]>(
    createMikaStorageConfig()[name],
  );
}

function createAdminAuditTestDocument(
  overrides: Partial<Omit<AdminAuditDocument, "record">> & {
    readonly record?: Partial<AdminAuditDocument["record"]>;
  } = {},
): AdminAuditDocument {
  const { record: recordOverrides, ...documentOverrides } = overrides;
  const id = documentOverrides.id ?? createTestMikaId("admin_audit", 1);
  const action = documentOverrides.action ?? recordOverrides?.action ?? "order.refund";
  const status = documentOverrides.status ?? recordOverrides?.status ?? "started";
  const idempotencyKey =
    documentOverrides.idempotencyKey ?? recordOverrides?.idempotencyKey ?? "admin_retry_race";
  const metadata = {
    idempotencyInputHash: "same_input_hash",
    ...recordOverrides?.metadata,
  };

  return {
    id,
    type: "adminAudit",
    schemaVersion: 1,
    action,
    status,
    idempotencyKey,
    record: {
      id,
      action,
      status,
      idempotencyKey,
      createdAt: TEST_NOW,
      metadata,
      ...recordOverrides,
    },
    createdAt: TEST_NOW,
    updatedAt: TEST_NOW,
    ...documentOverrides,
  };
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

async function issueDownloadToken(
  repositories: MikaBackendRepositories,
  input: {
    readonly token: string;
    readonly status?: string;
    readonly expiresAt: string;
    readonly data: JsonObject;
  },
): Promise<void> {
  await repositories.ephemeral.put({
    key: createTestHash(`download-token:${input.token}`),
    kind: "token",
    status: input.status ?? "pending",
    count: 0,
    expiresAt: createISODateTime(input.expiresAt),
    version: 1,
    createdAt: TEST_NOW,
    updatedAt: TEST_NOW,
    data: {
      purpose: "download",
      ...input.data,
    },
  });
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

function createOrderDocument(overrides: Partial<OrderDocument> = {}): OrderDocument {
  const orderId = overrides.id ?? createTestMikaId("order", 1);

  return {
    id: orderId,
    type: "order",
    schemaVersion: 1,
    orderNumber: "M-1001",
    customerId: createTestMikaId("customer", 1),
    provider: TEST_PROVIDER,
    providerPaymentId: "payment_1",
    providerOrderId: "provider_order_1",
    status: "paid",
    paymentStatus: "paid",
    currency: TEST_CURRENCY,
    totalAmount: 1200,
    paidAt: TEST_NOW,
    aggregate: {
      schemaVersion: 1,
      customer: {
        customerId: createTestMikaId("customer", 1),
        userId: "user_1",
        email: "Subscriber@Example.test",
        emailHash: createTestHash("email:subscriber@example.test"),
        name: "Subscriber One",
      },
      lines: [
        {
          id: createTestMikaId("order_line", 1),
          item: createPurchasableSnapshot({ titleSnapshot: "Test download" }),
          quantity: 1,
          subtotalAmount: 1200,
          totalAmount: 1200,
          downloadRefs: ["download:order_1:order_line_1"],
        },
      ],
      totals: {
        subtotal: { amount: 1200, currency: TEST_CURRENCY },
        total: { amount: 1200, currency: TEST_CURRENCY },
      },
      providerRefs: [
        {
          provider: TEST_PROVIDER,
          paymentId: "payment_1",
          orderId: "provider_order_1",
        },
      ],
      invoiceUrl: "https://invoice.example.test/order_1",
    },
    createdAt: TEST_NOW,
    updatedAt: TEST_NOW,
    ...overrides,
  };
}

function createSubscriptionDocument(
  overrides: Partial<SubscriptionDocument> = {},
): SubscriptionDocument {
  const currentPeriodEnd = createTestClock().isoAt(31 * 24 * 60 * 60_000);

  return {
    id: createTestMikaId("subscription", 1),
    type: "subscription",
    schemaVersion: 1,
    customerId: createTestMikaId("customer", 1),
    provider: TEST_PROVIDER,
    providerCustomerId: "provider_customer_1",
    providerSubscriptionId: "provider_subscription_1",
    status: "active",
    currentPeriodEnd,
    aggregate: {
      schemaVersion: 1,
      customer: {
        customerId: createTestMikaId("customer", 1),
        userId: "user_1",
        email: "Subscriber@Example.test",
        emailHash: createTestHash("email:subscriber@example.test"),
        name: "Subscriber One",
      },
      sellable: createPurchasableSnapshot({
        titleSnapshot: "Test subscription",
        mode: "subscription",
        fulfillmentKind: "entitlement",
      }),
      providerRef: {
        provider: TEST_PROVIDER,
        customerId: "provider_customer_1",
        subscriptionId: "provider_subscription_1",
      },
      status: "active",
      cancelAtPeriodEnd: false,
      currentPeriodEnd,
    },
    createdAt: TEST_NOW,
    updatedAt: TEST_NOW,
    ...overrides,
  };
}

function createCartDocument(overrides: Partial<CartDocument> = {}): CartDocument {
  const id = overrides.id ?? createTestMikaId("cart", 1);

  return {
    id,
    type: "cart",
    schemaVersion: 1,
    sessionId: "session_1",
    customerId: createTestMikaId("customer", 1),
    userId: "user_1",
    status: "open",
    currency: TEST_CURRENCY,
    version: 1,
    aggregate: {
      schemaVersion: 1,
      currency: TEST_CURRENCY,
      items: [],
    },
    createdAt: TEST_NOW,
    updatedAt: TEST_NOW,
    ...overrides,
  };
}

function createEntitlementDocument(
  overrides: Partial<Omit<EntitlementDocument, "record">> & {
    readonly record?: Partial<EntitlementDocument["record"]>;
  } = {},
): EntitlementDocument {
  const { record: recordOverrides, ...documentOverrides } = overrides;
  const currentPeriodEnd = createTestClock().isoAt(31 * 24 * 60 * 60_000);
  const record = {
    id: overrides.id ?? createTestMikaId("entitlement", 1),
    customerId: createTestMikaId("customer", 1),
    userId: "user_1",
    emailHash: createTestHash("email:subscriber@example.test"),
    entitlementKey: "downloads.pro",
    orderId: createTestMikaId("order", 1),
    status: "active" as const,
    currentPeriodEnd,
    grantedAt: TEST_NOW,
    ...recordOverrides,
  };

  return {
    id: record.id,
    type: "entitlement",
    schemaVersion: 1,
    customerId: record.customerId,
    userId: record.userId,
    emailHash: record.emailHash,
    entitlementKey: record.entitlementKey,
    status: record.status,
    orderId: record.orderId,
    subscriptionId: record.subscriptionId,
    record,
    createdAt: TEST_NOW,
    updatedAt: TEST_NOW,
    ...documentOverrides,
  };
}

function createLicenseDocument(overrides: Partial<LicenseDocument> = {}): LicenseDocument {
  const record = {
    id: overrides.id ?? createTestMikaId("license", 1),
    orderId: createTestMikaId("order", 1),
    orderLineId: createTestMikaId("order_line", 1),
    entitlementId: createTestMikaId("entitlement", 1),
    licenseKeyHash: createTestHash("license-key:one"),
    displayKeySuffix: "1234",
    status: "active" as const,
    createdAt: TEST_NOW,
    ...overrides.record,
  };

  return {
    id: record.id,
    type: "license",
    schemaVersion: 1,
    orderId: record.orderId,
    orderLineId: record.orderLineId,
    entitlementId: record.entitlementId,
    status: record.status,
    customerId: createTestMikaId("customer", 1),
    record,
    createdAt: TEST_NOW,
    updatedAt: TEST_NOW,
    ...overrides,
  };
}

function createEmailDocument(
  overrides: Partial<Omit<EmailDocument, "record">> & {
    readonly record?: Partial<EmailDocument["record"]>;
  } = {},
): EmailDocument {
  const record = {
    id: overrides.id ?? createTestMikaId("email", 1),
    customerId: createTestMikaId("customer", 1),
    orderId: createTestMikaId("order", 1),
    kind: "download" as const,
    toEmail: "subscriber@example.test",
    subject: "Your download",
    status: "queued" as const,
    templateKey: "download",
    templateVersion: "1",
    attemptCount: 1,
    maxAttempts: 5,
    nextAttemptAt: TEST_NOW,
    createdAt: TEST_NOW,
    ...overrides.record,
  };

  return {
    id: record.id,
    type: "email",
    schemaVersion: 1,
    ...overrides,
    status: record.status,
    nextAttemptAt: record.nextAttemptAt,
    orderId: record.orderId,
    tokenId: record.tokenId,
    kind: record.kind,
    record,
    createdAt: TEST_NOW,
    updatedAt: TEST_NOW,
  };
}

function createPurchasableSnapshot(
  overrides: Partial<OrderDocument["aggregate"]["lines"][number]["item"]> = {},
): OrderDocument["aggregate"]["lines"][number]["item"] {
  return {
    content: createTestContentRef(),
    sellableId: createTestMikaId("sellable", 1),
    priceId: createTestMikaId("price", 1),
    sku: "TEST-SKU-1",
    titleSnapshot: "Test sellable",
    variantOptions: [],
    unitAmount: 1200,
    currency: TEST_CURRENCY,
    mode: "payment",
    fulfillmentKind: "download",
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
    readonly sessionId?: string;
    readonly customerId?: MikaId;
    readonly status?: CheckoutDocument["status"];
    readonly providerCheckoutId?: string;
    readonly checkoutIdempotencyKey?: string;
    readonly checkoutIdempotencyInputHash?: string;
    readonly providerStatus?: CheckoutDocument["providerStatus"];
    readonly redirectUrl?: string;
    readonly orderId?: MikaId;
    readonly failureReason?: string;
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
    sessionId: overrides.sessionId,
    customerId: overrides.customerId,
    provider: TEST_PROVIDER,
    providerCheckoutId,
    checkoutIdempotencyKey: overrides.checkoutIdempotencyKey,
    checkoutIdempotencyInputHash: overrides.checkoutIdempotencyInputHash,
    providerStatus: overrides.providerStatus,
    redirectUrl: overrides.redirectUrl,
    orderId: overrides.orderId,
    failureReason: overrides.failureReason,
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

async function expectCheckoutFailureInvariant(input: {
  readonly repositories: MikaBackendRepositories;
  readonly provider: ReturnType<typeof createFakeMikaProvider>;
  readonly providerCheckoutCalls: number;
  readonly stockSellableId?: MikaId;
  readonly quantityReserved?: number;
  readonly cartId?: MikaId;
  readonly cartStatus?: string;
  readonly checkoutId?: MikaId;
  readonly checkoutStatus?: string | null;
}): Promise<void> {
  expect(input.provider.getCalls().createCheckoutSession).toHaveLength(input.providerCheckoutCalls);

  if (input.stockSellableId !== undefined && input.quantityReserved !== undefined) {
    await expect(
      input.repositories.stock.findBySellableId(input.stockSellableId),
    ).resolves.toMatchObject({
      quantityReserved: input.quantityReserved,
    });
  }

  if (input.cartId !== undefined && input.cartStatus !== undefined) {
    await expect(input.repositories.session.findById(input.cartId)).resolves.toMatchObject({
      type: "cart",
      status: input.cartStatus,
    });
  }

  if (input.checkoutId !== undefined) {
    if (input.checkoutStatus === null) {
      await expect(input.repositories.session.findById(input.checkoutId)).resolves.toBeNull();
    } else if (input.checkoutStatus !== undefined) {
      await expect(input.repositories.session.findById(input.checkoutId)).resolves.toMatchObject({
        type: "checkout",
        status: input.checkoutStatus,
      });
    }
  }
}

function expectMikaOk<T>(result: MikaApiResult<T>, data?: unknown): void {
  expect(result).toMatchObject({
    ok: true,
    status: 200,
    ...(data === undefined ? {} : { data }),
  });
}

function expectMikaError(
  result: MikaApiResult<unknown>,
  error: {
    readonly status: number;
    readonly code: string;
    readonly message?: string;
  },
): void {
  expect(result).toMatchObject({
    ok: false,
    status: error.status,
    error: {
      code: error.code,
      ...(error.message === undefined ? {} : { message: error.message }),
    },
  });
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

function webhookMarkerFromRawBody(rawBody: Uint8Array): string {
  const parsed: unknown = JSON.parse(new TextDecoder().decode(rawBody));

  return isJsonObject(parsed) && typeof parsed["marker"] === "string"
    ? parsed["marker"]
    : "unknown";
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
    readonly paymentStatus?: Extract<
      MikaProviderWebhookEvent,
      { readonly kind: "payment" }
    >["paymentStatus"];
  } = {},
): MikaProviderWebhookEvent {
  return {
    kind: "payment",
    paymentStatus: overrides.paymentStatus ?? "paid",
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
