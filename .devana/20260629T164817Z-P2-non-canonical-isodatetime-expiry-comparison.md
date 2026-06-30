DEVANA-FINDING: v1
DEVANA-STATE: fixed | P2 | medium | security=no
DEVANA-KEY: src/types/primitives.ts:39 | non-canonical-isodatetime-expiry-comparison

# `createISODateTime` validates but does not canonicalize, so a non-`Z` `expiresAt` breaks string-based expiry comparisons

# Finding

Token and entitlement expiry are evaluated with **string** comparisons against a canonical `now`, e.g. `record.expiresAt <= now` (`src/api/backend.ts:2954, 2980, 3219, 3245, 3269, 3316, 3037`) and `expires_at > now` in `consumeToken`. `now` is always canonical UTC (`createISODateTime(input.now().toISOString())` → `…Z` with milliseconds).

The smart constructor `createISODateTime` (`src/types/primitives.ts:39-46`) only checks `ISO_DATE_TIME_PATTERN` (`/^\d{4}-\d{2}-\d{2}T/`) and `!Number.isNaN(Date.parse(value))`, then returns the **input string unchanged** — it never normalizes to `Z`. Offset forms (`+14:00`), millisecond-less forms, and other valid-but-non-canonical ISO-8601 strings pass and are stored verbatim.

Caller-supplied `expiresAt` reaches this path through public, schema-validated admin inputs: `downloadIssueInputSchema.expiresAt` (`src/api/validation.ts:452`, `optionalISODateTimeSchema`) → download token `expiresAt` (`src/api/backend.ts:2229-2230`), and `entitlementGrantInputSchema.expiresAt` → entitlement `currentPeriodEnd` (`src/api/backend.ts:2319`). The branded-string schema (`src/api/validation.ts`) only calls `createISODateTime` and returns its result, adding no normalization.

## Violated Invariant Or Contract

For `expiresAt <= now` to mean "the instant `expiresAt` is at or before the instant `now`", both operands must be in the same canonical lexicographically-orderable form (UTC `Z`). `createISODateTime` accepts values for which lexicographic order diverges from chronological order.

## Oracle

The comparison sites assume canonical-`Z` operands (every internally-produced timestamp uses `toISOString()` / `addMilliseconds`, which always emit `…Z`). The constructor is the single boundary that is supposed to guarantee the stored form; it does not.

## Counterexample

- `now = "2026-06-29T10:00:00.000Z"`.
- Admin issues a download token (or grants an entitlement) with `expiresAt = "2026-06-29T23:00:00+14:00"`. Its real instant is `2026-06-29T09:00:00Z` — already 1 hour in the past (genuinely expired). It passes `createISODateTime` (pattern matches, `Date.parse` valid).
- Sink: `"2026-06-29T23:00:00+14:00" <= "2026-06-29T10:00:00.000Z"` compares the hour digit `'2'`(0x32) vs `'1'`(0x31) → token string is lexicographically greater → comparison is **false** → `downloadTokenError` does not return `TOKEN_EXPIRED` → an already-expired token is served as valid. The same mis-ordering on `currentPeriodEnd` (`src/api/backend.ts:3037`) keeps an actually-expired entitlement reported active.
- Even without an offset: `expiresAt = "2026-06-29T10:00:00Z"` (no milliseconds) vs `now = "2026-06-29T10:00:00.000Z"` compares greater because `'Z'`(0x5A) > `'.'`(0x2E), so two strings denoting the same instant disagree at the boundary.

## Why It Might Matter

Capability tokens (download grants) and entitlements can be honored past their real expiry, or rejected before it, depending on the supplied format — a correctness/access-window defect on a security-relevant boundary, triggered through a public admin input field.

## Proof

Static dataflow: caller input → schema (no normalization) → `createISODateTime` (validate-only cast) → `expires_at TEXT` column stored verbatim → string `<=`/`>` comparison against a canonical `now`. Counterexample digits demonstrate lexicographic vs chronological divergence.

## Counterevidence Checked

- zod `brandedStringSchema` delegates to `createISODateTime` and returns its result — no normalization layer.
- The storage column is plain text written verbatim; no DB canonicalization.
- Internally-generated expiries (`addMilliseconds`, `toISOString`) are always canonical `Z`, so the bug only fires when a caller supplies `expiresAt` explicitly on `download.issue` / `entitlement.grant`.
- Strongest false-positive reason: in practice callers often derive `expiresAt` from `new Date(...).toISOString()` (canonical), so the malformed path requires an admin to pass a non-`Z` value. It is reachable (both are public validated fields) but caller-gated — hence P2, not P1.

## Suggested Next Step

Normalize inside `createISODateTime` (return `new Date(value).toISOString()` after validation) so all stored timestamps are canonical UTC `Z`, guaranteeing lexicographic order matches chronological order at every comparison site.

## Agent Handoff

After working this report, preserve the original finding body. Update line 2 `DEVANA-STATE:` and the final `DEVANA-SUMMARY:` prefix. Keep `DEVANA-KEY:` stable unless the same finding moved.

## Status Notes

- 2026-06-29: open by Devana. Verified `createISODateTime` returns the input unchanged (`src/types/primitives.ts:39-46`) and that `expiresAt` flows from `downloadIssueInputSchema`/`entitlementGrantInputSchema` into string comparisons.
- 2026-06-30: fixed (chosen approach exactly as the report's Suggested Next Step: canonicalize inside the smart constructor). `createISODateTime` (`src/types/primitives.ts`) now returns `new Date(dateTime).toISOString()` after the existing validate-only checks (pattern + `Date.parse`), so every constructed/stored timestamp is canonical UTC `Z` with milliseconds and the lexicographic order used by the string expiry comparisons (`record.expiresAt <= now`, `expires_at > now`) always matches chronological order. The validation itself is unchanged; only the return is canonicalized. No `RangeError` risk: the pattern requires a 4-digit year (0000–9999), well inside `toISOString`'s range, and `Date.parse` non-NaN guarantees `new Date(...)` is valid. Idempotent for values already produced by `toISOString()`/`addMilliseconds` (the source of every internally-generated timestamp), so internal timestamps are byte-unchanged. BLAST RADIUS validated: `createISODateTime` is the most-used primitive constructor, yet the full suite (379) and both tsc configs pass with the change AND with ZERO edits to any existing assertion — i.e. nothing relied on verbatim non-canonical round-tripping (the bug was latent precisely because no internal path produced a non-canonical value). The hash/proof/idempotency suites pass too: canonicalization happens at the single construction boundary, so any timestamp that participates in a proof/hash goes through it on both sides and stays consistent. Evidence — two layers, both mutation-verified (cp-backup + restore, NO git): (1) unit tests on `createISODateTime` (`test/index.test.ts`): a `+14:00` offset value normalizes to its real `Z` instant (`2026-06-29T23:00:00+14:00` → `2026-06-29T09:00:00.000Z`), a second-precision `Z` value gains `.000`, an already-canonical value is unchanged (idempotent), and invalid values still throw; (2) a behavioral test on the real download sink (`test/backend.test.ts`): a download token issued with `expiresAt = "2026-01-01T13:00:00+14:00"` (real instant `2025-12-31T23:00:00Z`, already past `TEST_NOW` `2026-01-01T00:00:00.000Z`, but lexicographically AFTER it when stored verbatim) is correctly resolved as `TOKEN_EXPIRED` (HTTP 410) — the issuance helper routes `expiresAt` through `createISODateTime`, so the token is canonicalized before storage exactly as the public `download.issue`/`entitlement.grant` schema paths (`optionalISODateTimeSchema` → `createISODateTime`) do. With the canonicalization neutered to `return dateTime`, the two offset/precision unit tests AND the behavioral test FAIL (the expired token is served as valid — the exact reported defect); restored via cp and re-confirmed green. Out of scope (NOT changed, documented): a timezone-LESS input (e.g. `2026-06-29T10:00:00`, no offset/`Z`) is interpreted by `Date.parse`/`new Date` as LOCAL time and canonicalized to a runtime-timezone-dependent UTC instant — this ambiguity is pre-existing (`Date.parse` of a zoneless string was already local) and not introduced by canonicalization, which still yields a canonical-`Z`, comparison-safe stored value; tightening the validator to require an explicit offset/`Z` could be a separate follow-up. Review corroborated completeness by construction: the `ISODateTime` brand + this single constructor + zero `as ISODateTime` casts anywhere else in `src` mean no timestamp can reach a string-comparison expiry sink uncanonicalized — covering not just the two reported sinks but also entitlement `currentPeriodEnd <= now` (`src/api/backend.ts`, reached via `download.resolve`), whose writers (`grantInput.expiresAt`, `isoChild(...)`, `stripeTimestamp(...)`) all route through the constructor or are already canonical. One negligible boundary caveat recorded by review: a 4-digit-year input within ~14h of the year-9999 boundary combined with a large UTC offset canonicalizes to an extended-year `+0YYYYYY` form that sorts before normal years (and would fail re-validation); irrelevant for commerce expiries, noted only for completeness.

DEVANA-KEY: src/types/primitives.ts:39 | non-canonical-isodatetime-expiry-comparison
DEVANA-SUMMARY: fixed | P2 | medium | createISODateTime now canonicalizes to UTC `Z` (`new Date(value).toISOString()`) after validation, so a caller-supplied non-`Z` `expiresAt` is stored in canonical form and the string-based expiry comparisons match real instants — expired download tokens/entitlements are no longer accepted (nor valid ones rejected). Idempotent for internally-generated timestamps; full suite + both tsc green with no existing-assertion changes.
