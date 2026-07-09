# Review: U05 / `fd9fb8b` — MikaActions ↔ action tree pin

**Commit:** `fd9fb8b54ec878fb8b5023940c0e0fe7eecd75a3`  
**Checkmark:** P0.2 `MikaActions` bidirectional with action definitions / tree (beyond one-way tree coverage)  
**Scope:** `src/astro-actions.ts` (+40 / −5)  
**Unit:** U05 · Verify claimed: `typecheck`, `templates:check`

## Summary

This unit upgrades the existing one-way compile-time guard next to `createMikaActions`’s `as MikaActions` cast into a **three-part set-equality pin** between the hand `MikaActions` interface and `typeof mikaActionTreeSpec`:

1. **Tree covers interface** — retained structural check: every `MikaActions` namespace/method is present on the tree with a leaf typed as `MikaActionDefinitionKey`.
2. **Interface covers tree methods** — new `MikaActionsTreeMethodDrift` rejects orphan tree methods (registry action present, hand client missing).
3. **Namespace sets match** — `MikaActionsNamespaceDrift` rejects namespaces only on one side.

`MikaActionsInterfaceMethodDrift` closes the reverse method direction explicitly (largely overlapping (1) for *presence*, while (1) still uniquely enforces leaf key typing). The combined `MikaActionsRegistryDrift` is folded into `MikaActionsTreeCoverage`, which must resolve to `true` for `_mikaActionsTreeCoverage = true` to typecheck.

This matches the U03/U04 wave pattern (method/namespace drift unions + zero-runtime `const _assert… = true`) and the U05 substeps in `docs/qa/EXECUTION.md` (§6: both directions fail on drift). It also closes the residual called out in `docs/qa/external-api-surface.md` (“`interface MikaActions` | One-way tree coverage type”).

**Why this is enough for “action definitions / tree”:** `mikaActionTreeSpec` is already **derived** from `mikaActionDefinitions` (`MikaDerivedActionTreeSpec` / `collectMikaActionTreeSpec` in `src/api/action-tree.ts`), and runtime `validateMikaActionTreeSpec` still enforces 1:1 definition-key coverage (tested in `test/index.test.ts`). Pinning hand `MikaActions` ↔ tree therefore pins hand `MikaActions` ↔ the action-definition set for namespace/method **presence**. No change to `action-tree.ts` was required; the ROADMAP file list names that module as the other half of the contract, not as mandatory edit surface for this unit.

**Add-op failure mode (goal of slice 1):**

| Change | Before (one-way) | After (this commit) |
| ------ | ---------------- | ------------------- |
| New `action:` on an op (tree grows) without updating `MikaActions` | Silent | `TreeMethodDrift` / `NamespaceDrift` → `TreeCoverage = never` |
| New hand method on `MikaActions` without tree/definition | Fail (`TreeCoversInterface`) | Fail (same + `InterfaceMethodDrift`) |
| Rename on one side only | Partial | Both directions |

**Verdict:** **Accept.** Closes P0.2 / U05 as specified. Residual notes below are nits / intentional name-only pin scope, not blockers.

## Checkmarks

| Criterion | Result |
| --------- | ------ |
| Bidirectional vs prior one-way tree coverage | Pass — both method directions + namespace equality |
| Compile-time (prefer `satisfies` / helper types over runtime) | Pass — pure types + unused const assert; runtime tree validation unchanged and still complementary |
| Aligns with U03/U04 pin style | Pass — same drift-union approach as U04 commit |
| Scope discipline (no behavior / graph / unrelated edits) | Pass — single file, types/docs only around existing assert |
| Cast `as MikaActions` still justified | Pass — builder remains structural `unknown` tree walk; pin guards the cast rather than removing it |

## Issues

### Issue 1 — Severity: nit
- File: `src/astro-actions.ts` (`MikaActionsTreeCoverage` / `_mikaActionsTreeCoverage`)
- Description: On failure, the assert type collapses to `never`, so TypeScript reports roughly `Type 'true' is not assignable to type 'never'` without naming the drifted keys. U04’s original assert used `Drift extends never ? true : Drift`, which surfaces the offending key union in the error. `InterfaceMethodDrift` / `TreeMethodDrift` already compute those unions; they are discarded when folded into `never`.
- Suggestion: Optional DX follow-up (not required for the checkmark):

  ```ts
  type MikaActionsTreeCoverage = MikaActionsTreeCoversInterface extends true
    ? MikaActionsRegistryDrift extends never
      ? true
      : MikaActionsRegistryDrift
    : never;
  ```

  (or split asserts so leaf-type failure vs key-set failure stay distinct).
- Status: open

### Issue 2 — Severity: nit
- File: `src/astro-actions.ts` (comment block + drift type names)
- Description: `MikaActionsInterfaceMethodDrift` and half of `MikaActionsNamespaceDrift` overlap `MikaActionsTreeCoversInterface` for the “interface ⊆ tree” direction. Not wrong — defense in depth and symmetry with U04 — but slightly more surface than the minimum (`TreeCoversInterface` + `TreeMethodDrift` + tree-only namespace excess).
- Suggestion: Keep as-is for readability/parity with facade pin, or collapse later if the pin block is simplified across U03–U05 together.
- Status: open (non-actionable preference)

### Issue 3 — Severity: residual (out of strict U05 scope)
- File: `src/astro-actions.ts` (`interface MikaActions` client signatures)
- Description: Like U03’s MikaApi **method-name** pin, this unit locks **namespace/method presence** (and that tree leaves are some `MikaActionDefinitionKey`), not that each hand client’s input/output types match the linked operation’s schema/DTO. A hand method can still declare the wrong `MikaFormActionClient`/`MikaJsonActionClient` shape and typecheck.
- Suggestion: Accept as intentional residual of P0.2 (presence locks). Stronger signature derivation remains a Later/maintainability item if desired; do not expand this commit.
- Status: open (accepted residual)

### Issue 4 — Severity: nit (docs lag)
- File: `docs/qa/external-api-surface.md` (~line 171)
- Description: Residual-drift table still says `interface MikaActions` → “One-way tree coverage type”. After `fd9fb8b` that row is stale. Not part of the commit’s claimed scope.
- Suggestion: When next touching that doc (e.g. U07 three-faces), update to “bidirectional tree/interface method+namespace pin (`astro-actions.ts`)”.
- Status: open

## Non-issues / notes

- **`as MikaActions` remains:** Expected; the unit was a pin for the cast, not a rewrite of `buildMikaActionTree`.
- **Runtime `validateMikaActionTreeSpec`:** Still the right place for unknown/duplicate/missing *definition key strings*; types cannot fully replace that walk for arbitrary runtime specs.
- **Action subset vs full `MikaApi`:** Ops without `action:` correctly never enter the tree; the pin does not force Astro actions for every API method (matches external-api-surface “Mutation/form subset”).
- **Verify suite:** Not re-executed in this review; commit message and EXECUTION unit table align (`typecheck` + `templates:check` for Astro-facing types).

## Verdict detail

**Accept** for ROADMAP P0.2 / EXECUTION U05. The missing half of the drift lock (orphan registry/tree entries vs hand `MikaActions`) is now a typecheck failure, which is the ship-slice “Drift locks” outcome for the Astro Actions face. Nits are diagnostic/docs/residual signature depth only; no fix commit required to close the checkmark.
