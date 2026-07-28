// biome-ignore-all lint/complexity/useLiteralKeys: Runtime validators intentionally use exact schema keys on untrusted objects.
import { ContractValidationError } from "./errors.js";

export type RecordingRequest = {
  schemaVersion: 1;
  requestId: string;
  url: string;
  objective: string;
  viewport: { width: 1440; height: 900; deviceScaleFactor: 1 };
  output: { width: 1920; height: 1080; fps: 30; format: "mp4" };
  policy: {
    allowPrivateOrigin: boolean;
    allowedOrigins: string[];
    maxAttempts: 2;
  };
};

const requestKeys = [
  "schemaVersion",
  "requestId",
  "url",
  "objective",
  "viewport",
  "output",
  "policy",
] as const;

function asObject(value: unknown, location: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ContractValidationError("invalid_shape", `${location} must be an object`);
  }
  return value as Record<string, unknown>;
}

function assertExactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  location: string,
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      throw new ContractValidationError("unknown_field", `${location} has unknown field: ${key}`);
    }
  }
  for (const key of allowed) {
    if (!(key in value)) {
      throw new ContractValidationError(
        "missing_field",
        `${location} is missing required field: ${key}`,
      );
    }
  }
}

function expectLiteral(
  value: unknown,
  expected: string | number | boolean,
  location: string,
): void {
  if (value !== expected) {
    throw new ContractValidationError(
      "invalid_literal",
      `${location} must equal ${String(expected)}`,
    );
  }
}

function expectString(value: unknown, location: string, maxLength: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength) {
    throw new ContractValidationError("invalid_string", `${location} must be a non-empty string`);
  }
  if (
    value
      .split("")
      .some((character) => character.charCodeAt(0) <= 31 || character.charCodeAt(0) === 127)
  ) {
    throw new ContractValidationError("unsafe_string", `${location} contains a control character`);
  }
  return value;
}

function expectFixedObject<T extends Record<string, unknown>>(
  value: unknown,
  expected: T,
  location: string,
): T {
  const object = asObject(value, location);
  assertExactKeys(object, Object.keys(expected), location);
  for (const [key, expectedValue] of Object.entries(expected)) {
    expectLiteral(object[key], expectedValue as string | number | boolean, `${location}.${key}`);
  }
  return expected;
}

function isPrivateHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replaceAll("[", "").replaceAll("]", "");
  if (
    normalized === "localhost" ||
    normalized.endsWith(".localhost") ||
    normalized.endsWith(".local")
  ) {
    return true;
  }
  if (
    normalized === "::1" ||
    normalized === "0.0.0.0" ||
    normalized.startsWith("fc") ||
    normalized.startsWith("fd")
  ) {
    return true;
  }
  const octets = normalized.split(".").map(Number);
  if (
    octets.length !== 4 ||
    octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)
  ) {
    return false;
  }
  const first = octets[0];
  const second = octets[1];
  return (
    first === 10 ||
    first === 127 ||
    (first === 169 && second === 254) ||
    (first === 172 && second !== undefined && second >= 16 && second <= 31) ||
    (first === 192 && second === 168)
  );
}

function parseAllowedOrigin(value: unknown, location: string, allowPrivateOrigin: boolean): string {
  const raw = expectString(value, location, 512);
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new ContractValidationError(
      "invalid_origin",
      `${location} must be an absolute URL origin`,
    );
  }
  if (
    (parsed.protocol !== "https:" && parsed.protocol !== "http:") ||
    parsed.username.length > 0 ||
    parsed.password.length > 0 ||
    parsed.pathname !== "/" ||
    parsed.search.length > 0 ||
    parsed.hash.length > 0
  ) {
    throw new ContractValidationError(
      "invalid_origin",
      `${location} must be an HTTP(S) origin without credentials`,
    );
  }
  if (isPrivateHostname(parsed.hostname) && !allowPrivateOrigin) {
    throw new ContractValidationError("private_origin", `${location} requires allowPrivateOrigin`);
  }
  return parsed.origin;
}

function validateUrl(
  value: unknown,
  allowedOrigins: readonly string[],
  allowPrivateOrigin: boolean,
): string {
  const raw = expectString(value, "request.url", 2_048);
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new ContractValidationError("invalid_url", "request.url must be an absolute URL");
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new ContractValidationError("unsafe_url", "request.url must use HTTP(S)");
  }
  if (
    parsed.username.length > 0 ||
    parsed.password.length > 0 ||
    parsed.search.length > 0 ||
    parsed.hash.length > 0
  ) {
    throw new ContractValidationError(
      "unsafe_url",
      "request.url cannot contain credentials, query, or fragment",
    );
  }
  if (isPrivateHostname(parsed.hostname) && !allowPrivateOrigin) {
    throw new ContractValidationError("private_origin", "request.url points to a private origin");
  }
  if (!allowedOrigins.includes(parsed.origin)) {
    throw new ContractValidationError(
      "origin_not_allowed",
      "request.url origin is not allowlisted",
    );
  }
  return parsed.toString();
}

export function validateRecordingRequest(value: unknown): RecordingRequest {
  const object = asObject(value, "request");
  assertExactKeys(object, requestKeys, "request");
  expectLiteral(object["schemaVersion"], 1, "request.schemaVersion");
  const requestId = expectString(object["requestId"], "request.requestId", 128);
  const objective = expectString(object["objective"], "request.objective", 2_000);
  expectFixedObject(
    object["viewport"],
    { width: 1440, height: 900, deviceScaleFactor: 1 },
    "request.viewport",
  );
  expectFixedObject(
    object["output"],
    { width: 1920, height: 1080, fps: 30, format: "mp4" },
    "request.output",
  );

  const policy = asObject(object["policy"], "request.policy");
  assertExactKeys(
    policy,
    ["allowPrivateOrigin", "allowedOrigins", "maxAttempts"],
    "request.policy",
  );
  if (typeof policy["allowPrivateOrigin"] !== "boolean") {
    throw new ContractValidationError(
      "invalid_literal",
      "request.policy.allowPrivateOrigin must be a boolean",
    );
  }
  const allowPrivateOrigin = policy["allowPrivateOrigin"];
  expectLiteral(policy["maxAttempts"], 2, "request.policy.maxAttempts");
  if (
    !Array.isArray(policy["allowedOrigins"]) ||
    policy["allowedOrigins"].length === 0 ||
    policy["allowedOrigins"].length > 20
  ) {
    throw new ContractValidationError(
      "invalid_origins",
      "request.policy.allowedOrigins must be a non-empty bounded array",
    );
  }
  const allowedOrigins = policy["allowedOrigins"].map((origin, index) =>
    parseAllowedOrigin(origin, `request.policy.allowedOrigins[${index}]`, allowPrivateOrigin),
  );
  if (new Set(allowedOrigins).size !== allowedOrigins.length) {
    throw new ContractValidationError(
      "duplicate_origin",
      "request.policy.allowedOrigins must not contain duplicates",
    );
  }

  const url = validateUrl(object["url"], allowedOrigins, allowPrivateOrigin);
  return {
    schemaVersion: 1,
    requestId,
    url,
    objective,
    viewport: { width: 1440, height: 900, deviceScaleFactor: 1 },
    output: { width: 1920, height: 1080, fps: 30, format: "mp4" },
    policy: { allowPrivateOrigin, allowedOrigins, maxAttempts: 2 },
  };
}
