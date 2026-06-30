/**
 * Compatibility shim for older copied Astro templates that imported form helpers locally.
 * Re-exports hidden-input and redirect helpers unchanged; new templates should import
 * directly from `@bnomei/emdash-mika/astro` so upgrades pick up the supported entrypoint.
 */
export { mikaHiddenInput, mikaRedirectInputs, mikaReturnToInput } from "@bnomei/emdash-mika/astro";
