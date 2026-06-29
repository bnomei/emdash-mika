/**
 * Serialized form-field contracts for purchase buttons and checkout customer fields.
 * Keeps HTML form values aligned with operation input schemas.
 */
export interface MikaPurchaseFieldInput {
  readonly sellableId: string;
  readonly priceId?: string | null;
}

/** Parsed sellable/price pair from a purchase hidden field or query string. */
export interface MikaParsedPurchaseField {
  readonly sellableId?: string;
  readonly priceId?: string;
}

/** Optional checkout customer fields collected from HTML forms. */
export interface MikaCheckoutCustomerFields {
  readonly email?: string;
  readonly name?: string;
  readonly company?: string;
  readonly vatId?: string;
}

/** Encodes purchase intent as URL search params for hidden inputs. */
export function serializeMikaPurchaseField(input: MikaPurchaseFieldInput): string {
  const params = new URLSearchParams({ sellableId: input.sellableId });
  if (input.priceId) params.set("priceId", input.priceId);

  return params.toString();
}

/** Decodes a serialized purchase field value. */
export function parseMikaPurchaseField(value: string | null | undefined): MikaParsedPurchaseField {
  if (!value) return {};

  const params = new URLSearchParams(value);

  return {
    sellableId: nonEmptyString(params.get("sellableId")),
    priceId: nonEmptyString(params.get("priceId")),
  };
}

/** Drops empty customer fields; returns `undefined` when all fields are absent. */
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
