/**
 * ACP protocol constants and default timing knobs.
 */

/** ACP API version header value supported by Mika checkout handlers. */
export const MIKA_ACP_API_VERSION = "2025-09-12";

/** Official ACP repository schema snapshot used by Mika's conformance tests. */
export const MIKA_ACP_SCHEMA_SNAPSHOT = "2025-09-29";

/** Default prefix for generated ACP checkout session ids. */
export const MIKA_ACP_DEFAULT_SESSION_PREFIX = "acp_checkout";

export const MIKA_ACP_DEFAULT_SESSION_TTL_MS = 15 * 60_000;
export const MIKA_ACP_DEFAULT_TERMINAL_RETENTION_MS = 24 * 60 * 60_000;
// Must comfortably exceed the slowest handler run, including provider SDK timeouts (80s+ for
// some Stripe operations); an expired-but-live claim reopens the key to concurrent execution.
export const MIKA_ACP_DEFAULT_IDEMPOTENCY_CLAIM_TTL_MS = 120_000;
export const MIKA_ACP_SIGNATURE_TOLERANCE_MS = 5 * 60_000;
// Bounds handleAcpComplete's retry past an incidental expiry write (see
// acpRecordIsOnlyIncidentallyExpired) — a handful of attempts absorbs a few bystander GETs ticking
// the lazy expiry sweep during a slow payment attempt without looping unboundedly.
export const MIKA_ACP_COMPLETE_WRITE_RETRIES = 3;
