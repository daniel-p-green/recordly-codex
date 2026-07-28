import { describe, expect, it } from "vitest";

import {
  CompilationError,
  type CompilerProvenance,
  compileRecording,
} from "../../src/compiler/index.js";
import { canonicalJson } from "../../src/manifest/canonical-json.js";

const request = {
  schemaVersion: 1,
  requestId: "request-001",
  url: "https://demo.example/products/search",
  objective: "Show the product search flow.",
  viewport: { width: 1440, height: 900, deviceScaleFactor: 1 },
  output: { width: 1920, height: 1080, fps: 30, format: "mp4" },
  policy: {
    allowPrivateOrigin: false,
    allowedOrigins: ["https://demo.example"],
    maxAttempts: 2,
  },
};

const provenance: CompilerProvenance = {
  environment: {
    codexSurface: "desktop-browser",
    browserProtocol: "cdp-1.3",
    runtime: "node-22",
  },
  renderer: {
    name: "recordly-codex",
    version: "0.1.0",
    profile: "1080p30",
    implementationSha256: "b".repeat(64),
  },
};

const frameHash = (frameId: number, imagePath: string, sha256: string) => ({
  frameId,
  imagePath,
  sha256,
});

describe("recording compiler", () => {
  it("uses stable key ordering and JSON-compatible omission for canonical evidence", () => {
    expect(canonicalJson({ z: 1, a: { b: 2, omitted: undefined } })).toBe('{"a":{"b":2},"z":1}');
  });

  it("supports null-prototype evidence objects and rejects values JSON cannot safely encode", () => {
    const nullPrototype = Object.create(null) as { a: unknown; z: unknown };
    nullPrototype.z = true;
    nullPrototype.a = 1;

    expect(canonicalJson(nullPrototype)).toBe('{"a":1,"z":true}');
    expect(() => canonicalJson({ value: Number.NaN })).toThrow(/non-finite/i);
    expect(() => canonicalJson(new Date())).toThrow(/plain objects/i);
  });

  it("compiles validated evidence into canonical, sanitized manifest and deterministic timeline", () => {
    const output = compileRecording({
      request,
      provenance,
      frameHashes: [
        frameHash(1, "frames/raw/000001.webp", "a".repeat(64)),
        frameHash(2, "frames/raw/000002.webp", "c".repeat(64)),
      ],
      events: [
        {
          schemaVersion: 1,
          sessionId: "session-001",
          seq: 1,
          tUs: 0,
          type: "frame",
          data: {
            cdpSessionId: 1,
            frameId: 1,
            receivedAtUs: 0,
            imagePath: "frames/raw/000001.webp",
            sha256: "a".repeat(64),
            width: 1440,
            height: 900,
          },
        },
        {
          schemaVersion: 1,
          sessionId: "session-001",
          seq: 2,
          tUs: 100_000,
          type: "pointer",
          data: { x: 200, y: 150, buttons: 0, source: "planned" },
        },
        {
          schemaVersion: 1,
          sessionId: "session-001",
          seq: 3,
          tUs: 200_000,
          type: "click",
          data: { x: 220, y: 160, button: 0, targetLabel: "Search" },
        },
        {
          schemaVersion: 1,
          sessionId: "session-001",
          seq: 4,
          tUs: 300_000,
          type: "marker",
          data: { id: "search-results" },
        },
        {
          schemaVersion: 1,
          sessionId: "session-001",
          seq: 5,
          tUs: 400_000,
          type: "capture_health",
          data: { queueOccupancy: 0.2, ackLatencyUs: 1_000 },
        },
        {
          schemaVersion: 1,
          sessionId: "session-001",
          seq: 6,
          tUs: 500_000,
          type: "frame",
          data: {
            cdpSessionId: 1,
            frameId: 2,
            receivedAtUs: 500_000,
            imagePath: "frames/raw/000002.webp",
            sha256: "c".repeat(64),
            width: 1440,
            height: 900,
          },
        },
      ],
    });

    expect(output.manifest).toMatchObject({
      schemaVersion: 1,
      request: {
        requestId: "request-001",
        target: { origin: "https://demo.example", path: "/products/search" },
      },
      provenance,
      artifacts: [
        { frameId: 1, imagePath: "frames/raw/000001.webp", sha256: "a".repeat(64) },
        { frameId: 2, imagePath: "frames/raw/000002.webp", sha256: "c".repeat(64) },
      ],
      redactions: { query: "omitted", fragment: "omitted", credentials: "omitted" },
    });
    expect(JSON.stringify(output.manifest)).not.toContain("?");
    expect(output.timeline).toMatchObject({
      schemaVersion: 1,
      cursorTrack: [{ tUs: 100_000, x: 200, y: 150, buttons: 0, source: "planned" }],
      clickTrack: [{ tUs: 200_000, x: 220, y: 160, button: 0, targetLabel: "Search" }],
      zoomCandidates: [
        expect.objectContaining({ id: "marker:search-results", kind: "marker", score: 4 }),
      ],
    });
    expect(output.timeline.cfrSlots).toHaveLength(16);
    expect(output.timeline.cfrSlots[0]).toMatchObject({ sourceFrameId: 1 });
    expect(output.timeline.cfrSlots.at(-1)).toMatchObject({ sourceFrameId: 2 });
    expect(output.timeline.qa).toMatchObject({ status: "ready" });
    expect(output.hashes.manifestSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(output.hashes.timelineSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(canonicalJson(output.manifest)).toBe(output.canonical.manifest);
    expect(canonicalJson(output.timeline)).toBe(output.canonical.timeline);
    expect(
      compileRecording({
        request,
        provenance,
        frameHashes: output.manifest.artifacts,
        events: output.manifest.events,
      }),
    ).toEqual(output);
  });

  it("fails closed when a frame hash, artifact path, or unsafe navigation cannot be proven", () => {
    const baseInput = {
      request,
      provenance,
      frameHashes: [frameHash(1, "frames/raw/000001.webp", "a".repeat(64))],
      events: [
        {
          schemaVersion: 1,
          sessionId: "session-001",
          seq: 1,
          tUs: 0,
          type: "frame",
          data: {
            cdpSessionId: 1,
            frameId: 1,
            receivedAtUs: 0,
            imagePath: "frames/raw/000001.webp",
            sha256: "a".repeat(64),
            width: 1440,
            height: 900,
          },
        },
      ],
    };

    expect(() =>
      compileRecording({
        ...baseInput,
        frameHashes: [frameHash(1, "frames/raw/000001.webp", "b".repeat(64))],
      }),
    ).toThrow(CompilationError);
    expect(() =>
      compileRecording({
        ...baseInput,
        frameHashes: [frameHash(1, "frames/raw/../private.webp", "a".repeat(64))],
      }),
    ).toThrow(/contained/i);
    expect(() =>
      compileRecording({
        ...baseInput,
        events: [
          ...baseInput.events,
          {
            schemaVersion: 1,
            sessionId: "session-001",
            seq: 2,
            tUs: 1,
            type: "navigation",
            data: { origin: "https://elsewhere.example" },
          },
        ],
      }),
    ).toThrow(/origin/i);
  });

  it("rejects incomplete evidence before compilation can produce a manifest", () => {
    expect(() => compileRecording({ request, provenance, frameHashes: [], events: [] })).toThrow(
      /at least one session event/i,
    );

    expect(() =>
      compileRecording({
        request,
        provenance,
        frameHashes: [],
        events: [
          {
            schemaVersion: 1,
            sessionId: "session-001",
            seq: 1,
            tUs: 0,
            type: "marker",
            data: { id: "accepted-plan" },
          },
        ],
      }),
    ).toThrow(/immutable frame hashes/i);
  });

  it("classifies missing coverage and degraded health as QA blockers without changing slot selection", () => {
    const output = compileRecording({
      request,
      provenance,
      frameHashes: [frameHash(1, "frames/raw/000001.webp", "a".repeat(64))],
      events: [
        {
          schemaVersion: 1,
          sessionId: "session-001",
          seq: 1,
          tUs: 100_000,
          type: "frame",
          data: {
            cdpSessionId: 1,
            frameId: 1,
            receivedAtUs: 100_000,
            imagePath: "frames/raw/000001.webp",
            sha256: "a".repeat(64),
            width: 1440,
            height: 900,
          },
        },
        {
          schemaVersion: 1,
          sessionId: "session-001",
          seq: 2,
          tUs: 1_000_000,
          type: "capture_health",
          data: { queueOccupancy: 1, ackLatencyUs: 1_000_001 },
        },
      ],
    });

    expect(output.timeline.cfrSlots[0]).toMatchObject({ sourceFrameId: undefined });
    expect(output.timeline.qa).toMatchObject({ status: "blocked" });
    expect(output.timeline.qa.preconditions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "frame-coverage", status: "fail" }),
        expect.objectContaining({ id: "capture-health", status: "fail" }),
      ]),
    );
  });
});
