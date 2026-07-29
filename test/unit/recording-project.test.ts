import { describe, expect, it } from "vitest";

import {
  assertProjectTextReadyForExport,
  ContractValidationError,
  canonicalRecordingProject,
  MAX_CAPTURE_SOURCE_HEIGHT,
  MAX_CAPTURE_SOURCE_WIDTH,
  migrateV1RecordingProject,
  reviseRecordingProject,
  toProjectRenderInput,
  validateRecordingProject,
} from "../../src/project/index.js";
import { assertRasterSourceBounded } from "../../src/render/project-renderer.js";

const project = {
  schemaVersion: 1,
  projectId: "product-search-demo",
  revision: 0,
  revisionPolicy: { automatedRevisionLimit: 8, automatedRevisionCount: 0 },
  captureSources: [
    {
      id: "search-capture",
      sessionId: "session-001",
      manifestSha256: "a".repeat(64),
      timelineSha256: "b".repeat(64),
      frameSetSha256: "c".repeat(64),
      sourceWidth: 1440,
      sourceHeight: 900,
      durationUs: 8_000_000,
    },
  ],
  output: {
    profile: "landscape-1080p",
    width: 1920,
    height: 1080,
    fps: 30,
    format: "mp4",
    quality: "high",
  },
  timeline: {
    clips: [
      {
        id: "clip-search",
        sourceId: "search-capture",
        trim: { startUs: 250_000, endUs: 7_000_000 },
        speedRegions: [
          { startUs: 250_000, endUs: 1_000_000, startRate: 1, endRate: 1 },
          { startUs: 1_000_000, endUs: 2_000_000, startRate: 1, endRate: 2 },
        ],
        zoomRegions: [
          {
            id: "search-zoom",
            startUs: 1_000_000,
            endUs: 2_000_000,
            mode: "automatic",
            focus: { x: 0.5, y: 0.4 },
            scale: 1.4,
            easing: "ease-in-out",
          },
        ],
        transitionAfter: { kind: "cut", durationUs: 0 },
      },
    ],
  },
  presentation: {
    cursor: {
      visible: true,
      preset: "system",
      sizePx: 28,
      motion: "smoothed",
      clickEffect: "ripple",
    },
    frame: {
      background: { kind: "gradient", startColor: "#111827", endColor: "#312e81" },
      paddingPx: 40,
      radiusPx: 24,
      shadow: "soft",
    },
  },
  overlays: {
    annotations: [
      {
        id: "search-label",
        clipId: "clip-search",
        timeDomain: "clip-source-relative",
        startUs: 750_000,
        endUs: 1_750_000,
        text: { value: "Find products", provenance: "authored", exportDisposition: "allow" },
        position: "bottom",
        style: "emphasis",
      },
    ],
    captions: [
      {
        id: "caption-1",
        clipId: "clip-search",
        timeDomain: "clip-source-relative",
        startUs: 250_000,
        endUs: 1_250_000,
        text: {
          value: "Search without leaving the page.",
          provenance: "authored",
          exportDisposition: "allow",
        },
      },
    ],
  },
  audioTracks: [
    {
      id: "narration",
      asset: { assetId: "voiceover-001", sha256: "d".repeat(64) },
      timeDomain: "project-output-relative",
      startUs: 0,
      trim: { startUs: 0, endUs: 4_000_000 },
      gainDb: -3,
    },
  ],
  pipTracks: [
    {
      id: "presenter",
      asset: { assetId: "webcam-001", sha256: "e".repeat(64) },
      clipId: "clip-search",
      timeDomain: "clip-source-relative",
      startUs: 0,
      endUs: 3_000_000,
      position: "bottom-right",
      scale: 0.24,
    },
  ],
  renderHooks: [
    {
      id: "release-watermark",
      kind: "watermark",
      permission: "explicit-local-render-hook",
      status: "declared",
    },
  ],
  preview: { status: "not-requested" },
} as const;

describe("recording project contract", () => {
  it("accepts a versioned, re-renderable project and emits deterministic canonical JSON", () => {
    const validated = validateRecordingProject(project);

    expect(validated).toEqual(project);
    expect(canonicalRecordingProject(project)).toBe(canonicalRecordingProject(validated));
    expect(canonicalRecordingProject(project)).not.toContain("https://");
    expect(toProjectRenderInput(validated)).toEqual({
      projectId: "product-search-demo",
      revision: 0,
      revisionPolicy: project.revisionPolicy,
      captureSources: project.captureSources,
      output: project.output,
      timeline: project.timeline,
      presentation: project.presentation,
      overlays: project.overlays,
      audioTracks: project.audioTracks,
      pipTracks: project.pipTracks,
      renderHooks: project.renderHooks,
    });
  });

  it("normalizes an omitted transition to the canonical cut default", () => {
    const withoutTransition = {
      ...project,
      timeline: {
        clips: project.timeline.clips.map(({ transitionAfter: _transitionAfter, ...clip }) => clip),
      },
    };

    const canonical = canonicalRecordingProject(withoutTransition);

    expect(validateRecordingProject(withoutTransition).timeline.clips[0]?.transitionAfter).toEqual({
      kind: "cut",
      durationUs: 0,
    });
    expect(canonical).toBe(canonicalRecordingProject(project));
    expect(canonicalRecordingProject(JSON.parse(canonical))).toBe(canonical);
  });

  it("fails closed on raw paths, URLs, secrets, unknown fields, and invalid editorial references", () => {
    const invalid = [
      { ...project, privatePath: "/tmp/recording.mp4" },
      {
        ...project,
        captureSources: [{ ...project.captureSources[0], sessionId: "../session-001" }],
      },
      {
        ...project,
        audioTracks: [
          {
            ...project.audioTracks[0],
            asset: { ...project.audioTracks[0].asset, assetId: "https://bad" },
          },
        ],
      },
      {
        ...project,
        timeline: {
          clips: [{ ...project.timeline.clips[0], sourceId: "missing-source" }],
        },
      },
      {
        ...project,
        overlays: {
          ...project.overlays,
          captions: [{ ...project.overlays.captions[0], clipId: "missing-clip" }],
        },
      },
      {
        ...project,
        timeline: {
          clips: [
            {
              ...project.timeline.clips[0],
              speedRegions: [
                { startUs: 250_000, endUs: 2_000_000, startRate: 1, endRate: 1 },
                { startUs: 1_000_000, endUs: 3_000_000, startRate: 1, endRate: 1 },
              ],
            },
          ],
        },
      },
    ];

    for (const value of invalid) {
      expect(() => validateRecordingProject(value)).toThrow(ContractValidationError);
    }
  });

  it("rejects sparse and prototype-backed persisted values, unsafe capture geometry, and clip-domain overflow", () => {
    const sparse = [...project.captureSources] as unknown[];
    delete sparse[0];
    const inherited = Object.create({ projectId: "inherited" }) as Record<string, unknown>;
    Object.assign(inherited, project);

    for (const value of [
      { ...project, captureSources: sparse },
      inherited,
      { ...project, schemaVersion: 2 },
      {
        ...project,
        captureSources: [{ ...project.captureSources[0], sourceWidth: 0 }],
      },
      {
        ...project,
        overlays: {
          ...project.overlays,
          captions: [
            {
              ...project.overlays.captions[0],
              endUs:
                project.timeline.clips[0].trim.endUs - project.timeline.clips[0].trim.startUs + 1,
            },
          ],
        },
      },
    ]) {
      expect(() => validateRecordingProject(value)).toThrow(ContractValidationError);
    }
  });

  it("accepts only capture geometry that the preview renderer can consume", () => {
    const current = {
      ...project,
      captureSources: [
        {
          ...project.captureSources[0],
          sourceWidth: MAX_CAPTURE_SOURCE_WIDTH,
          sourceHeight: MAX_CAPTURE_SOURCE_HEIGHT,
        },
      ],
    };
    const revised = reviseRecordingProject(current, {
      ...current,
      revision: 1,
      preview: { status: "not-requested" },
    });
    const capture = revised.captureSources[0];
    if (capture === undefined) throw new Error("expected a capture source");

    expect(() =>
      assertRasterSourceBounded({
        width: capture.sourceWidth,
        height: capture.sourceHeight,
      }),
    ).not.toThrow();
    expect(() =>
      reviseRecordingProject(current, {
        ...current,
        revision: 1,
        captureSources: [
          { ...current.captureSources[0], sourceWidth: MAX_CAPTURE_SOURCE_WIDTH + 1 },
        ],
      }),
    ).toThrow(ContractValidationError);
  });

  it("rejects legacy geometry that cannot be migrated into a preview-renderable V2 project", () => {
    expect(() =>
      migrateV1RecordingProject({
        ...project,
        captureSources: [
          { ...project.captureSources[0], sourceHeight: MAX_CAPTURE_SOURCE_HEIGHT + 1 },
        ],
      }),
    ).toThrow(ContractValidationError);
  });

  it("allows monotonic immutable revisions while separately bounding automated revisions", () => {
    const revised = reviseRecordingProject(project, {
      ...project,
      revision: 1,
      presentation: {
        ...project.presentation,
        cursor: { ...project.presentation.cursor, preset: "large" },
      },
      preview: { status: "ready", revision: 0 },
    });

    expect(revised.revision).toBe(1);
    expect(revised.preview).toEqual({ status: "stale", revision: 0 });
    expect(() =>
      reviseRecordingProject(project, {
        ...project,
        revision: 1,
        captureSources: [{ ...project.captureSources[0], frameSetSha256: "f".repeat(64) }],
      }),
    ).toThrow(/capture sources/i);
    expect(
      reviseRecordingProject(
        { ...project, revision: 50 },
        { ...project, revision: 51, preview: { status: "not-requested" } },
      ).revision,
    ).toBe(51);
    expect(() =>
      reviseRecordingProject(
        project,
        {
          ...project,
          revision: 1,
          revisionPolicy: { automatedRevisionLimit: 8, automatedRevisionCount: 0 },
        },
        "automated",
      ),
    ).toThrow(/automated/i);
    expect(
      reviseRecordingProject(
        project,
        {
          ...project,
          revision: 1,
          revisionPolicy: { automatedRevisionLimit: 8, automatedRevisionCount: 1 },
        },
        "automated",
      ).revisionPolicy.automatedRevisionCount,
    ).toBe(1);
  });

  it("requires an explicit authored-text export disposition instead of claiming secret detection", () => {
    const redacted = {
      ...project,
      overlays: {
        ...project.overlays,
        captions: [
          {
            ...project.overlays.captions[0],
            text: { ...project.overlays.captions[0].text, exportDisposition: "redact" },
          },
        ],
      },
    };

    expect(validateRecordingProject(redacted).overlays.captions[0]?.text).toMatchObject({
      provenance: "authored",
      exportDisposition: "redact",
    });
    expect(() => assertProjectTextReadyForExport(redacted)).toThrow(/redact/i);
    expect(() => toProjectRenderInput(redacted)).toThrow(/redact/i);
  });
});
