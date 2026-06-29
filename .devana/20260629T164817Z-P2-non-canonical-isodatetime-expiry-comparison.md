DEVANA-FINDING: v1
DEVANA-STATE: open | P2 | medium | security=no
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

DEVANA-KEY: src/types/primitives.ts:39 | non-canonical-isodatetime-expiry-comparison
DEVANA-SUMMARY: open | P2 | medium | `createISODateTime` validates without canonicalizing, so a caller-supplied non-`Z` `expiresAt` makes string-based expiry comparisons accept expired download tokens / entitlements (or reject valid ones).
