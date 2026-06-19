import type {
  AdminActionResultDTO,
  MikaProviderCapability,
  OrderInvoiceDTO,
  ProviderHealthDTO,
} from "../../src/api/types";
import type {
  MikaProviderAdapter,
  MikaProviderCheckoutInput,
  MikaProviderCheckoutSession,
  MikaProviderInvoiceInput,
  MikaProviderOrderCancelInput,
  MikaProviderPortalInput,
  MikaProviderPortalSession,
  MikaProviderRefundInput,
  MikaProviderSubscriptionActionInput,
  MikaProviderSyncInput,
  MikaProviderWebhookEvent,
  MikaProviderWebhookVerificationInput,
  MikaVerifiedWebhookPayload,
} from "../../src/provider";
import {
  createISODateTime,
  createMikaId,
  createProviderName,
  type ProviderName,
} from "../../src/types/primitives";

export type FakeMikaProviderOptionalMethod =
  | "health"
  | "createPortalSession"
  | "getInvoiceUrl"
  | "cancelSubscription"
  | "changeSubscription"
  | "renewSubscription"
  | "refundPayment"
  | "cancelOrder"
  | "syncCatalog"
  | "verifyWebhook"
  | "parseWebhookEvent";

export type FakeMikaProviderCallLog = {
  readonly capabilities: undefined[];
  readonly health: undefined[];
  readonly createCheckoutSession: MikaProviderCheckoutInput[];
  readonly retrieveCheckoutSession: string[];
  readonly createPortalSession: MikaProviderPortalInput[];
  readonly getInvoiceUrl: MikaProviderInvoiceInput[];
  readonly cancelSubscription: MikaProviderSubscriptionActionInput[];
  readonly changeSubscription: MikaProviderSubscriptionActionInput[];
  readonly renewSubscription: MikaProviderSubscriptionActionInput[];
  readonly refundPayment: MikaProviderRefundInput[];
  readonly cancelOrder: MikaProviderOrderCancelInput[];
  readonly syncCatalog: MikaProviderSyncInput[];
  readonly verifyWebhook: MikaProviderWebhookVerificationInput[];
  readonly parseWebhookEvent: MikaVerifiedWebhookPayload[];
};

export type FakeMikaProviderOverrides = Partial<{
  readonly capabilities: MikaProviderAdapter["capabilities"];
  readonly health: NonNullable<MikaProviderAdapter["health"]>;
  readonly createCheckoutSession: MikaProviderAdapter["createCheckoutSession"];
  readonly retrieveCheckoutSession: MikaProviderAdapter["retrieveCheckoutSession"];
  readonly createPortalSession: NonNullable<MikaProviderAdapter["createPortalSession"]>;
  readonly getInvoiceUrl: NonNullable<MikaProviderAdapter["getInvoiceUrl"]>;
  readonly cancelSubscription: NonNullable<MikaProviderAdapter["cancelSubscription"]>;
  readonly changeSubscription: NonNullable<MikaProviderAdapter["changeSubscription"]>;
  readonly renewSubscription: NonNullable<MikaProviderAdapter["renewSubscription"]>;
  readonly refundPayment: NonNullable<MikaProviderAdapter["refundPayment"]>;
  readonly cancelOrder: NonNullable<MikaProviderAdapter["cancelOrder"]>;
  readonly syncCatalog: NonNullable<MikaProviderAdapter["syncCatalog"]>;
  readonly verifyWebhook: NonNullable<MikaProviderAdapter["verifyWebhook"]>;
  readonly parseWebhookEvent: NonNullable<MikaProviderAdapter["parseWebhookEvent"]>;
}>;

export type CreateFakeMikaProviderOptions = {
  readonly id?: ProviderName | string;
  readonly capabilities?: readonly MikaProviderCapability[];
  readonly optionalMethods?: readonly FakeMikaProviderOptionalMethod[] | "all" | "none";
  readonly checkoutSession?: Partial<MikaProviderCheckoutSession>;
  readonly overrides?: FakeMikaProviderOverrides;
};

export type FakeMikaProvider = {
  readonly provider: MikaProviderAdapter;
  readonly calls: FakeMikaProviderCallLog;
  readonly getCalls: () => FakeMikaProviderCallLog;
  readonly resetCalls: () => void;
};

export function createFakeMikaProvider(
  options: CreateFakeMikaProviderOptions = {},
): FakeMikaProvider {
  const id = normalizeProviderName(options.id);
  const capabilities = options.capabilities ?? DEFAULT_CAPABILITIES;
  const calls = createCallLog();
  const overrides = options.overrides ?? {};
  const provider: MikaProviderAdapter = {
    id,
    capabilities: () => {
      calls.capabilities.push(undefined);
      return overrides.capabilities?.() ?? capabilities;
    },
    createCheckoutSession: async (input) => {
      calls.createCheckoutSession.push(input);
      return (
        (await overrides.createCheckoutSession?.(input)) ??
        createCheckoutSession(id, input, options.checkoutSession)
      );
    },
    retrieveCheckoutSession: async (checkoutSessionId) => {
      calls.retrieveCheckoutSession.push(checkoutSessionId);
      return (
        (await overrides.retrieveCheckoutSession?.(checkoutSessionId)) ??
        createCheckoutSession(id, undefined, {
          ...options.checkoutSession,
          id: createMikaId(checkoutSessionId),
          status: "completed",
        })
      );
    },
  };

  if (includesOptionalMethod(options.optionalMethods, "health")) {
    provider.health = async () => {
      calls.health.push(undefined);
      return (await overrides.health?.()) ?? createHealth(id, capabilities);
    };
  }

  if (includesOptionalMethod(options.optionalMethods, "createPortalSession")) {
    provider.createPortalSession = async (input) => {
      calls.createPortalSession.push(input);
      return (await overrides.createPortalSession?.(input)) ?? createPortalSession();
    };
  }

  if (includesOptionalMethod(options.optionalMethods, "getInvoiceUrl")) {
    provider.getInvoiceUrl = async (input) => {
      calls.getInvoiceUrl.push(input);
      return (await overrides.getInvoiceUrl?.(input)) ?? createInvoice(input);
    };
  }

  if (includesOptionalMethod(options.optionalMethods, "cancelSubscription")) {
    provider.cancelSubscription = async (input) => {
      calls.cancelSubscription.push(input);
      return (
        (await overrides.cancelSubscription?.(input)) ?? createActionResult("subscription_cancel")
      );
    };
  }

  if (includesOptionalMethod(options.optionalMethods, "changeSubscription")) {
    provider.changeSubscription = async (input) => {
      calls.changeSubscription.push(input);
      return (
        (await overrides.changeSubscription?.(input)) ?? createActionResult("subscription_change")
      );
    };
  }

  if (includesOptionalMethod(options.optionalMethods, "renewSubscription")) {
    provider.renewSubscription = async (input) => {
      calls.renewSubscription.push(input);
      return (
        (await overrides.renewSubscription?.(input)) ?? createActionResult("subscription_renew")
      );
    };
  }

  if (includesOptionalMethod(options.optionalMethods, "refundPayment")) {
    provider.refundPayment = async (input) => {
      calls.refundPayment.push(input);
      return (await overrides.refundPayment?.(input)) ?? createActionResult("refund");
    };
  }

  if (includesOptionalMethod(options.optionalMethods, "cancelOrder")) {
    provider.cancelOrder = async (input) => {
      calls.cancelOrder.push(input);
      return (await overrides.cancelOrder?.(input)) ?? createActionResult("order_cancel");
    };
  }

  if (includesOptionalMethod(options.optionalMethods, "syncCatalog")) {
    provider.syncCatalog = async (input) => {
      calls.syncCatalog.push(input);
      return (await overrides.syncCatalog?.(input)) ?? createActionResult("catalog_sync");
    };
  }

  if (includesOptionalMethod(options.optionalMethods, "verifyWebhook")) {
    provider.verifyWebhook = async (input) => {
      calls.verifyWebhook.push(input);
      return (await overrides.verifyWebhook?.(input)) ?? createVerifiedWebhook(id, input);
    };
  }

  if (includesOptionalMethod(options.optionalMethods, "parseWebhookEvent")) {
    provider.parseWebhookEvent = async (input) => {
      calls.parseWebhookEvent.push(input);
      return (await overrides.parseWebhookEvent?.(input)) ?? createWebhookEvent(id);
    };
  }

  return {
    provider,
    calls,
    getCalls: () => cloneCallLog(calls),
    resetCalls: () => resetCallLog(calls),
  };
}

const DEFAULT_CAPABILITIES = ["hosted_checkout"] satisfies readonly MikaProviderCapability[];
const DEFAULT_OPTIONAL_METHODS = [
  "health",
  "createPortalSession",
  "getInvoiceUrl",
  "cancelSubscription",
  "changeSubscription",
  "renewSubscription",
  "refundPayment",
  "cancelOrder",
  "syncCatalog",
  "verifyWebhook",
  "parseWebhookEvent",
] satisfies readonly FakeMikaProviderOptionalMethod[];

function normalizeProviderName(provider: ProviderName | string | undefined): ProviderName {
  return typeof provider === "string"
    ? createProviderName(provider)
    : (provider ?? createProviderName("fake"));
}

function createCallLog(): FakeMikaProviderCallLog {
  return {
    capabilities: [],
    health: [],
    createCheckoutSession: [],
    retrieveCheckoutSession: [],
    createPortalSession: [],
    getInvoiceUrl: [],
    cancelSubscription: [],
    changeSubscription: [],
    renewSubscription: [],
    refundPayment: [],
    cancelOrder: [],
    syncCatalog: [],
    verifyWebhook: [],
    parseWebhookEvent: [],
  };
}

function cloneCallLog(calls: FakeMikaProviderCallLog): FakeMikaProviderCallLog {
  return {
    capabilities: [...calls.capabilities],
    health: [...calls.health],
    createCheckoutSession: [...calls.createCheckoutSession],
    retrieveCheckoutSession: [...calls.retrieveCheckoutSession],
    createPortalSession: [...calls.createPortalSession],
    getInvoiceUrl: [...calls.getInvoiceUrl],
    cancelSubscription: [...calls.cancelSubscription],
    changeSubscription: [...calls.changeSubscription],
    renewSubscription: [...calls.renewSubscription],
    refundPayment: [...calls.refundPayment],
    cancelOrder: [...calls.cancelOrder],
    syncCatalog: [...calls.syncCatalog],
    verifyWebhook: [...calls.verifyWebhook],
    parseWebhookEvent: [...calls.parseWebhookEvent],
  };
}

function resetCallLog(calls: FakeMikaProviderCallLog): void {
  for (const entries of Object.values(calls)) {
    entries.length = 0;
  }
}

function includesOptionalMethod(
  optionalMethods: CreateFakeMikaProviderOptions["optionalMethods"],
  method: FakeMikaProviderOptionalMethod,
): boolean {
  if (optionalMethods === "none") return false;
  if (optionalMethods === undefined || optionalMethods === "all") {
    return DEFAULT_OPTIONAL_METHODS.includes(method);
  }

  return optionalMethods.includes(method);
}

function createCheckoutSession(
  provider: ProviderName,
  input: MikaProviderCheckoutInput | undefined,
  overrides: Partial<MikaProviderCheckoutSession> = {},
): MikaProviderCheckoutSession {
  return {
    id: createMikaId("checkout_fake"),
    status: "created",
    mode: input?.mode ?? "payment",
    provider,
    redirectUrl: "https://checkout.example.test/session/checkout_fake",
    expiresAt: createISODateTime("2026-01-01T01:00:00.000Z"),
    providerCheckoutId: "provider_checkout_fake",
    ...overrides,
  };
}

function createHealth(
  provider: ProviderName,
  capabilities: readonly MikaProviderCapability[],
): ProviderHealthDTO {
  return {
    provider,
    ok: true,
    capabilities,
    checkedAt: createISODateTime("2026-01-01T00:00:00.000Z"),
  };
}

function createPortalSession(): MikaProviderPortalSession {
  return {
    redirectUrl: "https://portal.example.test/session/portal_fake",
    expiresAt: createISODateTime("2026-01-01T01:00:00.000Z"),
  };
}

function createInvoice(input: MikaProviderInvoiceInput): OrderInvoiceDTO {
  return {
    orderId: input.orderId,
    href: "https://invoice.example.test/order/invoice_fake",
    expiresAt: createISODateTime("2026-01-01T01:00:00.000Z"),
  };
}

function createActionResult(id: string): AdminActionResultDTO {
  return {
    id: createMikaId(id),
    status: "completed",
  };
}

function createVerifiedWebhook(
  provider: ProviderName,
  input: MikaProviderWebhookVerificationInput,
): MikaVerifiedWebhookPayload {
  return {
    provider,
    rawBody: input.rawBody,
    payloadHash: "fake-webhook-hash",
    headers: Object.fromEntries(input.request.headers.entries()),
  };
}

function createWebhookEvent(provider: ProviderName): MikaProviderWebhookEvent {
  return {
    kind: "unknown",
    provider,
    providerEventId: "event_fake",
    type: "fake.event",
  };
}
