import { mikaActionDefinitions, type MikaActionDefinitions } from "./operations";

export type MikaActionDefinitionKey = keyof MikaActionDefinitions;
export type MikaActionTreeSpec = {
  readonly [key: string]: MikaActionDefinitionKey | MikaActionTreeSpec;
};

export const mikaActionTreeSpec = {
  catalog: { sellables: "catalogSellables" },
  stock: { availability: "stockAvailability" },
  cart: {
    add: "cartAdd",
    update: "cartUpdate",
    remove: "cartRemove",
    merge: "cartMerge",
    applyCoupon: "cartApplyCoupon",
    removeCoupon: "cartRemoveCoupon",
  },
  wishlist: {
    add: "wishlistAdd",
    remove: "wishlistRemove",
    moveToCart: "wishlistMoveToCart",
    saveForLater: "wishlistSaveForLater",
    merge: "wishlistMerge",
  },
  checkout: { start: "checkoutStart", status: "checkoutStatus" },
  magicLink: { request: "magicLinkRequest", verify: "magicLinkVerify" },
  account: {
    export: "accountExport",
    exportStatus: "accountExportStatus",
    delete: "accountDelete",
    portal: "accountPortal",
  },
  subscription: {
    cancel: "subscriptionCancel",
    change: "subscriptionChange",
    renew: "subscriptionRenew",
  },
} as const satisfies MikaActionTreeSpec;

export function validateMikaActionTreeSpec(
  spec: unknown = mikaActionTreeSpec,
  definitions: Record<string, unknown> = mikaActionDefinitions,
): readonly MikaActionDefinitionKey[] {
  const definitionKeys = new Set(Object.keys(definitions));
  const seen = new Set<string>();
  const keys = collectActionTreeDefinitionKeys(spec, definitionKeys, seen, "mikaActionTreeSpec");
  const missing = [...definitionKeys].filter((key) => !seen.has(key)).sort();

  if (missing.length > 0) {
    throw new Error(`mikaActionTreeSpec is missing action definitions: ${missing.join(", ")}.`);
  }

  return keys;
}

export function mikaActionTreeDefinitionKeys(
  spec: unknown = mikaActionTreeSpec,
): readonly MikaActionDefinitionKey[] {
  return validateMikaActionTreeSpec(spec);
}

function collectActionTreeDefinitionKeys(
  spec: unknown,
  definitions: ReadonlySet<string>,
  seen: Set<string>,
  path: string,
): readonly MikaActionDefinitionKey[] {
  if (!isActionTreeObject(spec)) {
    throw new Error(`${path} must be an object.`);
  }

  const keys: MikaActionDefinitionKey[] = [];

  for (const [key, value] of Object.entries(spec)) {
    const childPath = `${path}.${key}`;
    if (typeof value === "string") {
      if (!definitions.has(value)) {
        throw new Error(`${childPath} references unknown action definition '${value}'.`);
      }
      if (seen.has(value)) {
        throw new Error(`${childPath} duplicates action definition '${value}'.`);
      }
      seen.add(value);
      keys.push(value as MikaActionDefinitionKey);
      continue;
    }

    if (!isActionTreeObject(value)) {
      throw new Error(`${childPath} must be an action key or nested object.`);
    }
    keys.push(...collectActionTreeDefinitionKeys(value, definitions, seen, childPath));
  }

  return keys;
}

function isActionTreeObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
