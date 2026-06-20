export interface MikaPurchaseFieldInput {
  readonly sellableId: string;
  readonly priceId?: string | null;
}

export interface MikaParsedPurchaseField {
  readonly sellableId?: string;
  readonly priceId?: string;
}

export interface MikaCheckoutCustomerFields {
  readonly email?: string;
  readonly name?: string;
  readonly company?: string;
  readonly vatId?: string;
}

export function serializeMikaPurchaseField(input: MikaPurchaseFieldInput): string {
  const params = new URLSearchParams({ sellableId: input.sellableId });
  if (input.priceId) params.set("priceId", input.priceId);

  return params.toString();
}

export function parseMikaPurchaseField(value: string | null | undefined): MikaParsedPurchaseField {
  if (!value) return {};

  const params = new URLSearchParams(value);

  return {
    sellableId: nonEmptyString(params.get("sellableId")),
    priceId: nonEmptyString(params.get("priceId")),
  };
}

export function normalizeMikaCheckoutCustomer(
  input: MikaCheckoutCustomerFields,
): MikaCheckoutCustomerFields | undefined {
  if (!input.email && !input.name && !input.company && !input.vatId) return undefined;

  return {
    email: input.email,
    name: input.name,
    company: input.company,
    vatId: input.vatId,
  };
}

function nonEmptyString(value: string | null): string | undefined {
  return value && value.length > 0 ? value : undefined;
}
