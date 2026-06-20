import type { MikaActionDefinitions } from "./operations";

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

export function mikaActionTreeDefinitionKeys(
  spec: MikaActionTreeSpec = mikaActionTreeSpec,
): readonly MikaActionDefinitionKey[] {
  return Object.values(spec).flatMap((value) =>
    typeof value === "string" ? [value] : mikaActionTreeDefinitionKeys(value),
  );
}
