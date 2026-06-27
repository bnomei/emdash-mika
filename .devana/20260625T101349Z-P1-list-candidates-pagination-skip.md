DEVANA-FINDING: v1
Priority: P1 | Confidence: high | Security-sensitive: no | Status: open
Location: src/storage/repositories.ts:367-412 | Slug: list-candidates-pagination-skip

# listByTypeCandidates drops same-page matches once target is reached

## Finding

When `items.length >= target`, `listByTypeCandidates` advances `cursor` to the next page and breaks, orphaning remaining matching candidates on the current page. Email outbox and workflow lease scanners use this helper.

## Violated Invariant Or Contract

Paginated candidate scans must return every document matching the predicate across pages without skipping in-page matches after the target count is reached.

## Oracle

With `limit=3`, if one storage page contains five due emails, all five must be discoverable across repeated calls using `cursor`.

## Counterexample

1. Page has due emails A–E (ascending `nextAttemptAt`), `target=3`.
2. Loop collects A, B, C; sets `hasMore=true` on D; sets `cursor` to next page offset; breaks.
3. D and E on the current page are never returned.
4. Next call starts at the next page, skipping D and E permanently until they appear on a later page boundary.

## Why It Might Matter

Due emails and leaseable workflows can be delayed indefinitely when multiple candidates share a storage page and `target < page match count`. Affects notification delivery and webhook workflow recovery.

## Proof

**Control-flow trace:** Collect to `target`, set `cursor = page.cursor`, `break` at 402–404 with mid-page cursor. Orphaned IDs never selected.

## Counterevidence Checked

Pagination test only checks eventual discovery when earlier rows are filtered out, not multiple due rows on one page with `limit < dueCount`.

## Suggested Next Step

On break, set cursor to the last returned item's position within the page, or continue scanning the current page before advancing.

## Agent Handoff

After working this report, preserve the original finding body. Update line 2 `Status: ...` and the final `DEVANA-SUMMARY:` status.

## Status Notes

- 2026-06-25: open by Devana. Initial report written from static source inspection.

DEVANA-KEY: src/storage/repositories.ts:367-412 | P1 | list-candidates-pagination-skip
DEVANA-SUMMARY: Status=open | P1 high src/storage/repositories.ts:367-412 - Email and workflow candidate pagination skips remaining matches on the current page when target count is met.