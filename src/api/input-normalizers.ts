/**
 * Convenience normalizers that accept shorthand string ids for common account operations.
 */
import type {
  AccountExportDownloadInput,
  AccountExportStatusInput,
  MagicLinkVerifyInput,
} from "./types";
import { createMikaId } from "../types/primitives";

/** Accepts a raw token string or structured verify input. */
export function normalizeMagicLinkVerifyInput(
  input: MagicLinkVerifyInput | string,
): MagicLinkVerifyInput {
  return typeof input === "string" ? { token: input } : input;
}

/** Accepts an export id string or structured status input. */
export function normalizeAccountExportInput(input: AccountExportStatusInput | string) {
  return { exportId: typeof input === "string" ? createMikaId(input) : input.exportId };
}

/** Accepts an export id string or structured download input with token. */
export function normalizeAccountExportDownloadInput(input: AccountExportDownloadInput | string) {
  return typeof input === "string"
    ? { exportId: createMikaId(input) }
    : { exportId: input.exportId, token: input.token };
}
