DEVANA-FINDING: v1
DEVANA-STATE: resolved | P0 | high | security=yes
DEVANA-KEY: src/api/redirect-policy.ts:17 | return-path-open-redirect

# Same-origin absolute return URL with protocol-relative pathname bypasses sanitizer

## Finding

`mikaSafeReturnPath` rejects inputs that start with `//` but accepts same-origin absolute URLs whose parsed pathname begins with `//`. The function returns only `pathname + search + hash`. Downstream callers wrap the result with `new URL(sanitizedPath, requestOrigin)`, which resolves a `//host/path` pathname as a protocol-relative URL to an attacker-controlled origin.

## Violated Invariant Or Contract

Return-path sanitizer must reject open redirects. Module comment promises rejection of protocol-relative URLs and traversal; checkout and account portal flows rely on `safeRequestReturnPath` for `successPath`, `cancelPath`, and `returnTo`.

## Oracle

Tests block leading `//evil.test/...` and off-origin absolutes but not same-origin absolutes whose pathname is `//evil.test/...`. `checkoutSuccessUrl` uses `new URL(target, ctx.url)` after sanitization.

## Counterexample

Input: `successPath = "https://shop.test//evil.test/done"` with `origin = "https://shop.test"`.

1. `mikaSafeReturnPath` parses URL; `parsed.origin === base.origin` → passes.
2. Returns `//evil.test/done`.
3. `new URL("//evil.test/done", "https://shop.test/checkout")` → `https://evil.test/done`.
4. Stripe `success_url` or post-checkout redirect sends the shopper to `evil.test`.

## Why It Might Matter

Open redirect in checkout success/cancel and account portal return flows; phishing and credential theft after legitimate checkout.

## Proof

**Control-flow trace:** `checkout.start` → `checkoutSuccessUrl` → `safeRequestReturnPath` → `mikaSafeReturnPath` → `new URL(returnedPath, ctx.url)`.

Locations: `src/api/redirect-policy.ts` (`mikaSafeReturnPath` ~17–42, early `startsWith("//")` only at position 0), `src/api/backend.ts` (`checkoutSuccessUrl` ~6821–6832, `safeRequestReturnPath` ~6869–6877).

## Counterevidence Checked

`javascript:` and `data:` rejected by protocol filter; cross-origin absolutes rejected; literal `/account/%2e%2e/admin` blocked by `hasDotPathSegment`. None block same-origin absolute URLs producing `//` pathname prefixes.

## Suggested Next Step

Reject pathnames starting with `//` after URL parsing, or always return paths that cannot be reinterpreted as protocol-relative by `new URL(path, base)`.

## Agent Handoff

After working this report, preserve the original finding body. Update line 2 `DEVANA-STATE: ...` and the final `DEVANA-SUMMARY:` status/priority/confidence prefix.

## Status Notes

- 2026-06-29: open by Devana. Initial report written from static source inspection across security-boundaries and boundaries-oracles trails.
- 2026-06-29: resolved. `mikaSafeReturnPath` now rejects any sanitized result whose path begins with `//` (after URL parsing), returning the safe fallback instead. This closes the bypass where a same-origin absolute URL like `https://shop.test//evil.test/done` parsed to pathname `//evil.test/done` and a downstream `new URL(path, origin)` reinterpreted it as a protocol-relative URL to an attacker origin. Added regression assertions to the open-redirect test covering same-origin absolute URLs with `//` pathnames.

DEVANA-KEY: src/api/redirect-policy.ts:17 | return-path-open-redirect
DEVANA-SUMMARY: resolved | P0 | high | The return-path sanitizer now rejects parsed paths starting with `//`, so same-origin checkout return URLs can no longer be reinterpreted as protocol-relative redirects to an attacker origin.