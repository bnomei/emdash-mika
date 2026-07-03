/**
 * Per-request context for Mika operations: actor, session, idempotency, and correlation.
 * Built by route handlers and passed into every context-aware {@link MikaApi} method.
 */
import { createISODateTime, type ISODateTime, type MikaId } from "../types/primitives";
import type { MikaActorContext, MikaAuthorizationScope } from "./agent-types";

/** Immutable snapshot of request-scoped identity and timing for one operation invocation. */
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

/** Host session store abstraction used for anonymous cart and wishlist binding. */
export interface MikaSessionAccess {
  readonly sessionID?: string;
  get<T = unknown>(key: string): Promise<T | undefined>;
  set<T = unknown>(
    key: string,
    value: T,
    options?: { readonly ttl?: number },
  ): Promise<void> | void;
  delete?(key: string): Promise<void> | void;
  /**
   * Rotate the underlying session id, discarding the pre-rotation id. Mika calls this on a successful
   * magic-link verification, BEFORE binding identity, to defeat session fixation (an attacker who
   * planted a known session id in the victim's browser cannot reuse it after login). If a host omits
   * this method the call is a silent no-op and magic-link authentication remains fixation-exposed —
   * implement it (or rotate at the framework layer) to get that protection.
   */
  regenerate?(): Promise<void> | void;
  destroy?(): Promise<void> | void;
  load?(id: string): Promise<void> | void;
}

/** Fields available when constructing a {@link MikaRequestContext}. */
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

/** Normalizes host request, session, and actor data into a {@link MikaRequestContext}. */
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
