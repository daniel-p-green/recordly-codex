import { describe, expect, it } from "vitest";
import {
  migrateV1RecordingProject,
  toProjectRenderInput,
  type ProjectRenderInput,
} from "../../src/project/index.js";
import {
  buildCompositionPlan,
  buildCompositionPlanFromProject,
  mapPresentationTimeline,
  resolveRenderHooks,
  resolveRenderPreset,
} from "../../src/render/composition.js";

describe("deterministic composition planning", () => {
  it("uses only bounded observed source evidence for a V2 cursor trail", () => {
    const migrated = migrateV1RecordingProject({
      schemaVersion: 1,
      projectId: "observed-trail",
      revision: 0,
      revisionPolicy: { automatedRevisionLimit: 1, automatedRevisionCount: 0 },
      captureSources: [
        {
          id: "capture",
          sessionId: "session",
          manifestSha256: "a".repeat(64),
          timelineSha256: "b".repeat(64),
          frameSetSha256: "c".repeat(64),
          sourceWidth: 160,
          sourceHeight: 90,
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
            id: "clip",
            sourceId: "capture",
            trim: { startUs: 0, endUs: 1_000_000 },
            speedRegions: [],
            zoomRegions: [],
            transitionAfter: { kind: "cut", durationUs: 0 },
          },
        ],
      },
      presentation: {
        cursor: {
          visible: true,
          preset: "system",
          sizePx: 24,
          motion: "source",
          clickEffect: "none",
        },
        frame: {
          background: { kind: "solid", color: "#000000" },
          paddingPx: 0,
          radiusPx: 0,
          shadow: "none",
        },
      },
      overlays: { annotations: [], captions: [] },
      audioTracks: [],
      pipTracks: [],
      renderHooks: [],
      preview: { status: "not-requested" },
    });
    const plan = buildCompositionPlanFromProject(
      toProjectRenderInput({
        ...migrated,
        presentationControls: {
          ...migrated.presentationControls,
          cursor: { emphasis: "trail", trailDurationUs: 1_000_000 },
        },
      }),
      {
        cursorTrack: Array.from({ length: 120 }, (_, index) => ({
          sourceId: "capture",
          sourceTimeUs: index * 8_000,
          x: index,
          y: 45,
          state: "default" as const,
        })),
      },
    );
    const history = plan.cursorHistoryAtSource?.("capture", 1_000_000, 1_000_000) ?? [];
    expect(history).toHaveLength(96);
    expect(history[0]).toMatchObject({ tUs: 192_000 });
    expect(history.at(-1)).toMatchObject({ tUs: 952_000 });
    expect(plan.cursorHistoryAtSource?.("missing", 1_000_000, 1_000_000)).toEqual([]);
  });

  it("treats click styling as optional while keeping observed presentation evidence strict", () => {
    const input = toProjectRenderInput(
      migrateV1RecordingProject({
        schemaVersion: 1,
        projectId: "observed-evidence",
        revision: 0,
        revisionPolicy: { automatedRevisionLimit: 1, automatedRevisionCount: 0 },
        captureSources: [
          {
            id: "capture",
            sessionId: "session",
            manifestSha256: "a".repeat(64),
            timelineSha256: "b".repeat(64),
            frameSetSha256: "c".repeat(64),
            sourceWidth: 160,
            sourceHeight: 90,
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
              id: "clip",
              sourceId: "capture",
              trim: { startUs: 0, endUs: 500_000 },
              speedRegions: [],
              zoomRegions: [],
              transitionAfter: { kind: "cut", durationUs: 0 },
            },
          ],
        },
        presentation: {
          cursor: {
            visible: true,
            preset: "system",
            sizePx: 24,
            motion: "source",
            clickEffect: "ripple",
          },
          frame: {
            background: { kind: "solid", color: "#000000" },
            paddingPx: 0,
            radiusPx: 0,
            shadow: "none",
          },
        },
        overlays: { annotations: [], captions: [] },
        audioTracks: [],
        pipTracks: [],
        renderHooks: [],
        preview: { status: "not-requested" },
      }),
    );
    const cursor = {
      sourceId: "capture",
      sourceTimeUs: 250_000,
      x: 80,
      y: 45,
      state: "default" as const,
    };

    expect(buildCompositionPlanFromProject(input, { cursorTrack: [cursor] }).clickEffects).toEqual(
      [],
    );
    expect(() => buildCompositionPlanFromProject(input)).toThrow(
      /visible project cursor requires observed cursor evidence/u,
    );
    expect(() =>
      buildCompositionPlanFromProject(input, {
        cursorTrack: [{ ...cursor, sourceId: "missing" }],
      }),
    ).toThrow(/cursor evidence source is unknown/u);
    expect(() =>
      buildCompositionPlanFromProject(input, {
        cursorTrack: [{ ...cursor, sourceTimeUs: 1_000_001 }],
      }),
    ).toThrow(/cursor evidence is outside its source bounds/u);
    expect(() =>
      buildCompositionPlanFromProject(input, {
        cursorTrack: [{ ...cursor, state: "busy" as "default" }],
      }),
    ).toThrow(/cursor evidence state is invalid/u);
    expect(() =>
      buildCompositionPlanFromProject(input, {
        cursorTrack: [{ ...cursor, sourceTimeUs: 750_000 }],
      }),
    ).toThrow(/cursor evidence does not intersect a rendered clip/u);
    expect(() =>
      buildCompositionPlanFromProject(input, {
        cursorTrack: [cursor],
        clickTrack: [{ sourceId: "capture", sourceTimeUs: 500_001, x: 80, y: 45 }],
      }),
    ).toThrow(/click evidence does not intersect a rendered clip/u);
    expect(() =>
      buildCompositionPlanFromProject(input, {
        cursorTrack: [cursor],
        clickTrack: [{ sourceId: "capture", sourceTimeUs: 1_000_001, x: 80, y: 45 }],
      }),
    ).toThrow(/click evidence is outside its source bounds/u);
    expect(() =>
      buildCompositionPlanFromProject(input, {
        cursorTrack: Array.from({ length: 10_001 }, () => cursor),
      }),
    ).toThrow(/project presentation evidence exceeds its bound/u);
  });

  it("rejects invalid V2 extensions and invalid media timing before a composition can render", () => {
    const input = toProjectRenderInput(
      migrateV1RecordingProject({
        schemaVersion: 1,
        projectId: "v2-render-guards",
        revision: 0,
        revisionPolicy: { automatedRevisionLimit: 1, automatedRevisionCount: 0 },
        captureSources: [
          {
            id: "capture",
            sessionId: "session",
            manifestSha256: "a".repeat(64),
            timelineSha256: "b".repeat(64),
            frameSetSha256: "c".repeat(64),
            sourceWidth: 160,
            sourceHeight: 90,
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
              id: "clip",
              sourceId: "capture",
              trim: { startUs: 0, endUs: 1_000_000 },
              speedRegions: [],
              zoomRegions: [],
              transitionAfter: { kind: "cut", durationUs: 0 },
            },
          ],
        },
        presentation: {
          cursor: {
            visible: true,
            preset: "system",
            sizePx: 24,
            motion: "source",
            clickEffect: "none",
          },
          frame: {
            background: { kind: "solid", color: "#000000" },
            paddingPx: 0,
            radiusPx: 0,
            shadow: "none",
          },
        },
        overlays: { annotations: [], captions: [] },
        audioTracks: [],
        pipTracks: [],
        renderHooks: [],
        preview: { status: "not-requested" },
      }),
    );
    const presentationControls = {
      cursor: { emphasis: "none" as const, trailDurationUs: 0 },
      frame: { fit: "contain" as const, border: "none" as const },
      export: {
        audio: "include" as const,
        colorRange: "limited" as const,
        metadata: "none" as const,
      },
    };
    const v2 = {
      ...input,
      timelineTransitions: [],
      zoomProposals: [],
      visualTracks: [],
      media: { assets: [] },
      presentationControls,
    };

    expect(() => buildCompositionPlanFromProject({ ...input, captureSources: [] })).toThrow(
      /project has no capture sources/u,
    );
    expect(() =>
      buildCompositionPlanFromProject({
        ...input,
        renderHooks: [
          {
            id: "unapproved",
            kind: "metadata",
            permission: "unapproved" as "explicit-local-render-hook",
            status: "declared",
          },
        ],
      }),
    ).toThrow(/project render hook is not permitted/u);
    expect(() =>
      buildCompositionPlanFromProject({
        ...v2,
        presentationControls: undefined,
      } as unknown as ProjectRenderInput),
    ).toThrow(/V2 project presentation controls are unavailable/u);
    expect(() =>
      buildCompositionPlanFromProject({
        ...v2,
        presentation: {
          ...input.presentation,
          cursor: { ...input.presentation.cursor, visible: false },
        },
        presentationControls: {
          ...presentationControls,
          cursor: { emphasis: "spotlight" as const, trailDurationUs: 0 },
        },
      } as unknown as ProjectRenderInput),
    ).toThrow(/V2 cursor emphasis requires an observed visible cursor/u);
    expect(() =>
      buildCompositionPlanFromProject({
        ...v2,
        visualTracks: [
          {
            id: "visual",
            mediaId: "missing",
            clipId: "clip",
            timeDomain: "clip-source-relative" as const,
            startUs: 0,
            endUs: 1,
            mediaTrim: { startUs: 0, endUs: 1 },
            sync: "source-time" as const,
            layout: {
              position: "bottom-right" as const,
              scale: 0.25,
              fit: "contain" as const,
              crop: "none" as const,
              opacity: 1,
              radiusPx: 0,
              border: "none" as const,
            },
            motion: { preset: "none" as const, durationUs: 0 },
          },
        ],
      } as unknown as ProjectRenderInput),
    ).toThrow(/visual track media is unavailable/u);
    expect(() =>
      buildCompositionPlan({
        schemaVersion: 1,
        source: { width: 160, height: 90, fps: 30, durationUs: 1_000_000 },
        clips: [{ id: "clip", startUs: 0, endUs: 1_000_000 }],
        pipTracks: [
          {
            assetId: "pip",
            sha256: "d".repeat(64),
            startUs: 0,
            endUs: 1_000_001,
          },
        ],
      }),
    ).toThrow(/PiP timing is invalid/u);
  });

  it("fails closed on malformed direct composition evidence and presentation inputs", () => {
    const clip = { id: "clip", startUs: 0, endUs: 1_000_000 };
    const input = {
      schemaVersion: 1 as const,
      source: { width: 160, height: 90, fps: 30, durationUs: 1_000_000 },
      clips: [clip],
    };

    expect(() => buildCompositionPlan({ ...input, schemaVersion: 2 as 1 })).toThrow(
      /composition schema is unsupported/u,
    );
    expect(() => buildCompositionPlan({ ...input, clips: [] })).toThrow(
      /composition requires at least one clip/u,
    );
    expect(() => buildCompositionPlan({ ...input, source: { ...input.source, width: 0 } })).toThrow(
      /source width must be finite/u,
    );
    expect(() =>
      buildCompositionPlan({ ...input, clips: [{ ...clip, endUs: 1_000_001 }] }),
    ).toThrow(/clips must have valid ranges/u);
    expect(() =>
      buildCompositionPlan({
        ...input,
        clips: [
          {
            ...clip,
            speedRegions: [{ startUs: 0, endUs: 1, startRate: 0.05, endRate: 1 }],
          },
        ],
      }),
    ).toThrow(/speed region is invalid/u);
    expect(() =>
      buildCompositionPlan({
        ...input,
        frame: {
          background: { kind: "gradient", from: "#112233", to: "#445566" },
          padding: 12,
          radius: 8,
          shadow: "strong",
        },
      }),
    ).not.toThrow();
    expect(() =>
      buildCompositionPlan({
        ...input,
        cursorTrack: [
          { tUs: 0, x: 1, y: 1, state: "default" },
          { tUs: 0, x: 2, y: 2, state: "pressed" },
        ],
      }),
    ).toThrow(/cursor timestamps must be strictly increasing/u);
    expect(() =>
      buildCompositionPlan({
        ...input,
        cursorTrack: [{ tUs: 0, x: 1, y: 1, state: "busy" as never }],
      }),
    ).toThrow(/cursor state/u);
    expect(() =>
      buildCompositionPlan({
        ...input,
        clickTrack: [{ tUs: 0, x: 1, y: 1, button: 3 as never }],
      }),
    ).toThrow(/click button/u);
    expect(() =>
      buildCompositionPlan({
        ...input,
        zoomRegions: [{ id: "zoom", tUs: 0, x: 1, y: 1, scale: 2.1 }],
      }),
    ).toThrow(/zoom scale must be between 1 and 2/u);
    expect(() =>
      buildCompositionPlan({
        ...input,
        captions: [{ id: "caption", startUs: 0, endUs: 1_000_001, text: "Too long" }],
      }),
    ).toThrow(/caption timing is invalid/u);
    expect(() =>
      buildCompositionPlan({
        ...input,
        annotations: [
          {
            id: "annotation",
            startUs: 0,
            endUs: 1,
            text: "Bad coordinate",
            kind: "label",
            x: 0,
            y: Number.NaN,
          },
        ],
      }),
    ).toThrow(/annotation y must be finite/u);
    expect(() =>
      buildCompositionPlan({
        ...input,
        audioTracks: [{ assetId: "audio", sha256: "not-a-digest", startUs: 0 }],
      }),
    ).toThrow(/audio digest is invalid/u);
    expect(() =>
      buildCompositionPlan({
        ...input,
        audioTracks: [{ assetId: "audio", sha256: "d".repeat(64), startUs: 0, gainDb: 25 }],
      }),
    ).toThrow(/audio gain/u);
    expect(() =>
      buildCompositionPlan({
        ...input,
        pipTracks: [{ assetId: "pip", sha256: "not-a-digest", startUs: 0, endUs: 1 }],
      }),
    ).toThrow(/PiP digest is invalid/u);
  });

  it("resolves a reusable preset into an immutable, action-led presentation plan", () => {
    const plan = buildCompositionPlan({
      schemaVersion: 1,
      preset: "studio",
      profile: "vertical",
      source: { width: 1440, height: 900, fps: 30, durationUs: 3_000_000 },
      cursorTrack: [
        { tUs: 0, x: 120, y: 160, state: "default" },
        { tUs: 1_000_000, x: 720, y: 420, state: "pressed" },
      ],
      clickTrack: [{ tUs: 1_000_000, x: 720, y: 420, button: 0 }],
      zoomRegions: [{ id: "primary-action", tUs: 1_000_000, x: 720, y: 420 }],
      captions: [{ id: "caption-1", startUs: 800_000, endUs: 1_800_000, text: "Create a report" }],
      annotations: [
        {
          id: "note-1",
          startUs: 900_000,
          endUs: 1_500_000,
          kind: "label",
          text: "Choose Export",
          x: 720,
          y: 420,
        },
      ],
      clips: [{ id: "capture", startUs: 0, endUs: 3_000_000 }],
      hooks: ["safe-title-card"],
    });

    expect(plan.output).toEqual({
      format: "mp4",
      width: 1080,
      height: 1920,
      fps: 30,
      quality: "standard",
    });
    expect(plan.style.background).toEqual({ kind: "gradient", from: "#0f172a", to: "#1e3a8a" });
    expect(plan.cursorAt(500_000)).toMatchObject({ x: 420, y: 290, state: "default" });
    expect(plan.cursorAt(1_000_000)).toMatchObject({ x: 720, y: 420, state: "pressed" });
    expect(plan.clickEffects).toEqual([
      expect.objectContaining({ x: 720, y: 420, startUs: 1_000_000, durationUs: 450_000 }),
    ]);
    expect(plan.zoomAt(1_000_000)).toMatchObject({
      scale: expect.closeTo(1.16, 5),
      x: 720,
      y: 420,
    });
    expect(plan.hooks).toEqual(["safe-title-card"]);
    expect(plan.captions[0]).toEqual(expect.objectContaining({ text: "Create a report" }));
  });

  it("maps pauses to bounded speed-up segments without changing source evidence order", () => {
    expect(
      mapPresentationTimeline({
        durationUs: 5_000_000,
        actions: [
          { tUs: 0, sourceFrameId: 1 },
          { tUs: 4_000_000, sourceFrameId: 2 },
        ],
        maximumHoldUs: 1_000_000,
        idleSpeed: 4,
      }),
    ).toEqual({
      durationUs: 2_750_000,
      segments: [
        { sourceStartUs: 0, sourceEndUs: 1_000_000, presentationStartUs: 0, speed: 1 },
        {
          sourceStartUs: 1_000_000,
          sourceEndUs: 4_000_000,
          presentationStartUs: 1_000_000,
          speed: 4,
        },
        {
          sourceStartUs: 4_000_000,
          sourceEndUs: 5_000_000,
          presentationStartUs: 1_750_000,
          speed: 1,
        },
      ],
    });
  });

  it("rejects unknown presets, hooks, malformed text, and arbitrary executable hooks", () => {
    expect(() => resolveRenderPreset("not-a-preset")).toThrow(/preset/u);
    expect(() => resolveRenderHooks(["exec:curl"])).toThrow(/hook/u);
    expect(() =>
      buildCompositionPlan({
        schemaVersion: 1,
        source: { width: 1, height: 1, fps: 30, durationUs: 1_000_000 },
        clips: [{ id: "capture", startUs: 0, endUs: 1_000_000 }],
        captions: [{ id: "bad", startUs: 0, endUs: 1, text: "line\nbreak" }],
      }),
    ).toThrow(/single line/u);
  });

  it("adapts the path-free project renderer contract without giving the renderer a raw media path", () => {
    const plan = buildCompositionPlanFromProject(
      {
        projectId: "project-1",
        revision: 2,
        revisionPolicy: { automatedRevisionLimit: 3, automatedRevisionCount: 1 },
        captureSources: [
          {
            id: "source-1",
            sessionId: "session-1",
            manifestSha256: "a".repeat(64),
            timelineSha256: "b".repeat(64),
            frameSetSha256: "c".repeat(64),
            sourceWidth: 1440,
            sourceHeight: 900,
            durationUs: 2_000_000,
          },
        ],
        output: {
          profile: "square-1080",
          width: 1080,
          height: 1080,
          fps: 30,
          format: "gif",
          quality: "high",
        },
        timeline: {
          clips: [
            {
              id: "clip-1",
              sourceId: "source-1",
              trim: { startUs: 0, endUs: 2_000_000 },
              speedRegions: [{ startUs: 500_000, endUs: 1_500_000, startRate: 2, endRate: 4 }],
              zoomRegions: [
                {
                  id: "zoom-1",
                  startUs: 500_000,
                  endUs: 1_000_000,
                  mode: "automatic",
                  focus: { x: 0.5, y: 0.4 },
                  scale: 1.2,
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
            preset: "large",
            sizePx: 32,
            motion: "smoothed",
            clickEffect: "ripple",
          },
          frame: {
            background: { kind: "solid", color: "#ffffff" },
            paddingPx: 48,
            radiusPx: 24,
            shadow: "soft",
          },
        },
        overlays: {
          annotations: [
            {
              id: "annotation-1",
              clipId: "clip-1",
              startUs: 0,
              endUs: 1_000_000,
              timeDomain: "clip-source-relative",
              text: { value: "Review this", provenance: "authored", exportDisposition: "allow" },
              position: "top",
              style: "emphasis",
            },
          ],
          captions: [
            {
              id: "caption-1",
              clipId: "clip-1",
              timeDomain: "clip-source-relative",
              startUs: 0,
              endUs: 1_000_000,
              text: { value: "Narration", provenance: "authored", exportDisposition: "allow" },
            },
          ],
        },
        audioTracks: [
          {
            id: "audio-1",
            asset: { assetId: "audio-asset", sha256: "d".repeat(64) },
            timeDomain: "project-output-relative",
            startUs: 0,
            trim: { startUs: 0, endUs: 2_000_000 },
            gainDb: -3,
          },
        ],
        pipTracks: [
          {
            id: "pip-1",
            asset: { assetId: "pip-asset", sha256: "e".repeat(64) },
            clipId: "clip-1",
            timeDomain: "clip-source-relative",
            startUs: 500_000,
            endUs: 1_500_000,
            position: "top-right",
            scale: 0.25,
          },
        ],
        renderHooks: [
          {
            id: "hook-1",
            kind: "metadata",
            permission: "explicit-local-render-hook",
            status: "declared",
          },
        ],
      },
      {
        cursorTrack: [
          { sourceId: "source-1", sourceTimeUs: 250_000, x: 10, y: 10, state: "default" },
        ],
        clickTrack: [{ sourceId: "source-1", sourceTimeUs: 500_000, x: 10, y: 10 }],
      },
    );

    expect(plan.output).toMatchObject({
      format: "gif",
      width: 1080,
      height: 1080,
      quality: "high",
    });
    expect(plan.clips[0]).toMatchObject({
      transitionAfter: { kind: "cut", durationUs: 0 },
      speedRegions: expect.any(Array),
    });
    expect(plan.audioTracks[0]).toMatchObject({ assetId: "audio-asset", gainDb: -3 });
    expect(plan.pipTracks[0]).toMatchObject({
      assetId: "pip-asset",
      corner: "top-right",
      clipId: "clip-1",
    });
    expect(plan.captions[0]).toMatchObject({
      clipId: "clip-1",
      timeDomain: "clip-source-relative",
    });
    expect(plan.annotations[0]).toMatchObject({
      clipId: "clip-1",
      timeDomain: "clip-source-relative",
    });
    expect(plan.sourceGeometries).toEqual([
      { id: "source-1", width: 1440, height: 900, durationUs: 2_000_000 },
    ]);
    expect(plan.zoomAt(750_000)).toMatchObject({ x: 720, y: 360, scale: expect.closeTo(1.2, 5) });
    expect(plan.zoomAt(750_000, "clip-1", 750_000)).toMatchObject({
      x: 720,
      y: 360,
      scale: expect.closeTo(1.085, 5),
    });
    expect(plan.style.cursor.size).toBeGreaterThan(1.9);
    expect(plan.cursorAtSource?.("source-1", 250_000)).toMatchObject({ x: 10, y: 10 });
    expect(plan.cursorAtSource?.("missing", 250_000)).toBeUndefined();
    expect(plan.clickEffects[0]).toMatchObject({
      clipId: "clip-1",
      kind: "ripple",
      startUs: 500_000,
    });
    expect(plan.hooks).toEqual(["safe-title-card"]);
    expect(JSON.stringify(plan)).not.toContain("path");
  });

  it("uses only accepted V2 zoom proposals instead of unreviewed proposals or legacy zooms", () => {
    const migrated = migrateV1RecordingProject({
      schemaVersion: 1,
      projectId: "reviewed-zoom-project",
      revision: 0,
      revisionPolicy: { automatedRevisionLimit: 1, automatedRevisionCount: 0 },
      captureSources: [
        {
          id: "capture-1",
          sessionId: "session-1",
          manifestSha256: "a".repeat(64),
          timelineSha256: "b".repeat(64),
          frameSetSha256: "c".repeat(64),
          sourceWidth: 160,
          sourceHeight: 90,
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
            zoomRegions: [
              {
                id: "legacy-zoom",
                startUs: 0,
                endUs: 1_000_000,
                mode: "manual",
                focus: { x: 0.1, y: 0.1 },
                scale: 1.1,
                easing: "linear",
              },
            ],
            transitionAfter: { kind: "cut", durationUs: 0 },
          },
          {
            id: "clip-2",
            sourceId: "capture-1",
            trim: { startUs: 0, endUs: 1_000_000 },
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
          sizePx: 24,
          motion: "source",
          clickEffect: "none",
        },
        frame: {
          background: { kind: "solid", color: "#000000" },
          paddingPx: 0,
          radiusPx: 0,
          shadow: "none",
        },
      },
      overlays: { annotations: [], captions: [] },
      audioTracks: [],
      pipTracks: [],
      renderHooks: [],
      preview: { status: "not-requested" },
    });
    const project = {
      ...migrated,
      timeline: {
        clips: [
          {
            ...migrated.timeline.clips[0],
            transitionAfter: { kind: "crossfade" as const, durationUs: 100_000 },
          },
          migrated.timeline.clips[1],
        ],
      },
      timelineTransitions: [
        {
          clipId: "clip-1",
          family: "wipe-left" as const,
          durationUs: 100_000,
          easing: "ease-out" as const,
        },
      ],
      zoomProposals: [
        {
          id: "proposed",
          clipId: "clip-1",
          sourceRange: { startUs: 0, endUs: 1_000_000 },
          focus: { x: 0.9, y: 0.9 },
          scale: 2,
          easing: "linear" as const,
          review: { status: "proposed" as const, basis: "manual" as const },
        },
        {
          id: "rejected",
          clipId: "clip-1",
          sourceRange: { startUs: 0, endUs: 1_000_000 },
          focus: { x: 0.8, y: 0.8 },
          scale: 2,
          easing: "linear" as const,
          review: { status: "rejected" as const, basis: "manual" as const },
        },
        {
          id: "accepted",
          clipId: "clip-1",
          sourceRange: { startUs: 0, endUs: 1_000_000 },
          focus: { x: 0.25, y: 0.75 },
          scale: 1.5,
          easing: "linear" as const,
          review: { status: "accepted" as const, basis: "observed-input" as const },
        },
      ],
    };

    const plan = buildCompositionPlanFromProject(toProjectRenderInput(project));

    expect(plan.zoomAt(750_000, "clip-1", 750_000)).toEqual({
      x: 40,
      y: 67.5,
      scale: 1.375,
    });
    expect(plan.reviewedTransitions).toEqual([
      { clipId: "clip-1", family: "wipe-left", durationUs: 100_000, easing: "ease-out" },
    ]);
    expect(plan.presentationControls).toEqual(migrated.presentationControls);
    expect(() =>
      buildCompositionPlanFromProject(
        toProjectRenderInput({
          ...project,
          presentationControls: {
            ...project.presentationControls,
            cursor: { emphasis: "spotlight" as const, trailDurationUs: 0 },
          },
        }),
      ),
    ).toThrow(/visible cursor/u);
  });
});
