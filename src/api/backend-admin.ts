/**
 * Composes the admin namespace of {@link MikaApi} from host-provided handlers with optional overrides.
 */
import type { MikaApi } from "./server";

/** Required admin handler map matching {@link MikaApi.admin}. */
export type MikaAdminBackendHandlers = {
  readonly [K in keyof MikaApi["admin"]]: MikaApi["admin"][K];
};

/** Input for wiring admin operations into a backend API instance. */
export interface CreateMikaAdminBackendInput {
  readonly handlers: MikaAdminBackendHandlers;
  readonly overrides?: Partial<MikaApi["admin"]>;
}

/** Merges admin handlers with optional per-method overrides. */
export function createMikaAdminBackend({
  handlers,
  overrides,
}: CreateMikaAdminBackendInput): MikaApi["admin"] {
  return {
    ...handlers,
    ...overrides,
  };
}
