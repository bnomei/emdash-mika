import type { AccountDTO } from "@bnomei/emdash-mika/types";

export interface MikaTemplateAccountLicense {
  readonly id: string;
  readonly title: string;
  readonly status: string;
  readonly displayKeySuffix?: string;
  readonly orderId?: string;
  readonly downloadHref?: string;
}

export type MikaTemplateAccountDTO = AccountDTO & {
  readonly licenses?: readonly MikaTemplateAccountLicense[];
};

export function mikaTemplateAccount(account: AccountDTO): MikaTemplateAccountDTO {
  return account as MikaTemplateAccountDTO;
}
