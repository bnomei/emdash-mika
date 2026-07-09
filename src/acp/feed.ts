/**
 * ACP product feed: build, validate, and serialize catalog entries for agent discovery.
 */
import { omitUndefined } from "../internal/object";
import type { SellableDTO, VariantOptionValueDTO } from "../api/types";
import type { MikaId } from "../types/primitives";
import type {
  MikaAcpDescription,
  MikaAcpFeedProductInput,
  MikaAcpFileUploadProductRow,
  MikaAcpFileUploadRowsInput,
  MikaAcpProductFeed,
  MikaAcpValidationIssue,
  MikaAcpVariantOption,
} from "./types";

/** Builds an ACP product feed from Mika sellables and active prices for agent discovery. */
export function createMikaAcpProductFeed(input: {
  readonly targetCountry?: string;
  readonly products: readonly MikaAcpFeedProductInput[];
}): MikaAcpProductFeed {
  return {
    ...(input.targetCountry ? { target_country: input.targetCountry } : {}),
    products: input.products.flatMap((product) => {
      const variants = product.sellables.flatMap((sellable) =>
        sellable.prices
          .filter((price) => price.active)
          .map((price) =>
            omitUndefined({
              id: `${sellable.id}:${price.id}`,
              title: priceTitle(sellable, price.id),
              ...(product.description ? { description: product.description } : {}),
              ...(product.url ? { url: product.url } : {}),
              price: {
                amount: price.amount,
                currency: price.currency,
              },
              availability: acpAvailability(sellable),
              variant_options: acpVariantOptions(sellable.variantOptions),
              ...(sellable.imageRef
                ? { media: [{ type: "image" as const, url: sellable.imageRef }] }
                : {}),
              ...(product.seller ? { seller: product.seller } : {}),
            }),
          ),
      );
      if (variants.length === 0) return [];

      return [
        {
          id: product.id,
          ...(product.title ? { title: product.title } : {}),
          ...(product.description ? { description: product.description } : {}),
          ...(product.url ? { url: product.url } : {}),
          ...(product.media ? { media: product.media } : {}),
          variants,
        },
      ];
    }),
  };
}

/**
 * Format a minor-unit amount as the merchant-feed `price` string `"<decimal> <ISO currency>"`
 * (e.g. `"12.00 EUR"`). The file-upload / Google-Merchant catalog convention is a DECIMAL major-unit
 * value, not the raw integer minor units, so divide by the currency's fraction digits — matching the
 * package's other money→string renderers (astro.ts, email.ts, ProductStructuredData.astro).
 */
function acpFeedPriceString(amount: number, currency: string): string {
  const fractionDigits =
    new Intl.NumberFormat("en", { style: "currency", currency }).resolvedOptions()
      .maximumFractionDigits ?? 2;
  return `${(amount / 10 ** fractionDigits).toFixed(fractionDigits)} ${currency}`;
}

/** Flattens sellables into ACP file-upload catalog rows for merchant feed ingestion. */
export function createMikaAcpFileUploadRows(
  input: MikaAcpFileUploadRowsInput,
): readonly MikaAcpFileUploadProductRow[] {
  return input.products.flatMap((product) =>
    product.sellables.flatMap((sellable) =>
      sellable.prices
        .filter((price) => price.active)
        .map((price) => ({
          is_eligible_search: true,
          is_eligible_checkout: input.checkoutEnabled ?? false,
          item_id: `${sellable.id}:${price.id}`,
          title: priceTitle(sellable, price.id),
          description: descriptionText(product.description) || product.title || sellable.title,
          url: requiredProductField(product.url, "url"),
          brand: input.brand,
          image_url: requiredProductField(
            sellable.imageRef ?? product.media?.[0]?.url,
            "image_url",
          ),
          price: acpFeedPriceString(price.amount, price.currency),
          availability: acpFileAvailability(sellable),
          seller_name: input.sellerName,
          seller_url: input.sellerUrl,
          return_policy: input.returnPolicy,
          target_countries: input.targetCountries.join(","),
          store_country: input.storeCountry,
          ...(input.checkoutEnabled && input.sellerPrivacyPolicy
            ? { seller_privacy_policy: input.sellerPrivacyPolicy }
            : {}),
          ...(input.checkoutEnabled && input.sellerTos ? { seller_tos: input.sellerTos } : {}),
        })),
    ),
  );
}

/** Serializes ACP file-upload catalog rows to newline-delimited JSON for merchant feeds. */
export function serializeMikaAcpFileUploadRows(
  rows: readonly MikaAcpFileUploadProductRow[],
): string {
  return rows.map((row) => JSON.stringify(row)).join("\n");
}

/** Validates an ACP product feed and returns structural issues with JSON paths. */
export function validateMikaAcpProductFeed(
  feed: MikaAcpProductFeed,
): readonly MikaAcpValidationIssue[] {
  const issues: MikaAcpValidationIssue[] = [];

  feed.products.forEach((product, productIndex) => {
    const productPath = `$.products[${productIndex}]`;
    if (!product.id) issues.push({ path: `${productPath}.id`, message: "Product id is required." });
    if (product.url) validateUrl(product.url, `${productPath}.url`, issues);
    if (!product.variants.length) {
      issues.push({
        path: `${productPath}.variants`,
        message: "At least one variant is required.",
      });
    }
    product.media?.forEach((media, mediaIndex) =>
      validateUrl(media.url, `${productPath}.media[${mediaIndex}].url`, issues),
    );

    product.variants.forEach((variant, variantIndex) => {
      const variantPath = `${productPath}.variants[${variantIndex}]`;
      if (!variant.id)
        issues.push({ path: `${variantPath}.id`, message: "Variant id is required." });
      if (!variant.title) {
        issues.push({ path: `${variantPath}.title`, message: "Variant title is required." });
      }
      if (variant.url) validateUrl(variant.url, `${variantPath}.url`, issues);
      if (variant.price && (!Number.isInteger(variant.price.amount) || variant.price.amount < 0)) {
        issues.push({
          path: `${variantPath}.price.amount`,
          message: "Price amount must be a non-negative integer.",
        });
      }
      variant.media?.forEach((media, mediaIndex) =>
        validateUrl(media.url, `${variantPath}.media[${mediaIndex}].url`, issues),
      );
      variant.seller?.links.forEach((link, linkIndex) =>
        validateUrl(link.url, `${variantPath}.seller.links[${linkIndex}].url`, issues),
      );
    });
  });

  return issues;
}

/** Serializes a validated ACP product feed to pretty-printed JSON. */
export function serializeMikaAcpProductFeed(feed: MikaAcpProductFeed): string {
  const issues = validateMikaAcpProductFeed(feed);
  if (issues.length > 0) {
    throw new Error(`ACP product feed is invalid: ${issues[0]!.path} ${issues[0]!.message}`);
  }

  return JSON.stringify(feed, null, 2);
}

export function priceTitle(sellable: SellableDTO, priceId: MikaId): string {
  if (sellable.prices.length <= 1) return sellable.title;
  const price = sellable.prices.find((candidate) => candidate.id === priceId);

  return price?.mode === "subscription"
    ? `${sellable.title} subscription`
    : `${sellable.title} purchase`;
}

export function descriptionText(description: MikaAcpDescription | undefined): string | undefined {
  return description?.plain ?? description?.markdown ?? stripHtml(description?.html);
}

export function stripHtml(input: string | undefined): string | undefined {
  return (
    input
      ?.replace(/<[^>]*>/g, " ")
      .replace(/\s+/g, " ")
      .trim() || undefined
  );
}

export function requiredProductField(value: string | undefined, field: string): string {
  if (!value) throw new Error(`ACP file-upload row requires ${field}.`);

  return value;
}

/** The subset of MikaAcpAvailability.status that acpAvailability actually produces. */
export type AcpProducedStatus = "in_stock" | "backorder" | "out_of_stock";

export function acpAvailability(sellable: SellableDTO): {
  readonly available: boolean;
  readonly status: AcpProducedStatus;
} {
  const status = sellable.availability?.status;

  if (!sellable.active || status === "out_of_stock" || status === "manual") {
    return { available: false, status: "out_of_stock" };
  }

  if (status === "backorder") {
    return { available: true, status: "backorder" };
  }

  if (status === "untracked") {
    return { available: true, status: "in_stock" };
  }

  const available = sellable.availability?.availableQuantity !== 0;

  return {
    available,
    status: available ? "in_stock" : "out_of_stock",
  };
}

export function acpFileAvailability(
  sellable: SellableDTO,
): MikaAcpFileUploadProductRow["availability"] {
  // Exhaustive over AcpProducedStatus (enforced by noImplicitReturns): a newly produced status fails
  // the build. The row's "pre_order" wire value stays in the type union but is not produced here.
  switch (acpAvailability(sellable).status) {
    case "in_stock":
      return "in_stock";
    case "backorder":
      return "backorder";
    case "out_of_stock":
      return "out_of_stock";
  }
}

export function acpVariantOptions(
  options: readonly VariantOptionValueDTO[],
): readonly MikaAcpVariantOption[] | undefined {
  const values = options.map((option) => ({
    name: option.label ?? option.option,
    value: option.value,
  }));

  return values.length > 0 ? values : undefined;
}

export function validateUrl(url: string, path: string, issues: MikaAcpValidationIssue[]): void {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      issues.push({ path, message: "URL must use http or https." });
    }
  } catch {
    issues.push({ path, message: "URL must be valid." });
  }
}
