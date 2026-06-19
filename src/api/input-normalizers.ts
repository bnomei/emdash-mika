import type {
  AccountExportDownloadInput,
  AccountExportStatusInput,
  MagicLinkVerifyInput,
  OrderInvoiceInput,
} from "./types";
import { createMikaId } from "../types/primitives";

export function normalizeMagicLinkVerifyInput(
  input: MagicLinkVerifyInput | string,
): MagicLinkVerifyInput {
  return typeof input === "string" ? { token: input } : input;
}

export function normalizeAccountExportInput(input: AccountExportStatusInput | string) {
  return { exportId: typeof input === "string" ? createMikaId(input) : input.exportId };
}

export function normalizeAccountExportDownloadInput(input: AccountExportDownloadInput | string) {
  return typeof input === "string"
    ? { exportId: createMikaId(input) }
    : { exportId: input.exportId, token: input.token };
}

export function normalizeOrderInvoiceInput(input: OrderInvoiceInput | string) {
  return typeof input === "string" ? { orderId: createMikaId(input) } : input;
}
