/**
 * Integration harness for the published Mika package surface.
 * Covers plugin wiring, subpath exports, agent manifests, and template contracts.
 */
import { readdirSync, readFileSync } from "node:fs";
import Ajv2020 from "ajv/dist/2020";
import { describe, expect, expectTypeOf, it } from "vite-plus/test";
import {
  MIKA_PACKAGE_NAME,
  MIKA_MAINTENANCE_CRON_SCHEDULE,
  MIKA_MAINTENANCE_CRON_TASK,
  MIKA_PLUGIN_ID,
  MIKA_PLUGIN_VERSION,
  createPlugin,
  mikaPlugin,
  type MikaCreatePluginOptions,
} from "../src/index";
import type {
  mikaPlugin as PackageMikaPlugin,
  MikaOperationDescriptor as PackageRootMikaOperationDescriptor,
  MikaOperationPolicy as PackageRootMikaOperationPolicy,
} from "@bnomei/emdash-mika";
import type {
  createMikaAcpCheckoutHandlers as PackageCreateMikaAcpCheckoutHandlers,
  createMikaAcpProductFeed as PackageCreateMikaAcpProductFeed,
} from "@bnomei/emdash-mika/acp";
import type {
  createMikaAgentManifest as PackageCreateMikaAgentManifest,
  mikaAgentManifestJsonSchema as PackageMikaAgentManifestJsonSchema,
  MikaAgentActionDescriptor as PackageMikaAgentActionDescriptor,
  MikaAgentManifestJsonSchema as PackageMikaAgentManifestJsonSchemaType,
} from "@bnomei/emdash-mika/agent";
import type { createMikaAdminActionsManifest as PackageCreateMikaAdminActionsManifest } from "@bnomei/emdash-mika/admin";
import type {
  createMika as PackageCreateMika,
  MikaAstroClientOptions as PackageMikaAstroClientOptions,
  mikaHiddenInput as PackageMikaHiddenInput,
  mikaRedirectInputs as PackageMikaRedirectInputs,
  mikaReturnToInput as PackageMikaReturnToInput,
  mikaSafeReturnTo as PackageMikaSafeReturnTo,
} from "@bnomei/emdash-mika/astro";
import type { createMikaClient as PackageCreateMikaClient } from "@bnomei/emdash-mika/client";
import type { renderMikaEmail as PackageRenderMikaEmail } from "@bnomei/emdash-mika/email";
import type { createMikaProviderRegistry as PackageCreateMikaProviderRegistry } from "@bnomei/emdash-mika/provider";
import type { MikaProvider as PackageMikaProvider } from "@bnomei/emdash-mika/react";
import type {
  assertMikaApiWired as PackageAssertMikaApiWired,
  createEmDashMikaEmailSender as PackageCreateEmDashMikaEmailSender,
  createMikaBackendApi as PackageCreateMikaBackendApi,
  createMikaEmailOutboxRunner as PackageCreateMikaEmailOutboxRunner,
  createMikaMaintenanceRunner as PackageCreateMikaMaintenanceRunner,
  createMikaServerClient as PackageCreateMikaServerClient,
  mikaApiMethodNames as PackageMikaApiMethodNames,
  MikaBackendDependencies as PackageMikaBackendDependencies,
  MikaNotificationHook as PackageMikaNotificationHook,
  MikaNotificationIntent as PackageMikaNotificationIntent,
  MikaNotificationKind as PackageMikaNotificationKind,
  MikaOperationDescriptor as PackageServerMikaOperationDescriptor,
  MikaOperationPolicy as PackageServerMikaOperationPolicy,
} from "@bnomei/emdash-mika/server";
import type {
  MIKA_ERROR_CODES as PACKAGE_MIKA_ERROR_CODES,
  MikaActorContext as PackageMikaActorContext,
  MikaPaymentAuthorizationRef as PackageMikaPaymentAuthorizationRef,
  createMikaId as PackageCreateMikaId,
} from "@bnomei/emdash-mika/types";
import type { createMikaStripeProvider as PackageCreateMikaStripeProvider } from "@bnomei/emdash-mika/stripe";
import {
  createMikaAcpCheckoutHandlers,
  createMikaAcpProductFeed,
  createMemoryMikaAcpSessionStore,
  type MikaAcpProduct,
} from "../src/acp";
import {
  createMikaAgentManifest,
  mikaAgentManifestJsonSchema,
  MIKA_ACTION_RUN_STATUSES,
  MIKA_AGENT_ACTOR_REQUIREMENTS,
  MIKA_AGENT_APPROVAL_STATUSES,
  MIKA_AGENT_CAPABILITIES,
  MIKA_AGENT_CONFIRMATION_POLICIES,
  MIKA_AGENT_EFFECTS,
  MIKA_AGENT_IDEMPOTENCY_KEY_HEADER,
  MIKA_AGENT_IDEMPOTENCY_POLICIES,
  MIKA_AGENT_IDEMPOTENCY_SCOPES,
  MIKA_AGENT_MANIFEST_VERSION,
  MIKA_AGENT_PROOF_KINDS,
  MIKA_AGENT_RESOURCES,
  MIKA_AGENT_RISKS,
  MIKA_AGENT_VISIBILITIES,
  type MikaActorContext,
  type MikaActionRun,
  type MikaAgentActionDescriptor,
  type MikaAgentApprovalRef,
  type MikaAgentManifest,
  type MikaAgentManifestJsonSchema,
  type MikaAgentOperationMetadata,
  type MikaPaymentAuthorizationRef,
} from "../src/agent";
import {
  createMikaActionButtonOptions,
  createMikaActionsProviderConfig,
  createMikaAdminActionsManifest,
  createMikaCatalogSyncActionButtonOptions,
  mikaAdminActionDefinitions,
  type MikaAdminActionId,
} from "../src/admin";
import {
  assertMikaApiWired,
  createMikaBackendApi,
  createEmDashMikaEmailSender,
  createMikaRequestContext,
  createMikaApi,
  createMikaEmailOutboxRunner,
  createMikaMaintenanceRunner,
  createMikaServerClient,
  mikaApiMethodNames,
  type MikaBackendDependencies,
  type MikaApi,
  type MikaApiOverrides,
  type MikaNotificationHook,
  type MikaNotificationIntent,
  type MikaNotificationKind,
  type MikaOperationDescriptor,
  type MikaOperationPolicy,
  type MikaServerClient,
} from "../src/server";
import { createMikaClient, type MikaClient } from "../src/api/client";
import { requestMika } from "../src/api/request";
import { createMikaPluginRoutes } from "../src/api/route-handlers";
import { catalogSellablesToDTO } from "../src/model/index";
import {
  createMika,
  createMikaPurchaseModel,
  createMikaPurchaseOptions,
  formatMikaMoney,
  isMikaPurchasable,
  type MikaAstroClientOptions,
  mikaHiddenInput,
  mikaMaxPurchaseQuantity,
  mikaRedirectInputs,
  mikaReturnTo,
  mikaReturnToInput,
  mikaSafeReturnTo,
} from "../src/astro";
import { mikaRedirectInputs as mikaShimRedirectInputs } from "../src/templates/astro/lib/form";
import {
  createMikaProviderRegistry,
  defineMikaProvider,
  type MikaProviderAdapter,
  type MikaProviderCheckoutSession,
} from "../src/provider";
import { createMikaStripeProvider, type MikaStripeClient } from "../src/stripe";
import {
  createMikaPluginRouteBuilder,
  mikaPluginRoutes,
  mikaPluginRoute,
  publicMikaPluginRouteNames,
  type MikaPluginRouteName,
} from "../src/api/routes";
import {
  mikaActionDefinitions,
  mikaOperationDescriptors,
  mikaOperationDefinitions,
  mikaRoutedOperationDefinitions,
  mikaRouteOnlyDefinitions,
} from "../src/api/operations";
import {
  cartQuoteInputSchema,
  startCheckoutInputSchema,
  updateCartItemInputSchema,
} from "../src/api/validation";
import {
  adminActionOperation,
  mikaAdminActionRuntimeDefinitions,
} from "../src/api/admin-action-runner";
import { mikaActionTreeDefinitionKeys, validateMikaActionTreeSpec } from "../src/api/action-tree";
import { mikaOperationFacadeSpec } from "../src/api/operation-facade";
import { resolveMikaOperationPolicy, setDefaultMikaOperationPolicy } from "../src/api/runtime-api";
import {
  mikaEmailTemplates,
  renderMikaEmail,
  renderMikaMagicLinkEmail,
  renderMikaOrderConfirmationEmail,
  type MikaEmailInput,
} from "../src/email";
import {
  type CartDTO,
  type CartQuoteDTO,
  type CartQuoteInput,
  type AccountExportDownloadDTO,
  type CheckoutPreviewDTO,
  type CheckoutPreviewInput,
  type CheckoutPreviewProofRequirementDTO,
  type DownloadResolutionDTO,
  MIKA_ERROR_CODES,
  MIKA_PROVIDER_CAPABILITIES,
  type MikaApiResult,
  type MikaErrorCode,
  type MikaProviderCapability,
  type ProviderHealthDTO,
  type RemoveWishlistItemInput,
} from "../src/api/types";

const expectedOperationContracts = [
  ["catalogSellables", "catalog", "sellables", "catalogSellables"],
  ["stockAvailability", "stock", "availability", "stockAvailability"],
  ["cartGet", "cart", "get", ""],
  ["cartQuote", "cart", "quote", ""],
  ["cartAdd", "cart", "add", "cartAdd"],
  ["cartUpdate", "cart", "update", "cartUpdate"],
  ["cartRemove", "cart", "remove", "cartRemove"],
  ["cartMerge", "cart", "merge", "cartMerge"],
  ["cartApplyCoupon", "cart", "applyCoupon", "cartApplyCoupon"],
  ["cartRemoveCoupon", "cart", "removeCoupon", "cartRemoveCoupon"],
  ["wishlistGet", "wishlist", "get", ""],
  ["wishlistAdd", "wishlist", "add", "wishlistAdd"],
  ["wishlistRemove", "wishlist", "remove", "wishlistRemove"],
  ["wishlistMoveToCart", "wishlist", "moveToCart", "wishlistMoveToCart"],
  ["wishlistSaveForLater", "wishlist", "saveForLater", "wishlistSaveForLater"],
  ["wishlistMerge", "wishlist", "merge", "wishlistMerge"],
  ["checkoutStart", "checkout", "start", "checkoutStart"],
  ["checkoutPreview", "checkout", "preview", ""],
  ["checkoutStatus", "checkout", "status", "checkoutStatus"],
  ["checkoutCancel", "checkout", "cancel", ""],
  ["magicLinkRequest", "magicLink", "request", "magicLinkRequest"],
  ["magicLinkVerify", "magicLink", "verify", "magicLinkVerify"],
  ["accountGet", "account", "get", ""],
  ["accountExport", "account", "export", "accountExport"],
  ["accountExportStatus", "account", "exportStatus", "accountExportStatus"],
  ["accountExportDownload", "account", "exportDownload", ""],
  ["accountExportDownloadConsume", "account", "exportDownloadConsume", ""],
  ["accountDelete", "account", "delete", "accountDelete"],
  ["accountPortal", "account", "portal", "accountPortal"],
  ["subscriptionCancel", "subscription", "cancel", "subscriptionCancel"],
  ["subscriptionChange", "subscription", "change", "subscriptionChange"],
  ["subscriptionRenew", "subscription", "renew", "subscriptionRenew"],
  ["downloadResolve", "download", "resolve", ""],
  ["downloadConfirm", "download", "confirm", "downloadConfirm"],
  ["orderInvoice", "order", "invoice", ""],
  ["webhookReceive", "webhook", "receive", ""],
  ["adminProviderHealth", "admin", "providerHealth", ""],
  ["adminProviderSync", "admin", "providerSync", ""],
  ["adminStockAdjust", "admin", "stockAdjust", ""],
  ["adminStockReleaseExpiredReservations", "admin", "releaseExpiredReservations", ""],
  ["adminWebhookReplay", "admin", "webhookReplay", ""],
  ["adminOrderRefund", "admin", "orderRefund", ""],
  ["adminOrderCancel", "admin", "orderCancel", ""],
  ["adminEntitlementGrant", "admin", "entitlementGrant", ""],
  ["adminEntitlementRevoke", "admin", "entitlementRevoke", ""],
  ["adminEmailResend", "admin", "emailResend", ""],
  ["adminLicenseRevoke", "admin", "licenseRevoke", ""],
  ["adminDownloadIssue", "admin", "downloadIssue", ""],
] as const;
import {
  createCurrencyCode,
  createISODateTime,
  createMikaId,
  createProviderName,
  isISODateTime,
  type CurrencyCode,
  type ISODateTime,
  type MikaId,
  type ProviderName,
} from "../src/types/primitives";
import { decodeJsonObject } from "../src/storage/json";
import type {
  createMikaActions,
  createMikaActions as PackageCreateMikaActions,
  MikaActionName,
  MikaActions,
} from "@bnomei/emdash-mika/astro-actions";
import { MikaProvider as MikaReactProvider, useMikaStock } from "../src/react";

const id = createMikaId;
const iso = createISODateTime;
const currency = createCurrencyCode;
const provider = createProviderName;

type MutableAgentManifest = {
  operations: Array<{
    name: string;
    public: boolean;
    agent: Record<string, unknown>;
    route?: Record<string, unknown>;
  }>;
};

function createAgentManifestValidator() {
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  return ajv.compile(mikaAgentManifestJsonSchema);
}

function mutableAgentManifest(manifest: MikaAgentManifest): MutableAgentManifest {
  return structuredClone(manifest) as unknown as MutableAgentManifest;
}

function findMutableOperation(manifest: MutableAgentManifest, name: string) {
  const operation = manifest.operations.find((candidate) => candidate.name === name);
  if (!operation) {
    throw new Error(`Missing test operation '${name}'.`);
  }

  return operation;
}

export type MissingRootMikaApi =
  // @ts-expect-error Server API contracts are intentionally exported from the server subpath.
  import("@bnomei/emdash-mika").MikaApi;
export type MissingRootMikaApiOverrides =
  // @ts-expect-error Server API contracts are intentionally exported from the server subpath.
  import("@bnomei/emdash-mika").MikaApiOverrides;
export type MissingRootCreateMikaBackendApi =
  // @ts-expect-error Backend API composition is intentionally exported from the server subpath.
  typeof import("@bnomei/emdash-mika").createMikaBackendApi;
export type MissingMikaCartAddActionInput =
  // @ts-expect-error Form input helper aliases are intentionally not public exports.
  import("@bnomei/emdash-mika/astro-actions").MikaCartAddActionInput;
export type MissingMikaCheckoutStartActionInput =
  // @ts-expect-error Form input helper aliases are intentionally not public exports.
  import("@bnomei/emdash-mika/astro-actions").MikaCheckoutStartActionInput;
export type MissingMikaReturnToActionInput =
  // @ts-expect-error Form input helper aliases are intentionally not public exports.
  import("@bnomei/emdash-mika/astro-actions").MikaReturnToActionInput;
export type MissingMikaApiStatus =
  // @ts-expect-error Mika API result statuses are plain numbers, not a public alias.
  import("@bnomei/emdash-mika/types").MikaApiStatus;
export type MissingCouponResultDTO =
  // @ts-expect-error Coupon responses use CartDTO plus AppliedCouponDTO directly.
  import("@bnomei/emdash-mika/types").CouponResultDTO;
export type MissingPublicMikaOperations =
  // @ts-expect-error Operation metadata is intentionally internal to the source package.
  typeof import("@bnomei/emdash-mika/server").mikaOperationDefinitions;
export type MissingPublicRunMikaOperation =
  // @ts-expect-error Operation execution helpers are intentionally internal.
  typeof import("@bnomei/emdash-mika/server").runMikaOperation;
export type MissingPublicCallMikaOperation =
  // @ts-expect-error Dynamic operation dispatch is intentionally internal.
  typeof import("@bnomei/emdash-mika/server").callMikaOperation;

describe("Mika native plugin package", () => {
  const createPluginCronContext = (cronCalls: unknown[], logCalls: unknown[] = []) =>
    ({
      cron: {
        schedule: async (...args: unknown[]) => {
          cronCalls.push(args);
        },
        cancel: async (...args: unknown[]) => {
          cronCalls.push(["cancel", ...args]);
        },
        list: async () => [],
      },
      log: {
        debug: (message: string, data?: unknown) => {
          logCalls.push(["debug", message, data]);
        },
        info: (message: string, data?: unknown) => {
          logCalls.push(["info", message, data]);
        },
        warn: (message: string, data?: unknown) => {
          logCalls.push(["warn", message, data]);
        },
        error: (message: string, data?: unknown) => {
          logCalls.push(["error", message, data]);
        },
      },
    }) as never;

  it("creates an EmDash native plugin descriptor", () => {
    expect(mikaPlugin()).toMatchObject({
      id: MIKA_PLUGIN_ID,
      version: MIKA_PLUGIN_VERSION,
      format: "native",
      entrypoint: MIKA_PACKAGE_NAME,
      options: {},
      capabilities: ["content:read", "email:send"],
    });
  });

  it("honors descriptor entrypoint overrides", () => {
    expect(mikaPlugin({ entrypoint: "./local-plugin" })).toMatchObject({
      entrypoint: "./local-plugin",
    });
  });

  it("creates a runtime plugin with Mika routes", () => {
    const plugin = createPlugin({ assertWired: false });

    expect(plugin.id).toBe(MIKA_PLUGIN_ID);
    expect(plugin.version).toBe(MIKA_PLUGIN_VERSION);
    expect(Object.keys(plugin.routes)).toEqual(
      expect.arrayContaining([".well-known/actions", "cart", "wishlist", "checkout", "account"]),
    );
  });

  it("fails loudly at construction when the Mika API is not fully wired", () => {
    expect(() => createPlugin()).toThrow(/missing wired methods/);
    expect(() => createPlugin()).toThrow(/assertWired: false/);
    expect(() => createPlugin({ assertWired: ["checkout"] })).toThrow(/checkout\.start/);
  });

  it("hints at descriptor serialization when a provided api arrives unwired", () => {
    // The EmDash host JSON-serializes descriptor options, stripping function values.
    const serialized = JSON.parse(JSON.stringify({ api: { cart: {} } })) as MikaCreatePluginOptions;
    expect(() => createPlugin(serialized)).toThrow(/JSON-serializes descriptor options/);
    expect(() => createPlugin()).not.toThrow(/JSON-serializes descriptor options/);
  });

  it("rethrows unknown assertWired scopes without the wiring remediation", () => {
    expect(() => createPlugin({ assertWired: ["chekout"] })).toThrow(
      /Unknown Mika API wiring scope/,
    );
    expect(() => createPlugin({ assertWired: ["chekout"] })).not.toThrow(/assertWired: false/);
    expect(() => createPlugin({ assertWired: ["chekout"] })).toThrow(/assertWired entries/);
  });

  it("forwards assertWired through the mikaPlugin descriptor options", () => {
    expect(mikaPlugin({ assertWired: false }).options).toMatchObject({ assertWired: false });
    expect(mikaPlugin({ assertWired: ["catalog"] }).options).toMatchObject({
      assertWired: ["catalog"],
    });
    expect(mikaPlugin().options).not.toHaveProperty("assertWired");
  });

  it("scopes the wiring assertion to requested namespaces and methods", () => {
    expect(() =>
      createPlugin({
        api: {
          catalog: {
            sellables: async () => ({ ok: true, status: 200, data: [] }),
          },
        },
        assertWired: ["catalog"],
      }),
    ).not.toThrow();
    expect(() => createPlugin({ assertWired: false })).not.toThrow();
  });

  it("registers the default Mika maintenance cron task", async () => {
    const plugin = createPlugin({ assertWired: false });
    const calls: unknown[] = [];

    await plugin.hooks["plugin:install"]?.handler({} as never, createPluginCronContext(calls));

    expect(calls).toEqual([
      [MIKA_MAINTENANCE_CRON_TASK, { schedule: MIKA_MAINTENANCE_CRON_SCHEDULE }],
    ]);
  });

  it("supports disabled and custom Mika maintenance schedules", async () => {
    const disabled = createPlugin({ assertWired: false, maintenance: { enabled: false } });
    const custom = createPlugin({ assertWired: false, maintenance: { schedule: "*/5 * * * *" } });
    const disabledCalls: unknown[] = [];
    const customCalls: unknown[] = [];

    await disabled.hooks["plugin:activate"]?.handler(
      {} as never,
      createPluginCronContext(disabledCalls),
    );
    await custom.hooks["plugin:activate"]?.handler(
      {} as never,
      createPluginCronContext(customCalls),
    );

    expect(disabledCalls).toEqual([["cancel", MIKA_MAINTENANCE_CRON_TASK]]);
    expect(customCalls).toEqual([[MIKA_MAINTENANCE_CRON_TASK, { schedule: "*/5 * * * *" }]]);
  });

  it("cancels Mika maintenance cron on plugin deactivate and uninstall", async () => {
    const plugin = createPlugin({ assertWired: false });
    const calls: unknown[] = [];
    const ctx = createPluginCronContext(calls);

    await plugin.hooks["plugin:deactivate"]?.handler({} as never, ctx);
    await plugin.hooks["plugin:uninstall"]?.handler({ deleteData: false } as never, ctx);

    expect(calls).toEqual([
      ["cancel", MIKA_MAINTENANCE_CRON_TASK],
      ["cancel", MIKA_MAINTENANCE_CRON_TASK],
    ]);
  });

  it("invokes Mika maintenance from the cron hook", async () => {
    const calls: unknown[] = [];
    const logCalls: unknown[] = [];
    const plugin = createPlugin({
      assertWired: false,
      api: {
        admin: {
          releaseExpiredReservations: async (input) => {
            calls.push(input);

            return {
              ok: true,
              status: 200,
              data: { status: "completed", affected: { reservationsReleased: 2 } },
            };
          },
        },
      },
    });

    await plugin.hooks.cron?.handler(
      { name: MIKA_MAINTENANCE_CRON_TASK, scheduledAt: "2026-06-21T10:00:00.000Z" },
      createPluginCronContext([], logCalls),
    );
    await plugin.hooks.cron?.handler(
      { name: "unrelated", scheduledAt: "2026-06-21T10:01:00.000Z" },
      createPluginCronContext([], logCalls),
    );

    expect(calls).toEqual([{ now: "2026-06-21T10:00:00.000Z" }]);
    expect(logCalls).toEqual([
      [
        "info",
        "Mika maintenance completed",
        expect.objectContaining({
          now: "2026-06-21T10:00:00.000Z",
          tasks: expect.objectContaining({
            stockReservations: expect.objectContaining({
              status: "completed",
              reservationsReleased: 2,
            }),
            emailOutbox: expect.objectContaining({
              status: "skipped",
            }),
            accountDeleteRequests: expect.objectContaining({
              status: "skipped",
            }),
          }),
        }),
      ],
    ]);
  });

  it("runs the email outbox, ephemeral purge, and account-delete tasks when the host wires them", async () => {
    const logCalls: unknown[] = [];
    const emailRunCalls: unknown[] = [];
    const purgeCalls: unknown[] = [];
    const plugin = createPlugin({
      assertWired: false,
      api: {
        admin: {
          releaseExpiredReservations: async () => ({
            ok: true,
            status: 200,
            data: { status: "completed", affected: { reservationsReleased: 0 } },
          }),
        },
      },
      maintenance: {
        emailOutboxRunner: {
          runOnce: async (options) => {
            emailRunCalls.push(options);
            return {
              scanned: 2,
              leased: 2,
              sent: 2,
              failed: 0,
              skipped: 0,
              leaseMissed: 0,
              leaseLost: 0,
              hasMore: false,
              items: [],
            };
          },
        },
        repositories: {
          ephemeral: {
            purgeExpired: async (now: string) => {
              purgeCalls.push(now);
              return 4;
            },
          },
          ops: {
            listQueuedAccountDeleteRequests: async () => ({ items: [], hasMore: false }),
            reclaimExhaustedEmails: async () => ({ scanned: 0, reclaimed: 0 }),
            purgeWebhookRawPayloads: async () => ({ scanned: 0, purged: 0 }),
            reclaimExhaustedWorkflows: async () => ({ scanned: 0, reclaimed: 0 }),
            listDueWorkflows: async () => ({ items: [], hasMore: false }),
          },
          session: {
            listCheckoutPendingCartsByCustomer: async () => ({ items: [], hasMore: false }),
          },
          stock: {},
        } as never,
      },
    });

    await plugin.hooks.cron?.handler(
      { name: MIKA_MAINTENANCE_CRON_TASK, scheduledAt: "2026-06-21T10:00:00.000Z" },
      createPluginCronContext([], logCalls),
    );

    expect(emailRunCalls).toEqual([{ now: "2026-06-21T10:00:00.000Z" }]);
    expect(purgeCalls).toEqual(["2026-06-21T10:00:00.000Z"]);
    expect(logCalls).toEqual([
      [
        "info",
        "Mika maintenance completed",
        expect.objectContaining({
          tasks: expect.objectContaining({
            emailOutbox: expect.objectContaining({ status: "completed", sent: 2 }),
            ephemeralRecords: expect.objectContaining({ status: "completed", purged: 4 }),
            accountDeleteRequests: expect.objectContaining({ status: "completed" }),
            stuckWorkflows: expect.objectContaining({ status: "completed" }),
            webhookRetries: expect.objectContaining({ status: "completed" }),
          }),
        }),
      ],
    ]);
  });

  it("logs Mika maintenance failures before surfacing stock cleanup errors", async () => {
    const logCalls: unknown[] = [];
    const plugin = createPlugin({
      assertWired: false,
      api: {
        admin: {
          releaseExpiredReservations: async () => ({
            ok: false,
            status: 500,
            error: { code: "PROVIDER_FAILED", message: "release failed" },
          }),
        },
      },
    });

    await expect(
      plugin.hooks.cron?.handler(
        { name: MIKA_MAINTENANCE_CRON_TASK, scheduledAt: "2026-06-21T10:00:00.000Z" },
        createPluginCronContext([], logCalls),
      ),
    ).rejects.toThrow("release failed");

    expect(logCalls).toEqual([
      [
        "warn",
        "Mika maintenance completed with failures",
        expect.objectContaining({
          now: "2026-06-21T10:00:00.000Z",
          tasks: expect.objectContaining({
            stockReservations: expect.objectContaining({
              status: "failed",
              error: "release failed",
            }),
          }),
        }),
      ],
    ]);
  });
});

describe("Mika Astro helpers", () => {
  it("scales money by the currency's own fraction digits, not a fixed /100", () => {
    const fmt = (amount: number, currency: string) =>
      formatMikaMoney(
        { amount, currency: createCurrencyCode(currency) },
        { locales: "en-US" },
      ).replace(/[  ]/g, " ");

    expect(fmt(1200, "USD")).toBe("$12.00");
    expect(fmt(1000, "JPY")).toBe("¥1,000");
    expect(fmt(1500, "BHD")).toBe("BHD 1.500");
  });

  it("preserves query strings in return targets", () => {
    expect(mikaReturnTo(new URL("https://shop.test/products/ring?size=5"))).toBe(
      "/products/ring?size=5",
    );
  });

  it("normalizes safe return targets and rejects open redirects", () => {
    const options = { origin: "https://shop.test/products/ring?size=5", fallback: "/fallback" };

    expect(mikaSafeReturnTo("/account/orders#latest", options)).toBe("/account/orders#latest");
    expect(mikaSafeReturnTo("https://shop.test/account/orders", options)).toBe("/account/orders");
    expect(mikaSafeReturnTo("https://evil.test/account", options)).toBe("/fallback");
    expect(mikaSafeReturnTo("//evil.test/account", options)).toBe("/fallback");
    expect(mikaSafeReturnTo("https://shop.test//evil.test/done", options)).toBe("/fallback");
    expect(mikaSafeReturnTo("https://shop.test//evil.test", options)).toBe("/fallback");
    expect(mikaSafeReturnTo("javascript:alert(1)", options)).toBe("/fallback");
    expect(mikaSafeReturnTo("data:text/html,hi", options)).toBe("/fallback");
    expect(mikaSafeReturnTo("account", options)).toBe("/fallback");
    expect(mikaSafeReturnTo("/account/../admin", options)).toBe("/fallback");
    expect(mikaSafeReturnTo("/account/%2e%2e/admin", options)).toBe("/fallback");
  });

  it("serializes nullish hidden input values as empty strings", () => {
    expect(mikaHiddenInput("sellableId", null)).toEqual({ name: "sellableId", value: "" });
    expect(mikaHiddenInput("priceId", undefined)).toEqual({ name: "priceId", value: "" });
    expect(mikaHiddenInput("quantity", 2)).toEqual({ name: "quantity", value: "2" });
  });

  it("rejects open redirects in returnTo hidden inputs", () => {
    expect(
      mikaReturnToInput("https://evil.test/account", {
        origin: "https://shop.test",
        fallback: "/account",
      }),
    ).toEqual({ name: "returnTo", value: "/account" });
    expect(
      mikaReturnToInput("https://shop.test/account/orders", {
        origin: "https://shop.test",
        fallback: "/account",
      }),
    ).toEqual({ name: "returnTo", value: "/account/orders" });
  });

  it("applies separate checkout redirect fallbacks", () => {
    const redirectInputs = mikaRedirectInputs(
      {
        successPath: "https://evil.test/thanks",
        cancelPath: "//evil.test/cancel",
        returnTo: "/cart",
      },
      {
        origin: "https://shop.test",
        successFallback: "/checkout/success",
        cancelFallback: "/checkout/cancel",
        returnToFallback: "/products",
      },
    );

    expect(redirectInputs.successPath).toEqual({
      name: "successPath",
      value: "/checkout/success",
    });
    expect(redirectInputs.cancelPath).toEqual({
      name: "cancelPath",
      value: "/checkout/cancel",
    });
    expect(redirectInputs.returnTo).toEqual({ name: "returnTo", value: "/cart" });
  });

  it("preserves checkout redirect fallbacks in the copied-template form shim", () => {
    const redirectInputs = mikaShimRedirectInputs({
      successPath: undefined,
      cancelPath: undefined,
      returnTo: undefined,
    });

    expect(redirectInputs.successPath).toEqual({
      name: "successPath",
      value: "/checkout/success",
    });
    expect(redirectInputs.cancelPath).toEqual({
      name: "cancelPath",
      value: "/checkout/cancel",
    });
    expect(redirectInputs.returnTo).toEqual({ name: "returnTo", value: "/" });
  });

  it("uses native plugin API overrides for direct Astro helpers by default", async () => {
    const api = {
      cart: {
        get: async () => ({
          ok: true,
          status: 200,
          data: { id: "cart_1" } as CartDTO,
        }),
      },
    } satisfies MikaApiOverrides;

    try {
      createPlugin({ api, assertWired: false });
      const Mika = createMika({
        request: new Request("https://shop.test/cart"),
        url: new URL("https://shop.test/cart"),
      });

      await expect(Mika.cart.get()).resolves.toMatchObject({
        ok: true,
        data: { id: "cart_1" },
      });
    } finally {
      createPlugin({ assertWired: false });
    }
  });

  it("lets explicit Astro helper API overrides win over native plugin defaults", async () => {
    const defaultApi = {
      cart: {
        get: async () => ({
          ok: true,
          status: 200,
          data: { id: "cart_default" } as CartDTO,
        }),
      },
    } satisfies MikaApiOverrides;
    const explicitApi = {
      cart: {
        get: async () => ({
          ok: true,
          status: 200,
          data: { id: "cart_explicit" } as CartDTO,
        }),
      },
    } satisfies MikaApiOverrides;

    try {
      createPlugin({ api: defaultApi, assertWired: false });
      const Mika = createMika(
        {
          request: new Request("https://shop.test/cart"),
          url: new URL("https://shop.test/cart"),
        },
        { api: explicitApi },
      );

      await expect(Mika.cart.get()).resolves.toMatchObject({
        ok: true,
        data: { id: "cart_explicit" },
      });
    } finally {
      createPlugin({ assertWired: false });
    }
  });

  it("clears native plugin API defaults when a plugin is created without overrides", async () => {
    const api = {
      cart: {
        get: async () => ({
          ok: true,
          status: 200,
          data: { id: "cart_default" } as CartDTO,
        }),
      },
    } satisfies MikaApiOverrides;

    createPlugin({ api, assertWired: false });
    createPlugin({ assertWired: false });

    const Mika = createMika({
      request: new Request("https://shop.test/cart"),
      url: new URL("https://shop.test/cart"),
    });

    await expect(Mika.cart.get()).resolves.toMatchObject({
      ok: false,
      status: 501,
      error: { code: "NOT_IMPLEMENTED" },
    });
  });

  it("falls back to Astro's current locale for direct catalog helper calls", async () => {
    let contentRef: unknown;
    const api = {
      catalog: {
        sellables: async (input) => {
          contentRef = input.contentRef;
          return {
            ok: true,
            status: 200,
            data: [],
          };
        },
      },
    } satisfies MikaApiOverrides;
    const Mika = createMika(
      {
        request: new Request("https://shop.test/de/products/ring"),
        url: new URL("https://shop.test/de/products/ring"),
        currentLocale: "de",
      },
      { api },
    );

    await Mika.catalog.sellables("products", "ring");
    expect(contentRef).toEqual({ collection: "products", id: "ring", locale: "de" });

    await Mika.catalog.sellables("products", "ring", { locale: "en" });
    expect(contentRef).toEqual({ collection: "products", id: "ring", locale: "en" });
  });

  it("passes direct Astro helper calls through operation policy", async () => {
    const observed: Array<{
      readonly operation: string;
      readonly sessionId?: string;
      readonly locale?: string;
      readonly input: unknown;
    }> = [];
    const api = {
      cart: {
        add: async (_ctx, input) => ({
          ok: true,
          status: 200,
          data: {
            id: "cart_1",
            items: [{ sellableId: input.sellableId }],
          } as unknown as CartDTO,
        }),
      },
    } satisfies MikaApiOverrides;
    const policy: MikaOperationPolicy = ({ descriptor, ctx, input }) => {
      observed.push({
        operation: descriptor.name,
        sessionId: ctx.sessionId,
        locale: ctx.locale,
        input,
      });
    };
    const Mika = createMika(
      {
        request: new Request("https://shop.test/cart"),
        url: new URL("https://shop.test/cart"),
        currentLocale: "en-IE",
        session: {
          sessionID: "session_direct_policy",
          get: async () => undefined,
          set: () => undefined,
        } as never,
      },
      { api, operationPolicy: policy },
    );

    await expect(
      Mika.cart.add({ sellableId: createMikaId("sellable_1"), quantity: 2 }),
    ).resolves.toMatchObject({
      ok: true,
      status: 200,
    });

    expect(observed).toEqual([
      {
        operation: "cart.add",
        sessionId: "session_direct_policy",
        locale: "en-IE",
        input: {
          sellableId: createMikaId("sellable_1"),
          quantity: 2,
        },
      },
    ]);
  });

  it("returns direct Astro helper policy rejections without calling the API", async () => {
    let called = false;
    const api = {
      cart: {
        add: async () => {
          called = true;
          return { ok: true, status: 200, data: { id: "cart_1" } as CartDTO };
        },
      },
    } satisfies MikaApiOverrides;
    const Mika = createMika(
      {
        request: new Request("https://shop.test/cart"),
        url: new URL("https://shop.test/cart"),
      },
      {
        api,
        operationPolicy: () =>
          ({
            ok: false,
            status: 403,
            error: {
              code: "FORBIDDEN",
              message: "Direct helper rejected.",
            },
          }) as const,
      },
    );

    await expect(
      Mika.cart.add({ sellableId: createMikaId("sellable_1"), quantity: 1 }),
    ).resolves.toEqual({
      ok: false,
      status: 403,
      error: {
        code: "FORBIDDEN",
        message: "Direct helper rejected.",
      },
    });
    expect(called).toBe(false);
  });

  it("normalizes Astro session IDs into request contexts", () => {
    const ctx = createMikaRequestContext({
      session: {
        sessionID: "session_1",
        get: async () => undefined,
        set: () => undefined,
      },
    });

    expect(ctx.sessionId).toBe("session_1");
  });

  it("marks out-of-stock purchase options as disabled", () => {
    const [option] = createMikaPurchaseOptions([
      {
        id: id("sellable_1"),
        contentRef: { collection: "products", id: "ring" },
        title: "Ring",
        active: true,
        variantOptions: [],
        availability: {
          sellableId: id("sellable_1"),
          status: "out_of_stock",
        },
        prices: [
          {
            id: id("price_1"),
            sellableId: id("sellable_1"),
            amount: 2500,
            currency: currency("EUR"),
            mode: "payment",
            fulfillmentKind: "none",
            active: true,
          },
        ],
      },
    ]);

    expect(option?.disabled).toBe(true);
    expect(option?.fields).toEqual({
      sellableId: "sellable_1",
      priceId: "price_1",
      purchase: "sellableId=sellable_1&priceId=price_1",
    });
    expect(isMikaPurchasable(option?.sellable.availability)).toBe(false);
  });

  it("builds a purchase model for variant and price controls", () => {
    const model = createMikaPurchaseModel([
      {
        id: id("sellable_1"),
        contentRef: { collection: "products", id: "ring" },
        title: "Ring",
        active: true,
        variantOptions: [{ option: "finish", value: "silver", label: "Silver" }],
        variantGroups: [
          {
            option: "finish",
            label: "Finish",
            values: [{ option: "finish", value: "silver", label: "Silver" }],
          },
        ],
        availability: {
          sellableId: id("sellable_1"),
          status: "available",
          availableQuantity: 3,
        },
        prices: [
          {
            id: id("price_1"),
            sellableId: id("sellable_1"),
            amount: 2500,
            currency: currency("EUR"),
            mode: "payment",
            fulfillmentKind: "none",
            active: true,
          },
        ],
      },
      {
        id: id("sellable_2"),
        contentRef: { collection: "products", id: "ring" },
        title: "Ring",
        active: true,
        variantOptions: [{ option: "finish", value: "gold", label: "Gold" }],
        variantGroups: [
          {
            option: "finish",
            label: "Finish",
            values: [{ option: "finish", value: "gold", label: "Gold" }],
          },
        ],
        availability: {
          sellableId: id("sellable_2"),
          status: "out_of_stock",
        },
        prices: [
          {
            id: id("price_2"),
            sellableId: id("sellable_2"),
            amount: 3500,
            currency: currency("EUR"),
            mode: "payment",
            fulfillmentKind: "none",
            active: true,
          },
        ],
      },
    ]);

    expect(model).toMatchObject({
      selectedOptionIndex: 0,
      selectedSellable: { id: "sellable_1" },
      selectedPrice: { id: "price_1" },
      maxQuantity: 3,
      unavailable: false,
      useGroupedVariantControls: true,
      variantOptionMap: [
        {
          id: "sellable_1",
          priceId: "price_1",
          disabled: false,
          options: { finish: "silver" },
        },
        {
          id: "sellable_2",
          priceId: "price_2",
          disabled: true,
          options: { finish: "gold" },
        },
      ],
    });
  });

  it("derives purchase quantity caps from availability", () => {
    expect(
      mikaMaxPurchaseQuantity({
        sellableId: id("sellable_1"),
        status: "low_stock",
        availableQuantity: 2,
        maxPerOrder: 5,
      }),
    ).toBe(2);
    expect(
      mikaMaxPurchaseQuantity({
        sellableId: id("sellable_1"),
        status: "untracked",
        maxPerOrder: 3,
      }),
    ).toBe(3);
  });
});

describe("Mika client", () => {
  it("normalizes transport failures into Mika API results", async () => {
    const client = createMikaClient({
      baseUrl: "https://shop.test",
      fetch: async () => {
        throw new Error("network unavailable");
      },
    });

    await expect(client.catalog.sellables("products", "ring")).resolves.toMatchObject({
      ok: false,
      status: 0,
      error: {
        code: "PROVIDER_FAILED",
      },
    });
  });

  it("normalizes invalid request URL construction into Mika API results", async () => {
    await expect(
      requestMika("catalogSellables", undefined, {
        baseUrl: "shop.test",
        fetch: async () => Response.json({ ok: true, status: 200, data: [] }),
      }),
    ).resolves.toMatchObject({
      ok: false,
      status: 0,
      error: {
        code: "PROVIDER_FAILED",
        message: "Mika request URL is invalid.",
      },
    });
  });

  it("rejects malformed success envelopes from JSON routes", async () => {
    await expect(
      requestMika("catalogSellables", undefined, {
        baseUrl: "https://shop.test",
        fetch: async () => Response.json({ ok: true, status: 200 }),
      }),
    ).resolves.toMatchObject({
      ok: false,
      status: 200,
      error: {
        code: "PROVIDER_FAILED",
        message: "Malformed Mika response.",
      },
    });
  });

  it("normalizes nested EmDash Mika result envelopes", async () => {
    await expect(
      requestMika<{ readonly value: number }>("catalogSellables", undefined, {
        baseUrl: "https://shop.test",
        fetch: async () =>
          Response.json({
            data: {
              ok: true,
              status: 200,
              data: { value: 1 },
            },
          }),
      }),
    ).resolves.toEqual({
      ok: true,
      status: 200,
      data: { value: 1 },
    });
  });

  it("keeps only valid client effects from JSON route envelopes", async () => {
    await expect(
      requestMika<{ readonly value: number }>("catalogSellables", undefined, {
        baseUrl: "https://shop.test",
        fetch: async () =>
          Response.json({
            ok: true,
            status: 200,
            data: { value: 1 },
            effects: [
              { type: "reload" },
              { type: "redirect", url: "/cart" },
              { type: "toast", tone: "success", message: "Saved." },
            ],
          }),
      }),
    ).resolves.toMatchObject({
      ok: true,
      effects: [
        { type: "reload" },
        { type: "redirect", url: "/cart" },
        { type: "toast", tone: "success", message: "Saved." },
      ],
    });

    await expect(
      requestMika<{ readonly value: number }>("catalogSellables", undefined, {
        baseUrl: "https://shop.test",
        fetch: async () =>
          Response.json({
            ok: true,
            status: 200,
            data: { value: 1 },
            effects: [{ type: "toast", tone: "info", message: "Ignored." }],
          }),
      }),
    ).resolves.toEqual({
      ok: true,
      status: 200,
      data: { value: 1 },
    });
  });

  it("preserves normalized error envelope details", async () => {
    await expect(
      requestMika("catalogSellables", undefined, {
        baseUrl: "https://shop.test",
        fetch: async () =>
          Response.json(
            {
              error: {
                code: "VALIDATION_FAILED",
                message: "Invalid input.",
                fieldErrors: { email: "Invalid email.", ignored: 123 },
                retryAfter: 30,
                correlationId: "corr_1",
              },
            },
            { status: 422 },
          ),
      }),
    ).resolves.toEqual({
      ok: false,
      status: 422,
      error: {
        code: "VALIDATION_FAILED",
        message: "Invalid input.",
        fieldErrors: { email: "Invalid email." },
        retryAfter: 30,
        correlationId: "corr_1",
      },
    });
  });

  it("keeps private flows off the storefront JSON client", () => {
    const client = createMikaClient();

    expect("admin" in client).toBe(false);
    expect("webhook" in client).toBe(false);
    expect("cart" in client).toBe(false);
    expect("checkout" in client).toBe(false);
    expect("account" in client).toBe(false);
    expectTypeOf<keyof MikaClient>().toEqualTypeOf<"routes" | "catalog" | "stock">();
    expectTypeOf<Parameters<MikaClient["routes"]>[0]>().toEqualTypeOf<
      (typeof publicMikaPluginRouteNames)[number]
    >();
  });

  it("keeps admin and webhook on the trusted server JSON client", () => {
    const client = createMikaServerClient();

    expect("admin" in client).toBe(true);
    expect("webhook" in client).toBe(true);
    expectTypeOf<keyof MikaServerClient>().toEqualTypeOf<
      | keyof MikaClient
      | "cart"
      | "wishlist"
      | "checkout"
      | "magicLink"
      | "account"
      | "subscription"
      | "download"
      | "order"
      | "webhook"
      | "admin"
    >();
    expectTypeOf<Parameters<MikaServerClient["routes"]>[0]>().toEqualTypeOf<MikaPluginRouteName>();
  });

  it("derives server JSON request origins from the incoming request", async () => {
    let requestedUrl = "";
    let forwardedCookie: string | null = null;
    const request = new Request("https://shop.test/cart", {
      headers: { cookie: "mika_session=abc" },
    });
    const client = createMikaServerClient({
      request,
      fetch: async (url, init) => {
        requestedUrl =
          typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;
        forwardedCookie = new Headers(init?.headers).get("cookie");
        return Response.json({
          ok: true,
          status: 200,
          data: { id: "cart_1" },
        });
      },
    });

    await client.cart.get();

    expect(requestedUrl).toBe("https://shop.test/_emdash/api/plugins/mika/cart");
    expect(forwardedCookie).toBe("mika_session=abc");
    expect(client.routes("cart")).toBe("https://shop.test/_emdash/api/plugins/mika/cart");
  });

  it("binds route helpers to client defaults", () => {
    const client = createMikaClient({
      baseUrl: "https://shop.test",
      apiBase: "/commerce",
      pluginId: "custom-mika",
    });

    expect(
      client.routes("catalogSellables", {
        search: { collection: "products", id: "ring" },
      }),
    ).toBe("https://shop.test/commerce/custom-mika/catalog/sellables?collection=products&id=ring");
  });

  it("honors route builder default search parameters", () => {
    const routes = createMikaPluginRouteBuilder({
      origin: "https://shop.test",
      apiBase: "/commerce",
      search: { collection: "products", id: "ring" },
    });

    expect(routes("catalogSellables")).toBe(
      "https://shop.test/commerce/mika/catalog/sellables?collection=products&id=ring",
    );
    expect(
      routes("catalogSellables", {
        search: { collection: "products", id: "hat" },
      }),
    ).toBe("https://shop.test/commerce/mika/catalog/sellables?collection=products&id=hat");
  });

  it("generates routes for the expanded contract surface", () => {
    expect(mikaPluginRoute("cartCoupon")).toBe("/_emdash/api/plugins/mika/cart/coupon");
    expect(mikaPluginRoute("cartQuote")).toBe("/_emdash/api/plugins/mika/cart/quote");
    expect(mikaPluginRoute("wishlistMoveToCart")).toBe(
      "/_emdash/api/plugins/mika/wishlist/move-to-cart",
    );
    expect(mikaPluginRoute("checkoutPreview")).toBe("/_emdash/api/plugins/mika/checkout/preview");
    expect(mikaPluginRoute("adminProviderHealth")).toBe(
      "/_emdash/api/plugins/mika/admin/provider/health",
    );
    expect(mikaPluginRoute("actionsRunner")).toBe(
      "/_emdash/api/plugins/mika/.well-known/actions/run",
    );
    expect("checkoutSuccess" in mikaPluginRoutes).toBe(false);
    expect("checkoutCancel" in mikaPluginRoutes).toBe(false);
  });

  it("derives route, API method, and action contracts from operation metadata", () => {
    expect(mikaPluginRoutes).toEqual({
      actionsManifest: ".well-known/actions",
      actionsRunner: ".well-known/actions/run",
      catalogSellables: "catalog/sellables",
      sellableAvailability: "sellables/availability",
      cart: "cart",
      cartQuote: "cart/quote",
      cartItems: "cart/items",
      cartItem: "cart/item",
      cartMerge: "cart/merge",
      cartCoupon: "cart/coupon",
      wishlist: "wishlist",
      wishlistItems: "wishlist/items",
      wishlistItem: "wishlist/item",
      wishlistMoveToCart: "wishlist/move-to-cart",
      wishlistSaveForLater: "wishlist/save-for-later",
      wishlistMerge: "wishlist/merge",
      checkout: "checkout",
      checkoutPreview: "checkout/preview",
      checkoutStatus: "checkout/status",
      checkoutAbandon: "checkout/abandon",
      magicLink: "magic-link",
      magicLinkVerify: "magic-link/verify",
      account: "account",
      accountExport: "account/export",
      accountExportStatus: "account/export/status",
      accountExportDownload: "account/export/download",
      accountDelete: "account/delete",
      accountPortal: "account/portal",
      subscriptionCancel: "subscriptions/cancel",
      subscriptionChange: "subscriptions/change",
      subscriptionRenew: "subscriptions/renew",
      download: "download",
      downloadConfirm: "download/confirm",
      orderInvoice: "orders/invoice",
      webhook: "webhooks",
      adminProviderHealth: "admin/provider/health",
      adminProviderSync: "admin/provider/sync",
      adminStockAdjust: "admin/stock/adjust",
      adminStockReleaseExpiredReservations: "admin/stock/release-expired-reservations",
      adminWebhookReplay: "admin/webhooks/replay",
      adminOrderRefund: "admin/orders/refund",
      adminOrderCancel: "admin/orders/cancel",
      adminEntitlementGrant: "admin/entitlements/grant",
      adminEntitlementRevoke: "admin/entitlements/revoke",
      adminEmailResend: "admin/emails/resend",
      adminLicenseRevoke: "admin/licenses/revoke",
      adminDownloadIssue: "admin/downloads/issue",
    });
    expect(publicMikaPluginRouteNames).toEqual(["catalogSellables", "sellableAvailability"]);
    expect(mikaApiMethodNames).toEqual({
      catalog: ["sellables"],
      stock: ["availability"],
      cart: ["get", "quote", "add", "update", "remove", "merge", "applyCoupon", "removeCoupon"],
      wishlist: ["get", "add", "remove", "moveToCart", "saveForLater", "merge"],
      checkout: ["start", "preview", "status", "cancel"],
      magicLink: ["request", "verify"],
      account: ["get", "export", "exportStatus", "exportDownload", "delete", "portal"],
      subscription: ["cancel", "change", "renew"],
      download: ["resolve", "confirm"],
      order: ["invoice"],
      webhook: ["receive"],
      admin: [
        "providerHealth",
        "providerSync",
        "stockAdjust",
        "releaseExpiredReservations",
        "webhookReplay",
        "orderRefund",
        "orderCancel",
        "entitlementGrant",
        "entitlementRevoke",
        "emailResend",
        "licenseRevoke",
        "downloadIssue",
      ],
    });
    expect(Object.values(mikaActionDefinitions).map((definition) => definition.name)).toEqual([
      "catalog.sellables",
      "stock.availability",
      "cart.add",
      "cart.update",
      "cart.remove",
      "cart.merge",
      "cart.applyCoupon",
      "cart.removeCoupon",
      "wishlist.add",
      "wishlist.remove",
      "wishlist.moveToCart",
      "wishlist.saveForLater",
      "wishlist.merge",
      "checkout.start",
      "checkout.status",
      "magicLink.request",
      "magicLink.verify",
      "account.export",
      "account.exportStatus",
      "account.delete",
      "account.portal",
      "subscription.cancel",
      "subscription.change",
      "subscription.renew",
      "download.confirm",
    ]);
  });

  it("pins every operation route, transport, and action exposure", () => {
    expect(
      Object.entries(mikaOperationDefinitions).map(([key, operation]) =>
        [
          key,
          operation.name,
          `${operation.namespace}.${operation.method}`,
          operation.routeKey,
          operation.httpMethod,
          operation.transport,
          operation.public ? "public" : "trusted",
          operation.requiresRequestContext ? "ctx" : "noctx",
          "searchKeys" in operation ? (operation.searchKeys?.join(",") ?? "") : "",
          "action" in operation ? (operation.action?.accept ?? "") : "",
        ].join("|"),
      ),
    ).toEqual([
      "catalogSellables|catalog.sellables|catalog.sellables|catalogSellables|GET|search|public|noctx|collection,id,locale|json",
      "stockAvailability|stock.availability|stock.availability|sellableAvailability|GET|search|public|noctx|sellableId|json",
      "cartGet|cart.get|cart.get|cart|GET|none|trusted|ctx||",
      "cartQuote|cart.quote|cart.quote|cartQuote|POST|body|trusted|ctx||",
      "cartAdd|cart.add|cart.add|cartItems|POST|body|trusted|ctx||form",
      "cartUpdate|cart.update|cart.update|cartItem|PATCH|body|trusted|ctx||form",
      "cartRemove|cart.remove|cart.remove|cartItem|DELETE|body|trusted|ctx||form",
      "cartMerge|cart.merge|cart.merge|cartMerge|POST|body|trusted|ctx||form",
      "cartApplyCoupon|cart.applyCoupon|cart.applyCoupon|cartCoupon|POST|body|trusted|ctx||form",
      "cartRemoveCoupon|cart.removeCoupon|cart.removeCoupon|cartCoupon|DELETE|body|trusted|ctx||form",
      "wishlistGet|wishlist.get|wishlist.get|wishlist|GET|none|trusted|ctx||",
      "wishlistAdd|wishlist.add|wishlist.add|wishlistItems|POST|body|trusted|ctx||form",
      "wishlistRemove|wishlist.remove|wishlist.remove|wishlistItem|DELETE|body|trusted|ctx||form",
      "wishlistMoveToCart|wishlist.moveToCart|wishlist.moveToCart|wishlistMoveToCart|POST|body|trusted|ctx||form",
      "wishlistSaveForLater|wishlist.saveForLater|wishlist.saveForLater|wishlistSaveForLater|POST|body|trusted|ctx||form",
      "wishlistMerge|wishlist.merge|wishlist.merge|wishlistMerge|POST|body|trusted|ctx||form",
      "checkoutStart|checkout.start|checkout.start|checkout|POST|body|trusted|ctx||form",
      "checkoutPreview|checkout.preview|checkout.preview|checkoutPreview|POST|body|trusted|ctx||",
      "checkoutStatus|checkout.status|checkout.status|checkoutStatus|GET|search|trusted|ctx|checkoutId,token|json",
      "checkoutCancel|checkout.cancel|checkout.cancel|checkoutAbandon|POST|body|trusted|ctx||",
      "magicLinkRequest|magicLink.request|magicLink.request|magicLink|POST|body|trusted|ctx||form",
      "magicLinkVerify|magicLink.verify|magicLink.verify|magicLinkVerify|POST|body|trusted|ctx||form",
      "accountGet|account.get|account.get|account|GET|none|trusted|ctx||",
      "accountExport|account.export|account.export|accountExport|POST|body|trusted|ctx||form",
      "accountExportStatus|account.exportStatus|account.exportStatus|accountExportStatus|GET|search|trusted|ctx|exportId|json",
      "accountExportDownload|account.exportDownload|account.exportDownload|accountExportDownload|GET|search|trusted|ctx|exportId,token|",
      "accountExportDownloadConsume|account.exportDownloadConsume|account.exportDownloadConsume|accountExportDownload|POST|body|trusted|ctx||",
      "accountDelete|account.delete|account.delete|accountDelete|POST|body|trusted|ctx||form",
      "accountPortal|account.portal|account.portal|accountPortal|POST|body|trusted|ctx||form",
      "subscriptionCancel|subscription.cancel|subscription.cancel|subscriptionCancel|POST|body|trusted|ctx||form",
      "subscriptionChange|subscription.change|subscription.change|subscriptionChange|POST|body|trusted|ctx||form",
      "subscriptionRenew|subscription.renew|subscription.renew|subscriptionRenew|POST|body|trusted|ctx||form",
      "downloadResolve|download.resolve|download.resolve|download|GET|search|trusted|noctx|token|",
      "downloadConfirm|download.confirm|download.confirm|downloadConfirm|POST|body|trusted|noctx||form",
      "orderInvoice|order.invoice|order.invoice|orderInvoice|GET|search|trusted|ctx|orderId,token,returnTo|",
      "webhookReceive|webhook.receive|webhook.receive|webhook|POST|body|trusted|ctx||",
      "adminProviderHealth|admin.providerHealth|admin.providerHealth|adminProviderHealth|POST|body|trusted|noctx||",
      "adminProviderSync|admin.providerSync|admin.providerSync|adminProviderSync|POST|body|trusted|noctx||",
      "adminStockAdjust|admin.stockAdjust|admin.stockAdjust|adminStockAdjust|POST|body|trusted|noctx||",
      "adminStockReleaseExpiredReservations|admin.releaseExpiredReservations|admin.releaseExpiredReservations|adminStockReleaseExpiredReservations|POST|body|trusted|noctx||",
      "adminWebhookReplay|admin.webhookReplay|admin.webhookReplay|adminWebhookReplay|POST|body|trusted|noctx||",
      "adminOrderRefund|admin.orderRefund|admin.orderRefund|adminOrderRefund|POST|body|trusted|noctx||",
      "adminOrderCancel|admin.orderCancel|admin.orderCancel|adminOrderCancel|POST|body|trusted|noctx||",
      "adminEntitlementGrant|admin.entitlementGrant|admin.entitlementGrant|adminEntitlementGrant|POST|body|trusted|noctx||",
      "adminEntitlementRevoke|admin.entitlementRevoke|admin.entitlementRevoke|adminEntitlementRevoke|POST|body|trusted|noctx||",
      "adminEmailResend|admin.emailResend|admin.emailResend|adminEmailResend|POST|body|trusted|noctx||",
      "adminLicenseRevoke|admin.licenseRevoke|admin.licenseRevoke|adminLicenseRevoke|POST|body|trusted|noctx||",
      "adminDownloadIssue|admin.downloadIssue|admin.downloadIssue|adminDownloadIssue|POST|body|trusted|noctx||",
    ]);
  });

  it("projects operation, action, and facade keys from one expected contract table", () => {
    expect(Object.keys(mikaOperationDefinitions)).toEqual(
      expectedOperationContracts.map(([operationKey]) => operationKey),
    );

    for (const [operationKey, namespace, method, actionKey] of expectedOperationContracts) {
      const operation = mikaOperationDefinitions[operationKey];

      expect(operation.namespace).toBe(namespace);
      expect(operation.method).toBe(method);
      if (operationKey !== "accountExportDownloadConsume") {
        expect(
          (mikaOperationFacadeSpec as Record<string, Record<string, string>>)[namespace]?.[method],
        ).toBe(operationKey);
      }

      if (actionKey) {
        expect(mikaActionDefinitions[actionKey].operation).toBe(operation);
      } else {
        expect(
          Object.values(mikaActionDefinitions).some(
            (definition) => definition.operation === operation,
          ),
        ).toBe(false);
      }
    }
  });

  it("keeps operation descriptor namespace and method identities unique", () => {
    const identities = Object.values(mikaOperationDescriptors).map(
      (descriptor) => `${descriptor.namespace}.${descriptor.method}`,
    );

    expect(new Set(identities).size).toBe(identities.length);
  });

  it("dispatches account export download GET and POST through distinct operation identities", async () => {
    const inputs: unknown[] = [];
    const routes = createMikaPluginRoutes(
      createMikaApi({
        account: {
          exportDownload: async (_ctx, input) => {
            inputs.push(input);

            return {
              ok: true,
              status: 200,
              data: { id: id("account_export_1"), href: "https://shop.test/export.json" },
            } as MikaApiResult<AccountExportDownloadDTO>;
          },
        },
      } satisfies MikaApiOverrides),
    );
    const path = "https://shop.test/_emdash/api/plugins/mika/account/export/download";

    await routes[mikaPluginRoutes.accountExportDownload].handler({
      input: undefined,
      request: new Request(`${path}?exportId=account_export_1&token=export_token_1`, {
        method: "GET",
      }),
    });
    await routes[mikaPluginRoutes.accountExportDownload].handler({
      input: { exportId: id("account_export_1"), token: "export_token_1" },
      request: new Request(path, { method: "POST" }),
    });

    expect(inputs).toEqual([
      { exportId: "account_export_1", token: "export_token_1" },
      { exportId: "account_export_1", token: "export_token_1", consumeToken: true },
    ]);
  });

  it("keeps operation policy classes aligned with public and agent projections", () => {
    const operations = Object.values(mikaOperationDefinitions);
    const publicOperations = operations.filter((operation) => operation.public);
    const defaultManifestNames = new Set<string>(
      createMikaAgentManifest().operations.map((operation) => operation.name),
    );
    const actionOperationNames = new Set<string>(
      Object.values(mikaActionDefinitions).map((definition) => definition.operation.name),
    );

    expect(publicOperations.map((operation) => operation.name)).toEqual([
      "catalog.sellables",
      "stock.availability",
    ]);
    for (const operation of publicOperations) {
      expect(operation.httpMethod).toBe("GET");
      expect(operation.transport).toBe("search");
      expect(operation.requiresRequestContext).toBe(false);
      expect(operation.agent).toMatchObject({
        visible: "public",
        effect: "read",
        risk: "none",
        requiresActor: "none",
        confirmation: "none",
        idempotency: "not_needed",
      });
      expect(defaultManifestNames.has(operation.name)).toBe(true);
      expect(actionOperationNames.has(operation.name)).toBe(true);
    }

    for (const operation of operations) {
      if (operation.agent.visible === "hidden" || operation.agent.visible === "admin") {
        expect(defaultManifestNames.has(operation.name)).toBe(false);
        expect(actionOperationNames.has(operation.name)).toBe(false);
      }

      const isTrustedOrAdmin =
        operation.agent.visible === "trusted" || operation.agent.visible === "admin";
      const mutatesServerState =
        operation.agent.effect !== "read" && operation.agent.effect !== "download_resolution";
      if (isTrustedOrAdmin && mutatesServerState) {
        expect(operation.agent.idempotency).not.toBe("not_needed");
        expect(operation.agent.idempotencyKey).toMatchObject({
          keyHeader: MIKA_AGENT_IDEMPOTENCY_KEY_HEADER,
          owner: "host",
          replay: "same_key_same_input",
        });
      }
    }
  });

  it("exposes stable operation descriptors without internal schema or call hooks", () => {
    const checkout = mikaOperationDescriptors.checkoutStart;

    expect(checkout).toMatchObject({
      name: "checkout.start",
      namespace: "checkout",
      method: "start",
      public: false,
      requiresRequestContext: true,
      action: {
        key: "checkoutStart",
        name: "checkout.start",
        accept: "form",
      },
      route: {
        key: "checkout",
        path: "checkout",
        httpMethod: "POST",
        transport: "body",
      },
      agent: {
        capability: "checkout:start",
        idempotency: "required",
      },
    });
    expect("schema" in checkout).toBe(false);
    expect("call" in checkout).toBe(false);
    expect(Object.isFrozen(checkout)).toBe(true);
    expect(Object.isFrozen(checkout.agent.resources)).toBe(true);
    expect(mikaOperationDescriptors.checkoutStatus.route.searchKeys).toEqual([
      "checkoutId",
      "token",
    ]);
    expect(Object.isFrozen(mikaOperationDescriptors.checkoutStatus.route.searchKeys)).toBe(true);
    expect(Object.keys(mikaOperationDescriptors).sort()).toEqual(
      Object.keys(mikaOperationDefinitions).sort(),
    );
  });

  it("passes stable operation descriptors to operation policy hooks", async () => {
    const observed: unknown[] = [];
    const policy: MikaOperationPolicy = ({ descriptor }) => {
      observed.push({
        descriptor,
        operationName: descriptor.name,
        descriptorHasCall: "call" in descriptor,
        descriptorHasSchema: "schema" in descriptor,
      });
    };
    const routes = createMikaPluginRoutes(
      createMikaApi({
        cart: {
          add: async () => ({
            ok: true,
            status: 200,
            data: { id: id("cart_1") } as CartDTO,
          }),
        },
      } satisfies MikaApiOverrides),
      { operationPolicy: policy },
    );

    await routes[mikaPluginRoutes.cartItems].handler({
      input: { sellableId: "sellable_1", quantity: 1 },
      request: new Request("https://shop.test/_emdash/api/plugins/mika/cart/items", {
        method: "POST",
      }),
    });

    expect(observed).toEqual([
      {
        descriptor: expect.objectContaining({
          name: "cart.add",
          route: {
            key: "cartItems",
            path: "cart/items",
            httpMethod: "POST",
            transport: "body",
          },
        }),
        operationName: "cart.add",
        descriptorHasCall: false,
        descriptorHasSchema: false,
      },
    ]);
  });

  it("forwards the Idempotency-Key header into direct admin route input", async () => {
    const received: unknown[] = [];
    const routes = createMikaPluginRoutes(
      createMikaApi({
        admin: {
          stockAdjust: async (adjustment) => {
            received.push(adjustment);

            return {
              ok: true,
              status: 200,
              data: {
                id: id("stock_event_1"),
                status: "completed",
                affected: { stockItems: 1, movements: 1 },
              },
            };
          },
        },
      } satisfies MikaApiOverrides),
    );

    const adjustInput = { stockItemId: "stock_item_1", quantityDelta: 4 };
    const adjustUrl = "https://shop.test/_emdash/api/plugins/mika/admin/stock/adjust";

    await routes[mikaPluginRoutes.adminStockAdjust].handler({
      input: adjustInput,
      request: new Request(adjustUrl, {
        method: "POST",
        headers: { [MIKA_AGENT_IDEMPOTENCY_KEY_HEADER]: "adjust_header_key" },
      }),
    });
    await routes[mikaPluginRoutes.adminStockAdjust].handler({
      input: { ...adjustInput, idempotencyKey: "" },
      request: new Request(adjustUrl, {
        method: "POST",
        headers: { [MIKA_AGENT_IDEMPOTENCY_KEY_HEADER]: "adjust_header_empty_body_key" },
      }),
    });

    const rejected = await routes[mikaPluginRoutes.adminStockAdjust].handler({
      input: adjustInput,
      request: new Request(adjustUrl, { method: "POST" }),
    });

    expect(received).toEqual([
      expect.objectContaining({ idempotencyKey: "adjust_header_key" }),
      expect.objectContaining({ idempotencyKey: "adjust_header_empty_body_key" }),
    ]);
    expect(rejected).toMatchObject({
      ok: false,
      status: 409,
      error: {
        code: "CONFLICT",
        message: "Mika operation 'admin.stockAdjust' requires an idempotency key.",
      },
    });
  });

  it("wires Astro action request context to the Idempotency-Key header", () => {
    const source = readFileSync(new URL("../src/astro-actions.ts", import.meta.url), "utf8");

    expect(source).toContain("MIKA_AGENT_IDEMPOTENCY_KEY_HEADER");
    expect(source).toContain("idempotencyKey: actionIdempotencyKey(ctx.request)");
    expect(source).toContain("request.headers.get(MIKA_AGENT_IDEMPOTENCY_KEY_HEADER)");
    expect(source).toContain("mikaOperationInputWithIdempotencyContext");
  });

  it("pins action descriptors to their operation metadata", () => {
    expect(
      Object.entries(mikaActionDefinitions).map(([key, definition]) =>
        [
          key,
          definition.name,
          definition.accept,
          definition.operation.name,
          definition.operation.routeKey,
          definition.operation.transport,
        ].join("|"),
      ),
    ).toEqual([
      "catalogSellables|catalog.sellables|json|catalog.sellables|catalogSellables|search",
      "stockAvailability|stock.availability|json|stock.availability|sellableAvailability|search",
      "cartAdd|cart.add|form|cart.add|cartItems|body",
      "cartUpdate|cart.update|form|cart.update|cartItem|body",
      "cartRemove|cart.remove|form|cart.remove|cartItem|body",
      "cartMerge|cart.merge|form|cart.merge|cartMerge|body",
      "cartApplyCoupon|cart.applyCoupon|form|cart.applyCoupon|cartCoupon|body",
      "cartRemoveCoupon|cart.removeCoupon|form|cart.removeCoupon|cartCoupon|body",
      "wishlistAdd|wishlist.add|form|wishlist.add|wishlistItems|body",
      "wishlistRemove|wishlist.remove|form|wishlist.remove|wishlistItem|body",
      "wishlistMoveToCart|wishlist.moveToCart|form|wishlist.moveToCart|wishlistMoveToCart|body",
      "wishlistSaveForLater|wishlist.saveForLater|form|wishlist.saveForLater|wishlistSaveForLater|body",
      "wishlistMerge|wishlist.merge|form|wishlist.merge|wishlistMerge|body",
      "checkoutStart|checkout.start|form|checkout.start|checkout|body",
      "checkoutStatus|checkout.status|json|checkout.status|checkoutStatus|search",
      "magicLinkRequest|magicLink.request|form|magicLink.request|magicLink|body",
      "magicLinkVerify|magicLink.verify|form|magicLink.verify|magicLinkVerify|body",
      "accountExport|account.export|form|account.export|accountExport|body",
      "accountExportStatus|account.exportStatus|json|account.exportStatus|accountExportStatus|search",
      "accountDelete|account.delete|form|account.delete|accountDelete|body",
      "accountPortal|account.portal|form|account.portal|accountPortal|body",
      "subscriptionCancel|subscription.cancel|form|subscription.cancel|subscriptionCancel|body",
      "subscriptionChange|subscription.change|form|subscription.change|subscriptionChange|body",
      "subscriptionRenew|subscription.renew|form|subscription.renew|subscriptionRenew|body",
      "downloadConfirm|download.confirm|form|download.confirm|downloadConfirm|body",
    ]);
  });

  it("keeps form action normalizers in operation metadata", () => {
    const cartInput = mikaActionDefinitions.cartAdd.schema.parse({
      purchase: "sellableId=sellable_1&priceId=price_1",
      quantity: "2",
      returnTo: "/products/ring",
    });
    const checkoutInput = mikaActionDefinitions.checkoutStart.schema.parse({
      sellableId: "sellable_1",
      email: "customer@example.test",
      name: "Customer Test",
      quantity: "1",
    });

    expect(mikaActionDefinitions.cartAdd.normalize?.(cartInput)).toEqual({
      sellableId: id("sellable_1"),
      priceId: id("price_1"),
      variantKey: undefined,
      variantOptions: undefined,
      quantity: 2,
      returnTo: "/products/ring",
    });
    expect(mikaActionDefinitions.checkoutStart.normalize?.(checkoutInput)).toEqual({
      cartId: undefined,
      sellableId: id("sellable_1"),
      priceId: undefined,
      quantity: 1,
      provider: undefined,
      couponCode: undefined,
      customer: {
        email: "customer@example.test",
        name: "Customer Test",
        company: undefined,
        vatId: undefined,
      },
      customFields: undefined,
      successPath: undefined,
      cancelPath: undefined,
      returnTo: undefined,
    });
  });

  it("keeps update quantities strict and preserves explicit coupon clears", () => {
    expect(updateCartItemInputSchema.safeParse({ lineId: "cart_line_1" }).success).toBe(false);
    expect(
      updateCartItemInputSchema.safeParse({ lineId: "cart_line_1", quantity: "" }).success,
    ).toBe(false);
    expect(updateCartItemInputSchema.parse({ lineId: "cart_line_1", quantity: "2" })).toEqual({
      lineId: id("cart_line_1"),
      quantity: 2,
    });
    expect(cartQuoteInputSchema.parse({ cartId: "cart_1", couponCode: "" })).toMatchObject({
      cartId: id("cart_1"),
      couponCode: "",
    });
    expect(startCheckoutInputSchema.parse({ cartId: "cart_1", couponCode: "" })).toMatchObject({
      cartId: id("cart_1"),
      couponCode: "",
    });
  });

  it("covers every routed operation with handler and validation metadata", () => {
    const routes = createMikaPluginRoutes();
    const expectedRoutePaths = [
      ...Object.values(mikaRouteOnlyDefinitions).map((route) => route.routePath),
      ...new Set(mikaRoutedOperationDefinitions.map((operation) => operation.routePath)),
    ].sort();

    expect(Object.keys(routes).sort()).toEqual(expectedRoutePaths);

    for (const route of Object.values(mikaRouteOnlyDefinitions)) {
      expect(routes[route.routePath as keyof typeof routes]).toBeDefined();
      expect(typeof route.public).toBe("boolean");
    }

    for (const operation of Object.values(mikaOperationDefinitions)) {
      expect(routes[operation.routePath as keyof typeof routes]).toBeDefined();
      expect(typeof operation.public).toBe("boolean");
      expect(["GET", "POST", "PATCH", "DELETE"]).toContain(operation.httpMethod);
      expect(["body", "search", "none"]).toContain(operation.transport);
      expect(MIKA_AGENT_VISIBILITIES).toContain(operation.agent.visible);
      expect(MIKA_AGENT_CAPABILITIES).toContain(operation.agent.capability);
      expect(MIKA_AGENT_EFFECTS).toContain(operation.agent.effect);
      expect(MIKA_AGENT_RISKS).toContain(operation.agent.risk);
      expect(MIKA_AGENT_ACTOR_REQUIREMENTS).toContain(operation.agent.requiresActor);
      expect(MIKA_AGENT_CONFIRMATION_POLICIES).toContain(operation.agent.confirmation);
      expect(MIKA_AGENT_IDEMPOTENCY_POLICIES).toContain(operation.agent.idempotency);
      expect(operation.agent.scopes.length).toBeGreaterThan(0);
      for (const scope of operation.agent.scopes) {
        expect(typeof scope).toBe("string");
        expect(scope.length).toBeGreaterThan(0);
      }
      expect(operation.agent.resources.length).toBeGreaterThan(0);
      for (const resource of operation.agent.resources) {
        expect(MIKA_AGENT_RESOURCES).toContain(resource);
      }
      const acceptsProofs = operation.agent.acceptsProofs ?? [];
      for (const proof of acceptsProofs) {
        expect(MIKA_AGENT_PROOF_KINDS).toContain(proof);
      }
      expect(Array.isArray(operation.agent.requiredProofs)).toBe(true);
      for (const proof of operation.agent.requiredProofs) {
        expect(MIKA_AGENT_PROOF_KINDS).toContain(proof);
        expect(acceptsProofs).toContain(proof);
      }
      if (operation.agent.idempotency === "not_needed") {
        expect(operation.agent.idempotencyKey).toBeUndefined();
      } else {
        expect(operation.agent.idempotencyKey).toMatchObject({
          keyHeader: MIKA_AGENT_IDEMPOTENCY_KEY_HEADER,
          scope: MIKA_AGENT_IDEMPOTENCY_SCOPES[0],
          replay: "same_key_same_input",
          owner: "host",
        });
      }

      if (operation.transport === "none") {
        expect("schema" in operation ? operation.schema : undefined).toBeUndefined();
      } else {
        expect("schema" in operation ? operation.schema : undefined).toBeDefined();
      }

      if (operation.transport === "search") {
        expect(operation.searchKeys?.length).toBeGreaterThan(0);
      }
    }

    const routePublicFlags = new Map<string, boolean>();
    for (const operation of Object.values(mikaOperationDefinitions)) {
      const existing = routePublicFlags.get(operation.routePath);
      if (existing !== undefined) {
        expect(operation.public).toBe(existing);
      }
      routePublicFlags.set(operation.routePath, operation.public);
    }

    const methodsFromOperations = [
      ...new Set(
        Object.values(mikaOperationDefinitions)
          .filter((operation) => !("apiMethod" in operation && operation.apiMethod === false))
          .map((operation) => `${operation.namespace}.${operation.method}`),
      ),
    ].sort();
    const methodsFromPublicApi = Object.entries(mikaApiMethodNames)
      .flatMap(([namespace, methods]) => methods.map((method) => `${namespace}.${String(method)}`))
      .sort();
    expect(methodsFromPublicApi).toEqual(methodsFromOperations);
  });

  it("keeps Astro Action wiring aligned with action metadata", () => {
    const astroActionsSource = readFileSync(
      new URL("../src/astro-actions.ts", import.meta.url),
      "utf8",
    );
    const actionTreeKeys = mikaActionTreeDefinitionKeys();

    expectSourceContract(astroActionsSource, {
      required: [
        "mikaActionDefinitions",
        "mikaActionTreeSpec",
        "Object.entries(spec)",
        "defineMikaAction(mikaActionDefinitions[value])",
        "definition.schema",
        "definition.accept",
        "runMikaOperation({",
      ],
      forbidden: [
        "mikaActionDefinitions.cartAdd",
        "mikaActionDefinitions.checkoutStart",
        "mikaActionDefinitions.subscriptionRenew",
      ],
    });
    expect([...new Set(actionTreeKeys)].sort()).toEqual(Object.keys(mikaActionDefinitions).sort());
    expect(actionTreeKeys).toHaveLength(Object.keys(mikaActionDefinitions).length);
    expect(validateMikaActionTreeSpec()).toEqual(actionTreeKeys);
  });

  it("rejects invalid Mika Action tree specs with stable drift errors", () => {
    expect(() =>
      validateMikaActionTreeSpec({
        cart: { add: "cartAdd" },
        duplicate: "cartAdd",
      }),
    ).toThrow("mikaActionTreeSpec.duplicate duplicates action definition 'cartAdd'");
    expect(() =>
      validateMikaActionTreeSpec({
        catalog: { sellables: "catalogSellables" },
      }),
    ).toThrow("mikaActionTreeSpec is missing action definitions");
    expect(() =>
      validateMikaActionTreeSpec({
        cart: { add: "missingAction" },
      }),
    ).toThrow("mikaActionTreeSpec.cart.add references unknown action definition 'missingAction'");
    expect(() =>
      validateMikaActionTreeSpec({
        cart: { add: 1 },
      }),
    ).toThrow("mikaActionTreeSpec.cart.add must be an action key or nested object");
  });

  it("keeps JSON client adapters aligned with operation metadata", () => {
    const client = createMikaServerClient() as unknown as Record<string, Record<string, unknown>>;

    for (const [namespace, methods] of Object.entries(mikaApiMethodNames)) {
      expect(Object.keys(client[namespace] ?? {}).sort()).toEqual([...methods].sort());
    }
  });

  it("dispatches JSON client adapters with operation route, method, and transport metadata", async () => {
    const requests: Array<{
      readonly url: string;
      readonly method: string;
      readonly body?: string;
    }> = [];
    const client = createMikaServerClient({
      baseUrl: "https://shop.test",
      fetch: async (url, init) => {
        requests.push({
          url: typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url,
          method: init?.method ?? "GET",
          body: typeof init?.body === "string" ? init.body : undefined,
        });

        return Response.json({ ok: true, status: 200, data: {} });
      },
    });
    const cases = [
      {
        run: () => client.catalog.sellables("products", "ring", { locale: "en-IE" }),
        operation: mikaOperationDefinitions.catalogSellables,
        expectedUrl:
          "https://shop.test/_emdash/api/plugins/mika/catalog/sellables?collection=products&id=ring&locale=en-IE",
      },
      {
        run: () => client.cart.get(),
        operation: mikaOperationDefinitions.cartGet,
        expectedUrl: "https://shop.test/_emdash/api/plugins/mika/cart",
      },
      {
        run: () => client.cart.add({ sellableId: createMikaId("sellable_1"), quantity: 2 }),
        operation: mikaOperationDefinitions.cartAdd,
        expectedUrl: "https://shop.test/_emdash/api/plugins/mika/cart/items",
        expectedBody: JSON.stringify({ sellableId: "sellable_1", quantity: 2 }),
      },
      {
        run: () =>
          client.checkout.status({ checkoutId: id("checkout_1"), token: "status_token_1" }),
        operation: mikaOperationDefinitions.checkoutStatus,
        expectedUrl:
          "https://shop.test/_emdash/api/plugins/mika/checkout/status?checkoutId=checkout_1&token=status_token_1",
      },
    ];

    for (const adapterCase of cases) {
      requests.length = 0;
      await adapterCase.run();

      expect(requests).toEqual([
        {
          url: adapterCase.expectedUrl,
          method: adapterCase.operation.httpMethod,
          ...(adapterCase.expectedBody ? { body: adapterCase.expectedBody } : {}),
        },
      ]);
    }
  });

  it("does not throw from account export string shorthand normalizers on empty ids", async () => {
    const client = createMikaServerClient({
      baseUrl: "https://shop.test",
      fetch: async () =>
        Response.json(
          {
            ok: false,
            status: 422,
            error: {
              code: "VALIDATION_FAILED",
              message: "Mika input validation failed.",
            },
          },
          { status: 422 },
        ),
    });

    await expect(client.account.exportStatus("")).resolves.toMatchObject({
      ok: false,
      status: 422,
      error: { code: "VALIDATION_FAILED" },
    });
    await expect(client.account.exportDownload("   ")).resolves.toMatchObject({
      ok: false,
      status: 422,
      error: { code: "VALIDATION_FAILED" },
    });
  });

  it("keeps dynamic operation dispatch centralized", () => {
    const operationsSource = readFileSync(
      new URL("../src/api/operations.ts", import.meta.url),
      "utf8",
    );
    const operationRunnerSource = readFileSync(
      new URL("../src/api/operation-runner.ts", import.meta.url),
      "utf8",
    );
    const routeHandlersSource = readFileSync(
      new URL("../src/api/route-handlers.ts", import.meta.url),
      "utf8",
    );
    const astroActionsSource = readFileSync(
      new URL("../src/astro-actions.ts", import.meta.url),
      "utf8",
    );

    expect(operationsSource).toContain("z.infer<TSchema>");
    expect(operationsSource).toContain("export function callMikaOperation");
    expect(operationsSource).toContain("MikaApiOperationData<TOperation>");
    expect(operationRunnerSource).toContain("export async function runMikaOperation");
    expect(operationRunnerSource).toContain("runMikaOperationPolicy(operationPolicy");
    expect(operationRunnerSource).toContain("callMikaOperation(operation, api, ctx, input)");
    expect(operationsSource).not.toContain("input: never");
    expect(routeHandlersSource).toContain("runMikaOperation({");
    expect(routeHandlersSource).not.toContain("callMikaOperation(operation");
    expect(routeHandlersSource).not.toContain("runMikaOperationPolicy");
    expect(routeHandlersSource).not.toContain("as never");
    expect(astroActionsSource).toContain("runMikaOperation({");
    expect(astroActionsSource).not.toContain("callMikaOperation(definition.operation");
    expect(astroActionsSource).not.toContain("runMikaOperationPolicy");
    expect(astroActionsSource).toContain("resolveMikaOperationPolicy(options.operationPolicy)");
    expect(astroActionsSource).not.toContain(
      "const operationPolicy = resolveMikaOperationPolicy(options.operationPolicy)",
    );
    expect(astroActionsSource).not.toContain("as never");
  });

  it("forwards request cookies only for same-origin client calls by default", async () => {
    const observedCookies: Array<string | null> = [];
    const request = new Request("https://shop.test/product/ring", {
      headers: { cookie: "mika_session=abc" },
    });
    const fetcher: typeof fetch = async (_url, init) => {
      observedCookies.push(new Headers(init?.headers).get("cookie"));
      return Response.json({
        ok: true,
        status: 200,
        data: [],
      });
    };

    await createMikaClient({
      baseUrl: "https://shop.test",
      request,
      fetch: fetcher,
    }).catalog.sellables("products", "ring");
    await createMikaClient({
      baseUrl: "https://api.shop.test",
      request,
      fetch: fetcher,
    }).catalog.sellables("products", "ring");
    await createMikaServerClient({
      baseUrl: "https://api.shop.test",
      request,
      fetch: fetcher,
      forwardCrossOriginCookies: true,
    }).admin.providerHealth();

    expect(observedCookies).toEqual(["mika_session=abc", null, "mika_session=abc"]);
  });

  it("marks only catalog and availability plugin JSON routes public", () => {
    const publicRoutes = Object.entries(createMikaPluginRoutes())
      .filter(([, route]) => route.public)
      .map(([path]) => path)
      .sort();

    expect(publicRoutes).toEqual(
      publicMikaPluginRouteNames.map((route) => mikaPluginRoutes[route]).sort(),
    );
  });

  it("keeps cart and wishlist JSON route expectations private and request-bound", () => {
    const trustedRoutes = Object.values(mikaOperationDefinitions)
      .filter((operation) => operation.namespace === "cart" || operation.namespace === "wishlist")
      .map((operation) => ({
        name: operation.name,
        routeKey: operation.routeKey,
        routePath: operation.routePath,
        httpMethod: operation.httpMethod,
        public: operation.public,
        requiresRequestContext: operation.requiresRequestContext,
      }));

    expect(trustedRoutes).toEqual([
      {
        name: "cart.get",
        routeKey: "cart",
        routePath: "cart",
        httpMethod: "GET",
        public: false,
        requiresRequestContext: true,
      },
      {
        name: "cart.quote",
        routeKey: "cartQuote",
        routePath: "cart/quote",
        httpMethod: "POST",
        public: false,
        requiresRequestContext: true,
      },
      {
        name: "cart.add",
        routeKey: "cartItems",
        routePath: "cart/items",
        httpMethod: "POST",
        public: false,
        requiresRequestContext: true,
      },
      {
        name: "cart.update",
        routeKey: "cartItem",
        routePath: "cart/item",
        httpMethod: "PATCH",
        public: false,
        requiresRequestContext: true,
      },
      {
        name: "cart.remove",
        routeKey: "cartItem",
        routePath: "cart/item",
        httpMethod: "DELETE",
        public: false,
        requiresRequestContext: true,
      },
      {
        name: "cart.merge",
        routeKey: "cartMerge",
        routePath: "cart/merge",
        httpMethod: "POST",
        public: false,
        requiresRequestContext: true,
      },
      {
        name: "cart.applyCoupon",
        routeKey: "cartCoupon",
        routePath: "cart/coupon",
        httpMethod: "POST",
        public: false,
        requiresRequestContext: true,
      },
      {
        name: "cart.removeCoupon",
        routeKey: "cartCoupon",
        routePath: "cart/coupon",
        httpMethod: "DELETE",
        public: false,
        requiresRequestContext: true,
      },
      {
        name: "wishlist.get",
        routeKey: "wishlist",
        routePath: "wishlist",
        httpMethod: "GET",
        public: false,
        requiresRequestContext: true,
      },
      {
        name: "wishlist.add",
        routeKey: "wishlistItems",
        routePath: "wishlist/items",
        httpMethod: "POST",
        public: false,
        requiresRequestContext: true,
      },
      {
        name: "wishlist.remove",
        routeKey: "wishlistItem",
        routePath: "wishlist/item",
        httpMethod: "DELETE",
        public: false,
        requiresRequestContext: true,
      },
      {
        name: "wishlist.moveToCart",
        routeKey: "wishlistMoveToCart",
        routePath: "wishlist/move-to-cart",
        httpMethod: "POST",
        public: false,
        requiresRequestContext: true,
      },
      {
        name: "wishlist.saveForLater",
        routeKey: "wishlistSaveForLater",
        routePath: "wishlist/save-for-later",
        httpMethod: "POST",
        public: false,
        requiresRequestContext: true,
      },
      {
        name: "wishlist.merge",
        routeKey: "wishlistMerge",
        routePath: "wishlist/merge",
        httpMethod: "POST",
        public: false,
        requiresRequestContext: true,
      },
    ]);
  });

  it("rejects invalid JSON route bodies with validation failures", async () => {
    const routes = createMikaPluginRoutes();
    const request = new Request("https://shop.test/_emdash/api/plugins/mika/cart/items", {
      method: "POST",
    });

    await expect(
      routes[mikaPluginRoutes.cartItems].handler({
        input: { sellableId: "" },
        request,
      }),
    ).resolves.toMatchObject({
      ok: false,
      status: 422,
      error: { code: "VALIDATION_FAILED" },
    });
    await expect(
      routes[mikaPluginRoutes.adminStockAdjust].handler({
        input: { stockItemId: "stock_1", quantityDelta: "nope" },
        request,
      }),
    ).resolves.toMatchObject({
      ok: false,
      status: 422,
      error: { code: "VALIDATION_FAILED" },
    });
    await expect(
      routes[mikaPluginRoutes.cartQuote].handler({
        input: { quantity: "nope" },
        request: new Request("https://shop.test/_emdash/api/plugins/mika/cart/quote", {
          method: "POST",
        }),
      }),
    ).resolves.toMatchObject({
      ok: false,
      status: 422,
      error: { code: "VALIDATION_FAILED" },
    });
    await expect(
      routes[mikaPluginRoutes.checkoutPreview].handler({
        input: { proofRefs: [{ kind: "receipt" }] },
        request: new Request("https://shop.test/_emdash/api/plugins/mika/checkout/preview", {
          method: "POST",
        }),
      }),
    ).resolves.toMatchObject({
      ok: false,
      status: 422,
      error: { code: "VALIDATION_FAILED" },
    });
    await expect(
      routes[mikaPluginRoutes.webhook].handler({
        input: { provider: "" },
        request,
      }),
    ).resolves.toMatchObject({
      ok: false,
      status: 422,
      error: { code: "VALIDATION_FAILED" },
    });
  });

  it("rejects deeply nested checkout customFields without throwing", () => {
    const customFields: Record<string, unknown> = {};
    let cursor = customFields;
    for (let depth = 0; depth < 40; depth += 1) {
      const next: Record<string, unknown> = {};
      cursor["next"] = next;
      cursor = next;
    }

    expect(() =>
      startCheckoutInputSchema.safeParse({
        sellableId: "sellable_1",
        customFields,
      }),
    ).not.toThrow();
    expect(
      startCheckoutInputSchema.safeParse({
        sellableId: "sellable_1",
        customFields,
      }).success,
    ).toBe(false);
  });

  it("rejects unsupported JSON route methods without invoking fallback mutators", async () => {
    let updateCalled = false;
    let applyCouponCalled = false;
    const routes = createMikaPluginRoutes(
      createMikaApi({
        cart: {
          update: async () => {
            updateCalled = true;
            return { ok: true, status: 200, data: { id: id("cart_1") } as CartDTO };
          },
          applyCoupon: async () => {
            applyCouponCalled = true;
            return { ok: true, status: 200, data: { id: id("cart_1") } as CartDTO };
          },
        },
      } satisfies MikaApiOverrides),
    );

    await expect(
      routes[mikaPluginRoutes.cartItem].handler({
        input: { lineId: "line_1", quantity: 2 },
        request: new Request("https://shop.test/_emdash/api/plugins/mika/cart/item", {
          method: "POST",
        }),
      }),
    ).resolves.toMatchObject({
      ok: false,
      status: 405,
      error: {
        code: "METHOD_NOT_ALLOWED",
        fieldErrors: { method: "Expected DELETE, PATCH." },
      },
    });
    await expect(
      routes[mikaPluginRoutes.cartCoupon].handler({
        input: { code: "SAVE10" },
        request: new Request("https://shop.test/_emdash/api/plugins/mika/cart/coupon", {
          method: "PATCH",
        }),
      }),
    ).resolves.toMatchObject({
      ok: false,
      status: 405,
      error: {
        code: "METHOD_NOT_ALLOWED",
        fieldErrors: { method: "Expected DELETE, POST." },
      },
    });
    expect(updateCalled).toBe(false);
    expect(applyCouponCalled).toBe(false);
  });

  it("passes parsed branded route bodies to API overrides", async () => {
    let observed: unknown;
    const routes = createMikaPluginRoutes(
      createMikaApi({
        cart: {
          add: async (_ctx, input) => {
            observed = input;
            return { ok: true, status: 200, data: { id: id("cart_1") } as CartDTO };
          },
        },
      } satisfies MikaApiOverrides),
    );

    await routes[mikaPluginRoutes.cartItems].handler({
      input: { sellableId: " sellable_1 ", priceId: " price_1 ", quantity: "2" },
      request: new Request("https://shop.test/_emdash/api/plugins/mika/cart/items", {
        method: "POST",
      }),
    });

    expect(observed).toMatchObject({
      sellableId: id("sellable_1"),
      priceId: id("price_1"),
      quantity: 2,
    });
  });

  it("allows JSON route operations by default when no policy is configured", async () => {
    let called = false;
    const routes = createMikaPluginRoutes(
      createMikaApi({
        catalog: {
          sellables: async () => {
            called = true;
            return { ok: true, status: 200, data: [] };
          },
        },
      } satisfies MikaApiOverrides),
    );

    await expect(
      routes[mikaPluginRoutes.catalogSellables].handler({
        input: {},
        request: new Request(
          "https://shop.test/_emdash/api/plugins/mika/catalog/sellables?collection=products&id=ring",
        ),
      }),
    ).resolves.toMatchObject({
      ok: true,
      status: 200,
      data: [],
    });
    expect(called).toBe(true);
  });

  it("validates JSON route input before policy or API dispatch", async () => {
    let policyCalled = false;
    let apiCalled = false;
    const routes = createMikaPluginRoutes(
      createMikaApi({
        cart: {
          add: async () => {
            apiCalled = true;
            return { ok: true, status: 200, data: { id: id("cart_1") } as CartDTO };
          },
        },
      } satisfies MikaApiOverrides),
      {
        operationPolicy: () => {
          policyCalled = true;
        },
      },
    );

    await expect(
      routes[mikaPluginRoutes.cartItems].handler({
        input: { sellableId: "" },
        request: new Request("https://shop.test/_emdash/api/plugins/mika/cart/items", {
          method: "POST",
        }),
      }),
    ).resolves.toMatchObject({
      ok: false,
      status: 422,
      error: { code: "VALIDATION_FAILED" },
    });
    expect(policyCalled).toBe(false);
    expect(apiCalled).toBe(false);
  });

  it("passes operation, request context, and parsed input to JSON route policy", async () => {
    const observed: Array<{
      readonly operation: string;
      readonly sessionId?: string;
      readonly input: unknown;
    }> = [];
    const policy: MikaOperationPolicy = ({ descriptor, ctx, input }) => {
      observed.push({ operation: descriptor.name, sessionId: ctx.sessionId, input });
    };
    const routes = createMikaPluginRoutes(
      createMikaApi({
        cart: {
          add: async (_ctx, input) => ({
            ok: true,
            status: 200,
            data: {
              id: id("cart_1"),
              items: [{ sellableId: input.sellableId }],
            } as unknown as CartDTO,
          }),
        },
      } satisfies MikaApiOverrides),
      { operationPolicy: policy },
    );

    await routes[mikaPluginRoutes.cartItems].handler({
      input: { sellableId: " sellable_1 ", quantity: "2" },
      request: new Request("https://shop.test/_emdash/api/plugins/mika/cart/items", {
        method: "POST",
      }),
      sessionId: "session_policy_1",
    });

    expect(observed).toEqual([
      {
        operation: "cart.add",
        sessionId: "session_policy_1",
        input: {
          sellableId: id("sellable_1"),
          quantity: 2,
        },
      },
    ]);
  });

  it("dispatches action runner invocations through policy and API overrides", async () => {
    let apiInput: unknown;
    const policyCalls: Array<{
      readonly operation: string;
      readonly sessionId?: string;
      readonly input: unknown;
    }> = [];
    const routes = createMikaPluginRoutes(
      createMikaApi({
        admin: {
          stockAdjust: async (input) => {
            apiInput = input;
            return {
              ok: true,
              status: 200,
              data: {
                id: input.stockItemId,
                status: "completed",
                message: "Stock adjusted.",
              },
            };
          },
        },
      } satisfies MikaApiOverrides),
      {
        operationPolicy: ({ descriptor, ctx, input }) => {
          policyCalls.push({ operation: descriptor.name, sessionId: ctx.sessionId, input });
        },
      },
    );

    const result = await routes[mikaPluginRoutes.actionsRunner].handler({
      input: {
        actionId: "mika.stock.adjust",
        invocationId: "stock_adjust_invocation_1",
        payload: { quantityDelta: 4 },
        context: {
          surface: "row",
          rowId: "stock_1",
          row: { stockItemId: "stock_1" },
        },
        target: {
          type: "row",
          surface: "row",
          rowId: "stock_1",
          path: "stock.0",
          value: { stockItemId: "stock_1" },
        },
      },
      request: new Request("https://shop.test/_emdash/api/plugins/mika/.well-known/actions/run", {
        method: "POST",
      }),
      sessionId: "session_runner_1",
    });

    const expectedInput = {
      stockItemId: id("stock_1"),
      quantityDelta: 4,
      idempotencyKey: "stock_adjust_invocation_1",
    };
    expect(apiInput).toEqual(expectedInput);
    expect(policyCalls).toEqual([
      {
        operation: "admin.stockAdjust",
        sessionId: "session_runner_1",
        input: expectedInput,
      },
    ]);
    expect(result).toMatchObject({
      ok: true,
      status: 200,
      severity: "success",
      message: "Stock adjusted.",
      effects: { reload: true },
      data: {
        id: "stock_1",
        status: "completed",
      },
    });
  });

  it("resolves admin action operations from internal runtime metadata", () => {
    expect(
      Object.entries(mikaAdminActionRuntimeDefinitions).map(([actionId, runtime]) => [
        actionId,
        runtime.operationKey,
        adminActionOperation(actionId as keyof typeof mikaAdminActionDefinitions).name,
      ]),
    ).toEqual([
      ["mika.provider.health", "adminProviderHealth", "admin.providerHealth"],
      ["mika.provider.sync", "adminProviderSync", "admin.providerSync"],
      [
        "mika.stock.releaseExpiredReservations",
        "adminStockReleaseExpiredReservations",
        "admin.releaseExpiredReservations",
      ],
      ["mika.catalog.syncEntry", "adminProviderSync", "admin.providerSync"],
      ["mika.stock.adjust", "adminStockAdjust", "admin.stockAdjust"],
      ["mika.webhook.replay", "adminWebhookReplay", "admin.webhookReplay"],
      ["mika.order.refund", "adminOrderRefund", "admin.orderRefund"],
      ["mika.order.cancel", "adminOrderCancel", "admin.orderCancel"],
      ["mika.entitlement.grant", "adminEntitlementGrant", "admin.entitlementGrant"],
      ["mika.entitlement.revoke", "adminEntitlementRevoke", "admin.entitlementRevoke"],
      ["mika.email.resend", "adminEmailResend", "admin.emailResend"],
      ["mika.license.revoke", "adminLicenseRevoke", "admin.licenseRevoke"],
      ["mika.download.issue", "adminDownloadIssue", "admin.downloadIssue"],
    ]);
  });

  it("requires idempotency for admin runner operations before policy or API dispatch", async () => {
    let policyCalled = false;
    let apiCalled = false;
    const routes = createMikaPluginRoutes(
      createMikaApi({
        admin: {
          stockAdjust: async () => {
            apiCalled = true;
            return { ok: true, status: 200, data: { status: "completed" } };
          },
        },
      } satisfies MikaApiOverrides),
      {
        operationPolicy: () => {
          policyCalled = true;
        },
      },
    );

    await expect(
      routes[mikaPluginRoutes.actionsRunner].handler({
        input: {
          actionId: "mika.stock.adjust",
          payload: { quantityDelta: 1 },
          target: {
            type: "row",
            value: { stockItemId: "stock_1" },
          },
        },
        request: new Request("https://shop.test/_emdash/api/plugins/mika/.well-known/actions/run", {
          method: "POST",
        }),
      }),
    ).resolves.toMatchObject({
      ok: false,
      status: 409,
      severity: "error",
      message: "Mika operation 'admin.stockAdjust' requires an idempotency key.",
    });
    expect(policyCalled).toBe(false);
    expect(apiCalled).toBe(false);
  });

  it("accepts admin runner idempotency from request headers", async () => {
    const policyCalls: Array<{ readonly idempotencyKey?: string }> = [];
    const apiInputs: Array<{ readonly idempotencyKey?: string }> = [];
    const routes = createMikaPluginRoutes(
      createMikaApi({
        admin: {
          stockAdjust: async (input) => {
            apiInputs.push({ idempotencyKey: input.idempotencyKey });

            return {
              ok: true,
              status: 200,
              data: { status: "completed" },
            };
          },
        },
      } satisfies MikaApiOverrides),
      {
        operationPolicy: ({ ctx }) => {
          policyCalls.push({ idempotencyKey: ctx.idempotencyKey });
        },
      },
    );

    await expect(
      routes[mikaPluginRoutes.actionsRunner].handler({
        input: {
          actionId: "mika.stock.adjust",
          payload: { quantityDelta: 1 },
          target: {
            type: "row",
            value: { stockItemId: "stock_1" },
          },
        },
        request: new Request("https://shop.test/_emdash/api/plugins/mika/.well-known/actions/run", {
          method: "POST",
          headers: { [MIKA_AGENT_IDEMPOTENCY_KEY_HEADER]: "admin_action_header_1" },
        }),
      }),
    ).resolves.toMatchObject({
      ok: true,
      status: 200,
    });
    expect(policyCalls).toEqual([{ idempotencyKey: "admin_action_header_1" }]);
    expect(apiInputs).toEqual([{ idempotencyKey: "admin_action_header_1" }]);
  });

  it("validates action runner target and input before policy or API dispatch", async () => {
    let policyCalled = false;
    let apiCalled = false;
    const routes = createMikaPluginRoutes(
      createMikaApi({
        admin: {
          stockAdjust: async () => {
            apiCalled = true;
            return { ok: true, status: 200, data: { status: "completed" } };
          },
        },
      } satisfies MikaApiOverrides),
      {
        operationPolicy: () => {
          policyCalled = true;
        },
      },
    );

    await expect(
      routes[mikaPluginRoutes.actionsRunner].handler({
        input: {
          actionId: "mika.stock.adjust",
          payload: { quantityDelta: 1 },
          target: { type: "dashboard" },
        },
        request: new Request("https://shop.test/_emdash/api/plugins/mika/.well-known/actions/run", {
          method: "POST",
        }),
      }),
    ).resolves.toMatchObject({
      ok: false,
      status: 422,
      severity: "warning",
      message: "Mika action 'mika.stock.adjust' cannot run for this target.",
    });
    expect(policyCalled).toBe(false);
    expect(apiCalled).toBe(false);
  });

  it("rejects action runner targets with an explicit mismatched kind", async () => {
    let apiCalled = false;
    const routes = createMikaPluginRoutes(
      createMikaApi({
        admin: {
          stockAdjust: async () => {
            apiCalled = true;
            return { ok: true, status: 200, data: { status: "completed" } };
          },
        },
      } satisfies MikaApiOverrides),
    );

    await expect(
      routes[mikaPluginRoutes.actionsRunner].handler({
        input: {
          actionId: "mika.stock.adjust",
          invocationId: "stock_adjust_invocation_wrong_kind",
          payload: { quantityDelta: 1 },
          target: {
            type: "row",
            kind: "order",
            value: { stockItemId: "stock_1" },
          },
        },
        request: new Request("https://shop.test/_emdash/api/plugins/mika/.well-known/actions/run", {
          method: "POST",
        }),
      }),
    ).resolves.toMatchObject({
      ok: false,
      status: 422,
      severity: "warning",
      message: "Mika action 'mika.stock.adjust' cannot run for this target.",
    });
    expect(apiCalled).toBe(false);
  });

  it("normalizes thrown admin runner operations into action result envelopes", async () => {
    const routes = createMikaPluginRoutes(
      createMikaApi({
        admin: {
          stockAdjust: async () => {
            throw new Error("database unavailable");
          },
        },
      } satisfies MikaApiOverrides),
    );

    await expect(
      routes[mikaPluginRoutes.actionsRunner].handler({
        input: {
          actionId: "mika.stock.adjust",
          invocationId: "stock_adjust_invocation_throw",
          payload: { quantityDelta: 1 },
          target: {
            type: "row",
            kind: "stockItem",
            value: { stockItemId: "stock_1" },
          },
        },
        request: new Request("https://shop.test/_emdash/api/plugins/mika/.well-known/actions/run", {
          method: "POST",
        }),
      }),
    ).resolves.toMatchObject({
      ok: false,
      status: 500,
      severity: "error",
      message: "Mika operation failed.",
    });
  });

  it("does not use UI row ids as action operation ids", async () => {
    let policyCalled = false;
    let apiCalled = false;
    const routes = createMikaPluginRoutes(
      createMikaApi({
        admin: {
          stockAdjust: async () => {
            apiCalled = true;
            return { ok: true, status: 200, data: { status: "completed" } };
          },
        },
      } satisfies MikaApiOverrides),
      {
        operationPolicy: () => {
          policyCalled = true;
        },
      },
    );

    await expect(
      routes[mikaPluginRoutes.actionsRunner].handler({
        input: {
          actionId: "mika.stock.adjust",
          payload: { quantityDelta: 1 },
          target: {
            type: "row",
            surface: "row",
            rowId: "ui_row_1",
            path: "stock.0",
            value: {},
          },
        },
        request: new Request("https://shop.test/_emdash/api/plugins/mika/.well-known/actions/run", {
          method: "POST",
        }),
      }),
    ).resolves.toMatchObject({
      ok: false,
      status: 422,
      severity: "warning",
      message: "Mika action 'mika.stock.adjust' requires a target identifier.",
    });
    expect(policyCalled).toBe(false);
    expect(apiCalled).toBe(false);
  });

  it("accepts primitive canonical row values as action operation ids", async () => {
    let apiInput: unknown;
    const routes = createMikaPluginRoutes(
      createMikaApi({
        admin: {
          stockAdjust: async (input) => {
            apiInput = input;
            return { ok: true, status: 200, data: { id: input.stockItemId, status: "completed" } };
          },
        },
      } satisfies MikaApiOverrides),
    );

    await expect(
      routes[mikaPluginRoutes.actionsRunner].handler({
        input: {
          actionId: "mika.stock.adjust",
          invocationId: "stock_adjust_invocation_primitive",
          payload: { quantityDelta: 2 },
          target: {
            type: "row",
            surface: "row",
            rowId: "ui_row_1",
            path: "stock.0",
            value: "stock_primitive_1",
          },
        },
        request: new Request("https://shop.test/_emdash/api/plugins/mika/.well-known/actions/run", {
          method: "POST",
        }),
      }),
    ).resolves.toMatchObject({
      ok: true,
      status: 200,
      severity: "success",
    });
    expect(apiInput).toEqual({
      stockItemId: id("stock_primitive_1"),
      quantityDelta: 2,
      idempotencyKey: "stock_adjust_invocation_primitive",
    });
  });

  it("resolves entry-scoped catalog sync action targets", async () => {
    let apiInput: unknown;
    const policyCalls: Array<{
      readonly operation: string;
      readonly input: unknown;
    }> = [];
    const routes = createMikaPluginRoutes(
      createMikaApi({
        admin: {
          providerSync: async (input) => {
            apiInput = input;
            return {
              ok: true,
              status: 200,
              data: {
                id: id("admin_job_1"),
                status: "completed",
              },
            };
          },
        },
      } satisfies MikaApiOverrides),
      {
        operationPolicy: ({ descriptor, input }) => {
          policyCalls.push({ operation: descriptor.name, input });
        },
      },
    );

    const result = await routes[mikaPluginRoutes.actionsRunner].handler({
      input: {
        actionId: "mika.catalog.syncEntry",
        invocationId: "catalog_sync_invocation_1",
        payload: { mode: "apply" },
        target: {
          type: "field",
          surface: "field",
          collection: "products",
          entryId: "ring",
          locale: "en",
          fieldName: "commerce",
        },
      },
      request: new Request("https://shop.test/_emdash/api/plugins/mika/.well-known/actions/run", {
        method: "POST",
      }),
    });

    const expectedInput = {
      mode: "apply",
      scope: "entry",
      contentRef: {
        collection: "products",
        id: "ring",
        locale: "en",
      },
      idempotencyKey: "catalog_sync_invocation_1",
    };
    expect(apiInput).toEqual(expectedInput);
    expect(policyCalls).toEqual([{ operation: "admin.providerSync", input: expectedInput }]);
    expect(result).toMatchObject({
      ok: true,
      status: 200,
      severity: "success",
      effects: { reload: true },
    });
  });

  it("preserves download issue order and order-line ids from row values", async () => {
    let apiInput: unknown;
    const routes = createMikaPluginRoutes(
      createMikaApi({
        admin: {
          downloadIssue: async (input) => {
            apiInput = input;
            return {
              ok: true,
              status: 200,
              data: {
                id: id("download_job_1"),
                status: "completed",
              },
            };
          },
        },
      } satisfies MikaApiOverrides),
    );

    await expect(
      routes[mikaPluginRoutes.actionsRunner].handler({
        input: {
          actionId: "mika.download.issue",
          invocationId: "download_issue_invocation_1",
          target: {
            type: "row",
            surface: "row",
            rowId: "ui_row_1",
            path: "downloads.0",
            value: {
              orderId: "order_1",
              orderLineId: "order_line_1",
            },
          },
        },
        request: new Request("https://shop.test/_emdash/api/plugins/mika/.well-known/actions/run", {
          method: "POST",
        }),
      }),
    ).resolves.toMatchObject({
      ok: true,
      status: 200,
      severity: "success",
    });
    expect(apiInput).toEqual({
      orderId: id("order_1"),
      orderLineId: id("order_line_1"),
      idempotencyKey: "download_issue_invocation_1",
    });
  });

  it("rejects entry-scoped provider sync without a content ref before dispatch", async () => {
    let policyCalled = false;
    let apiCalled = false;
    const routes = createMikaPluginRoutes(
      createMikaApi({
        admin: {
          providerSync: async () => {
            apiCalled = true;
            return { ok: true, status: 200, data: { status: "completed" } };
          },
        },
      } satisfies MikaApiOverrides),
      {
        operationPolicy: () => {
          policyCalled = true;
        },
      },
    );

    await expect(
      routes[mikaPluginRoutes.actionsRunner].handler({
        input: {
          actionId: "mika.provider.sync",
          payload: { scope: "entry" },
          target: { type: "dashboard" },
        },
        request: new Request("https://shop.test/_emdash/api/plugins/mika/.well-known/actions/run", {
          method: "POST",
        }),
      }),
    ).resolves.toMatchObject({
      ok: false,
      status: 422,
      severity: "warning",
      message: "Mika input validation failed.",
    });
    expect(policyCalled).toBe(false);
    expect(apiCalled).toBe(false);
  });

  it("returns stable JSON route failures when operation policy rejects", async () => {
    let called = false;
    const policy: MikaOperationPolicy = () => ({
      ok: false,
      status: 409,
      error: {
        code: "CONFLICT",
        message: "Policy rejected cart mutation.",
      },
    });
    const routes = createMikaPluginRoutes(
      createMikaApi({
        cart: {
          add: async () => {
            called = true;
            return { ok: true, status: 200, data: { id: id("cart_1") } as CartDTO };
          },
        },
      } satisfies MikaApiOverrides),
      { operationPolicy: policy },
    );

    await expect(
      routes[mikaPluginRoutes.cartItems].handler({
        input: { sellableId: "sellable_1", quantity: 1 },
        request: new Request("https://shop.test/_emdash/api/plugins/mika/cart/items", {
          method: "POST",
        }),
      }),
    ).resolves.toEqual({
      ok: false,
      status: 409,
      error: {
        code: "CONFLICT",
        message: "Policy rejected cart mutation.",
      },
    });
    expect(called).toBe(false);
  });

  it("resolves default operation policy at dispatch time", () => {
    const firstPolicy: MikaOperationPolicy = () => true;
    const secondPolicy: MikaOperationPolicy = () => false;

    try {
      setDefaultMikaOperationPolicy(undefined);
      const earlyResolved = resolveMikaOperationPolicy(undefined);

      setDefaultMikaOperationPolicy(firstPolicy);
      expect(earlyResolved).toBeUndefined();
      expect(resolveMikaOperationPolicy(undefined)).toBe(firstPolicy);
      expect(resolveMikaOperationPolicy(secondPolicy)).toBe(secondPolicy);

      setDefaultMikaOperationPolicy(secondPolicy);
      expect(resolveMikaOperationPolicy(undefined)).toBe(secondPolicy);
    } finally {
      setDefaultMikaOperationPolicy(undefined);
    }
  });

  it("validates JSON route query parameters", async () => {
    const routes = createMikaPluginRoutes();

    await expect(
      routes[mikaPluginRoutes.catalogSellables].handler({
        input: {},
        request: new Request(
          "https://shop.test/_emdash/api/plugins/mika/catalog/sellables?collection=&id=ring",
        ),
      }),
    ).resolves.toMatchObject({
      ok: false,
      status: 422,
      error: { code: "VALIDATION_FAILED" },
    });
  });

  it("forwards catalog locale through the JSON client", async () => {
    let requestedUrl = "";
    const client = createMikaClient({
      baseUrl: "https://shop.test",
      fetch: async (url) => {
        requestedUrl =
          typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;
        return Response.json({
          ok: true,
          status: 200,
          data: [],
        });
      },
    });

    await client.catalog.sellables("products", "ring", { locale: "de" });

    expect(requestedUrl).toBe(
      "https://shop.test/_emdash/api/plugins/mika/catalog/sellables?collection=products&id=ring&locale=de",
    );
  });

  it("preserves return targets for order invoice requests", async () => {
    let requestedUrl = "";
    const client = createMikaServerClient({
      baseUrl: "https://shop.test",
      fetch: async (url) => {
        requestedUrl =
          typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;
        return Response.json({
          ok: true,
          status: 200,
          data: { orderId: "order_1", href: "/invoice/order_1" },
        });
      },
    });

    await client.order.invoice({
      orderId: id("order_1"),
      token: "invoice_token_1",
      returnTo: "/account/orders",
    });

    expect(requestedUrl).toBe(
      "https://shop.test/_emdash/api/plugins/mika/orders/invoice?orderId=order_1&token=invoice_token_1&returnTo=%2Faccount%2Forders",
    );
  });

  it("requests quote and checkout preview through the trusted JSON client", async () => {
    const requests: Array<{
      readonly url: string;
      readonly method?: string;
      readonly body: string;
    }> = [];
    const client = createMikaServerClient({
      baseUrl: "https://shop.test",
      fetch: async (url, init) => {
        requests.push({
          url: typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url,
          method: init?.method,
          body: typeof init?.body === "string" ? init.body : "",
        });
        return Response.json({
          ok: false,
          status: 501,
          error: { code: "NOT_IMPLEMENTED", message: "stub" },
        });
      },
    });

    await client.cart.quote({ cartId: id("cart_1"), couponCode: "SAVE10" });
    await client.checkout.preview({
      quoteId: id("quote_1"),
      proofRefs: [{ kind: "receipt", id: "receipt_1", inputHash: "hash_1" }],
    });

    expect(requests).toEqual([
      {
        url: "https://shop.test/_emdash/api/plugins/mika/cart/quote",
        method: "POST",
        body: JSON.stringify({ cartId: "cart_1", couponCode: "SAVE10" }),
      },
      {
        url: "https://shop.test/_emdash/api/plugins/mika/checkout/preview",
        method: "POST",
        body: JSON.stringify({
          quoteId: "quote_1",
          proofRefs: [{ kind: "receipt", id: "receipt_1", inputHash: "hash_1" }],
        }),
      },
    ]);
  });

  it("maps representative server client methods through operation transport metadata", async () => {
    const requests: Array<{
      readonly url: string;
      readonly method?: string;
      readonly body: string;
    }> = [];
    const client = createMikaServerClient({
      baseUrl: "https://shop.test",
      fetch: async (url, init) => {
        requests.push({
          url: typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url,
          method: init?.method,
          body: typeof init?.body === "string" ? init.body : "",
        });
        return Response.json({
          ok: false,
          status: 501,
          error: { code: "NOT_IMPLEMENTED", message: "stub" },
        });
      },
    });

    await client.cart.get();
    await client.checkout.status({ checkoutId: id("checkout_1"), token: "status_token_1" });
    await client.cart.update({ lineId: id("cart_line_1"), quantity: 2 });
    await client.cart.remove({ lineId: id("cart_line_1") });
    await client.cart.applyCoupon({ code: "SAVE10" });
    await client.cart.removeCoupon({ cartId: id("cart_1") });

    expect(requests).toEqual([
      {
        url: "https://shop.test/_emdash/api/plugins/mika/cart",
        method: "GET",
        body: "",
      },
      {
        url: "https://shop.test/_emdash/api/plugins/mika/checkout/status?checkoutId=checkout_1&token=status_token_1",
        method: "GET",
        body: "",
      },
      {
        url: "https://shop.test/_emdash/api/plugins/mika/cart/item",
        method: "PATCH",
        body: JSON.stringify({ lineId: "cart_line_1", quantity: 2 }),
      },
      {
        url: "https://shop.test/_emdash/api/plugins/mika/cart/item",
        method: "DELETE",
        body: JSON.stringify({ lineId: "cart_line_1" }),
      },
      {
        url: "https://shop.test/_emdash/api/plugins/mika/cart/coupon",
        method: "POST",
        body: JSON.stringify({ code: "SAVE10" }),
      },
      {
        url: "https://shop.test/_emdash/api/plugins/mika/cart/coupon",
        method: "DELETE",
        body: JSON.stringify({ cartId: "cart_1" }),
      },
    ]);
  });

  it("keeps new default API methods explicitly unwired", async () => {
    const api = createMikaApi();
    const ctx = {
      request: new Request("https://shop.test"),
      url: new URL("https://shop.test"),
      now: iso(new Date(0).toISOString()),
    };

    await expect(api.cart.applyCoupon(ctx, { code: "SAVE10" })).resolves.toMatchObject({
      ok: false,
      status: 501,
      error: { code: "NOT_IMPLEMENTED" },
    });
    await expect(api.cart.quote(ctx, {})).resolves.toMatchObject({
      ok: false,
      status: 501,
      error: { code: "NOT_IMPLEMENTED" },
    });
    await expect(api.checkout.preview(ctx, {})).resolves.toMatchObject({
      ok: false,
      status: 501,
      error: { code: "NOT_IMPLEMENTED" },
    });
    await expect(api.admin.providerSync({ mode: "dry_run" })).resolves.toMatchObject({
      ok: false,
      status: 501,
      error: { code: "NOT_IMPLEMENTED" },
    });
    expect(mikaApiMethodNames.cart).toContain("applyCoupon");
    expect(mikaApiMethodNames.cart).toContain("quote");
    expect(mikaApiMethodNames.checkout).toContain("preview");
    expect(mikaApiMethodNames.admin).toContain("releaseExpiredReservations");
  });
});

describe("Mika model mappers", () => {
  it("maps catalog aggregates and stock counters into storefront sellables", () => {
    const [sellable] = catalogSellablesToDTO({
      catalog: {
        schemaVersion: 1,
        content: { collection: "products", id: "ring" },
        titleSnapshot: "Ring",
        sellables: [
          {
            id: id("sellable_1"),
            titleSnapshot: "Silver Ring",
            variantKey: "finish:silver",
            variantOptions: [{ option: "finish", value: "silver", label: "Silver" }],
            variantGroups: [
              {
                option: "finish",
                label: "Finish",
                values: [{ option: "finish", value: "silver", label: "Silver" }],
              },
            ],
            active: true,
            sortOrder: 1,
            maxPerOrder: 2,
            prices: [
              {
                id: id("price_1"),
                providerRefs: [],
                amount: 2500,
                currency: currency("EUR"),
                mode: "payment",
                fulfillmentKind: "none",
                active: true,
              },
            ],
          },
        ],
      },
      stockBySellableId: new Map([
        [
          id("sellable_1"),
          {
            id: id("stock_1"),
            sellableId: id("sellable_1"),
            policy: "finite",
            quantityOnHand: 5,
            quantityReserved: 4,
            lowStockThreshold: 2,
            allowBackorder: false,
            createdAt: iso(new Date(0).toISOString()),
            updatedAt: iso(new Date(0).toISOString()),
          },
        ],
      ]),
    });

    expect(sellable).toMatchObject({
      id: "sellable_1",
      title: "Silver Ring",
      variantGroups: [
        {
          option: "finish",
          label: "Finish",
        },
      ],
      prices: [
        {
          id: "price_1",
          sellableId: "sellable_1",
          amount: 2500,
        },
      ],
      availability: {
        status: "low_stock",
        availableQuantity: 1,
        maxPerOrder: 2,
      },
    });
  });
});

describe("Mika storage boundaries", () => {
  it("rejects non-object JSON metadata", () => {
    expect(decodeJsonObject(JSON.stringify({ nested: { ok: true } }))).toEqual({
      nested: { ok: true },
    });
    expect(() => decodeJsonObject(JSON.stringify(["not", "object"]))).toThrow(
      /must be a JSON object/,
    );
  });
});

describe("Mika provider contracts", () => {
  it("registers provider adapters without wrapping their implementation", () => {
    const adapter = defineMikaProvider({
      id: provider("fake"),
      capabilities: () => ["hosted_checkout"],
      createCheckoutSession: async () => ({
        id: id("checkout_1"),
        status: "created",
        mode: "payment",
        provider: provider("fake"),
      }),
      retrieveCheckoutSession: async () => ({
        id: id("checkout_1"),
        status: "completed",
        mode: "payment",
        provider: provider("fake"),
      }),
    });
    const registry = createMikaProviderRegistry([adapter]);

    expect(registry.get(provider("fake"))).toBe(adapter);
    expect(registry.list()).toEqual([adapter]);
  });
});

describe("Mika admin and email shell", () => {
  it("exposes an emdash-actions compatible provider config and manifest", () => {
    const provider = createMikaActionsProviderConfig();
    const manifest = createMikaAdminActionsManifest();

    expect(provider).toEqual({
      pluginId: "mika",
      label: "Mika",
      manifestRoute: ".well-known/actions",
      runnerRoute: ".well-known/actions/run",
      allowedTargetPluginIds: [],
    });
    const providerHealth = manifest.actions.find((action) => action.id === "mika.provider.health");
    const catalogSync = manifest.actions.find((action) => action.id === "mika.catalog.syncEntry");
    expect(providerHealth).toMatchObject({
      id: "mika.provider.health",
      mode: "runner",
      runner: true,
      target: { surfaces: ["dashboard"], required: true },
      placement: "dashboard",
    });
    expect(catalogSync).toMatchObject({
      id: "mika.catalog.syncEntry",
      mode: "runner",
      runner: true,
      target: { surfaces: ["entry", "field"], required: true },
      placement: "field",
    });
    expect(providerHealth && "route" in providerHealth).toBe(false);
    expect(providerHealth && "method" in providerHealth).toBe(false);
    expect(providerHealth && "pluginId" in providerHealth).toBe(false);
    expect(providerHealth && "operationKey" in providerHealth).toBe(false);
    expect(providerHealth && "resultAdapter" in providerHealth).toBe(false);
    expect(catalogSync && "route" in catalogSync).toBe(false);
    expect(catalogSync && "method" in catalogSync).toBe(false);
    expect(catalogSync && "pluginId" in catalogSync).toBe(false);
    expect(catalogSync && "inputResolver" in catalogSync).toBe(false);
    const stockAdjust = manifest.actions.find((action) => action.id === "mika.stock.adjust");
    expect(stockAdjust).toMatchObject({
      target: { surfaces: ["field", "row"], required: true },
      form: {
        mode: "inline",
        fields: [
          { name: "quantityDelta", label: "Quantity delta", type: "integer", required: true },
          { name: "reason", label: "Reason", type: "string" },
        ],
      },
    });
    expect(stockAdjust && "input" in stockAdjust).toBe(false);
    expect(stockAdjust && "targetIdentity" in stockAdjust).toBe(false);
    expect(stockAdjust?.target && "idKeys" in stockAdjust.target).toBe(false);
    expect(stockAdjust?.target && "idFrom" in stockAdjust.target).toBe(false);
  });

  it("creates copyable field action button options", () => {
    expect(createMikaCatalogSyncActionButtonOptions()).toMatchObject({
      mode: "run",
      provider: "mika",
      providerLabel: "Mika",
      actionPluginId: "mika",
      manifestRoute: ".well-known/actions",
      runnerRoute: ".well-known/actions/run",
      action: "mika.catalog.syncEntry",
      contextKey: "context",
    });
    expect(createMikaActionButtonOptions("mika.stock.adjust")).toMatchObject({
      action: "mika.stock.adjust",
      provider: "mika",
      runnerRoute: ".well-known/actions/run",
      route: undefined,
      confirm: "Adjust stock for this item?",
    });
    expect(
      createMikaActionButtonOptions("mika.stock.adjust", {
        provider: "custom",
        providerLabel: "Custom",
      }),
    ).toMatchObject({
      provider: "custom",
      providerLabel: "Custom",
      actionPluginId: "custom",
      actionPluginLabel: "Custom",
    });
  });

  it("renders minimal magic-link and order-confirmation emails", () => {
    const magicLink = renderMikaMagicLinkEmail({
      toEmail: "customer@example.com",
      url: "https://shop.test/account/magic-link?token=secret",
      brand: { siteName: "Test Shop", supportEmail: "support@example.com" },
    });
    const order = renderMikaOrderConfirmationEmail({
      toEmail: "customer@example.com",
      orderNumber: "M-1001",
      total: { amount: 2500, currency: currency("EUR") },
      lines: [{ title: "Ring", quantity: 1, total: { amount: 2500, currency: currency("EUR") } }],
      accountUrl: "https://shop.test/account",
      brand: { siteName: "Test Shop" },
    });

    expect(magicLink).toMatchObject({
      template: "magic_link",
      subject: "Sign in to Test Shop",
    });
    expect(magicLink.text).toContain("https://shop.test/account/magic-link?token=secret");
    expect(order).toMatchObject({
      template: "order_confirmation",
      subject: "Order M-1001 confirmed",
    });
    expect(order.text).toContain("Ring");
    expect(
      renderMikaEmail("magic_link", {
        toEmail: "customer@example.com",
        url: "https://shop.test/login",
      }),
    ).toMatchObject({
      template: "magic_link",
    });
  });
});

describe("Mika agent manifest", () => {
  it("derives sanitized agent descriptors from operation metadata", () => {
    const manifest = createMikaAgentManifest();
    const operationNames = manifest.operations.map((operation) => operation.name);

    expect(manifest.version).toBe(MIKA_AGENT_MANIFEST_VERSION);
    expect(operationNames).toEqual(
      expect.arrayContaining([
        "catalog.sellables",
        "stock.availability",
        "cart.quote",
        "cart.add",
        "checkout.start",
        "checkout.preview",
        "account.get",
      ]),
    );
    expect(operationNames).not.toContain("webhook.receive");
    expect(operationNames).not.toContain("admin.providerHealth");

    const catalog = manifest.operations.find((operation) => operation.name === "catalog.sellables");
    const cartAdd = manifest.operations.find((operation) => operation.name === "cart.add");
    const cartQuote = manifest.operations.find((operation) => operation.name === "cart.quote");
    const checkoutStart = manifest.operations.find(
      (operation) => operation.name === "checkout.start",
    );
    const checkoutPreview = manifest.operations.find(
      (operation) => operation.name === "checkout.preview",
    );

    expect(catalog).toMatchObject({
      public: true,
      agent: {
        visible: "public",
        capability: "catalog:read",
        scopes: ["catalog:read"],
        effect: "read",
        risk: "none",
        requiredProofs: [],
      },
      route: {
        key: "catalogSellables",
        path: "catalog/sellables",
        httpMethod: "GET",
        transport: "search",
        searchKeys: ["collection", "id", "locale"],
      },
    });
    expect(cartAdd).toMatchObject({
      public: false,
      agent: {
        visible: "trusted",
        capability: "cart:write",
        confirmation: "host",
        idempotency: "recommended",
        idempotencyKey: {
          keyHeader: MIKA_AGENT_IDEMPOTENCY_KEY_HEADER,
          owner: "host",
        },
        scopes: ["cart:write"],
        requiredProofs: [],
      },
    });
    expect(cartAdd?.route).toBeUndefined();
    expect(cartQuote).toMatchObject({
      public: false,
      agent: {
        capability: "cart:read",
        effect: "read",
        resources: ["cart", "sellable", "price", "stock"],
        requiredProofs: [],
      },
    });
    expect(cartQuote?.route).toBeUndefined();
    expect(checkoutStart).toMatchObject({
      public: false,
      agent: {
        capability: "checkout:start",
        confirmation: "payment",
        idempotency: "required",
        acceptsProofs: ["consent", "mandate", "payment_authorization"],
        requiredProofs: [],
      },
    });
    expect(checkoutStart?.route).toBeUndefined();
    expect(checkoutPreview).toMatchObject({
      public: false,
      agent: {
        capability: "checkout:read",
        acceptsProofs: ["consent", "mandate", "payment_authorization"],
        requiredProofs: [],
      },
    });
    expect(checkoutPreview?.route).toBeUndefined();
    expect(JSON.stringify(manifest)).not.toContain("schema");
    expect(JSON.stringify(manifest)).not.toContain("call");
  });

  it("returns manifest descriptors without leaking mutable registry references", () => {
    const manifest = createMikaAgentManifest();
    const cartAdd = manifest.operations.find((operation) => operation.name === "cart.add");
    const catalog = manifest.operations.find((operation) => operation.name === "catalog.sellables");

    (cartAdd?.agent.resources as string[] | undefined)?.push("admin");
    (catalog?.route?.searchKeys as string[] | undefined)?.push("unexpected");

    const freshManifest = createMikaAgentManifest();
    const freshCartAdd = freshManifest.operations.find(
      (operation) => operation.name === "cart.add",
    );
    const freshCatalog = freshManifest.operations.find(
      (operation) => operation.name === "catalog.sellables",
    );

    expect(freshCartAdd?.agent.resources).toEqual(["cart", "sellable", "price"]);
    expect(freshCatalog?.route?.searchKeys).toEqual(["collection", "id", "locale"]);
  });

  it("exports a JSON-safe v1 manifest schema that validates generated manifests", () => {
    const schema = JSON.parse(JSON.stringify(mikaAgentManifestJsonSchema)) as {
      readonly properties: {
        readonly version: { readonly const: number };
      };
      readonly $defs: {
        readonly agentMetadata: {
          readonly required: readonly string[];
        };
      };
    };

    expect(schema.properties.version.const).toBe(MIKA_AGENT_MANIFEST_VERSION);
    expect(schema.$defs.agentMetadata.required).toEqual(
      expect.arrayContaining(["scopes", "resources", "requiredProofs"]),
    );
    expect(JSON.stringify(schema)).toContain(MIKA_AGENT_IDEMPOTENCY_KEY_HEADER);

    const validate = createAgentManifestValidator();
    for (const manifest of [
      createMikaAgentManifest(),
      createMikaAgentManifest({ include: ["public"] }),
      createMikaAgentManifest({ include: ["public", "trusted", "admin"] }),
      createMikaAgentManifest({ include: ["hidden"] }),
    ]) {
      expect(validate(manifest), JSON.stringify(validate.errors)).toBe(true);
    }
  });

  it("rejects manifest shapes that violate agent projection invariants", () => {
    const validate = createAgentManifestValidator();
    const expectInvalid = (manifest: MutableAgentManifest) => {
      expect(validate(manifest)).toBe(false);
    };

    const missingPublicRoute = mutableAgentManifest(
      createMikaAgentManifest({ include: ["public"] }),
    );
    delete findMutableOperation(missingPublicRoute, "catalog.sellables").route;
    expectInvalid(missingPublicRoute);

    const privateRouteLeak = mutableAgentManifest(createMikaAgentManifest());
    findMutableOperation(privateRouteLeak, "cart.add").route = {
      key: "cartItems",
      path: "cart/items",
      httpMethod: "POST",
      transport: "body",
    };
    expectInvalid(privateRouteLeak);

    const missingIdempotencyKey = mutableAgentManifest(createMikaAgentManifest());
    delete findMutableOperation(missingIdempotencyKey, "cart.add").agent["idempotencyKey"];
    expectInvalid(missingIdempotencyKey);

    const badEnum = mutableAgentManifest(createMikaAgentManifest());
    findMutableOperation(badEnum, "cart.add").agent["risk"] = "tiny";
    expectInvalid(badEnum);

    const missingSearchKeys = mutableAgentManifest(
      createMikaAgentManifest({ include: ["public"] }),
    );
    const missingSearchRoute = findMutableOperation(missingSearchKeys, "catalog.sellables").route;
    if (!missingSearchRoute) throw new Error("Missing public route fixture.");
    delete missingSearchRoute["searchKeys"];
    expectInvalid(missingSearchKeys);

    const nonSearchWithSearchKeys = mutableAgentManifest(
      createMikaAgentManifest({ include: ["public"] }),
    );
    const nonSearchRoute = findMutableOperation(nonSearchWithSearchKeys, "catalog.sellables").route;
    if (!nonSearchRoute) throw new Error("Missing public route fixture.");
    nonSearchRoute["transport"] = "body";
    expectInvalid(nonSearchWithSearchKeys);
  });

  it("can include admin descriptors only when requested", () => {
    const manifest = createMikaAgentManifest({ include: ["public", "trusted", "admin"] });

    expect(manifest.operations.map((operation) => operation.name)).toContain(
      "admin.providerHealth",
    );
    expect(
      manifest.operations.find((operation) => operation.name === "admin.providerHealth"),
    ).toMatchObject({
      public: false,
      agent: {
        visible: "admin",
        capability: "admin:read",
        requiresActor: "admin",
      },
    });
    expect(
      manifest.operations.find((operation) => operation.name === "admin.providerHealth")?.route,
    ).toBeUndefined();
  });
});

describe("public types", () => {
  it("keeps the package export map curated", () => {
    const packageJson = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ) as {
      readonly exports: Record<string, unknown>;
    };
    const exportsMap = packageJson.exports;

    expect(Object.keys(exportsMap).sort()).toEqual(
      [
        ".",
        "./acp",
        "./agent",
        "./admin",
        "./astro",
        "./astro-actions",
        "./client",
        "./email",
        "./provider",
        "./react",
        "./server",
        "./stripe",
        "./templates/astro/*",
        "./types",
        "./types/aggregates",
        "./types/documents",
        "./types/operational",
      ].sort(),
    );
    expect(exportsMap).not.toHaveProperty("./api");
    expect(exportsMap).not.toHaveProperty("./model");
    expect(exportsMap).not.toHaveProperty("./storage");

    for (const [subpath, entry] of Object.entries(exportsMap)) {
      if (subpath === "./templates/astro/*") continue;
      const conditions = entry as Record<string, unknown>;
      expect(Object.keys(conditions)).toEqual(["types", "import"]);
      expect(conditions["types"]).toEqual(expect.stringMatching(/^\.\/dist\/.+\.d\.mts$/));
      expect(conditions["import"]).toEqual(expect.stringMatching(/^\.\/dist\/.+\.mjs$/));
    }
  });

  it("keeps the source-facing client and action types aligned", () => {
    const client = createMikaClient();

    expectTypeOf(client).toMatchTypeOf<MikaClient>();
    expectTypeOf<ReturnType<typeof createMikaAgentManifest>>().toEqualTypeOf<MikaAgentManifest>();
    expectTypeOf<typeof PackageMikaAgentManifestJsonSchema>().toEqualTypeOf<
      typeof mikaAgentManifestJsonSchema
    >();
    expectTypeOf<typeof mikaAgentManifestJsonSchema>().toEqualTypeOf<MikaAgentManifestJsonSchema>();
    expectTypeOf<PackageMikaAgentManifestJsonSchemaType>().toEqualTypeOf<MikaAgentManifestJsonSchema>();
    expectTypeOf<MikaAgentActionDescriptor["agent"]>().toEqualTypeOf<MikaAgentOperationMetadata>();
    expectTypeOf<MikaPaymentAuthorizationRef["kind"]>().toEqualTypeOf<"payment_authorization">();
    expectTypeOf<MikaActionRun["status"]>().toEqualTypeOf<
      (typeof MIKA_ACTION_RUN_STATUSES)[number]
    >();
    expectTypeOf<MikaAgentApprovalRef["status"]>().toEqualTypeOf<
      (typeof MIKA_AGENT_APPROVAL_STATUSES)[number]
    >();
    expectTypeOf<PackageMikaAgentActionDescriptor>().toEqualTypeOf<MikaAgentActionDescriptor>();
    expectTypeOf<PackageMikaActorContext>().toEqualTypeOf<MikaActorContext>();
    expectTypeOf<PackageMikaPaymentAuthorizationRef>().toEqualTypeOf<MikaPaymentAuthorizationRef>();
    expectTypeOf<ReturnType<typeof createMikaActions>>().toMatchTypeOf<MikaActions>();
    expectTypeOf<ReturnType<typeof createMikaActions>["catalog"]["sellables"]>().toBeObject();
    expectTypeOf<ReturnType<typeof createMikaActions>["checkout"]["status"]>().toBeObject();
    expectTypeOf<ReturnType<typeof createMikaActions>["account"]["exportStatus"]>().toBeObject();
    expectTypeOf<Awaited<ReturnType<MikaServerClient["cart"]["get"]>>>().toEqualTypeOf<
      MikaApiResult<CartDTO>
    >();
    expectTypeOf<Awaited<ReturnType<MikaServerClient["cart"]["quote"]>>>().toEqualTypeOf<
      MikaApiResult<CartQuoteDTO>
    >();
    expectTypeOf<Parameters<MikaServerClient["cart"]["quote"]>[0]>().toEqualTypeOf<
      CartQuoteInput | undefined
    >();
    expectTypeOf<Awaited<ReturnType<MikaServerClient["checkout"]["preview"]>>>().toEqualTypeOf<
      MikaApiResult<CheckoutPreviewDTO>
    >();
    expectTypeOf<Parameters<MikaServerClient["checkout"]["preview"]>[0]>().toEqualTypeOf<
      CheckoutPreviewInput | undefined
    >();
    expectTypeOf<CheckoutPreviewProofRequirementDTO["kind"]>().toEqualTypeOf<
      (typeof MIKA_AGENT_PROOF_KINDS)[number]
    >();
    expectTypeOf<Awaited<ReturnType<MikaServerClient["admin"]["providerHealth"]>>>().toEqualTypeOf<
      MikaApiResult<ProviderHealthDTO>
    >();
    expectTypeOf<DownloadResolutionDTO>().toEqualTypeOf<{
      readonly title?: string;
      readonly redirectUrl?: string;
      readonly expiresAt?: ISODateTime;
    }>();
    expectTypeOf<ReturnType<typeof defineMikaProvider>>().toMatchTypeOf<MikaProviderAdapter>();
    expectTypeOf<ReturnType<typeof createMikaAcpProductFeed>["products"]>().toEqualTypeOf<
      readonly MikaAcpProduct[]
    >();
    expectTypeOf<ReturnType<typeof createMikaAcpCheckoutHandlers>["create"]>().toBeFunction();
    expectTypeOf<ReturnType<typeof createMemoryMikaAcpSessionStore>["get"]>().toBeFunction();
    expectTypeOf<
      ReturnType<typeof createMikaStripeProvider>
    >().toMatchTypeOf<MikaProviderAdapter>();
    expectTypeOf<NonNullable<MikaStripeClient["checkout"]>>().toMatchTypeOf<{
      readonly sessions: unknown;
    }>();
    expectTypeOf<keyof MikaProviderCheckoutSession>().toEqualTypeOf<
      | "id"
      | "status"
      | "mode"
      | "provider"
      | "redirectUrl"
      | "expiresAt"
      | "providerCheckoutId"
      | "providerCustomerId"
      | "raw"
    >();
    expectTypeOf<typeof MikaReactProvider>().toBeFunction();
    expectTypeOf<ReturnType<typeof useMikaStock>>().toEqualTypeOf<
      MikaClient["stock"]["availability"]
    >();
    expectTypeOf<
      Parameters<MikaServerClient["wishlist"]["remove"]>[0]
    >().toEqualTypeOf<RemoveWishlistItemInput>();
    expectTypeOf<(typeof MIKA_ERROR_CODES)[number]>().toEqualTypeOf<MikaErrorCode>();
    expectTypeOf<
      (typeof MIKA_PROVIDER_CAPABILITIES)[number]
    >().toEqualTypeOf<MikaProviderCapability>();
    expectTypeOf<keyof typeof mikaAdminActionDefinitions>().toEqualTypeOf<MikaAdminActionId>();
    expectTypeOf<keyof typeof mikaEmailTemplates>().toEqualTypeOf<
      "magic_link" | "order_confirmation"
    >();
    expectTypeOf<MikaEmailInput<"magic_link">>().toEqualTypeOf<
      Parameters<typeof renderMikaMagicLinkEmail>[0]
    >();
    expectTypeOf<MikaNotificationKind>().toEqualTypeOf<
      | "magic_link.requested"
      | "order.confirmed"
      | "checkout.payment_failed"
      | "download.ready"
      | "license.issued"
      | "subscription.started"
      | "subscription.updated"
      | "subscription.renewal_failed"
      | "account.export_ready"
      | "account.delete_requested"
      | "ops.webhook_failed"
    >();
    expectTypeOf<MikaNotificationIntent<"magic_link.requested">["context"]>().toMatchTypeOf<{
      readonly toEmail: string;
      readonly link: string;
      readonly purpose: string;
      readonly expiresAt: ISODateTime;
      readonly tokenId: MikaId;
      readonly returnTo?: string;
    }>();
    expectTypeOf<(typeof mikaApiMethodNames)["admin"][number]>().toEqualTypeOf<
      keyof MikaApi["admin"]
    >();
    expectTypeOf<(typeof mikaApiMethodNames)["catalog"][number]>().toEqualTypeOf<
      keyof MikaApi["catalog"]
    >();
    expectTypeOf<MikaActionName>().toEqualTypeOf<
      | "catalog.sellables"
      | "stock.availability"
      | "cart.add"
      | "cart.update"
      | "cart.remove"
      | "cart.merge"
      | "cart.applyCoupon"
      | "cart.removeCoupon"
      | "wishlist.add"
      | "wishlist.remove"
      | "wishlist.moveToCart"
      | "wishlist.saveForLater"
      | "wishlist.merge"
      | "checkout.start"
      | "checkout.status"
      | "magicLink.request"
      | "magicLink.verify"
      | "account.export"
      | "account.exportStatus"
      | "account.delete"
      | "account.portal"
      | "subscription.cancel"
      | "subscription.change"
      | "subscription.renew"
      | "download.confirm"
    >();
    expectTypeOf<Parameters<ReturnType<typeof createMika>["routes"]>[0]>().toEqualTypeOf<
      (typeof publicMikaPluginRouteNames)[number]
    >();
    expectTypeOf<MikaAstroClientOptions["operationPolicy"]>().toEqualTypeOf<
      MikaOperationPolicy | undefined
    >();
    expectTypeOf<ReturnType<typeof mikaHiddenInput>>().toEqualTypeOf<{
      name: string;
      value: string;
    }>();
    expectTypeOf<ReturnType<typeof mikaReturnToInput>>().toEqualTypeOf<
      ReturnType<typeof mikaHiddenInput>
    >();
    expectTypeOf<ReturnType<typeof mikaRedirectInputs>>().toEqualTypeOf<{
      successPath: ReturnType<typeof mikaHiddenInput>;
      cancelPath: ReturnType<typeof mikaHiddenInput>;
      returnTo: ReturnType<typeof mikaHiddenInput>;
    }>();
    expectTypeOf<string>().not.toMatchTypeOf<MikaId>();
    expectTypeOf<string>().not.toMatchTypeOf<CurrencyCode>();
    expectTypeOf<string>().not.toMatchTypeOf<ProviderName>();
    expectTypeOf<string>().not.toMatchTypeOf<ISODateTime>();
    expectTypeOf<ReturnType<typeof createMikaId>>().toEqualTypeOf<MikaId>();
    expectTypeOf<ReturnType<typeof createCurrencyCode>>().toEqualTypeOf<CurrencyCode>();
    expectTypeOf<ReturnType<typeof createProviderName>>().toEqualTypeOf<ProviderName>();
    expectTypeOf<ReturnType<typeof createISODateTime>>().toEqualTypeOf<ISODateTime>();
  });

  it("keeps package subpath imports aligned with public entries", () => {
    expectTypeOf<typeof PackageMikaPlugin>().toBeFunction();
    expectTypeOf<typeof PackageCreateMikaAgentManifest>().toEqualTypeOf<
      typeof createMikaAgentManifest
    >();
    expectTypeOf<typeof PackageCreateMikaAcpProductFeed>().toEqualTypeOf<
      typeof createMikaAcpProductFeed
    >();
    expectTypeOf<typeof PackageCreateMikaAcpCheckoutHandlers>().toEqualTypeOf<
      typeof createMikaAcpCheckoutHandlers
    >();
    expectTypeOf<typeof PackageCreateMikaAdminActionsManifest>().toBeFunction();
    expectTypeOf<typeof PackageCreateMika>().toBeFunction();
    expectTypeOf<typeof PackageMikaSafeReturnTo>().toEqualTypeOf<typeof mikaSafeReturnTo>();
    expectTypeOf<typeof PackageMikaHiddenInput>().toEqualTypeOf<typeof mikaHiddenInput>();
    expectTypeOf<typeof PackageMikaReturnToInput>().toEqualTypeOf<typeof mikaReturnToInput>();
    expectTypeOf<typeof PackageMikaRedirectInputs>().toEqualTypeOf<typeof mikaRedirectInputs>();
    expectTypeOf<typeof PackageCreateMikaActions>().toBeFunction();
    expectTypeOf<typeof PackageCreateMikaClient>().toBeFunction();
    expectTypeOf<typeof PackageRenderMikaEmail>().toBeFunction();
    expectTypeOf<typeof PackageCreateMikaProviderRegistry>().toBeFunction();
    expectTypeOf<typeof PackageMikaProvider>().toBeFunction();
    expectTypeOf<typeof PackageAssertMikaApiWired>().toEqualTypeOf<typeof assertMikaApiWired>();
    expectTypeOf<typeof PackageCreateMikaServerClient>().toBeFunction();
    expectTypeOf<typeof PackageCreateMikaBackendApi>().toEqualTypeOf<typeof createMikaBackendApi>();
    expectTypeOf<typeof PackageCreateMikaEmailOutboxRunner>().toEqualTypeOf<
      typeof createMikaEmailOutboxRunner
    >();
    expectTypeOf<typeof PackageCreateMikaMaintenanceRunner>().toEqualTypeOf<
      typeof createMikaMaintenanceRunner
    >();
    expectTypeOf<typeof PackageCreateEmDashMikaEmailSender>().toEqualTypeOf<
      typeof createEmDashMikaEmailSender
    >();
    expectTypeOf<PackageMikaBackendDependencies>().toEqualTypeOf<MikaBackendDependencies>();
    expectTypeOf<PackageMikaNotificationKind>().toEqualTypeOf<MikaNotificationKind>();
    expectTypeOf<PackageMikaNotificationIntent>().toEqualTypeOf<MikaNotificationIntent>();
    expectTypeOf<PackageMikaNotificationHook>().toEqualTypeOf<MikaNotificationHook>();
    expectTypeOf<typeof PackageMikaApiMethodNames>().toEqualTypeOf<typeof mikaApiMethodNames>();
    expectTypeOf<PackageMikaAstroClientOptions>().toEqualTypeOf<MikaAstroClientOptions>();
    expectTypeOf<PackageRootMikaOperationDescriptor>().toEqualTypeOf<MikaOperationDescriptor>();
    expectTypeOf<PackageServerMikaOperationDescriptor>().toEqualTypeOf<MikaOperationDescriptor>();
    expectTypeOf<PackageRootMikaOperationPolicy>().toEqualTypeOf<MikaOperationPolicy>();
    expectTypeOf<PackageServerMikaOperationPolicy>().toEqualTypeOf<MikaOperationPolicy>();
    expectTypeOf<typeof PACKAGE_MIKA_ERROR_CODES>().toEqualTypeOf<typeof MIKA_ERROR_CODES>();
    expectTypeOf<typeof PackageCreateMikaId>().toEqualTypeOf<typeof createMikaId>();
    expectTypeOf<typeof PackageCreateMikaStripeProvider>().toEqualTypeOf<
      typeof createMikaStripeProvider
    >();
  });
});

describe("createISODateTime canonicalization", () => {
  it("normalizes a UTC-offset timestamp to canonical Z so string expiry comparisons stay correct", () => {
    expect(createISODateTime("2026-06-29T23:00:00+14:00")).toBe("2026-06-29T09:00:00.000Z");
  });

  it("adds milliseconds to a second-precision Z timestamp", () => {
    expect(createISODateTime("2026-06-29T10:00:00Z")).toBe("2026-06-29T10:00:00.000Z");
  });

  it("is idempotent for an already-canonical timestamp", () => {
    expect(createISODateTime("2026-06-29T10:00:00.000Z")).toBe("2026-06-29T10:00:00.000Z");
  });

  it("rejects impossible calendar dates instead of rolling them forward", () => {
    expect(() => createISODateTime("2026-02-30T00:00:00Z")).toThrow("Invalid ISODateTime");
    expect(isISODateTime("2026-02-30T00:00:00Z")).toBe(false);
  });

  it("still rejects values that are not ISO date-times", () => {
    expect(() => createISODateTime("not-a-date")).toThrow("Invalid ISODateTime");
    expect(() => createISODateTime("2026-06-29")).toThrow("Invalid ISODateTime");
  });

  it("aligns the isISODateTime guard with what createISODateTime actually produces", () => {
    const canonical = createISODateTime("2026-06-29T12:00:00+02:00");
    expect(canonical).toBe("2026-06-29T10:00:00.000Z");
    expect(isISODateTime(canonical)).toBe(true);

    // createISODateTime canonicalizes offsets and non-millisecond forms away; a value that
    // merely parses but was never actually canonicalized must not pass the brand guard.
    expect(isISODateTime("2026-06-29T12:00:00+02:00")).toBe(false);
    expect(isISODateTime("2026-06-29T10:00:00Z")).toBe(false);
  });
});

describe("Mika Astro template contracts", () => {
  it("keeps Astro Actions on the request-bound API instead of private JSON routes", () => {
    const source = readFileSync(new URL("../src/astro-actions.ts", import.meta.url), "utf8");
    const operationsSource = readFileSync(
      new URL("../src/api/operations.ts", import.meta.url),
      "utf8",
    );

    expect(source).toContain("createMikaRequestContext");
    expect(source).toContain("createMikaApi");
    expect(source).not.toContain("createMikaClient");
    expect(source).toContain("normalizeMikaActionInput");
    expect(source).not.toContain("const purchaseSellableId = parsePurchaseMikaId");
    expect(operationsSource).toContain("const purchaseSellableId = parsePurchaseMikaId");
    expect(operationsSource).toContain("normalizeCheckoutStartActionInput");
  });

  it("documents the Kumo core copy path separately from contract examples", () => {
    const source = readFileSync(
      new URL("../src/templates/astro/README.md", import.meta.url),
      "utf8",
    );

    expect(source).toContain("Core product flow:");
    expect(source).toContain("styles/kumo.css");
    expect(source).toContain("components/MikaKumoAppFrame.tsx");
    expect(source).toContain("components/MikaKumoPage.astro");
    expect(source).toContain("components/ProductPurchase.astro");
    expect(source).toContain("components/AddToCartForm.astro");
    expect(source).toContain("components/BuyNowForm.astro");
    expect(source).toContain("components/WishlistForm.astro");
    expect(source).toContain("components/AccountSignInPanel.astro");
    expect(source).toContain("Contract examples such as `CouponForm`, `CheckoutForm`");
    expect(source).toContain("account export/delete");
    expect(source).toContain("pages/account/orders.astro");
    expect(source).toContain("pages/account/subscriptions.astro");
    expect(source).toContain("pages/account/licenses.astro");
    expect(source).toContain("pages/account/downloads.astro");
    expect(source).toContain("webhook endpoint");
    expect(source).toContain("coordinates hidden");
    expect(source).toContain("grouped variant selection");
    expect(source).toContain("Agent-readable storefront flow:");
    expect(source).toContain("components/ProductStructuredData.astro");
    expect(source).toContain("pages/.well-known/mika-agent.json.ts");
    expect(source).toContain("Install and enable Kumo UI");
    expect(source).toContain("@cloudflare/kumo/styles/standalone");
    expect(source).toContain("@cloudflare/kumo/styles/tailwind");
    expect(source).toContain("Mika.webhook.receive");
    expect(source).toContain("order.invoiceHref");
    expect(source).toContain("protected `order.invoice` route");
  });

  it("ships the Kumo app shell around copied pages", () => {
    const page = readFileSync(
      new URL("../src/templates/astro/components/MikaKumoPage.astro", import.meta.url),
      "utf8",
    );
    const frame = readFileSync(
      new URL("../src/templates/astro/components/MikaKumoAppFrame.tsx", import.meta.url),
      "utf8",
    );
    const styles = readFileSync(
      new URL("../src/templates/astro/styles/kumo.css", import.meta.url),
      "utf8",
    );
    const cartHelper = readFileSync(
      new URL("../src/templates/astro/lib/cart.ts", import.meta.url),
      "utf8",
    );
    const cartPage = readFileSync(
      new URL("../src/templates/astro/pages/cart.astro", import.meta.url),
      "utf8",
    );
    const wishlistPage = readFileSync(
      new URL("../src/templates/astro/pages/wishlist.astro", import.meta.url),
      "utf8",
    );
    const tsconfig = readFileSync(new URL("../tsconfig.json", import.meta.url), "utf8");

    expect(page).toContain('import MikaKumoAppFrame from "./MikaKumoAppFrame"');
    expect(page).not.toContain('import { createMika } from "@bnomei/emdash-mika/astro"');
    expect(page).toContain("cartItemCount?: number");
    expect(page).not.toContain("productNavItems?: readonly MikaKumoNavItem[]");
    expect(page).toContain("<MikaKumoAppFrame");
    expect(page).toContain("client:load");
    expect(page).toContain("cartItemCount={cartItemCount}");
    expect(page).toContain("{cartLabel}");
    expect(page).toContain('aria-label="Page shortcuts"');

    expect(frame).toContain("<Sidebar.Provider");
    expect(frame).toContain("cartItemCount = 0");
    expect(frame).toContain("Cart (${visibleCartItemCount})");
    expect(frame).toContain("aria-label={cartAriaLabel}");
    expect(frame).toContain("mobileBreakpoint={900}");
    expect(frame).toContain('tooltip="Products"');
    expect(frame).toContain('href="/account/orders"');
    expect(frame).toContain('href="/account/subscriptions"');
    expect(frame).toContain('href="/account/licenses"');
    expect(frame).toContain('href="/account/downloads"');
    expect(frame).not.toContain("function ProductsSidebarMenu");
    expect(frame).not.toContain("const [productsOpen, setProductsOpen]");
    expect(frame).not.toContain("aria-controls={productMenuId}");
    expect(frame).not.toContain("All products");
    expect(frame).toContain("mika-kumo-mobile-topbar");

    expect(cartHelper).toContain("mikaTemplateCurrentCartItemCount");
    expect(cartHelper).toContain('import { createMika } from "@bnomei/emdash-mika/astro"');
    expect(cartPage).toContain("cartItemCount={itemCount}");
    expect(wishlistPage).toContain("mikaTemplateCurrentCartItemCount");

    expect(styles).toContain(".mika-kumo-app-frame");
    expect(styles).toContain(".mika-kumo-mobile-topbar");
    expect(styles).toContain(".mika-kumo-footer");
    expect(styles).toContain(".mika-kumo-table-scroll");
    expect(styles).not.toContain(".mika-kumo-products-caret");
    expect(tsconfig).toContain('"src/**/*.tsx"');
  });

  it("ships copyable agent-readable storefront examples", () => {
    const structuredData = readFileSync(
      new URL("../src/templates/astro/components/ProductStructuredData.astro", import.meta.url),
      "utf8",
    );
    const llms = readFileSync(
      new URL("../src/templates/astro/pages/llms.txt.ts", import.meta.url),
      "utf8",
    );
    const wellKnown = readFileSync(
      new URL("../src/templates/astro/pages/.well-known/mika-agent.json.ts", import.meta.url),
      "utf8",
    );

    expect(structuredData).toContain('type="application/ld+json"');
    expect(structuredData).toContain('"@type": "Product"');
    expect(structuredData).toContain('"@type": "ProductGroup"');
    expect(structuredData).toContain('"@type": "Offer"');
    expect(structuredData).toContain('"@type": "AggregateOffer"');
    expect(structuredData).toContain("productGroupID");
    expect(structuredData).toContain("inProductGroupWithID");
    expect(structuredData).toContain("hasVariant");
    expect(structuredData).toContain("isVariantOf");
    expect(structuredData).toContain("additionalProperty");
    expect(structuredData).toContain("variantSchemaProperties");
    expect(structuredData).toContain("https://schema.org/color");
    expect(structuredData).toContain("https://schema.org/size");
    expect(structuredData).toContain("priceValidUntil");
    expect(structuredData).toContain("shippingDetails");
    expect(structuredData).toContain("hasMerchantReturnPolicy");
    expect(structuredData).toContain("UnitPriceSpecification");
    expect(structuredData).toContain('replaceAll("<", "\\\\u003C")');
    expect(structuredData).toContain("https://schema.org/InStock");
    expect(structuredData).toContain("https://schema.org/LimitedAvailability");
    expect(llms).toContain("[Agent capability manifest](/.well-known/mika-agent.json)");
    expect(llms).toContain("mikaAgentManifestJsonSchema");
    expect(llms).toContain("MIKA_AGENT_MANIFEST_VERSION");
    expect(llms).toContain("ProductStructuredData JSON-LD");
    expect(llms).toContain("/_emdash/api/plugins/mika/");
    expect(llms).toContain("Trusted agent projections: cart.quote and checkout.preview");
    expect(llms).toContain("Astro Actions submitted by HTML forms");
    expect(wellKnown).toContain('from "@bnomei/emdash-mika/agent"');
    expect(wellKnown).toContain("mikaAgentManifestJsonSchema");
    expect(wellKnown).toContain("MIKA_AGENT_MANIFEST_VERSION");
    expect(wellKnown).toContain("routeBasePath");
    expect(wellKnown).toContain("protectedFlowSummaries");
    expect(wellKnown).toContain("checkout.start");
    expect(wellKnown).toContain("order.invoice");
    expect(wellKnown).toContain('createMikaAgentManifest({ include: ["public"] })');
    expect(wellKnown).toContain("host OAuth or session policy");
  });

  it("keeps template imports on public package subpaths", () => {
    const packageJson = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ) as {
      readonly name: string;
      readonly exports: Record<string, unknown>;
    };
    const publicImports = new Set(
      Object.keys(packageJson.exports)
        .filter((subpath) => subpath !== "./templates/astro/*")
        .map((subpath) =>
          subpath === "." ? packageJson.name : `${packageJson.name}/${subpath.slice(2)}`,
        ),
    );
    const templateSources = sourceFiles(new URL("../src/templates/astro/", import.meta.url)).filter(
      (file) =>
        file.pathname.endsWith(".astro") ||
        file.pathname.endsWith(".ts") ||
        file.pathname.endsWith(".tsx"),
    );

    for (const file of templateSources) {
      const source = readFileSync(file, "utf8");
      const imports = source.matchAll(/from\s+["'](@bnomei\/emdash-mika(?:\/[^"']+)?)["']/g);

      for (const [, specifier] of imports) {
        if (!specifier) continue;
        expect(publicImports.has(specifier)).toBe(true);
      }
    }
  });

  it("keeps copied template route defaults centralized", () => {
    const routeDefaults = readFileSync(
      new URL("../src/templates/astro/lib/routes.ts", import.meta.url),
      "utf8",
    );
    const buyNow = readFileSync(
      new URL("../src/templates/astro/components/BuyNowForm.astro", import.meta.url),
      "utf8",
    );
    const checkout = readFileSync(
      new URL("../src/templates/astro/components/CheckoutForm.astro", import.meta.url),
      "utf8",
    );
    const account = readFileSync(
      new URL("../src/templates/astro/pages/account.astro", import.meta.url),
      "utf8",
    );
    const accountOrders = readFileSync(
      new URL("../src/templates/astro/pages/account/orders.astro", import.meta.url),
      "utf8",
    );
    const accountSubscriptions = readFileSync(
      new URL("../src/templates/astro/pages/account/subscriptions.astro", import.meta.url),
      "utf8",
    );
    const accountLicenses = readFileSync(
      new URL("../src/templates/astro/pages/account/licenses.astro", import.meta.url),
      "utf8",
    );
    const accountDownloads = readFileSync(
      new URL("../src/templates/astro/pages/account/downloads.astro", import.meta.url),
      "utf8",
    );
    const checkoutSuccess = readFileSync(
      new URL("../src/templates/astro/pages/checkout/success.astro", import.meta.url),
      "utf8",
    );
    const checkoutCancel = readFileSync(
      new URL("../src/templates/astro/pages/checkout/cancel.astro", import.meta.url),
      "utf8",
    );
    const accountOrdersComponent = readFileSync(
      new URL("../src/templates/astro/components/AccountOrders.astro", import.meta.url),
      "utf8",
    );

    expect(routeDefaults).toContain('account: "/account"');
    expect(routeDefaults).toContain('accountOrders: "/account/orders"');
    expect(routeDefaults).toContain('accountSubscriptions: "/account/subscriptions"');
    expect(routeDefaults).toContain('accountLicenses: "/account/licenses"');
    expect(routeDefaults).toContain('accountDownloads: "/account/downloads"');
    expect(routeDefaults).toContain('wishlist: "/wishlist"');
    expect(routeDefaults).toContain('products: "/"');
    expect(routeDefaults).toContain('checkoutSuccess: "/checkout/success"');
    expect(buyNow).toContain("mikaTemplateRoutes.checkoutSuccess");
    expect(checkout).toContain("mikaTemplateRoutes.checkoutCancel");
    expect(account).toContain("mikaTemplateRoutes.account");
    expect(account).not.toContain("<AccountOrders");
    expect(account).not.toContain("<AccountSubscriptions");
    expect(account).not.toContain("<AccountLicenses");
    expect(account).not.toContain("<AccountDownloads");
    expect(accountOrders).toContain("mikaTemplateRoutes.accountOrders");
    expect(accountOrders).toContain("<AccountOrders");
    expect(accountSubscriptions).toContain("mikaTemplateRoutes.accountSubscriptions");
    expect(accountSubscriptions).toContain("<AccountSubscriptions");
    expect(accountLicenses).toContain("mikaTemplateRoutes.accountLicenses");
    expect(accountLicenses).toContain("<AccountLicenses");
    expect(accountDownloads).toContain("mikaTemplateRoutes.accountDownloads");
    expect(accountDownloads).toContain("<AccountDownloads");
    expect(checkoutSuccess).toContain("mikaTemplateCheckoutSuccessHref");
    expect(checkoutSuccess).toContain("mikaTemplateRoutes.accountOrders");
    expect(checkoutSuccess).toContain('Astro.url.searchParams.get("checkoutId")');
    expect(checkoutSuccess).toContain('Astro.url.searchParams.get("token")');
    expect(checkoutSuccess).toContain("Checkout status link is missing.");
    expect(checkoutSuccess).toContain("refreshHref");
    expect(checkoutSuccess).not.toContain("checkout_id");
    expect(checkoutSuccess).not.toContain("session_id");
    expect(checkoutSuccess).toContain('import { Link, Text } from "@cloudflare/kumo"');
    expect(checkoutCancel).toContain('Astro.url.searchParams.get("checkoutId")');
    expect(checkoutCancel).toContain('Astro.url.searchParams.get("token")');
    expect(checkoutCancel).toContain("Mika.checkout.cancel({ checkoutId, token })");
    expect(checkoutCancel).toContain("Checkout cancel link is missing.");
    expect(checkoutCancel).toContain("No payment was confirmed by this return page.");
    expect(checkoutCancel).toContain(
      "Payment was completed before this cancellation could be applied.",
    );
    expect(checkoutCancel).toContain('import { Link, Text } from "@cloudflare/kumo"');
    expect(accountOrdersComponent).toContain("order.invoiceHref");
    expect(accountOrdersComponent).not.toContain("order.invoiceUrl");
    expect(accountOrdersComponent).toContain(
      'import { Badge, Empty, Link, Table, Text } from "@cloudflare/kumo"',
    );
  });

  it("keeps form accessibility hooks wired in copied templates", () => {
    const magicLink = readFileSync(
      new URL("../src/templates/astro/components/MagicLinkForm.astro", import.meta.url),
      "utf8",
    );
    const checkout = readFileSync(
      new URL("../src/templates/astro/components/CheckoutForm.astro", import.meta.url),
      "utf8",
    );
    const account = readFileSync(
      new URL("../src/templates/astro/pages/account.astro", import.meta.url),
      "utf8",
    );
    const accountSignIn = readFileSync(
      new URL("../src/templates/astro/components/AccountSignInPanel.astro", import.meta.url),
      "utf8",
    );

    expect(magicLink).toContain('"mika-magic-link-email"');
    expect(magicLink).toContain("aria-describedby={resolvedEmailErrorId}");
    expect(account).toContain("<AccountSignInPanel");
    expect(accountSignIn).toContain('id="mika-account-magic-link"');
    expect(checkout).toContain("customerLegend");
    expect(checkout).toContain('<legend class="mika-kumo-legend">{customerLegend}</legend>');
  });

  it("ships clearer cart and wishlist customer tasks", () => {
    const cartLines = readFileSync(
      new URL("../src/templates/astro/components/CartLines.astro", import.meta.url),
      "utf8",
    );
    const cartPage = readFileSync(
      new URL("../src/templates/astro/pages/cart.astro", import.meta.url),
      "utf8",
    );
    const wishlistForm = readFileSync(
      new URL("../src/templates/astro/components/WishlistForm.astro", import.meta.url),
      "utf8",
    );
    const wishlistList = readFileSync(
      new URL("../src/templates/astro/components/WishlistList.astro", import.meta.url),
      "utf8",
    );
    const checkout = readFileSync(
      new URL("../src/templates/astro/components/CheckoutForm.astro", import.meta.url),
      "utf8",
    );

    expect(cartLines).toContain("Update quantity");
    expect(cartLines).toContain("Remove from cart");
    expect(cartLines).toContain("Move to wishlist");
    expect(cartLines).toContain("<Table>");
    expect(cartLines).toContain("title={emptyLabel}");
    expect(cartLines).not.toContain("Your cart is empty.");
    expect(cartPage).toContain("lineCount > 0");
    expect(cartPage).toContain("<CouponForm cart={cart} />");
    expect(cartPage).toContain("Browse products");
    expect(wishlistForm).toContain('label = "Save to wishlist"');
    expect(wishlistList).toContain("Remove from wishlist");
    expect(wishlistList).toContain("Save products here to compare or buy later.");
    expect(wishlistList).toContain("<Table>");
    expect(checkout).toContain('label = "Proceed to checkout"');
    expect(checkout).toContain('emailLabel = "Email address"');
    expect(checkout).toContain("<Input");
  });

  it("keeps grouped variant cross-form sync owned by ProductPurchase", () => {
    const variantGroupsSource = readFileSync(
      new URL("../src/templates/astro/components/VariantOptionGroups.astro", import.meta.url),
      "utf8",
    );
    const productPurchaseSource = readFileSync(
      new URL("../src/templates/astro/components/ProductPurchase.astro", import.meta.url),
      "utf8",
    );
    const productPurchaseSyncSource = readFileSync(
      new URL("../src/templates/astro/components/ProductPurchaseSync.astro", import.meta.url),
      "utf8",
    );

    expect(variantGroupsSource).toContain("root.dispatchEvent(");
    expect(variantGroupsSource).toContain('"mika:variant-change"');
    expect(variantGroupsSource).not.toContain('closest("[data-mika-product-purchase]")');
    expect(variantGroupsSource).not.toContain("[data-mika-purchase-submit]");
    expect(variantGroupsSource).not.toContain("[data-mika-purchase-quantity]");
    expect(variantGroupsSource).not.toContain("[data-mika-availability-for]");
    expect(variantGroupsSource).not.toContain("syncInputs");

    expect(productPurchaseSource).toContain("<mika-product-purchase");
    expect(productPurchaseSource).toContain("needsPurchaseSync");
    expect(productPurchaseSource).toContain("<ProductPurchaseSync />");

    expect(productPurchaseSyncSource).toContain("customElements.define(");
    expect(productPurchaseSyncSource).toContain('"mika-product-purchase"');
    expect(productPurchaseSyncSource).toContain("[data-mika-variant-groups]");
    expect(productPurchaseSyncSource).not.toContain("JSON.parse");
    expect(productPurchaseSyncSource).not.toContain("data-mika-sellables");
    expect(productPurchaseSyncSource).toContain("event.detail");
    expect(productPurchaseSyncSource).toContain("groups.dataset.mikaSelectedSellableId");
    expect(productPurchaseSyncSource).toContain("sync(sellableId, priceId, maxQuantity);");
    expect(productPurchaseSyncSource).toContain('groups.addEventListener("mika:variant-change"');
    expect(productPurchaseSyncSource).toContain(
      'sellableId === "" || button.dataset.mikaInitialDisabled',
    );
    expect(productPurchaseSyncSource).toContain(
      "panel.hidden = panel.dataset.mikaAvailabilityFor !== sellableId;",
    );
  });

  it("keeps standalone grouped add-to-cart forms locally synchronized", () => {
    const addToCartSource = readFileSync(
      new URL("../src/templates/astro/components/AddToCartForm.astro", import.meta.url),
      "utf8",
    );
    const addToCartSyncSource = readFileSync(
      new URL("../src/templates/astro/components/AddToCartFormSync.astro", import.meta.url),
      "utf8",
    );

    expect(addToCartSource).toContain("purchase.useGroupedVariantControls");
    expect(addToCartSource).toContain("<noscript>");
    expect(addToCartSource).toContain("[data-mika-add-to-cart] [data-mika-variant-groups]");
    expect(addToCartSource).toContain('name="purchase"');
    expect(addToCartSource).toContain("needsAddToCartSync");
    expect(addToCartSource).toContain("<AddToCartFormSync />");
    expect(addToCartSyncSource).toContain('form.querySelector("[data-mika-variant-groups]")');
    expect(addToCartSyncSource).toContain('groups.addEventListener("mika:variant-change"');
    expect(addToCartSyncSource).toContain("event.detail");
    expect(addToCartSyncSource).toContain("groups.dataset.mikaSelectedSellableId");
    expect(addToCartSyncSource).toContain("[data-mika-purchase-submit]");
    expect(addToCartSyncSource).toContain("[data-mika-purchase-quantity]");
    expect(addToCartSyncSource).toContain("[data-mika-availability-for]");
    expect(addToCartSyncSource).toContain(
      "panel.hidden = panel.dataset.mikaAvailabilityFor !== sellableId;",
    );
    expect(addToCartSource).not.toContain('form.querySelector("[data-mika-variant-groups]")');
  });
});

function sourceFiles(root: URL): URL[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const url = new URL(`${entry.name}${entry.isDirectory() ? "/" : ""}`, root);
    return entry.isDirectory() ? sourceFiles(url) : [url];
  });
}

function expectSourceContract(
  source: string,
  contract: {
    readonly required?: readonly string[];
    readonly forbidden?: readonly string[];
  },
) {
  for (const required of contract.required ?? []) {
    expect(source).toContain(required);
  }
  for (const forbidden of contract.forbidden ?? []) {
    expect(source).not.toContain(forbidden);
  }
}
