import { describe, expect, it } from "vitest";

import {
  buildCompositionPlan,
  buildCompositionPlanFromProject,
  mapPresentationTimeline,
  resolveRenderHooks,
  resolveRenderPreset,
} from "../../src/render/composition.js";

describe("deterministic composition planning", () => {
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
});
