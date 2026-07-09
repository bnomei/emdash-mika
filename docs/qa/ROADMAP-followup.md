# ROADMAP follow-up — next cleanup cards

**Status:** planning deck for the **next** cleanup campaign  
**Parent:** [ROADMAP.md](./ROADMAP.md) (P0–P3 hygiene largely shipped on `review-fixes`)  
**Created:** 2026-07-09  
**Basis:** manual ROADMAP audit + commit reviews under [reviews/](./reviews/)

Use this file as the **only task list** for the next pass. Do not re-open completed P0 drift armor, megafile first-level splits, or peer-honesty work unless a card says so.

---

## Scope

### In scope (this deck)

Everything still open or only **partially** done after the hygiene campaign, **except** the exclusions below.

### Explicitly out of scope (do not schedule here)

| Excluded | Why |
| -------- | --- |
| **`templates:check` + real `emdash()` fixture** | User-directed skip for this follow-up. Keep existing plain Astro template fixture. |
| **Later.1–2 agentic** (ActionRun stores, proof hooks, OpenAPI `x-mika-agent`, UCP/MCP/AP2/MPP/x402 host examples) | User-directed skip. Protocol projections stay host-owned later. |
| **Guardrails / Hold non-goals** | Policy, not cleanup tasks. See [ROADMAP — Guardrails](./ROADMAP.md#guardrails-non-action--do-not-undo) and [Hold](./ROADMAP.md#hold--explicit-non-goals). |
| **Full architectural redesign** | Already rejected; see [architecture-overhaul-verdict.md](./architecture-overhaul-verdict.md). |

### Permanent rule (still open on parent ROADMAP, not a “build” card)

- **Never move protocol field names into `CartDTO` / `CheckoutSessionDTO`.**  
  Reaffirm when touching agent/ACP mappers; do not schedule a “implement UCP fields on DTOs” task.

---

## How to use these cards

1. **One card ≈ one commit** (or a short main + review-fix pair).  
2. Per card: implement → verify suite → Grok local review → **fix all findings** → re-verify → commit.  
3. Prefer order **Wave F0 → F1 → F2 → F3**. Do not start brand migration (F1) until error emit (F0) is done if both touch the same money paths.  
4. If blocked, mark the card **Blocked** with reason; do not silently skip acceptance criteria.  
5. After a card ships, tick its checkbox here **and** the matching parent ROADMAP item (if any).  
6. **Do not** reintroduce: `routes → operations` (client purity), dual Astro major peers without CI, auto-lowercase ACP error map, one-way registry pins.

### Suggested verify suites

| Suite | Commands |
| ----- | -------- |
| **Fast** | `npm run typecheck && npm test` |
| **Full** | `npm run check && npm run typecheck && npm test && npm run templates:check && npm run pack:check && npm run types:check` |
| **Client purity** (if touching routes/client) | After pack: `dist/api/client.mjs` must not pull `operations-*` or `astro/zod` |

---

## Campaign context (do not re-do)

Already shipped (see parent ROADMAP + git log on `review-fixes`): registry pins, `/types` barrel, client route-paths purity, Astro `^7` peer, `/server/*` subpaths, operations/acp/checkout/payment/stripe splits, `z.infer` Input SoT, EmDash storage converters, declarationMap, entity brand **constructors**, additive **code constants** + ACP allowlist (map), three host faces docs.

**Known residual megafiles (split later only if a card requires):**

| File | ~LOC | Note |
| ---- | ---- | ---- |
| `src/acp/handlers.ts` | ~1177 | Further split only with CAS/idempotency care |
| `src/api/backend/checkout/start.ts` | ~995 | Same |
| `src/api/operation-definitions.ts` | ~760 | Registry body; leave unless editing many ops |

---

## Wave F0 — Honesty & small gates (do first)

Cheap, high-signal; reduces lying checkmarks and publish/CI drift.

---

### Card F0.1 — `prepublishOnly` includes `templates:check`

| | |
| -- | -- |
| **Parent** | P0.4 partial (CI has it; prepublish does not) |
| **Priority** | P0-small |
| **Break risk** | None (stricter publish) |
| **Depends on** | — |
| **Files** | `package.json` (`prepublishOnly`) |

**Why**  
Review U01: CI runs `templates:check`; `prepublishOnly` still skips it. Publish can ship broken templates.

**Current state**  
```text
prepublishOnly: check && typecheck && test && pack:check && types:check
# missing: templates:check
```

**Do**  
1. Insert `npm run templates:check` after `test` (same order as CI).  
2. Confirm script still points at `test/fixtures/astro-template-check`.

**Acceptance**  
- [ ] `prepublishOnly` and CI both include `templates:check` in the same relative order.  
- [ ] `npm run templates:check` alone still green.

**Do not**  
- Add `emdash()` to the fixture (excluded from this deck).

**Verify**  
Fast + `templates:check`.

---

### Card F0.2 — Emit additive error codes at real sites

| | |
| -- | -- |
| **Parent** | P2.3 (codes exist; emission still mostly `CONFLICT`) |
| **Priority** | P1 |
| **Break risk** | Soft for clients that only branch on `CONFLICT` for those cases (document codes; keep HTTP status) |
| **Depends on** | — (do before brand migration if touching same files) |
| **Files** | `src/api/backend/errors.ts`, `src/api/backend/cart.ts`, stock paths, webhook ingest/payment, checkout start, `src/api/types.ts` (codes already listed), ACP map already updated |

**Why**  
`IDEMPOTENCY_MISMATCH`, `WEBHOOK_DEFERRED`, `STOCK_CONFLICT` are on `MIKA_ERROR_CODES` and ACP-mapped, but call sites still return `code: "CONFLICT"`. Codes without emission are theater.

**Current state (examples)**  
- Checkout idempotency reuse → still `CONFLICT` (`errors.ts`).  
- Cart CAS / lock → still `CONFLICT` (`cart.ts`).  
- Stock undercut / CAS → still `CONFLICT` (stock repos / cart).  
- Webhook deferred paths → verify and switch if they currently use `CONFLICT` or generic failures.

**Do**  
1. Inventory every `apiFailure(..., "CONFLICT", ...)` (and 409 builders).  
2. Classify: true concurrency CAS vs idempotency payload mismatch vs deferred webhook vs stock race.  
3. Emit:  
   - `IDEMPOTENCY_MISMATCH` — key reused with different input (checkout + any other).  
   - `STOCK_CONFLICT` — stock CAS undercut / concurrent reservation failure.  
   - `WEBHOOK_DEFERRED` — accepted-but-deferred webhook processing (if product-correct).  
   - Leave genuine generic CAS as `CONFLICT` where no better code applies.  
4. Add/adjust tests that assert **code** (not only status 409).  
5. Confirm ACP map: `CONFLICT` → `conflict`, `IDEMPOTENCY_MISMATCH` → `request_not_idempotent`, `STOCK_CONFLICT` → `out_of_stock` (already intended after review-followup).

**Acceptance**  
- [ ] No remaining emit of `CONFLICT` for pure idempotency-payload mismatch.  
- [ ] At least one stock path emits `STOCK_CONFLICT` where CAS undercuts.  
- [ ] Tests cover new codes.  
- [ ] Existing clients that only check status 409 still work (status unchanged unless intentionally changed).

**Do not**  
- Remove `CONFLICT` from the enum.  
- Auto-map every 409 to a new code.

**Verify**  
Full (backend tests exercise cart/checkout heavily).

---

### Card F0.3 — Admin operationKey test: remove tautology

| | |
| -- | -- |
| **Parent** | P1.3 / review U08 |
| **Priority** | P3-small |
| **Break risk** | None |
| **Files** | `test/admin-operation-keys.test.ts`, possibly `src/admin.ts` |

**Why**  
Second test only loops keys of `mikaAdminActionRuntimeDefinitions` and asserts defined — tautology.

**Do**  
1. Assert runtime map keys **equal** the admin action id union / `mikaAdminActionDefinitions` keys (sorted set equality).  
2. Keep the first test: every `operationKey` ∈ `mikaOperationDefinitions`.  
3. Prefer `Object.hasOwn` over `in` for registry membership if still using `in`.

**Acceptance**  
- [ ] Missing admin id without runtime entry fails the test.  
- [ ] Extra runtime key not in admin definitions fails (or is explicitly allowlisted with comment).

**Verify**  
Fast.

---

### Card F0.4 — Package-export pin for `./types/primitives`

| | |
| -- | -- |
| **Parent** | P3 / review U28 |
| **Priority** | P3-small |
| **Break risk** | None |
| **Files** | `test/package-exports.ts`, optionally README export list tests in `test/index.test.ts` |

**Why**  
Subpath exists; package-exports samples other type subpaths but not primitives.

**Do**  
1. Import a few symbols from `@bnomei/emdash-mika/types/primitives` in `package-exports.ts` (e.g. `SellableId`, `createSellableId`, `MikaId`).  
2. Ensure export-map test still lists `./types/primitives`.  
3. Optional: README already mentions it; keep consistent.

**Acceptance**  
- [ ] `types:check` / package-exports fails if subpath breaks.  
- [ ] Sampled symbols match public surface (not internal-only).

**Verify**  
`npm run types:check` + pack if needed.

---

### Card F0.5 — `/types` barrel completeness: harden pin

| | |
| -- | -- |
| **Parent** | P0.1 / review U02 |
| **Priority** | P2-small |
| **Break risk** | None |
| **Files** | `test/types-barrel-completeness.ts`, `src/types/index.ts` |

**Why**  
Hand list of 39 inputs: new `*Input` omitted from the list still typechecks. Completeness uses source paths, not package resolution for all names.

**Do**  
1. Prefer generating the key list from a single array used for both directions, **or** derive keys from validation’s exported `*Input` type names if feasible.  
2. Add a comment: “when adding a public `*Input`, update this file + types barrel.”  
3. Optional: one package-path import sample for a random Input (not only source paths).

**Acceptance**  
- [ ] Adding a new exported Input type without listing it either fails automatically or is impossible by construction.  
- [ ] Existing 39+ inputs still pin equal to `api/types` re-exports.

**Verify**  
Fast + `tsc -p test/tsconfig.json`.

---

## Wave F1 — Entity brands (money paths)

Highest type-safety ROI still unfinished. Soft-break for typed hosts that treated all ids as interchangeable `MikaId`.

---

### Card F1.1 — Real brands + Zod mint helpers

| | |
| -- | -- |
| **Parent** | P2.2 introduce brands (constructors only today) |
| **Priority** | P1 |
| **Break risk** | Soft if brands stop being assignable from bare `MikaId` |
| **Depends on** | F0.2 preferred (less churn in same files) |
| **Files** | `src/types/primitives.ts`, `src/api/validation.ts`, `src/types/index.ts`, `src/types/primitives-entry.ts` |

**Why**  
Current brands are `MikaId & { __mikaEntity?: "…" }` — optional phantom field; plain `MikaId` still assignable. No Zod mint via `createSellableId` etc.

**Do**  
1. Decide brand strategy (document in card commit body):  
   - **Recommended:** unique-symbol brands incompatible with each other; `createX` / `asX` only at boundaries; keep `MikaId` as opaque generic or deprecate gradual.  
   - **Avoid:** optional `__mikaEntity?` that does not prevent mixups.  
2. Implement `createSellableId`, `createPriceId`, `createCartId`, `createCheckoutSessionId`, `createOrderId` with validation parity to `createMikaId`.  
3. Add Zod helpers: `sellableIdSchema`, `cartIdSchema`, … (via `brandedStringSchema(createSellableId, …)` pattern).  
4. Export from `/types` and `/types/primitives`.  
5. Unit tests for cross-assign failure (`SellableId` ↛ `CartId` at compile time — use `expectTypeOf` or a types-only assert file).

**Acceptance**  
- [ ] `SellableId` is not assignable to `CartId` (and vice versa) under `strict`.  
- [ ] Schemas mint branded values, not bare strings.  
- [ ] Public exports updated.

**Do not**  
- Migrate all call sites in this card (that is F1.2).  
- Brand every foreign key in metadata blobs.

**Verify**  
Fast + types package exports.

---

### Card F1.2 — Migrate money-path fields to entity brands

| | |
| -- | -- |
| **Parent** | P2.2 migrate cart → checkout → order → webhook → ACP |
| **Priority** | P1 |
| **Break risk** | Soft for typed hosts |
| **Depends on** | **F1.1** |
| **Files** | DTOs/inputs (`src/api/types.ts` / validation), `src/api/backend/cart.ts`, `checkout/*`, stock, webhooks, `src/model/builders.ts`, ACP session/mappers/handlers, tests |

**Why**  
Constructors alone do not stop `refund(orderId: cart.id)`.

**Do (order matters)**  
1. **Cart:** `cartId`, line ids if separate, `sellableId` / `priceId` on add/update DTOs.  
2. **Checkout:** session id, binding ids, start/status/cancel inputs.  
3. **Order / refund / cancel:** `orderId`.  
4. **Stock:** sellable/stock item ids on adjust/reserve paths.  
5. **Webhook / payment:** order/checkout correlation fields.  
6. **ACP:** session record fields + mappers (keep ACP **wire** strings; brand only after parse).  
7. Leave low-risk metadata / provider external ids as `string` or `MikaId` until needed.

**Acceptance**  
- [ ] Money-path public Inputs/DTOs use entity brands.  
- [ ] Backend money functions take branded params at internal boundaries.  
- [ ] Wire/ACP still parse `string` → brand at edge.  
- [ ] Full test suite green; no silent `as Brand` sprinkled outside mint helpers.

**Do not**  
- Brand protocol wire JSON field types as brands without parse.  
- One giant PR mixing behavior changes.

**Verify**  
Full.

---

### Card F1.3 — JSON action clients use branded / inferred inputs

| | |
| -- | -- |
| **Parent** | P2.2 align JSON actions |
| **Priority** | P2 |
| **Break risk** | Soft for typed action callers |
| **Depends on** | **F1.1–F1.2** |
| **Files** | `src/astro-actions.ts`, `src/api/action-tree.ts` / operations action schemas |

**Why**  
Hand `MikaActions` still widens some JSON clients to `string` (e.g. sellableId/checkoutId).

**Do**  
1. Derive JSON action input types from the same Zod schemas / brands as API inputs.  
2. Keep **form** accepts as `FormData` / string transport → parse in schema.  
3. Ensure `MikaActions` interface stays pinned to tree (bidirectional assert must remain).

**Acceptance**  
- [ ] JSON action input types match operation inputs for ids.  
- [ ] Form actions still accept form posts.  
- [ ] Bidirectional `MikaActions` pin still green.

**Verify**  
Full + `templates:check`.

---

## Wave F2 — Maintainability & exhaustiveness

---

### Card F2.1 — Expand `assertNever` on status machines

| | |
| -- | -- |
| **Parent** | P2.4 |
| **Priority** | P2 |
| **Break risk** | None (compile failures on new union members — good) |
| **Files** | webhook payment modules, ACP handlers/status, stock policy branches, `src/api/backend/shared.ts` (`assertNever`) |

**Why**  
`assertNever` used mainly in fulfillment; other switches risk silent fallthrough.

**Do**  
1. Inventory `switch` on kind/status unions in payment, ACP, stock, checkout provider status.  
2. Add default `assertNever(x)` (or exhaustive `satisfies` maps).  
3. Prefer maps with `satisfies Record<Union, …>` where data-driven.

**Acceptance**  
- [ ] New union member without handler fails typecheck in each touched switch.  
- [ ] No behavior change for existing members.

**Verify**  
Fast + targeted tests if any.

---

### Card F2.2 — Storage kit: fewer `as unknown as`; lean on Extract helpers

| | |
| -- | -- |
| **Parent** | P2.4 |
| **Priority** | P2 |
| **Break risk** | None if behavior identical |
| **Files** | `src/storage/repositories/kit.ts`, callers using loose casts |

**Why**  
`findOneByType` / `listByType` exist; residual casts mask bad results.

**Do**  
1. Grep `as unknown as` under `src/storage`.  
2. Replace with typed helpers or narrowed returns.  
3. Document when a cast is still required (EmDash storage API limits).

**Acceptance**  
- [ ] No new casts; net cast count down or each remaining cast has a one-line justification.  
- [ ] Repository tests still green.

**Verify**  
Fast.

---

### Card F2.3 — Lint: ban new ad-hoc `as unknown as MikaApi` (and cousins)

| | |
| -- | -- |
| **Parent** | P2.1 dispatch cast (comment only today) |
| **Priority** | P2-small |
| **Break risk** | None |
| **Files** | `vite.config.ts` / oxlint rules, allowlist `operation-define.ts` only |

**Why**  
Dispatch cast is localized; nothing stops reintroduction.

**Do**  
1. Add oxlint/eslint restriction (or vite-plus plugin rule) forbidding `as unknown as MikaApi` / double casts on API namespaces outside allowlisted files.  
2. Allowlist: `src/api/operation-define.ts` (`createDefaultMikaOperationCall`) only.  
3. Document in comment near the allowlisted cast.

**Acceptance**  
- [ ] Introducing a new forbidden cast fails `npm run check`.  
- [ ] Existing allowlisted cast still builds.

**Verify**  
`npm run check`.

---

### Card F2.4 — Residual megafile splits (optional, on-demand)

**Decision (2026-07-09): DEFERRED.** `acp/handlers.ts` and `checkout/start.ts` remain large; split only when next feature forces a full-file edit. No behavior risk from deferral.

| | |
| -- | -- |
| **Parent** | P2.1 residual |
| **Priority** | P3 (only when next feature forces large edits) |
| **Break risk** | None if barrels preserved |
| **Files** | `src/acp/handlers.ts`, `src/api/backend/checkout/start.ts` |

**Why**  
Still ~1k LOC; review/agent context pain.

**Do**  
Split only along existing seams (e.g. ACP complete vs update vs cancel; checkout claim vs provider create vs persist). **Behavior-identical** only.

**Acceptance**  
- [ ] Public barrels unchanged (`/acp`, backend factory imports).  
- [ ] Full suite green.  
- [ ] No logic edits in the same commit.

**Do not**  
- Mix with F0.2 or F1.2 behavior.

**Verify**  
Full.

---

### Card F2.5 — Route path dual-SSOT hardening

| | |
| -- | -- |
| **Parent** | P0.3 / review U06 residual |
| **Priority** | P2-small |
| **Break risk** | None |
| **Files** | `src/api/route-paths.ts`, `src/api/operation-definitions.ts`, `src/api/operation-collect.ts` |

**Why**  
Paths live in pure map **and** IR `routePath` strings; assert runs only when collect loads.

**Do**  
1. Prefer `routePath: mikaPluginRoutePaths.<key>` on each definition (single string source).  
2. Or add compile-time key-set pin between definitions and map (beyond runtime assert).  
3. Document “add route” steps in a short comment on `route-paths.ts`.

**Acceptance**  
- [ ] Cannot add IR route with wrong path without type or assert failure.  
- [ ] Client purity preserved (`routes` never imports operations).

**Verify**  
Full + client purity greps.

---

## Wave F3 — Optional polish & docs debt

---

### Card F3.1 — `exactOptionalObject` cast surface

**Decision (2026-07-09): DEFERRED.** Cast retained for EOPT + shape reattach until Astro/Zod offers a cleaner exact-optional path. Blocker: no upgrade leverage in current stack.

| | |
| -- | -- |
| **Parent** | P1.1 open |
| **Priority** | P3 |
| **Break risk** | Medium if inference changes optionality |
| **Depends on** | Prefer after Zod/astro upgrade opportunity |
| **Files** | `src/api/validation.ts` |

**Why**  
Still `transform` + `as unknown as` + shape reattach for EOPT + idempotencyKey detection.

**Do**  
1. Check current `astro/zod` / Zod version for better exact-optional APIs.  
2. If no leverage: document **deferred** with version blocker and close card as “won’t until Zod X”.  
3. If leverage: rewrite without losing `.shape` public access and EOPT omit-undefined behavior.  
4. Re-run schema-contracts + full suite.

**Acceptance**  
- [ ] Either cast surface reduced with contracts green, **or** explicit defer note in this file + parent ROADMAP.  
- [ ] `schemaAcceptsIdempotencyKey` still works without `_def` internals.

**Verify**  
Full.

---

### Card F3.2 — Pilot `isolatedDeclarations` on pure type packages

**Decision (2026-07-09): DEFERRED / abandoned for now.** Separate tsconfig for types/** not worth split cost while validation/operations stay inference-heavy.

| | |
| -- | -- |
| **Parent** | P3 |
| **Priority** | P3 |
| **Break risk** | Build-only; may force more explicit exports |
| **Files** | `src/types/**`, possibly separate tsconfig |

**Do**  
1. Try `isolatedDeclarations` only on types entrypoints (`primitives-entry`, aggregates, documents, operational).  
2. Fix export style issues; do **not** force on `operations` / action inference hubs.  
3. If too costly, document abort criteria and stop.

**Acceptance**  
- [ ] Types packages declare cleanly under pilot config, **or** written decision to abandon.  
- [ ] Pack/types:check still green for main pipeline.

**Verify**  
`types:check` + pack.

---

### Card F3.3 — `lib` / `target` bump (ES2024 or ES2025)

| | |
| -- | -- |
| **Parent** | P3 |
| **Priority** | P3 |
| **Break risk** | Low for Node ≥ 22.12 hosts; verify pack |
| **Files** | `tsconfig.json`, pack emit, engines already `>=22.12.0` |

**Do**  
1. Bump `target`/`lib` carefully; keep DOM libs if browser types needed.  
2. Full pack + attw + tests.  
3. Note any downlevel issues in commit body.

**Acceptance**  
- [ ] Full gate green.  
- [ ] No accidental reliance on unshipped runtime APIs without engines bump.

**Verify**  
Full.

---

### Card F3.4 — Optional unstyled template slice (no Kumo)

| | |
| -- | -- |
| **Parent** | P3 |
| **Priority** | P3 product-signal |
| **Break risk** | None (additive copy) |
| **Files** | `src/templates/astro/` (new slice or examples), template README |

**Why**  
Sharper “kit not theme” for hosts who do not want Cloudflare Kumo.

**Do**  
1. Add a minimal unstyled page/component set **or** document a “strip Kumo” path.  
2. Do not remove existing Kumo templates.  
3. Keep mika-template-version markers.

**Acceptance**  
- [ ] Host can copy a non-Kumo path without phosphor/kumo peers.  
- [ ] Existing Kumo path unchanged.

**Verify**  
`templates:check` still green for existing fixture (no emdash fixture required).

---

### Card F3.5 — Mark historical commerce-research rows

| | |
| -- | -- |
| **Parent** | P3 research debt |
| **Priority** | P3-docs |
| **Break risk** | None |
| **Files** | `docs/commerce-research/use-case-surface-audit.md`, other stale research called out in architecture-internal |

**Do**  
1. Banner at top: **Historical / pre-implementation** vs **Still accurate**.  
2. Strike or annotate rows superseded by registry, native plugin, shipped templates.  
3. Link to live ROADMAP / this follow-up for current work.

**Acceptance**  
- [ ] Reader can tell live vs historical in ≤30s.  
- [ ] No contradictory “must implement” language for already-shipped items.

**Verify**  
Docs-only.

---

### Card F3.6 — declarationMap consumer reality

| | |
| -- | -- |
| **Parent** | P3 declarationMap shipped |
| **Priority** | P3-small |
| **Break risk** | None |
| **Files** | pack pipeline, `package.json` `files`, optional `src` publish decision |

**Why**  
Maps point at `src/` paths; package `files` may not include `src` → jump-to-source broken for npm consumers.

**Do**  
1. Confirm published tarball contents (`npm pack --dry-run`).  
2. Either publish `src` (or declaration map roots that resolve), or document that maps help monorepo/path consumers only.  
3. Align expectation in README “types” blurb if needed.

**Acceptance**  
- [ ] Documented true consumer behavior.  
- [ ] No false claim of npm jump-to-source if `src` is unpublished.

**Verify**  
`npm pack --dry-run` + notes.

---

### Card F3.7 — Intentional Input divergences matrix

| | |
| -- | -- |
| **Parent** | P1.1 docs partial |
| **Priority** | P3-small |
| **Break risk** | None |
| **Files** | `src/api/validation.ts` (comments), optional `docs` or validation header table |

**Why**  
Only a few divergences are documented (`consumeToken`, subscription cancel/renew).

**Do**  
1. Table of every intentional wire-vs-server or form-vs-operation divergence.  
2. Each row: schema name, public type, difference, why, test pin location.  
3. Keep next to schemas or single canonical section linked from schemas.

**Acceptance**  
- [ ] Complete vs schema-contracts special cases.  
- [ ] No silent divergence without a row.

**Verify**  
Docs + existing schema-contracts.

---

## Wave F4 — Process / hygiene (meta)

Not product code; prevents the next campaign from lying to itself.

---

### Card F4.1 — Parent ROADMAP hygiene for policy items

| | |
| -- | -- |
| **Priority** | P3-docs |
| **Files** | `docs/qa/ROADMAP.md` |

**Do**  
1. Move Guardrails + Hold to non-checkbox sections (or always-checked “acknowledged” with date).  
2. Open `[ ]` on policy confuses “what’s left.”  
3. Point “open engineering work” to **this** follow-up file.

**Acceptance**  
- [ ] Counting open checkboxes no longer mixes policy with tasks.

---

### Card F4.2 — Keep reviews + follow-up discoverable

| | |
| -- | -- |
| **Priority** | P3-docs |
| **Files** | `docs/qa/README.md`, `docs/qa/reviews/README.md` |

**Do**  
1. Link `ROADMAP-followup.md` from `docs/qa/README.md`.  
2. Note `/docs` gitignore if reviews stay local-only.  
3. Optional: force-add policy if the team wants reviews in git (team decision).

**Acceptance**  
- [ ] New agent finds follow-up cards from `docs/qa/README.md` in one hop.

---

## Suggested ship order (capacity-limited)

| Order | Cards | Outcome |
| ----- | ----- | ------- |
| 1 | F0.1, F0.3, F0.4 | Publish/CI honesty + small test/export pins |
| 2 | F0.2 | Error codes actually emitted |
| 3 | F0.5, F2.5, F2.3 | Drift armor hardening |
| 4 | F1.1 → F1.2 → F1.3 | Real brand safety on money paths |
| 5 | F2.1, F2.2 | Exhaustiveness + kit typing |
| 6 | F2.4 | Only if editing those megafiles next |
| 7 | F3.* / F4.* | Polish as capacity allows |

---

## Progress log (follow-up campaign)

| Date | Card | Commit | Notes |
| ---- | ---- | ------ | ----- |
| | | | |

| 2026-07-09 | F0.1 | `fef5462` | prepublish templates:check |
| 2026-07-09 | F0.2 | `b4fc9ae` | emit additive error codes |
| 2026-07-09 | F0.3–F0.5 | `babb83b` / `d912a6a` | admin pin, primitives export, barrel |
| 2026-07-09 | F1.1 | `55dcbb5` | unique-symbol brands + Zod mint |
| 2026-07-09 | F2.1 | `021c19c` | assertNever payment kinds |
| 2026-07-09 | F2.3 | `11b59ae` | cast allowlist test |
| 2026-07-09 | F2.5 | `8b3cba9` | IR routePath from map |
| 2026-07-09 | F3.3 | (pending) | ES2024 |
| 2026-07-09 | F3.6 | `87f4d47` | declarationMap reality |
| 2026-07-09 | F3.1 | **DEFER** | exactOptionalObject cast retained until Zod/astro upgrade leverage |
| 2026-07-09 | F3.2 | **DEFER** | isolatedDeclarations abandoned for ops/inference hubs; types-only pilot not worth split tsconfig now |
| 2026-07-09 | F2.4 | **DEFER** | acp/handlers + checkout/start remain ~1k LOC until feature forces split |

---

## Cross-links

| Doc | Role |
| --- | ---- |
| [ROADMAP.md](./ROADMAP.md) | Parent checklist (historical + done marks) |
| [EXECUTION.md](./EXECUTION.md) | First-campaign unit log |
| [reviews/](./reviews/) | Per-commit review findings that generated several F0 cards |
| [typescript-internals-improvements.md](./typescript-internals-improvements.md) | Type tactics |
| [architecture-overhaul-verdict.md](./architecture-overhaul-verdict.md) | No full redesign |
