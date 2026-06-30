/**
 * Agent-facing contracts: capabilities, risk, idempotency, proofs, actors, and action-run telemetry.
 * Consumed by operation descriptors, route handlers, and agent manifests.
 */
import type { CurrencyCode, ISODateTime, JsonObject, MikaId } from "../types/primitives";

/** Version of the published agent operation manifest schema. */
export const MIKA_AGENT_MANIFEST_VERSION = 1 as const;

/** Visibility tiers controlling which operations appear in agent manifests. */
export const MIKA_AGENT_VISIBILITIES = ["public", "trusted", "admin", "hidden"] as const;
export type MikaAgentVisibility = (typeof MIKA_AGENT_VISIBILITIES)[number];

/** Fine-grained authorization scopes agents must hold to invoke operations. */
export const MIKA_AGENT_CAPABILITIES = [
  "catalog:read",
  "stock:read",
  "cart:read",
  "cart:write",
  "wishlist:read",
  "wishlist:write",
  "checkout:read",
  "checkout:start",
  "magic_link:write",
  "account:read",
  "account:write",
  "subscription:write",
  "download:read",
  "order:read",
  "webhook:receive",
  "admin:read",
  "admin:write",
] as const;
export type MikaAgentCapability = (typeof MIKA_AGENT_CAPABILITIES)[number];

/** Side-effect class used for policy and confirmation decisions. */
export const MIKA_AGENT_EFFECTS = [
  "read",
  "cart_mutation",
  "wishlist_mutation",
  "checkout_handoff",
  "account_mutation",
  "subscription_mutation",
  "download_resolution",
  "webhook_ingest",
  "admin_mutation",
] as const;
export type MikaAgentEffect = (typeof MIKA_AGENT_EFFECTS)[number];

/** Risk tier guiding confirmation and proof requirements. */
export const MIKA_AGENT_RISKS = ["none", "low", "purchase", "account", "admin"] as const;
export type MikaAgentRisk = (typeof MIKA_AGENT_RISKS)[number];

/** Minimum actor kind required before an operation may run. */
export const MIKA_AGENT_ACTOR_REQUIREMENTS = [
  "none",
  "session",
  "customer",
  "service",
  "admin",
] as const;
export type MikaAgentActorRequirement = (typeof MIKA_AGENT_ACTOR_REQUIREMENTS)[number];

/** Who must approve before a mutating operation proceeds. */
export const MIKA_AGENT_CONFIRMATION_POLICIES = ["none", "host", "user", "payment"] as const;
export type MikaAgentConfirmationPolicy = (typeof MIKA_AGENT_CONFIRMATION_POLICIES)[number];

/** Whether callers should supply an idempotency key for safe retries. */
export const MIKA_AGENT_IDEMPOTENCY_POLICIES = ["not_needed", "recommended", "required"] as const;
export type MikaAgentIdempotencyPolicy = (typeof MIKA_AGENT_IDEMPOTENCY_POLICIES)[number];

/** HTTP header name hosts use to pass idempotency keys. */
export const MIKA_AGENT_IDEMPOTENCY_KEY_HEADER = "Idempotency-Key" as const;
/** Replay scope: same actor, operation, resource, and input hash. */
export const MIKA_AGENT_IDEMPOTENCY_SCOPES = ["actor_operation_resource_input"] as const;
export type MikaAgentIdempotencyScope = (typeof MIKA_AGENT_IDEMPOTENCY_SCOPES)[number];

/** Commerce resources an operation may read or mutate. */
export const MIKA_AGENT_RESOURCES = [
  "sellable",
  "price",
  "stock",
  "cart",
  "wishlist",
  "checkout",
  "account",
  "subscription",
  "download",
  "order",
  "webhook",
  "admin",
] as const;
export type MikaAgentResource = (typeof MIKA_AGENT_RESOURCES)[number];

/** Proof kinds operations may accept or require at invocation time. */
export const MIKA_AGENT_PROOF_KINDS = [
  "consent",
  "mandate",
  "payment_authorization",
  "receipt",
] as const;
export type MikaAgentProofKind = (typeof MIKA_AGENT_PROOF_KINDS)[number];

/** Host-owned idempotency contract attached to operation metadata. */
export interface MikaAgentIdempotencyMetadata {
  readonly keyHeader: typeof MIKA_AGENT_IDEMPOTENCY_KEY_HEADER;
  readonly scope: MikaAgentIdempotencyScope;
  readonly replay: "same_key_same_input";
  readonly owner: "host";
}

/** Agent policy block embedded in each operation descriptor. */
export interface MikaAgentOperationMetadata {
  readonly visible: MikaAgentVisibility;
  readonly capability: MikaAgentCapability;
  readonly scopes: readonly MikaAuthorizationScope[];
  readonly effect: MikaAgentEffect;
  readonly risk: MikaAgentRisk;
  readonly requiresActor: MikaAgentActorRequirement;
  readonly confirmation: MikaAgentConfirmationPolicy;
  readonly idempotency: MikaAgentIdempotencyPolicy;
  readonly idempotencyKey?: MikaAgentIdempotencyMetadata;
  readonly resources: readonly MikaAgentResource[];
  readonly acceptsProofs?: readonly MikaAgentProofKind[];
  readonly requiredProofs: readonly MikaAgentProofKind[];
}

/** Kind of principal executing a Mika operation. */
export type MikaActorKind = "anonymous" | "customer" | "delegated_agent" | "service" | "admin";

/** Capability or host-defined scope granted to the current actor. */
export type MikaAuthorizationScope = MikaAgentCapability | (string & {});

/** Resolved actor identity carried in {@link MikaRequestContext}. */
export interface MikaActorContext {
  readonly kind: MikaActorKind;
  readonly id?: string;
  readonly userId?: string;
  readonly customerId?: MikaId;
  readonly sessionId?: string;
  readonly delegatedBy?: string;
  readonly claims?: JsonObject;
}

/** Shared fields for externally issued proof references. */
export interface MikaProofRefBase {
  readonly id: string;
  readonly issuer?: string;
  readonly subject?: string;
  readonly issuedAt?: ISODateTime;
  readonly expiresAt?: ISODateTime;
  readonly inputHash?: string;
  readonly raw?: JsonObject;
}

/** Proof reference recording end-user consent for a gated operation. */
export interface MikaConsentProofRef extends MikaProofRefBase {
  readonly kind: "consent";
}

/** Proof reference for a standing mandate authorizing recurring or delegated actions. */
export interface MikaMandateRef extends MikaProofRefBase {
  readonly kind: "mandate";
  readonly mandateType?: string;
}

/** Proof reference capping spend for a payment-sensitive operation. */
export interface MikaPaymentAuthorizationRef extends MikaProofRefBase {
  readonly kind: "payment_authorization";
  readonly handlerId?: string;
  readonly maxAmount?: {
    readonly amount: number;
    readonly currency: CurrencyCode;
  };
}

/** Proof reference tying an operation to a settled or pending commerce receipt. */
export interface MikaReceiptRef extends MikaProofRefBase {
  readonly kind: "receipt";
  readonly status?: "pending" | "settled" | "failed" | "refunded";
}

/** Union of proof references agents may attach to sensitive operations. */
export type MikaAgentProofRef =
  | MikaConsentProofRef
  | MikaMandateRef
  | MikaPaymentAuthorizationRef
  | MikaReceiptRef;

/** Lifecycle states for host-mediated operation approvals. */
export const MIKA_AGENT_APPROVAL_STATUSES = [
  "requested",
  "approved",
  "rejected",
  "expired",
  "revoked",
] as const;
export type MikaAgentApprovalStatus = (typeof MIKA_AGENT_APPROVAL_STATUSES)[number];

/** Proof reference recording an approval decision for a gated operation. */
export interface MikaAgentApprovalRef extends MikaProofRefBase {
  readonly status: MikaAgentApprovalStatus;
  readonly operation: string;
  readonly approvedInputHash?: string;
  readonly approvedBy?: MikaActorContext;
  readonly revokedAt?: ISODateTime;
}

/** Terminal and in-flight states for tracked agent action runs. */
export const MIKA_ACTION_RUN_STATUSES = [
  "queued",
  "running",
  "completed",
  "failed",
  "conflict",
  "requires_approval",
] as const;
export type MikaActionRunStatus = (typeof MIKA_ACTION_RUN_STATUSES)[number];

/** Structured failure surfaced on an action run. */
export interface MikaActionRunError {
  readonly code: string;
  readonly message: string;
  readonly retryAfter?: number;
  readonly raw?: JsonObject;
}

/** Audit record for a single agent-orchestrated operation attempt. */
export interface MikaActionRun {
  readonly id?: string;
  readonly operation: string;
  readonly actor?: MikaActorContext;
  readonly scopes?: readonly MikaAuthorizationScope[];
  readonly inputHash?: string;
  readonly idempotencyKey?: string;
  readonly correlationId?: string;
  readonly status: MikaActionRunStatus;
  readonly requestedAt?: ISODateTime;
  readonly startedAt?: ISODateTime;
  readonly completedAt?: ISODateTime;
  readonly approval?: MikaAgentApprovalRef;
  readonly proofRefs?: readonly MikaAgentProofRef[];
  readonly resultRef?: string;
  readonly error?: MikaActionRunError;
  readonly raw?: JsonObject;
}

/** Payload encoding accepted by HTML action endpoints. */
export type MikaAgentActionAccept = "form" | "json";
/** Where operation input is read from on the wire. */
export type MikaAgentOperationTransport = "body" | "search" | "none";
/** HTTP verb used by an operation's wire route in the agent manifest. */
export type MikaAgentOperationHttpMethod = "GET" | "POST" | "PATCH" | "DELETE";

/** Single operation entry in an agent manifest. */
export interface MikaAgentActionDescriptor {
  readonly name: string;
  readonly namespace: string;
  readonly method: string;
  readonly public: boolean;
  readonly requiresRequestContext: boolean;
  readonly agent: MikaAgentOperationMetadata;
  readonly action?: {
    readonly key: string;
    readonly name: string;
    readonly accept: MikaAgentActionAccept;
  };
  readonly route?: {
    readonly key: string;
    readonly path: string;
    readonly httpMethod: MikaAgentOperationHttpMethod;
    readonly transport: MikaAgentOperationTransport;
    readonly searchKeys?: readonly string[];
  };
}

/** Published catalog of agent-callable Mika operations and their policies. */
export interface MikaAgentManifest {
  readonly version: typeof MIKA_AGENT_MANIFEST_VERSION;
  readonly operations: readonly MikaAgentActionDescriptor[];
}
