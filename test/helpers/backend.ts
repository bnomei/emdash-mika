/**
 * Backend test fixtures: request context, clocks, DTOs, and in-memory Kysely DB.
 */
import { LibsqlDialect } from "@libsql/kysely-libsql";
import { Kysely } from "kysely";

import { optionalProperty } from "../../src/internal/object";
import { createMikaRequestContext, type MikaRequestContext } from "../../src/api/context";
import type { MikaDb } from "../../src/storage/repositories";
import type { MikaDatabase } from "../../src/storage/schema";
import type { ContentRefDTO, PriceDTO, SellableDTO } from "../../src/api/types";
import {
  createCurrencyCode,
  createISODateTime,
  createMikaId,
  createProviderName,
  type CurrencyCode,
  type ISODateTime,
  type MikaId,
  type ProviderName,
} from "../../src/types/primitives";

/** Fixed ISO timestamp shared across backend tests. */
export const TEST_NOW = createISODateTime("2026-01-01T00:00:00.000Z");
export const TEST_NOW_DATE = new Date(TEST_NOW);
export const TEST_CURRENCY = createCurrencyCode("EUR");
export const TEST_PROVIDER = createProviderName("fake");

/** Deterministic clock with offset helpers for time-dependent assertions. */
export type TestClock = {
  readonly now: Date;
  readonly iso: ISODateTime;
  readonly at: (offsetMs: number) => Date;
  readonly isoAt: (offsetMs: number) => ISODateTime;
};

export type CreateTestRequestContextOptions = {
  readonly request?: Request;
  readonly url?: string | URL;
  readonly method?: string;
  readonly sessionId?: string | false;
  readonly customerId?: MikaId | string | false;
  readonly userId?: string | false;
  readonly idempotencyKey?: string | false;
  readonly locale?: string | false;
  readonly now?: Date;
};

/** Builds a frozen test clock anchored at `now`. */
export function createTestClock(now: Date | string = TEST_NOW_DATE): TestClock {
  const date = typeof now === "string" ? new Date(now) : new Date(now);

  return {
    now: new Date(date),
    iso: createISODateTime(date.toISOString()),
    at: (offsetMs) => new Date(date.getTime() + offsetMs),
    isoAt: (offsetMs) => createISODateTime(new Date(date.getTime() + offsetMs).toISOString()),
  };
}

export function createTestMikaId(prefix = "test", index = 1): MikaId {
  return createMikaId(`${prefix}_${index}`);
}

export function createTestProviderName(provider = "fake"): ProviderName {
  return createProviderName(provider);
}

export function createTestCurrencyCode(currency = "EUR"): CurrencyCode {
  return createCurrencyCode(currency);
}

/** In-memory LibSQL-backed Kysely instance for repository tests. */
export function createTestMikaDb(): MikaDb {
  return new Kysely<MikaDatabase>({
    dialect: new LibsqlDialect({ url: "file::memory:" }),
  });
}

export function createTestHash(input = "mika:test"): string {
  let hash = 0x811c9dc5;

  for (const char of input) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 0x01000193);
  }

  return `test_${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

/** Minimal {@link MikaRequestContext} with session, customer, and idempotency defaults. */
export function createTestRequestContext(
  options: CreateTestRequestContextOptions = {},
): MikaRequestContext {
  const url = options.url ?? "https://shop.example.test/products/test-product?ref=test";
  const request =
    options.request ??
    new Request(url, {
      method: options.method ?? "GET",
      headers: { "x-test-request": "backend" },
    });
  const sessionId = options.sessionId === false ? undefined : (options.sessionId ?? "session_1");
  const session = sessionId === undefined ? undefined : createTestSession(sessionId);

  return createMikaRequestContext({
    request,
    url,
    ...optionalProperty("session", session),
    ...optionalProperty("sessionId", sessionId),
    ...optionalProperty("customerId", normalizeOptionalMikaId(options.customerId, "customer", 1)),
    ...optionalProperty(
      "userId",
      options.userId === false ? undefined : (options.userId ?? "user_1"),
    ),
    ...optionalProperty(
      "idempotencyKey",
      options.idempotencyKey === false ? undefined : (options.idempotencyKey ?? "idem_1"),
    ),
    ...optionalProperty(
      "locale",
      options.locale === false ? undefined : (options.locale ?? "en-IE"),
    ),
    now: options.now ?? TEST_NOW_DATE,
  });
}

export function createTestContentRef(overrides: Partial<ContentRefDTO> = {}): ContentRefDTO {
  return {
    collection: "products",
    id: "test-product",
    locale: "en-IE",
    ...overrides,
  };
}

export function createTestPriceDTO(overrides: Partial<PriceDTO> = {}): PriceDTO {
  const sellableId = overrides.sellableId ?? createTestMikaId("sellable", 1);

  return {
    id: createTestMikaId("price", 1),
    sellableId,
    amount: 1200,
    currency: TEST_CURRENCY,
    mode: "payment",
    fulfillmentKind: "none",
    active: true,
    ...overrides,
  };
}

export function createTestSellableDTO(overrides: Partial<SellableDTO> = {}): SellableDTO {
  const id = overrides.id ?? createTestMikaId("sellable", 1);
  const prices = overrides.prices ?? [createTestPriceDTO({ sellableId: id })];

  return {
    id,
    contentRef: createTestContentRef(),
    sku: "TEST-SKU-1",
    title: "Test product",
    active: true,
    variantOptions: [],
    prices,
    ...overrides,
  };
}

function createTestSession(sessionID: string): NonNullable<MikaRequestContext["session"]> {
  const values = new Map<string, unknown>();

  return {
    sessionID,
    async get<T = unknown>(key: string): Promise<T | undefined> {
      return values.get(key) as T | undefined;
    },
    set<T = unknown>(key: string, value: T): void {
      values.set(key, value);
    },
    delete(key: string): void {
      values.delete(key);
    },
  };
}

function normalizeOptionalMikaId(
  value: MikaId | string | false | undefined,
  prefix: string,
  index: number,
): MikaId | undefined {
  if (value === false) return undefined;
  if (typeof value === "string") return createMikaId(value);

  return value ?? createTestMikaId(prefix, index);
}
