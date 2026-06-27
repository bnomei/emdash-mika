DEVANA-FINDING: v1
DEVANA-STATE: open | P1 | high | security=no
DEVANA-KEY: src/api/backend.ts:3150-3154 | magic-link-email-post-only-url

# Default magic-link email points at POST-only verify route

## Finding

`requestMagicLink` emails a URL built with `magicLinkUrl`, which targets the plugin `magicLinkVerify` route. That operation is registered as `httpMethod: "POST"` with `transport: "body"`. Email clients open the link with GET, so the default sign-in email link cannot complete verification without host customization.

## Violated Invariant Or Contract

The default queued magic-link email must link to a surface that can consume the token when the recipient clicks it.

## Oracle

`magicLinkVerify` operation definition (`httpMethod: "POST"`, `transport: "body"`); shipped template `magic-link.astro` expects users to land on a page and POST the token via Astro Action, not on the plugin API URL.

## Counterexample

1. User requests magic link via default backend path.
2. Email contains `/_emdash/api/plugins/mika/magic-link/verify?token=…&returnTo=…` from `magicLinkUrl`.
3. User clicks link → browser GET → route handler selects POST-only operation → 405 or no verify.
4. Template flow (`/account/magic-link?token=…` → POST action) is never reached.

## Why It Might Matter

Default magic-link sign-in is broken for hosts using bundled email templates without overriding notification handlers or link builders.

## Proof

**Contract mismatch:** `requestMagicLink` sets `link = magicLinkUrl(ctx, token, safeReturnTo)` (backend.ts:2613) → `mikaPluginRoute("magicLinkVerify", { search: { token, returnTo } })` (3150-3154) vs `magicLinkVerify` POST/body contract (operations.ts:720-726) vs template page POST form (magic-link.astro:35-39).

## Counterevidence Checked

Hosts can override email templates or notification handlers. No GET handler exists for verify in this package. `public: false` on the route does not fix method mismatch.

## Suggested Next Step

Point default `magicLinkUrl` at a host page route (e.g. `/account/magic-link`) or add a GET-capable verify entry that redirects after session bind.

## Agent Handoff

After working this report, preserve the original finding body. Update line 2 `DEVANA-STATE: ...` and the final `DEVANA-SUMMARY:` status/priority/confidence prefix. Use one of: `open`, `fixed`, `invalid`, `stale`, `duplicate`, `wontfix`. Keep `DEVANA-KEY:` stable unless the same finding moved. Add dated notes below with evidence checked.

## Status Notes

- 2026-06-27: open by Devana. Initial report written from static source inspection.

DEVANA-KEY: src/api/backend.ts:3150-3154 | magic-link-email-post-only-url
DEVANA-SUMMARY: open | P1 | high | Default magic-link emails link to a POST-only plugin verify route, so email clicks cannot complete sign-in without host overrides.