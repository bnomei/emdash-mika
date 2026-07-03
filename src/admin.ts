/**
 * EmDash admin action definitions and manifests for Mika ops: provider health/sync, stock,
 * webhooks, orders, entitlements, licenses, downloads, and email resend via the actions runner.
 */
import { MIKA_PLUGIN_ID } from "./api/routes";

/** Well-known route serving the Mika admin actions manifest JSON. */
export const MIKA_ACTIONS_MANIFEST_ROUTE = ".well-known/actions";

/** Well-known route executing Mika admin runner actions from the EmDash dashboard. */
export const MIKA_ACTIONS_RUNNER_ROUTE = ".well-known/actions/run";

/** Visual emphasis tier for admin action buttons in the EmDash dashboard. */
export type MikaAdminActionTone = "default" | "positive" | "warning" | "danger" | "info";
/** HTTP method allowed when a field action button invokes a custom route. */
export type MikaAdminActionMethod = "POST" | "PUT" | "PATCH" | "DELETE";
/** EmDash surface where an admin action may appear (dashboard, field editor, or extension). */
export type MikaAdminActionPlacement = "dashboard" | "field" | (string & {});
/** Whether an action runs inline or through the Mika actions runner. */
export type MikaAdminActionMode = "direct" | "runner";
/** EmDash UI surface that must supply context before an action can run. */
export type MikaAdminActionTarget = "dashboard" | "entry" | "field" | "row";
/** Structured target binding describing surfaces, entity kind, and required context. */
export interface MikaAdminActionTargetMetadata {
  readonly surfaces?: readonly MikaAdminActionTarget[];
  readonly kind?: string;
  readonly required?: boolean;
}
/** Target requirement as a single surface, surface list, or structured metadata. */
export type MikaAdminActionTargetRequirement =
  | MikaAdminActionTarget
  | readonly MikaAdminActionTarget[]
  | MikaAdminActionTargetMetadata;
/** Supported input field types for inline admin action forms. */
export type MikaAdminActionInputType =
  | "string"
  | "number"
  | "integer"
  | "boolean"
  | "datetime"
  | "select"
  | "json";
/** Scalar value stored on a select option in an admin action form. */
export type MikaAdminActionInputOptionValue = string | number | boolean;

/** Labeled choice for a select input in an admin action form. */
export interface MikaAdminActionInputOption {
  readonly value: MikaAdminActionInputOptionValue;
  readonly label?: string;
}

/** Single labeled field in an inline admin action form. */
export interface MikaAdminActionInputField {
  readonly name: string;
  readonly label?: string;
  readonly description?: string;
  readonly type?: MikaAdminActionInputType;
  readonly required?: boolean;
  readonly default?: unknown;
  readonly options?: readonly MikaAdminActionInputOption[];
}

/** Inline form schema and submit label for runner-backed admin actions. */
export interface MikaAdminActionInputMetadata {
  readonly mode?: "inline";
  readonly fields: readonly MikaAdminActionInputField[];
  readonly submitLabel?: string;
}

/** Alias for inline form metadata on admin action definitions. */
export type MikaAdminActionFormMetadata = MikaAdminActionInputMetadata;
/** Runner route binding when an admin action executes server-side. */
export type MikaAdminActionRunnerMetadata = true | { readonly route?: string };

/** Progress, success, and error copy shown while an admin action runs. */
export interface MikaAdminActionFeedback {
  readonly progress?: string;
  readonly success?: string;
  readonly error?: string;
}

/** Declarative admin action metadata consumed by EmDash dashboard and field action buttons. */
export interface MikaAdminActionDefinition {
  readonly id: string;
  readonly label: string;
  readonly mode?: MikaAdminActionMode;
  readonly description?: string;
  readonly icon?: string;
  readonly tone?: MikaAdminActionTone;
  readonly confirm?: string;
  readonly placement?: MikaAdminActionPlacement;
  readonly payload?: Record<string, unknown>;
  /** Entry field name whose value is injected into the runner payload. */
  readonly contextKey?: string;
  /** Payload property that receives the context field value. */
  readonly contextValueKey?: string;
  readonly target?: MikaAdminActionTargetRequirement;
  readonly form?: MikaAdminActionFormMetadata;
  readonly disabled?: boolean;
  /** Minimum milliseconds between repeated runs of the same action. */
  readonly cooldownMs?: number;
  readonly feedback?: MikaAdminActionFeedback;
  /** Poll interval while waiting for async admin runner completion. */
  readonly pollIntervalMs?: number;
  /** Maximum poll duration before the UI treats the run as timed out. */
  readonly pollTimeoutMs?: number;
}

type MikaAdminActionDescriptorBase = Omit<MikaAdminActionDefinition, "id" | "target"> & {
  readonly id: MikaAdminActionId | (string & {});
  readonly target?: MikaAdminActionTargetMetadata;
};

/** Runner-mode admin action entry in the EmDash actions manifest. */
export type MikaAdminActionDescriptor = MikaAdminActionDescriptorBase & {
  readonly mode: "runner";
  readonly runner: MikaAdminActionRunnerMetadata;
};

/** Manifest payload listing runner-backed admin actions exposed to the EmDash actions provider. */
export interface MikaAdminActionsManifest {
  readonly actions: readonly MikaAdminActionDescriptor[];
}

/** EmDash actions provider registration for Mika admin runner routes and allowed targets. */
export interface MikaActionsProviderConfig {
  readonly pluginId: string;
  readonly label?: string;
  readonly manifestRoute?: string;
  readonly runnerRoute?: string;
  /** EmDash plugin ids permitted as action targets in the actions provider. */
  readonly allowedTargetPluginIds?: readonly string[];
}

/** Field-editor options wiring an admin action button to the Mika actions runner. */
export interface MikaActionButtonFieldOptions {
  readonly mode?: "run" | "clipboard";
  readonly provider?: string;
  readonly providerLabel?: string;
  readonly runnerRoute?: string;
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

const MIKA_DASHBOARD_ACTION_TARGET = {
  surfaces: ["dashboard"],
  required: true,
} as const satisfies MikaAdminActionTargetMetadata;

const MIKA_ENTRY_FIELD_ACTION_TARGET = {
  surfaces: ["entry", "field"],
  required: true,
} as const satisfies MikaAdminActionTargetMetadata;

const MIKA_FIELD_ROW_ACTION_TARGET = {
  surfaces: ["field", "row"],
  required: true,
} as const satisfies MikaAdminActionTargetMetadata;

const MIKA_STOCK_ITEM_ACTION_TARGET = {
  ...MIKA_FIELD_ROW_ACTION_TARGET,
  kind: "stockItem",
} as const satisfies MikaAdminActionTargetMetadata;

const MIKA_WEBHOOK_ACTION_TARGET = {
  ...MIKA_FIELD_ROW_ACTION_TARGET,
  kind: "webhook",
} as const satisfies MikaAdminActionTargetMetadata;

const MIKA_ORDER_ACTION_TARGET = {
  ...MIKA_FIELD_ROW_ACTION_TARGET,
  kind: "order",
} as const satisfies MikaAdminActionTargetMetadata;

const MIKA_ENTITLEMENT_ACTION_TARGET = {
  ...MIKA_FIELD_ROW_ACTION_TARGET,
  kind: "entitlement",
} as const satisfies MikaAdminActionTargetMetadata;

const MIKA_EMAIL_ACTION_TARGET = {
  ...MIKA_FIELD_ROW_ACTION_TARGET,
  kind: "email",
} as const satisfies MikaAdminActionTargetMetadata;

const MIKA_LICENSE_ACTION_TARGET = {
  ...MIKA_FIELD_ROW_ACTION_TARGET,
  kind: "license",
} as const satisfies MikaAdminActionTargetMetadata;

const MIKA_DOWNLOAD_ACTION_TARGET = {
  ...MIKA_FIELD_ROW_ACTION_TARGET,
  kind: "download",
} as const satisfies MikaAdminActionTargetMetadata;

/** Canonical catalog of Mika admin runner actions (provider, stock, orders, entitlements, etc.). */
export const mikaAdminActionDefinitions = defineMikaAdminActionDefinitions({
  "mika.provider.health": {
    id: "mika.provider.health",
    label: "Check provider",
    mode: "runner",
    placement: "dashboard",
    target: MIKA_DASHBOARD_ACTION_TARGET,
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
    mode: "runner",
    placement: "dashboard",
    target: MIKA_DASHBOARD_ACTION_TARGET,
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
    mode: "runner",
    placement: "dashboard",
    target: MIKA_DASHBOARD_ACTION_TARGET,
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
    mode: "runner",
    placement: "field",
    target: MIKA_ENTRY_FIELD_ACTION_TARGET,
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
    mode: "runner",
    placement: "field",
    target: MIKA_STOCK_ITEM_ACTION_TARGET,
    form: {
      mode: "inline",
      fields: [
        { name: "quantityDelta", label: "Quantity delta", type: "integer", required: true },
        { name: "reason", label: "Reason", type: "string" },
      ],
    },
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
    mode: "runner",
    placement: "field",
    target: MIKA_WEBHOOK_ACTION_TARGET,
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
    mode: "runner",
    placement: "field",
    target: MIKA_ORDER_ACTION_TARGET,
    form: {
      mode: "inline",
      fields: [
        { name: "amount", label: "Amount", type: "number" },
        { name: "reason", label: "Reason", type: "string" },
      ],
    },
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
    mode: "runner",
    placement: "field",
    target: MIKA_ORDER_ACTION_TARGET,
    form: {
      mode: "inline",
      fields: [{ name: "reason", label: "Reason", type: "string" }],
    },
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
    mode: "runner",
    placement: "field",
    target: MIKA_FIELD_ROW_ACTION_TARGET,
    form: {
      mode: "inline",
      fields: [
        { name: "entitlementKey", label: "Entitlement key", type: "string", required: true },
        { name: "customerId", label: "Customer ID", type: "string" },
        { name: "userId", label: "User ID", type: "string" },
        { name: "email", label: "Email", type: "string" },
        { name: "expiresAt", label: "Expires at", type: "datetime" },
      ],
    },
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
    mode: "runner",
    placement: "field",
    target: MIKA_ENTITLEMENT_ACTION_TARGET,
    form: {
      mode: "inline",
      fields: [{ name: "reason", label: "Reason", type: "string" }],
    },
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
    mode: "runner",
    placement: "field",
    target: MIKA_EMAIL_ACTION_TARGET,
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
    mode: "runner",
    placement: "field",
    target: MIKA_LICENSE_ACTION_TARGET,
    form: {
      mode: "inline",
      fields: [{ name: "reason", label: "Reason", type: "string" }],
    },
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
    mode: "runner",
    placement: "field",
    target: MIKA_DOWNLOAD_ACTION_TARGET,
    form: {
      mode: "inline",
      fields: [{ name: "expiresAt", label: "Expires at", type: "datetime" }],
    },
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

/** Stable id union for built-in Mika admin actions. */
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

/**
 * Zero-runtime coverage guard for the manifest id lists: `satisfies` above only checks that every
 * listed id is valid, not that every valid id is listed. This asserts MIKA_DASHBOARD_ACTION_IDS and
 * MIKA_FIELD_ACTION_IDS together cover every MikaAdminActionId, so a new action added to
 * mikaAdminActionDefinitions but not listed in either array collapses this to `never` and fails the
 * build instead of silently dropping from the actions manifest. Mirrors astro-actions.ts's
 * MikaActionsTreeCoverage; relies on MikaAdminActionId being a type alias (a non-distributive
 * conditional) so whole-union coverage is checked.
 */
type MikaAdminManifestActionCoverage = MikaAdminActionId extends
  | (typeof MIKA_DASHBOARD_ACTION_IDS)[number]
  | (typeof MIKA_FIELD_ACTION_IDS)[number]
  ? true
  : never;
const _mikaAdminManifestActionCoverage: MikaAdminManifestActionCoverage = true;
void _mikaAdminManifestActionCoverage;

/** Options for filtering which dashboard and field admin actions appear in a manifest. */
export interface MikaAdminManifestOptions {
  /** When false, dashboard-surface actions are omitted from the manifest. */
  readonly includeDashboardActions?: boolean;
  /** When false, entry/field-surface actions are omitted from the manifest. */
  readonly includeFieldActions?: boolean;
  readonly disabled?: readonly MikaAdminActionId[];
}

/** Builds the EmDash actions provider config with Mika default routes and plugin id. */
export function createMikaActionsProviderConfig(
  options: Partial<MikaActionsProviderConfig> = {},
): MikaActionsProviderConfig {
  return {
    pluginId: options.pluginId ?? MIKA_PLUGIN_ID,
    label: options.label ?? "Mika",
    manifestRoute: options.manifestRoute ?? MIKA_ACTIONS_MANIFEST_ROUTE,
    runnerRoute: options.runnerRoute ?? MIKA_ACTIONS_RUNNER_ROUTE,
    allowedTargetPluginIds: options.allowedTargetPluginIds ?? [],
  };
}

/** Serializes selected Mika admin actions into an EmDash actions manifest document. */
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

/** Merges a built-in admin action definition with field-button overrides for EmDash editors. */
export function createMikaActionButtonOptions(
  actionId: MikaAdminActionId,
  options: Partial<MikaActionButtonFieldOptions> = {},
): MikaActionButtonFieldOptions {
  const action: MikaAdminActionDefinition = mikaAdminActionDefinitions[actionId];
  const provider = options.provider ?? MIKA_PLUGIN_ID;
  const providerLabel = options.providerLabel ?? "Mika";

  return {
    mode: options.mode ?? "run",
    provider,
    providerLabel,
    runnerRoute: options.runnerRoute ?? MIKA_ACTIONS_RUNNER_ROUTE,
    manifestRoute: options.manifestRoute ?? MIKA_ACTIONS_MANIFEST_ROUTE,
    action: options.action ?? actionId,
    route: options.route,
    method: options.method,
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

/** Preset field-button options for the per-entry catalog sync admin action. */
export function createMikaCatalogSyncActionButtonOptions(
  options: Partial<MikaActionButtonFieldOptions> = {},
): MikaActionButtonFieldOptions {
  return createMikaActionButtonOptions("mika.catalog.syncEntry", options);
}

/** Preset field-button options for the stock adjust admin action. */
export function createMikaStockAdjustActionButtonOptions(
  options: Partial<MikaActionButtonFieldOptions> = {},
): MikaActionButtonFieldOptions {
  return createMikaActionButtonOptions("mika.stock.adjust", options);
}

function adminActionDescriptor(
  actionId: MikaAdminActionId,
  disabled: boolean,
): MikaAdminActionDescriptor {
  const action = mikaAdminActionDefinitions[actionId];
  const base = disabled ? { ...action, disabled: true } : action;
  const descriptorBase = adminActionDescriptorBase(base);

  return {
    ...descriptorBase,
    mode: "runner",
    runner: true,
  };
}

function adminActionDescriptorBase(
  action: MikaAdminActionDefinition,
): MikaAdminActionDescriptorBase {
  const { target, ...descriptor } = action;

  return {
    ...descriptor,
    ...(target ? { target: normalizeMikaAdminActionTarget(target) } : {}),
  };
}

function normalizeMikaAdminActionTarget(
  target: MikaAdminActionTargetRequirement,
): MikaAdminActionTargetMetadata {
  if (typeof target === "string") {
    return { surfaces: [target] };
  }
  if (isMikaAdminActionTargetList(target)) {
    return { surfaces: [...new Set(target)] };
  }

  const { surfaces, kind, required } = target;
  return {
    ...(surfaces ? { surfaces } : {}),
    ...(kind ? { kind } : {}),
    ...(required !== undefined ? { required } : {}),
  };
}

function isMikaAdminActionTargetList(
  target: MikaAdminActionTargetRequirement,
): target is readonly MikaAdminActionTarget[] {
  return Array.isArray(target);
}
