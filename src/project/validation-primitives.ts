// biome-ignore-all lint/complexity/useLiteralKeys: Exact runtime validation protects persisted project JSON.
import { ContractValidationError } from "../contracts/errors.js";

export const hashPattern = /^[a-f0-9]{64}$/iu;
export const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
export const colorPattern = /^#[a-f0-9]{6}$/iu;

export function invalid(code: string, message: string): never {
  throw new ContractValidationError(code, message);
}

export function object(value: unknown, location: string): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  ) {
    invalid("invalid_shape", `${location} must be an object`);
  }
  return value as Record<string, unknown>;
}

export function exact(
  value: Record<string, unknown>,
  requiredKeys: readonly string[],
  location: string,
  optionalKeys: readonly string[] = [],
): void {
  const allowedKeys = [...requiredKeys, ...optionalKeys];
  if (Object.getOwnPropertySymbols(value).length > 0)
    invalid("unknown_field", `${location} cannot contain symbol fields`);
  for (const key of Object.getOwnPropertyNames(value))
    if (!allowedKeys.includes(key))
      invalid("unknown_field", `${location} has unknown field: ${key}`);
  for (const key of requiredKeys)
    if (!Object.hasOwn(value, key))
      invalid("missing_field", `${location} is missing required own field: ${key}`);
}

export function identifier(value: unknown, location: string): string {
  if (typeof value !== "string" || !identifierPattern.test(value)) {
    invalid("invalid_identifier", `${location} must be a safe identifier`);
  }
  return value;
}

export function text(value: unknown, location: string, maxLength = 500): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maxLength ||
    [...value].some((character) => character.charCodeAt(0) <= 31 || character.charCodeAt(0) === 127)
  )
    invalid("invalid_string", `${location} must be safe non-empty text`);
  return value;
}

export function integer(
  value: unknown,
  location: string,
  minimum = 0,
  maximum = Number.MAX_SAFE_INTEGER,
): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    invalid("invalid_integer", `${location} is outside its allowed range`);
  }
  return value as number;
}

export function number(value: unknown, location: string, minimum: number, maximum: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum) {
    invalid("invalid_number", `${location} is outside its allowed range`);
  }
  return value;
}

export function oneOf<T extends string | number>(
  value: unknown,
  values: readonly T[],
  location: string,
): T {
  if (!values.includes(value as T))
    invalid("invalid_literal", `${location} has an unsupported value`);
  return value as T;
}

export function hash(value: unknown, location: string): string {
  const digest = text(value, location, 64);
  if (!hashPattern.test(digest)) invalid("invalid_hash", `${location} must be a SHA-256 digest`);
  return digest.toLowerCase();
}

export function boundedArray(value: unknown, location: string, maximum: number): unknown[] {
  if (
    !Array.isArray(value) ||
    value.length > maximum ||
    Object.keys(value).length !== value.length ||
    !Array.from({ length: value.length }, (_, index) => Object.hasOwn(value, index)).every(Boolean)
  )
    invalid("invalid_array", `${location} must be a bounded array`);
  return value;
}

export function unique(values: readonly string[], location: string): void {
  if (new Set(values).size !== values.length)
    invalid("duplicate_identifier", `${location} contains duplicate identifiers`);
}

export function range(
  value: unknown,
  location: string,
  minimum: number,
  maximum: number,
): { startUs: number; endUs: number } {
  const parsed = object(value, location);
  exact(parsed, ["startUs", "endUs"], location);
  const startUs = integer(parsed["startUs"], `${location}.startUs`, minimum, maximum);
  const endUs = integer(parsed["endUs"], `${location}.endUs`, minimum + 1, maximum);
  if (endUs <= startUs) invalid("invalid_range", `${location}.endUs must be after startUs`);
  return { startUs, endUs };
}

export function noOverlaps(
  regions: readonly { startUs: number; endUs: number }[],
  location: string,
): void {
  for (let index = 1; index < regions.length; index += 1) {
    if (
      (regions[index - 1] as { endUs: number }).endUs >
      (regions[index] as { startUs: number }).startUs
    ) {
      invalid("overlapping_regions", `${location} must be ordered and non-overlapping`);
    }
  }
}
