import { describe, expect, it } from "vitest";

import { type ActivityAnalysisInput, analyzeDeadTime } from "../../src/analysis/index.js";

const digest = (character: string): string => character.repeat(64);

const baseConfig = {
  openingContextUs: 1_000_000,
  endingContextUs: 1_000_000,
  actionContextUs: 250_000,
  clickNavigationContextUs: 500_000,
  staticVisualChangeScore: 0.01,
  readingVisualChangeScore: 0.1,
  idleReviewDurationUs: 2_000_000,
  staticReadingReviewDurationUs: 3_000_000,
};

const staticInput = (): ActivityAnalysisInput => ({
  schemaVersion: 1,
  captureDurationUs: 12_000_000,
  frameSamples: [
    { tUs: 0, sha256: digest("a") },
    { tUs: 3_000_000, sha256: digest("a") },
    { tUs: 6_000_000, sha256: digest("a") },
    { tUs: 9_000_000, sha256: digest("a") },
  ],
  actionSamples: [],
  config: baseConfig,
});

describe("analyzeDeadTime", () => {
  it("marks sustained static evidence as review-trim after protected context", () => {
    const result = analyzeDeadTime(staticInput());

    expect(
      result.intervals.some(
        (interval) =>
          interval.classification === "idle" &&
          interval.suggestedAction === "review-trim" &&
          interval.startUs >= 1_000_000 &&
          interval.endUs <= 11_000_000,
      ),
    ).toBe(true);
    expect(
      result.intervals.filter(
        (interval) => interval.startUs < 1_000_000 || interval.endUs > 11_000_000,
      ),
    ).toEqual(expect.arrayContaining([expect.objectContaining({ suggestedAction: "keep" })]));
  });

  it("keeps pointer, scroll, and click activity", () => {
    const input: ActivityAnalysisInput = {
      ...staticInput(),
      actionSamples: [
        { tUs: 3_000_000, kind: "pointer" },
        { tUs: 5_000_000, kind: "scroll" },
        { tUs: 7_000_000, kind: "click" },
      ],
    };

    const result = analyzeDeadTime(input);

    expect(result.intervals).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ classification: "static-reading", suggestedAction: "keep" }),
        expect.objectContaining({ classification: "active", suggestedAction: "keep" }),
      ]),
    );
    expect(
      result.intervals.some(
        (interval) =>
          interval.suggestedAction === "review-trim" &&
          interval.startUs <= 7_000_000 &&
          interval.endUs >= 7_000_000,
      ),
    ).toBe(false);
  });

  it("classifies minor visual change as static-reading and applies its explicit review rule", () => {
    const input: ActivityAnalysisInput = {
      ...staticInput(),
      frameSamples: [
        { tUs: 0, sha256: digest("a") },
        { tUs: 4_000_000, sha256: digest("b"), visualChangeScore: 0.05 },
        { tUs: 8_000_000, sha256: digest("c"), visualChangeScore: 0.05 },
      ],
    };

    const result = analyzeDeadTime(input);

    expect(result.intervals).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          classification: "static-reading",
          suggestedAction: "review-trim",
        }),
      ]),
    );
  });

  it("keeps sparse, unbracketed tails instead of treating missing frames as static evidence", () => {
    const input: ActivityAnalysisInput = {
      ...staticInput(),
      frameSamples: [
        { tUs: 0, sha256: digest("a") },
        { tUs: 2_000_000, sha256: digest("a") },
      ],
    };

    const result = analyzeDeadTime(input);
    const unsupportedTail = result.intervals.find(
      (interval) => interval.startUs === 2_000_000 && interval.endUs === 11_000_000,
    );

    expect(unsupportedTail).toEqual(
      expect.objectContaining({
        classification: "idle",
        suggestedAction: "keep",
        confidence: expect.any(Number),
        evidence: expect.objectContaining({ staticFramePairs: 0 }),
      }),
    );
    expect(unsupportedTail?.confidence).toBeLessThan(0.5);
  });

  it("keeps large unsampled gaps around a navigation buffer", () => {
    const input: ActivityAnalysisInput = {
      ...staticInput(),
      frameSamples: [
        { tUs: 0, sha256: digest("a") },
        { tUs: 1_000_000, sha256: digest("a") },
      ],
      actionSamples: [{ tUs: 8_000_000, kind: "navigation" }],
    };

    const result = analyzeDeadTime(input);

    expect(result.intervals).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          startUs: 1_000_000,
          endUs: 7_500_000,
          classification: "idle",
          suggestedAction: "keep",
          evidence: expect.objectContaining({ staticFramePairs: 0 }),
        }),
        expect.objectContaining({
          startUs: 7_500_000,
          endUs: 8_500_000,
          classification: "active",
          suggestedAction: "keep",
        }),
      ]),
    );
    expect(result.intervals.some((interval) => interval.suggestedAction === "review-trim")).toBe(
      false,
    );
  });

  it("preserves short pauses surrounding discrete activity and both context boundaries", () => {
    const input: ActivityAnalysisInput = {
      ...staticInput(),
      captureDurationUs: 6_000_000,
      frameSamples: [
        { tUs: 0, sha256: digest("a") },
        { tUs: 2_000_000, sha256: digest("a") },
        { tUs: 2_100_000, sha256: digest("a") },
        { tUs: 5_000_000, sha256: digest("a") },
      ],
      actionSamples: [{ tUs: 2_000_000, kind: "navigation" }],
    };

    const result = analyzeDeadTime(input);

    expect(
      result.intervals.some(
        (interval) =>
          interval.classification === "active" &&
          interval.startUs <= 2_000_000 &&
          interval.endUs >= 2_100_000,
      ),
    ).toBe(true);
    expect(
      result.intervals.some(
        (interval) => interval.startUs === 0 && interval.suggestedAction === "keep",
      ),
    ).toBe(true);
    expect(
      result.intervals.some(
        (interval) => interval.endUs === 6_000_000 && interval.suggestedAction === "keep",
      ),
    ).toBe(true);
  });

  it("is deterministic and includes a canonical analysis digest", () => {
    const first = analyzeDeadTime(staticInput());
    const second = analyzeDeadTime(staticInput());

    expect(first).toEqual(second);
    expect(first.analysisSha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it("rejects malformed, unordered, path-like, and flooded evidence", () => {
    expect(() =>
      analyzeDeadTime({ ...staticInput(), unexpectedPath: "/private/tmp/frame.png" }),
    ).toThrow(/unknown field/i);
    expect(() =>
      analyzeDeadTime({
        ...staticInput(),
        frameSamples: [
          { tUs: 2, sha256: digest("a") },
          { tUs: 2, sha256: digest("a") },
        ],
      }),
    ).toThrow(/strictly increasing/i);
    expect(() =>
      analyzeDeadTime({
        ...staticInput(),
        actionSamples: [{ tUs: 12_000_001, kind: "click" }],
      }),
    ).toThrow(/within 0\.\.12000000/i);
    expect(() =>
      analyzeDeadTime({
        ...staticInput(),
        actionSamples: [{ tUs: 1, kind: "click", text: "password" }],
      }),
    ).toThrow(/unknown field/i);
    expect(() =>
      analyzeDeadTime({
        ...staticInput(),
        frameSamples: Array.from({ length: 10_001 }, (_, index) => ({
          tUs: index,
          sha256: digest("a"),
        })),
      }),
    ).toThrow(/at most 10000/i);
  });
});
