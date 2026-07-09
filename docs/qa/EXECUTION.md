# QA execution plan — full roadmap, commit cadence

**Status:** active plan for working **top-down through [ROADMAP.md](./ROADMAP.md)**  
**Delivery model:** commits on the current branch (no PRs)  
**Quality gate per unit:** implement → verify → Grok review → fix **all** findings → re-verify → commit  
**Last updated:** 2026-07-09

This document is the **operator schedule**. [ROADMAP.md](./ROADMAP.md) remains the checklist of *what*; this file is *order, batching, intermediates, and the review loop*.

---

## 1. Working agreement

### 1.1 No PRs

- All work lands as **linear commits** on the working branch (currently `review-fixes`).
- One **execution unit** ≈ one logical commit (or a short pair: main commit + review-fix commit if review finds issues after a provisional commit).
- Prefer **pre-commit review** so the main commit is already clean; use a follow-up commit only when review runs after commit or late findings appear.

### 1.2 Per-unit loop (mandatory)

```text
┌─────────────────────────────────────────────────────────────┐
│  UNIT N                                                     │
│  1. Implement only this unit’s scope                        │
│  2. Run the unit’s verify suite (see §3)                    │
│  3. Grok review on local changes (reviewer persona)         │
│  4. Fix ALL open issues (bugs + suggestions + nits)         │
│  5. Re-run verify suite                                     │
│  6. Commit with message:                                    │
│       qa(<unit-id>): <imperative summary>                   │
│       Body: roadmap refs + why                              │
│  7. Tick matching ROADMAP checkboxes; note date if phase    │
│     exit criteria met                                       │
└─────────────────────────────────────────────────────────────┘
```

**Fix policy:** do not leave “won’t fix” without an explicit note in the commit body and a ROADMAP hold. Default is **fix everything the reviewer flags**.

### 1.3 Review invocation

Use the bundled review flow against **local (uncommitted) changes** before the final commit of the unit:

1. Stage or leave working tree as the unit’s full diff.
2. Run Grok **local** review (reviewer persona; findings to a temp review file).
3. Apply fixes until the review would be empty of actionable issues (or re-run once after fixes).
4. Then commit.

If a unit was committed too early, immediately: review that commit’s diff vs parent → fix-all → `qa(<unit-id>): address review findings`.

### 1.4 Commit message shape

```text
qa(U03): pin MikaApi shape to operation registry

Roadmap: P0.2 MikaApi satisfies
Verify: typecheck, test
```

Unit ids are `U00`… from §4. Keep messages imperative and scoped.

### 1.5 What not to mix

- Do not combine **client purity** (graph change) with **z.infer input rewrites** (type churn).
- Do not combine **megafile splits** with **behavior changes**.
- Do not open **Later** (agentic/protocol) until P0–P2 complete.
- Do not reverse Guardrails.

---

## 2. Optimal sequencing rationale

Capacity is unlimited, so order for **dependency and risk**, not “smallest first only.”

| Principle | Application |
| --------- | ----------- |
| **Safety net first** | CI must run every gate used locally before structural work. |
| **Contract before structure** | Drift pins and type barrel before splitting modules. |
| **Graph purity before input rewrite** | Client route map extract before Zod-primary inputs (avoids thrashing validation imports). |
| **Honesty before polish** | Peer/matrix and maintenance docs before declarationMap. |
| **Split when pins exist** | Megafile splits after registry pins so moves can’t silently drop methods. |
| **Brands after input SoT** | Entity brands after input dual-truth settles (one migration of id types, not two). |
| **Errors before brands optional** | Additive error codes can land before or after brands; prefer **before** so ACP allowlist and client branch docs don’t fight brand renames. |
| **Later last** | Agentic runtime / protocol projections only when core load is down. |

**Dependency graph (simplified):**

```text
U00 baseline
  → U01 CI templates:check
  → U02 /types barrel
  → U03–U05 registry pins (Api → facade → Actions)
  → U06 client purity (Zod-free route map)
  → U07 three-faces docs
  → U08 admin operationKey test
  → U09 Astro peer honesty
  → U10 storage typing + maintenance docs + emdash fixture
  → U11–U14 input truth (contracts → cart/checkout → rest → exactOptional revisit)
  → U15 optional /server subpaths
  → U16–U20 megafile splits (operations first, then acp, checkout, payment, stripe)
  → U21 dispatch cast containment
  → U22 additive errors + ACP allowlist
  → U23–U24 entity brands (primitives → money paths)
  → U25 exhaustiveness + storage Extract helpers + index keys
  → U26–U28 P3 polish batch
  → U29+ Later (only if still desired)
```

---

## 3. Verify suites

### 3.1 Full gate (prepublish-equivalent)

Use after structural or publish-surface units (`U01`, `U02`, `U06`, `U15`, any split that touches entrypoints, end of P0, end of P1, end of P2):

```bash
npm run check
npm run typecheck
npm test
npm run templates:check
npm run pack:check
npm run types:check
```

### 3.2 Fast gate (type/test only)

Use for pure-type or docs-only units:

```bash
npm run typecheck
npm test
```

### 3.3 Client purity extra check (`U06`)

After pack:

```bash
# Must not pull operations IR or astro/zod into the browser client graph
rg -n "astro/zod|operations-" dist/api/client.mjs dist/*operations* 2>/dev/null || true
# Stronger: inspect client.mjs imports / bundled chunk list from pack output
```

Document the exact greps used in the commit body once the pack layout is confirmed.

### 3.4 CI note (as of plan writing)

[`.github/workflows/ci.yml`](../../.github/workflows/ci.yml) already runs: `check`, `typecheck`, `test`, `pack:check`, `types:check`.  
**Missing:** `templates:check` → unit **U01**.

---

## 4. Execution units (top-down)

Tick units here as they complete; also tick the corresponding [ROADMAP](./ROADMAP.md) boxes.

### Wave 0 — Baseline & CI

| ID | Scope | Roadmap | Verify | Notes |
| -- | ----- | ------- | ------ | ----- |
| **U00** | Run full gate on clean tree; record failures | — | Full | No product code. Fix only if baseline is red (separate hotfix commits). |
| **U01** | Add `templates:check` to CI; keep local script | P0.4 CI | Full | Non-breaking workflow change. |

### Wave 1 — P0 contract locks

| ID | Scope | Roadmap | Verify | Notes |
| -- | ----- | ------- | ------ | ----- |
| **U02** | Export missing public inputs on `/types` + barrel completeness test | P0.1 | Full | Known gaps: `CheckoutCancelInput`, `CheckoutStatusInput`; add completeness assert in package-exports or schema-contracts. |
| **U03** | `MikaApi` ↔ registry bidirectional pin | P0.2 | Fast → Full if ops touched | Prefer compile-time `satisfies` / helper types over runtime. |
| **U04** | `MikaOperationFacade` pin to registry/facade spec | P0.2 | Fast | After U03 so patterns match. |
| **U05** | `MikaActions` bidirectional with action defs/tree | P0.2 | Full | Astro types; run `templates:check`. |
| **U06** | Zod-free route path map; purify `/client` import graph | P0.3 | Full + §3.3 | Highest graph risk in P0; do **after** pins so route names stay locked. |
| **U07** | Document three host faces (README + template index) | P0.4 docs | Fast | No behavior change. |

**Wave 1 exit:** ROADMAP P0 exit criteria met (add-op fails typecheck if faces missing; barrel complete; client graph clean; faces documented; CI complete).

### Wave 2 — P1 honesty & third registries

| ID | Scope | Roadmap | Verify | Notes |
| -- | ----- | ------- | ------ | ----- |
| **U08** | Admin `operationKey` ∈ `mikaOperationDefinitions` test | P1.3 | Fast | Small, high value; do early. |
| **U09** | Astro peer honesty: **decide** dual CI matrix **or** narrow to `^7` + docs | P1.2 peer | Full | Prefer **narrow to `^7` + document** unless dual matrix is cheap; either is fine if honest. |
| **U10** | Bundle: storage config typing vs EmDash; maintenance wiring docs; note `astro` peer required for schema stack; extend template fixture with `emdash()` if feasible | P1.2 rest | Full | If `emdash()` fixture is heavy, split **U10a** docs/typing and **U10b** fixture. |
| **U11** | Expand `schema-contracts.ts` to all public inputs (still dual-pin) | P1.1 | Fast | Safety net **before** infer migration. |
| **U12** | Prefer `z.infer` for cart + checkout inputs | P1.1 | Full | Domain batch 1. |
| **U13** | Prefer `z.infer` for remaining public inputs | P1.1 | Full | Domain batch 2; document intentional divergences beside schemas. |
| **U14** | Revisit `exactOptionalObject` if Astro/Zod allows cleaner shape | P1.1 | Full | Skip if no upgrade leverage; note “deferred” in ROADMAP. |
| **U15** | Optional additive `/server` sub-discoverability (`ports`, `maintenance`, `email`) re-exporting current symbols | P1.3 | Full | Additive only; never remove current `/server` re-exports. |

**Wave 2 exit:** P1 exit criteria (input primary source or full dual-pin; peer honest; admin can’t dangle; maintenance obvious).

### Wave 3 — P2 maintainability

Order: **operations split first** (enables cleaner future registry work) → other megafiles → dispatch → errors → brands → exhaustiveness.

| ID | Scope | Roadmap | Verify | Notes |
| -- | ----- | ------- | ------ | ----- |
| **U16** | Split `operations.ts` → define / definitions / collect | P2.1 | Full | No package export change; re-export barrels preserve paths. |
| **U17** | Split `acp.ts` | P2.1 | Full | Public `@bnomei/emdash-mika/acp` unchanged. |
| **U18** | Split `checkout.ts` | P2.1 | Full | Behavior-identical. |
| **U19** | Split `webhooks/payment.ts` | P2.1 | Full | When not blocked; still do in this wave. |
| **U20** | Split `stripe.ts` | P2.1 | Full | Public `/stripe` barrel unchanged. |
| **U21** | Contain dynamic API dispatch casts; lint guard if cheap | P2.1 last bullet | Fast | After U16. |
| **U22** | Additive error codes + ACP allowlist + template “branch on code” docs | P2.3 | Full | Additive only. |
| **U23** | Introduce entity brand types + constructors + Zod helpers | P2.2 | Fast | Types only first. |
| **U24** | Migrate money paths: cart → checkout → order → webhook → ACP | P2.2 | Full | Largest soft-break risk for typed hosts; keep brands assignable policy documented. |
| **U25** | `assertNever` expansion + repository `Extract` helpers + `MikaIndex` if missing | P2.4 | Full | |

**Wave 3 exit:** P2 exit criteria (reviewable modules; brands on money paths; additive errors; exhaustiveness).

### Wave 4 — P3 polish

| ID | Scope | Roadmap | Verify | Notes |
| -- | ----- | ------- | ------ | ----- |
| **U26** | `declarationMap` in publish DTS pipeline | P3 | Full | |
| **U27** | Docs: Astro matrix, uncacheable routes, reserved `src/fetch.ts`, compressHTML/JSX notes | P3 | Fast | Can merge if small. |
| **U28** | Optional: `isolatedDeclarations` pilot on `types/**`; lib/target bump trial; `./types/primitives`; unstyled template slice; mark stale research docs | P3 | Full per sub-item | Split into U28a/b/c if any sub-item grows. |

### Wave 5 — Later (optional)

| ID | Scope | Roadmap | Verify | Notes |
| -- | ----- | ------- | ------ | ----- |
| **U29+** | Agentic runtime ports; protocol projection fixtures | Later.1–2 | Full | Only after Waves 0–4. Never protocol fields in core DTOs. |

---

## 5. Intermediate milestones (pause & reassess)

After each milestone, run **full gate**, skim success metrics in ROADMAP, and only then continue.

| Milestone | After unit | Checkpoint questions |
| --------- | ---------- | -------------------- |
| **M0** | U01 | Is CI green with templates? |
| **M1 — P0 done** | U07 | Can a fake missing op method fail typecheck? Is client.mjs clean? |
| **M2 — P1 done** | U15 | Is peer claim honest? Are inputs dual-pinned or inferred? |
| **M3 — splits done** | U21 | Any file still > ~800 LOC without a plan note? |
| **M4 — P2 done** | U25 | Money-path brands + additive errors live? |
| **M5 — polish done** | U28 | declarationMap + host docs done? |

If a unit is blocked (e.g. EmDash types unavailable for storage config), record **blocked → skip with ROADMAP note** and continue to the next independent unit; do not stall the whole wave.

---

## 6. Intermediate technical steps (inside hard units)

These are **substeps inside a unit**, not separate commits, unless a substep fails and needs isolation.

### U03–U05 (registry pins)

1. Inventory `mikaOperationApiMethodNames` / action keys.  
2. Build derived type `MikaApiFromOperations` (method presence + rough arity/ctx).  
3. `type _Assert = …` or `satisfies` so both directions fail on drift.  
4. Fix any real mismatches found (those are bugs, not “test noise”).  
5. Review + commit.

### U06 (client purity)

1. Introduce `src/api/route-paths.ts` (or similar) with **data only**: path map + public route names.  
2. Point `operations` collectors and `routes.ts` at it.  
3. Ensure `client.ts` imports only route-paths + request helpers — **not** `operations.ts` / validation.  
4. `npm run pack:check` + graph check §3.3.  
5. Review + commit.

### U11–U13 (input truth)

1. U11: contracts only (no type source change).  
2. U12/U13: per-schema switch to `z.infer`; keep exported type **alias names** stable (`export type AddCartItemInput = …`).  
3. Document intentional divergences (e.g. `consumeToken`) beside schema.  
4. Never rewrite DTO interfaces to Zod in these units.

### U16–U20 (splits)

1. Create sibling files; move code; re-export from original path if needed for deep imports (prefer no deep imports).  
2. No logic edits in the same unit.  
3. Full gate after each file family.

### U23–U24 (brands)

1. U23: brands + factories only; `MikaId` remains union or escape hatch.  
2. U24: migrate call sites path-by-path; Zod mint at boundaries; forms stay string → parse.

---

## 7. Mapping ROADMAP “ship slices” → units

| ROADMAP slice | Units |
| ------------- | ----- |
| 1 — Drift locks | U01, U03–U05 |
| 2 — Barrel + purity | U02, U06 |
| 3 — Host honesty | U07–U10, U08 |
| 4 — Input truth | U11–U14 |
| 5 — Size | U16–U21 |
| 6 — Safety | U22–U25 |
| 7 — Polish | U26–U28 |
| Hold off Later | U29+ |

Slight reorder vs original slice table: **barrel (U02) before pins** for host-facing completeness early; **admin test (U08) before peer decision** for a quick win; **errors (U22) before brands (U23–U24)**.

---

## 8. Progress log

| Date | Unit | Commit | Notes |
| ---- | ---- | ------ | ----- |
| 2026-07-09 | U00 | — | Full gate green (warnings only); npm ci |
| 2026-07-09 | U01 | `9928369` | CI `templates:check` |
| 2026-07-09 | U02 | `31c00b3` | `/types` barrel + completeness test |
| 2026-07-09 | U03 | `4fba413` | MikaApi ↔ registry method-name pin |
| 2026-07-09 | U04 | `91633c5` | Facade ↔ registry pin |
| 2026-07-09 | U05 | `fd9fb8b` | MikaActions ↔ tree pin |
| 2026-07-09 | U06 | `f5277e5` | Zod-free route-paths; client purity |
| 2026-07-09 | U07 | `fd6305b` | Three host faces docs · **M1 P0 complete** |
| 2026-07-09 | U08 | `76e2ef4` | Admin operationKey registry test |
| 2026-07-09 | U09–U15 | `5bf9010` | Astro ^7 peer, maintenance docs, `/server/*` subpaths; P1.1 via schema-contracts dual-pin |
| 2026-07-09 | U16,U22–23,U26 | `c614399` | operations split; error codes + ACP map; entity brands; declarationMap |
| 2026-07-09 | U17–U21,U27 | `c4e57b6` | acp/checkout/payment/stripe splits; template Astro 7 notes |
| 2026-07-09 | U28 | `2c03dcb` | `./types/primitives` subpath · **campaign complete** (Later.1–2 deferred) |

---

## 9. Start command (when execution begins)

1. Confirm branch and clean tree (or commit unrelated WIP).  
2. Execute **U00** (baseline full gate).  
3. Proceed **U01 → …** without skipping waves except documented blocks.  
4. Update this progress log and ROADMAP checkboxes after each unit.
)
