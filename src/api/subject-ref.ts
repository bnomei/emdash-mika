/**
 * Stable subject references used to bind capability tokens to customers, users, emails, or sessions.
 */
import { createMikaId, type MikaId } from "../types/primitives";

export type SubjectRef =
  | { readonly kind: "customer"; readonly id: MikaId }
  | { readonly kind: "user"; readonly id: string }
  | { readonly kind: "email"; readonly id: string }
  | { readonly kind: "session"; readonly id: string };

export function formatSubjectRef(ref: SubjectRef): string {
  return `${ref.kind}:${ref.id}`;
}

export function parseSubjectRef(value: string): SubjectRef | null {
  const separator = value.indexOf(":");
  if (separator <= 0) return null;

  const kind = value.slice(0, separator);
  const id = value.slice(separator + 1);
  if (!id) return null;

  switch (kind) {
    case "customer":
      return { kind, id: createMikaId(id) };
    case "user":
    case "email":
    case "session":
      return { kind, id };
    default:
      return null;
  }
}
