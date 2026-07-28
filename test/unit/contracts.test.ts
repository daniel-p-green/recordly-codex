import { describe, expect, it } from "vitest";

import {
  ContractValidationError,
  validateRecordingRequest,
  validateSessionEvent,
  validateSessionEvents,
} from "../../src/contracts/index.js";

const request = {
  schemaVersion: 1,
  requestId: "request-001",
  url: "https://demo.example/products",
  objective: "Show the product search flow.",
  viewport: { width: 1440, height: 900, deviceScaleFactor: 1 },
  output: { width: 1920, height: 1080, fps: 30, format: "mp4" },
  policy: {
    allowPrivateOrigin: false,
    allowedOrigins: ["https://demo.example"],
    maxAttempts: 2,
  },
};

const frame = {
  schemaVersion: 1,
  sessionId: "session-001",
  seq: 1,
  tUs: 0,
  type: "frame",
  data: {
    cdpSessionId: 1,
    frameId: 3,
    receivedAtUs: 0,
    imagePath: "frames/raw/000003.webp",
    sha256: "a".repeat(64),
    width: 1440,
    height: 900,
  },
};

describe("recording request contract", () => {
  it("accepts an exact v1 request with an allowlisted public URL", () => {
    expect(validateRecordingRequest(request)).toEqual(request);
  });

  it("rejects unknown versions and unknown nested fields", () => {
    expect(() => validateRecordingRequest({ ...request, schemaVersion: 2 })).toThrow(
      ContractValidationError,
    );
    expect(() =>
      validateRecordingRequest({
        ...request,
        output: { ...request.output, bitrate: 2_000_000 },
      }),
    ).toThrow(/unknown field/i);
  });

  it("rejects unsafe, credential-bearing, query-bearing, private, and non-allowlisted URLs", () => {
    for (const url of [
      "file:///Users/example/private.html",
      "data:text/html,hello",
      "javascript:alert(1)",
      "https://user:password@demo.example/products",
      "https://demo.example/products?token=secret",
      "http://127.0.0.1:3000/",
      "https://elsewhere.example/",
    ]) {
      expect(() => validateRecordingRequest({ ...request, url })).toThrow(ContractValidationError);
    }
  });

  it("permits an explicitly allowlisted private origin only when policy allows it", () => {
    const privateRequest = {
      ...request,
      url: "http://127.0.0.1:3000/demo",
      policy: {
        allowPrivateOrigin: true,
        allowedOrigins: ["http://127.0.0.1:3000"],
        maxAttempts: 2,
      },
    };

    expect(validateRecordingRequest(privateRequest)).toEqual(privateRequest);
  });

  it("rejects malformed policy fields, duplicate allowlist entries, and malformed request shapes", () => {
    expect(() => validateRecordingRequest(null)).toThrow(/object/i);
    expect(() => validateRecordingRequest({ ...request, objective: "" })).toThrow(/non-empty/i);
    expect(() =>
      validateRecordingRequest({ ...request, objective: "unsafe\u0000objective" }),
    ).toThrow(/control/i);
    expect(() =>
      validateRecordingRequest({
        ...request,
        policy: { allowPrivateOrigin: false, allowedOrigins: ["https://demo.example"] },
      }),
    ).toThrow(/missing required/i);
    expect(() =>
      validateRecordingRequest({
        ...request,
        policy: { ...request.policy, allowPrivateOrigin: "false" },
      }),
    ).toThrow(/boolean/i);
    expect(() =>
      validateRecordingRequest({
        ...request,
        policy: {
          ...request.policy,
          allowedOrigins: ["https://demo.example", "https://demo.example"],
        },
      }),
    ).toThrow(/duplicate/i);
    expect(() =>
      validateRecordingRequest({
        ...request,
        policy: { ...request.policy, allowedOrigins: ["https://demo.example/has-a-path"] },
      }),
    ).toThrow(/origin/i);
    expect(() =>
      validateRecordingRequest({ ...request, policy: { ...request.policy, allowedOrigins: [] } }),
    ).toThrow(/non-empty bounded/i);
    expect(() =>
      validateRecordingRequest({
        ...request,
        policy: { ...request.policy, allowedOrigins: ["not a URL"] },
      }),
    ).toThrow(/absolute/i);
    expect(() =>
      validateRecordingRequest({
        ...request,
        policy: { ...request.policy, allowedOrigins: ["http://127.0.0.1:3000"] },
      }),
    ).toThrow(/allowPrivateOrigin/i);
    expect(() => validateRecordingRequest({ ...request, url: "https://localhost/demo" })).toThrow(
      /private/i,
    );
    expect(() => validateRecordingRequest({ ...request, url: "http://[::1]/demo" })).toThrow(
      /private/i,
    );
    expect(() => validateRecordingRequest({ ...request, url: "not a URL" })).toThrow(/absolute/i);
  });
});

describe("session event contract", () => {
  it("accepts an exact typed frame envelope", () => {
    expect(validateSessionEvent(frame)).toEqual(frame);
  });

  it("rejects unknown envelope and event-data fields", () => {
    expect(() => validateSessionEvent({ ...frame, traceId: "not allowed" })).toThrow(
      /unknown field/i,
    );
    expect(() =>
      validateSessionEvent({ ...frame, data: { ...frame.data, rawUrl: "https://secret.example" } }),
    ).toThrow(/unknown field/i);
  });

  it("rejects unsafe event payloads and validates all declared event types", () => {
    expect(() =>
      validateSessionEvent({ ...frame, data: { ...frame.data, imagePath: "../secret" } }),
    ).toThrow(ContractValidationError);
    expect(
      validateSessionEvent({
        schemaVersion: 1,
        sessionId: "session-001",
        seq: 2,
        tUs: 10,
        type: "click",
        data: { x: 30, y: 40, button: 0, targetLabel: "Search" },
      }),
    ).toMatchObject({ type: "click" });
  });

  it("requires strictly increasing sequence and monotonic timestamps", () => {
    const later = { ...frame, seq: 2, tUs: 100, type: "marker" as const, data: { id: "search" } };
    expect(validateSessionEvents([frame, later])).toEqual([frame, later]);
    expect(() => validateSessionEvents([frame, { ...later, seq: 1 }])).toThrow(/sequence/i);
    expect(() => validateSessionEvents([frame, { ...later, tUs: -1 }])).toThrow(/integer/i);
    expect(() => validateSessionEvents([frame, { ...later, sessionId: "other-session" }])).toThrow(
      /mix/i,
    );
    expect(() => validateSessionEvents([frame, later, { ...later, seq: 3, tUs: 50 }])).toThrow(
      /timestamp/i,
    );
  });

  it("accepts each non-frame event contract without raw URL or DOM fields", () => {
    const common = { schemaVersion: 1, sessionId: "session-001" };
    const events = [
      {
        ...common,
        seq: 2,
        tUs: 10,
        type: "pointer",
        data: { x: 2, y: 4, buttons: 0, source: "planned" },
      },
      { ...common, seq: 3, tUs: 20, type: "scroll", data: { x: 2, y: 4, deltaX: 0, deltaY: 50 } },
      { ...common, seq: 4, tUs: 30, type: "navigation", data: { origin: "https://demo.example" } },
      {
        ...common,
        seq: 5,
        tUs: 40,
        type: "viewport",
        data: { width: 1440, height: 900, deviceScaleFactor: 1 },
      },
      { ...common, seq: 6, tUs: 50, type: "marker", data: { id: "search" } },
      {
        ...common,
        seq: 7,
        tUs: 60,
        type: "capture_health",
        data: { queueOccupancy: 0.4, ackLatencyUs: 100 },
      },
    ];

    expect(events.map(validateSessionEvent).map((event) => event.type)).toEqual([
      "pointer",
      "scroll",
      "navigation",
      "viewport",
      "marker",
      "capture_health",
    ]);
  });

  it("rejects unsupported types, unsafe navigation, and invalid typed data", () => {
    expect(() => validateSessionEvent(null)).toThrow(/object/i);
    expect(() => validateSessionEvent({ ...frame, schemaVersion: 2 })).toThrow(/schemaVersion/i);
    expect(() => validateSessionEvent({ ...frame, type: "keyboard" })).toThrow(/not supported/i);
    expect(() =>
      validateSessionEvent({
        ...frame,
        type: "navigation",
        data: { origin: "http://demo.example" },
      }),
    ).toThrow(/HTTPS/i);
    expect(() =>
      validateSessionEvent({
        ...frame,
        type: "pointer",
        data: { x: 1, y: 1, buttons: 0, source: "page" },
      }),
    ).toThrow(/planned or observed/i);
    expect(() =>
      validateSessionEvent({ ...frame, type: "click", data: { x: 1, y: 1, button: 4 } }),
    ).toThrow(/0, 1, or 2/i);
    expect(() =>
      validateSessionEvent({
        ...frame,
        type: "capture_health",
        data: { queueOccupancy: 0.5, ackLatencyUs: -1 },
      }),
    ).toThrow(/integer/i);
  });
});
