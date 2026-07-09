# Review: F2–F4 maintainability & docs (`021c19c` … `8cdb2e2`)

**Commits reviewed:**

| SHA | Message |
| --- | ------- |
| `021c19c` | qa(F2.1): assertNever on payment webhook kind switch |
| `ec53344` | qa(F2.2): document remaining kit StorageQueryOptions cast |
| `8b3cba9` | qa(F2.5): operation IR routePath from pure route-paths map |
| `d4e46b8` | qa(F3.3): bump TypeScript target and lib to ES2024 |
| `983c78a` | qa(F3.4): document unstyled kit path without Kumo |
| `87f4d47` | qa(F3.6): document declarationMap npm consumer reality |
| `228db22` | qa(F3.7): complete intentional Input divergences matrix |
| `1b79712` | qa(F3.5): mark commerce-research as historical |
| `c5cc155` | qa(F4.1): parent ROADMAP hygiene for policy and follow-up closeout |
| `8cdb2e2` | qa(F4.2): link follow-up campaign from reviews index |

**Focus:** assertNever exhaustiveness, routePath dual-SSOT / client purity, ES2024 runtime assumptions, declarationMap + unstyled-kit docs accuracy, divergence matrix vs schema-contracts.

## Summary

Most of this wave is sound maintainability and honesty work.

| Area | Verdict |
| ---- | ------- |
| **F2.1** payment `event.kind` switch | **Correct** for `MikaProviderWebhookEvent` (`payment` \| `subscription` \| `unknown`); residual inventory outside this switch |
| **F2.2** kit cast | **Accept** — sole `as unknown as StorageQueryOptions` justified + items re-validated |
| **F2.5** IR `routePath` from map | **Strong** for path SSOT + client purity; missing “add route” comment; load assert still required |
| **F3.3** ES2024 | **Accept** — matches `engines.node >= 22.12.0`; no accidental ES2024-only API reliance found |
| **F3.4** unstyled kit | **Docs bug** in sample form action binding |
| **F3.5** historical research | **Accept** — folder + audit banners + live ROADMAP links |
| **F3.6** declarationMap | **Accept** — README matches published `files` (`dist` + `src/templates` only); maps point at unpublished `../src/…` |
| **F3.7** divergences matrix | **Accept** — covers schema-contracts special cases; one pin still says `MikaId` for availability |
| **F4.1 / F4.2** docs hygiene | **Accept** — policy de-checkboxed; follow-up linked from QA + reviews index |

**Overall:** Accept with a small set of open findings (one docs correctness bug, a few completeness residuals). No runtime defect found in the payment switch, kit cast justification, route-path wiring, ES2024 bump, declarationMap honesty, or F4 hygiene.

## Issues

### Issue 1 -- Severity: bug

- File: `src/templates/astro/examples/unstyled-kit.md:29`
- Description: The unstyled kit sample posts to `action={Mika.actions.cart.add}`, but `createMika` / `MikaAstroClient` is the operation facade + `routes` only — it has **no** `.actions` property. Real template forms use Astro Actions (`actions.mika.cart.add` / `.queryString` from `astro:actions`), e.g. `src/templates/astro/components/AddToCartForm.astro:69`. A host following this “minimal” path would get a type/runtime failure on first form. Catalog read usage (`Mika.catalog.sellables` + `.ok` / `.data`) is directionally correct for the facade result envelope.
- Suggestion: Rewrite the example to match the storefront path: `import { actions } from "astro:actions"` and `action={actions.mika.cart.add}` (or `.queryString` if that is the preferred form pattern). Keep Kumo out of the sample.
- Status: open
- Commit: `983c78a`

### Issue 2 -- Severity: suggestion

- File: `src/api/backend/webhooks/payment/process.ts:30-119`
- Description: F2.1 correctly exhausts `MikaProviderWebhookEvent` (`src/provider.ts:237-240`) with `default: return assertNever(event)`. That is the right pattern for this switch and is behavior-preserving for existing kinds. However, card F2.1 / parent ROADMAP text also named **ACP status machines**, **stock policy branches**, and broader inventory. Those paths still rely on `noImplicitReturns` / `satisfies` rather than `assertNever` (e.g. `src/acp/feed.ts:237-244`, `src/api/backend/checkout/helpers.ts:406-418`, `src/model/builders.ts:449-453`, `src/api/backend/fulfillment.ts:550-598`, and the sibling kind switch `webhookEventToJson` at `src/api/backend/webhooks/ingest.ts:323-378` with no default). Compile-time safety is largely already present under current `tsconfig` flags; the claimed “expand assertNever” inventory is only partially closed by this commit.
- Suggestion: Either (a) add a short residual note on the F2.1 card that remaining switches already exhaust via `noImplicitReturns`/`satisfies` and do not need `assertNever`, or (b) add `assertNever` defaults to the few remaining kind/status switches still missing an explicit default for symmetry with payment process / fulfillment revoke.
- Status: open
- Commit: `021c19c`

### Issue 3 -- Severity: suggestion

- File: `src/api/route-paths.ts:1-7`
- Description: F2.5 successfully wires IR `routePath` values through `mikaPluginRoutePaths.*` in `src/api/operation-definitions.ts` (route-only + every routed op). Client purity is preserved: `src/api/routes.ts` and `src/api/client.ts` still import only the pure map / routes helper, never operations. Load-time `assertMikaPluginRoutesConsistent` in `src/api/operation-collect.ts:178-235` still enforces key coverage, path equality, and no duplicate `path:method`. Card F2.5 Do item 3 asked to document **“add route” steps** on `route-paths.ts`; the header only describes browser SSOT and that operations assert alignment — it does not say the ordered steps (add map key → IR `routeKey`/`routePath: mikaPluginRoutePaths.x` → public list if needed → verify collect assert / client purity greps).
- Suggestion: Add a short ordered “adding a route” comment block on `route-paths.ts` (and optionally cross-link from `operation-definitions.ts`). Optional hardening: type `routePath` as `(typeof mikaPluginRoutePaths)[MikaPluginRouteName]` or `satisfies` the map intersection instead of `as` on `mikaOperationPluginRoutes` so wrong literals fail at compile time, not only at load assert.
- Status: open
- Commit: `8b3cba9`

### Issue 4 -- Severity: nit

- File: `src/templates/astro/README.md:66-78`
- Description: `examples/README.md` links the unstyled kit, but the parent templates README “Examples” list still only lists release-slice / storefront / backend-provider / agent-ready — hosts starting from `src/templates/astro/README.md` can miss the non-Kumo path that F3.4 was meant to surface.
- Suggestion: Add a bullet for `examples/unstyled-kit.md` next to the other examples, and optionally soften the opening line that describes the whole tree as “Kumo UI examples” only.
- Status: open
- Commit: `983c78a`

### Issue 5 -- Severity: nit

- File: `test/schema-contracts.ts:119-122`
- Description: F3.7’s validation header matrix correctly lists intentional special cases also pinned in schema-contracts (`consumeToken` omit, subscription cancel/renew `priceId` omit, shared `returnToInputSchema`, `stockAvailabilityInputSchema`, `downloadResolveInputSchema`, form schemas, branded money-path ids). Completeness vs special cases is good. Residual inconsistency: the matrix documents `stockAvailabilityInputSchema` as `{ sellableId: SellableId }`, matching `src/api/validation.ts:186-188`, while the schema-contracts pin still uses `{ readonly sellableId: MikaId }`. `AssertExactKeys` only checks key sets, so the outdated value type does not fail typecheck after F1 brands.
- Suggestion: Update the stock availability contract pin to `SellableId` (and import it) so matrix, schema, and contracts agree on value types as well as keys.
- Status: open
- Commit: `228db22`

## Non-issues / confirmed correct

### F2.1 payment exhaustiveness (`021c19c`)

- `MikaProviderWebhookEvent` is a closed three-member discriminated union; cases `payment` / `subscription` / `unknown` + `assertNever(event)` cover it.
- Existing payment/subscription control flow is unchanged; `unknown` still no-ops by returning the webhook document.
- `assertNever` from `src/api/backend/shared.ts:273-276` remains `never`-returning at type level and throws at runtime if reached.

### F2.2 kit cast (`ec53344`)

- Only storage `as unknown as` under `src/storage` is `kit.ts:94` (`StorageQueryOptions<TDocument>`).
- Comment at `kit.ts:85-87` documents EmDash non-generic query options (F2.2) and items are re-validated via `documentOfType` before return.
- Meets “remaining cast has a one-line justification” without claiming the EmDash API was fixed.

### F2.5 dual-SSOT / client purity (`8b3cba9`)

- Path **strings** are single-sourced from `mikaPluginRoutePaths` for IR definitions.
- `routes.ts` depends only on `./route-paths` (Zod-free); browser `/client` cannot pull operation IR through that edge.
- Collect assert still fails fast if map and IR keys/paths diverge or a map key is orphaned.

### F3.3 ES2024 (`d4e46b8`)

- `tsconfig.json` `target`/`lib` are `ES2024` (+ DOM libs kept).
- `package.json` `engines.node` is `>=22.12.0`, which is a coherent runtime floor for ES2024 emit via `vp pack` + that tsconfig.
- No new reliance on unshipped runtime APIs (e.g. no `Array.fromAsync` / `Promise.withResolvers` adoption found as part of this bump’s responsibility).

### F3.5 / F3.6 / F4

- Commerce-research README + use-case audit banners mark historical status and point at `docs/qa/ROADMAP-followup.md` / parent ROADMAP; reader can distinguish live vs research in ≤30s.
- README Install section states declaration maps help monorepo/path consumers and **do not** give npm tarball jump-to-source; matches `files: ["dist", "src/templates"]` and map `sources` like `../src/api/server-client.ts` on `dist/server.d.mts.map`.
- Parent ROADMAP: Guardrails / Hold / Later are policy sections (no open `[ ]` mixed with engineering tasks); open work points at follow-up only. Reviews index + `docs/qa/README.md` link the follow-up campaign.

## Scorecard

| Card | Rating |
| ---- | ------ |
| F2.1 assertNever payment kinds | **Done for payment process; residual inventory / wording** |
| F2.2 kit cast documentation | **Done** |
| F2.5 routePath from map | **Done with small doc residual** |
| F3.3 ES2024 | **Done** |
| F3.4 unstyled kit | **Partial — sample is wrong** |
| F3.5 historical research | **Done** |
| F3.6 declarationMap reality | **Done** |
| F3.7 divergences matrix | **Done (minor pin wording drift)** |
| F4.1 / F4.2 hygiene | **Done** |


## Autofix (2026-07-09)

| Issue | Status | Change |
| ----- | ------ | ------ |
| 1 unstyled-kit `Mika.actions` | **fixed** | sample uses `actions.mika.cart.add` from `astro:actions` |
| 2 F2.1 residual switches | **partial** | `assertNever` on `webhookEventToJson`; other switches already exhaustive via noImplicitReturns |
| 3 route-paths “add route” docs | **fixed** | ordered steps on `route-paths.ts` header |
| 4 templates README link | **fixed** | unstyled kit bullet |
| 5 schema-contracts SellableId | **fixed** | availability pin matches brands |
