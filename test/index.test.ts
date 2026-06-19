import { readdirSync, readFileSync } from "node:fs";
import Ajv2020 from "ajv/dist/2020";
import { describe, expect, expectTypeOf, it } from "vite-plus/test";
import {
  MIKA_PACKAGE_NAME,
  MIKA_PLUGIN_ID,
  MIKA_PLUGIN_VERSION,
  createPlugin,
  mikaPlugin,
} from "../src/index";
import type { mikaPlugin as PackageMikaPlugin } from "@bnomei/emdash-mika";
import type {
  createMikaAgentManifest as PackageCreateMikaAgentManifest,
  mikaAgentManifestJsonSchema as PackageMikaAgentManifestJsonSchema,
  MikaAgentActionDescriptor as PackageMikaAgentActionDescriptor,
  MikaAgentManifestJsonSchema as PackageMikaAgentManifestJsonSchemaType,
} from "@bnomei/emdash-mika/agent";
import type { createMikaAdminActionsManifest as PackageCreateMikaAdminActionsManifest } from "@bnomei/emdash-mika/admin";
import type { createMika as PackageCreateMika } from "@bnomei/emdash-mika/astro";
import type { createMikaClient as PackageCreateMikaClient } from "@bnomei/emdash-mika/client";
import type { renderMikaEmail as PackageRenderMikaEmail } from "@bnomei/emdash-mika/email";
import type { createMikaProviderRegistry as PackageCreateMikaProviderRegistry } from "@bnomei/emdash-mika/provider";
import type { MikaProvider as PackageMikaProvider } from "@bnomei/emdash-mika/react";
import type {
  createMikaBackendApi as PackageCreateMikaBackendApi,
  createMikaServerClient as PackageCreateMikaServerClient,
  mikaApiMethodNames as PackageMikaApiMethodNames,
  MikaBackendDependencies as PackageMikaBackendDependencies,
} from "@bnomei/emdash-mika/server";
import type {
  MIKA_ERROR_CODES as PACKAGE_MIKA_ERROR_CODES,
  MikaActorContext as PackageMikaActorContext,
  MikaPaymentAuthorizationRef as PackageMikaPaymentAuthorizationRef,
  createMikaId as PackageCreateMikaId,
} from "@bnomei/emdash-mika/types";
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
  createMikaBackendApi,
  createMikaRequestContext,
  createMikaApi,
  createMikaServerClient,
  mikaApiMethodNames,
  type MikaBackendDependencies,
  type MikaApi,
  type MikaApiOverrides,
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
  isMikaPurchasable,
  mikaMaxPurchaseQuantity,
  mikaReturnTo,
} from "../src/astro";
import {
  createMikaProviderRegistry,
  defineMikaProvider,
  type MikaProviderAdapter,
  type MikaProviderCheckoutSession,
} from "../src/provider";
import {
  createMikaPluginRouteBuilder,
  mikaPluginRoutes,
  mikaPluginRoute,
  publicMikaPluginRouteNames,
  type MikaPluginRouteName,
} from "../src/api/routes";
import {
  mikaActionDefinitions,
  mikaOperationDefinitions,
  mikaRoutedOperationDefinitions,
  mikaRouteOnlyDefinitions,
} from "../src/api/operations";
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
import {
  createCurrencyCode,
  createISODateTime,
  createMikaId,
  createProviderName,
  type CurrencyCode,
  type ISODateTime,
  type MikaId,
  type ProviderName,
} from "../src/types/primitives";
import { MikaCache } from "../src/storage/cache";
import { decodeAggregate, decodeJsonObject } from "../src/storage/json";
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

describe("Mika native plugin package", () => {
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
    const plugin = createPlugin();

    expect(plugin.id).toBe(MIKA_PLUGIN_ID);
    expect(plugin.version).toBe(MIKA_PLUGIN_VERSION);
    expect(Object.keys(plugin.routes)).toEqual(
      expect.arrayContaining([".well-known/actions", "cart", "wishlist", "checkout", "account"]),
    );
  });
});

describe("Mika Astro helpers", () => {
  it("preserves query strings in return targets", () => {
    expect(mikaReturnTo(new URL("https://shop.test/products/ring?size=5"))).toBe(
      "/products/ring?size=5",
    );
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
      createPlugin({ api });
      const Mika = createMika({
        request: new Request("https://shop.test/cart"),
        url: new URL("https://shop.test/cart"),
      });

      await expect(Mika.cart.get()).resolves.toMatchObject({
        ok: true,
        data: { id: "cart_1" },
      });
    } finally {
      createPlugin();
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
      createPlugin({ api: defaultApi });
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
      createPlugin();
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

    createPlugin({ api });
    createPlugin();

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
    expect("checkoutSuccess" in mikaPluginRoutes).toBe(false);
    expect("checkoutCancel" in mikaPluginRoutes).toBe(false);
  });

  it("derives route, API method, and action contracts from operation metadata", () => {
    expect(mikaPluginRoutes).toEqual({
      actionsManifest: ".well-known/actions",
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
      checkout: ["start", "preview", "status"],
      magicLink: ["request", "verify"],
      account: ["get", "export", "exportStatus", "exportDownload", "delete", "portal"],
      subscription: ["cancel", "change", "renew"],
      download: ["resolve"],
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
      "checkoutStatus|checkout.status|checkout.status|checkoutStatus|GET|search|trusted|noctx|checkoutId|json",
      "magicLinkRequest|magicLink.request|magicLink.request|magicLink|POST|body|trusted|ctx||form",
      "magicLinkVerify|magicLink.verify|magicLink.verify|magicLinkVerify|POST|body|trusted|ctx||form",
      "accountGet|account.get|account.get|account|GET|none|trusted|ctx||",
      "accountExport|account.export|account.export|accountExport|POST|body|trusted|ctx||form",
      "accountExportStatus|account.exportStatus|account.exportStatus|accountExportStatus|GET|search|trusted|ctx|exportId|json",
      "accountExportDownload|account.exportDownload|account.exportDownload|accountExportDownload|GET|search|trusted|ctx|exportId,token|",
      "accountDelete|account.delete|account.delete|accountDelete|POST|body|trusted|ctx||form",
      "accountPortal|account.portal|account.portal|accountPortal|POST|body|trusted|ctx||form",
      "subscriptionCancel|subscription.cancel|subscription.cancel|subscriptionCancel|POST|body|trusted|ctx||form",
      "subscriptionChange|subscription.change|subscription.change|subscriptionChange|POST|body|trusted|ctx||form",
      "subscriptionRenew|subscription.renew|subscription.renew|subscriptionRenew|POST|body|trusted|ctx||form",
      "downloadResolve|download.resolve|download.resolve|download|GET|search|trusted|noctx|token|",
      "orderInvoice|order.invoice|order.invoice|orderInvoice|GET|search|trusted|noctx|orderId,returnTo|",
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
    ]);
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

    const methodsFromOperations = Object.values(mikaOperationDefinitions)
      .map((operation) => `${operation.namespace}.${operation.method}`)
      .sort();
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

    for (const key of Object.keys(mikaActionDefinitions)) {
      expect(astroActionsSource).toContain(`mikaActionDefinitions.${key}`);
    }
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
        run: () => client.checkout.status("checkout_1"),
        operation: mikaOperationDefinitions.checkoutStatus,
        expectedUrl:
          "https://shop.test/_emdash/api/plugins/mika/checkout/status?checkoutId=checkout_1",
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

  it("keeps dynamic operation dispatch centralized", () => {
    const operationsSource = readFileSync(
      new URL("../src/api/operations.ts", import.meta.url),
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
    expect(operationsSource).not.toContain("input: never");
    expect(routeHandlersSource).toContain("callMikaOperation(operation");
    expect(routeHandlersSource).not.toContain("as never");
    expect(astroActionsSource).toContain("callMikaOperation<TData>");
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
      returnTo: "/account/orders",
    });

    expect(requestedUrl).toBe(
      "https://shop.test/_emdash/api/plugins/mika/orders/invoice?orderId=order_1&returnTo=%2Faccount%2Forders",
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
    await client.checkout.status("checkout_1");
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
        url: "https://shop.test/_emdash/api/plugins/mika/checkout/status?checkoutId=checkout_1",
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
  it("validates aggregate primitive fields while decoding JSON", () => {
    expect(
      decodeAggregate(
        JSON.stringify({
          schemaVersion: 1,
          id: "aggregate_1",
          currency: "EUR",
          provider: "fake",
          createdAt: new Date(0).toISOString(),
        }),
      ),
    ).toMatchObject({
      schemaVersion: 1,
      id: "aggregate_1",
    });

    expect(() =>
      decodeAggregate(
        JSON.stringify({
          schemaVersion: 1,
          currency: "eur",
        }),
      ),
    ).toThrow(/Invalid aggregate field 'currency'/);
  });

  it("rejects non-object JSON metadata", () => {
    expect(decodeJsonObject(JSON.stringify({ nested: { ok: true } }))).toEqual({
      nested: { ok: true },
    });
    expect(() => decodeJsonObject(JSON.stringify(["not", "object"]))).toThrow(
      /must be a JSON object/,
    );
  });

  it("deletes malformed and expired cache entries on read", async () => {
    const entries = new Map<string, unknown>();
    const kv = {
      async get<T>(key: string) {
        return (entries.get(key) ?? null) as T | null;
      },
      async set(key: string, value: unknown) {
        entries.set(key, value);
      },
      async delete(key: string) {
        return entries.delete(key);
      },
      async list(prefix = "") {
        return Array.from(entries.entries())
          .filter(([key]) => key.startsWith(prefix))
          .map(([key, value]) => ({ key, value }));
      },
    };
    const cache = new MikaCache(kv);

    entries.set("cache:bad", {
      value: "bad",
      createdAt: new Date(0).toISOString(),
      expiresAt: "not-a-date",
    });
    entries.set("cache:expired", {
      value: "expired",
      createdAt: iso(new Date(0).toISOString()),
      expiresAt: iso(new Date(1).toISOString()),
    });

    await expect(cache.get("bad", new Date(10))).resolves.toBeNull();
    await expect(cache.get("expired", new Date(10))).resolves.toBeNull();
    expect(entries.has("cache:bad")).toBe(false);
    expect(entries.has("cache:expired")).toBe(false);
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
      allowedTargetPluginIds: [],
    });
    expect(manifest.actions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "mika.provider.health",
          route: "admin/provider/health",
          placement: "dashboard",
        }),
        expect.objectContaining({
          id: "mika.catalog.syncEntry",
          route: "admin/provider/sync",
          placement: "field",
        }),
      ]),
    );
  });

  it("creates copyable field action button options", () => {
    expect(createMikaCatalogSyncActionButtonOptions()).toMatchObject({
      mode: "run",
      actionPluginId: "mika",
      manifestRoute: ".well-known/actions",
      action: "mika.catalog.syncEntry",
      contextKey: "context",
    });
    expect(createMikaActionButtonOptions("mika.stock.adjust")).toMatchObject({
      action: "mika.stock.adjust",
      route: "admin/stock/adjust",
      confirm: "Adjust stock for this item?",
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
        "./agent",
        "./admin",
        "./astro",
        "./astro-actions",
        "./client",
        "./email",
        "./provider",
        "./react",
        "./server",
        "./templates/*",
        "./types",
      ].sort(),
    );
    expect(exportsMap).not.toHaveProperty("./api");
    expect(exportsMap).not.toHaveProperty("./model");
    expect(exportsMap).not.toHaveProperty("./storage");

    for (const [subpath, entry] of Object.entries(exportsMap)) {
      if (subpath === "./templates/*") continue;
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
    >();
    expectTypeOf<Parameters<ReturnType<typeof createMika>["routes"]>[0]>().toEqualTypeOf<
      (typeof publicMikaPluginRouteNames)[number]
    >();
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
    expectTypeOf<typeof PackageCreateMikaAdminActionsManifest>().toBeFunction();
    expectTypeOf<typeof PackageCreateMika>().toBeFunction();
    expectTypeOf<typeof PackageCreateMikaActions>().toBeFunction();
    expectTypeOf<typeof PackageCreateMikaClient>().toBeFunction();
    expectTypeOf<typeof PackageRenderMikaEmail>().toBeFunction();
    expectTypeOf<typeof PackageCreateMikaProviderRegistry>().toBeFunction();
    expectTypeOf<typeof PackageMikaProvider>().toBeFunction();
    expectTypeOf<typeof PackageCreateMikaServerClient>().toBeFunction();
    expectTypeOf<typeof PackageCreateMikaBackendApi>().toEqualTypeOf<typeof createMikaBackendApi>();
    expectTypeOf<PackageMikaBackendDependencies>().toEqualTypeOf<MikaBackendDependencies>();
    expectTypeOf<typeof PackageMikaApiMethodNames>().toEqualTypeOf<typeof mikaApiMethodNames>();
    expectTypeOf<typeof PACKAGE_MIKA_ERROR_CODES>().toEqualTypeOf<typeof MIKA_ERROR_CODES>();
    expectTypeOf<typeof PackageCreateMikaId>().toEqualTypeOf<typeof createMikaId>();
  });
});

describe("Mika Astro template contracts", () => {
  it("keeps Astro Actions on the request-bound API instead of private JSON routes", () => {
    const source = readFileSync(new URL("../src/astro-actions.ts", import.meta.url), "utf8");

    expect(source).toContain("createMikaRequestContext");
    expect(source).toContain("createMikaApi");
    expect(source).not.toContain("createMikaClient");
    expect(source).toContain("const purchaseSellableId = parsePurchaseMikaId");
    expect(source).toContain("const sellableId = purchaseSellableId ?? input.sellableId");
  });

  it("documents the core copy path separately from contract examples", () => {
    const source = readFileSync(
      new URL("../src/templates/astro/README.md", import.meta.url),
      "utf8",
    );

    expect(source).toContain("The core kit is the smallest copy path");
    expect(source).toContain("`ProductPurchase`, `AddToCartForm`, `BuyNowForm`, `WishlistForm`");
    expect(source).toContain("Contract examples stay in place");
    expect(source).toContain("`CouponForm`, `CheckoutForm`, account export/delete pages");
    expect(source).toContain("the webhook endpoint stub");
    expect(source).toContain("owns cross-form grouped variant synchronization");
    expect(source).toContain("`VariantOptionGroups` is render-focused");
    expect(source).toContain("Agent-readable examples are optional copyable references");
    expect(source).toContain("`ProductStructuredData`");
    expect(source).toContain("`.well-known/mika-agent.json.ts`");
    expect(source).toContain('createMikaAgentManifest({ include: ["public"] })');
    expect(source).toContain("manifest schema, version, and EmDash Mika plugin route base path");
    expect(source).toContain("not an auth, payment, or tool contract");
    expect(source).toContain("OAuth, policy, confirmation, replay storage, and provider");
    expect(source).toContain("It emits `Product` for simple products and `ProductGroup`");
    expect(source).toContain("Product groups include `productGroupID`");
    expect(source).toContain("schema.org variant properties");
    expect(source).toContain("seller, shipping details, return policy, and");
    expect(source).toContain("non-verifying");
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
        .filter((subpath) => subpath !== "./templates/*")
        .map((subpath) =>
          subpath === "." ? packageJson.name : `${packageJson.name}/${subpath.slice(2)}`,
        ),
    );
    const templateSources = sourceFiles(new URL("../src/templates/astro/", import.meta.url)).filter(
      (file) => file.pathname.endsWith(".astro") || file.pathname.endsWith(".ts"),
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
    const checkoutSuccess = readFileSync(
      new URL("../src/templates/astro/pages/checkout/success.astro", import.meta.url),
      "utf8",
    );

    expect(routeDefaults).toContain('account: "/account"');
    expect(routeDefaults).toContain('checkoutSuccess: "/checkout/success"');
    expect(buyNow).toContain("mikaTemplateRoutes.checkoutSuccess");
    expect(checkout).toContain("mikaTemplateRoutes.checkoutCancel");
    expect(account).toContain("mikaTemplateRoutes.account");
    expect(checkoutSuccess).toContain("mikaTemplateCheckoutSuccessHref");
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

    expect(magicLink).toContain('"mika-magic-link-email"');
    expect(magicLink).toContain("aria-describedby={resolvedEmailErrorId}");
    expect(account).toContain('id="mika-account-magic-link"');
    expect(checkout).toContain("customerLegend");
    expect(checkout).toContain("<legend>{customerLegend}</legend>");
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
