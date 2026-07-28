import { describe, expect, it } from "vitest";

import {
  CaptureAdapter,
  CompilationError,
  ContractValidationError,
  assertFixtureContract,
  canonicalJson,
  cleanupRenderedFixtureCandidate,
  compileRecording,
  cssPointToCapturePoint,
  fixtureVideoContract,
  normalizeFrameGrid,
  renderSanitizedFixtureCandidate,
  selectZoomCandidates,
  validateRecordingRequest,
  validateSessionEvent,
  validateSessionEvents,
} from "../../src/index.js";
import type {
  CaptureAdapterOptions,
  CompilerProvenance,
  RecordingRequest,
  RenderedFixtureCandidate,
  SessionEvent,
} from "../../src/index.js";
import * as publicApi from "../../src/index.js";

describe("public API", () => {
  it("exposes the tested request, session, capture, compiler, manifest, timeline, encoder, and render surface", () => {
    const request: RecordingRequest | undefined = undefined;
    const event: SessionEvent | undefined = undefined;
    const captureOptions: CaptureAdapterOptions | undefined = undefined;
    const provenance: CompilerProvenance | undefined = undefined;
    const candidate: RenderedFixtureCandidate | undefined = undefined;

    expect({
      CaptureAdapter,
      CompilationError,
      ContractValidationError,
      assertFixtureContract,
      canonicalJson,
      cleanupRenderedFixtureCandidate,
      compileRecording,
      cssPointToCapturePoint,
      fixtureVideoContract,
      normalizeFrameGrid,
      renderSanitizedFixtureCandidate,
      selectZoomCandidates,
      validateRecordingRequest,
      validateSessionEvent,
      validateSessionEvents,
    }).toEqual({
      CaptureAdapter: expect.any(Function),
      CompilationError: expect.any(Function),
      ContractValidationError: expect.any(Function),
      assertFixtureContract: expect.any(Function),
      canonicalJson: expect.any(Function),
      cleanupRenderedFixtureCandidate: expect.any(Function),
      compileRecording: expect.any(Function),
      cssPointToCapturePoint: expect.any(Function),
      fixtureVideoContract: { width: 1920, height: 1080, fps: 30, frameCount: 30 },
      normalizeFrameGrid: expect.any(Function),
      renderSanitizedFixtureCandidate: expect.any(Function),
      selectZoomCandidates: expect.any(Function),
      validateRecordingRequest: expect.any(Function),
      validateSessionEvent: expect.any(Function),
      validateSessionEvents: expect.any(Function),
    });
    expect([request, event, captureOptions, provenance, candidate]).toEqual([
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
    ]);
  });

  it("does not expose encoder path ownership or executable resolution internals", () => {
    expect("assertOwnedFixtureArtifactPaths" in publicApi).toBe(false);
    expect("resolveMediaExecutable" in publicApi).toBe(false);
  });
});
