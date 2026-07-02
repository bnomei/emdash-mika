/**
 * ACP product projection and Stripe provider adapter tests.
 */
import { describe, expect, it } from "vite-plus/test";
import { createHash, createHmac } from "node:crypto";

import {
  createMemoryMikaAcpSessionStore,
  createMikaAcpCheckoutHandlers,
  createMikaAcpFileUploadRows,
  createMikaAcpProductFeed,
  serializeMikaAcpFileUploadRows,
  serializeMikaAcpProductFeed,
  validateMikaAcpProductFeed,
  type MikaAcpSessionStore,
  type MikaAcpSessionRecord,
  type MikaAcpSeller,
} from "../src/acp";
import type { MikaRequestContext } from "../src/api/context";
import type { MikaApi } from "../src/api/server";
import type { MikaProviderWebhookEvent } from "../src/provider";
import type {
  CartDTO,
  CartQuoteDTO,
  CheckoutPreviewInput,
  CheckoutPreviewDTO,
  CheckoutSessionDTO,
  MikaApiResult,
} from "../src/api/types";
import {
  MIKA_STRIPE_DELEGATED_PAYMENT_PROVIDER_METADATA_KEY,
  MIKA_STRIPE_DELEGATED_PAYMENT_TOKEN_METADATA_KEY,
  MIKA_STRIPE_PAYMENT_AUTHORIZATION_METADATA_KEY,
  createMikaStripeProvider,
  type MikaStripeCheckoutSessionCreateParams,
  type MikaStripeClient,
} from "../src/stripe";
import {
  createCurrencyCode,
  createISODateTime,
  createMikaId,
  createProviderName,
  type JsonObject,
} from "../src/types/primitives";
import { createTestSellableDTO } from "./helpers/backend";
import {
  expectMethodBackedProviderCapabilities,
  expectNonFulfillingProviderEvent,
  expectPaidProviderPaymentEvent,
} from "./helpers/provider-contract";

describe("Mika ACP projection", () => {
  it("builds API product feeds and file-upload rows from Mika sellables", () => {
    const sellable = createTestSellableDTO({
      id: createMikaId("sellable_print"),
      title: "Limited print",
      imageRef: "https://shop.example.test/print.jpg",
      variantOptions: [{ option: "size", value: "A3", label: "Size" }],
      availability: {
        sellableId: createMikaId("sellable_print"),
        status: "available",
        availableQuantity: 4,
      },
    });
    const seller: MikaAcpSeller = {
      name: "Mika Studio",
      links: [
        { type: "terms_of_use", url: "https://shop.example.test/terms" },
        { type: "privacy_policy", url: "https://shop.example.test/privacy" },
      ],
    };

    const feed = createMikaAcpProductFeed({
      targetCountry: "US",
      products: [
        {
          id: "product_print",
          title: "Limited print",
          description: { plain: "Archival print." },
          url: "https://shop.example.test/products/print",
          media: [{ type: "image", url: "https://shop.example.test/print.jpg" }],
          seller,
          sellables: [sellable],
        },
      ],
    });

    expect(validateMikaAcpProductFeed(feed)).toEqual([]);
    expect(feed.products[0]?.variants[0]).toMatchObject({
      id: "sellable_print:price_1",
      title: "Limited print",
      price: { amount: 1200, currency: "EUR" },
      availability: { available: true, status: "in_stock" },
      variant_options: [{ name: "Size", value: "A3" }],
    });

    const rows = createMikaAcpFileUploadRows({
      products: [
        {
          id: "product_print",
          title: "Limited print",
          description: { plain: "Archival print." },
          url: "https://shop.example.test/products/print",
          media: [{ type: "image", url: "https://shop.example.test/print.jpg" }],
          sellables: [sellable],
        },
      ],
      brand: "Mika",
      sellerName: "Mika Studio",
      sellerUrl: "https://shop.example.test",
      returnPolicy: "https://shop.example.test/returns",
      targetCountries: ["US"],
      storeCountry: "US",
      checkoutEnabled: true,
      sellerPrivacyPolicy: "https://shop.example.test/privacy",
      sellerTos: "https://shop.example.test/terms",
    });

    expect(rows[0]).toMatchObject({
      is_eligible_search: true,
      is_eligible_checkout: true,
      item_id: "sellable_print:price_1",
      price: "12.00 EUR",
      seller_privacy_policy: "https://shop.example.test/privacy",
      seller_tos: "https://shop.example.test/terms",
    });
    expect(serializeMikaAcpFileUploadRows(rows)).toContain('"item_id":"sellable_print:price_1"');
  });

  it("advertises a sold-out backorder sellable as available/backorder, not out_of_stock", async () => {
    const sellable = createTestSellableDTO({
      id: createMikaId("sellable_backorder"),
      title: "Backorder poster",
      availability: {
        sellableId: createMikaId("sellable_backorder"),
        status: "backorder",
        availableQuantity: 0,
      },
    });

    const feed = createMikaAcpProductFeed({
      targetCountry: "US",
      products: [
        {
          id: "product_backorder",
          title: "Backorder poster",
          description: { plain: "Ships when restocked." },
          url: "https://shop.example.test/products/backorder",
          media: [{ type: "image", url: "https://shop.example.test/backorder.jpg" }],
          seller: {
            name: "Mika Studio",
            links: [
              { type: "terms_of_use", url: "https://shop.example.test/terms" },
              { type: "privacy_policy", url: "https://shop.example.test/privacy" },
            ],
          },
          sellables: [sellable],
        },
      ],
    });

    expect(validateMikaAcpProductFeed(feed)).toEqual([]);
    expect(feed.products[0]?.variants[0]?.availability).toEqual({
      available: true,
      status: "backorder",
    });

    const rows = createMikaAcpFileUploadRows({
      products: [
        {
          id: "product_backorder",
          title: "Backorder poster",
          description: { plain: "Ships when restocked." },
          url: "https://shop.example.test/products/backorder",
          media: [{ type: "image", url: "https://shop.example.test/backorder.jpg" }],
          sellables: [sellable],
        },
      ],
      brand: "Mika",
      sellerName: "Mika Studio",
      sellerUrl: "https://shop.example.test",
      returnPolicy: "https://shop.example.test/returns",
      targetCountries: ["US"],
      storeCountry: "US",
      checkoutEnabled: true,
      sellerPrivacyPolicy: "https://shop.example.test/privacy",
      sellerTos: "https://shop.example.test/terms",
    });

    expect(rows[0]?.availability).toBe("backorder");
  });

  it("skips zero-variant products instead of failing the whole ACP product feed", () => {
    const active = createTestSellableDTO({
      id: createMikaId("sellable_active"),
      title: "Active print",
    });
    const pausedBase = createTestSellableDTO({
      id: createMikaId("sellable_paused"),
      title: "Paused print",
    });
    const paused = {
      ...pausedBase,
      prices: pausedBase.prices.map((price) => ({ ...price, active: false })),
    };

    const feed = createMikaAcpProductFeed({
      products: [
        {
          id: "product_paused",
          title: "Paused print",
          sellables: [paused],
        },
        {
          id: "product_empty",
          title: "Empty product",
          sellables: [],
        },
        {
          id: "product_active",
          title: "Active print",
          sellables: [active],
        },
      ],
    });

    expect(feed.products.map((product) => product.id)).toEqual(["product_active"]);
    expect(validateMikaAcpProductFeed(feed)).toEqual([]);
    expect(() => serializeMikaAcpProductFeed(feed)).not.toThrow();
  });

  it("creates and completes ACP checkout sessions with Stripe SPT metadata", async () => {
    let cart = createCart([]);
    let checkoutPreviewInput: CheckoutPreviewInput | undefined;
    let checkoutStartMetadata: JsonObject | undefined;
    let checkoutStartCount = 0;
    const api = createAcpTestApi({
      getCart: () => cart,
      setCart: (next) => {
        cart = next;
      },
      onCheckoutPreview: (previewInput) => {
        checkoutPreviewInput = previewInput;
      },
      onCheckoutStart: (metadata) => {
        checkoutStartCount += 1;
        checkoutStartMetadata = metadata;
      },
    });
    const handlers = createMikaAcpCheckoutHandlers({
      api,
      store: createMemoryMikaAcpSessionStore(),
      seller: {
        name: "Mika Studio",
        links: [{ type: "terms_of_use", url: "https://shop.example.test/terms" }],
      },
      apiKey: "acp_test_key",
      provider: createProviderName("stripe"),
      now: () => new Date("2026-01-01T00:00:00.000Z"),
      createSessionId: () => "checkout_session_acp_1",
      orderUrl: ({ checkoutId }) => `https://shop.example.test/account/orders/${checkoutId}`,
    });

    const created = await handlers.create(
      acpRequest("https://shop.example.test/checkout_sessions", "idem_create", {
        items: [{ id: "sellable_1:price_1", quantity: 2 }],
        buyer: { name: "Ada Buyer", email: "ada@example.test" },
      }),
    );

    expect(created.status).toBe(201);
    expect(created.headers.get("Idempotency-Key")).toBe("idem_create");
    await expect(created.json()).resolves.toMatchObject({
      id: "checkout_session_acp_1",
      status: "ready_for_payment",
      currency: "eur",
      line_items: [{ item: { id: "sellable_1:price_1", quantity: 2 }, total: 2400 }],
    });

    const completed = await handlers.complete(
      acpRequest(
        "https://shop.example.test/checkout_sessions/checkout_session_acp_1/complete",
        "idem_complete",
        {
          payment_data: { provider: "stripe", token: "spt_test_123" },
        },
      ),
      "checkout_session_acp_1",
    );

    expect(completed.status).toBe(200);
    await expect(completed.json()).resolves.toMatchObject({
      id: "checkout_session_acp_1",
      status: "completed",
      order: {
        checkout_session_id: "checkout_session_acp_1",
        permalink_url: "https://shop.example.test/account/orders/checkout_1",
      },
    });
    expect(checkoutPreviewInput).toMatchObject({
      cartId: "cart_1",
      provider: "stripe",
      customer: { name: "Ada Buyer", email: "ada@example.test" },
    });
    expect(checkoutStartMetadata).toMatchObject({
      [MIKA_STRIPE_DELEGATED_PAYMENT_TOKEN_METADATA_KEY]: "spt_test_123",
      [MIKA_STRIPE_DELEGATED_PAYMENT_PROVIDER_METADATA_KEY]: "stripe",
      [MIKA_STRIPE_PAYMENT_AUTHORIZATION_METADATA_KEY]: expect.stringContaining(
        "acp_payment_authorization_",
      ),
      acpCheckoutSessionId: "checkout_session_acp_1",
      acpPaymentAuthorizationInputHash: "hash_quote_1",
    });
    expect(checkoutStartCount).toBe(1);

    const replayed = await handlers.complete(
      acpRequest(
        "https://shop.example.test/checkout_sessions/checkout_session_acp_1/complete",
        "idem_complete",
        {
          payment_data: { provider: "stripe", token: "spt_test_123" },
        },
      ),
      "checkout_session_acp_1",
    );

    expect(replayed.status).toBe(200);
    await expect(replayed.json()).resolves.toMatchObject({
      id: "checkout_session_acp_1",
      status: "completed",
    });
    expect(checkoutStartCount).toBe(1);
  });

  it("freezes completed ACP quote totals instead of drifting with later cart changes", async () => {
    let cart = createCart([]);
    const store = createMemoryMikaAcpSessionStore();
    const handlers = createMikaAcpCheckoutHandlers({
      api: createAcpTestApi({
        getCart: () => cart,
        setCart: (next) => {
          cart = next;
        },
      }),
      store,
      seller: { name: "Mika Studio", links: [] },
      apiKey: "acp_test_key",
      provider: createProviderName("stripe"),
      now: () => new Date("2026-01-01T00:00:00.000Z"),
      createSessionId: () => "checkout_session_acp_snapshot",
    });

    await handlers.create(
      acpRequest("https://shop.example.test/checkout_sessions", "idem_snapshot_create", {
        items: [{ id: "sellable_1:price_1", quantity: 1 }],
      }),
    );
    const completed = await handlers.complete(
      acpRequest(
        "https://shop.example.test/checkout_sessions/checkout_session_acp_snapshot/complete",
        "idem_snapshot_complete",
        { payment_data: { provider: "stripe", token: "spt_test_123" } },
      ),
      "checkout_session_acp_snapshot",
    );

    expect(completed.status).toBe(200);
    await expect(completed.json()).resolves.toMatchObject({
      status: "completed",
      line_items: [{ total: 1200 }],
      totals: expect.arrayContaining([{ type: "total", display_text: "Total", amount: 1200 }]),
    });

    const expensiveMoney = { amount: 9900, currency: createCurrencyCode("EUR") };
    const driftedLine = {
      ...cart.items[0]!,
      unitAmount: expensiveMoney,
      subtotal: expensiveMoney,
      total: expensiveMoney,
    };
    cart = createCart([driftedLine]);

    const fetched = await handlers.get(
      acpRequest(
        "https://shop.example.test/checkout_sessions/checkout_session_acp_snapshot",
        "idem_snapshot_get",
        {},
      ),
      "checkout_session_acp_snapshot",
    );

    expect(fetched.status).toBe(200);
    await expect(fetched.json()).resolves.toMatchObject({
      status: "completed",
      line_items: [{ total: 1200 }],
      totals: expect.arrayContaining([{ type: "total", display_text: "Total", amount: 1200 }]),
    });
    const record = await store.get("checkout_session_acp_snapshot");
    expect(record?.quoteSnapshot?.totals).toEqual(
      expect.arrayContaining([{ type: "total", display_text: "Total", amount: 1200 }]),
    );
  });

  it("expires ACP sessions before mutation and blocks payment handoff", async () => {
    let cart = createCart([]);
    let now = new Date("2026-01-01T00:00:00.000Z");
    let checkoutStarts = 0;
    const store = createMemoryMikaAcpSessionStore();
    const handlers = createMikaAcpCheckoutHandlers({
      api: createAcpTestApi({
        getCart: () => cart,
        setCart: (next) => {
          cart = next;
        },
        onCheckoutStart: () => {
          checkoutStarts += 1;
        },
      }),
      store,
      seller: { name: "Mika Studio", links: [] },
      apiKey: "acp_test_key",
      provider: createProviderName("stripe"),
      now: () => now,
      sessionTtlMs: 1_000,
      terminalRetentionMs: 60_000,
      createSessionId: () => "checkout_session_acp_expiring",
    });

    await handlers.create(
      acpRequest("https://shop.example.test/checkout_sessions", "idem_expiring_create", {
        items: [{ id: "sellable_1:price_1", quantity: 1 }],
      }),
    );

    now = new Date("2026-01-01T00:00:02.000Z");
    const updated = await handlers.update(
      acpRequest("https://shop.example.test/checkout_sessions/checkout_session_acp_expiring", "idem_expiring_update", {
        buyer: { name: "Ada Buyer", email: "ada@example.test" },
      }),
      "checkout_session_acp_expiring",
    );

    expect(updated.status).toBe(409);
    await expect(updated.json()).resolves.toMatchObject({
      code: "checkout_expired",
      message: "Checkout session has expired. Create a new ACP checkout session to continue.",
    });
    await expect(store.get("checkout_session_acp_expiring")).resolves.toMatchObject({
      status: "not_ready_for_payment",
      expiredAt: createISODateTime("2026-01-01T00:00:02.000Z"),
      purgeAt: createISODateTime("2026-01-01T00:01:02.000Z"),
    });

    const completed = await handlers.complete(
      acpRequest(
        "https://shop.example.test/checkout_sessions/checkout_session_acp_expiring/complete",
        "idem_expiring_complete",
        { payment_data: { provider: "stripe", token: "spt_test_123" } },
      ),
      "checkout_session_acp_expiring",
    );

    expect(completed.status).toBe(409);
    await expect(completed.json()).resolves.toMatchObject({ code: "checkout_expired" });
    expect(checkoutStarts).toBe(0);
  });

  it("cleans up expired ACP sessions and purges retained terminal sessions", async () => {
    const store = createMemoryMikaAcpSessionStore();
    const activeExpired: MikaAcpSessionRecord = {
      id: "checkout_session_acp_cleanup_expired",
      sessionId: "acp_checkout:cleanup_expired",
      status: "ready_for_payment",
      items: [{ id: "sellable_1:price_1", quantity: 1 }],
      provider: createProviderName("stripe"),
      expiresAt: createISODateTime("2026-01-01T00:00:00.000Z"),
      createdAt: createISODateTime("2025-12-31T23:00:00.000Z"),
      updatedAt: createISODateTime("2025-12-31T23:00:00.000Z"),
    };
    const retainedTerminal: MikaAcpSessionRecord = {
      id: "checkout_session_acp_cleanup_terminal",
      sessionId: "acp_checkout:cleanup_terminal",
      status: "completed",
      items: [{ id: "sellable_1:price_1", quantity: 1 }],
      provider: createProviderName("stripe"),
      purgeAt: createISODateTime("2026-01-01T00:00:00.000Z"),
      createdAt: createISODateTime("2025-12-31T22:00:00.000Z"),
      updatedAt: createISODateTime("2025-12-31T22:00:00.000Z"),
    };
    await store.put(activeExpired);
    await store.put(retainedTerminal);
    await store.claimIdempotencyKey!("idem_cleanup_terminal", retainedTerminal.id);
    await store.bindIdempotencyKey!("idem_cleanup_terminal", retainedTerminal.id);

    await expect(
      store.cleanupExpired!({
        now: createISODateTime("2026-01-01T00:00:02.000Z"),
        terminalRetentionMs: 60_000,
      }),
    ).resolves.toEqual({ scanned: 2, expired: 1, purged: 1, hasMore: false });
    await expect(store.get(activeExpired.id)).resolves.toMatchObject({
      status: "not_ready_for_payment",
      expiredAt: createISODateTime("2026-01-01T00:00:02.000Z"),
      purgeAt: createISODateTime("2026-01-01T00:01:02.000Z"),
    });
    await expect(store.get(retainedTerminal.id)).resolves.toBeUndefined();
    await expect(
      store.claimIdempotencyKey("idem_cleanup_terminal", retainedTerminal.id),
    ).resolves.toEqual({ status: "claimed" });
  });

  it("replays the original session on an idempotent ACP create retry instead of returning 409", async () => {
    let cart = createCart([]);
    let mintedIds = 0;
    const handlers = createMikaAcpCheckoutHandlers({
      api: createAcpTestApi({
        getCart: () => cart,
        setCart: (next) => {
          cart = next;
        },
      }),
      store: createMemoryMikaAcpSessionStore(),
      seller: { name: "Mika Studio", links: [] },
      apiKey: "acp_test_key",
      provider: createProviderName("stripe"),
      now: () => new Date("2026-01-01T00:00:00.000Z"),
      createSessionId: () => `checkout_session_acp_retry_${(mintedIds += 1)}`,
    });

    const body = {
      items: [{ id: "sellable_1:price_1", quantity: 2 }],
      buyer: { name: "Ada Buyer", email: "ada@example.test" },
    };

    const first = await handlers.create(
      acpRequest("https://shop.example.test/checkout_sessions", "idem_create_retry", body),
    );
    expect(first.status).toBe(201);
    const firstBody = (await first.json()) as {
      readonly id: string;
      readonly status: string;
      readonly line_items: unknown;
    };
    expect(firstBody).toMatchObject({ id: "checkout_session_acp_retry_1" });

    const retry = await handlers.create(
      acpRequest("https://shop.example.test/checkout_sessions", "idem_create_retry", body),
    );
    expect(retry.status).toBe(201);
    await expect(retry.json()).resolves.toMatchObject({
      id: firstBody.id,
      status: firstBody.status,
      line_items: firstBody.line_items,
    });
    expect(mintedIds).toBe(2);

    const fresh = await handlers.create(
      acpRequest("https://shop.example.test/checkout_sessions", "idem_create_fresh", body),
    );
    expect(fresh.status).toBe(201);
    await expect(fresh.json()).resolves.toMatchObject({ id: "checkout_session_acp_retry_3" });
  });

  it("rejects concurrent ACP create replays while the first request is in progress", async () => {
    let cart = createCart([]);
    let releaseCartAdd!: () => void;
    let enteredCartAdd!: () => void;
    const cartAddEntered = new Promise<void>((resolve) => {
      enteredCartAdd = resolve;
    });
    const cartAddRelease = new Promise<void>((resolve) => {
      releaseCartAdd = resolve;
    });
    const handlers = createMikaAcpCheckoutHandlers({
      api: createAcpTestApi({
        getCart: () => cart,
        setCart: (next) => {
          cart = next;
        },
        onCartAdd: async () => {
          enteredCartAdd();
          await cartAddRelease;
        },
      }),
      store: createMemoryMikaAcpSessionStore(),
      seller: { name: "Mika Studio", links: [] },
      apiKey: "acp_test_key",
      provider: createProviderName("stripe"),
      now: () => new Date("2026-01-01T00:00:00.000Z"),
      createSessionId: () => "checkout_session_acp_create_race",
    });
    const body = { items: [{ id: "sellable_1:price_1", quantity: 1 }] };

    const first = handlers.create(
      acpRequest("https://shop.example.test/checkout_sessions", "idem_create_concurrent", body),
    );
    await cartAddEntered;
    const second = await handlers.create(
      acpRequest("https://shop.example.test/checkout_sessions", "idem_create_concurrent", body),
    );

    expect(second.status).toBe(409);
    await expect(second.json()).resolves.toMatchObject({
      code: "request_not_idempotent",
      message: "Idempotency-Key replay is already in progress.",
    });

    releaseCartAdd();
    await expect(first).resolves.toMatchObject({ status: 201 });
    const retry = await handlers.create(
      acpRequest("https://shop.example.test/checkout_sessions", "idem_create_concurrent", body),
    );
    expect(retry.status).toBe(201);
    await expect(retry.json()).resolves.toMatchObject({
      id: "checkout_session_acp_create_race",
    });
  });

  it("releases an ACP create idempotency claim when the session store write throws", async () => {
    let cart = createCart([]);
    let mintedIds = 0;
    let failNextPut = true;
    const baseStore = createMemoryMikaAcpSessionStore();
    const handlers = createMikaAcpCheckoutHandlers({
      api: createAcpTestApi({
        getCart: () => cart,
        setCart: (next) => {
          cart = next;
        },
      }),
      store: {
        ...baseStore,
        put: async (record) => {
          if (failNextPut) {
            failNextPut = false;
            throw new Error("acp store unavailable");
          }

          await baseStore.put(record);
        },
      },
      seller: { name: "Mika Studio", links: [] },
      apiKey: "acp_test_key",
      provider: createProviderName("stripe"),
      now: () => new Date("2026-01-01T00:00:00.000Z"),
      createSessionId: () => `checkout_session_acp_store_${(mintedIds += 1)}`,
    });
    const body = {
      items: [{ id: "sellable_1:price_1", quantity: 1 }],
      buyer: { name: "Ada Buyer", email: "ada@example.test" },
    };

    const failed = await handlers.create(
      acpRequest("https://shop.example.test/checkout_sessions", "idem_create_store_throw", body),
    );
    expect(failed.status).toBe(500);
    await expect(failed.json()).resolves.toMatchObject({
      code: "provider_failed",
      message: "ACP checkout operation failed.",
    });

    const retry = await handlers.create(
      acpRequest("https://shop.example.test/checkout_sessions", "idem_create_store_throw", body),
    );
    expect(retry.status).toBe(201);
    await expect(retry.json()).resolves.toMatchObject({
      id: "checkout_session_acp_store_2",
    });
  });

  it("rejects a new ACP complete attempt after a non-terminal payment handoff", async () => {
    let cart = createCart([]);
    let checkoutStartCount = 0;
    const handlers = createMikaAcpCheckoutHandlers({
      api: createAcpTestApi({
        getCart: () => cart,
        setCart: (next) => {
          cart = next;
        },
        onCheckoutStart: () => {
          checkoutStartCount += 1;
        },
        checkoutSessionStatus: "pending",
      }),
      store: createMemoryMikaAcpSessionStore(),
      seller: { name: "Mika Studio", links: [] },
      apiKey: "acp_test_key",
      provider: createProviderName("stripe"),
      now: () => new Date("2026-01-01T00:00:00.000Z"),
      createSessionId: () => "checkout_session_acp_pending",
    });

    await handlers.create(
      acpRequest("https://shop.example.test/checkout_sessions", "idem_create_pending", {
        items: [{ id: "sellable_1:price_1", quantity: 1 }],
        buyer: { name: "Ada Buyer", email: "ada@example.test" },
      }),
    );

    const first = await handlers.complete(
      acpRequest(
        "https://shop.example.test/checkout_sessions/checkout_session_acp_pending/complete",
        "idem_complete_1",
        { payment_data: { provider: "stripe", token: "spt_test_123" } },
      ),
      "checkout_session_acp_pending",
    );
    expect(first.status).toBe(200);
    await expect(first.json()).resolves.toMatchObject({ status: "ready_for_payment" });
    expect(checkoutStartCount).toBe(1);

    const second = await handlers.complete(
      acpRequest(
        "https://shop.example.test/checkout_sessions/checkout_session_acp_pending/complete",
        "idem_complete_2",
        { payment_data: { provider: "stripe", token: "spt_test_123" } },
      ),
      "checkout_session_acp_pending",
    );
    expect(second.status).toBe(409);
    await expect(second.json()).resolves.toMatchObject({
      code: "invalid_request",
      message:
        "Checkout session already has a payment attempt in progress. Create a new ACP checkout session to retry payment.",
    });
    expect(checkoutStartCount).toBe(1);
  });

  it("does not double-authorize when two completes race with distinct idempotency keys", async () => {
    let cart = createCart([]);
    let startCount = 0;
    let releaseGate: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    let signalStarted: () => void = () => {};
    const firstStarted = new Promise<void>((resolve) => {
      signalStarted = resolve;
    });
    const handlers = createMikaAcpCheckoutHandlers({
      api: createAcpTestApi({
        getCart: () => cart,
        setCart: (next) => {
          cart = next;
        },
        onCheckoutStart: async () => {
          startCount += 1;
          if (startCount === 1) {
            signalStarted();
            await gate;
          }
        },
        checkoutSessionStatus: "pending",
      }),
      store: createMemoryMikaAcpSessionStore(),
      seller: { name: "Mika Studio", links: [] },
      apiKey: "acp_test_key",
      provider: createProviderName("stripe"),
      now: () => new Date("2026-01-01T00:00:00.000Z"),
      createSessionId: () => "checkout_session_acp_race",
    });

    await handlers.create(
      acpRequest("https://shop.example.test/checkout_sessions", "idem_create_race", {
        items: [{ id: "sellable_1:price_1", quantity: 1 }],
        buyer: { name: "Ada Buyer", email: "ada@example.test" },
      }),
    );

    const complete = (key: string) =>
      handlers.complete(
        acpRequest(
          "https://shop.example.test/checkout_sessions/checkout_session_acp_race/complete",
          key,
          { payment_data: { provider: "stripe", token: "spt_test_123" } },
        ),
        "checkout_session_acp_race",
      );

    const first = complete("idem_complete_a");
    await firstStarted;

    const second = await complete("idem_complete_b");
    expect(second.status).toBe(409);
    expect(startCount).toBe(1);

    releaseGate();
    const firstResponse = await first;
    expect(firstResponse.status).toBe(200);
    expect(startCount).toBe(1);
  });

  it("releases an ACP complete claim when the completion lock claim throws", async () => {
    let cart = createCart([]);
    let failCompletionLock = true;
    let checkoutStartCount = 0;
    const baseStore = createMemoryMikaAcpSessionStore();
    const handlers = createMikaAcpCheckoutHandlers({
      api: createAcpTestApi({
        getCart: () => cart,
        setCart: (next) => {
          cart = next;
        },
        onCheckoutStart: () => {
          checkoutStartCount += 1;
        },
      }),
      store: {
        ...baseStore,
        claimIdempotencyKey: async (key, id) => {
          if (key.startsWith("acp_complete_lock:") && failCompletionLock) {
            failCompletionLock = false;
            throw new Error("completion lock unavailable");
          }

          return baseStore.claimIdempotencyKey(key, id);
        },
      },
      seller: { name: "Mika Studio", links: [] },
      apiKey: "acp_test_key",
      provider: createProviderName("stripe"),
      now: () => new Date("2026-01-01T00:00:00.000Z"),
      createSessionId: () => "checkout_session_acp_lock_failure",
    });

    await handlers.create(
      acpRequest("https://shop.example.test/checkout_sessions", "idem_create_lock_failure", {
        items: [{ id: "sellable_1:price_1", quantity: 1 }],
      }),
    );

    const completeRequest = () =>
      acpRequest(
        "https://shop.example.test/checkout_sessions/checkout_session_acp_lock_failure/complete",
        "idem_complete_lock_failure",
        { payment_data: { provider: "stripe", token: "spt_test_123" } },
      );

    const failed = await handlers.complete(
      completeRequest(),
      "checkout_session_acp_lock_failure",
    );
    expect(failed.status).toBe(500);

    const retry = await handlers.complete(completeRequest(), "checkout_session_acp_lock_failure");
    expect(retry.status).toBe(200);
    await expect(retry.json()).resolves.toMatchObject({ status: "completed" });
    expect(checkoutStartCount).toBe(1);
  });

  it("refuses to build ACP handlers without an apiKey or signatureSecret", () => {
    let cart = createCart([]);
    const baseOptions = {
      api: createAcpTestApi({
        getCart: () => cart,
        setCart: (next: CartDTO) => {
          cart = next;
        },
      }),
      store: createMemoryMikaAcpSessionStore(),
      seller: { name: "Mika Studio", links: [] },
      provider: createProviderName("stripe"),
    };

    expect(() => createMikaAcpCheckoutHandlers(baseOptions)).toThrow(
      "requires an apiKey or signatureSecret",
    );
    expect(() =>
      createMikaAcpCheckoutHandlers({ ...baseOptions, apiKey: "acp_test_key" }),
    ).not.toThrow();
    expect(() =>
      createMikaAcpCheckoutHandlers({ ...baseOptions, signatureSecret: "shh" }),
    ).not.toThrow();
  });

  it("refuses to build ACP handlers with a non-atomic idempotency store", () => {
    let cart = createCart([]);
    const store = {
      async get() {
        return undefined;
      },
      async put() {},
    } as unknown as MikaAcpSessionStore;

    expect(() =>
      createMikaAcpCheckoutHandlers({
        api: createAcpTestApi({
          getCart: () => cart,
          setCart: (next) => {
            cart = next;
          },
        }),
        store,
        seller: { name: "Mika Studio", links: [] },
        apiKey: "acp_test_key",
        provider: createProviderName("stripe"),
      }),
    ).toThrow("requires an ACP session store with atomic claimIdempotencyKey");
  });

  it("accepts a canonical ACP request signature", async () => {
    let cart = createCart([]);
    const handlers = createMikaAcpCheckoutHandlers({
      api: createAcpTestApi({
        getCart: () => cart,
        setCart: (next) => {
          cart = next;
        },
      }),
      store: createMemoryMikaAcpSessionStore(),
      seller: { name: "Mika Studio", links: [] },
      signatureSecret: "acp_signature_secret",
      provider: createProviderName("stripe"),
      now: () => new Date("2026-01-01T00:00:00.000Z"),
      createSessionId: () => "checkout_session_acp_signed",
    });

    const response = await handlers.create(
      signedAcpRequest(
        "https://shop.example.test/checkout_sessions?expand=totals",
        "idem_signed_create",
        { items: [{ id: "sellable_1:price_1", quantity: 1 }] },
        "acp_signature_secret",
        "2026-01-01T00:00:00.000Z",
      ),
    );

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({
      id: "checkout_session_acp_signed",
      status: "ready_for_payment",
    });
  });

  it("rejects a canonical ACP request signature replayed on a different path", async () => {
    let cart = createCart([]);
    const handlers = createMikaAcpCheckoutHandlers({
      api: createAcpTestApi({
        getCart: () => cart,
        setCart: (next) => {
          cart = next;
        },
      }),
      store: createMemoryMikaAcpSessionStore(),
      seller: { name: "Mika Studio", links: [] },
      signatureSecret: "acp_signature_secret",
      provider: createProviderName("stripe"),
      now: () => new Date("2026-01-01T00:00:00.000Z"),
      createSessionId: () => "checkout_session_acp_replay",
    });

    const response = await handlers.create(
      signedAcpRequest(
        "https://shop.example.test/checkout_sessions/replayed",
        "idem_signed_replay",
        { items: [{ id: "sellable_1:price_1", quantity: 1 }] },
        "acp_signature_secret",
        "2026-01-01T00:00:00.000Z",
        { signedUrl: "https://shop.example.test/checkout_sessions" },
      ),
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({
      code: "signature_invalid",
      message: "ACP request signature is invalid.",
    });
  });

  it("rejects stale and malformed ACP request signature timestamps", async () => {
    let cart = createCart([]);
    const handlers = createMikaAcpCheckoutHandlers({
      api: createAcpTestApi({
        getCart: () => cart,
        setCart: (next) => {
          cart = next;
        },
      }),
      store: createMemoryMikaAcpSessionStore(),
      seller: { name: "Mika Studio", links: [] },
      signatureSecret: "acp_signature_secret",
      provider: createProviderName("stripe"),
      now: () => new Date("2026-01-01T00:00:00.000Z"),
      createSessionId: () => "checkout_session_acp_timestamp",
    });
    const body = { items: [{ id: "sellable_1:price_1", quantity: 1 }] };

    const stale = await handlers.create(
      signedAcpRequest(
        "https://shop.example.test/checkout_sessions",
        "idem_signed_stale",
        body,
        "acp_signature_secret",
        "2025-12-31T23:54:59.000Z",
      ),
    );
    expect(stale.status).toBe(401);
    await expect(stale.json()).resolves.toMatchObject({
      code: "signature_invalid",
      message: "ACP request signature timestamp is invalid.",
    });

    const malformed = await handlers.create(
      signedAcpRequest(
        "https://shop.example.test/checkout_sessions",
        "idem_signed_malformed",
        body,
        "acp_signature_secret",
        "not-a-timestamp",
      ),
    );
    expect(malformed.status).toBe(401);
    await expect(malformed.json()).resolves.toMatchObject({
      code: "signature_invalid",
      message: "ACP request signature timestamp is invalid.",
    });
  });

  it("rejects ACP bearer-token mismatches", async () => {
    let cart = createCart([]);
    const handlers = createMikaAcpCheckoutHandlers({
      api: createAcpTestApi({
        getCart: () => cart,
        setCart: (next) => {
          cart = next;
        },
      }),
      store: createMemoryMikaAcpSessionStore(),
      seller: { name: "Mika Studio", links: [] },
      apiKey: "acp_test_key",
      provider: createProviderName("stripe"),
      now: () => new Date("2026-01-01T00:00:00.000Z"),
      createSessionId: () => "checkout_session_acp_auth",
    });
    const body = JSON.stringify({ items: [{ id: "sellable_1:price_1", quantity: 1 }] });

    const response = await handlers.create(
      new Request("https://shop.example.test/checkout_sessions", {
        method: "POST",
        headers: {
          Authorization: "Bearer acp_wrong_key",
          "Content-Type": "application/json",
          "Idempotency-Key": "idem_wrong_bearer",
          "Request-Id": "req_wrong_bearer",
          "API-Version": "2025-09-12",
        },
        body,
      }),
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({
      code: "unauthorized",
      message: "ACP authorization failed.",
    });
  });

  it("cancels the bound Mika checkout when an ACP session is canceled", async () => {
    let cart = createCart([]);
    const cancelCalls: Array<{ readonly checkoutId: string }> = [];
    const handlers = createMikaAcpCheckoutHandlers({
      api: createAcpTestApi({
        getCart: () => cart,
        setCart: (next) => {
          cart = next;
        },
        onCheckoutStart: () => {},
        onCheckoutCancel: (cancelInput) => {
          cancelCalls.push({ checkoutId: String(cancelInput.checkoutId) });

          return undefined;
        },
        checkoutSessionStatus: "pending",
      }),
      store: createMemoryMikaAcpSessionStore(),
      seller: { name: "Mika Studio", links: [] },
      apiKey: "acp_test_key",
      provider: createProviderName("stripe"),
      createSessionId: () => "checkout_session_acp_cancel_bound",
    });

    await handlers.create(
      acpRequest("https://shop.example.test/checkout_sessions", "idem_create_cancel_bound", {
        items: [{ id: "sellable_1:price_1", quantity: 1 }],
        buyer: { name: "Ada Buyer", email: "ada@example.test" },
      }),
    );
    await handlers.complete(
      acpRequest(
        "https://shop.example.test/checkout_sessions/checkout_session_acp_cancel_bound/complete",
        "idem_complete_cancel_bound",
        { payment_data: { provider: "stripe", token: "spt_test_123" } },
      ),
      "checkout_session_acp_cancel_bound",
    );

    const canceled = await handlers.cancel(
      acpRequest(
        "https://shop.example.test/checkout_sessions/checkout_session_acp_cancel_bound/cancel",
        "idem_cancel_bound",
        {},
      ),
      "checkout_session_acp_cancel_bound",
    );

    expect(canceled.status).toBe(200);
    await expect(canceled.json()).resolves.toMatchObject({ status: "canceled" });
    expect(cancelCalls).toEqual([{ checkoutId: "checkout_1" }]);
  });

  it("surfaces a failure to cancel the bound Mika checkout", async () => {
    let cart = createCart([]);
    const handlers = createMikaAcpCheckoutHandlers({
      api: createAcpTestApi({
        getCart: () => cart,
        setCart: (next) => {
          cart = next;
        },
        onCheckoutStart: () => {},
        onCheckoutCancel: () => ({
          ok: false,
          status: 409,
          error: { code: "CONFLICT", message: "Checkout is locked." },
        }),
        checkoutSessionStatus: "pending",
      }),
      store: createMemoryMikaAcpSessionStore(),
      seller: { name: "Mika Studio", links: [] },
      apiKey: "acp_test_key",
      provider: createProviderName("stripe"),
      createSessionId: () => "checkout_session_acp_cancel_fail",
    });

    await handlers.create(
      acpRequest("https://shop.example.test/checkout_sessions", "idem_create_cancel_fail", {
        items: [{ id: "sellable_1:price_1", quantity: 1 }],
        buyer: { name: "Ada Buyer", email: "ada@example.test" },
      }),
    );
    await handlers.complete(
      acpRequest(
        "https://shop.example.test/checkout_sessions/checkout_session_acp_cancel_fail/complete",
        "idem_complete_cancel_fail",
        { payment_data: { provider: "stripe", token: "spt_test_123" } },
      ),
      "checkout_session_acp_cancel_fail",
    );

    const canceled = await handlers.cancel(
      acpRequest(
        "https://shop.example.test/checkout_sessions/checkout_session_acp_cancel_fail/cancel",
        "idem_cancel_fail",
        {},
      ),
      "checkout_session_acp_cancel_fail",
    );

    expect(canceled.status).toBe(409);
    const session = await handlers.get(
      acpRequest(
        "https://shop.example.test/checkout_sessions/checkout_session_acp_cancel_fail",
        "idem_get_cancel_fail",
        {},
      ),
      "checkout_session_acp_cancel_fail",
    );
    await expect(session.json()).resolves.toMatchObject({ status: "ready_for_payment" });
  });

  it("rejects ACP item changes after a checkout has been bound", async () => {
    let cart = createCart([]);
    const handlers = createMikaAcpCheckoutHandlers({
      api: createAcpTestApi({
        getCart: () => cart,
        setCart: (next) => {
          cart = next;
        },
        checkoutSessionStatus: "pending",
      }),
      store: createMemoryMikaAcpSessionStore(),
      seller: { name: "Mika Studio", links: [] },
      apiKey: "acp_test_key",
      provider: createProviderName("stripe"),
      now: () => new Date("2026-01-01T00:00:00.000Z"),
      createSessionId: () => "checkout_session_acp_bound",
    });

    await handlers.create(
      acpRequest("https://shop.example.test/checkout_sessions", "idem_create_bound", {
        items: [{ id: "sellable_1:price_1", quantity: 1 }],
        buyer: { name: "Ada Buyer", email: "ada@example.test" },
      }),
    );

    const completed = await handlers.complete(
      acpRequest(
        "https://shop.example.test/checkout_sessions/checkout_session_acp_bound/complete",
        "idem_complete_bound",
        { payment_data: { provider: "stripe", token: "spt_test_123" } },
      ),
      "checkout_session_acp_bound",
    );
    expect(completed.status).toBe(200);
    await expect(completed.json()).resolves.toMatchObject({ status: "ready_for_payment" });

    const updated = await handlers.update(
      acpRequest(
        "https://shop.example.test/checkout_sessions/checkout_session_acp_bound",
        "idem_update_bound",
        { items: [{ id: "sellable_1:price_1", quantity: 5 }] },
      ),
      "checkout_session_acp_bound",
    );
    expect(updated.status).toBe(409);
    await expect(updated.json()).resolves.toMatchObject({
      code: "invalid_request",
      message: expect.stringContaining("after checkout has started"),
    });
  });

  it("does not mark ACP complete ready for payment when checkout.start returns a failed checkout", async () => {
    let cart = createCart([]);
    const store = createMemoryMikaAcpSessionStore();
    const handlers = createMikaAcpCheckoutHandlers({
      api: createAcpTestApi({
        getCart: () => cart,
        setCart: (next) => {
          cart = next;
        },
        checkoutSessionStatus: "failed",
      }),
      store,
      seller: { name: "Mika Studio", links: [] },
      apiKey: "acp_test_key",
      provider: createProviderName("stripe"),
      now: () => new Date("2026-01-01T00:00:00.000Z"),
      createSessionId: () => "checkout_session_acp_failed_checkout",
    });

    await handlers.create(
      acpRequest("https://shop.example.test/checkout_sessions", "idem_create_failed_checkout", {
        items: [{ id: "sellable_1:price_1", quantity: 1 }],
        buyer: { name: "Ada Buyer", email: "ada@example.test" },
      }),
    );

    const completed = await handlers.complete(
      acpRequest(
        "https://shop.example.test/checkout_sessions/checkout_session_acp_failed_checkout/complete",
        "idem_complete_failed_checkout",
        { payment_data: { provider: "stripe", token: "spt_declined" } },
      ),
      "checkout_session_acp_failed_checkout",
    );
    expect(completed.status).toBe(409);
    await expect(completed.json()).resolves.toMatchObject({
      code: "invalid_request",
      message: "Checkout session is failed and cannot be completed.",
    });
    const record = await store.get("checkout_session_acp_failed_checkout");
    expect(record).toMatchObject({ status: "not_ready_for_payment" });
    expect(record).not.toHaveProperty("checkoutId");
  });

  it("preserves Mika failure codes and retry hints in ACP error envelopes", async () => {
    let cart = createCart([]);
    const api = createAcpTestApi({
      getCart: () => cart,
      setCart: (next) => {
        cart = next;
      },
      onCheckoutPreview: () =>
        fail(429, "RATE_LIMITED", "Too many checkout attempts.", { retryAfter: 30 }),
    });
    const handlers = createMikaAcpCheckoutHandlers({
      api,
      store: createMemoryMikaAcpSessionStore(),
      seller: { name: "Mika Studio", links: [] },
      apiKey: "acp_test_key",
      createSessionId: () => "checkout_session_acp_rate_limited",
    });

    await handlers.create(
      acpRequest("https://shop.example.test/checkout_sessions", "idem_rate_limit_create", {
        buyer: { name: "Ada Buyer", email: "ada@example.test" },
        items: [{ id: "sellable_1:price_1", quantity: 1 }],
      }),
    );
    const response = await handlers.complete(
      acpRequest(
        "https://shop.example.test/checkout_sessions/checkout_session_acp_rate_limited/complete",
        "idem_rate_limit_complete",
        { payment_data: { provider: "stripe", token: "spt_test_123" } },
      ),
      "checkout_session_acp_rate_limited",
    );

    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("30");
    await expect(response.json()).resolves.toMatchObject({
      type: "invalid_request",
      code: "rate_limited",
      message: "Too many checkout attempts.",
      retry_after: 30,
    });
  });

  it("authenticates ACP API keys through the bearer credential gate", async () => {
    const handlers = createMikaAcpCheckoutHandlers({
      api: createAcpTestApi({
        getCart: () => createCart([]),
        setCart: () => undefined,
      }),
      store: createMemoryMikaAcpSessionStore(),
      seller: { name: "Mika Studio", links: [] },
      apiKey: "acp_test_key",
    });

    const unauthorized = await handlers.get(
      new Request("https://shop.example.test/checkout_sessions/missing", {
        headers: { Authorization: "Bearer acp_test_bad" },
      }),
      "missing",
    );
    expect(unauthorized.status).toBe(401);

    const authorized = await handlers.get(
      new Request("https://shop.example.test/checkout_sessions/missing", {
        headers: { Authorization: "Bearer acp_test_key" },
      }),
      "missing",
    );
    expect(authorized.status).toBe(404);
  });

  it("pins ACP checkout context URLs to the configured baseUrl", async () => {
    let cart = createCart([]);
    let checkoutContextUrl = "";
    const handlers = createMikaAcpCheckoutHandlers({
      api: createAcpTestApi({
        getCart: () => cart,
        setCart: (next) => {
          cart = next;
        },
        onCheckoutStart: (_metadata, ctx) => {
          checkoutContextUrl = ctx.url?.toString() ?? "";
        },
      }),
      store: createMemoryMikaAcpSessionStore(),
      seller: {
        name: "Mika Studio",
        links: [{ type: "terms_of_use", url: "https://shop.example.test/terms" }],
      },
      apiKey: "acp_test_key",
      provider: createProviderName("stripe"),
      baseUrl: "https://shop.example.test",
      now: () => new Date("2026-01-01T00:00:00.000Z"),
      createSessionId: () => "checkout_session_acp_origin",
    });

    await handlers.create(
      acpRequest("https://evil.example.test/checkout_sessions", "idem_origin_create", {
        items: [{ id: "sellable_1:price_1", quantity: 1 }],
      }),
    );
    const completed = await handlers.complete(
      acpRequest(
        "https://evil.example.test/checkout_sessions/checkout_session_acp_origin/complete?attempt=1",
        "idem_origin_complete",
        { payment_data: { provider: "stripe", token: "spt_test_123" } },
      ),
      "checkout_session_acp_origin",
    );

    expect(completed.status).toBe(200);
    expect(checkoutContextUrl).toBe(
      "https://shop.example.test/checkout_sessions/checkout_session_acp_origin/complete?attempt=1",
    );
  });

  it("rejects unsafe ACP terminal transitions", async () => {
    let canceledCart = createCart([]);
    let canceledCheckoutStarts = 0;
    const canceledHandlers = createMikaAcpCheckoutHandlers({
      api: createAcpTestApi({
        getCart: () => canceledCart,
        setCart: (next) => {
          canceledCart = next;
        },
        onCheckoutStart: () => {
          canceledCheckoutStarts += 1;
        },
      }),
      store: createMemoryMikaAcpSessionStore(),
      seller: { name: "Mika Studio", links: [] },
      apiKey: "acp_test_key",
      provider: createProviderName("stripe"),
      createSessionId: () => "checkout_session_acp_canceled",
    });
    await canceledHandlers.create(
      acpRequest("https://shop.example.test/checkout_sessions", "idem_create_canceled", {
        items: [{ id: "sellable_1:price_1", quantity: 1 }],
      }),
    );
    const canceled = await canceledHandlers.cancel(
      acpRequest(
        "https://shop.example.test/checkout_sessions/checkout_session_acp_canceled/cancel",
        "idem_cancel_first",
        {},
      ),
      "checkout_session_acp_canceled",
    );

    expect(canceled.status).toBe(200);
    await expect(canceled.json()).resolves.toMatchObject({ status: "canceled" });

    const completeCanceled = await canceledHandlers.complete(
      acpRequest(
        "https://shop.example.test/checkout_sessions/checkout_session_acp_canceled/complete",
        "idem_complete_canceled",
        { payment_data: { provider: "stripe", token: "spt_test_123" } },
      ),
      "checkout_session_acp_canceled",
    );

    expect(completeCanceled.status).toBe(409);
    await expect(completeCanceled.json()).resolves.toMatchObject({
      code: "invalid_request",
      message: "Checkout session is canceled and cannot be completed.",
    });
    expect(canceledCheckoutStarts).toBe(0);

    let completedCart = createCart([]);
    const completedHandlers = createMikaAcpCheckoutHandlers({
      api: createAcpTestApi({
        getCart: () => completedCart,
        setCart: (next) => {
          completedCart = next;
        },
        onCheckoutStart: () => {},
      }),
      store: createMemoryMikaAcpSessionStore(),
      seller: { name: "Mika Studio", links: [] },
      apiKey: "acp_test_key",
      provider: createProviderName("stripe"),
      createSessionId: () => "checkout_session_acp_completed",
    });
    await completedHandlers.create(
      acpRequest("https://shop.example.test/checkout_sessions", "idem_create_completed", {
        items: [{ id: "sellable_1:price_1", quantity: 1 }],
      }),
    );
    const completed = await completedHandlers.complete(
      acpRequest(
        "https://shop.example.test/checkout_sessions/checkout_session_acp_completed/complete",
        "idem_complete_first",
        { payment_data: { provider: "stripe", token: "spt_test_123" } },
      ),
      "checkout_session_acp_completed",
    );

    expect(completed.status).toBe(200);
    await expect(completed.json()).resolves.toMatchObject({ status: "completed" });

    const cancelCompleted = await completedHandlers.cancel(
      acpRequest(
        "https://shop.example.test/checkout_sessions/checkout_session_acp_completed/cancel",
        "idem_cancel_completed",
        {},
      ),
      "checkout_session_acp_completed",
    );

    expect(cancelCompleted.status).toBe(409);
    await expect(cancelCompleted.json()).resolves.toMatchObject({
      code: "invalid_request",
      message: "Checkout session is completed and cannot be canceled.",
    });
  });

  it("restores the previous ACP cart when reconciliation fails after mutation", async () => {
    let cart = createCart([]);
    let failSellableId: string | undefined;
    const handlers = createMikaAcpCheckoutHandlers({
      api: createAcpTestApi({
        getCart: () => cart,
        setCart: (next) => {
          cart = next;
        },
        onCartAdd: (item) =>
          String(item.sellableId) === failSellableId
            ? fail<CartDTO>(409, "OUT_OF_STOCK", "Requested item is out of stock.")
            : undefined,
        onCheckoutStart: () => {},
      }),
      store: createMemoryMikaAcpSessionStore(),
      seller: { name: "Mika Studio", links: [] },
      apiKey: "acp_test_key",
      provider: createProviderName("stripe"),
      createSessionId: () => "checkout_session_acp_rollback",
    });
    await handlers.create(
      acpRequest("https://shop.example.test/checkout_sessions", "idem_create_rollback", {
        items: [{ id: "sellable_1:price_1", quantity: 1 }],
      }),
    );
    expect(cart.items).toHaveLength(1);
    failSellableId = "sellable_fail";

    const updated = await handlers.update(
      acpRequest(
        "https://shop.example.test/checkout_sessions/checkout_session_acp_rollback",
        "idem_update_rollback",
        {
          items: [
            { id: "sellable_2:price_2", quantity: 1 },
            { id: "sellable_fail:price_fail", quantity: 1 },
          ],
        },
      ),
      "checkout_session_acp_rollback",
    );

    expect(updated.status).toBe(409);
    await expect(updated.json()).resolves.toMatchObject({
      code: "out_of_stock",
      message: "Requested item is out of stock.",
    });
    expect(cart.items).toMatchObject([
      { sellableId: "sellable_1", priceId: "price_1", quantity: 1 },
    ]);
  });

  it("requires ACP payment data to match the configured Stripe provider", async () => {
    let cart = createCart([]);
    let checkoutStartCount = 0;
    const handlers = createMikaAcpCheckoutHandlers({
      api: createAcpTestApi({
        getCart: () => cart,
        setCart: (next) => {
          cart = next;
        },
        onCheckoutStart: () => {
          checkoutStartCount += 1;
        },
      }),
      store: createMemoryMikaAcpSessionStore(),
      seller: { name: "Mika Studio", links: [] },
      apiKey: "acp_test_key",
      provider: createProviderName("stripe"),
      createSessionId: () => "checkout_session_acp_provider_mismatch",
    });
    await handlers.create(
      acpRequest("https://shop.example.test/checkout_sessions", "idem_create_provider", {
        items: [{ id: "sellable_1:price_1", quantity: 1 }],
      }),
    );

    const completed = await handlers.complete(
      acpRequest(
        "https://shop.example.test/checkout_sessions/checkout_session_acp_provider_mismatch/complete",
        "idem_complete_provider_mismatch",
        { payment_data: { provider: "adyen", token: "adyen_token_123" } },
      ),
      "checkout_session_acp_provider_mismatch",
    );

    expect(completed.status).toBe(400);
    await expect(completed.json()).resolves.toMatchObject({
      code: "invalid_request",
      message: "payment_data.provider must be 'stripe' for this checkout session.",
      param: "$.payment_data.provider",
    });
    expect(checkoutStartCount).toBe(0);
  });

  it("recovers a crashed ACP complete once the stuck idempotency claim expires", async () => {
    let cart = createCart([]);
    const store = createMemoryMikaAcpSessionStore();
    const handlers = createMikaAcpCheckoutHandlers({
      api: createAcpTestApi({
        getCart: () => cart,
        setCart: (next) => {
          cart = next;
        },
      }),
      store,
      seller: { name: "Mika Studio", links: [] },
      apiKey: "acp_test_key",
      provider: createProviderName("stripe"),
      now: () => new Date("2026-01-01T00:10:00.000Z"),
      createSessionId: () => "checkout_session_acp_lease_expiry",
    });

    await handlers.create(
      acpRequest("https://shop.example.test/checkout_sessions", "idem_create_lease_expiry", {
        items: [{ id: "sellable_1:price_1", quantity: 1 }],
      }),
    );

    // Simulate a crashed complete: its completion lock was claimed but never released.
    await expect(
      store.claimIdempotencyKey(
        "acp_complete_lock:checkout_session_acp_lease_expiry",
        "checkout_session_acp_lease_expiry",
        {
          now: createISODateTime("2026-01-01T00:00:00.000Z"),
          expiresAt: createISODateTime("2026-01-01T00:01:00.000Z"),
        },
      ),
    ).resolves.toEqual({ status: "claimed" });

    // The stuck claim expired at 00:01; the handler clock is 00:10, so completion recovers.
    const completed = await handlers.complete(
      acpRequest(
        "https://shop.example.test/checkout_sessions/checkout_session_acp_lease_expiry/complete",
        "idem_complete_lease_expiry",
        { payment_data: { provider: "stripe", token: "spt_test_123" } },
      ),
      "checkout_session_acp_lease_expiry",
    );
    expect(completed.status).toBe(200);
    await expect(completed.json()).resolves.toMatchObject({ status: "completed" });
  });

  it("keeps blocking ACP complete while a live completion claim has not expired", async () => {
    let cart = createCart([]);
    const store = createMemoryMikaAcpSessionStore();
    const handlers = createMikaAcpCheckoutHandlers({
      api: createAcpTestApi({
        getCart: () => cart,
        setCart: (next) => {
          cart = next;
        },
      }),
      store,
      seller: { name: "Mika Studio", links: [] },
      apiKey: "acp_test_key",
      provider: createProviderName("stripe"),
      now: () => new Date("2026-01-01T00:10:00.000Z"),
      createSessionId: () => "checkout_session_acp_live_lease",
    });

    await handlers.create(
      acpRequest("https://shop.example.test/checkout_sessions", "idem_create_live_lease", {
        items: [{ id: "sellable_1:price_1", quantity: 1 }],
      }),
    );

    await expect(
      store.claimIdempotencyKey(
        "acp_complete_lock:checkout_session_acp_live_lease",
        "checkout_session_acp_live_lease",
        {
          now: createISODateTime("2026-01-01T00:09:00.000Z"),
          expiresAt: createISODateTime("2026-01-01T01:00:00.000Z"),
        },
      ),
    ).resolves.toEqual({ status: "claimed" });

    const blocked = await handlers.complete(
      acpRequest(
        "https://shop.example.test/checkout_sessions/checkout_session_acp_live_lease/complete",
        "idem_complete_live_lease",
        { payment_data: { provider: "stripe", token: "spt_test_123" } },
      ),
      "checkout_session_acp_live_lease",
    );
    expect(blocked.status).toBe(409);
    await expect(blocked.json()).resolves.toMatchObject({
      code: "request_not_idempotent",
      message: "Idempotency-Key replay is already in progress.",
    });
  });

  it("validates ACP request body shapes before touching carts or sessions", async () => {
    let cart = createCart([]);
    let cartMutations = 0;
    const handlers = createMikaAcpCheckoutHandlers({
      api: createAcpTestApi({
        getCart: () => cart,
        setCart: (next) => {
          cartMutations += 1;
          cart = next;
        },
      }),
      store: createMemoryMikaAcpSessionStore(),
      seller: { name: "Mika Studio", links: [] },
      apiKey: "acp_test_key",
      provider: createProviderName("stripe"),
      createSessionId: () => "checkout_session_acp_body_validation",
    });

    const emptyItems = await handlers.create(
      acpRequest("https://shop.example.test/checkout_sessions", "idem_create_empty_items", {
        items: [],
      }),
    );
    expect(emptyItems.status).toBe(400);
    await expect(emptyItems.json()).resolves.toMatchObject({
      code: "invalid_request",
      message: expect.stringContaining("non-empty"),
      param: "$.items",
    });

    const zeroQuantity = await handlers.create(
      acpRequest("https://shop.example.test/checkout_sessions", "idem_create_zero_quantity", {
        items: [{ id: "sellable_1:price_1", quantity: 0 }],
      }),
    );
    expect(zeroQuantity.status).toBe(400);
    await expect(zeroQuantity.json()).resolves.toMatchObject({
      code: "invalid_request",
      param: "$.items[0].quantity",
    });


    const junkBuyer = await handlers.create(
      acpRequest("https://shop.example.test/checkout_sessions", "idem_create_junk_buyer", {
        buyer: "not-an-object",
        items: [{ id: "sellable_1:price_1", quantity: 1 }],
      }),
    );
    expect(junkBuyer.status).toBe(400);
    await expect(junkBuyer.json()).resolves.toMatchObject({
      code: "invalid_request",
      param: "$.buyer",
    });
    expect(cartMutations).toBe(0);

    // Agents commonly serialize omitted optionals as explicit JSON null.
    const nullBuyer = await handlers.create(
      acpRequest("https://shop.example.test/checkout_sessions", "idem_create_null_buyer", {
        buyer: null,
        fulfillment_address: null,
        items: [{ id: "sellable_1:price_1", quantity: 1 }],
      }),
    );
    expect(nullBuyer.status).toBe(201);

    const created = await handlers.create(
      acpRequest("https://shop.example.test/checkout_sessions", "idem_create_body_validation", {
        items: [{ id: "sellable_1:price_1", quantity: 1 }],
      }),
    );
    expect(created.status).toBe(201);

    const badOption = await handlers.update(
      acpRequest(
        "https://shop.example.test/checkout_sessions/checkout_session_acp_body_validation",
        "idem_update_bad_option",
        { fulfillment_option_id: 123 },
      ),
      "checkout_session_acp_body_validation",
    );
    expect(badOption.status).toBe(400);
    await expect(badOption.json()).resolves.toMatchObject({
      code: "invalid_request",
      param: "$.fulfillment_option_id",
    });

    const missingPayment = await handlers.complete(
      acpRequest(
        "https://shop.example.test/checkout_sessions/checkout_session_acp_body_validation/complete",
        "idem_complete_missing_payment",
        { buyer: { email: "ada@example.test" } },
      ),
      "checkout_session_acp_body_validation",
    );
    expect(missingPayment.status).toBe(400);
    await expect(missingPayment.json()).resolves.toMatchObject({
      code: "invalid_request",
      param: "$.payment_data",
    });
  });

  it("rejects concurrent ACP idempotency replays while the first request is in progress", async () => {
    let cart = createCart([]);
    let releaseCheckoutStart!: () => void;
    let enteredCheckoutStart!: () => void;
    const checkoutStartEntered = new Promise<void>((resolve) => {
      enteredCheckoutStart = resolve;
    });
    const checkoutStartRelease = new Promise<void>((resolve) => {
      releaseCheckoutStart = resolve;
    });
    let checkoutStartCount = 0;
    const handlers = createMikaAcpCheckoutHandlers({
      api: createAcpTestApi({
        getCart: () => cart,
        setCart: (next) => {
          cart = next;
        },
        onCheckoutStart: async () => {
          checkoutStartCount += 1;
          enteredCheckoutStart();
          await checkoutStartRelease;
        },
      }),
      store: createMemoryMikaAcpSessionStore(),
      seller: { name: "Mika Studio", links: [] },
      apiKey: "acp_test_key",
      provider: createProviderName("stripe"),
      createSessionId: () => "checkout_session_acp_idempotency",
    });
    await handlers.create(
      acpRequest("https://shop.example.test/checkout_sessions", "idem_create_idempotency", {
        items: [{ id: "sellable_1:price_1", quantity: 1 }],
      }),
    );

    const first = handlers.complete(
      acpRequest(
        "https://shop.example.test/checkout_sessions/checkout_session_acp_idempotency/complete",
        "idem_complete_shared",
        { payment_data: { provider: "stripe", token: "spt_test_123" } },
      ),
      "checkout_session_acp_idempotency",
    );
    await checkoutStartEntered;
    const second = await handlers.complete(
      acpRequest(
        "https://shop.example.test/checkout_sessions/checkout_session_acp_idempotency/complete",
        "idem_complete_shared",
        { payment_data: { provider: "stripe", token: "spt_test_123" } },
      ),
      "checkout_session_acp_idempotency",
    );

    expect(second.status).toBe(409);
    await expect(second.json()).resolves.toMatchObject({
      code: "request_not_idempotent",
      message: "Idempotency-Key replay is already in progress.",
    });
    releaseCheckoutStart();
    await expect(first).resolves.toMatchObject({ status: 200 });
    expect(checkoutStartCount).toBe(1);
  });
});

describe("Mika Stripe provider", () => {
  it("maps Stripe refund statuses to admin action statuses", async () => {
    const refundActionStatus = async (status: string | null) => {
      const stripe: MikaStripeClient = {
        refunds: {
          create: async () => ({ id: "re_test_1", status }),
        },
      };
      const provider = createMikaStripeProvider({ stripe });
      const result = await provider.refundPayment?.({
        orderId: createMikaId("order_1"),
        providerPaymentId: "pi_test_1",
      });

      return result?.status;
    };

    expect(await refundActionStatus("succeeded")).toBe("completed");
    expect(await refundActionStatus("pending")).toBe("running");
    expect(await refundActionStatus("requires_action")).toBe("running");
    expect(await refundActionStatus("failed")).toBe("failed");
    expect(await refundActionStatus("canceled")).toBe("failed");
    expect(await refundActionStatus(null)).toBe("running");
  });

  it("forwards the admin idempotency key to Stripe refunds.create so retries dedupe", async () => {
    let capturedIdempotencyKey: string | undefined;
    const stripe: MikaStripeClient = {
      refunds: {
        create: async (_params, options) => {
          capturedIdempotencyKey = options?.idempotencyKey;

          return { id: "re_test_1", status: "succeeded" };
        },
      },
    };
    const provider = createMikaStripeProvider({ stripe });
    await provider.refundPayment?.({
      orderId: createMikaId("order_1"),
      providerPaymentId: "pi_test_1",
      idempotencyKey: "refund-1",
    });

    expect(capturedIdempotencyKey).toBe("refund-1_refund");
  });

  it("creates hosted checkout sessions from provider price ids", async () => {
    const createCalls: unknown[] = [];
    const stripe: MikaStripeClient = {
      checkout: {
        sessions: {
          create: async (params, options) => {
            createCalls.push({ params, options });

            return {
              id: "cs_test_123",
              status: "open",
              payment_status: "unpaid",
              mode: "payment",
              url: "https://checkout.stripe.test/cs_test_123",
              expires_at: 1_767_225_600,
              customer: "cus_test_123",
            };
          },
          retrieve: async () => ({ id: "cs_test_123", status: "complete", mode: "payment" }),
        },
      },
    };
    const provider = createMikaStripeProvider({ stripe });

    await expect(
      provider.createCheckoutSession({
        idempotencyKey: "idem_1",
        mode: "payment",
        provider: createProviderName("stripe"),
        successUrl: "https://shop.example.test/success",
        cancelUrl: "https://shop.example.test/cancel",
        lines: [
          {
            sellableId: createMikaId("sellable_1"),
            priceId: createMikaId("price_1"),
            contentRef: { collection: "products", id: "print" },
            title: "Limited print",
            providerPriceId: "price_stripe_123",
            quantity: 2,
            unitAmount: 1200,
            currency: createCurrencyCode("EUR"),
            mode: "payment",
            fulfillmentKind: "download",
          },
        ],
      }),
    ).resolves.toMatchObject({
      id: "cs_test_123",
      status: "redirected",
      redirectUrl: "https://checkout.stripe.test/cs_test_123",
      providerCheckoutId: "cs_test_123",
      providerCustomerId: "cus_test_123",
    });
    expect(createCalls[0]).toMatchObject({
      params: {
        line_items: [{ price: "price_stripe_123", quantity: 2 }],
      },
      options: { idempotencyKey: "idem_1" },
    });
  });

  it("maps catalog billing cadence onto inline subscription price_data", async () => {
    const createCalls: { params: MikaStripeCheckoutSessionCreateParams }[] = [];
    const stripe: MikaStripeClient = {
      checkout: {
        sessions: {
          create: async (params) => {
            createCalls.push({ params });
            return {
              id: "cs_sub_1",
              status: "open",
              mode: "subscription",
              url: "https://checkout.stripe.test/cs_sub_1",
            };
          },
          retrieve: async () => ({ id: "cs_sub_1", status: "open", mode: "subscription" }),
        },
      },
    };
    const provider = createMikaStripeProvider({ stripe });

    await provider.createCheckoutSession({
      idempotencyKey: "idem_sub_1",
      mode: "subscription",
      provider: createProviderName("stripe"),
      successUrl: "https://shop.example.test/success",
      cancelUrl: "https://shop.example.test/cancel",
      lines: [
        {
          sellableId: createMikaId("sellable_sub"),
          priceId: createMikaId("price_sub"),
          contentRef: { collection: "products", id: "membership" },
          title: "Annual membership",
          quantity: 1,
          unitAmount: 12000,
          currency: createCurrencyCode("EUR"),
          mode: "subscription",
          fulfillmentKind: "none",
          interval: "year",
          intervalCount: 2,
        },
      ],
    });

    expect(createCalls[0]?.params.line_items[0]).toMatchObject({
      price_data: {
        recurring: { interval: "year", interval_count: 2 },
      },
    });
  });

  it("uses Stripe shared payment granted tokens for delegated ACP checkout", async () => {
    const intentCalls: unknown[] = [];
    const stripe: MikaStripeClient = {
      paymentIntents: {
        create: async (params, options) => {
          intentCalls.push({ params, options });

          return {
            id: "pi_test_123",
            status: "succeeded",
            amount: 2400,
            currency: "eur",
          };
        },
      },
    };
    const provider = createMikaStripeProvider({ stripe });

    await expect(
      provider.createCheckoutSession({
        idempotencyKey: "idem_spt_1",
        mode: "payment",
        provider: createProviderName("stripe"),
        successUrl: "https://shop.example.test/success",
        cancelUrl: "https://shop.example.test/cancel",
        metadata: {
          [MIKA_STRIPE_DELEGATED_PAYMENT_TOKEN_METADATA_KEY]: "spt_test_123",
        },
        lines: [
          {
            sellableId: createMikaId("sellable_1"),
            priceId: createMikaId("price_1"),
            contentRef: { collection: "products", id: "print" },
            title: "Limited print",
            quantity: 2,
            unitAmount: 1200,
            currency: createCurrencyCode("EUR"),
            mode: "payment",
            fulfillmentKind: "download",
          },
        ],
      }),
    ).resolves.toMatchObject({
      id: "pi_test_123",
      status: "completed",
      providerCheckoutId: "pi_test_123",
    });
    expect(intentCalls[0]).toMatchObject({
      params: {
        amount: 2400,
        currency: "eur",
        confirm: true,
        payment_method_data: { shared_payment_granted_token: "spt_test_123" },
      },
      options: { idempotencyKey: "idem_spt_1" },
    });
  });

  it("applies an order-level discount as a one-time Stripe coupon on hosted checkout", async () => {
    const sessionCalls: unknown[] = [];
    const couponCalls: unknown[] = [];
    const stripe: MikaStripeClient = {
      checkout: {
        sessions: {
          create: async (params) => {
            sessionCalls.push({ params });
            return {
              id: "cs_disc_1",
              status: "open",
              mode: "payment",
              url: "https://checkout.stripe.test/cs_disc_1",
            };
          },
          retrieve: async () => ({ id: "cs_disc_1", status: "open", mode: "payment" }),
        },
      },
      coupons: {
        create: async (params, options) => {
          couponCalls.push({ params, options });
          return { id: "coupon_test_1" };
        },
      },
    };
    const provider = createMikaStripeProvider({ stripe });

    await provider.createCheckoutSession({
      idempotencyKey: "idem_disc_1",
      mode: "payment",
      provider: createProviderName("stripe"),
      successUrl: "https://shop.example.test/success",
      cancelUrl: "https://shop.example.test/cancel",
      discount: { amount: 240, currency: createCurrencyCode("EUR") },
      lines: [
        {
          sellableId: createMikaId("sellable_1"),
          priceId: createMikaId("price_1"),
          contentRef: { collection: "products", id: "print" },
          title: "Limited print",
          providerPriceId: "price_stripe_123",
          quantity: 2,
          unitAmount: 1200,
          currency: createCurrencyCode("EUR"),
          mode: "payment",
          fulfillmentKind: "download",
        },
      ],
    });

    expect(couponCalls[0]).toMatchObject({
      params: { amount_off: 240, currency: "eur", duration: "once" },
      options: { idempotencyKey: "idem_disc_1_coupon" },
    });
    expect(sessionCalls[0]).toMatchObject({
      params: { discounts: [{ coupon: "coupon_test_1" }] },
    });
  });

  it("fails a discounted hosted checkout when Stripe coupons are unavailable", async () => {
    const stripe: MikaStripeClient = {
      checkout: {
        sessions: {
          create: async () => ({ id: "cs_x", status: "open", mode: "payment" }),
          retrieve: async () => ({ id: "cs_x", status: "open", mode: "payment" }),
        },
      },
    };
    const provider = createMikaStripeProvider({ stripe });

    await expect(
      provider.createCheckoutSession({
        idempotencyKey: "idem_disc_fail",
        mode: "payment",
        provider: createProviderName("stripe"),
        successUrl: "https://shop.example.test/success",
        cancelUrl: "https://shop.example.test/cancel",
        discount: { amount: 240, currency: createCurrencyCode("EUR") },
        lines: [
          {
            sellableId: createMikaId("sellable_1"),
            priceId: createMikaId("price_1"),
            contentRef: { collection: "products", id: "print" },
            title: "Limited print",
            providerPriceId: "price_stripe_123",
            quantity: 2,
            unitAmount: 1200,
            currency: createCurrencyCode("EUR"),
            mode: "payment",
            fulfillmentKind: "download",
          },
        ],
      }),
    ).rejects.toThrow(/coupons are required/i);
  });

  it("subtracts an order-level discount from the delegated payment amount", async () => {
    const intentCalls: unknown[] = [];
    const stripe: MikaStripeClient = {
      paymentIntents: {
        create: async (params) => {
          intentCalls.push({ params });
          return { id: "pi_disc_1", status: "succeeded", amount: 2160, currency: "eur" };
        },
      },
    };
    const provider = createMikaStripeProvider({ stripe });

    await provider.createCheckoutSession({
      idempotencyKey: "idem_spt_disc_1",
      mode: "payment",
      provider: createProviderName("stripe"),
      successUrl: "https://shop.example.test/success",
      cancelUrl: "https://shop.example.test/cancel",
      metadata: { [MIKA_STRIPE_DELEGATED_PAYMENT_TOKEN_METADATA_KEY]: "spt_test_123" },
      discount: { amount: 240, currency: createCurrencyCode("EUR") },
      lines: [
        {
          sellableId: createMikaId("sellable_1"),
          priceId: createMikaId("price_1"),
          contentRef: { collection: "products", id: "print" },
          title: "Limited print",
          quantity: 2,
          unitAmount: 1200,
          currency: createCurrencyCode("EUR"),
          mode: "payment",
          fulfillmentKind: "download",
        },
      ],
    });

    expect(intentCalls[0]).toMatchObject({ params: { amount: 2160, currency: "eur" } });
  });

  it("does not let a negative delegated-payment discount increase the charge amount", async () => {
    const intentCalls: unknown[] = [];
    const stripe: MikaStripeClient = {
      paymentIntents: {
        create: async (params) => {
          intentCalls.push({ params });
          return { id: "pi_disc_negative", status: "succeeded", amount: 2400, currency: "eur" };
        },
      },
    };
    const provider = createMikaStripeProvider({ stripe });

    await provider.createCheckoutSession({
      idempotencyKey: "idem_spt_disc_negative",
      mode: "payment",
      provider: createProviderName("stripe"),
      successUrl: "https://shop.example.test/success",
      cancelUrl: "https://shop.example.test/cancel",
      metadata: { [MIKA_STRIPE_DELEGATED_PAYMENT_TOKEN_METADATA_KEY]: "spt_test_123" },
      discount: { amount: -500, currency: createCurrencyCode("EUR") },
      lines: [
        {
          sellableId: createMikaId("sellable_1"),
          priceId: createMikaId("price_1"),
          contentRef: { collection: "products", id: "print" },
          title: "Limited print",
          quantity: 2,
          unitAmount: 1200,
          currency: createCurrencyCode("EUR"),
          mode: "payment",
          fulfillmentKind: "download",
        },
      ],
    });

    expect(intentCalls[0]).toMatchObject({ params: { amount: 2400, currency: "eur" } });
  });

  it("resolves the invoice id from a payment-intent id before retrieving the invoice", async () => {
    const invoiceCalls: string[] = [];
    const intentCalls: string[] = [];
    const stripe: MikaStripeClient = {
      paymentIntents: {
        create: async () => ({ id: "pi_unused" }),
        retrieve: async (id) => {
          intentCalls.push(id);
          return { id, status: "succeeded", invoice: "in_456" };
        },
      },
      invoices: {
        retrieve: async (id) => {
          invoiceCalls.push(id);
          return { id, hosted_invoice_url: "https://invoice.stripe.test/in_456" };
        },
      },
    };
    const provider = createMikaStripeProvider({ stripe });

    await expect(
      provider.getInvoiceUrl?.({ orderId: createMikaId("order_1"), providerPaymentId: "pi_123" }),
    ).resolves.toEqual({
      orderId: "order_1",
      href: "https://invoice.stripe.test/in_456",
    });
    expect(intentCalls).toEqual(["pi_123"]);
    expect(invoiceCalls).toEqual(["in_456"]);
  });

  it("returns an empty invoice result when a payment intent has no invoice", async () => {
    const invoiceCalls: string[] = [];
    const stripe: MikaStripeClient = {
      paymentIntents: {
        create: async () => ({ id: "pi_unused" }),
        retrieve: async (id) => ({ id, status: "succeeded" }),
      },
      invoices: {
        retrieve: async (id) => {
          invoiceCalls.push(id);
          return { id, hosted_invoice_url: "https://invoice.stripe.test/unused" };
        },
      },
    };
    const provider = createMikaStripeProvider({ stripe });

    await expect(
      provider.getInvoiceUrl?.({ orderId: createMikaId("order_1"), providerPaymentId: "pi_123" }),
    ).resolves.toEqual({ orderId: "order_1" });
    expect(invoiceCalls).toEqual([]);
  });

  it("retrieves the invoice directly when given a Stripe invoice id", async () => {
    const invoiceCalls: string[] = [];
    const stripe: MikaStripeClient = {
      invoices: {
        retrieve: async (id) => {
          invoiceCalls.push(id);
          return { id, hosted_invoice_url: "https://invoice.stripe.test/in_789" };
        },
      },
    };
    const provider = createMikaStripeProvider({ stripe });

    await expect(
      provider.getInvoiceUrl?.({ orderId: createMikaId("order_1"), providerPaymentId: "in_789" }),
    ).resolves.toEqual({
      orderId: "order_1",
      href: "https://invoice.stripe.test/in_789",
    });
    expect(invoiceCalls).toEqual(["in_789"]);
  });

  it("schedules a subscription cancel at period end instead of terminating immediately", async () => {
    const updateCalls: Array<{ id: string; params: JsonObject }> = [];
    const cancelCalls: string[] = [];
    const stripe: MikaStripeClient = {
      subscriptions: {
        cancel: async (id) => {
          cancelCalls.push(id);
          return { id, status: "canceled" };
        },
        update: async (id, params) => {
          updateCalls.push({ id, params });
          return { id, status: "active" };
        },
      },
    };
    const provider = createMikaStripeProvider({ stripe });

    await expect(
      provider.cancelSubscription?.({
        subscriptionId: createMikaId("sub_1"),
        providerSubscriptionId: "sub_123",
      }),
    ).resolves.toMatchObject({ status: "completed" });

    expect(cancelCalls).toEqual([]);
    expect(updateCalls).toEqual([{ id: "sub_123", params: { cancel_at_period_end: true } }]);
  });

  it("returns failed admin action DTOs for Stripe SDK rejections", async () => {
    const stripe: MikaStripeClient = {
      paymentIntents: {
        create: async () => ({ id: "pi_unused" }),
        cancel: async () => {
          throw new Error("payment intent cannot be cancelled");
        },
      },
      subscriptions: {
        cancel: async () => {
          throw new Error("subscription cancel failed");
        },
        update: async () => {
          throw new Error("subscription update failed");
        },
        resume: async () => {
          throw new Error("subscription resume failed");
        },
      },
    };
    const provider = createMikaStripeProvider({ stripe });

    await expect(
      provider.cancelOrder?.({
        orderId: createMikaId("order_1"),
        providerOrderId: "pi_succeeded",
      }),
    ).resolves.toMatchObject({
      id: "order_cancel",
      status: "failed",
      message: "payment intent cannot be cancelled",
    });
    await expect(
      provider.cancelSubscription?.({
        subscriptionId: createMikaId("subscription_1"),
        providerSubscriptionId: "sub_123",
      }),
    ).resolves.toMatchObject({
      id: "subscription_cancel",
      status: "failed",
      message: "subscription update failed",
    });
    await expect(
      provider.changeSubscription?.({
        subscriptionId: createMikaId("subscription_1"),
        providerSubscriptionId: "sub_123",
        providerPriceId: "price_next",
      }),
    ).resolves.toMatchObject({
      id: "subscription_change",
      status: "failed",
      message: "subscription update failed",
    });
    await expect(
      provider.renewSubscription?.({
        subscriptionId: createMikaId("subscription_1"),
        providerSubscriptionId: "sub_123",
      }),
    ).resolves.toMatchObject({
      id: "subscription_renew",
      status: "failed",
      message: "subscription resume failed",
    });
  });

  it("prefers providerPaymentId over providerOrderId when cancelling Stripe orders", async () => {
    const cancelCalls: string[] = [];
    const stripe: MikaStripeClient = {
      paymentIntents: {
        create: async () => ({ id: "pi_unused" }),
        cancel: async (id) => {
          cancelCalls.push(id);
          return { id, status: "canceled" };
        },
      },
    };
    const provider = createMikaStripeProvider({ stripe });

    await expect(
      provider.cancelOrder?.({
        orderId: createMikaId("order_1"),
        providerPaymentId: "pi_payment",
        providerOrderId: "in_invoice",
      }),
    ).resolves.toMatchObject({
      id: "pi_payment",
      status: "completed",
    });

    expect(cancelCalls).toEqual(["pi_payment"]);
  });

  it("derives Stripe capabilities from the configured client by default", async () => {
    const stripe: MikaStripeClient = {
      checkout: {
        sessions: {
          create: async () => ({
            id: "cs_test_123",
            status: "open",
            mode: "payment",
            url: "https://checkout.stripe.test/cs_test_123",
          }),
          retrieve: async () => ({ id: "cs_test_123", status: "complete", mode: "payment" }),
        },
      },
    };
    const provider = createMikaStripeProvider({ stripe });

    await expectMethodBackedProviderCapabilities(provider);
    expect(await Promise.resolve(provider.capabilities())).toEqual(["hosted_checkout", "payments"]);
    await expect(provider.health?.()).resolves.toMatchObject({
      ok: true,
      capabilities: ["hosted_checkout", "payments"],
      warnings: ["Stripe webhook secret is not configured."],
    });
  });

  it("verifies and normalizes Stripe checkout webhooks", async () => {
    const payload = {
      id: "evt_test_123",
      type: "checkout.session.completed",
      data: {
        object: {
          id: "cs_test_123",
          payment_intent: "pi_test_123",
          customer: "cus_test_123",
          customer_email: "ada@example.test",
          payment_status: "paid",
          amount_total: 2400,
          currency: "eur",
        },
      },
    };
    const stripe: MikaStripeClient = {
      webhooks: {
        constructEvent: (body, signature, secret) => {
          expect(signature).toBe("sig_test");
          expect(secret).toBe("whsec_test");

          return JSON.parse(body) as JsonObject;
        },
      },
    };
    const provider = createMikaStripeProvider({ stripe, webhookSecret: "whsec_test" });
    const rawBody = new TextEncoder().encode(JSON.stringify(payload));
    const verified = await provider.verifyWebhook?.({
      provider: createProviderName("stripe"),
      request: new Request("https://shop.example.test/api/stripe", {
        method: "POST",
        headers: { "stripe-signature": "sig_test" },
        body: rawBody,
      }),
      rawBody,
    });

    expect(verified).toMatchObject({
      provider: "stripe",
      payloadHash: expect.stringContaining("sha256:"),
    });
    const event = await provider.parseWebhookEvent?.(verified!);
    if (!event) throw new Error("Expected Stripe checkout webhook event.");

    expectPaidProviderPaymentEvent(event);
    expect(event).toMatchObject({
      kind: "payment",
      paymentStatus: "paid",
      provider: "stripe",
      providerEventId: "evt_test_123",
      type: "checkout.session.completed",
      providerCheckoutId: "cs_test_123",
      providerPaymentId: "pi_test_123",
      providerOrderId: "pi_test_123",
      customer: { email: "ada@example.test" },
      totals: { total: { amount: 2400, currency: "EUR" } },
    });
  });

  it("normalizes delegated Stripe payment_intent.succeeded webhooks with a checkout id", async () => {
    const payload = {
      id: "evt_delegated_paid",
      type: "payment_intent.succeeded",
      data: {
        object: {
          id: "pi_delegated_paid",
          status: "succeeded",
          amount: 2400,
          currency: "eur",
        },
      },
    };
    const stripe: MikaStripeClient = {
      webhooks: {
        constructEvent: (body) => JSON.parse(body) as JsonObject,
      },
    };
    const provider = createMikaStripeProvider({ stripe, webhookSecret: "whsec_test" });
    const rawBody = new TextEncoder().encode(JSON.stringify(payload));
    const verified = await provider.verifyWebhook?.({
      provider: createProviderName("stripe"),
      request: new Request("https://shop.example.test/api/stripe", {
        method: "POST",
        headers: { "stripe-signature": "sig_test" },
        body: rawBody,
      }),
      rawBody,
    });

    const event = await provider.parseWebhookEvent?.(verified!);
    if (!event) throw new Error("Expected Stripe delegated payment webhook event.");

    expectPaidProviderPaymentEvent(event);
    expect(event).toMatchObject({
      kind: "payment",
      paymentStatus: "paid",
      provider: "stripe",
      providerEventId: "evt_delegated_paid",
      type: "payment_intent.succeeded",
      providerCheckoutId: "pi_delegated_paid",
      providerPaymentId: "pi_delegated_paid",
      providerOrderId: "pi_delegated_paid",
      totals: { total: { amount: 2400, currency: "EUR" } },
    });
  });

  it("normalizes no-payment-required completed Stripe checkout webhooks as paid", async () => {
    const payload = {
      id: "evt_zero_total",
      type: "checkout.session.completed",
      data: {
        object: {
          id: "cs_zero_total",
          customer_email: "ada@example.test",
          payment_status: "no_payment_required",
          amount_total: 0,
          currency: "eur",
        },
      },
    };
    const stripe: MikaStripeClient = {
      webhooks: {
        constructEvent: (body) => JSON.parse(body) as JsonObject,
      },
    };
    const provider = createMikaStripeProvider({ stripe, webhookSecret: "whsec_test" });
    const rawBody = new TextEncoder().encode(JSON.stringify(payload));
    const verified = await provider.verifyWebhook?.({
      provider: createProviderName("stripe"),
      request: new Request("https://shop.example.test/api/stripe", {
        method: "POST",
        headers: { "stripe-signature": "sig_test" },
        body: rawBody,
      }),
      rawBody,
    });

    const event = await provider.parseWebhookEvent?.(verified!);
    if (!event) throw new Error("Expected Stripe zero-total checkout webhook event.");

    expectPaidProviderPaymentEvent(event);
    expect(event).toMatchObject({
      kind: "payment",
      paymentStatus: "paid",
      provider: "stripe",
      providerEventId: "evt_zero_total",
      type: "checkout.session.completed",
      providerCheckoutId: "cs_zero_total",
      providerOrderId: "cs_zero_total",
      customer: { email: "ada@example.test" },
      totals: { total: { amount: 0, currency: "EUR" } },
    });
  });

  it("normalizes Stripe async-payment-succeeded checkout webhooks as paid payment events", async () => {
    const payload = {
      id: "evt_async_succeeded",
      type: "checkout.session.async_payment_succeeded",
      data: {
        object: {
          id: "cs_async_succeeded",
          payment_intent: "pi_async",
          customer: "cus_async",
          customer_email: "ada@example.test",
          payment_status: "paid",
          amount_total: 2400,
          currency: "eur",
        },
      },
    };
    const stripe: MikaStripeClient = {
      webhooks: {
        constructEvent: (body) => JSON.parse(body) as JsonObject,
      },
    };
    const provider = createMikaStripeProvider({ stripe, webhookSecret: "whsec_test" });
    const rawBody = new TextEncoder().encode(JSON.stringify(payload));
    const verified = await provider.verifyWebhook?.({
      provider: createProviderName("stripe"),
      request: new Request("https://shop.example.test/api/stripe", {
        method: "POST",
        headers: { "stripe-signature": "sig_test" },
        body: rawBody,
      }),
      rawBody,
    });

    const event = await provider.parseWebhookEvent?.(verified!);
    if (!event) throw new Error("Expected Stripe async-payment-succeeded webhook event.");

    expectPaidProviderPaymentEvent(event);
    expect(event).toMatchObject({
      kind: "payment",
      paymentStatus: "paid",
      provider: "stripe",
      providerEventId: "evt_async_succeeded",
      type: "checkout.session.async_payment_succeeded",
      providerCheckoutId: "cs_async_succeeded",
      providerPaymentId: "pi_async",
      providerOrderId: "pi_async",
      customer: { email: "ada@example.test" },
      totals: { total: { amount: 2400, currency: "EUR" } },
    });
  });

  it("normalizes explicitly paid Stripe invoice webhooks", async () => {
    const payload = {
      id: "evt_invoice_paid",
      type: "invoice.paid",
      data: {
        object: {
          id: "in_paid",
          payment_intent: "pi_paid",
          customer_email: "ada@example.test",
          paid: true,
          status: "paid",
          amount_paid: 2400,
          currency: "eur",
        },
      },
    };
    const stripe: MikaStripeClient = {
      webhooks: {
        constructEvent: (body) => JSON.parse(body) as JsonObject,
      },
    };
    const provider = createMikaStripeProvider({ stripe, webhookSecret: "whsec_test" });
    const rawBody = new TextEncoder().encode(JSON.stringify(payload));
    const verified = await provider.verifyWebhook?.({
      provider: createProviderName("stripe"),
      request: new Request("https://shop.example.test/api/stripe", {
        method: "POST",
        headers: { "stripe-signature": "sig_test" },
        body: rawBody,
      }),
      rawBody,
    });

    const event = await provider.parseWebhookEvent?.(verified!);
    if (!event) throw new Error("Expected Stripe invoice webhook event.");

    expectPaidProviderPaymentEvent(event);
    expect(event).toMatchObject({
      kind: "payment",
      paymentStatus: "paid",
      provider: "stripe",
      providerEventId: "evt_invoice_paid",
      type: "invoice.paid",
      providerPaymentId: "pi_paid",
      providerOrderId: "in_paid",
      customer: { email: "ada@example.test" },
      totals: { total: { amount: 2400, currency: "EUR" } },
    });
  });

  it("does not normalize non-success Stripe webhooks as payments", async () => {
    const stripe: MikaStripeClient = {
      webhooks: {
        constructEvent: (body) => JSON.parse(body) as JsonObject,
      },
    };
    const provider = createMikaStripeProvider({ stripe, webhookSecret: "whsec_test" });
    const parse = async (payload: JsonObject): Promise<MikaProviderWebhookEvent> => {
      const rawBody = new TextEncoder().encode(JSON.stringify(payload));
      const verified = await provider.verifyWebhook?.({
        provider: createProviderName("stripe"),
        request: new Request("https://shop.example.test/api/stripe", {
          method: "POST",
          headers: { "stripe-signature": "sig_test" },
          body: rawBody,
        }),
        rawBody,
      });

      const event = await provider.parseWebhookEvent?.(verified!);
      if (!event) throw new Error("Expected Stripe webhook event.");

      return event;
    };

    const unknownCases: readonly JsonObject[] = [
      {
        id: "evt_payment_canceled",
        type: "payment_intent.canceled",
        data: { object: { id: "pi_canceled", status: "canceled" } },
      },
      {
        id: "evt_invoice_unpaid",
        type: "invoice.paid",
        data: { object: { id: "in_unpaid", paid: false, amount_paid: 0 } },
      },
      {
        id: "evt_invoice_partial",
        type: "invoice.payment_succeeded",
        data: { object: { id: "in_partial", paid: false, status: "open", amount_paid: 100 } },
      },
    ];

    for (const payload of unknownCases) {
      const event = await parse(payload);
      expectNonFulfillingProviderEvent(event);
      expect(event).toMatchObject({
        kind: "unknown",
        provider: "stripe",
        providerEventId: payload["id"],
        type: payload["type"],
      });
    }
  });

  it("normalizes Stripe payment-failure webhooks as failed payment events", async () => {
    const stripe: MikaStripeClient = {
      webhooks: {
        constructEvent: (body) => JSON.parse(body) as JsonObject,
      },
    };
    const provider = createMikaStripeProvider({ stripe, webhookSecret: "whsec_test" });
    const parse = async (payload: JsonObject): Promise<MikaProviderWebhookEvent> => {
      const rawBody = new TextEncoder().encode(JSON.stringify(payload));
      const verified = await provider.verifyWebhook?.({
        provider: createProviderName("stripe"),
        request: new Request("https://shop.example.test/api/stripe", {
          method: "POST",
          headers: { "stripe-signature": "sig_test" },
          body: rawBody,
        }),
        rawBody,
      });
      const event = await provider.parseWebhookEvent?.(verified!);
      if (!event) throw new Error("Expected Stripe webhook event.");

      return event;
    };

    const asyncFailed = await parse({
      id: "evt_async_failed",
      type: "checkout.session.async_payment_failed",
      data: {
        object: {
          id: "cs_async_failed",
          payment_status: "unpaid",
          payment_intent: "pi_async",
          customer_email: "ada@example.test",
        },
      },
    });
    expectNonFulfillingProviderEvent(asyncFailed);
    expect(asyncFailed).toMatchObject({
      kind: "payment",
      paymentStatus: "failed",
      provider: "stripe",
      providerEventId: "evt_async_failed",
      type: "checkout.session.async_payment_failed",
      providerCheckoutId: "cs_async_failed",
      providerPaymentId: "pi_async",
      providerOrderId: "pi_async",
      customer: { email: "ada@example.test" },
    });

    const checkoutExpired = await parse({
      id: "evt_checkout_expired",
      type: "checkout.session.expired",
      data: {
        object: {
          id: "cs_expired",
          payment_status: "unpaid",
          payment_intent: "pi_expired",
          customer_email: "ada@example.test",
        },
      },
    });
    expectNonFulfillingProviderEvent(checkoutExpired);
    expect(checkoutExpired).toMatchObject({
      kind: "payment",
      paymentStatus: "failed",
      provider: "stripe",
      providerEventId: "evt_checkout_expired",
      type: "checkout.session.expired",
      providerCheckoutId: "cs_expired",
      providerPaymentId: "pi_expired",
      providerOrderId: "pi_expired",
      customer: { email: "ada@example.test" },
    });

    const intentFailed = await parse({
      id: "evt_payment_failed",
      type: "payment_intent.payment_failed",
      data: { object: { id: "pi_failed", status: "requires_payment_method" } },
    });
    expectNonFulfillingProviderEvent(intentFailed);
    expect(intentFailed).toMatchObject({
      kind: "payment",
      paymentStatus: "failed",
      provider: "stripe",
      providerEventId: "evt_payment_failed",
      type: "payment_intent.payment_failed",
      providerPaymentId: "pi_failed",
      providerOrderId: "pi_failed",
    });

    const invoiceFailed = await parse({
      id: "evt_invoice_failed",
      type: "invoice.payment_failed",
      data: { object: { id: "in_failed", paid: false, amount_paid: 0, payment_intent: "pi_inv" } },
    });
    expectNonFulfillingProviderEvent(invoiceFailed);
    expect(invoiceFailed).toMatchObject({
      kind: "payment",
      paymentStatus: "failed",
      provider: "stripe",
      providerEventId: "evt_invoice_failed",
      type: "invoice.payment_failed",
      providerPaymentId: "pi_inv",
      providerOrderId: "in_failed",
    });
  });

  it("normalizes Stripe refund/chargeback/uncollectible webhooks as reversal payment events", async () => {
    const stripe: MikaStripeClient = {
      webhooks: {
        constructEvent: (body) => JSON.parse(body) as JsonObject,
      },
    };
    const provider = createMikaStripeProvider({ stripe, webhookSecret: "whsec_test" });
    const parse = async (payload: JsonObject): Promise<MikaProviderWebhookEvent> => {
      const rawBody = new TextEncoder().encode(JSON.stringify(payload));
      const verified = await provider.verifyWebhook?.({
        provider: createProviderName("stripe"),
        request: new Request("https://shop.example.test/api/stripe", {
          method: "POST",
          headers: { "stripe-signature": "sig_test" },
          body: rawBody,
        }),
        rawBody,
      });
      const event = await provider.parseWebhookEvent?.(verified!);
      if (!event) throw new Error("Expected Stripe webhook event.");

      return event;
    };

    const fullRefund = await parse({
      id: "evt_charge_refunded",
      type: "charge.refunded",
      data: {
        object: {
          id: "ch_refunded",
          payment_intent: "pi_refunded",
          refunded: true,
          amount: 2400,
          amount_refunded: 2400,
          currency: "eur",
        },
      },
    });
    expectNonFulfillingProviderEvent(fullRefund);
    expect(fullRefund).toMatchObject({
      kind: "payment",
      paymentStatus: "refunded",
      provider: "stripe",
      providerEventId: "evt_charge_refunded",
      type: "charge.refunded",
      providerPaymentId: "pi_refunded",
      providerOrderId: "pi_refunded",
      totals: { total: { amount: 2400, currency: "EUR" } },
    });

    const partialRefund = await parse({
      id: "evt_charge_partial",
      type: "charge.refunded",
      data: {
        object: {
          id: "ch_partial",
          payment_intent: "pi_partial",
          refunded: false,
          amount: 2400,
          amount_refunded: 600,
          currency: "eur",
        },
      },
    });
    expectNonFulfillingProviderEvent(partialRefund);
    expect(partialRefund).toMatchObject({
      kind: "payment",
      paymentStatus: "partially_refunded",
      type: "charge.refunded",
      providerPaymentId: "pi_partial",
      totals: { total: { amount: 600, currency: "EUR" } },
    });

    const dispute = await parse({
      id: "evt_dispute",
      type: "charge.dispute.created",
      data: {
        object: { id: "dp_1", payment_intent: "pi_disputed", amount: 2400, currency: "eur" },
      },
    });
    expectNonFulfillingProviderEvent(dispute);
    expect(dispute).toMatchObject({
      kind: "unknown",
      provider: "stripe",
      providerEventId: "evt_dispute",
      type: "charge.dispute.created",
    });

    const uncollectible = await parse({
      id: "evt_uncollectible",
      type: "invoice.marked_uncollectible",
      data: { object: { id: "in_unc", payment_intent: "pi_unc", amount: 2400, currency: "eur" } },
    });
    expectNonFulfillingProviderEvent(uncollectible);
    expect(uncollectible).toMatchObject({
      kind: "payment",
      paymentStatus: "refunded",
      type: "invoice.marked_uncollectible",
      providerPaymentId: "pi_unc",
    });
  });
});

function acpRequest(url: string, idempotencyKey: string, body: JsonObject): Request {
  return new Request(url, {
    method: "POST",
    headers: {
      Authorization: "Bearer acp_test_key",
      "Content-Type": "application/json",
      "Idempotency-Key": idempotencyKey,
      "Request-Id": `req_${idempotencyKey}`,
      "API-Version": "2025-09-12",
    },
    body: JSON.stringify(body),
  });
}

function signedAcpRequest(
  url: string,
  idempotencyKey: string,
  body: JsonObject,
  secret: string,
  timestamp: string,
  options: { readonly signedUrl?: string } = {},
): Request {
  const rawBody = JSON.stringify(body);
  const signatureUrl = new URL(options.signedUrl ?? url);
  const canonical = [
    "POST",
    `${signatureUrl.pathname}${signatureUrl.search}`,
    createHash("sha256").update(rawBody).digest("hex"),
    timestamp,
  ].join("\n");
  const signature = createHmac("sha256", secret).update(canonical).digest("base64");

  return new Request(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Idempotency-Key": idempotencyKey,
      "Request-Id": `req_${idempotencyKey}`,
      "API-Version": "2025-09-12",
      Signature: signature,
      "Signature-Timestamp": timestamp,
    },
    body: rawBody,
  });
}

function createAcpTestApi(input: {
  readonly getCart: () => CartDTO;
  readonly setCart: (cart: CartDTO) => void;
  readonly onCartAdd?: (item: {
    readonly sellableId: MikaIdLike;
    readonly priceId?: MikaIdLike;
    readonly quantity?: number;
  }) => MikaApiResult<CartDTO> | void | Promise<MikaApiResult<CartDTO> | void>;
  readonly onCheckoutPreview?: (
    previewInput: CheckoutPreviewInput,
    ctx: MikaRequestContext,
  ) => MikaApiResult<CheckoutPreviewDTO> | void | Promise<MikaApiResult<CheckoutPreviewDTO> | void>;
  readonly onCheckoutStart?: (
    metadata: JsonObject | undefined,
    ctx: MikaRequestContext,
  ) => void | Promise<void>;
  readonly onCheckoutCancel?: (
    cancelInput: { readonly checkoutId: MikaIdLike },
    ctx: MikaRequestContext,
  ) => MikaApiResult<CheckoutSessionDTO> | undefined;
  readonly checkoutSessionStatus?: CheckoutSessionDTO["status"];
}): MikaApi {
  const checkoutSessionStatus = input.checkoutSessionStatus ?? "completed";
  const checkoutSession = (): CheckoutSessionDTO => ({
    id: createMikaId("checkout_1"),
    status: checkoutSessionStatus,
    mode: "payment",
    provider: createProviderName("stripe"),
    ...(checkoutSessionStatus === "completed" ? { orderId: createMikaId("order_1") } : {}),
  });
  const api = {
    cart: {
      get: async () => ok(input.getCart()),
      quote: async () => ok(cartToQuote(input.getCart())),
      add: async (
        _ctx: unknown,
        item: {
          readonly sellableId: MikaIdLike;
          readonly priceId?: MikaIdLike;
          readonly quantity?: number;
        },
      ) => {
        const failure = await input.onCartAdd?.(item);
        if (failure) return failure;
        const line = createCartLine({
          id: `cart_line_${input.getCart().items.length + 1}`,
          sellableId: String(item.sellableId),
          priceId: item.priceId ? String(item.priceId) : undefined,
          quantity: item.quantity ?? 1,
        });
        input.setCart(createCart([...input.getCart().items, line]));

        return ok(input.getCart());
      },
      remove: async (_ctx: unknown, item: { readonly lineId: MikaIdLike }) => {
        input.setCart(createCart(input.getCart().items.filter((line) => line.id !== item.lineId)));

        return ok(input.getCart());
      },
    },
    checkout: {
      preview: async (
        ctx: MikaRequestContext,
        previewInput: CheckoutPreviewInput,
      ): Promise<MikaApiResult<CheckoutPreviewDTO>> => {
        const override = await input.onCheckoutPreview?.(previewInput, ctx);
        if (override) return override;

        return ok({
          id: createMikaId("checkout_preview_1"),
          quoteId: createMikaId("cart_quote_1"),
          status: "requires_payment_authorization",
          mode: "payment",
          provider: createProviderName("stripe"),
          quote: cartToQuote(input.getCart()),
          requiredProofs: [
            {
              kind: "payment_authorization",
              required: true,
              inputHash: "hash_quote_1",
            },
          ],
          inputHash: "hash_quote_1",
        });
      },
      start: async (
        ctx: MikaRequestContext,
        checkoutInput: { readonly customFields?: JsonObject },
      ) => {
        await input.onCheckoutStart?.(checkoutInput.customFields, ctx);

        return ok<CheckoutSessionDTO>(checkoutSession());
      },
      status: async () => ok<CheckoutSessionDTO>(checkoutSession()),
      cancel: async (
        ctx: MikaRequestContext,
        cancelInput: { readonly checkoutId: MikaIdLike },
      ) => {
        const override = input.onCheckoutCancel?.(cancelInput, ctx);
        if (override) return override;

        return ok<CheckoutSessionDTO>({ ...checkoutSession(), status: "cancelled" });
      },
    },
  };

  return api as unknown as MikaApi;
}

type MikaIdLike = string;

function createCartLine(input: {
  readonly id: string;
  readonly sellableId: string;
  readonly priceId?: string;
  readonly quantity: number;
}): CartDTO["items"][number] {
  return {
    id: createMikaId(input.id),
    sellableId: createMikaId(input.sellableId),
    priceId: input.priceId ? createMikaId(input.priceId) : undefined,
    title: "Limited print",
    sku: "PRINT-A3",
    variantOptions: [],
    quantity: input.quantity,
    unitAmount: { amount: 1200, currency: createCurrencyCode("EUR") },
    subtotal: { amount: 1200 * input.quantity, currency: createCurrencyCode("EUR") },
    total: { amount: 1200 * input.quantity, currency: createCurrencyCode("EUR") },
  };
}

function createCart(items: CartDTO["items"]): CartDTO {
  const total = items.reduce((sum, item) => sum + item.total.amount, 0);
  const money = { amount: total, currency: createCurrencyCode("EUR") };

  return {
    id: createMikaId("cart_1"),
    status: "open",
    currency: createCurrencyCode("EUR"),
    items,
    subtotal: money,
    total: money,
  };
}

function cartToQuote(cart: CartDTO): CartQuoteDTO {
  return {
    id: createMikaId("cart_quote_1"),
    cartId: cart.id,
    status: cart.items.length > 0 ? "valid" : "unavailable",
    currency: cart.currency,
    items: cart.items.map((item) => ({
      lineId: item.id,
      sellableId: item.sellableId,
      priceId: item.priceId,
      title: item.title,
      sku: item.sku,
      variantOptions: item.variantOptions,
      quantity: item.quantity,
      unitAmount: item.unitAmount,
      subtotal: item.subtotal,
      total: item.total,
    })),
    subtotal: cart.subtotal,
    total: cart.total,
    expiresAt: createISODateTime("2026-01-01T01:00:00.000Z"),
  };
}

function ok<T>(data: T): MikaApiResult<T> {
  return { ok: true, status: 200, data };
}

function fail<T>(
  status: number,
  code: Extract<MikaApiResult<T>, { readonly ok: false }>["error"]["code"],
  message: string,
  options: { readonly retryAfter?: number } = {},
): MikaApiResult<T> {
  return {
    ok: false,
    status,
    error: {
      code,
      message,
      ...(options.retryAfter !== undefined ? { retryAfter: options.retryAfter } : {}),
    },
  };
}
