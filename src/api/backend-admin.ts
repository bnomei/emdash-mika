import type { MikaApi } from "./server";

export type MikaAdminBackendHandlers = {
  readonly [K in keyof MikaApi["admin"]]: MikaApi["admin"][K];
};

export interface CreateMikaAdminBackendInput {
  readonly handlers: MikaAdminBackendHandlers;
  readonly overrides?: Partial<MikaApi["admin"]>;
}

export function createMikaAdminBackend({
  handlers,
  overrides,
}: CreateMikaAdminBackendInput): MikaApi["admin"] {
  return {
    ...handlers,
    ...overrides,
  };
}
