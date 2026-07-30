/** Plain JSON objects only — no arrays, null, or exotic prototypes. */
export function asPlainObject(value: unknown, location: string): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  ) {
    throw new TypeError(`${location} must be a plain object`);
  }
  return value as Record<string, unknown>;
}

/** Require an exact key set (no extras, no missing). */
export function assertExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
  location: string,
): void {
  const actual = Object.keys(value);
  if (actual.length !== keys.length || keys.some((key) => !(key in value))) {
    throw new TypeError(`${location} must contain exactly: ${keys.join(", ")}`);
  }
}

export function asSafeInteger(
  value: unknown,
  location: string,
  minimum = 0,
  maximum = Number.MAX_SAFE_INTEGER,
): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new TypeError(`${location} is outside its allowed integer range`);
  }
  return value as number;
}

export function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => key in value);
}
