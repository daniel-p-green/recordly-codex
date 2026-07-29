import { describe, expect, it } from "vitest";

import {
  analyzeDeadTime,
  applyAcceptedEditorialProposal,
  buildEditorialProposal,
  type EditorialProposalInput,
  migrateV1RecordingProject,
} from "../../src/index.js";

const sha = (character: string) => character.repeat(64);

function project() {
  return migrateV1RecordingProject({
    schemaVersion: 1,
    projectId: "editorial-demo",
    revision: 0,
    revisionPolicy: { automatedRevisionLimit: 2, automatedRevisionCount: 0 },
    captureSources: [
      {
        id: "capture-a",
        sessionId: "session-a",
        manifestSha256: sha("a"),
        timelineSha256: sha("b"),
        frameSetSha256: sha("c"),
        sourceWidth: 1000,
        sourceHeight: 500,
        durationUs: 10_000_000,
      },
      {
        id: "capture-b",
        sessionId: "session-b",
        manifestSha256: sha("d"),
        timelineSha256: sha("e"),
        frameSetSha256: sha("f"),
        sourceWidth: 800,
        sourceHeight: 800,
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
          id: "clip-a",
          sourceId: "capture-a",
          trim: { startUs: 0, endUs: 10_000_000 },
          speedRegions: [],
          zoomRegions: [],
          transitionAfter: { kind: "cut", durationUs: 0 },
        },
        {
          id: "clip-b",
          sourceId: "capture-b",
          trim: { startUs: 0, endUs: 8_000_000 },
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
        sizePx: 28,
        motion: "source",
        clickEffect: "none",
      },
      frame: {
        background: { kind: "solid", color: "#111827" },
        paddingPx: 24,
        radiusPx: 12,
        shadow: "soft",
      },
    },
    overlays: { annotations: [], captions: [] },
    audioTracks: [],
    pipTracks: [],
    renderHooks: [],
    preview: { status: "not-requested" },
  });
}

function analysis(durationUs: number) {
  return analyzeDeadTime({
    schemaVersion: 1,
    captureDurationUs: durationUs,
    frameSamples: [
      { tUs: 0, sha256: sha("a") },
      { tUs: 3_000_000, sha256: sha("a") },
      { tUs: durationUs - 1_000_000, sha256: sha("a") },
    ],
    actionSamples: [],
    config: {
      openingContextUs: 500_000,
      endingContextUs: 500_000,
      actionContextUs: 250_000,
      clickNavigationContextUs: 500_000,
      staticVisualChangeScore: 0.01,
      readingVisualChangeScore: 0.1,
      idleReviewDurationUs: 1_000_000,
      staticReadingReviewDurationUs: 2_000_000,
      mergeGapUs: 0,
    },
  });
}

function input(): EditorialProposalInput {
  const current = project();
  return {
    schemaVersion: 1,
    project: current,
    observedEvents: [
      {
        id: "event-a",
        source: "observed",
        sourceId: "capture-a",
        tUs: 3_000_000,
        kind: "click",
        x: 250,
        y: 125,
      },
      {
        id: "event-a-near",
        source: "observed",
        sourceId: "capture-a",
        tUs: 3_100_000,
        kind: "scroll",
        x: 350,
        y: 225,
      },
      {
        id: "event-b",
        source: "observed",
        sourceId: "capture-b",
        tUs: 2_000_000,
        kind: "click",
        x: 400,
        y: 200,
      },
      {
        id: "event-nav",
        source: "observed",
        sourceId: "capture-b",
        tUs: 4_000_000,
        kind: "navigation",
      },
    ],
    deadTimeBySource: [
      { sourceId: "capture-a", analysis: analysis(10_000_000) },
      { sourceId: "capture-b", analysis: analysis(8_000_000) },
    ],
  };
}

describe("deterministic editorial proposals", () => {
  it("makes a canonical, source-bound proposal with coalesced observed zoom evidence and review-only trims", () => {
    const first = buildEditorialProposal(input());
    const second = buildEditorialProposal(input());

    expect(first).toEqual(second);
    expect(first.proposalSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(first.zoomProposals).toHaveLength(2);
    expect(first.zoomProposals[0]).toMatchObject({
      clipId: "clip-a",
      focus: { x: 0.3, y: 0.35 },
      evidence: { observedEventIds: ["event-a", "event-a-near"] },
    });
    expect(first.zoomProposals[1]).toMatchObject({ clipId: "clip-b", focus: { x: 0.5, y: 0.25 } });
    expect(first.reviewTrimProposals.length).toBeGreaterThan(0);
    expect(first.reviewTrimProposals.every((proposal) => proposal.action === "review-trim")).toBe(
      true,
    );
    expect(first.transitionSuggestions).toEqual([
      expect.objectContaining({ fromClipId: "clip-a", toClipId: "clip-b", family: "cut" }),
    ]);
  });

  it("rejects planned, forged, out-of-geometry, and cross-source evidence", () => {
    const planned = input();
    planned.observedEvents = [
      {
        ...(planned.observedEvents[0] as EditorialProposalInput["observedEvents"][number]),
        source: "planned",
      } as never,
    ];
    expect(() => buildEditorialProposal(planned)).toThrow(/observed/i);

    const forged = input();
    forged.deadTimeBySource = [
      {
        sourceId: "capture-a",
        analysis: { ...analysis(10_000_000), analysisSha256: sha("0") },
      },
    ];
    expect(() => buildEditorialProposal(forged)).toThrow(/digest|analysis/i);

    const missing = input();
    const firstAnalysis = missing.deadTimeBySource.at(0);
    if (firstAnalysis === undefined) throw new Error("fixture analysis missing");
    missing.deadTimeBySource = [firstAnalysis];
    expect(() => buildEditorialProposal(missing)).toThrow(/every project capture source/i);

    const outside = input();
    outside.observedEvents = [
      {
        ...(outside.observedEvents[0] as EditorialProposalInput["observedEvents"][number]),
        x: 1001,
      },
    ];
    expect(() => buildEditorialProposal(outside)).toThrow(/geometry/i);

    const unknownSource = input();
    unknownSource.observedEvents = [
      {
        ...(unknownSource.observedEvents[0] as EditorialProposalInput["observedEvents"][number]),
        sourceId: "capture-nope",
      },
    ];
    expect(() => buildEditorialProposal(unknownSource)).toThrow(/source/i);
  });

  it("only revises from explicit accepted zoom IDs, consumes one budget, and stales preview", () => {
    const current = project();
    const proposal = buildEditorialProposal({ ...input(), project: current });
    const accepted = proposal.zoomProposals[0];
    if (accepted === undefined) throw new Error("zoom proposal missing");

    const revised = applyAcceptedEditorialProposal(current, proposal, [accepted.id]);
    expect(revised).toMatchObject({
      schemaVersion: 2,
      revision: 1,
      revisionPolicy: { automatedRevisionLimit: 2, automatedRevisionCount: 1 },
      preview: { status: "stale", revision: 0 },
    });
    expect(revised.zoomProposals).toEqual([
      expect.objectContaining({
        id: accepted.id,
        review: { status: "accepted", basis: "observed-input" },
      }),
    ]);

    expect(() => applyAcceptedEditorialProposal(current, proposal, [])).toThrow(/accepted/i);
    expect(() =>
      applyAcceptedEditorialProposal(current, proposal, [
        proposal.reviewTrimProposals[0]?.id ?? "nope",
      ]),
    ).toThrow(/zoom/i);
    const exhausted = {
      ...current,
      revisionPolicy: { automatedRevisionLimit: 0, automatedRevisionCount: 0 },
    };
    const exhaustedProposal = buildEditorialProposal({ ...input(), project: exhausted });
    expect(() =>
      applyAcceptedEditorialProposal(exhausted, exhaustedProposal, [accepted.id]),
    ).toThrow(/automated/i);
  });
});
