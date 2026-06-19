import type { MikaClientOptions } from "./client";
import { mikaPluginRoute, type MikaPluginRouteName } from "./routes";
import {
  MIKA_ERROR_CODES,
  type MikaApiResult,
  type MikaClientEffect,
  type MikaError,
  type MikaErrorCode,
} from "./types";

interface MikaCookieForwardingOptions {
  readonly forwardCrossOriginCookies?: boolean;
}

type MikaRequestOptions = MikaClientOptions & MikaCookieForwardingOptions;

export async function requestMika<TData>(
  route: MikaPluginRouteName,
  init: MikaRequestInit = {},
  options: MikaRequestOptions = {},
): Promise<MikaApiResult<TData>> {
  const fetcher = options.fetch ?? globalThis.fetch;
  const origin = options.baseUrl ?? options.request?.url;
  const url = mikaPluginRoute(route, {
    apiBase: options.apiBase,
    pluginId: options.pluginId,
    origin,
    search: init.search,
  });
  const headers = new Headers(options.headers);
  headers.set("accept", "application/json");

  const cookie = options.request?.headers.get("cookie");
  if (cookie && !headers.has("cookie") && shouldForwardRequestCookie(url, options)) {
    headers.set("cookie", cookie);
  }

  let body: BodyInit | undefined;
  if (init.body !== undefined) {
    headers.set("content-type", "application/json");
    body = JSON.stringify(init.body);
  }

  let response: Response;
  try {
    response = await fetcher(url, {
      method: init.method ?? "GET",
      headers,
      body,
    });
  } catch {
    return {
      ok: false,
      status: 0,
      error: {
        code: "PROVIDER_FAILED",
        message: "Mika request failed.",
      },
    };
  }

  const payload = (await response.json().catch(() => null)) as unknown;

  const result = normalizeMikaApiResult<TData>(payload, response.status);
  if (result) {
    return result;
  }

  if (isRecord(payload)) {
    const nestedResult = normalizeMikaApiResult<TData>(payload["data"], response.status);
    if (nestedResult) {
      return nestedResult;
    }

    if ("error" in payload) {
      return {
        ok: false,
        status: response.status,
        error: normalizeEnvelopeError(payload["error"], response.status),
      };
    }
  }

  return {
    ok: false,
    status: response.status,
    error: {
      code: fallbackMikaErrorCode(response.status),
      message: response.statusText || "Mika request failed.",
    },
  };
}

export interface MikaRequestInit {
  readonly method?: "GET" | "POST" | "PATCH" | "DELETE";
  readonly search?: Record<string, string | number | boolean | undefined>;
  readonly body?: unknown;
}

function shouldForwardRequestCookie(url: string, options: MikaRequestOptions): boolean {
  if (options.forwardCrossOriginCookies) return true;
  if (!options.request) return false;

  const requestUrl = new URL(options.request.url);
  const targetUrl = new URL(url, requestUrl);

  return targetUrl.origin === requestUrl.origin;
}

function normalizeMikaApiResult<TData>(
  value: unknown,
  fallbackStatus: number,
): MikaApiResult<TData> | undefined {
  if (!isRecord(value) || typeof value["ok"] !== "boolean") {
    return undefined;
  }

  if (value["ok"]) {
    if (!("data" in value) || !isStatus(value["status"])) {
      return malformedMikaResponse(fallbackStatus);
    }
    const warnings = normalizeWarnings(value["warnings"]);
    const effects = normalizeEffects(value["effects"]);

    return {
      ok: true,
      status: value["status"],
      data: value["data"] as TData,
      ...(warnings ? { warnings } : {}),
      ...(effects ? { effects } : {}),
    };
  }

  const status = isStatus(value["status"]) ? value["status"] : fallbackStatus;
  const effects = normalizeEffects(value["effects"]);
  return {
    ok: false,
    status,
    error: normalizeEnvelopeError(value["error"], status),
    ...(effects ? { effects } : {}),
  };
}

function normalizeEnvelopeError(error: unknown, status: number): MikaError {
  const envelopeError = isRecord(error) ? error : {};
  const fieldErrors = normalizeFieldErrors(envelopeError["fieldErrors"]);

  return {
    code: isMikaErrorCode(envelopeError["code"])
      ? envelopeError["code"]
      : fallbackMikaErrorCode(status),
    message:
      typeof envelopeError["message"] === "string" && envelopeError["message"].length > 0
        ? envelopeError["message"]
        : "Mika request failed.",
    ...(fieldErrors ? { fieldErrors } : {}),
    ...(typeof envelopeError["retryAfter"] === "number"
      ? { retryAfter: envelopeError["retryAfter"] }
      : {}),
    ...(typeof envelopeError["correlationId"] === "string"
      ? { correlationId: envelopeError["correlationId"] }
      : {}),
  };
}

function malformedMikaResponse<TData>(status: number): MikaApiResult<TData> {
  return {
    ok: false,
    status,
    error: {
      code: fallbackMikaErrorCode(status),
      message: "Malformed Mika response.",
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStatus(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function normalizeWarnings(warnings: unknown): readonly string[] | undefined {
  return Array.isArray(warnings) && warnings.every((warning) => typeof warning === "string")
    ? warnings
    : undefined;
}

function normalizeEffects(effects: unknown): readonly MikaClientEffect[] | undefined {
  return Array.isArray(effects) && effects.every(isMikaClientEffect) ? effects : undefined;
}

function fallbackMikaErrorCode(status: number): MikaErrorCode {
  if (status === 401) return "AUTH_REQUIRED";
  if (status === 403) return "FORBIDDEN";
  if (status === 409) return "CONFLICT";
  if (status === 422) return "VALIDATION_FAILED";
  if (status === 429) return "RATE_LIMITED";
  if (status === 501) return "NOT_IMPLEMENTED";
  return "PROVIDER_FAILED";
}

function isMikaErrorCode(code: unknown): code is MikaErrorCode {
  return typeof code === "string" && (MIKA_ERROR_CODES as readonly string[]).includes(code);
}

function isMikaClientEffect(effect: unknown): effect is MikaClientEffect {
  if (!isRecord(effect) || typeof effect["type"] !== "string") return false;

  if (effect["type"] === "reload") return true;

  if (effect["type"] === "redirect") {
    return typeof effect["url"] === "string" && effect["url"].length > 0;
  }

  if (effect["type"] === "toast") {
    return (
      (effect["tone"] === "success" ||
        effect["tone"] === "warning" ||
        effect["tone"] === "error") &&
      typeof effect["message"] === "string" &&
      effect["message"].length > 0
    );
  }

  return false;
}

function normalizeFieldErrors(fieldErrors: unknown): Record<string, string> | undefined {
  if (typeof fieldErrors !== "object" || fieldErrors === null || Array.isArray(fieldErrors)) {
    return undefined;
  }

  const entries = Object.entries(fieldErrors).filter(
    (entry): entry is [string, string] => typeof entry[1] === "string",
  );

  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}
