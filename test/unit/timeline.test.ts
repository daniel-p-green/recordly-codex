import { describe, expect, it } from "vitest";

import { normalizeFrameGrid } from "../../src/timeline/frame-grid.js";
import { cssPointToCapturePoint } from "../../src/timeline/coordinates.js";
import { selectZoomCandidates } from "../../src/timeline/zoom.js";

describe("constant-frame-rate normalization", () => {
  it("selects the newest received source frame at or before each output slot", () => {
    const normalized = normalizeFrameGrid(
      [
        { frameId: 1, tUs: 0 },
        { frameId: 2, tUs: 140_000 },
        { frameId: 3, tUs: 260_000 },
      ],
      { fps: 10, durationUs: 350_000, cadenceGapUs: 100_000 },
    );

    expect(normalized.slots.map((slot) => slot.sourceFrameId)).toEqual([1, 1, 2, 3]);
    expect(normalized.slots.map((slot) => slot.isDistinctSource)).toEqual([
      true,
      false,
      true,
      true,
    ]);
    expect(normalized.health.longestInterFrameGapUs).toBe(140_000);
    expect(normalized.health.cadenceGaps).toEqual([
      { fromFrameId: 1, toFrameId: 2, gapUs: 140_000 },
      { fromFrameId: 2, toFrameId: 3, gapUs: 120_000 },
    ]);
  });

  it("fails closed for invalid source ordering and never invents a pre-capture frame", () => {
    expect(() =>
      normalizeFrameGrid(
        [
          { frameId: 2, tUs: 10 },
          { frameId: 1, tUs: 0 },
        ],
        { fps: 30, durationUs: 100_000 },
      ),
    ).toThrow(/strictly increasing/i);

    const normalized = normalizeFrameGrid([{ frameId: 1, tUs: 50_000 }], {
      fps: 10,
      durationUs: 200_000,
    });
    expect(normalized.slots.map((slot) => slot.sourceFrameId)).toEqual([undefined, 1]);
    expect(() => normalizeFrameGrid([], { fps: 0, durationUs: 1 })).toThrow(/positive/i);
    expect(() => normalizeFrameGrid([{ frameId: 1, tUs: -1 }], { fps: 30, durationUs: 1 })).toThrow(
      /non-negative/i,
    );
  });
});

describe("coordinate transform", () => {
  it("maps CSS viewport coordinates to capture-frame pixels and clamps capture bounds", () => {
    expect(
      cssPointToCapturePoint(
        { x: 720, y: 450 },
        { width: 1440, height: 900 },
        { width: 2880, height: 1800 },
      ),
    ).toEqual({ x: 1440, y: 900 });
    expect(
      cssPointToCapturePoint(
        { x: 1600, y: -10 },
        { width: 1440, height: 900 },
        { width: 2880, height: 1800 },
      ),
    ).toEqual({ x: 2880, y: 0 });
    expect(() =>
      cssPointToCapturePoint(
        { x: Number.NaN, y: 0 },
        { width: 1, height: 1 },
        { width: 1, height: 1 },
      ),
    ).toThrow(/finite/i);
    expect(() =>
      cssPointToCapturePoint({ x: 0, y: 0 }, { width: 0, height: 1 }, { width: 1, height: 1 }),
    ).toThrow(/positive/i);
  });
});

describe("zoom candidate selection", () => {
  it("uses deterministic priority and lexical ID tie resolution within the overlap window", () => {
    const selected = selectZoomCandidates(
      [
        { id: "scroll", tUs: 1_000_000, kind: "scroll", x: 500, y: 500 },
        { id: "click", tUs: 1_100_000, kind: "click", x: 500, y: 500 },
        { id: "marker-z", tUs: 1_200_000, kind: "marker", x: 500, y: 500 },
        { id: "marker-a", tUs: 1_250_000, kind: "marker", x: 500, y: 500 },
      ],
      { minSeparationUs: 1_200_000 },
    );

    expect(selected).toEqual([
      expect.objectContaining({
        id: "marker-a",
        score: 4,
        wonAgainst: ["click", "marker-z", "scroll"],
      }),
    ]);
    expect(
      selectZoomCandidates([
        { id: "first", tUs: 0, kind: "scroll", x: 1, y: 1 },
        { id: "second", tUs: 1_200_000, kind: "type", x: 2, y: 2 },
      ]),
    ).toMatchObject([{ id: "first" }, { id: "second" }]);
    expect(() => selectZoomCandidates([], { minSeparationUs: -1 })).toThrow(/non-negative/i);
    expect(() => selectZoomCandidates([{ id: "", tUs: 0, kind: "click", x: 1, y: 1 }])).toThrow(
      /bounded/i,
    );
  });
});
