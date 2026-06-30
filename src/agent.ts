/**
 * Agent manifest builder and JSON Schema for exposing Mika operation descriptors to autonomous
 * agents with capability, risk, idempotency, and proof metadata.
 */
import { mikaOperationDefinitions } from "./api/operations";
import {
  MIKA_AGENT_ACTOR_REQUIREMENTS,
  MIKA_AGENT_CAPABILITIES,
  MIKA_AGENT_CONFIRMATION_POLICIES,
  MIKA_AGENT_EFFECTS,
  MIKA_AGENT_IDEMPOTENCY_KEY_HEADER,
  MIKA_AGENT_IDEMPOTENCY_POLICIES,
  MIKA_AGENT_IDEMPOTENCY_SCOPES,
  MIKA_AGENT_MANIFEST_VERSION,
  MIKA_AGENT_PROOF_KINDS,
  MIKA_AGENT_RESOURCES,
  MIKA_AGENT_RISKS,
  MIKA_AGENT_VISIBILITIES,
  type MikaAgentActionDescriptor,
  type MikaAgentManifest,
  type MikaAgentOperationMetadata,
  type MikaAgentVisibility,
} from "./api/agent-types";

/** Recursive JSON value type used to build the agent manifest JSON Schema object. */
export type MikaJsonSchemaValue =
  | string
  | number
  | boolean
  | null
  | readonly MikaJsonSchemaValue[]
  | { readonly [key: string]: MikaJsonSchemaValue };

/** JSON Schema object describing the shape of a published Mika agent manifest. */
export interface MikaAgentManifestJsonSchema {
  readonly [key: string]: MikaJsonSchemaValue;
}

const JSON_SCHEMA_THEN = "then" as const;

/** Draft 2020-12 JSON Schema for validating agent manifests at integration boundaries. */
export const mikaAgentManifestJsonSchema: MikaAgentManifestJsonSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://bnomei.com/schemas/emdash-mika/agent-manifest.v1.json",
  title: "Mika Agent Manifest",
  type: "object",
  additionalProperties: false,
  required: ["version", "operations"],
  properties: {
    version: { const: MIKA_AGENT_MANIFEST_VERSION },
    operations: {
      type: "array",
      items: { $ref: "#/$defs/operation" },
    },
  },
  $defs: {
    operation: {
      type: "object",
      additionalProperties: false,
      required: ["name", "namespace", "method", "public", "requiresRequestContext", "agent"],
      allOf: [
        {
          if: {
            properties: {
              public: { const: true },
            },
          },
          [JSON_SCHEMA_THEN]: {
            required: ["route"],
            properties: {
              route: { $ref: "#/$defs/route" },
            },
          },
          else: {
            properties: {
              route: false,
            },
          },
        },
      ],
      properties: {
        name: { type: "string", minLength: 1 },
        namespace: { type: "string", minLength: 1 },
        method: { type: "string", minLength: 1 },
        public: { type: "boolean" },
        requiresRequestContext: { type: "boolean" },
        agent: { $ref: "#/$defs/agentMetadata" },
        action: { $ref: "#/$defs/action" },
        route: { $ref: "#/$defs/route" },
      },
    },
    agentMetadata: {
      type: "object",
      additionalProperties: false,
      required: [
        "visible",
        "capability",
        "scopes",
        "effect",
        "risk",
        "requiresActor",
        "confirmation",
        "idempotency",
        "resources",
        "requiredProofs",
      ],
      allOf: [
        {
          if: {
            properties: {
              idempotency: { enum: ["recommended", "required"] },
            },
          },
          [JSON_SCHEMA_THEN]: {
            required: ["idempotencyKey"],
            properties: {
              idempotencyKey: { $ref: "#/$defs/idempotencyKey" },
            },
          },
          else: {
            properties: {
              idempotencyKey: false,
            },
          },
        },
      ],
      properties: {
        visible: { enum: [...MIKA_AGENT_VISIBILITIES] },
        capability: { enum: [...MIKA_AGENT_CAPABILITIES] },
        scopes: {
          type: "array",
          minItems: 1,
          items: { type: "string", minLength: 1 },
        },
        effect: { enum: [...MIKA_AGENT_EFFECTS] },
        risk: { enum: [...MIKA_AGENT_RISKS] },
        requiresActor: { enum: [...MIKA_AGENT_ACTOR_REQUIREMENTS] },
        confirmation: { enum: [...MIKA_AGENT_CONFIRMATION_POLICIES] },
        idempotency: { enum: [...MIKA_AGENT_IDEMPOTENCY_POLICIES] },
        idempotencyKey: { $ref: "#/$defs/idempotencyKey" },
        resources: {
          type: "array",
          minItems: 1,
          items: { enum: [...MIKA_AGENT_RESOURCES] },
        },
        acceptsProofs: {
          type: "array",
          items: { enum: [...MIKA_AGENT_PROOF_KINDS] },
        },
        requiredProofs: {
          type: "array",
          items: { enum: [...MIKA_AGENT_PROOF_KINDS] },
        },
      },
    },
    idempotencyKey: {
      type: "object",
      additionalProperties: false,
      required: ["keyHeader", "scope", "replay", "owner"],
      properties: {
        keyHeader: { const: MIKA_AGENT_IDEMPOTENCY_KEY_HEADER },
        scope: { enum: [...MIKA_AGENT_IDEMPOTENCY_SCOPES] },
        replay: { const: "same_key_same_input" },
        owner: { const: "host" },
      },
    },
    action: {
      type: "object",
      additionalProperties: false,
      required: ["key", "name", "accept"],
      properties: {
        key: { type: "string", minLength: 1 },
        name: { type: "string", minLength: 1 },
        accept: { enum: ["form", "json"] },
      },
    },
    route: {
      type: "object",
      additionalProperties: false,
      required: ["key", "path", "httpMethod", "transport"],
      allOf: [
        {
          if: {
            properties: {
              transport: { const: "search" },
            },
          },
          [JSON_SCHEMA_THEN]: {
            required: ["searchKeys"],
            properties: {
              searchKeys: {
                type: "array",
                minItems: 1,
                items: { type: "string", minLength: 1 },
              },
            },
          },
          else: {
            properties: {
              searchKeys: false,
            },
          },
        },
      ],
      properties: {
        key: { type: "string", minLength: 1 },
        path: { type: "string", minLength: 1 },
        httpMethod: { enum: ["GET", "POST", "PATCH", "DELETE"] },
        transport: { enum: ["body", "search", "none"] },
        searchKeys: {
          type: "array",
          items: { type: "string", minLength: 1 },
        },
      },
    },
  },
};

const DEFAULT_AGENT_VISIBILITIES = [
  "public",
  "trusted",
] as const satisfies readonly MikaAgentVisibility[];

/** Filters which agent-visible operations are included in the generated manifest. */
export interface CreateMikaAgentManifestOptions {
  readonly include?: readonly MikaAgentVisibility[];
}

/** Options alias for `createMikaAgentManifest`; filters operations by agent visibility tier. */
export type MikaAgentManifestOptions = CreateMikaAgentManifestOptions;

/** Projects Mika operation descriptors into an agent manifest for autonomous commerce clients. */
export function createMikaAgentManifest(
  options: CreateMikaAgentManifestOptions = {},
): MikaAgentManifest {
  const included = new Set(options.include ?? DEFAULT_AGENT_VISIBILITIES);

  return {
    version: MIKA_AGENT_MANIFEST_VERSION,
    operations: Object.values(mikaOperationDefinitions)
      .filter((operation) => included.has(operation.agent.visible))
      .map(toAgentActionDescriptor),
  };
}

function toAgentActionDescriptor(
  operation: (typeof mikaOperationDefinitions)[keyof typeof mikaOperationDefinitions],
): MikaAgentActionDescriptor {
  return {
    name: operation.name,
    namespace: operation.namespace,
    method: operation.method,
    public: operation.public,
    requiresRequestContext: operation.requiresRequestContext,
    agent: toAgentOperationMetadata(operation.agent),
    ...("action" in operation
      ? {
          action: {
            key: operation.action.key,
            name: operation.action.name,
            accept: operation.action.accept,
          },
        }
      : {}),
    ...(operation.public
      ? {
          route: {
            key: operation.routeKey,
            path: operation.routePath,
            httpMethod: operation.httpMethod,
            transport: operation.transport,
            ...("searchKeys" in operation ? { searchKeys: [...operation.searchKeys] } : {}),
          },
        }
      : {}),
  };
}

function toAgentOperationMetadata(agent: MikaAgentOperationMetadata): MikaAgentOperationMetadata {
  return {
    visible: agent.visible,
    capability: agent.capability,
    scopes: [...agent.scopes],
    effect: agent.effect,
    risk: agent.risk,
    requiresActor: agent.requiresActor,
    confirmation: agent.confirmation,
    idempotency: agent.idempotency,
    ...(agent.idempotencyKey ? { idempotencyKey: { ...agent.idempotencyKey } } : {}),
    resources: [...agent.resources],
    ...(agent.acceptsProofs ? { acceptsProofs: [...agent.acceptsProofs] } : {}),
    requiredProofs: [...agent.requiredProofs],
  };
}

export {
  MIKA_ACTION_RUN_STATUSES,
  MIKA_AGENT_ACTOR_REQUIREMENTS,
  MIKA_AGENT_APPROVAL_STATUSES,
  MIKA_AGENT_CAPABILITIES,
  MIKA_AGENT_CONFIRMATION_POLICIES,
  MIKA_AGENT_EFFECTS,
  MIKA_AGENT_IDEMPOTENCY_KEY_HEADER,
  MIKA_AGENT_IDEMPOTENCY_POLICIES,
  MIKA_AGENT_IDEMPOTENCY_SCOPES,
  MIKA_AGENT_MANIFEST_VERSION,
  MIKA_AGENT_PROOF_KINDS,
  MIKA_AGENT_RESOURCES,
  MIKA_AGENT_RISKS,
  MIKA_AGENT_VISIBILITIES,
} from "./api/agent-types";
export type {
  MikaActorContext,
  MikaActorKind,
  MikaActionRun,
  MikaActionRunError,
  MikaActionRunStatus,
  MikaAgentApprovalRef,
  MikaAgentApprovalStatus,
  MikaAgentActionAccept,
  MikaAgentActionDescriptor,
  MikaAgentActorRequirement,
  MikaAgentCapability,
  MikaAgentConfirmationPolicy,
  MikaAgentEffect,
  MikaAgentIdempotencyMetadata,
  MikaAgentIdempotencyPolicy,
  MikaAgentIdempotencyScope,
  MikaAgentManifest,
  MikaAgentOperationHttpMethod,
  MikaAgentOperationMetadata,
  MikaAgentOperationTransport,
  MikaAgentProofKind,
  MikaAgentProofRef,
  MikaAgentResource,
  MikaAgentRisk,
  MikaAgentVisibility,
  MikaAuthorizationScope,
  MikaConsentProofRef,
  MikaMandateRef,
  MikaPaymentAuthorizationRef,
  MikaReceiptRef,
} from "./api/agent-types";
