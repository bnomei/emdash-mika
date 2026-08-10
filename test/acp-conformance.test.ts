/**
 * Schema-level proof for Mika's pinned ACP checkout surface.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import Ajv2020 from "ajv/dist/2020";
import addFormats from "ajv-formats";
import { describe, expect, it } from "vite-plus/test";

import {
  MIKA_ACP_API_VERSION,
  MIKA_ACP_SCHEMA_SNAPSHOT,
  acpCheckoutSessionFromState,
  type MikaAcpCheckoutCompleteRequest,
  type MikaAcpCheckoutCreateRequest,
  type MikaAcpCheckoutUpdateRequest,
  type MikaAcpError,
  type MikaAcpSessionRecord,
} from "../src/acp";
import type { CartQuoteDTO, CheckoutSessionDTO } from "../src/api/types";
import {
  createCheckoutSessionId,
  createCurrencyCode,
  createISODateTime,
  createOrderId,
  createProviderName,
  createSellableId,
} from "../src/types/primitives";

type SchemaNode = {
  additionalProperties?: boolean;
  unevaluatedProperties?: boolean;
  properties?: Record<string, Record<string, unknown>>;
  [key: string]: unknown;
};

type AcpSchemaBundle = SchemaNode & {
  readonly $id: string;
  readonly $defs: Record<string, SchemaNode>;
};

const schemaFixture = new URL(
  "./fixtures/acp/schema.agentic_checkout.2025-09-29.json",
  import.meta.url,
);
const exactSchemaBytes = readFileSync(schemaFixture);
const exactSchema = JSON.parse(exactSchemaBytes.toString("utf8")) as AcpSchemaBundle;
const exactSchemaSha256 = "d8d16c9b25b07e61f8366fce01255f0a2dfee76ab7996bd5819fe7afaea4f838";

function normalizedPinnedSchema(): AcpSchemaBundle {
  const schema = structuredClone(exactSchema);
  const quantity = schema.$defs["Item"]?.properties?.["quantity"];
  const base = schema.$defs["CheckoutSessionBase"];
  const session = schema.$defs["CheckoutSession"];
  const sessionWithOrder = schema.$defs["CheckoutSessionWithOrder"];
  if (!quantity || !base || !session || !sessionWithOrder) {
    throw new Error("Pinned ACP schema is missing a required checkout definition.");
  }

  // The official snapshot declares draft 2020-12 but uses draft-04's boolean
  // exclusiveMinimum spelling. Preserve its intended `quantity > 0` constraint.
  delete quantity["minimum"];
  quantity["exclusiveMinimum"] = 0;

  // CheckoutSessionWithOrder composes `order` with a base that closes additional properties,
  // which otherwise rejects its own order field. Move closure to the two composed definitions.
  delete base.additionalProperties;
  session["type"] = "object";
  session.unevaluatedProperties = false;
  sessionWithOrder["type"] = "object";
  sessionWithOrder.unevaluatedProperties = false;

  return schema;
}

function conformanceValidator() {
  const schema = normalizedPinnedSchema();
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats(ajv);
  ajv.addSchema(schema);

  return (definition: string, value: unknown) => {
    const validate = ajv.compile({ $ref: `${schema.$id}#/$defs/${definition}` });
    const valid = validate(value);
    expect(valid, JSON.stringify(validate.errors, null, 2)).toBe(true);
  };
}

describe("ACP 2025-09-29 schema conformance", () => {
  it("pins the official schema bytes and documents its two mechanical validator fixes", () => {
    expect(MIKA_ACP_API_VERSION).toBe("2025-09-12");
    expect(MIKA_ACP_SCHEMA_SNAPSHOT).toBe("2025-09-29");
    expect(createHash("sha256").update(exactSchemaBytes).digest("hex")).toBe(exactSchemaSha256);
    expect(() => {
      new Ajv2020({ strict: true, validateFormats: false }).addSchema(exactSchema);
    }).toThrow(/exclusiveMinimum/);
  });

  it("validates the first-release request, session, completion, and error shapes", () => {
    const expectConformant = conformanceValidator();
    const buyer = {
      first_name: "Ada",
      last_name: "Buyer",
      email: "ada@example.test",
    } as const;
    const createRequest = {
      buyer,
      items: [{ id: "sellable_1:price_1", quantity: 1 }],
    } satisfies MikaAcpCheckoutCreateRequest;
    const updateRequest = {
      buyer,
      items: [],
      fulfillment_option_id: "digital_delivery",
    } satisfies MikaAcpCheckoutUpdateRequest;
    const completeRequest = {
      buyer,
      payment_data: { provider: "stripe", token: "spt_test_123" },
    } satisfies MikaAcpCheckoutCompleteRequest;

    expectConformant("CheckoutSessionCreateRequest", createRequest);
    expectConformant("CheckoutSessionUpdateRequest", updateRequest);
    expectConformant("CheckoutSessionCompleteRequest", completeRequest);

    const currency = createCurrencyCode("EUR");
    const now = createISODateTime("2026-01-01T00:00:00.000Z");
    const provider = createProviderName("stripe");
    const record: MikaAcpSessionRecord = {
      id: "checkout_session_schema",
      sessionId: "acp_checkout:schema",
      status: "ready_for_payment",
      buyer,
      items: createRequest.items,
      provider,
      createdAt: now,
      updatedAt: now,
      version: 1,
    };
    const quote: CartQuoteDTO = {
      status: "valid",
      currency,
      items: [
        {
          sellableId: createSellableId("sellable_1"),
          fulfillmentKind: "download",
          quantity: 1,
          unitAmount: { amount: 1_200, currency },
          subtotal: { amount: 1_200, currency },
          total: { amount: 1_200, currency },
        },
      ],
      subtotal: { amount: 1_200, currency },
      total: { amount: 1_200, currency },
    };
    const seller = {
      name: "Mika Studio",
      links: [{ type: "terms_of_use", url: "https://shop.example.test/terms" }],
    } as const;
    const session = acpCheckoutSessionFromState({ record, quote, seller });

    expectConformant("CheckoutSession", session);

    const checkout: CheckoutSessionDTO = {
      id: createCheckoutSessionId("checkout_schema"),
      status: "completed",
      mode: "payment",
      provider,
      orderId: createOrderId("order_schema"),
    };
    const completedSession = acpCheckoutSessionFromState({
      record: {
        ...record,
        checkoutId: checkout.id,
        status: "completed",
      },
      quote,
      checkout,
      seller,
      orderUrl: "https://shop.example.test/account/orders/order_schema",
    });

    expectConformant("CheckoutSessionWithOrder", completedSession);

    expect(() =>
      acpCheckoutSessionFromState({
        record,
        quote,
        seller: { name: "Mika Studio", links: [{ type: "terms_of_use", url: "not a uri" }] },
      }),
    ).toThrow("ACP seller link must be an absolute URI.");
    expect(() =>
      acpCheckoutSessionFromState({
        record: { ...record, status: "completed" },
        quote,
        checkout,
        seller,
        orderUrl: "not a uri",
      }),
    ).toThrow("ACP order URL must be an absolute URI.");

    const error = {
      type: "invalid_request",
      code: "validation_failed",
      message: "Quantity must be positive.",
      param: "$.items[0].quantity",
    } satisfies MikaAcpError;
    expectConformant("Error", error);
  });
});
