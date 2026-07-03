/** Object-shape helpers used to keep exact optional property contracts precise. */

/** Partial patch where explicit `undefined` is intentional and means "clear this field". */
export type ExactPartial<T extends object> = {
  readonly [K in keyof T]?: T[K] | undefined;
};

/** Conditional spread fragment for an optional key under exact optional property contracts. */
export function optionalProperty<const TKey extends PropertyKey, TValue>(
  key: TKey,
  value: TValue | undefined,
): { readonly [K in TKey]?: Exclude<TValue, undefined> } {
  return value === undefined
    ? {}
    : ({ [key]: value } as { readonly [K in TKey]?: Exclude<TValue, undefined> });
}

type DefinedObject<T extends object> = {
  [K in keyof T as undefined extends T[K] ? never : K]: T[K];
} & {
  [K in keyof T as undefined extends T[K] ? K : never]?: Exclude<T[K], undefined>;
};

/** Returns a shallow copy with undefined-valued keys omitted. */
export function omitUndefined<const T extends object>(input: T): DefinedObject<T> {
  return Object.fromEntries(
    Object.entries(input).filter(([, value]) => value !== undefined),
  ) as DefinedObject<T>;
}
