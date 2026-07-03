/**
 * Leased email outbox runner: renders queued emails, delivers via injectable sender, handles retries.
 * Integrates with ops repository leasing and EmDash host email pipelines.
 */
import { renderMikaEmail, type MikaEmailBrand, type MikaRenderedEmail } from "../email";
import { optionalProperty } from "../internal/object";
import type { EmailDocument, OrderDocument } from "../types/documents";
import {
  createISODateTime,
  isISODateTime,
  type ISODateTime,
  type JsonObject,
  type MikaId,
} from "../types/primitives";
import type { MikaBackendIdFactory, MikaBackendNow, MikaBackendRepositories } from "./backend";

/** Fully rendered message passed to the host email sender. */
export interface MikaEmailDeliveryMessage {
  readonly emailId: MikaId;
  readonly kind: EmailDocument["kind"];
  readonly to: string;
  readonly subject: string;
  readonly text: string;
  readonly html: string;
  readonly idempotencyKey?: string;
  readonly metadata?: JsonObject;
}

/** Optional provider message id returned after successful delivery. */
export interface MikaEmailDeliveryResult {
  readonly providerMessageId?: string;
}

/** Host-injected transport that sends a prepared outbox message. */
export type MikaEmailSender = (
  message: MikaEmailDeliveryMessage,
) => Promise<MikaEmailDeliveryResult | void>;

/** Context passed to custom retry-delay functions after a failed delivery attempt. */
export interface MikaEmailOutboxRetryInput {
  readonly email: EmailDocument;
  readonly error: unknown;
  readonly attemptCount: number;
  readonly now: ISODateTime;
}

/** Dependencies for constructing an outbox runner. */
export interface MikaEmailOutboxRunnerInput {
  readonly repositories: Pick<MikaBackendRepositories, "ledger" | "ops">;
  readonly sender: MikaEmailSender;
  readonly now?: MikaBackendNow;
  readonly createId?: MikaBackendIdFactory;
  readonly batchSize?: number;
  readonly leaseMs?: number;
  readonly retryDelayMs?: (input: MikaEmailOutboxRetryInput) => number;
  readonly brand?: MikaEmailBrand | ((email: EmailDocument) => MikaEmailBrand | undefined);
  readonly accountUrl?:
    | string
    | ((input: {
        readonly email: EmailDocument;
        readonly order: OrderDocument;
      }) => string | undefined);
}

/** Optional clock override and batch limit for one outbox sweep. */
export interface MikaEmailOutboxRunOptions {
  readonly now?: ISODateTime;
  readonly limit?: number;
}

/** Per-email terminal status from a single outbox delivery attempt. */
export type MikaEmailOutboxRunItem =
  | {
      readonly emailId: MikaId;
      readonly status: "sent";
      readonly providerMessageId?: string;
      readonly recoveredLeaseLost?: boolean;
    }
  | {
      readonly emailId: MikaId;
      readonly status: "failed";
      readonly error: string;
      readonly nextAttemptAt?: ISODateTime;
      readonly terminal: boolean;
    }
  | {
      readonly emailId: MikaId;
      readonly status: "skipped";
      readonly error: string;
    }
  | {
      readonly emailId: MikaId;
      /** Lease contention before send (missed) or lost after successful provider delivery. */
      readonly status: "lease_missed" | "lease_lost";
    };

/** Aggregated counters and per-email outcomes from one outbox sweep. */
export interface MikaEmailOutboxRunResult {
  readonly scanned: number;
  readonly leased: number;
  readonly sent: number;
  readonly failed: number;
  readonly skipped: number;
  readonly leaseMissed: number;
  readonly leaseLost: number;
  readonly hasMore: boolean;
  readonly items: readonly MikaEmailOutboxRunItem[];
}

/** Batch processor that drains due emails with lease-based concurrency safety. */
export interface MikaEmailOutboxRunner {
  runOnce(options?: MikaEmailOutboxRunOptions): Promise<MikaEmailOutboxRunResult>;
}

/** Payload shape expected by the EmDash host email pipeline. */
export interface MikaEmDashEmailMessage {
  readonly to: string;
  readonly subject: string;
  readonly text: string;
  readonly html?: string;
  readonly idempotencyKey?: string;
}

/** EmDash host email pipeline (`locals.emdash.email`). */
export interface MikaEmDashEmailPipeline {
  readonly send: (message: MikaEmDashEmailMessage, source: string) => Promise<void>;
  readonly isAvailable?: () => boolean;
}

/** Options when adapting an EmDash pipeline into a Mika sender. */
export interface MikaEmDashEmailSenderOptions {
  readonly source?: string;
  readonly allowPluginScopedSender?: boolean;
}

const DEFAULT_EMAIL_BATCH_SIZE = 25;
const DEFAULT_EMAIL_LEASE_MS = 5 * 60_000;

/** Creates a leased outbox runner bound to ops storage and a sender implementation. */
export function createMikaEmailOutboxRunner(
  input: MikaEmailOutboxRunnerInput,
): MikaEmailOutboxRunner {
  const batchSize = input.batchSize ?? DEFAULT_EMAIL_BATCH_SIZE;
  const leaseMs = input.leaseMs ?? DEFAULT_EMAIL_LEASE_MS;

  return {
    async runOnce(options = {}) {
      const now = options.now ?? currentISODateTime(input.now);
      const due = await input.repositories.ops.listDueEmails(now, options.limit ?? batchSize);
      const items: MikaEmailOutboxRunItem[] = [];

      for (const item of due.items) {
        const email = item.data;
        const leaseKey = createEmailLeaseKey(input.createId, email.id);
        const leaseExpiresAt = addMilliseconds(now, leaseMs);
        const leased = await input.repositories.ops.tryLeaseEmail({
          emailId: email.id,
          leaseKey,
          now,
          leaseExpiresAt,
        });

        if (!leased) {
          items.push({ emailId: email.id, status: "lease_missed" });
          continue;
        }

        items.push(await deliverLeasedEmail(input, leased, leaseKey, now));
      }

      return summarizeRun(due.items.length, due.hasMore, items);
    },
  };
}

/** Adapts an EmDash email pipeline into a {@link MikaEmailSender}. */
export function createEmDashMikaEmailSender(
  email: MikaEmDashEmailPipeline,
  options: MikaEmDashEmailSenderOptions = {},
): MikaEmailSender {
  const source = options.source ?? "system";

  return async (message) => {
    if (email.isAvailable && !email.isAvailable()) {
      throw new Error("EmDash email provider is not configured.");
    }
    if (!options.allowPluginScopedSender && email.send.length < 2) {
      throw new Error(
        "EmDash email sender must accept a source argument. Pass locals.emdash.email or set allowPluginScopedSender.",
      );
    }

    await email.send(
      {
        to: message.to,
        subject: message.subject,
        text: message.text,
        html: message.html,
        ...(message.idempotencyKey ? { idempotencyKey: message.idempotencyKey } : {}),
      },
      source,
    );
  };
}

async function deliverLeasedEmail(
  input: MikaEmailOutboxRunnerInput,
  email: EmailDocument,
  leaseKey: string,
  now: ISODateTime,
): Promise<MikaEmailOutboxRunItem> {
  let prepared: Awaited<ReturnType<typeof prepareEmailDelivery>>;
  try {
    prepared = await prepareEmailDelivery(input, email);
  } catch (error) {
    return failLeasedEmail(input, email, leaseKey, now, error);
  }

  if (prepared.status === "skip") {
    const skipped = await input.repositories.ops.skipEmail({
      emailId: email.id,
      leaseKey,
      now,
      lastError: prepared.error,
    });

    return skipped
      ? { emailId: email.id, status: "skipped", error: prepared.error }
      : { emailId: email.id, status: "lease_lost" };
  }

  if (prepared.status === "fail") {
    return failLeasedEmail(input, email, leaseKey, now, prepared.error);
  }

  let result: Awaited<ReturnType<typeof input.sender>>;
  try {
    result = await input.sender(prepared.message);
  } catch (error) {
    return failLeasedEmail(input, email, leaseKey, now, error);
  }

  const providerMessageId = result?.providerMessageId;
  const completed = await input.repositories.ops
    .completeEmail({
      emailId: email.id,
      leaseKey,
      now,
      ...optionalProperty("providerMessageId", providerMessageId),
    })
    .catch(() => false);

  if (completed) {
    return {
      emailId: email.id,
      status: "sent",
      ...optionalProperty("providerMessageId", providerMessageId),
    };
  }

  // Provider delivery succeeded but lease was lost; mark delivered without holding the lease.
  const recovered = await input.repositories.ops
    .markEmailDelivered({
      emailId: email.id,
      now,
      ...optionalProperty("providerMessageId", providerMessageId),
    })
    .catch(() => false);

  return recovered
    ? {
        emailId: email.id,
        status: "sent",
        ...optionalProperty("providerMessageId", providerMessageId),
        recoveredLeaseLost: true,
      }
    : { emailId: email.id, status: "lease_lost" };
}

async function failLeasedEmail(
  input: MikaEmailOutboxRunnerInput,
  email: EmailDocument,
  leaseKey: string,
  now: ISODateTime,
  error: unknown,
): Promise<MikaEmailOutboxRunItem> {
  const message = errorMessage(error);
  const nextAttemptAt = nextEmailAttemptAt(input, email, error, now);
  const failed = await input.repositories.ops.failEmail({
    emailId: email.id,
    leaseKey,
    now,
    lastError: message,
    ...optionalProperty("nextAttemptAt", nextAttemptAt),
  });

  return failed
    ? {
        emailId: email.id,
        status: "failed",
        error: message,
        ...optionalProperty("nextAttemptAt", nextAttemptAt),
        terminal: nextAttemptAt === undefined,
      }
    : { emailId: email.id, status: "lease_lost" };
}

async function prepareEmailDelivery(
  input: MikaEmailOutboxRunnerInput,
  email: EmailDocument,
): Promise<
  | { readonly status: "send"; readonly message: MikaEmailDeliveryMessage }
  | { readonly status: "fail"; readonly error: string }
  | { readonly status: "skip"; readonly error: string }
> {
  switch (email.kind) {
    case "magic_link": {
      const url =
        jsonString(email.record.metadata, "link") ?? jsonString(email.record.metadata, "url");
      if (!url) {
        return { status: "skip", error: "Magic-link email is missing its delivery URL." };
      }

      return {
        status: "send",
        message: deliveryMessageFromRendered(
          email,
          renderMikaEmail("magic_link", {
            toEmail: email.record.toEmail,
            url,
            ...optionalProperty("purpose", jsonString(email.record.metadata, "purpose")),
            ...optionalProperty("expiresAt", jsonISODateTime(email.record.metadata, "expiresAt")),
            ...optionalProperty("brand", resolveBrand(input, email)),
          }),
        ),
      };
    }
    case "order_confirmation": {
      const orderId = email.orderId ?? email.record.orderId;
      if (!orderId) {
        return { status: "fail", error: "Order-confirmation email is missing its order id." };
      }

      const order = await input.repositories.ledger.findOrderById(orderId);
      if (!order) {
        return { status: "fail", error: `Order '${orderId}' was not found for email delivery.` };
      }
      if (order.status === "refunded" || order.status === "cancelled") {
        return {
          status: "skip",
          error: `Order '${orderId}' is ${order.status}; order-confirmation email skipped.`,
        };
      }

      const orderLineIds = new Set(jsonStringArray(email.record.metadata, "orderLineIds"));
      const lines =
        orderLineIds.size > 0
          ? order.aggregate.lines.filter((line) => orderLineIds.has(line.id))
          : order.aggregate.lines;

      return {
        status: "send",
        message: deliveryMessageFromRendered(
          email,
          renderMikaEmail("order_confirmation", {
            toEmail: email.record.toEmail,
            orderNumber: order.orderNumber,
            subtotal: order.aggregate.totals.subtotal,
            ...(order.aggregate.totals.discount
              ? { discount: order.aggregate.totals.discount }
              : {}),
            total: order.aggregate.totals.total,
            lines: lines.map((line) => ({
              title: line.item.titleSnapshot,
              quantity: line.quantity,
              total: { amount: line.totalAmount, currency: line.item.currency },
            })),
            ...optionalProperty("accountUrl", resolveAccountUrl(input, email, order)),
            ...optionalProperty("brand", resolveBrand(input, email)),
          }),
        ),
      };
    }
    case "admin_notification":
    case "download":
      return { status: "skip", error: `Email kind '${email.kind}' has no Mika renderer.` };
  }
}

function deliveryMessageFromRendered(
  email: EmailDocument,
  rendered: MikaRenderedEmail,
): MikaEmailDeliveryMessage {
  return {
    emailId: email.id,
    kind: email.kind,
    to: email.record.toEmail,
    subject: rendered.subject,
    text: rendered.text,
    html: rendered.html,
    ...optionalProperty("idempotencyKey", email.record.idempotencyKey),
    ...optionalProperty("metadata", email.record.metadata),
  };
}

function nextEmailAttemptAt(
  input: MikaEmailOutboxRunnerInput,
  email: EmailDocument,
  error: unknown,
  now: ISODateTime,
): ISODateTime | undefined {
  const attemptCount = email.record.attemptCount;
  if (attemptCount >= email.record.maxAttempts) return undefined;
  const delay =
    input.retryDelayMs?.({
      email,
      error,
      attemptCount,
      now,
    }) ?? Math.min(60_000 * 2 ** (Math.max(1, attemptCount) - 1), 15 * 60_000);

  return addMilliseconds(now, delay);
}

function summarizeRun(
  scanned: number,
  hasMore: boolean,
  items: readonly MikaEmailOutboxRunItem[],
): MikaEmailOutboxRunResult {
  return {
    scanned,
    leased: items.filter((item) => item.status !== "lease_missed").length,
    sent: items.filter((item) => item.status === "sent").length,
    failed: items.filter((item) => item.status === "failed").length,
    skipped: items.filter((item) => item.status === "skipped").length,
    leaseMissed: items.filter((item) => item.status === "lease_missed").length,
    leaseLost: items.filter((item) => item.status === "lease_lost").length,
    hasMore,
    items,
  };
}

function resolveBrand(
  input: MikaEmailOutboxRunnerInput,
  email: EmailDocument,
): MikaEmailBrand | undefined {
  return typeof input.brand === "function" ? input.brand(email) : input.brand;
}

function resolveAccountUrl(
  input: MikaEmailOutboxRunnerInput,
  email: EmailDocument,
  order: OrderDocument,
): string | undefined {
  return typeof input.accountUrl === "function"
    ? input.accountUrl({ email, order })
    : input.accountUrl;
}

function currentISODateTime(now?: MikaBackendNow): ISODateTime {
  return createISODateTime((now?.() ?? new Date()).toISOString());
}

function addMilliseconds(value: ISODateTime, milliseconds: number): ISODateTime {
  return createISODateTime(new Date(Date.parse(value) + milliseconds).toISOString());
}

function createEmailLeaseKey(createId: MikaBackendIdFactory | undefined, emailId: MikaId): string {
  return createId?.("email_lease") ?? `email:${emailId}:${randomId()}`;
}

function randomId(): string {
  return (
    globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}${Math.random().toString(36)}`
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function jsonString(metadata: JsonObject | undefined, key: string): string | undefined {
  const value = metadata?.[key];

  return typeof value === "string" ? value : undefined;
}

function jsonISODateTime(metadata: JsonObject | undefined, key: string): ISODateTime | undefined {
  const value = jsonString(metadata, key);

  return value && isISODateTime(value) ? value : undefined;
}

function jsonStringArray(metadata: JsonObject | undefined, key: string): readonly string[] {
  const value = metadata?.[key];

  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}
