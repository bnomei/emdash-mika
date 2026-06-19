import { mikaPluginRoutes, MIKA_PLUGIN_ID } from "./api/routes";

export const MIKA_ACTIONS_MANIFEST_ROUTE = ".well-known/actions";

export type MikaAdminActionTone = "default" | "positive" | "warning" | "danger" | "info";
export type MikaAdminActionMethod = "POST" | "PUT" | "PATCH" | "DELETE";
export type MikaAdminActionPlacement = "dashboard" | "field" | (string & {});

export interface MikaAdminActionFeedback {
  readonly progress?: string;
  readonly success?: string;
  readonly error?: string;
}

export interface MikaAdminActionDefinition {
  readonly id: string;
  readonly label: string;
  readonly route: string;
  readonly method?: MikaAdminActionMethod;
  readonly pluginId?: string;
  readonly description?: string;
  readonly icon?: string;
  readonly tone?: MikaAdminActionTone;
  readonly confirm?: string;
  readonly placement?: MikaAdminActionPlacement;
  readonly payload?: Record<string, unknown>;
  readonly contextKey?: string;
  readonly contextValueKey?: string;
  readonly disabled?: boolean;
  readonly cooldownMs?: number;
  readonly feedback?: MikaAdminActionFeedback;
  readonly pollIntervalMs?: number;
  readonly pollTimeoutMs?: number;
}

export type MikaAdminActionDescriptor = Omit<MikaAdminActionDefinition, "id"> & {
  readonly id: MikaAdminActionId | (string & {});
};

export interface MikaAdminActionsManifest {
  readonly actions: readonly MikaAdminActionDescriptor[];
}

export interface MikaActionsProviderConfig {
  readonly pluginId: string;
  readonly label?: string;
  readonly manifestRoute?: string;
  readonly allowedTargetPluginIds?: readonly string[];
}

export interface MikaActionButtonFieldOptions {
  readonly mode?: "run" | "clipboard";
  readonly actionPluginId?: string;
  readonly pluginId?: string;
  readonly actionPluginLabel?: string;
  readonly action?: MikaAdminActionId | (string & {});
  readonly route?: string;
  readonly method?: MikaAdminActionMethod;
  readonly label?: string;
  readonly description?: string;
  readonly icon?: string;
  readonly tone?: MikaAdminActionTone;
  readonly confirm?: string;
  readonly manifestRoute?: string;
  readonly payload?: Record<string, unknown>;
  readonly valueKey?: string;
  readonly contextKey?: string;
  readonly contextValueKey?: string;
  readonly resultValueKey?: string;
  readonly disabled?: boolean;
  readonly cooldownMs?: number;
  readonly feedback?: MikaAdminActionFeedback;
  readonly pollIntervalMs?: number;
  readonly pollTimeoutMs?: number;
}

function defineMikaAdminActionDefinitions<
  const TDefinitions extends Record<string, MikaAdminActionDefinition>,
>(
  definitions: TDefinitions,
): Readonly<Record<keyof TDefinitions & string, MikaAdminActionDefinition>> {
  return definitions;
}

export const mikaAdminActionDefinitions = defineMikaAdminActionDefinitions({
  "mika.provider.health": {
    id: "mika.provider.health",
    label: "Check provider",
    route: mikaPluginRoutes.adminProviderHealth,
    method: "POST",
    placement: "dashboard",
    description: "Checks Mika provider configuration and capabilities.",
    icon: "activity",
    tone: "info",
    feedback: {
      progress: "Checking provider...",
      success: "Provider check completed.",
      error: "Provider check failed.",
    },
  },
  "mika.provider.sync": {
    id: "mika.provider.sync",
    label: "Sync provider",
    route: mikaPluginRoutes.adminProviderSync,
    method: "POST",
    placement: "dashboard",
    description: "Runs a provider product/customer/subscription sync.",
    icon: "refresh",
    tone: "warning",
    confirm: "Run provider sync now?",
    payload: { mode: "dry_run" },
    feedback: {
      progress: "Syncing provider...",
      success: "Provider sync accepted.",
      error: "Provider sync failed.",
    },
    pollIntervalMs: 1500,
    pollTimeoutMs: 60000,
  },
  "mika.stock.releaseExpiredReservations": {
    id: "mika.stock.releaseExpiredReservations",
    label: "Release expired stock",
    route: mikaPluginRoutes.adminStockReleaseExpiredReservations,
    method: "POST",
    placement: "dashboard",
    description: "Releases expired checkout stock reservations.",
    icon: "clock",
    tone: "warning",
    confirm: "Release expired stock reservations?",
    feedback: {
      progress: "Releasing reservations...",
      success: "Expired reservations released.",
      error: "Reservation release failed.",
    },
  },
  "mika.catalog.syncEntry": {
    id: "mika.catalog.syncEntry",
    label: "Sync commerce",
    route: mikaPluginRoutes.adminProviderSync,
    method: "POST",
    placement: "field",
    description: "Syncs Mika sellables, prices, variants, and stock for this entry.",
    icon: "refresh",
    tone: "info",
    contextKey: "context",
    payload: { mode: "dry_run", scope: "entry" },
    feedback: {
      progress: "Syncing commerce data...",
      success: "Commerce data synced.",
      error: "Commerce sync failed.",
    },
  },
  "mika.stock.adjust": {
    id: "mika.stock.adjust",
    label: "Adjust stock",
    route: mikaPluginRoutes.adminStockAdjust,
    method: "POST",
    placement: "field",
    description: "Adjusts stock for a Mika stock item.",
    icon: "plus-minus",
    tone: "warning",
    confirm: "Adjust stock for this item?",
    contextKey: "context",
    feedback: {
      progress: "Adjusting stock...",
      success: "Stock adjusted.",
      error: "Stock adjustment failed.",
    },
  },
  "mika.webhook.replay": {
    id: "mika.webhook.replay",
    label: "Replay webhook",
    route: mikaPluginRoutes.adminWebhookReplay,
    method: "POST",
    placement: "field",
    description: "Replays a failed webhook event.",
    icon: "repeat",
    tone: "warning",
    confirm: "Replay this webhook event?",
    contextKey: "context",
    feedback: {
      progress: "Replaying webhook...",
      success: "Webhook replay accepted.",
      error: "Webhook replay failed.",
    },
  },
  "mika.order.refund": {
    id: "mika.order.refund",
    label: "Refund order",
    route: mikaPluginRoutes.adminOrderRefund,
    method: "POST",
    placement: "field",
    description: "Refunds an order through the configured provider.",
    icon: "arrow-counter-clockwise",
    tone: "danger",
    confirm: "Refund this order?",
    contextKey: "context",
    feedback: {
      progress: "Refunding order...",
      success: "Order refund accepted.",
      error: "Order refund failed.",
    },
  },
  "mika.order.cancel": {
    id: "mika.order.cancel",
    label: "Cancel order",
    route: mikaPluginRoutes.adminOrderCancel,
    method: "POST",
    placement: "field",
    description: "Cancels an order where the provider supports cancellation.",
    icon: "x",
    tone: "danger",
    confirm: "Cancel this order?",
    contextKey: "context",
    feedback: {
      progress: "Cancelling order...",
      success: "Order cancellation accepted.",
      error: "Order cancellation failed.",
    },
  },
  "mika.entitlement.grant": {
    id: "mika.entitlement.grant",
    label: "Grant entitlement",
    route: mikaPluginRoutes.adminEntitlementGrant,
    method: "POST",
    placement: "field",
    description: "Manually grants an entitlement.",
    icon: "key",
    tone: "positive",
    confirm: "Grant this entitlement?",
    contextKey: "context",
    feedback: {
      progress: "Granting entitlement...",
      success: "Entitlement granted.",
      error: "Entitlement grant failed.",
    },
  },
  "mika.entitlement.revoke": {
    id: "mika.entitlement.revoke",
    label: "Revoke entitlement",
    route: mikaPluginRoutes.adminEntitlementRevoke,
    method: "POST",
    placement: "field",
    description: "Revokes a manual or provider-backed entitlement.",
    icon: "keyhole",
    tone: "danger",
    confirm: "Revoke this entitlement?",
    contextKey: "context",
    feedback: {
      progress: "Revoking entitlement...",
      success: "Entitlement revoked.",
      error: "Entitlement revoke failed.",
    },
  },
  "mika.email.resend": {
    id: "mika.email.resend",
    label: "Resend email",
    route: mikaPluginRoutes.adminEmailResend,
    method: "POST",
    placement: "field",
    description: "Queues an email for resend.",
    icon: "envelope",
    tone: "info",
    confirm: "Resend this email?",
    contextKey: "context",
    feedback: {
      progress: "Resending email...",
      success: "Email resend queued.",
      error: "Email resend failed.",
    },
  },
  "mika.license.revoke": {
    id: "mika.license.revoke",
    label: "Revoke license",
    route: mikaPluginRoutes.adminLicenseRevoke,
    method: "POST",
    placement: "field",
    description: "Revokes a license key.",
    icon: "lock",
    tone: "danger",
    confirm: "Revoke this license?",
    contextKey: "context",
    feedback: {
      progress: "Revoking license...",
      success: "License revoked.",
      error: "License revoke failed.",
    },
  },
  "mika.download.issue": {
    id: "mika.download.issue",
    label: "Issue download",
    route: mikaPluginRoutes.adminDownloadIssue,
    method: "POST",
    placement: "field",
    description: "Issues a new download token or download action.",
    icon: "download",
    tone: "info",
    confirm: "Issue a new download?",
    contextKey: "context",
    feedback: {
      progress: "Issuing download...",
      success: "Download issued.",
      error: "Download issue failed.",
    },
  },
});

export type MikaAdminActionId = keyof typeof mikaAdminActionDefinitions;

const MIKA_DASHBOARD_ACTION_IDS = [
  "mika.provider.health",
  "mika.provider.sync",
  "mika.stock.releaseExpiredReservations",
] as const satisfies readonly MikaAdminActionId[];

const MIKA_FIELD_ACTION_IDS = [
  "mika.catalog.syncEntry",
  "mika.stock.adjust",
  "mika.webhook.replay",
  "mika.order.refund",
  "mika.order.cancel",
  "mika.entitlement.grant",
  "mika.entitlement.revoke",
  "mika.email.resend",
  "mika.license.revoke",
  "mika.download.issue",
] as const satisfies readonly MikaAdminActionId[];

export interface MikaAdminManifestOptions {
  readonly includeDashboardActions?: boolean;
  readonly includeFieldActions?: boolean;
  readonly disabled?: readonly MikaAdminActionId[];
}

export function createMikaActionsProviderConfig(
  options: Partial<MikaActionsProviderConfig> = {},
): MikaActionsProviderConfig {
  return {
    pluginId: options.pluginId ?? MIKA_PLUGIN_ID,
    label: options.label ?? "Mika",
    manifestRoute: options.manifestRoute ?? MIKA_ACTIONS_MANIFEST_ROUTE,
    allowedTargetPluginIds: options.allowedTargetPluginIds ?? [],
  };
}

export function createMikaAdminActionsManifest(
  options: MikaAdminManifestOptions = {},
): MikaAdminActionsManifest {
  const disabled = new Set(options.disabled ?? []);
  const ids = [
    ...(options.includeDashboardActions === false ? [] : MIKA_DASHBOARD_ACTION_IDS),
    ...(options.includeFieldActions === false ? [] : MIKA_FIELD_ACTION_IDS),
  ];
  const actions = ids.map((id) => adminActionDescriptor(id, disabled.has(id)));

  return { actions };
}

export function createMikaActionButtonOptions(
  actionId: MikaAdminActionId,
  options: Partial<MikaActionButtonFieldOptions> = {},
): MikaActionButtonFieldOptions {
  const action: MikaAdminActionDefinition = mikaAdminActionDefinitions[actionId];

  return {
    mode: options.mode ?? "run",
    actionPluginId: options.actionPluginId ?? MIKA_PLUGIN_ID,
    pluginId: options.pluginId,
    actionPluginLabel: options.actionPluginLabel ?? "Mika",
    manifestRoute: options.manifestRoute ?? MIKA_ACTIONS_MANIFEST_ROUTE,
    action: options.action ?? actionId,
    route: options.route ?? action.route,
    method: options.method ?? action.method,
    label: options.label ?? action.label,
    description: options.description ?? action.description,
    icon: options.icon ?? action.icon,
    tone: options.tone ?? action.tone,
    confirm: options.confirm ?? action.confirm,
    contextKey: options.contextKey ?? action.contextKey,
    contextValueKey: options.contextValueKey ?? action.contextValueKey,
    payload: options.payload ?? action.payload,
    valueKey: options.valueKey,
    resultValueKey: options.resultValueKey,
    disabled: options.disabled,
    cooldownMs: options.cooldownMs ?? action.cooldownMs,
    feedback: options.feedback ?? action.feedback,
    pollIntervalMs: options.pollIntervalMs ?? action.pollIntervalMs,
    pollTimeoutMs: options.pollTimeoutMs ?? action.pollTimeoutMs,
  };
}

export function createMikaCatalogSyncActionButtonOptions(
  options: Partial<MikaActionButtonFieldOptions> = {},
): MikaActionButtonFieldOptions {
  return createMikaActionButtonOptions("mika.catalog.syncEntry", options);
}

export function createMikaStockAdjustActionButtonOptions(
  options: Partial<MikaActionButtonFieldOptions> = {},
): MikaActionButtonFieldOptions {
  return createMikaActionButtonOptions("mika.stock.adjust", options);
}

function adminActionDescriptor(
  actionId: MikaAdminActionId,
  disabled: boolean,
): MikaAdminActionDescriptor {
  const action: MikaAdminActionDescriptor = mikaAdminActionDefinitions[actionId];
  return disabled ? { ...action, disabled: true } : action;
}
