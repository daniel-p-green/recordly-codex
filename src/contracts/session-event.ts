// biome-ignore-all lint/complexity/useLiteralKeys: Runtime validators intentionally use exact schema keys on untrusted objects.
import { ContractValidationError } from "./errors.js";

export type SessionEventType =
  | "frame"
  | "pointer"
  | "click"
  | "scroll"
  | "navigation"
  | "viewport"
  | "marker"
  | "capture_health";

export type SessionEvent = {
  schemaVersion: 1;
  sessionId: string;
  seq: number;
  tUs: number;
  type: SessionEventType;
  data: Record<string, unknown>;
};

function asObject(value: unknown, location: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ContractValidationError("invalid_shape", `${location} must be an object`);
  }
  return value as Record<string, unknown>;
}

function assertExactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
  location: string,
): void {
  for (const key of Object.keys(value)) {
    if (!required.includes(key) && !optional.includes(key)) {
      throw new ContractValidationError("unknown_field", `${location} has unknown field: ${key}`);
    }
  }
  for (const key of required) {
    if (!(key in value)) {
      throw new ContractValidationError(
        "missing_field",
        `${location} is missing required field: ${key}`,
      );
    }
  }
}

function expectString(value: unknown, location: string, maxLength: number): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maxLength ||
    value
      .split("")
      .some((character) => character.charCodeAt(0) <= 31 || character.charCodeAt(0) === 127)
  ) {
    throw new ContractValidationError(
      "invalid_string",
      `${location} must be a safe non-empty string`,
    );
  }
  return value;
}

function expectInteger(value: unknown, location: string, minimum = 0): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) {
    throw new ContractValidationError(
      "invalid_integer",
      `${location} must be an integer at least ${minimum}`,
    );
  }
  return value as number;
}

function expectNumber(value: unknown, location: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new ContractValidationError("invalid_number", `${location} must be a finite number`);
  }
  return value;
}

function validateData(type: SessionEventType, value: unknown): Record<string, unknown> {
  const data = asObject(value, "event.data");
  switch (type) {
    case "frame": {
      assertExactKeys(
        data,
        ["cdpSessionId", "frameId", "receivedAtUs", "imagePath", "sha256", "width", "height"],
        [],
        "event.data",
      );
      expectInteger(data["cdpSessionId"], "event.data.cdpSessionId", 1);
      expectInteger(data["frameId"], "event.data.frameId", 1);
      expectInteger(data["receivedAtUs"], "event.data.receivedAtUs");
      const imagePath = expectString(data["imagePath"], "event.data.imagePath", 512);
      if (
        !imagePath.startsWith("frames/raw/") ||
        imagePath.includes("..") ||
        imagePath.startsWith("/")
      ) {
        throw new ContractValidationError(
          "unsafe_path",
          "event.data.imagePath must be a contained raw-frame path",
        );
      }
      const sha256 = expectString(data["sha256"], "event.data.sha256", 64);
      if (!/^[a-f0-9]{64}$/iu.test(sha256)) {
        throw new ContractValidationError(
          "invalid_hash",
          "event.data.sha256 must be a SHA-256 hex digest",
        );
      }
      expectInteger(data["width"], "event.data.width", 1);
      expectInteger(data["height"], "event.data.height", 1);
      break;
    }
    case "pointer":
      assertExactKeys(data, ["x", "y", "buttons", "source"], [], "event.data");
      expectNumber(data["x"], "event.data.x");
      expectNumber(data["y"], "event.data.y");
      expectInteger(data["buttons"], "event.data.buttons");
      if (data["source"] !== "planned" && data["source"] !== "observed") {
        throw new ContractValidationError(
          "invalid_literal",
          "event.data.source must be planned or observed",
        );
      }
      break;
    case "click":
      assertExactKeys(data, ["x", "y", "button"], ["targetLabel"], "event.data");
      expectNumber(data["x"], "event.data.x");
      expectNumber(data["y"], "event.data.y");
      if (data["button"] !== 0 && data["button"] !== 1 && data["button"] !== 2) {
        throw new ContractValidationError(
          "invalid_literal",
          "event.data.button must be 0, 1, or 2",
        );
      }
      if ("targetLabel" in data) expectString(data["targetLabel"], "event.data.targetLabel", 120);
      break;
    case "scroll":
      assertExactKeys(data, ["x", "y", "deltaX", "deltaY"], [], "event.data");
      for (const key of ["x", "y", "deltaX", "deltaY"])
        expectNumber(data[key], `event.data.${key}`);
      break;
    case "navigation": {
      assertExactKeys(data, ["origin"], [], "event.data");
      const origin = expectString(data["origin"], "event.data.origin", 512);
      try {
        const parsed = new URL(origin);
        if (parsed.origin !== origin || parsed.protocol !== "https:") {
          throw new Error("not a canonical https origin");
        }
      } catch {
        throw new ContractValidationError(
          "unsafe_origin",
          "event.data.origin must be a canonical HTTPS origin",
        );
      }
      break;
    }
    case "viewport":
      assertExactKeys(data, ["width", "height", "deviceScaleFactor"], [], "event.data");
      expectInteger(data["width"], "event.data.width", 1);
      expectInteger(data["height"], "event.data.height", 1);
      expectNumber(data["deviceScaleFactor"], "event.data.deviceScaleFactor");
      break;
    case "marker":
      assertExactKeys(data, ["id"], [], "event.data");
      expectString(data["id"], "event.data.id", 128);
      break;
    case "capture_health":
      assertExactKeys(data, ["queueOccupancy", "ackLatencyUs"], [], "event.data");
      expectNumber(data["queueOccupancy"], "event.data.queueOccupancy");
      expectInteger(data["ackLatencyUs"], "event.data.ackLatencyUs");
      break;
  }
  return { ...data };
}

export function validateSessionEvent(value: unknown): SessionEvent {
  const event = asObject(value, "event");
  assertExactKeys(event, ["schemaVersion", "sessionId", "seq", "tUs", "type", "data"], [], "event");
  if (event["schemaVersion"] !== 1) {
    throw new ContractValidationError("unsupported_version", "event.schemaVersion must equal 1");
  }
  const sessionId = expectString(event["sessionId"], "event.sessionId", 128);
  const seq = expectInteger(event["seq"], "event.seq", 0);
  const tUs = expectInteger(event["tUs"], "event.tUs", 0);
  const type = event["type"];
  if (
    typeof type !== "string" ||
    ![
      "frame",
      "pointer",
      "click",
      "scroll",
      "navigation",
      "viewport",
      "marker",
      "capture_health",
    ].includes(type)
  ) {
    throw new ContractValidationError(
      "unknown_event_type",
      "event.type is not supported by schema version 1",
    );
  }
  return {
    schemaVersion: 1,
    sessionId,
    seq,
    tUs,
    type: type as SessionEventType,
    data: validateData(type as SessionEventType, event["data"]),
  };
}

export function validateSessionEvents(values: readonly unknown[]): SessionEvent[] {
  let previous: SessionEvent | undefined;
  return values.map((value) => {
    const event = validateSessionEvent(value);
    if (previous !== undefined) {
      if (event.sessionId !== previous.sessionId) {
        throw new ContractValidationError(
          "mixed_sessions",
          "session event stream cannot mix session IDs",
        );
      }
      if (event.seq <= previous.seq) {
        throw new ContractValidationError(
          "non_monotonic_sequence",
          "session event sequence must be strictly increasing",
        );
      }
      if (event.tUs < previous.tUs) {
        throw new ContractValidationError(
          "non_monotonic_timestamp",
          "session event timestamp must be monotonic",
        );
      }
    }
    previous = event;
    return event;
  });
}
