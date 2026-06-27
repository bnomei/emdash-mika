/**
 * Astro Actions server registration for the storefront template.
 * Exposes Mika mutations under `server.mika` for form posts and client calls.
 */
import { createMikaActions } from "./mika";

/** Registered Astro Actions map; `mika` holds commerce mutation handlers. */
export const server = {
  mika: createMikaActions(),
};
