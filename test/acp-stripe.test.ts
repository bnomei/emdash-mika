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
import type { MikaApi } from "../src/api/server";
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
    await expect(provider.parseWebhookEvent?.(verified!)).resolves.toMatchObject({
      kind: "payment",
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
  readonly onCheckoutStart?: (metadata: JsonObject | undefined) => void | Promise<void>;
}): MikaApi {
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
      start: async (_ctx: unknown, checkoutInput: { readonly customFields?: JsonObject }) => {
        await input.onCheckoutStart?.(checkoutInput.customFields);

        return ok<CheckoutSessionDTO>({
          id: createMikaId("checkout_1"),
          status: "completed",
          mode: "payment",
          provider: createProviderName("stripe"),
          orderId: createMikaId("order_1"),
        });
      },
      status: async () =>
        ok<CheckoutSessionDTO>({
          id: createMikaId("checkout_1"),
          status: "completed",
          mode: "payment",
          provider: createProviderName("stripe"),
          orderId: createMikaId("order_1"),
        }),
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
