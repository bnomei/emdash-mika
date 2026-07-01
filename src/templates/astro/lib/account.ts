/**
 * Account view helpers for the copyable Astro storefront template.
 * Extends core {@link AccountDTO} with license rows for downloads and account pages.
 */
import type { AccountDTO } from "@bnomei/emdash-mika/types";

/** License row rendered on account licenses and downloads pages. */
export interface MikaTemplateAccountLicense {
  readonly id: string;
  readonly title: string;
  readonly status: string;
  /** Truncated license key suffix shown in the account UI. */
  readonly displayKeySuffix?: string;
  /** Originating order id for entitlement traceability. */
  readonly orderId?: string;
  /** Resolved download link when the license grants file access. */
  readonly downloadHref?: string;
}

/** Account payload enriched with optional license rows for template rendering. */
export type MikaTemplateAccountDTO = AccountDTO & {
  readonly licenses?: readonly MikaTemplateAccountLicense[];
};

/**
 * Narrows a core account DTO to the template account shape.
 * Hosts may attach `licenses` before rendering; this helper documents the expected extension.
 */
export function mikaTemplateAccount(account: AccountDTO): MikaTemplateAccountDTO {
  return account as MikaTemplateAccountDTO;
}
