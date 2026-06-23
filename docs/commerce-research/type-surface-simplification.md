# Type Surface Simplification Research

This document captures a research pass over Mika's current TypeScript surface.
The goal is not to make the code clever for its own sake. The goal is to remove
drift-prone boilerplate while keeping Mika copyable, Astro-friendly, and small.

## Research Inputs

Local review was split across four focused passes:

- `api-action-type-surface (agent_019edc05-933d-7212-9713-72956be5124e)`:
  API routes, client, server stubs, route handlers, and Astro Actions.
- `storage-model-type-surface (agent_019edc05-b081-74b1-af22-42c6982dc198)`:
  aggregate/document types, storage config, repositories, and Kysely tables.
- `admin-email-shell-surface (agent_019edc05-cb5a-7b61-8fcc-fa3614de255d)`:
  admin action descriptors, `emdash-actions` compatibility, and email helpers.
- `astro-template-ergonomics-surface (agent_019edc05-e925-70f2-974a-48f721d4f3d2)`:
  Astro templates, purchase helpers, copied pages, and React helper ergonomics.

Tavily research covered endpoint-map/schema-first API patterns, Zod/TypeBox/tRPC
tradeoffs, TypeScript `satisfies`/const-map patterns, discriminated union
registries, Kysely JSON typing, schema-derived DTOs, generic repositories, and
code generation tradeoffs.

Useful external references:

- Astro Actions use Zod-compatible input schemas and generated type-safe action
  calls: <https://docs.astro.build/en/guides/actions/>
- TypeScript `satisfies` validates a value against a type while preserving the
  value's narrower inferred literal shape:
  <https://www.typescriptlang.org/docs/handbook/release-notes/typescript-4-9.html>
- Zod provides runtime validation with static type inference:
  <https://zod.dev/basics>
- TypeBox is useful when JSON Schema output is a first-class requirement:
  <https://github.com/sinclairzx81/typebox>
- tRPC-style routers give excellent TypeScript-only end-to-end inference, but
  are heavier than Mika's intended REST-like plugin surface:
  <https://trpc.io/docs/server/adapters>
- Kysely supports typed JSON columns and explicit `ColumnType` shapes:
  <https://kysely.dev/docs/examples/select/nested-object>

## Current Hotspots

| Surface                                   | Current shape                                                                                                                                                                                                         | Risk                                                                         | Better source of truth                                                                                                    |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| API routes/client/server/handlers/actions | Route keys, HTTP methods, inputs, outputs, API method names, and action names are repeated in `src/api/routes.ts`, `src/api/client.ts`, `src/api/server.ts`, `src/api/route-handlers.ts`, and `src/astro-actions.ts`. | Adding or renaming an endpoint requires coordinated edits across many files. | Internal endpoint definitions derived into route handlers, defaults, client request metadata, and Astro action metadata.  |
| Astro Actions                             | `MikaActionName` is handwritten and each `defineAction()` repeats accept mode, schema, action name, and client call.                                                                                                  | Action names and client calls can drift, and the file grows linearly.        | Local `defineMikaAction()` helper plus action definitions that keep schemas Astro-local.                                  |
| Storage documents                         | Document wrappers repeat fields from aggregate/record payloads, with some statuses widened back to `string`.                                                                                                          | Indexed fields drift from records, and useful status unions are lost.        | Generic `AggregateDocument` and `RecordBackedDocument` aliases, plus typed indexed projections.                           |
| Storage config/indexes                    | Indexes are plain strings even though document unions already know field names.                                                                                                                                       | Typos in index config are invisible to TypeScript.                           | `MikaIndex<TDocument>` using keys of the collection's document union.                                                     |
| Repositories                              | Repeated query, limit, discriminator check, and pagination casts.                                                                                                                                                     | Boilerplate hides the real query intent and casts can mask invalid results.  | Small `findOneByType()` and `listByType()` helpers returning `Extract<Union, { type: T }>`; keep business logic explicit. |
| Admin actions                             | ID union, descriptor arrays, helper defaults, docs tables, and route handlers repeat the same facts.                                                                                                                  | Manifest, field helpers, copy, feedback, and routes can drift.               | Single admin action registry derived into manifest and field helper options.                                              |
| Email templates                           | Template key union and generic renderer use casts.                                                                                                                                                                    | Adding a template requires several edits and loses input specificity.        | Template registry keyed by template name, deriving key and input types.                                                   |
| Astro purchase UI                         | `createMikaPurchaseOptions()` only exposes a flat option list; templates rederive selected sellable, price, quantity limits, and unavailable state.                                                                   | Variant/price selection logic will spread through copied templates.          | `createMikaPurchaseModel()` that returns the option list plus selected state and form fields.                             |

## Recommended Pattern

Use registries as internal source-of-truth values, validated with `satisfies`,
then derive types from those registries. This gives Mika most of the benefit of
schema-first or router-first systems without forcing a heavy framework onto host
projects.

This should be the default rule:

- Public APIs stay named, readable, and hand-friendly.
- Internal definitions become const maps.
- Types derive from the const maps where that removes drift.
- Runtime schemas live only at trust boundaries: Astro Actions, webhooks,
  provider payloads, stored JSON reads if needed, and admin action payloads.
- Business rules stay explicit. Atomic stock, token, webhook, checkout, and
  provider behavior should not disappear behind generic abstractions.

## Endpoint Definitions

The clean target is an internal `mikaEndpointDefinitions` map. It should not
replace the friendly `mika.cart.add(...)` public client surface. It should
centralize the facts that currently drift between the client, server stubs,
route handlers, and actions.

Shape sketch:

```ts
type MikaEndpointMethod = "GET" | "POST" | "PATCH" | "DELETE";
type MikaEndpointTransport = "none" | "search" | "body";

interface MikaEndpointSpec<TInput, TOutput> {
  readonly route: MikaPluginRouteName;
  readonly method: MikaEndpointMethod;
  readonly transport: MikaEndpointTransport;
  readonly action?: {
    readonly name: string;
    readonly accept: "form" | "json";
  };
  readonly call: (
    api: MikaApi,
    ctx: MikaRequestContext,
    input: TInput,
  ) => Promise<MikaApiResult<TOutput>>;
}

type AnyMikaEndpointSpec = MikaEndpointSpec<any, any>;

function endpoint<TInput, TOutput>(
  spec: MikaEndpointSpec<TInput, TOutput>,
): MikaEndpointSpec<TInput, TOutput> {
  return spec;
}

export const mikaEndpointDefinitions = {
  "cart.add": endpoint<AddCartItemInput, CartDTO>({
    route: "cartItems",
    method: "POST",
    transport: "body",
    action: { name: "cart.add", accept: "form" },
    call: (api, ctx, input) => api.cart.add(ctx, input),
  }),
  "checkout.status": endpoint<{ checkoutId: string; token?: string }, CheckoutSessionDTO>({
    route: "checkoutStatus",
    method: "GET",
    transport: "search",
    action: { name: "checkout.status", accept: "json" },
    call: (api, ctx, input) => api.checkout.status(ctx, input),
  }),
} as const satisfies Record<string, AnyMikaEndpointSpec>;

export type MikaEndpointName = keyof typeof mikaEndpointDefinitions;
```

The `any` is intentionally boxed inside the heterogeneous registry constraint.
The concrete input/output types still come from each `endpoint<TInput, TOutput>`
entry and should be exposed through derived helper types.

Derive these from the map:

- Route handler coverage: every route path in `mikaPluginRoutes` should be
  handled or intentionally marked route-only.
- Server default stubs: build `createMikaApi()` defaults from a method map so
  every missing method becomes `notImplemented("namespace.method")`.
- Action names: derive `MikaActionName` from definitions with `action`.
- Request metadata: client helpers can call a lower-level request with method
  and transport from the definition.

Keep these explicit:

- The public `MikaClient` interface for editor hovers and human readability.
- Convenience overloads such as `magicLink.verify(token)` and
  `account.portal(returnTo)`.
- DTO names that should be stable public API.

## Astro Actions

Astro Actions already push Mika toward Zod at the right boundary. Keep Zod in
`src/astro-actions.ts`, not in the core `./api` subpath. That avoids making the
API client/server types depend on Astro.

Recommended helper:

```ts
function defineMikaAction<TInput, TOutput>(options: {
  readonly name: MikaActionName;
  readonly accept: "form" | "json";
  readonly input: z.ZodType<TInput>;
  readonly call: (client: MikaClient, input: TInput) => Promise<MikaApiResult<TOutput>>;
}) {
  return defineAction({
    accept: options.accept,
    input: options.input,
    handler: (input, ctx) => run(ctx, options.name, input, (client) => options.call(client, input)),
  });
}
```

Use small schema helpers instead of duplicating form fields:

- `requiredString`
- `optionalString`
- `quantity`
- `returnToInput`
- `idInput("lineId")`
- `withReturnTo(schema)`

This is enough. Do not replace Astro Actions with tRPC. Tavily research confirms
tRPC is excellent when the whole app is TypeScript-owned, but Mika is a plugin
with REST-like routes, copyable Astro templates, and optional host integrations.

## Storage Documents And Repositories

Mika's storage model is intentionally close to EmDash collections. The leanest
shape is still collection documents with JSON aggregates, not a large relational
schema. TypeScript can make that cleaner.

Document aliases:

```ts
type BaseMikaDocument<TType extends string> = MikaStorageDocument & {
  readonly type: TType;
};

type AggregateDocument<
  TType extends string,
  TIndexed extends object,
  TAggregate,
> = BaseMikaDocument<TType> &
  TIndexed & {
    readonly aggregate: TAggregate;
  };

type RecordBackedDocument<
  TType extends string,
  TRecord,
  TIndexedKeys extends keyof TRecord,
> = BaseMikaDocument<TType> &
  Pick<TRecord, TIndexedKeys> & {
    readonly record: TRecord;
  };
```

That lets documents preserve important status unions instead of widening them:

```ts
type EmailDocument = RecordBackedDocument<
  "email",
  EmailMessageRecord,
  "status" | "nextAttemptAt" | "orderId" | "tokenId" | "kind"
>;
```

Typed indexes:

```ts
type KeysOfUnion<T> = T extends T ? keyof T : never;

export type MikaIndex<TDocument> = KeysOfUnion<TDocument> | readonly KeysOfUnion<TDocument>[];

export type MikaStorageConfig = {
  readonly [K in keyof MikaStorageDocuments]: {
    readonly indexes: readonly MikaIndex<MikaStorageDocuments[K]>[];
    readonly uniqueIndexes?: readonly MikaIndex<MikaStorageDocuments[K]>[];
  };
};
```

Repository helpers:

```ts
type DocumentOfType<TDocument, TType extends string> = Extract<TDocument, { type: TType }>;
type DocumentType<TDocument> = TDocument extends { type: infer TType extends string }
  ? TType
  : never;

async function findOneByType<
  TDocument extends { type: string },
  TType extends DocumentType<TDocument>,
>(
  collection: StorageCollection<TDocument>,
  type: TType,
  where: StorageWhereClause<TDocument>,
): Promise<DocumentOfType<TDocument, Extract<TType, string>> | null> {
  const result = await collection.query({ where: { ...where, type }, limit: 1 });
  const document = result.items[0]?.data;
  return document && (document as { type?: unknown }).type === type
    ? (document as DocumentOfType<TDocument, Extract<TType, string>>)
    : null;
}
```

Keep the helper small. Do not build a repository framework. Stock reservations,
ephemeral tokens, and Kysely atomic statements should remain explicit because
they have concurrency and security semantics.

## Admin Actions

Use a registry, not descriptor arrays:

```ts
interface MikaAdminActionDefinition extends MikaAdminActionDescriptor {
  readonly id: string;
  readonly fieldDefaults?: Partial<MikaActionButtonFieldOptions>;
}

export const mikaAdminActionDefinitions = {
  "mika.catalog.syncEntry": {
    id: "mika.catalog.syncEntry",
    label: "Sync commerce",
    route: mikaPluginRoutes.adminProviderSync,
    method: "POST",
    placement: "field",
    icon: "refresh",
    tone: "info",
    contextKey: "context",
    payload: { mode: "dry_run", scope: "entry" },
    feedback: {
      progress: "Syncing commerce data...",
      success: "Commerce data synced.",
      error: "Commerce sync failed.",
    },
  },
} as const satisfies Record<string, MikaAdminActionDefinition>;

export type MikaAdminActionId = keyof typeof mikaAdminActionDefinitions;
```

Then derive:

- `createMikaAdminActionsManifest()`
- `createMikaActionButtonOptions(actionId, overrides)`
- named wrappers such as `createMikaCatalogSyncActionButtonOptions()`
- docs tables if we later generate them

Keep `@bnomei/emdash-actions` optional. Mika can mirror the structural shape and
use type tests against `emdash-actions` in dev, but the core package should not
require the actions plugin at runtime.

## Email Templates

Use a typed template registry:

```ts
export const mikaEmailTemplates = {
  magic_link: {
    outboxKind: "magic_link",
    render: renderMikaMagicLinkEmail,
  },
  order_confirmation: {
    outboxKind: "order_confirmation",
    render: renderMikaOrderConfirmationEmail,
  },
} as const;

export type MikaEmailTemplateKey = keyof typeof mikaEmailTemplates;

export type MikaEmailInput<TTemplate extends MikaEmailTemplateKey> = Parameters<
  (typeof mikaEmailTemplates)[TTemplate]["render"]
>[0];

export function renderMikaEmail<TTemplate extends MikaEmailTemplateKey>(
  template: TTemplate,
  input: MikaEmailInput<TTemplate>,
): MikaRenderedEmail {
  return mikaEmailTemplates[template].render(input as never);
}
```

The one internal cast at the dispatch point is acceptable if the public generic
signature is precise and type tests cover it. Avoid adding a mailer or template
engine. Mika should render small copyable email bodies and let host projects own
delivery and branding.

## Astro Purchase Model

The frontend pressure is not generic type magic. It is missing derived UI state.
Add a richer helper:

```ts
export interface MikaPurchaseModel {
  readonly activeSellables: readonly SellableDTO[];
  readonly options: readonly MikaPurchaseOption[];
  readonly selectedOption?: MikaPurchaseOption;
  readonly selectedSellable?: SellableDTO;
  readonly selectedPrice?: PriceDTO;
  readonly maxQuantity?: number;
  readonly unavailable: boolean;
  readonly missingActivePrice: boolean;
  readonly variantGroups: readonly MikaPurchaseVariantGroup[];
}
```

Also give each option typed form fields:

```ts
export interface MikaPurchaseOption {
  readonly sellable: SellableDTO;
  readonly price: PriceDTO;
  readonly value: string;
  readonly fields: {
    readonly sellableId: string;
    readonly priceId: string;
    readonly purchase: string;
  };
  readonly label: string;
  readonly disabled: boolean;
}
```

This lets copied templates use the same object for add-to-cart, wishlist, and
buy-now forms. It also keeps variant and price selection behavior in one helper
instead of leaking it across `ProductPurchase`, `AddToCartForm`, and
`VariantOptionGroups`.

## What Not To Do

- Do not adopt full tRPC for Mika's public surface. It is a mismatch for a small
  REST-like EmDash plugin with copyable Astro files.
- Do not add OpenAPI/codegen unless Mika later needs external polyglot clients.
- Do not derive every DTO directly from storage documents. Public DTOs are a
  contract; storage documents are persistence shape.
- Do not move Astro/Zod dependencies into `./api`.
- Do not make repositories so generic that stock, token, and provider invariants
  become hard to see.
- Do not hide copied Astro templates behind black-box components. Helpers should
  reduce mistakes while leaving the HTML easy to copy and edit.

## Recommended Refactor Order

1. **Low risk, no behavior change**
   - Move `MIKA_ERROR_CODES` and similar runtime unions to exported const tuples.
   - Make route handler maps satisfy all known route paths.
   - Replace admin descriptor arrays with `mikaAdminActionDefinitions`.
   - Replace email dispatch casts with `mikaEmailTemplates`.

2. **API/action consolidation**
   - Add endpoint definitions for route, method, transport, action name, and API
     call.
   - Use them to reduce `createMikaApi()` defaults and route handler wiring.
   - Add `defineMikaAction()` while keeping Zod schemas in `astro-actions`.

3. **Storage type tightening**
   - Introduce document aliases for aggregate and record-backed documents.
   - Type `MikaIndex<TDocument>` and `StorageWhereClause<TDocument>`.
   - Add `findOneByType()` and `listByType()` helpers, then remove pagination
     casts where the helper proves the discriminator.

4. **Frontend helper pass**
   - Add `createMikaPurchaseModel()` and typed `option.fields`.
   - Add tiny action-result helpers for copied pages.
   - Consolidate high-count label props into `labels` objects where it improves
     localization.

5. **Only if needed later**
   - Add runtime validators for persisted JSON reads that cross trust
     boundaries.
   - Consider TypeBox or generated schemas only if Mika needs JSON Schema,
     OpenAPI, or non-TypeScript consumers.

## Bottom Line

The canonical path for Mika is not one grand abstraction. It is a few small
source-of-truth maps:

- endpoint definitions
- action definitions
- document/index definitions
- email template definitions
- purchase model helpers

Those maps let TypeScript infer the repetitive pieces while humans still see a
plain Astro and EmDash plugin surface.
