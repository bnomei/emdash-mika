import { createISODateTime, type ISODateTime, type MikaId } from "../types/primitives";
import type { MikaActorContext, MikaAuthorizationScope } from "./agent-types";

export interface MikaRequestContext {
  readonly request?: Request;
  readonly url?: URL;
  readonly method?: string;
  readonly actor?: MikaActorContext;
  readonly scopes?: readonly MikaAuthorizationScope[];
  readonly authSubject?: string;
  readonly authIssuer?: string;
  readonly correlationId?: string;
  readonly idempotencyKey?: string;
  readonly sessionId?: string;
  readonly session?: MikaSessionAccess;
  readonly customerId?: MikaId;
  readonly userId?: string;
  readonly locale?: string;
  readonly now: ISODateTime;
}

export interface MikaSessionAccess {
  readonly sessionID?: string;
  get<T = unknown>(key: string): Promise<T | undefined>;
  set<T = unknown>(
    key: string,
    value: T,
    options?: { readonly ttl?: number },
  ): Promise<void> | void;
  regenerate?(): Promise<void> | void;
  destroy?(): Promise<void> | void;
  load?(id: string): Promise<void> | void;
}

export interface CreateMikaRequestContextInput {
  readonly request?: Request;
  readonly url?: URL | string;
  readonly actor?: MikaActorContext;
  readonly scopes?: readonly MikaAuthorizationScope[];
  readonly authSubject?: string;
  readonly authIssuer?: string;
  readonly correlationId?: string;
  readonly idempotencyKey?: string;
  readonly sessionId?: string;
  readonly session?: MikaSessionAccess;
  readonly customerId?: MikaId;
  readonly userId?: string;
  readonly locale?: string;
  readonly now?: Date;
}

export function createMikaRequestContext(
  input: CreateMikaRequestContextInput = {},
): MikaRequestContext {
  const url =
    input.url instanceof URL
      ? input.url
      : input.url
        ? new URL(input.url)
        : input.request
          ? new URL(input.request.url)
          : undefined;

  return {
    request: input.request,
    url,
    method: input.request?.method,
    actor: input.actor,
    scopes: input.scopes,
    authSubject: input.authSubject,
    authIssuer: input.authIssuer,
    correlationId: input.correlationId,
    idempotencyKey: input.idempotencyKey,
    sessionId: input.sessionId ?? input.session?.sessionID,
    session: input.session,
    customerId: input.customerId,
    userId: input.userId,
    locale: input.locale,
    now: createISODateTime((input.now ?? new Date()).toISOString()),
  };
}

export function readFormString(form: FormData, key: string): string | undefined {
  const value = form.get(key);
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function readFormNumber(form: FormData, key: string): number | undefined {
  const value = readFormString(form, key);
  if (value === undefined) return undefined;
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}
