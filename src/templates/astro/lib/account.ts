// mika-template-version: 0.1.1
/**
 * Account view helpers for the copyable Astro storefront template.
 * Keeps host-provided license rows separate from Mika's core account DTO.
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

/** Override this host-side helper to fetch or project license rows for account templates. */
export async function mikaTemplateAccountLicenses(
  _account: AccountDTO,
): Promise<readonly MikaTemplateAccountLicense[]> {
  return [];
}
