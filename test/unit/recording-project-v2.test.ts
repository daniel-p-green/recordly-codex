import { describe, expect, it } from "vitest";

import {
  applyRecordingProfile,
  builtInRecordingProfiles,
  ContractValidationError,
  canonicalRecordingProject,
  migrateV1RecordingProject,
  reviseRecordingProject,
  toProjectRenderInput,
  validateRecordingProject,
} from "../../src/project/index.js";
import { buildCompositionPlanFromProject } from "../../src/render/composition.js";

const v1 = {
  schemaVersion: 1,
  projectId: "v2-media-demo",
  revision: 0,
  revisionPolicy: { automatedRevisionLimit: 4, automatedRevisionCount: 0 },
  captureSources: [
    {
      id: "capture-1",
      sessionId: "session-1",
      manifestSha256: "a".repeat(64),
      timelineSha256: "b".repeat(64),
      frameSetSha256: "c".repeat(64),
      sourceWidth: 1440,
      sourceHeight: 900,
      durationUs: 4_000_000,
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
        id: "clip-1",
        sourceId: "capture-1",
        trim: { startUs: 0, endUs: 4_000_000 },
        speedRegions: [],
        zoomRegions: [],
        transitionAfter: { kind: "cut", durationUs: 0 },
      },
    ],
  },
  presentation: {
    cursor: {
      visible: false,
      preset: "system",
      sizePx: 28,
      motion: "source",
      clickEffect: "none",
    },
    frame: {
      background: { kind: "solid", color: "#111827" },
      paddingPx: 40,
      radiusPx: 24,
      shadow: "soft",
    },
  },
  overlays: { annotations: [], captions: [] },
  audioTracks: [
    {
      id: "voice-1",
      asset: { assetId: "voice-1", sha256: "d".repeat(64) },
      timeDomain: "project-output-relative",
      startUs: 0,
      trim: { startUs: 0, endUs: 2_000_000 },
      gainDb: -3,
    },
  ],
  pipTracks: [
    {
      id: "pip-1",
      asset: { assetId: "pip-1", sha256: "e".repeat(64) },
      clipId: "clip-1",
      timeDomain: "clip-source-relative",
      startUs: 0,
      endUs: 2_000_000,
      position: "bottom-right",
      scale: 0.25,
    },
  ],
  renderHooks: [],
  preview: { status: "not-requested" },
} as const;

describe("recording project v2 contract and migration", () => {
  it("applies profiles as one revision without replacing evidence or existing media", () => {
    const target = builtInRecordingProfiles().find((profile) => profile.profileId === "product");
    if (target === undefined) throw new Error("product profile is missing");
    const applied = applyRecordingProfile(validateRecordingProject(v1), target, "manual");
    expect(applied).toMatchObject({
      schemaVersion: 2,
      revision: 1,
      profile: { profileId: "product" },
      output: { profile: "square-1080", width: 1080, height: 1080, format: "mp4" },
      presentation: { cursor: target.snapshot.cursor, frame: target.snapshot.frame },
      preview: { status: "stale", revision: 0 },
    });
    expect(applied.captureSources).toEqual(v1.captureSources);
    expect(applied.media.assets).toEqual(migrateV1RecordingProject(v1).media.assets);
    expect(applied.visualTracks[0]?.layout).toMatchObject(target.snapshot.visualLayout);
    expect(applied.audioTracks[0]?.gainDb).toBe(target.snapshot.audioDefaults.gainDb);
    expect(applied.timeline.clips.at(-1)?.transitionAfter).toEqual({ kind: "cut", durationUs: 0 });
    expect(applied.timelineTransitions.at(-1)).toMatchObject({ family: "cut", durationUs: 0 });
  });

  it("keeps a profile click style optional when an observed cursor has no click evidence", () => {
    const target = builtInRecordingProfiles().find((profile) => profile.profileId === "product");
    if (target === undefined) throw new Error("product profile is missing");
    const applied = applyRecordingProfile(validateRecordingProject(v1), target, "manual");
    const renderInput = toProjectRenderInput(applied);
    const cursorTrack = [
      {
        sourceId: "capture-1",
        sourceTimeUs: 500_000,
        x: 720,
        y: 450,
        state: "default" as const,
      },
    ];

    const plan = buildCompositionPlanFromProject(renderInput, { cursorTrack });

    expect(plan.style.cursor.clickEffect).toBe("ripple");
    expect(plan.clickEffects).toEqual([]);

    expect(() =>
      buildCompositionPlanFromProject(renderInput, {
        cursorTrack,
        clickTrack: [
          {
            sourceId: "capture-1",
            sourceTimeUs: 4_000_001,
            x: 720,
            y: 450,
          },
        ],
      }),
    ).toThrow(/click evidence is outside its source bounds/u);

    const trimmed = {
      ...renderInput,
      timeline: {
        ...renderInput.timeline,
        clips: renderInput.timeline.clips.map((clip) => ({
          ...clip,
          trim: { startUs: 0, endUs: 1_000_000 },
        })),
      },
    };
    expect(() =>
      buildCompositionPlanFromProject(trimmed, {
        cursorTrack,
        clickTrack: [
          {
            sourceId: "capture-1",
            sourceTimeUs: 2_000_000,
            x: 720,
            y: 450,
          },
        ],
      }),
    ).toThrow(/click evidence does not intersect a rendered clip/u);
  });

  it("applies every validated output profile with its canonical dimensions", () => {
    const expected = {
      clean: { width: 1920, height: 1080 },
      product: { width: 1080, height: 1080 },
      spotlight: { width: 1080, height: 1920 },
    } as const;
    for (const target of builtInRecordingProfiles()) {
      const dimensions = expected[target.profileId as keyof typeof expected];
      if (dimensions === undefined) throw new Error("unknown built-in profile");
      if (target.snapshot.output.format === "gif") {
        expect(() => applyRecordingProfile(validateRecordingProject(v1), target)).toThrow(
          /GIF|audio/i,
        );
      } else {
        expect(applyRecordingProfile(validateRecordingProject(v1), target).output).toMatchObject(
          dimensions,
        );
      }
    }
  });

  it("uses the automated budget exactly once and fails at the limit", () => {
    const target = builtInRecordingProfiles().find((profile) => profile.profileId === "product");
    if (target === undefined) throw new Error("product profile is missing");
    const current = migrateV1RecordingProject({
      ...v1,
      revisionPolicy: { automatedRevisionLimit: 1, automatedRevisionCount: 0 },
    });
    expect(applyRecordingProfile(current, target, "automated").revisionPolicy).toEqual({
      automatedRevisionLimit: 1,
      automatedRevisionCount: 1,
    });
    expect(() =>
      applyRecordingProfile(
        { ...current, revisionPolicy: { automatedRevisionLimit: 0, automatedRevisionCount: 0 } },
        target,
        "automated",
      ),
    ).toThrow(/automated/i);
  });

  it("migrates v1 deterministically without inspection-side mutation or sealed-source changes", () => {
    const before = structuredClone(v1);

    const inspected = validateRecordingProject(v1);
    const migrated = migrateV1RecordingProject(v1);

    expect(inspected.schemaVersion).toBe(1);
    expect(v1).toEqual(before);
    expect(migrated).toMatchObject({ schemaVersion: 2, projectId: v1.projectId, revision: 0 });
    expect(migrated.profile).toMatchObject({
      source: "builtin",
      profileId: "clean",
      profileRevision: 1,
    });
    expect(migrated.captureSources).toEqual(v1.captureSources);
    expect(migrated.media.assets).toEqual([
      expect.objectContaining({ id: "voice-1", kind: "audio", sha256: "d".repeat(64) }),
      expect.objectContaining({ id: "pip-1", kind: "image", sha256: "e".repeat(64) }),
    ]);
    expect(migrated.visualTracks[0]).toMatchObject({ mediaId: "pip-1", clipId: "clip-1" });
    expect(canonicalRecordingProject(migrated)).toBe(
      canonicalRecordingProject(migrateV1RecordingProject(v1)),
    );
  });

  it("accepts bounded future-media controls and rejects unknown or unsafe media declarations", () => {
    const migrated = migrateV1RecordingProject(v1);
    const candidate = {
      ...migrated,
      timeline: {
        clips: [
          {
            ...migrated.timeline.clips[0],
            transitionAfter: { kind: "crossfade" as const, durationUs: 300_000 },
          },
        ],
      },
      timelineTransitions: [
        {
          clipId: "clip-1",
          family: "dip-to-color",
          durationUs: 300_000,
          easing: "ease-in-out",
          color: "#000000",
        },
      ],
      zoomProposals: [
        {
          id: "zoom-proposal-1",
          clipId: "clip-1",
          sourceRange: { startUs: 500_000, endUs: 1_000_000 },
          focus: { x: 0.5, y: 0.5 },
          scale: 1.3,
          easing: "ease-out",
          review: { status: "accepted", basis: "observed-input" },
        },
      ],
      presentationControls: {
        cursor: { emphasis: "spotlight", trailDurationUs: 0 },
        frame: { fit: "contain", border: "subtle" },
        export: { audio: "include", colorRange: "limited", metadata: "minimal" },
      },
      audioMix: {
        tracks: [
          {
            trackId: "voice-1",
            mediaId: "voice-1",
            role: "primary",
            pan: 0,
            fadeInUs: 0,
            fadeOutUs: 0,
            ducking: "none",
          },
        ],
      },
      visualTracks: [
        {
          id: "webcam-video-1",
          mediaId: "webcam-video-1",
          clipId: "clip-1",
          timeDomain: "clip-source-relative",
          startUs: 500_000,
          endUs: 2_000_000,
          mediaTrim: { startUs: 0, endUs: 1_500_000 },
          sync: "source-time",
          layout: {
            position: "top-right",
            scale: 0.25,
            fit: "cover",
            crop: { x: 0.1, y: 0.1, width: 0.8, height: 0.8 },
            opacity: 1,
            radiusPx: 16,
            border: "light",
          },
          motion: { preset: "fade", durationUs: 150_000 },
        },
      ],
      media: {
        assets: [
          ...migrated.media.assets,
          {
            id: "webcam-video-1",
            sha256: "f".repeat(64),
            kind: "video",
            provenance: "explicit-local-import",
            durationUs: 3_000_000,
            width: 1280,
            height: 720,
            fps: 30,
          },
        ],
      },
    };

    expect(validateRecordingProject(candidate)).toMatchObject({ schemaVersion: 2 });
    const visualTrack = candidate.visualTracks[0];
    const mixTrack = candidate.audioMix.tracks[0];
    if (visualTrack === undefined || mixTrack === undefined)
      throw new Error("candidate media controls are missing");
    for (const unsafe of [
      { ...candidate, localPath: "/tmp/webcam.mp4" },
      {
        ...candidate,
        visualTracks: [{ ...visualTrack, mediaId: "missing-media" }],
      },
      {
        ...candidate,
        visualTracks: [
          {
            ...visualTrack,
            layout: {
              ...visualTrack.layout,
              crop: { x: 0.5, y: 0, width: 0.8, height: 1 },
            },
          },
        ],
      },
      {
        ...candidate,
        audioMix: {
          tracks: [{ ...mixTrack, mediaId: "pip-1" }],
        },
      },
    ]) {
      expect(() => validateRecordingProject(unsafe)).toThrow(ContractValidationError);
    }
    expect(() =>
      validateRecordingProject({
        ...candidate,
        profile: { ...candidate.profile, snapshotSha256: "0".repeat(64) },
      }),
    ).toThrow(/profile/i);
    expect(() =>
      validateRecordingProject({
        ...candidate,
        audioMix: {
          tracks: [
            {
              ...mixTrack,
              role: "bed",
              ducking: "against-primary",
            },
          ],
        },
      }),
    ).toThrow(/primary/i);
  });

  it("migrates only on an explicit first revision and keeps the old sealed sources immutable", () => {
    const nextV1 = { ...v1, revision: 1, preview: { status: "ready", revision: 0 } };

    const revised = reviseRecordingProject(v1, nextV1);

    expect(revised.schemaVersion).toBe(2);
    expect(revised.captureSources).toEqual(v1.captureSources);
    expect(revised.preview).toEqual({ status: "stale", revision: 0 });
    expect(validateRecordingProject(v1).schemaVersion).toBe(1);
  });
});
