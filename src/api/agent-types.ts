import type { CurrencyCode, ISODateTime, JsonObject, MikaId } from "../types/primitives";

export const MIKA_AGENT_MANIFEST_VERSION = 1 as const;

export const MIKA_AGENT_VISIBILITIES = ["public", "trusted", "admin", "hidden"] as const;
export type MikaAgentVisibility = (typeof MIKA_AGENT_VISIBILITIES)[number];

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

export const MIKA_AGENT_RISKS = ["none", "low", "purchase", "account", "admin"] as const;
export type MikaAgentRisk = (typeof MIKA_AGENT_RISKS)[number];

export const MIKA_AGENT_ACTOR_REQUIREMENTS = [
  "none",
  "session",
  "customer",
  "service",
  "admin",
] as const;
export type MikaAgentActorRequirement = (typeof MIKA_AGENT_ACTOR_REQUIREMENTS)[number];

export const MIKA_AGENT_CONFIRMATION_POLICIES = ["none", "host", "user", "payment"] as const;
export type MikaAgentConfirmationPolicy = (typeof MIKA_AGENT_CONFIRMATION_POLICIES)[number];

export const MIKA_AGENT_IDEMPOTENCY_POLICIES = ["not_needed", "recommended", "required"] as const;
export type MikaAgentIdempotencyPolicy = (typeof MIKA_AGENT_IDEMPOTENCY_POLICIES)[number];

export const MIKA_AGENT_IDEMPOTENCY_KEY_HEADER = "Idempotency-Key" as const;
export const MIKA_AGENT_IDEMPOTENCY_SCOPES = ["actor_operation_resource_input"] as const;
export type MikaAgentIdempotencyScope = (typeof MIKA_AGENT_IDEMPOTENCY_SCOPES)[number];

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

export const MIKA_AGENT_PROOF_KINDS = [
  "consent",
  "mandate",
  "payment_authorization",
  "receipt",
] as const;
export type MikaAgentProofKind = (typeof MIKA_AGENT_PROOF_KINDS)[number];

export interface MikaAgentIdempotencyMetadata {
  readonly keyHeader: typeof MIKA_AGENT_IDEMPOTENCY_KEY_HEADER;
  readonly scope: MikaAgentIdempotencyScope;
  readonly replay: "same_key_same_input";
  readonly owner: "host";
}

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

export type MikaActorKind = "anonymous" | "customer" | "delegated_agent" | "service" | "admin";

export type MikaAuthorizationScope = MikaAgentCapability | (string & {});

export interface MikaActorContext {
  readonly kind: MikaActorKind;
  readonly id?: string;
  readonly userId?: string;
  readonly customerId?: MikaId;
  readonly sessionId?: string;
  readonly delegatedBy?: string;
  readonly claims?: JsonObject;
}

export interface MikaProofRefBase {
  readonly id: string;
  readonly issuer?: string;
  readonly subject?: string;
  readonly issuedAt?: ISODateTime;
  readonly expiresAt?: ISODateTime;
  readonly inputHash?: string;
  readonly raw?: JsonObject;
}

export interface MikaConsentProofRef extends MikaProofRefBase {
  readonly kind: "consent";
}

export interface MikaMandateRef extends MikaProofRefBase {
  readonly kind: "mandate";
  readonly mandateType?: string;
}

export interface MikaPaymentAuthorizationRef extends MikaProofRefBase {
  readonly kind: "payment_authorization";
  readonly handlerId?: string;
  readonly maxAmount?: {
    readonly amount: number;
    readonly currency: CurrencyCode;
  };
}

export interface MikaReceiptRef extends MikaProofRefBase {
  readonly kind: "receipt";
  readonly status?: "pending" | "settled" | "failed" | "refunded";
}

export type MikaAgentProofRef =
  | MikaConsentProofRef
  | MikaMandateRef
  | MikaPaymentAuthorizationRef
  | MikaReceiptRef;

export const MIKA_AGENT_APPROVAL_STATUSES = [
  "requested",
  "approved",
  "rejected",
  "expired",
  "revoked",
] as const;
export type MikaAgentApprovalStatus = (typeof MIKA_AGENT_APPROVAL_STATUSES)[number];

export interface MikaAgentApprovalRef extends MikaProofRefBase {
  readonly status: MikaAgentApprovalStatus;
  readonly operation: string;
  readonly approvedInputHash?: string;
  readonly approvedBy?: MikaActorContext;
  readonly revokedAt?: ISODateTime;
}

export const MIKA_ACTION_RUN_STATUSES = [
  "queued",
  "running",
  "completed",
  "failed",
  "conflict",
  "requires_approval",
] as const;
export type MikaActionRunStatus = (typeof MIKA_ACTION_RUN_STATUSES)[number];

export interface MikaActionRunError {
  readonly code: string;
  readonly message: string;
  readonly retryAfter?: number;
  readonly raw?: JsonObject;
}

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

export type MikaAgentActionAccept = "form" | "json";
export type MikaAgentOperationTransport = "body" | "search" | "none";
export type MikaAgentOperationHttpMethod = "GET" | "POST" | "PATCH" | "DELETE";

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

export interface MikaAgentManifest {
  readonly version: typeof MIKA_AGENT_MANIFEST_VERSION;
  readonly operations: readonly MikaAgentActionDescriptor[];
}
