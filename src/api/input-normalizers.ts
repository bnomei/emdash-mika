/**
 * Convenience normalizers that accept shorthand string ids for common account operations.
 */
import type {
  AccountExportDownloadInput,
  AccountExportStatusInput,
  MagicLinkVerifyInput,
} from "./types";

/** Accepts a raw token string or structured verify input. */
export function normalizeMagicLinkVerifyInput(
  input: MagicLinkVerifyInput | string,
): MagicLinkVerifyInput {
  return typeof input === "string" ? { token: input } : input;
}

/**
 * Accepts an export id string or structured status input for {@link account.exportStatus}.
 * String shorthand maps to `{ exportId }`.
 */
export function normalizeAccountExportInput(input: AccountExportStatusInput | string) {
  return { exportId: typeof input === "string" ? input : input.exportId };
}

/**
 * Accepts an export id string or structured download input for {@link account.exportDownload}.
 * String shorthand maps to `{ exportId }`; structured input preserves an optional token.
 */
export function normalizeAccountExportDownloadInput(input: AccountExportDownloadInput | string) {
  return typeof input === "string"
    ? { exportId: input }
    : { exportId: input.exportId, token: input.token };
}
