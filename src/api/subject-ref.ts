/**
 * Stable subject references used to bind capability tokens to customers, users, emails, or sessions.
 */
import { createMikaId, type MikaId } from "../types/primitives";

/** Discriminated subject identity used to bind capability tokens to customers, users, emails, or sessions. */
export type SubjectRef =
  | { readonly kind: "customer"; readonly id: MikaId }
  | { readonly kind: "user"; readonly id: string }
  | { readonly kind: "email"; readonly id: string }
  | { readonly kind: "session"; readonly id: string };

/** Serializes a subject ref to the canonical `kind:id` string form. */
export function formatSubjectRef(ref: SubjectRef): string {
  return `${ref.kind}:${ref.id}`;
}

/** Builds lookup keys for token subject-hash matching from partial identity fields. */
export function subjectHashCandidates(input: {
  readonly customerId?: MikaId;
  readonly userId?: string;
  readonly emailHash?: string;
}): readonly string[] {
  return [
    ...(input.customerId
      ? [input.customerId, formatSubjectRef({ kind: "customer", id: input.customerId })]
      : []),
    ...(input.userId ? [formatSubjectRef({ kind: "user", id: input.userId })] : []),
    ...(input.emailHash
      ? [input.emailHash, formatSubjectRef({ kind: "email", id: input.emailHash })]
      : []),
  ];
}

/** Parses a `kind:id` string into a subject ref; returns null when the value is invalid. */
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
