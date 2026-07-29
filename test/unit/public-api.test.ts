import { describe, expect, it } from "vitest";
import type {
  CaptureAdapterOptions,
  CompilerProvenance,
  LazyRasterSource,
  ProjectRenderInput,
  RecordingProjectRenderInput,
  RecordingProjectRenderResult,
  RecordingRequest,
  RenderedFixtureCandidate,
  SessionEvent,
  SourceClickSample,
  SourceCursorSample,
} from "../../src/index.js";
import * as publicApi from "../../src/index.js";
import {
  assertFixtureContract,
  assertProjectTextReadyForExport,
  CaptureAdapter,
  CompilationError,
  ContractValidationError,
  canonicalJson,
  canonicalRecordingProject,
  cleanupRenderedFixtureCandidate,
  compileRecording,
  cssPointToCapturePoint,
  fixtureVideoContract,
  MAX_AUTOMATED_PROJECT_REVISIONS,
  normalizeFrameGrid,
  renderRecordingProject,
  renderSanitizedFixtureCandidate,
  reviseRecordingProject,
  selectZoomCandidates,
  toProjectRenderInput,
  validateRecordingProject,
  validateRecordingRequest,
  validateSessionEvent,
  validateSessionEvents,
} from "../../src/index.js";

describe("public API", () => {
  it("exposes the tested request, session, capture, compiler, manifest, timeline, encoder, and render surface", () => {
    const request: RecordingRequest | undefined = undefined;
    const event: SessionEvent | undefined = undefined;
    const captureOptions: CaptureAdapterOptions | undefined = undefined;
    const provenance: CompilerProvenance | undefined = undefined;
    const candidate: RenderedFixtureCandidate | undefined = undefined;
    const projectRenderInput: ProjectRenderInput | undefined = undefined;
    const lazySource: LazyRasterSource | undefined = undefined;
    const rendererInput: RecordingProjectRenderInput | undefined = undefined;
    const rendererResult: RecordingProjectRenderResult | undefined = undefined;
    const sourceCursor: SourceCursorSample | undefined = undefined;
    const sourceClick: SourceClickSample | undefined = undefined;

    expect({
      CaptureAdapter,
      CompilationError,
      ContractValidationError,
      MAX_AUTOMATED_PROJECT_REVISIONS,
      assertFixtureContract,
      assertProjectTextReadyForExport,
      canonicalJson,
      canonicalRecordingProject,
      cleanupRenderedFixtureCandidate,
      compileRecording,
      cssPointToCapturePoint,
      fixtureVideoContract,
      normalizeFrameGrid,
      renderSanitizedFixtureCandidate,
      renderRecordingProject,
      reviseRecordingProject,
      selectZoomCandidates,
      toProjectRenderInput,
      validateRecordingRequest,
      validateRecordingProject,
      validateSessionEvent,
      validateSessionEvents,
    }).toEqual({
      CaptureAdapter: expect.any(Function),
      CompilationError: expect.any(Function),
      ContractValidationError: expect.any(Function),
      MAX_AUTOMATED_PROJECT_REVISIONS: 16,
      assertFixtureContract: expect.any(Function),
      assertProjectTextReadyForExport: expect.any(Function),
      canonicalJson: expect.any(Function),
      canonicalRecordingProject: expect.any(Function),
      cleanupRenderedFixtureCandidate: expect.any(Function),
      compileRecording: expect.any(Function),
      cssPointToCapturePoint: expect.any(Function),
      fixtureVideoContract: { width: 1920, height: 1080, fps: 30, frameCount: 30 },
      normalizeFrameGrid: expect.any(Function),
      renderSanitizedFixtureCandidate: expect.any(Function),
      renderRecordingProject: expect.any(Function),
      reviseRecordingProject: expect.any(Function),
      selectZoomCandidates: expect.any(Function),
      toProjectRenderInput: expect.any(Function),
      validateRecordingRequest: expect.any(Function),
      validateRecordingProject: expect.any(Function),
      validateSessionEvent: expect.any(Function),
      validateSessionEvents: expect.any(Function),
    });
    expect([
      request,
      event,
      captureOptions,
      provenance,
      candidate,
      projectRenderInput,
      lazySource,
      rendererInput,
      rendererResult,
      sourceCursor,
      sourceClick,
    ]).toEqual([
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
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
