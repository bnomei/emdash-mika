/**
 * ACP product projection and Stripe provider adapter tests.
 */
import { describe, expect, it } from "vite-plus/test";

import {
  createMemoryMikaAcpSessionStore,
  createMikaAcpCheckoutHandlers,
  createMikaAcpFileUploadRows,
  createMikaAcpProductFeed,
  serializeMikaAcpFileUploadRows,
  validateMikaAcpProductFeed,
  type MikaAcpSeller,
} from "../src/acp";
import type { MikaRequestContext } from "../src/api/context";
import type { MikaApi } from "../src/api/server";
import type { MikaProviderWebhookEvent } from "../src/provider";
import type {
  CartDTO,
  CartQuoteDTO,
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

  it("creates and completes ACP checkout sessions with Stripe SPT metadata", async () => {
    let cart = createCart([]);
    let checkoutStartMetadata: JsonObject | undefined;
    let checkoutStartCount = 0;
    const api = createAcpTestApi({
      getCart: () => cart,
      setCart: (next) => {
        cart = next;
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

  it("does not start a second Mika checkout when completing a pending ACP session again", async () => {
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
    expect(second.status).toBe(200);
    await expect(second.json()).resolves.toMatchObject({
      id: "checkout_session_acp_pending",
      status: "ready_for_payment",
    });
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

    expect(updated.status).toBe(400);
    await expect(updated.json()).resolves.toMatchObject({
      code: "invalid_request",
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

    // The discount becomes a one-time coupon (idempotent on retry) attached to the session, so the
    // fixed-price line items are charged at the discounted total.
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

    // Fail closed rather than charge the full subtotal while Mika records the discounted total.
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

    // 2 x 1200 = 2400 subtotal, minus the 240 discount = 2160 charged.
    expect(intentCalls[0]).toMatchObject({ params: { amount: 2160, currency: "eur" } });
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
        id: "evt_expired",
        type: "checkout.session.expired",
        data: { object: { id: "cs_expired", payment_intent: "pi_expired" } },
      },
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

function createAcpTestApi(input: {
  readonly getCart: () => CartDTO;
  readonly setCart: (cart: CartDTO) => void;
  readonly onCartAdd?: (item: {
    readonly sellableId: MikaIdLike;
    readonly priceId?: MikaIdLike;
    readonly quantity?: number;
  }) => MikaApiResult<CartDTO> | undefined;
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
        const failure = input.onCartAdd?.(item);
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
      preview: async (): Promise<MikaApiResult<CheckoutPreviewDTO>> =>
        ok({
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
        }),
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
): MikaApiResult<T> {
  return { ok: false, status, error: { code, message } };
}
