import { createISODateTime, isISODateTime, type ISODateTime } from "../types/primitives";

export interface MikaKVAccess {
  get<T>(key: string): Promise<T | null>;
  set(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<boolean>;
  list(prefix?: string): Promise<Array<{ key: string; value: unknown }>>;
}

export interface ExpiringCacheEntry<T> {
  readonly value: T;
  readonly createdAt: ISODateTime;
  readonly expiresAt: ISODateTime;
}

export class MikaCache {
  private readonly kv: MikaKVAccess;
  private readonly prefix: string;

  constructor(kv: MikaKVAccess, prefix = "cache:") {
    this.kv = kv;
    this.prefix = prefix;
  }

  async get<T>(key: string, now = new Date()): Promise<T | null> {
    const cacheKey = this.key(key);
    const entry = await this.kv.get<unknown>(cacheKey);

    if (!entry) return null;
    if (!isExpiringCacheEntry(entry)) {
      await this.kv.delete(cacheKey);
      return null;
    }

    if (Date.parse(entry.expiresAt) <= now.getTime()) {
      await this.kv.delete(cacheKey);
      return null;
    }

    return entry.value as T;
  }

  async set<T>(key: string, value: T, ttlSeconds: number, now = new Date()): Promise<void> {
    const expiresAt = new Date(now.getTime() + ttlSeconds * 1000);
    await this.kv.set(this.key(key), {
      value,
      createdAt: createISODateTime(now.toISOString()),
      expiresAt: createISODateTime(expiresAt.toISOString()),
    } satisfies ExpiringCacheEntry<T>);
  }

  async delete(key: string): Promise<boolean> {
    return this.kv.delete(this.key(key));
  }

  async purgeExpired(now = new Date()): Promise<number> {
    const entries = await this.kv.list(this.prefix);
    let deleted = 0;

    for (const entry of entries) {
      if (!isExpiringCacheEntry(entry.value)) continue;
      if (Date.parse(entry.value.expiresAt) <= now.getTime()) {
        if (await this.kv.delete(entry.key)) deleted++;
      }
    }

    return deleted;
  }

  private key(key: string): string {
    return `${this.prefix}${key}`;
  }
}

export function isExpiringCacheEntry(value: unknown): value is ExpiringCacheEntry<unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    "expiresAt" in value &&
    isISODateTime(value.expiresAt) &&
    "createdAt" in value &&
    isISODateTime(value.createdAt) &&
    "value" in value
  );
}
