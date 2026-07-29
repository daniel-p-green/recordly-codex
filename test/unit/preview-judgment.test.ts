import { describe, expect, it } from "vitest";

import {
  previewJudgmentDigests,
  validatePreviewJudgment,
} from "../../src/project/preview-judgment.js";
import { validateRecordingProject } from "../../src/project/index.js";

const project = validateRecordingProject({
  schemaVersion: 1,
  projectId: "project-1",
  revision: 0,
  revisionPolicy: { automatedRevisionLimit: 2, automatedRevisionCount: 0 },
  captureSources: [
    {
      id: "capture-1",
      sessionId: "session-1",
      manifestSha256: "a".repeat(64),
      timelineSha256: "b".repeat(64),
      frameSetSha256: "c".repeat(64),
      sourceWidth: 320,
      sourceHeight: 180,
      durationUs: 1_000_000,
    },
  ],
  output: {
    profile: "landscape-1080p",
    width: 1920,
    height: 1080,
    fps: 30,
    format: "mp4",
    quality: "standard",
  },
  timeline: {
    clips: [
      {
        id: "clip-1",
        sourceId: "capture-1",
        trim: { startUs: 0, endUs: 1_000_000 },
        speedRegions: [],
        zoomRegions: [],
        transitionAfter: { kind: "cut", durationUs: 0 },
      },
    ],
  },
  presentation: {
    cursor: { visible: true, preset: "system", sizePx: 28, motion: "source", clickEffect: "none" },
    frame: {
      background: { kind: "solid", color: "#111827" },
      paddingPx: 32,
      radiusPx: 16,
      shadow: "soft",
    },
  },
  overlays: { annotations: [], captions: [] },
  audioTracks: [],
  pipTracks: [],
  renderHooks: [],
  preview: { status: "ready", revision: 0 },
});

describe("preview judgment contract", () => {
  it("derives stable path-free project and render-input digests", () => {
    const digests = previewJudgmentDigests(project);
    expect(digests).toEqual({
      projectSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
      renderInputSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
      renderRecipeSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
    });
    expect(JSON.stringify(digests)).not.toContain("/");
  });

  it("accepts only strict bounded issues and verdict rules", () => {
    const base = {
      schemaVersion: 1,
      projectId: "project-1",
      revision: 0,
      ...previewJudgmentDigests(project),
      previewArtifactSha256: "d".repeat(64),
    };
    expect(
      validatePreviewJudgment({
        ...base,
        verdict: "accept",
        issues: [],
      }),
    ).toMatchObject({ verdict: "accept", issues: [] });
    expect(() =>
      validatePreviewJudgment({
        ...base,
        verdict: "accept",
        issues: [
          {
            code: "framing",
            severity: "blocking",
            region: "presentation",
            startUs: 0,
            endUs: 1,
            evidence: "The subject is cropped.",
          },
        ],
      }),
    ).toThrow(/accept/i);
    expect(() =>
      validatePreviewJudgment({
        ...base,
        verdict: "revise",
        issues: [],
      }),
    ).toThrow(/revise/i);
    expect(() =>
      validatePreviewJudgment({
        ...base,
        verdict: "revise",
        issues: [
          {
            code: "framing",
            severity: "major",
            region: "presentation",
            startUs: 5,
            endUs: 4,
            evidence: "The subject is cropped.",
            unsafePath: "/tmp/private.mp4",
          },
        ],
      }),
    ).toThrow(/shape|issue/i);
  });
});
