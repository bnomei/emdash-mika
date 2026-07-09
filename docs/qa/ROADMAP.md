# QA roadmap — complete picture

**Status:** living index of all `docs/qa/` work  
**Last focused update:** 2026-07-09 (P0–P3 hygiene shipped; **follow-up F0–F4 closed or deferred**)  
**Open engineering work:** [ROADMAP-followup.md](./ROADMAP-followup.md) only.  
**Do not** treat Guardrails / Hold / Later as unchecked tasks — they are policy or out-of-scope.

**How to use (legacy archive):** historical checkmarks below record the first hygiene campaign. Prefer follow-up cards for anything still open.

---

## Headline decision

**No full architectural overhaul.**  
Ship **surface hygiene + drift armor** under the existing multi-entry public API.

| If “overhaul” means… | Do this |
| -------------------- | ------- |
| Redesign host-facing shape, subpaths, or `MikaApi` injection | **Do not** |
| Make the existing surface airtight (registry pins, barrels, client purity, peer honesty, megafile splits) | **Yes — this roadmap** |

**Primary decision doc:** [architecture-overhaul-verdict.md](./architecture-overhaul-verdict.md)

---

## Report index (all woven)

| Report | Focus | Role in this roadmap |
| ------ | ----- | -------------------- |
| [architecture-overhaul-verdict.md](./architecture-overhaul-verdict.md) | Go/no-go under external API goals | Decision, assumption board, freeze rules |
| [external-api-surface.md](./external-api-surface.md) | Exports, types, `MikaApi`, route/client/action coherence | P0–P1 external contracts |
| [astro-v7-emdash-fitness.md](./astro-v7-emdash-fitness.md) | Astro Actions + EmDash native plugin fitness | Client purity, peers, storage typing, templates |
| [tavily-validation-ts-astro-emdash.md](./tavily-validation-ts-astro-emdash.md) | External validation (TS libs, Astro 7, EmDash) | Evidence for keep vs change |
| [architecture-internal-vs-external-api.md](./architecture-internal-vs-external-api.md) | Hexagonal layers, agent projections, phases 0–6 | Internal blueprint + agentic / error phases |
| [typescript-internals-improvements.md](./typescript-internals-improvements.md) | TS config, brands, registry tactics, library polish | Implementation tactics for drift / brands / DX |

**Related (outside `docs/qa/`):**

| Doc | Use |
| --- | --- |
| [type-surface-simplification.md](../commerce-research/type-surface-simplification.md) | Registry sketch (largely **implemented**; residual = hand-interface pins) |
| [public-api-and-frontend-contract.md](../commerce-research/public-api-and-frontend-contract.md) | Wire DTO / error taxonomy intent |
| [outside-in-surfaces.md](../commerce-research/outside-in-surfaces.md) | Kit vs store-builder product principle |
| [sandbox-vs-native.md](../commerce-research/sandbox-vs-native.md) | Why native EmDash plugin for commerce |
| [docs/agentic/README.md](../agentic/README.md) | Protocol projections (UCP/MCP/…) stay host-owned |

---

## Priority legend

| Tier | Meaning |
| ---- | ------- |
| **Guardrails** | Policy — do not reverse without a written decision in a QA report |
| **P0** | Ship next — contract holes, drift locks, client purity (external-API blocking) |
| **P1** | Follow immediately — dual truth, peers, host DX, storage typing |
| **P2** | Maintainability — megafiles, brands, exhaustiveness, additive errors |
| **P3** | Polish — consumer DX, docs, optional template slices |
| **Later** | Agentic runtime + protocol projections (only after P0–P2 reduce load) |
| **Hold** | Explicit non-goals |

---

## Big picture (what we are protecting)

### Target shape (already mostly present)

```text
Host Astro + EmDash
  ├─ config: mikaPlugin()          → root export (JSON-safe)
  ├─ entrypoint: createMikaPlugin  → /server (live api)
  ├─ actions: createMikaActions    → /astro-actions
  ├─ pages: createMika / templates → /astro + copyable sources
  └─ projections: /agent /acp /admin /provider /stripe

Public wire contract
  └─ /types (+ aggregates | documents | operational)

Internal SSOT (not package-exported)
  └─ mikaOperationDefinitions → routes, stubs, actions, agent, HTTP init
```

Detail: [architecture-overhaul-verdict — Target architecture](./architecture-overhaul-verdict.md#target-architecture-already-mostly-present), [architecture-internal-vs-external-api — Layer map](./architecture-internal-vs-external-api.md#11-layer-map-as-implemented).

### Freeze surface (semver / stability rule)

Change only with intentional versioning. Internals may move freely behind these freezes:

| Freeze | Examples |
| ------ | -------- |
| Package subpaths | `.`, `/server`, `/client`, `/astro`, `/astro-actions`, `/agent`, `/acp`, `/admin`, `/provider`, `/stripe`, `/email`, `/react`, `/types*` |
| Wire language | `*DTO`, `MikaApiResult`, `MIKA_ERROR_CODES` (additive codes OK) |
| Operation names | `namespace.method` (e.g. `cart.add`, `checkout.start`) |
| Host injection | Single `MikaApi` composite + `createMikaBackendApi` / overrides |
| Descriptor boundary | Root = JSON-safe only; live `api` only via host entrypoint |

### Assumption board (compressed)

| Assumption | Status |
| ---------- | ------ |
| Multi-file endpoint tables force constant public API churn | **Mostly obsolete** (registry exists) |
| Package exports are chaotic | **False** |
| `MikaApi` must be split for hosts | **Size true, design false** — keep composite |
| Types/runtime drift systematically | **Partially true** — dual inputs + hand faces |
| Need tRPC / Effect / rewrite | **Reject** |
| Astro 7 / EmDash force redesign | **False** |
| Browser `/client` is fully client-safe | **Gap** — loads `operations` + `astro/zod` |
| Dual peer `astro ^6 \|\| ^7` is honest | **Weak** without dual CI |

Full board: [architecture-overhaul-verdict — Assumption board](./architecture-overhaul-verdict.md#assumption-board), [tavily-validation](./tavily-validation-ts-astro-emdash.md).

### Sources of truth (priority order)

| Registry | Owns | Derives |
| -------- | ---- | ------- |
| `mikaOperationDefinitions` | name, route, method, transport, public, agent meta, schema, action, call | routes, public routes, action defs, agent manifest, API method names, facade runtime |
| Hand interfaces (`MikaApi`, facade, `MikaActions`) | Hover/docs shape | **Must pin to registry** (still open) |
| `MIKA_ERROR_CODES` | Failure taxonomy | clients, ACP map allowlist |
| Document unions + `mikaStorageConfig` | Persistence shape | indexes, migrations discipline |
| Admin action registry | Dashboard/field actions | manifest + runner (`operationKey` must exist) |
| Provider capabilities | Feature gates | health, unsupported errors |

---

## Guardrails (policy — acknowledged 2026-07-09)

**Not engineering tasks.** Counting open checkboxes must ignore this section.

Detail: [typescript-internals — What is already strong](./typescript-internals-improvements.md#what-is-already-strong), [architecture-overhaul-verdict — What not to overhaul](./architecture-overhaul-verdict.md#what-not-to-overhaul), [architecture-internal — What NOT to overhaul](./architecture-internal-vs-external-api.md#53-what-not-to-overhaul).

### TypeScript / publish

- Keep `strict`, `exactOptionalPropertyTypes`, `erasableSyntaxOnly`, `verbatimModuleSyntax`, `noUncheckedIndexedAccess`, `noUncheckedSideEffectImports`.
- Keep ESM-only publish + `attw` / `publint` / `test/package-exports.ts` as release architecture (not optional polish).
- Keep DTO vs aggregate split; do not collapse public **DTOs** into Zod-inferred parse trees as the only API.
- Keep Astro Actions + `astro/zod` at form/json trust boundaries (no parallel bare-`zod` path forced on templates).

### External API / product shape

- Keep multi-entry `exports` + **root descriptor-only**; do not kitchen-sink root with `MikaApi` / runtime factories.
- Keep single host-injected **`MikaApi` composite**; modularize `backend/*` implementation, not required injectables.
- Keep browser **`createMikaClient` small** (catalog + stock only); do not expand to authenticated mutations.
- Do **not** publish raw `mikaOperationDefinitions` as public API (descriptors / manifests only).
- Keep agent + ACP as **projections** over semantic core; do not invent a parallel storefront API for agents.
- Keep EmDash **native** plugin path (not sandbox-only marketplace format) for secrets / cron / storage / webhooks.
- Keep host ownership of auth, OAuth, rate limits, tax/shipping, provider secrets.
- Keep aggregate-JSON + three Kysely tables (stock/ephemeral) storage model; research relational maps stay conceptual.
- Keep copyable templates (kit, not package-owned storefront theme).

---

## P0 — Contract correctness & drift locks

**Exit criteria:** Adding an operation without updating derived public faces fails typecheck; `/types` barrel is complete; browser client does not evaluate full operation IR + Zod; hosts can name the three trees from docs.

Sources: [architecture-overhaul-verdict P0](./architecture-overhaul-verdict.md#what-is-not-an-overhaul-do-these-instead), [external-api-surface P0](./external-api-surface.md#5-recommendations-ranked), [astro-v7-emdash-fitness P0](./astro-v7-emdash-fitness.md#4-overhaul-assessment), [architecture-internal Phase 0–1](./architecture-internal-vs-external-api.md#52-migration-phases-protect-external-api), [typescript-internals Stream A](./typescript-internals-improvements.md#stream-a--drift-armor-highest-roi), [tavily ladder](./tavily-validation-ts-astro-emdash.md#5-recommendation-ladder-evidence-backed).

### P0.1 Public type barrel

- [x] **Export missing public inputs on `/types`** (known gaps: `CheckoutCancelInput`, `CheckoutStatusInput`).  
  Files: `src/types/index.ts`, `src/api/types.ts`.  
  → [external-api-surface — Gaps](./external-api-surface.md#2-public-type-surface) · **U02** `31c00b3`
- [x] **Barrel completeness check** — every operation-facing type in `api/types.ts` used by public ops is re-exported (or intentionally private and tested as such).  
  → [external-api-surface — P0](./external-api-surface.md#5-recommendations-ranked) · **U02** `test/types-barrel-completeness.ts`

### P0.2 Registry ↔ public faces (bidirectional)

- [x] **`MikaApi` satisfies / is satisfied by** shapes derived from `mikaOperationDefinitions` / `mikaOperationApiMethodNames` (method presence; ctx rules as far as practical).  
  Files: `src/api/server.ts`, `src/api/operations.ts`.  
  → [typescript-internals — Registry hotspot](./typescript-internals-improvements.md#2-registry-is-not-yet-the-only-public-surface), [architecture-internal Phase 1](./architecture-internal-vs-external-api.md#52-migration-phases-protect-external-api) · **U03** `4fba413`
- [x] **`MikaOperationFacade` pinned** the same way (hand interface for hover; runtime already from facade spec).  
  File: `src/api/operation-facade.ts`.  
  → [external-api-surface — Residual drift](./external-api-surface.md#4-route--client--action-drift) · **U04** `91633c5`
- [x] **`MikaActions` bidirectional** with action definitions / tree (beyond one-way tree coverage).  
  Files: `src/astro-actions.ts`, `src/api/action-tree.ts`.  
  → [typescript-internals — Registry hotspot](./typescript-internals-improvements.md#2-registry-is-not-yet-the-only-public-surface) · **U05** `fd9fb8b`

### P0.3 Client import purity

- [x] **Extract Zod-free route path map** (and public route names) into a data-only module; `routes.ts` + `/client` consume it; schemas/call bindings stay in `operations.ts`.  
  Files: `src/api/routes.ts`, `src/api/operations.ts`, `src/api/client.ts`.  
  **Verify:** `dist/api/client.mjs` no longer pulls full `operations-*.mjs` + `astro/zod`.  
  → [astro-v7-emdash-fitness — Client gap](./astro-v7-emdash-fitness.md#3-layering-quality), [external-api-surface — Client purity](./external-api-surface.md#4-route--client--action-drift), [tavily — client purity](./tavily-validation-ts-astro-emdash.md#4-cross-cutting-synthesis) · **U06** `f5277e5`

### P0.4 Host mental model + gates

- [x] **Document the three host faces** in README + template index:  
  (1) Backend: `MikaApi` + `createMikaBackendApi`  
  (2) In-process: `createMika` / Astro Actions  
  (3) HTTP: `createMikaClient` (public) / `createMikaServerClient` (full)  
  → [external-api-surface — Three trees](./external-api-surface.md#3-mikaapi--backend-composition) · **U07** `fd6305b`
- [x] **Ensure PR CI runs** `typecheck`, `templates:check`, and `types:check` (not only local `prepublishOnly`).  
  → [typescript-internals Stream A](./typescript-internals-improvements.md#stream-a--drift-armor-highest-roi) · **U01** `9928369`
- [x] **Keep publish gates green as architecture:** `package-exports`, schema-contracts, attw, publint.  
  → [tavily — tooling recipe](./tavily-validation-ts-astro-emdash.md#1-typescript-library-external-api--validated-practices) · verified U00 baseline + each unit

---

## P1 — Dual truth, peers, host wiring, third registries

**Exit criteria:** Inputs have one primary source (or every dual is dual-pinned); Astro peer claim is honest; EmDash storage typing does not rely on `as unknown as`; admin keys cannot dangle; maintenance/outbox host wiring is obvious.

Sources: [typescript-internals Streams A/C](./typescript-internals-improvements.md), [external-api-surface P1](./external-api-surface.md#5-recommendations-ranked), [astro-v7-emdash-fitness P1](./astro-v7-emdash-fitness.md#4-overhaul-assessment), [architecture-internal Phase 1](./architecture-internal-vs-external-api.md#52-migration-phases-protect-external-api).

### P1.1 Input schemas vs hand interfaces

- [x] **Prefer `z.infer<typeof …Schema>` for public `*Input` types** after exact-optional transforms; keep hand types only where intentionally divergent.  
  Files: `src/api/validation.ts`, `src/api/types.ts`.  
  → [typescript-internals — Dual input truth](./typescript-internals-improvements.md#1-dual-input-truth-interfaces--zod), [external-api-surface — Dual input](./external-api-surface.md#2-public-type-surface) · **U29 · `77b06bb` (validation SoT + types re-export)**
- [x] **Expand `test/schema-contracts.ts`** to every public input schema ↔ type pin (including intentional omissions e.g. server-only `consumeToken`).   · **U11 · pre-existing dual-pin + campaign (schema-contracts)**
  → [typescript-internals — Dual input](./typescript-internals-improvements.md#1-dual-input-truth-interfaces--zod)
- [x] **Document intentional schema/type divergences** next to the schema (not only in tests).   · **U09–U15 `5bf9010` + validation comments / schema-contracts**
  → [typescript-internals Stream C](./typescript-internals-improvements.md#stream-c--input-schema-primacy)
- [x] **Revisit `exactOptionalObject` cast surface** — **DEFERRED** (F3.1, 2026-07-09): keep cast until Astro/Zod offers cleaner exact-optional path.  
  → [ROADMAP-followup F3.1](./ROADMAP-followup.md#card-f31--exactoptionalobject-cast-surface) · [typescript-internals — Dual input](./typescript-internals-improvements.md#1-dual-input-truth-interfaces--zod)

### P1.2 Astro / EmDash host honesty

- [x] **Astro 6 + 7 CI matrix** *or* document **Astro 7-only** and narrow peer to `^7`.   · **U09 · `5bf9010` (narrow peer to `^7`, Astro 7-only docs)**
  → [astro-v7-emdash-fitness — Dual peer](./astro-v7-emdash-fitness.md#1-astro-integration), [tavily — dual support](./tavily-validation-ts-astro-emdash.md#2-astro-v7--validated-practices-for-library-authors)
- [x] **Document that `astro` peer is required for the schema stack** even for “backend-only” `/server` hosts (validation via `astro/zod`).   · **U09 · `5bf9010` README peer table**
  → [external-api-surface — peer hygiene](./external-api-surface.md#1-package-exports-surface)
- [x] **Type `mikaStorageConfig` against real EmDash `PluginStorageConfig`** (dual descriptor/runtime configs if needed; remove `as unknown as` where possible).  
  Files: `src/storage/collections.ts`, `src/plugin.ts`.  
  → [astro-v7-emdash-fitness — Storage](./astro-v7-emdash-fitness.md#2-emdash-plugin-surface) · **U29 · `77b06bb` `toPluginStorageConfig` / `toDescriptorStorageConfig` (no unknown casts)**
- [x] **Document maintenance wiring** — default cron releases stock; outbox / account-delete / etc. need host-injected `maintenance.repositories` / `emailOutboxRunner`.   · **U09–U15 · `5bf9010` README maintenance section**
  → [astro-v7-emdash-fitness — Lifecycle](./astro-v7-emdash-fitness.md#2-emdash-plugin-surface), [tavily — maintenance DX](./tavily-validation-ts-astro-emdash.md#5-recommendation-ladder-evidence-backed)
- [x] **Extend `templates:check` fixture with `emdash()`** — **OUT OF SCOPE** for follow-up (user skip); plain Astro fixture retained.  
  → [ROADMAP-followup Scope](./ROADMAP-followup.md#explicitly-out-of-scope-do-not-schedule-here)

### P1.3 Third registries and `/server` discoverability

- [x] **Admin `operationKey` existence test** — every key in admin runtime map exists on `mikaOperationDefinitions`.   · **U08 · `76e2ef4`**
  → [external-api-surface — Residual drift](./external-api-surface.md#4-route--client--action-drift), [architecture-internal — registries](./architecture-internal-vs-external-api.md#51-target-architecture)
- [x] **Optional additive `/server` sub-discoverability** (`ports`, `maintenance`, `email`) **without removing** current `/server` re-exports.   · **U15 · `5bf9010`**
  → [external-api-surface — P1](./external-api-surface.md#5-recommendations-ranked), [architecture-overhaul-verdict — soft-break path](./architecture-overhaul-verdict.md#migration-phases-that-protect-the-external-api)

---

## P2 — Maintainability, nominal safety, additive errors

**Exit criteria:** No single adapter/service megafile without a split plan; money-path id mixups fail at compile time where branded; new error codes land additively; ACP/checkout reviewable.

Sources: [architecture-internal Phases 2–4](./architecture-internal-vs-external-api.md#52-migration-phases-protect-external-api), [typescript-internals Streams B/D](./typescript-internals-improvements.md), [architecture-overhaul-verdict P2](./architecture-overhaul-verdict.md#what-is-not-an-overhaul-do-these-instead).

### P2.1 Megafile splits (preserve public barrels)

| Module | Split target | Public path unchanged |
| ------ | ------------ | --------------------- |
| `src/api/operations.ts` | define / definitions / collect | internal only |
| `src/acp.ts` | feed / session / handlers / mappers / crypto | `@bnomei/emdash-mika/acp` |
| `src/api/backend/checkout.ts` | start / status / cancel / binding / provider | via `MikaApi` only |
| `src/api/backend/webhooks/payment.ts` | event-kind modules | internal |
| `src/stripe.ts` | checkout / webhook / portal / delegated | `@bnomei/emdash-mika/stripe` |

- [x] **Split `operations.ts`** into define / definitions / collect without package-export changes.   · **U16 · `c614399`**
  → [typescript-internals — overload wall](./typescript-internals-improvements.md#3-definemikaoperation-overload-wall--any-implementation), [architecture-internal Phase 2](./architecture-internal-vs-external-api.md#52-migration-phases-protect-external-api)
- [x] **Split `acp.ts`** along session / handlers / mappers / schemas.   · **U17 · `c4e57b6`**
  → [typescript-internals — Megafiles](./typescript-internals-improvements.md#6-megafiles), [architecture-internal Phase 2](./architecture-internal-vs-external-api.md#52-migration-phases-protect-external-api)
- [x] **Split `checkout.ts`** (start / status / cancel / binding / provider handoff).   · **U18 · `c4e57b6`**
  → same
- [x] **Split `webhooks/payment.ts`** when next lifecycle change would otherwise force a full-file review.   · **U19 · `c4e57b6`**
  → [architecture-internal — hotspots](./architecture-internal-vs-external-api.md#31-file-size-hotspots-loc-src)
- [x] **Split `stripe.ts`** (checkout adapter vs webhook vs portal) if it continues to grow.   · **U20 · `c4e57b6`**
  → [typescript-internals — Megafiles](./typescript-internals-improvements.md#6-megafiles)
- [x] **Contain dynamic API dispatch casts** to one function (or require explicit typed `call` on money-moving ops) + lint against new ad-hoc `as unknown as MikaApi`.   · **U21 · `c4e57b6` (localized + comment)**
  → [typescript-internals — Dynamic dispatch](./typescript-internals-improvements.md#10-dynamic-api-dispatch)

### P2.2 Entity id brands (money paths first)

- [x] **Introduce entity brands** (`SellableId`, `PriceId`, `CartId`, `CheckoutSessionId`, `OrderId`, …) with constructors + Zod mint helpers.   · **U23 · `c614399` constructors + types (Zod mint follow-up)**
  Files: `src/types/primitives.ts`, `src/api/validation.ts`.  
  → [typescript-internals — Monotype MikaId](./typescript-internals-improvements.md#4-monotype-mikaid), [architecture-internal Phase 4](./architecture-internal-vs-external-api.md#52-migration-phases-protect-external-api)
- [x] **Migrate cart → checkout → order → webhook → ACP session boundaries** first; leave low-risk metadata as `MikaId` until needed.   · **F1.2**  
  → same · [ROADMAP-followup F1.2](./ROADMAP-followup.md)
- [x] **Align JSON action inputs with brands / `z.infer`** (forms stay string → parse at boundary).   · **F1.3**  
  File: `src/astro-actions.ts`.  
  → [typescript-internals — Action clients widen](./typescript-internals-improvements.md#5-public-action-clients-widen-brands-to-string)

### P2.3 Error taxonomy (additive only)

- [x] **Add specific error codes** where clients already need to branch (e.g. idempotency mismatch, webhook deferred, stock undercut) — **do not** remove existing `CONFLICT` / `NOT_FOUND` without a major.   · **U22 · `c614399`**
  → [architecture-internal — Error model](./architecture-internal-vs-external-api.md#33-error-model-consistency)
- [x] **ACP error map allowlist** — explicit Mika → ACP mapping; stop auto-lowercasing unknown codes forever.   · **U22 · `c614399`**
  → [architecture-internal Phase 3](./architecture-internal-vs-external-api.md#52-migration-phases-protect-external-api)
- [x] **Template/docs guidance:** branch on `error.code`, never `error.message` for control flow.   · **U07/U27 · `fd6305b` / `c4e57b6`**
  → [architecture-internal — Success metrics](./architecture-internal-vs-external-api.md#54-success-metrics)

### P2.4 Exhaustiveness and storage typing

- [x] **Expand `assertNever` use** on webhook kinds, ACP status machines, stock policy branches.   · **F2.1**  
  → [typescript-internals — Exhaustiveness](./typescript-internals-improvements.md#9-exhaustiveness)
- [x] **Prefer `Extract<Union, { type: T }>` repository helpers**; reduce `as unknown as` in storage kit.   · **F2.2**  
  → [typescript-internals — Storage / Kysely](./typescript-internals-improvements.md#8-storage--kysely-layer)
- [x] **Land typed index keys** (`MikaIndex<TDocument>`) if not fully done.   · **pre-existing `MikaIndex<TDocument>` in collections.ts**
  → [type-surface-simplification — Storage](../commerce-research/type-surface-simplification.md)

---

## P3 — Consumer DX and host docs

Sources: [typescript-internals Stream E](./typescript-internals-improvements.md#stream-e--consumer-dx), [external-api-surface P2 polish](./external-api-surface.md#5-recommendations-ranked), [astro-v7-emdash-fitness P3](./astro-v7-emdash-fitness.md#4-overhaul-assessment), [tavily declarationMap](./tavily-validation-ts-astro-emdash.md#1-typescript-library-external-api--validated-practices).

- [x] **Enable `declarationMap`** in the published DTS pipeline.   · **U26 · `c614399`**
  → [typescript-internals — Package polish](./typescript-internals-improvements.md#7-package--consumer-ts-polish)
- [x] **Pilot `isolatedDeclarations`** — **DEFERRED / abandoned** (F3.2, 2026-07-09): types-only split tsconfig not worth cost while validation/ops stay inference-heavy.  
  → [ROADMAP-followup F3.2](./ROADMAP-followup.md)
- [x] **Consider `lib` / `target` bump** — shipped **ES2024** (F3.3).  
  → same
- [x] **Document Astro support matrix** (developed/tested on 7; peers still `^6 || ^7` until P1.2 resolves) in README / template README.   · **U09 · `5bf9010` peer table (Astro 7-only)**
  → [typescript-internals — Astro 7 notes](./typescript-internals-improvements.md#astro-7-notes-llm-knowledge-gap)
- [x] **Document uncacheable commerce routes** (cart / account / checkout) under Astro 7 route caching.   · **U27 · `c4e57b6` template README**
  → same
- [x] **Ban reserved host filenames in examples** (e.g. do not use `src/fetch.ts` for app code under advanced routing).   · **U27 · `c4e57b6` template README**
  → same, [tavily / Astro upgrade — reserved fetch](./tavily-validation-ts-astro-emdash.md#2-astro-v7--validated-practices-for-library-authors)
- [x] **Note Astro 7 template QA:** Rust compiler stricter HTML; `compressHTML: 'jsx'` whitespace between inline elements.   · **U27 · `c4e57b6` template README**
  → [astro-v7-emdash-fitness — Astro 7 host-facing breaks](./astro-v7-emdash-fitness.md#1-astro-integration)
- [x] **Optional unstyled template slice** without Kumo (sharper “kit not theme” signal).   · **F3.4**  
  → [astro-v7-emdash-fitness — P3](./astro-v7-emdash-fitness.md#4-overhaul-assessment)
- [x] **Optional `./types/primitives` subpath** (additive).   · **U28 · `2c03dcb`** + **F0.4** package-exports pin  
  → [external-api-surface — P2](./external-api-surface.md#5-recommendations-ranked)
- [x] **Re-audit or mark historical** `docs/commerce-research/use-case-surface-audit.md` rows that are stale post-implementation.   · **F3.5**  
  → [architecture-internal — Research debt](./architecture-internal-vs-external-api.md#4-existing-research-debt)

---

## Later — agentic runtime & protocol projections (out of scope for follow-up)

**Not open cleanup tasks.** Explicitly excluded from [ROADMAP-followup](./ROADMAP-followup.md). Revisit only with a new campaign after P0–P2 load stays low. Do **not** bake protocol field names into core DTOs.

Sources: [architecture-internal Phases 5–6](./architecture-internal-vs-external-api.md#52-migration-phases-protect-external-api), [docs/agentic/README.md](../agentic/README.md).

### Later.1 Agentic runtime (host-optional ports)

- Durable `MikaActionRun` / approval stores **behind ports** (ephemeral or ops) — not required core path.
- Proof verification hooks as **host-injected**, not OAuth-in-core.
- OpenAPI `x-mika-agent` generator as **dev tool or docs**, not runtime dependency.

### Later.2 Protocol projections (fixtures first)

- UCP / MCP / Arazzo / AP2 / MPP / x402 as **host examples or optional entrypoints** only after ACP fixture set is the golden reference.
- **Permanent rule:** never move protocol field names into `CartDTO` / `CheckoutSessionDTO`.

---

## Hold — explicit non-goals (policy — acknowledged 2026-07-09)

**Not engineering tasks.** Detail: [typescript-internals — Rejected](./typescript-internals-improvements.md#rejected-for-this-project), [architecture-overhaul-verdict — What not to overhaul](./architecture-overhaul-verdict.md#what-not-to-overhaul), [tavily — does not demand overhaul](./tavily-validation-ts-astro-emdash.md#4-cross-cutting-synthesis).

- Do not adopt tRPC or Effect as the core API shape.
- Do not make Zod the sole source of truth for public **DTOs** (inputs may use `z.infer`).
- Do not add dual CJS/ESM publishing without host demand.
- Do not disable `exactOptionalPropertyTypes` to ease Zod friction.
- Do not rewrite as sandbox-only EmDash marketplace plugin.
- Do not replace Astro Actions with a custom RPC framework.
- Do not make templates package-owned routes / a locked storefront framework.
- Do not expand browser `/client` to full mutation surface.
- Do not split required `MikaApi` injectables without a major-version multi-package plan.
- Do not rewrite working stock CAS / checkout claim logic “for purity” (split files only).
- Do not make private plugin routes public for agents by default.
- Do not force internal folder renames (`domain/`, `application/`) as a public API project — optional later, internal only.

---

## Migration phases → roadmap map

Aligns [architecture-internal phases](./architecture-internal-vs-external-api.md#52-migration-phases-protect-external-api) with checklist sections above.

| Phase | Theme | Roadmap section | Break risk |
| ----- | ----- | --------------- | ---------- |
| **0** | Freeze contracts + CI locks | Guardrails + P0.2 + P0.4 | None |
| **1** | Finish registry derivation + input primary source | P0.1–P0.3 + P1.1 | None (soft if optionality changes) |
| **2** | Split mega-modules behind barrels | P2.1 | None if exports unchanged |
| **3** | Additive error codes + ACP allowlist | P2.3 | Additive only |
| **4** | Entity brands at money edges | P2.2 | Soft for typed hosts |
| **5** | Agentic runtime ports | Later.1 | Additive / optional |
| **6** | Protocol projections + fixtures | Later.2 | Host-owned |

Cross-cutting (not a single phase): P0.3 client purity, P1.2 peers/storage, P1.3 admin/`/server`, P3 DX.

---

## Suggested ship order (capacity-limited)

| Slice | Items | Outcome |
| ----- | ----- | ------- |
| **1 — Drift locks** | P0.2 + P0.4 CI gates | Adding an op cannot silently miss `MikaApi` / facade / `MikaActions` |
| **2 — Barrel + purity** | P0.1 + P0.3 | Complete `/types`; browser client graph is clean |
| **3 — Host honesty** | P0.4 docs + P1.2 + P1.3 admin test | Peers/storage/maintenance/admin cannot lie |
| **4 — Input truth** | P1.1 | One primary source for inputs; schema-contracts complete |
| **5 — Size** | P2.1 when next feature forces megafile edit | Reviewable modules; same public barrels |
| **6 — Safety** | P2.2 money brands + P2.3 additive codes | Compile-time id safety; branchable errors |
| **7 — Polish** | P3 as capacity allows | declarationMap, Astro matrix docs, template QA |
| **Hold off** | Later.1–2 | Until slices 1–5 reduce cognitive load |

---

## Success metrics

From [architecture-internal — Success metrics](./architecture-internal-vs-external-api.md#54-success-metrics) + external-API gates.

1. **Add-operation cost:** ≤ 1 registry entry + optional DTO/schema; CI catches missing public faces.  
2. **Client purity:** `import` of `/client` does not evaluate full operations IR or `astro/zod`.  
3. **Barrel completeness:** hosts can import every public operation input from `/types`.  
4. **Megafile count:** no single adapter/service file > ~800 LOC without a split plan.  
5. **Error branchability:** storefront/agent code never string-matches `error.message` for control flow.  
6. **ACP isolation:** core DTO PR does not require ACP wire changes (and vice versa) except mapper layer.  
7. **Export stability:** `test/package-exports.ts` + attw + publint remain green; no surprise public path removals.  
8. **Peer honesty:** dual-major peers have dual CI, or peer range matches tested majors only.  
9. **Research docs:** live vs historical clearly labeled; use-case audit re-run or archived.

---

## Breaking vs non-breaking (decision aid)

| Path | Contents |
| ---- | -------- |
| **Non-breaking (default)** | Type exports, drift-guard types, docs, Zod-free route map, optional new subpaths that re-export, schema-contracts, admin tests, megafile splits behind barrels, additive error codes, declarationMap |
| **Soft-break (major or long deprecation)** | Drop mass repository input re-exports from root `/server`; require `./server/ports`; Zod-inferred inputs changing optionality; entity brands for typed hosts |
| **Hard-break (avoid)** | Split required `MikaApi` injectables; tRPC; expand browser client mutations; remove operation registry; sandbox-only plugin rewrite; remove public subpaths without migration |

---

## Weave maintenance (for later agents)

1. **Single source for tasks:** update **this file** when a report adds work; do not leave orphan checklists only in reports.  
2. **Report index:** set status to **Woven** when all actionables appear here; **Evidence only** for pure research.  
3. **Dedup rule:** if two reports recommend the same change, **one checkbox** with dual links — never two tasks.  
4. **Commit size:** one checkbox ≈ one execution unit (see [EXECUTION.md](./EXECUTION.md)); no PR required — implement → Grok review → fix all findings → commit.  
5. **Guardrails:** do not demote without a decision recorded in the justifying report.  
6. **Phases:** when completing a phase exit criterion, tick the matching P-tier items and note the date under **Last focused update**.  
7. **README:** keep [docs/qa/README.md](./README.md) pointing at this roadmap as the actionable index.
