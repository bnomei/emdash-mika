DEVANA-FINDING: v1
DEVANA-STATE: open | P2 | medium | security=no
DEVANA-KEY: src/templates/astro/pages/download/[token].ts:15 | download-get-prefetch-consumption

# Download route consumes single-use token on GET

## Finding

The storefront download page issues `GET /download/[token]`, which calls `download.resolve`. `resolveDownload` consumes the ephemeral token on the first successful resolve before redirecting. Email scanners, link previews, and prefetching clients commonly issue GET requests to links in messages.

## Violated Invariant Or Contract

Single-use download tokens delivered via email should survive benign prefetch until the user explicitly initiates download.

## Oracle

`resolveDownload` calls `consumeToken` before returning `redirectUrl` (`backend.ts:3057-3070`). Route handler is GET-only (`download/[token].ts:10-22`). Tests expect single-use consumption.

## Counterexample

1. `download.ready` email contains `https://shop.example/download/tok_abc`.
2. Mail security scanner GETs the URL first.
3. Token status becomes `consumed`.
4. Customer clicks the link → `TOKEN_USED` / 410.

## Why It Might Matter

Legitimate buyers lose download access when automated link checkers consume the token first.

## Proof

Entrypoint-to-sink trace: GET route → resolve → consume → redirect; first GET wins.

## Counterevidence Checked

Checkout status tokens use `active` status and are not consumed. Magic-link verify is POST-only. No one-time POST-then-redirect pattern for downloads.

## Suggested Next Step

Use POST confirmation for consumption, or multi-use tokens with separate view vs download scopes.

## Agent Handoff

After working this report, preserve the original finding body. Update line 2 `DEVANA-STATE: ...` and the final `DEVANA-SUMMARY:` status/priority/confidence prefix. Use one of: `open`, `fixed`, `invalid`, `stale`, `duplicate`, `wontfix`. Keep `DEVANA-KEY:` stable unless the same finding moved. Add dated notes below with evidence checked.

## Status Notes

- 2026-06-29: open by Devana. Initial report written from static source inspection.

DEVANA-KEY: src/templates/astro/pages/download/[token].ts:15 | download-get-prefetch-consumption
DEVANA-SUMMARY: open | P2 | medium | GET download route consumes single-use tokens before redirect, so email prefetch can burn the link.