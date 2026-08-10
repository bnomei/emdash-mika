/**
 * ACP checkout-session store contracts and the wire types they embed. Kept as a pure type leaf so
 * cross-entrypoint consumers (plugin.ts storage wiring, api/maintenance.ts cleanup) can import the
 * session-store vocabulary without referencing the full ACP handler entry. acp.ts re-exports every
 * name here, so the public `/acp` surface is unchanged.
 */
import type {
  CartId,
  CheckoutSessionId,
  CurrencyCode,
  ISODateTime,
  ProviderName,
} from "../types/primitives";

/** Buyer contact fields carried through the ACP checkout session lifecycle. */
export interface MikaAcpBuyer {
  readonly first_name: string;
  readonly last_name: string;
  readonly email: string;
  readonly phone_number?: string;
}

/** Sellable id and quantity line referenced by ACP checkout requests. */
export interface MikaAcpItem {
  readonly id: string;
  readonly quantity: number;
}

/** Structured fulfillment or billing address on ACP checkout sessions. */
export interface MikaAcpAddress {
  readonly name: string;
  readonly line_one: string;
  readonly line_two?: string;
  readonly city: string;
  readonly state: string;
  readonly country: string;
  readonly postal_code: string;
}

/** Lifecycle status advertised on ACP checkout session responses. */
export type MikaAcpCheckoutSessionStatus =
  | "not_ready_for_payment"
  | "ready_for_payment"
  | "completed"
  | "canceled";

/** Quoted line with base amount, discounts, tax, and total for the checkout session. */
export interface MikaAcpLineItem {
  readonly id: string;
  readonly item: MikaAcpItem;
  readonly base_amount: number;
  readonly discount: number;
  readonly subtotal: number;
  readonly tax: number;
  readonly total: number;
}

/** Digital or shipping fulfillment choice with priced subtotals. */
export type MikaAcpFulfillmentOption =
  | {
      readonly type: "digital";
      readonly id: string;
      readonly title: string;
      readonly subtitle?: string;
      readonly subtotal: number;
      readonly tax: number;
      readonly total: number;
    }
  | {
      readonly type: "shipping";
      readonly id: string;
      readonly title: string;
      readonly subtitle: string;
      readonly carrier: string;
      readonly earliest_delivery_time: string;
      readonly latest_delivery_time: string;
      readonly subtotal: number;
      readonly tax: number;
      readonly total: number;
    };

/** Labeled monetary total bucket (subtotal, tax, fulfillment, etc.) on a checkout session. */
export interface MikaAcpTotal {
  readonly type:
    | "items_base_amount"
    | "items_discount"
    | "subtotal"
    | "discount"
    | "fulfillment"
    | "tax"
    | "fee"
    | "total";
  readonly display_text: string;
  readonly amount: number;
}

/** Info or error message surfaced to the agent during checkout. */
export type MikaAcpMessage =
  | {
      readonly type: "info";
      readonly param: string;
      readonly content_type: "plain" | "markdown";
      readonly content: string;
    }
  | {
      readonly type: "error";
      readonly code:
        | "missing"
        | "invalid"
        | "out_of_stock"
        | "payment_declined"
        | "requires_sign_in"
        | "requires_3ds";
      readonly param?: string;
      readonly content_type: "plain" | "markdown";
      readonly content: string;
    };

/** Persisted ACP checkout session state linking cart, checkout, buyer, and payment authorization. */
export interface MikaAcpSessionRecord {
  /** ACP checkout session id (URL path param); distinct from the Mika cart/request session. */
  readonly id: string;
  /** Isolated Mika session id used for cart and checkout API calls. */
  readonly sessionId: string;
  readonly cartId?: CartId;
  readonly checkoutId?: CheckoutSessionId;
  readonly status: MikaAcpCheckoutSessionStatus;
  readonly buyer?: MikaAcpBuyer;
  readonly items: readonly MikaAcpItem[];
  readonly fulfillmentAddress?: MikaAcpAddress;
  readonly fulfillmentOptionId?: string;
  readonly currency?: CurrencyCode;
  readonly provider?: ProviderName;
  readonly paymentAuthorizationId?: string;
  /** Hash of checkout.preview input captured at delegated-payment handoff. */
  readonly quoteInputHash?: string;
  /** Frozen quote projection paired with quoteInputHash for completion replay checks. */
  readonly quoteSnapshot?: MikaAcpSessionSnapshot;
  readonly expiresAt?: ISODateTime;
  readonly expiredAt?: ISODateTime;
  /** Scheduled purge time for terminal sessions retained after completion or cancel. */
  readonly purgeAt?: ISODateTime;
  readonly createdAt: ISODateTime;
  readonly updatedAt: ISODateTime;
  /**
   * Monotonically incremented on every write. Optimistic-concurrency writes (see
   * {@link MikaAcpSessionStore.putIfUnchanged}) compare this instead of relying on the fencing
   * tokens that guard idempotency-key bookkeeping alone — those only protect the claim map, not
   * this record itself, so a handler reclaimed mid-flight could otherwise still overwrite a newer
   * write with its own stale one. Optional (not `undefined`-hostile) because records persisted
   * before this field existed have none at runtime despite any type claiming otherwise.
   */
  readonly version?: number;
}

/** Frozen ACP quote projection captured before delegated payment handoff. */
export interface MikaAcpSessionSnapshot {
  readonly capturedAt: ISODateTime;
  readonly quoteInputHash?: string;
  readonly currency: string;
  readonly lineItems: readonly MikaAcpLineItem[];
  readonly fulfillmentOptions: readonly MikaAcpFulfillmentOption[];
  readonly fulfillmentOptionId?: string;
  readonly totals: readonly MikaAcpTotal[];
  readonly messages: readonly MikaAcpMessage[];
}

/** Input for optional ACP session store cleanup. */
export interface MikaAcpSessionCleanupInput {
  readonly now: ISODateTime;
  readonly limit?: number;
  readonly terminalRetentionMs?: number;
}

/** Counts from expiring and purging ACP sessions. */
export interface MikaAcpSessionCleanupResult {
  readonly scanned: number;
  readonly expired: number;
  readonly purged: number;
  readonly hasMore: boolean;
}

/** Expiry window handed to {@link MikaAcpSessionStore.claimIdempotencyKey} for crash recovery. */
export interface MikaAcpIdempotencyLeaseWindow {
  readonly now: ISODateTime;
  readonly expiresAt: ISODateTime;
}

/** Pluggable store for ACP session records with atomic idempotency-key coordination. */
export interface MikaAcpSessionStore {
  get(id: string): Promise<MikaAcpSessionRecord | undefined>;
  /** Unconditional write, for records with no prior state to protect (only session creation). */
  put(record: MikaAcpSessionRecord): Promise<void>;
  /**
   * Optimistic-concurrency write: persists `record` only if the store's currently-stored version
   * for `record.id` still equals `expectedVersion`, and reports whether the write landed. Every
   * handler that reads a record and later writes a mutated copy of it must use this instead of
   * `put` — the idempotency-key fencing tokens above only protect the claim bookkeeping, not this
   * record, so without this a handler reclaimed mid-flight (its lease TTL expired while it was
   * merely slow, not crashed) could still silently overwrite a newer write already committed by
   * whoever reclaimed it. `expectedVersion` is `undefined` when the caller read a record persisted
   * before `version` existed, or when writing brand-new state with nothing to compare against —
   * implementations must allow the write in that case rather than always rejecting it.
   *
   * This protects the *record* from a reclaimed handler's stale write; it does not and cannot
   * prevent the reclaimed handler's own upstream side effects (e.g. handleAcpComplete's
   * checkout.start call) from having already run before it lost this race — a reclaim scenario
   * still means checkout.start executes once per handler attempt. Hosts wiring a real payment
   * provider should size `idempotencyClaimTtlMs` well above realistic handler latency to make
   * reclaims rare, and treat them as a known, bounded risk rather than one this method eliminates.
   */
  putIfUnchanged(
    record: MikaAcpSessionRecord,
    expectedVersion: number | undefined,
  ): Promise<boolean>;
  /**
   * Claim before mutating; replay returns the stored record, conflict returns the other session
   * id. Stores must treat a PENDING (unbound) claim whose `expiresAt` lies at or before
   * `lease.now` as expired and grant the new claim — otherwise a handler crash between claim and
   * bind/release leaves the key `in_progress` forever and, for the completion lock, permanently
   * bricks completion of that session. Bound keys never expire.
   *
   * A `"claimed"` result carries a `fencingToken` that must be unique to *this* claim and change
   * on every reclaim of the same key (a monotonically increasing counter is sufficient — it need
   * not be unguessable). The claim TTL is a heuristic (`idempotencyClaimTtlMs`): a handler that is
   * merely slow, not crashed, can still be running when its lease is reclaimed by a retry. Without
   * a fencing token, that original handler's later `bindIdempotencyKey`/`releaseIdempotencyKey`
   * call has no way to tell it no longer holds the key, and can silently overwrite or release the
   * reclaiming handler's in-progress or already-committed work.
   */
  claimIdempotencyKey(
    key: string,
    id: string,
    lease?: MikaAcpIdempotencyLeaseWindow,
  ): Promise<MikaAcpIdempotencyClaim>;
  /**
   * Bind after successful handler completion so replays return the committed record. `fencingToken`
   * must match the token returned by the `"claimed"` claim this bind corresponds to — stores must
   * reject (no-op) a bind whose token no longer matches the key's current claim, e.g. because the
   * original claim expired and was reclaimed by another handler in the meantime.
   */
  bindIdempotencyKey(key: string, id: string, fencingToken: string): Promise<void>;
  /**
   * Release after handler failure so the key can be retried. `fencingToken` must match the token
   * returned by the `"claimed"` claim this release corresponds to, for the same reclaim-safety
   * reason as {@link bindIdempotencyKey}.
   */
  releaseIdempotencyKey(key: string, id: string, fencingToken: string): Promise<void>;
  /**
   * Bulk-expires stale sessions and purges retained terminal ones. Implementations must apply the
   * same optimistic-concurrency discipline as {@link putIfUnchanged} to each record they mutate —
   * the in-memory reference implementation gets this for free because its whole scan-and-mutate
   * loop runs synchronously with no `await` in between, so nothing can interleave with a
   * concurrent `putIfUnchanged`, but that's an artifact of that specific implementation, not a
   * guarantee this interface provides. A host store (database-backed, possibly multi-process) that
   * bulk-updates records here without a per-record CAS reintroduces exactly the class of bug
   * `putIfUnchanged` exists to close — e.g. clobbering a session a concurrent handleAcpComplete is
   * mid-write on.
   */
  cleanupExpired?(input: MikaAcpSessionCleanupInput): Promise<MikaAcpSessionCleanupResult>;
}

/** Result of claiming an ACP idempotency key before creating or replaying a checkout session. */
export type MikaAcpIdempotencyClaim =
  | { readonly status: "claimed"; readonly fencingToken: string }
  | { readonly status: "replayed"; readonly record: MikaAcpSessionRecord }
  | { readonly status: "conflict"; readonly id: string }
  | { readonly status: "in_progress"; readonly id: string };
