import { describe, expect, it } from "vitest";
import type {
  CaptureAdapterOptions,
  CompilerProvenance,
  LazyRasterSource,
  ProjectMediaAsset,
  ProjectRenderInput,
  RecordingProfileReference,
  RecordingProfileSnapshot,
  RecordingProjectV1,
  RecordingProjectV2,
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
  builtInRecordingProfiles,
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
  migrateV1RecordingProject,
  normalizeFrameGrid,
  profileSnapshotSha256,
  renderRecordingProject,
  renderSanitizedFixtureCandidate,
  reviseRecordingProject,
  selectZoomCandidates,
  toProjectRenderInput,
  validateRecordingProfileReference,
  validateRecordingProfileSnapshot,
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
    const profileSnapshot: RecordingProfileSnapshot | undefined = undefined;
    const profileReference: RecordingProfileReference | undefined = undefined;
    const recordingProjectV1: RecordingProjectV1 | undefined = undefined;
    const recordingProjectV2: RecordingProjectV2 | undefined = undefined;
    const projectMediaAsset: ProjectMediaAsset | undefined = undefined;

    expect({
      CaptureAdapter,
      CompilationError,
      ContractValidationError,
      MAX_AUTOMATED_PROJECT_REVISIONS,
      assertFixtureContract,
      assertProjectTextReadyForExport,
      builtInRecordingProfiles,
      canonicalJson,
      canonicalRecordingProject,
      cleanupRenderedFixtureCandidate,
      compileRecording,
      cssPointToCapturePoint,
      fixtureVideoContract,
      migrateV1RecordingProject,
      normalizeFrameGrid,
      profileSnapshotSha256,
      renderSanitizedFixtureCandidate,
      renderRecordingProject,
      reviseRecordingProject,
      selectZoomCandidates,
      toProjectRenderInput,
      validateRecordingProfileReference,
      validateRecordingProfileSnapshot,
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
      builtInRecordingProfiles: expect.any(Function),
      canonicalJson: expect.any(Function),
      canonicalRecordingProject: expect.any(Function),
      cleanupRenderedFixtureCandidate: expect.any(Function),
      compileRecording: expect.any(Function),
      cssPointToCapturePoint: expect.any(Function),
      fixtureVideoContract: { width: 1920, height: 1080, fps: 30, frameCount: 30 },
      migrateV1RecordingProject: expect.any(Function),
      normalizeFrameGrid: expect.any(Function),
      profileSnapshotSha256: expect.any(Function),
      renderSanitizedFixtureCandidate: expect.any(Function),
      renderRecordingProject: expect.any(Function),
      reviseRecordingProject: expect.any(Function),
      selectZoomCandidates: expect.any(Function),
      toProjectRenderInput: expect.any(Function),
      validateRecordingProfileReference: expect.any(Function),
      validateRecordingProfileSnapshot: expect.any(Function),
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
      profileSnapshot,
      profileReference,
      recordingProjectV1,
      recordingProjectV2,
      projectMediaAsset,
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
