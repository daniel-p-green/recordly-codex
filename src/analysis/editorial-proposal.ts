import { createHash } from "node:crypto";

import { canonicalJson } from "../manifest/index.js";
import {
  canonicalRecordingProject,
  reviseRecordingProject,
  validateRecordingProject,
} from "../project/index.js";
import type { RecordingProjectV2 } from "../project/types.js";
import type { ActivityAnalysisResult } from "./dead-time.js";
import { ACTIVITY_ANALYSIS_SCHEMA_VERSION } from "./dead-time.js";

export const EDITORIAL_PROPOSAL_SCHEMA_VERSION = 1 as const;

const MAX_EVENTS = 2_048;
const MAX_ZOOM_PROPOSALS = 32;
const MAX_REVIEW_TRIMS = 64;
const MAX_TRANSITION_SUGGESTIONS = 31;
const MAX_CAPTURE_DURATION_US = 86_400_000_000;
const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const sha256Pattern = /^[a-f0-9]{64}$/iu;

export type EditorialObservedEventKind = "pointer" | "click" | "scroll" | "navigation";

export type EditorialObservedEvent = {
  id: string;
  source: "observed";
  sourceId: string;
  tUs: number;
  kind: EditorialObservedEventKind;
  x?: number;
  y?: number;
};

export type EditorialProposalInput = {
  schemaVersion: typeof EDITORIAL_PROPOSAL_SCHEMA_VERSION;
  project: unknown;
  observedEvents: EditorialObservedEvent[];
  deadTimeBySource: Array<{ sourceId: string; analysis: ActivityAnalysisResult }>;
};

export type EditorialZoomProposal = {
  id: string;
  clipId: string;
  sourceRange: { startUs: number; endUs: number };
  focus: { x: number; y: number };
  scale: number;
  easing: "ease-out";
  evidence: { sourceId: string; observedEventIds: string[]; observedEvidenceSha256: string };
};

export type EditorialReviewTrimProposal = {
  id: string;
  clipId: string;
  sourceRange: { startUs: number; endUs: number };
  action: "review-trim";
  evidence: { sourceId: string; activityAnalysisSha256: string; staticFramePairs: number };
};

export type EditorialTransitionSuggestion = {
  id: string;
  fromClipId: string;
  toClipId: string;
  family: "cut";
  durationUs: 0;
  evidence: { fromSourceId: string; toSourceId: string };
};

export type EditorialProposal = {
  schemaVersion: typeof EDITORIAL_PROPOSAL_SCHEMA_VERSION;
  projectId: string;
  projectRevision: number;
  projectSha256: string;
  sourceAnalyses: Array<{ sourceId: string; analysisSha256: string }>;
  zoomProposals: EditorialZoomProposal[];
  reviewTrimProposals: EditorialReviewTrimProposal[];
  transitionSuggestions: EditorialTransitionSuggestion[];
  proposalSha256: string;
};

// Runtime exact-key validation is deliberately used at this untrusted boundary.
// `any` here avoids weakening those checks merely to satisfy noPropertyAccessFromIndexSignature.
// biome-ignore lint/suspicious/noExplicitAny: Runtime exact-key validator boundary.
type RecordValue = any;
type Candidate = EditorialZoomProposal & { eventTimes: number[] };

function invalid(message: string): never {
  throw new Error(message);
}

/**
 * Converts immutable observed capture evidence into reviewable editorial suggestions.
 * It does not edit source media, manufacture page meaning, or make cuts.
 */
export function buildEditorialProposal(value: unknown): EditorialProposal {
  const input = parseInput(value);
  const project = requireV2Project(input.project);
  const sources = new Map(project.captureSources.map((source) => [source.id, source]));
  const events = parseObservedEvents(input.observedEvents, sources);
  const sourceAnalyses = parseAnalyses(input.deadTimeBySource, sources);
  const projectSha256 = digest(canonicalRecordingProject(project));
  const observedEvidenceSha256 = digest(canonicalJson(events));

  const occupied = new Map<string, Array<{ startUs: number; endUs: number }>>();
  for (const proposal of project.zoomProposals) {
    const entries = occupied.get(proposal.clipId) ?? [];
    entries.push(proposal.sourceRange);
    occupied.set(proposal.clipId, entries);
  }
  const zoomProposals = buildZoomProposals(project, events, observedEvidenceSha256, occupied);
  const reviewTrimProposals = buildReviewTrimProposals(project, sourceAnalyses);
  const transitionSuggestions = buildTransitionSuggestions(project);
  const payload = {
    schemaVersion: EDITORIAL_PROPOSAL_SCHEMA_VERSION,
    projectId: project.projectId,
    projectRevision: project.revision,
    projectSha256,
    sourceAnalyses: [...sourceAnalyses.entries()]
      .map(([sourceId, analysis]) => ({ sourceId, analysisSha256: analysis.analysisSha256 }))
      .sort((left, right) => left.sourceId.localeCompare(right.sourceId)),
    zoomProposals,
    reviewTrimProposals,
    transitionSuggestions,
  };
  return { ...payload, proposalSha256: digest(canonicalJson(payload)) };
}

/** Validates an already-produced proposal before a separate approval step uses it. */
export function validateEditorialProposal(value: unknown): EditorialProposal {
  const proposal = object(value, "editorial proposal");
  exact(
    proposal,
    [
      "schemaVersion",
      "projectId",
      "projectRevision",
      "projectSha256",
      "sourceAnalyses",
      "zoomProposals",
      "reviewTrimProposals",
      "transitionSuggestions",
      "proposalSha256",
    ],
    "editorial proposal",
  );
  if (proposal.schemaVersion !== EDITORIAL_PROPOSAL_SCHEMA_VERSION)
    invalid("editorial proposal has an unsupported schema version");
  const parsed = {
    schemaVersion: EDITORIAL_PROPOSAL_SCHEMA_VERSION,
    projectId: identifier(proposal.projectId, "editorial proposal.projectId"),
    projectRevision: integer(proposal.projectRevision, "editorial proposal.projectRevision", 0),
    projectSha256: sha256(proposal.projectSha256, "editorial proposal.projectSha256"),
    sourceAnalyses: array(proposal.sourceAnalyses, "editorial proposal.sourceAnalyses", 32)
      .map((entry, index) => {
        const item = object(entry, `editorial proposal.sourceAnalyses[${index}]`);
        exact(item, ["sourceId", "analysisSha256"], `editorial proposal.sourceAnalyses[${index}]`);
        return {
          sourceId: identifier(
            item.sourceId,
            `editorial proposal.sourceAnalyses[${index}].sourceId`,
          ),
          analysisSha256: sha256(
            item.analysisSha256,
            `editorial proposal.sourceAnalyses[${index}].analysisSha256`,
          ),
        };
      })
      .sort((left, right) => left.sourceId.localeCompare(right.sourceId)),
    zoomProposals: array(
      proposal.zoomProposals,
      "editorial proposal.zoomProposals",
      MAX_ZOOM_PROPOSALS,
    )
      .map(parseZoomProposal)
      .sort(compareById),
    reviewTrimProposals: array(
      proposal.reviewTrimProposals,
      "editorial proposal.reviewTrimProposals",
      MAX_REVIEW_TRIMS,
    )
      .map(parseReviewTrimProposal)
      .sort(compareById),
    transitionSuggestions: array(
      proposal.transitionSuggestions,
      "editorial proposal.transitionSuggestions",
      MAX_TRANSITION_SUGGESTIONS,
    )
      .map(parseTransitionSuggestion)
      .sort(compareById),
  };
  unique(
    parsed.sourceAnalyses.map((item) => item.sourceId),
    "editorial proposal source analyses",
  );
  unique(
    parsed.zoomProposals.map((item) => item.id),
    "editorial proposal zoom IDs",
  );
  unique(
    parsed.reviewTrimProposals.map((item) => item.id),
    "editorial proposal trim IDs",
  );
  unique(
    parsed.transitionSuggestions.map((item) => item.id),
    "editorial proposal transition IDs",
  );
  assertNoOverlap(parsed.zoomProposals, "editorial proposal zoom proposals");
  const proposalSha256 = sha256(proposal.proposalSha256, "editorial proposal.proposalSha256");
  if (proposalSha256 !== digest(canonicalJson(parsed)))
    invalid("editorial proposal digest does not match");
  return { ...parsed, proposalSha256 };
}

/**
 * Applies only explicitly accepted zoom suggestions as one automated project revision.
 * Review-trim and transition suggestions deliberately remain non-operative.
 */
export function applyAcceptedEditorialProposal(
  currentValue: unknown,
  proposalValue: unknown,
  acceptedZoomProposalIds: unknown,
): RecordingProjectV2 {
  const current = requireV2Project(currentValue);
  const proposal = validateEditorialProposal(proposalValue);
  const accepted = parseAcceptedIds(acceptedZoomProposalIds);
  if (proposal.projectId !== current.projectId || proposal.projectRevision !== current.revision)
    invalid("editorial proposal does not match the current project revision");
  if (proposal.projectSha256 !== digest(canonicalRecordingProject(current)))
    invalid("editorial proposal does not match current project contents");
  const byId = new Map(proposal.zoomProposals.map((proposal) => [proposal.id, proposal]));
  const selected = accepted.map((id) => {
    const found = byId.get(id);
    if (found === undefined)
      invalid("accepted proposal IDs must be zoom proposals from this proposal");
    return found;
  });
  const clips = new Map(current.timeline.clips.map((clip) => [clip.id, clip]));
  const sources = new Map(current.captureSources.map((source) => [source.id, source]));
  const occupied = new Map<string, Array<{ startUs: number; endUs: number }>>();
  for (const existing of current.zoomProposals) {
    const ranges = occupied.get(existing.clipId) ?? [];
    ranges.push(existing.sourceRange);
    occupied.set(existing.clipId, ranges);
  }
  for (const selectedProposal of selected) {
    assertProposalFitsProject(selectedProposal, clips, sources);
    const ranges = occupied.get(selectedProposal.clipId) ?? [];
    if (ranges.some((range) => overlaps(range, selectedProposal.sourceRange)))
      invalid("accepted proposal overlaps an existing project zoom");
    ranges.push(selectedProposal.sourceRange);
    occupied.set(selectedProposal.clipId, ranges);
  }
  const next = structuredClone(current);
  next.revision += 1;
  next.revisionPolicy.automatedRevisionCount += 1;
  next.zoomProposals.push(
    ...selected.map((item) => ({
      id: item.id,
      clipId: item.clipId,
      sourceRange: item.sourceRange,
      focus: item.focus,
      scale: item.scale,
      easing: item.easing,
      review: { status: "accepted" as const, basis: "observed-input" as const },
    })),
  );
  return reviseRecordingProject(current, next, "automated") as RecordingProjectV2;
}

function parseInput(value: unknown): EditorialProposalInput {
  const input = object(value, "editorial proposal input");
  exact(
    input,
    ["schemaVersion", "project", "observedEvents", "deadTimeBySource"],
    "editorial proposal input",
  );
  if (input.schemaVersion !== EDITORIAL_PROPOSAL_SCHEMA_VERSION)
    invalid("editorial proposal input has an unsupported schema version");
  return {
    schemaVersion: EDITORIAL_PROPOSAL_SCHEMA_VERSION,
    project: input.project,
    observedEvents: array(
      input.observedEvents,
      "editorial proposal input.observedEvents",
      MAX_EVENTS,
    ) as EditorialObservedEvent[],
    deadTimeBySource: array(
      input.deadTimeBySource,
      "editorial proposal input.deadTimeBySource",
      32,
    ) as EditorialProposalInput["deadTimeBySource"],
  };
}

function requireV2Project(value: unknown): RecordingProjectV2 {
  const project = validateRecordingProject(value);
  if (project.schemaVersion !== 2) invalid("editorial automation requires a validated V2 project");
  return project;
}

function parseObservedEvents(
  value: unknown,
  sources: ReadonlyMap<string, RecordingProjectV2["captureSources"][number]>,
): EditorialObservedEvent[] {
  const events = array(value, "observed events", MAX_EVENTS).map((entry, index) => {
    const event = object(entry, `observed events[${index}]`);
    exact(event, ["id", "source", "sourceId", "tUs", "kind"], `observed events[${index}]`, [
      "x",
      "y",
    ]);
    const id = identifier(event.id, `observed events[${index}].id`);
    if (event.source !== "observed") invalid("editorial evidence must be observed, never planned");
    const sourceId = identifier(event.sourceId, `observed events[${index}].sourceId`);
    const source = sources.get(sourceId);
    if (source === undefined) invalid("observed event references an unknown capture source");
    const tUs = integer(event.tUs, `observed events[${index}].tUs`, 0, source.durationUs);
    const kind = literal(
      event.kind,
      ["pointer", "click", "scroll", "navigation"] as const,
      `observed events[${index}].kind`,
    );
    const hasCoordinate = kind !== "navigation";
    if (hasCoordinate !== (event.x !== undefined && event.y !== undefined))
      invalid("observed event coordinates must match its interaction kind");
    const x =
      event.x === undefined
        ? undefined
        : finite(event.x, `observed events[${index}].x`, 0, source.sourceWidth);
    const y =
      event.y === undefined
        ? undefined
        : finite(event.y, `observed events[${index}].y`, 0, source.sourceHeight);
    return x === undefined || y === undefined
      ? { id, source: "observed" as const, sourceId, tUs, kind }
      : { id, source: "observed" as const, sourceId, tUs, kind, x, y };
  });
  unique(
    events.map((event) => event.id),
    "observed event IDs",
  );
  return events.sort(
    (left, right) =>
      left.sourceId.localeCompare(right.sourceId) ||
      left.tUs - right.tUs ||
      left.id.localeCompare(right.id),
  );
}

function parseAnalyses(
  value: unknown,
  sources: ReadonlyMap<string, RecordingProjectV2["captureSources"][number]>,
): Map<string, ActivityAnalysisResult> {
  const parsed = array(value, "dead-time analyses", 32).map((entry, index) => {
    const item = object(entry, `dead-time analyses[${index}]`);
    exact(item, ["sourceId", "analysis"], `dead-time analyses[${index}]`);
    const sourceId = identifier(item.sourceId, `dead-time analyses[${index}].sourceId`);
    const source = sources.get(sourceId);
    if (source === undefined) invalid("dead-time analysis references an unknown capture source");
    const analysis = verifyAnalysis(item.analysis, source.durationUs);
    return [sourceId, analysis] as const;
  });
  unique(
    parsed.map(([sourceId]) => sourceId),
    "dead-time analysis source IDs",
  );
  if (parsed.length !== sources.size)
    invalid("dead-time analysis is required for every project capture source");
  return new Map(parsed);
}

function verifyAnalysis(value: unknown, expectedDurationUs: number): ActivityAnalysisResult {
  const result = object(value, "dead-time analysis result");
  exact(
    result,
    ["schemaVersion", "captureDurationUs", "config", "intervals", "analysisSha256"],
    "dead-time analysis result",
  );
  if (
    result.schemaVersion !== ACTIVITY_ANALYSIS_SCHEMA_VERSION ||
    result.captureDurationUs !== expectedDurationUs
  )
    invalid("dead-time analysis does not match capture source duration");
  // The activity-analysis digest covers its deterministic, path-free result. The original
  // immutable frame/action evidence remains in the capture store and is intentionally not copied
  // into this proposal surface.
  const expected = digest(
    canonicalJson({
      schemaVersion: result.schemaVersion,
      captureDurationUs: result.captureDurationUs,
      config: result.config,
      intervals: result.intervals,
    }),
  );
  const supplied = sha256(result.analysisSha256, "dead-time analysis result.analysisSha256");
  if (expected !== supplied) invalid("dead-time analysis digest does not match");
  return value as ActivityAnalysisResult;
}

function buildZoomProposals(
  project: RecordingProjectV2,
  events: readonly EditorialObservedEvent[],
  observedEvidenceSha256: string,
  occupied: ReadonlyMap<string, readonly { startUs: number; endUs: number }[]>,
): EditorialZoomProposal[] {
  const candidates: Candidate[] = [];
  for (const event of events) {
    if (event.kind !== "click" && event.kind !== "scroll") continue;
    if (event.x === undefined || event.y === undefined) continue;
    const matches = project.timeline.clips.filter(
      (clip) =>
        clip.sourceId === event.sourceId &&
        event.tUs >= clip.trim.startUs &&
        event.tUs <= clip.trim.endUs,
    );
    if (matches.length !== 1) continue;
    const clip = matches[0];
    if (clip === undefined) continue;
    const source = project.captureSources.find((item) => item.id === event.sourceId);
    if (source === undefined) continue;
    const sourceRange = {
      startUs: Math.max(clip.trim.startUs, event.tUs - 500_000),
      endUs: Math.min(clip.trim.endUs, event.tUs + 1_000_000),
    };
    if (sourceRange.endUs - sourceRange.startUs < 250_000) continue;
    if ((occupied.get(clip.id) ?? []).some((range) => overlaps(range, sourceRange))) continue;
    candidates.push({
      id: "",
      clipId: clip.id,
      sourceRange,
      focus: { x: event.x / source.sourceWidth, y: event.y / source.sourceHeight },
      scale: 1.35,
      easing: "ease-out",
      evidence: { sourceId: event.sourceId, observedEventIds: [event.id], observedEvidenceSha256 },
      eventTimes: [event.tUs],
    });
  }
  const coalesced: Candidate[] = [];
  for (const candidate of candidates.sort(
    (left, right) =>
      left.clipId.localeCompare(right.clipId) ||
      left.sourceRange.startUs - right.sourceRange.startUs ||
      (left.evidence.observedEventIds.at(0) ?? "").localeCompare(
        right.evidence.observedEventIds.at(0) ?? "",
      ),
  )) {
    const previous = coalesced.at(-1);
    if (
      previous !== undefined &&
      previous.clipId === candidate.clipId &&
      overlapsOrTouches(previous.sourceRange, candidate.sourceRange)
    ) {
      const count =
        previous.evidence.observedEventIds.length + candidate.evidence.observedEventIds.length;
      coalesced[coalesced.length - 1] = {
        ...previous,
        sourceRange: {
          startUs: previous.sourceRange.startUs,
          endUs: Math.max(previous.sourceRange.endUs, candidate.sourceRange.endUs),
        },
        focus: {
          x:
            (previous.focus.x * previous.evidence.observedEventIds.length + candidate.focus.x) /
            count,
          y:
            (previous.focus.y * previous.evidence.observedEventIds.length + candidate.focus.y) /
            count,
        },
        evidence: {
          ...previous.evidence,
          observedEventIds: [
            ...previous.evidence.observedEventIds,
            ...candidate.evidence.observedEventIds,
          ].sort(),
        },
        eventTimes: [...previous.eventTimes, ...candidate.eventTimes],
      };
    } else {
      coalesced.push(candidate);
    }
  }
  return coalesced
    .slice(0, MAX_ZOOM_PROPOSALS)
    .map(({ eventTimes: _eventTimes, ...candidate }) => ({
      ...candidate,
      id: `zoom-${candidate.clipId}-${candidate.sourceRange.startUs}-${digest(canonicalJson(candidate.evidence)).slice(0, 12)}`,
    }));
}

function buildReviewTrimProposals(
  project: RecordingProjectV2,
  analyses: ReadonlyMap<string, ActivityAnalysisResult>,
): EditorialReviewTrimProposal[] {
  const proposals: EditorialReviewTrimProposal[] = [];
  for (const [sourceId, analysis] of analyses) {
    for (const interval of analysis.intervals) {
      if (interval.suggestedAction !== "review-trim" || interval.evidence.staticFramePairs < 1)
        continue;
      for (const clip of project.timeline.clips) {
        if (clip.sourceId !== sourceId) continue;
        const startUs = Math.max(clip.trim.startUs, interval.startUs);
        const endUs = Math.min(clip.trim.endUs, interval.endUs);
        if (endUs <= startUs) continue;
        const evidence = {
          sourceId,
          activityAnalysisSha256: analysis.analysisSha256,
          staticFramePairs: interval.evidence.staticFramePairs,
        };
        proposals.push({
          id: `review-trim-${clip.id}-${startUs}-${digest(canonicalJson(evidence)).slice(0, 12)}`,
          clipId: clip.id,
          sourceRange: { startUs, endUs },
          action: "review-trim",
          evidence,
        });
      }
    }
  }
  return proposals.sort(compareById).slice(0, MAX_REVIEW_TRIMS);
}

function buildTransitionSuggestions(project: RecordingProjectV2): EditorialTransitionSuggestion[] {
  const suggestions: EditorialTransitionSuggestion[] = [];
  for (let index = 0; index < project.timeline.clips.length - 1; index += 1) {
    const from = project.timeline.clips[index];
    const to = project.timeline.clips[index + 1];
    if (from === undefined || to === undefined || from.sourceId === to.sourceId) continue;
    const evidence = { fromSourceId: from.sourceId, toSourceId: to.sourceId };
    suggestions.push({
      id: `transition-${from.id}-${to.id}`,
      fromClipId: from.id,
      toClipId: to.id,
      family: "cut",
      durationUs: 0,
      evidence,
    });
  }
  return suggestions.slice(0, MAX_TRANSITION_SUGGESTIONS);
}

function parseZoomProposal(value: unknown, index: number): EditorialZoomProposal {
  const item = object(value, `editorial proposal.zoomProposals[${index}]`);
  exact(
    item,
    ["id", "clipId", "sourceRange", "focus", "scale", "easing", "evidence"],
    `editorial proposal.zoomProposals[${index}]`,
  );
  const sourceRange = range(
    item.sourceRange,
    `editorial proposal.zoomProposals[${index}].sourceRange`,
  );
  const focus = point(item.focus, `editorial proposal.zoomProposals[${index}].focus`);
  const evidence = object(item.evidence, `editorial proposal.zoomProposals[${index}].evidence`);
  exact(
    evidence,
    ["sourceId", "observedEventIds", "observedEvidenceSha256"],
    `editorial proposal.zoomProposals[${index}].evidence`,
  );
  const observedEventIds = array(
    evidence.observedEventIds,
    "editorial zoom evidence IDs",
    MAX_EVENTS,
  )
    .map((id, eventIndex) => identifier(id, `editorial zoom evidence ID ${eventIndex}`))
    .sort();
  if (observedEventIds.length === 0) invalid("editorial zoom evidence must name observed events");
  unique(observedEventIds, "editorial zoom evidence IDs");
  return {
    id: identifier(item.id, `editorial proposal.zoomProposals[${index}].id`),
    clipId: identifier(item.clipId, `editorial proposal.zoomProposals[${index}].clipId`),
    sourceRange,
    focus,
    scale: finite(item.scale, `editorial proposal.zoomProposals[${index}].scale`, 1.05, 2),
    easing: literal(
      item.easing,
      ["ease-out"] as const,
      `editorial proposal.zoomProposals[${index}].easing`,
    ),
    evidence: {
      sourceId: identifier(evidence.sourceId, "editorial zoom evidence source"),
      observedEventIds,
      observedEvidenceSha256: sha256(
        evidence.observedEvidenceSha256,
        "editorial zoom evidence digest",
      ),
    },
  };
}

function parseReviewTrimProposal(value: unknown, index: number): EditorialReviewTrimProposal {
  const item = object(value, `editorial proposal.reviewTrimProposals[${index}]`);
  exact(
    item,
    ["id", "clipId", "sourceRange", "action", "evidence"],
    `editorial proposal.reviewTrimProposals[${index}]`,
  );
  const evidence = object(
    item.evidence,
    `editorial proposal.reviewTrimProposals[${index}].evidence`,
  );
  exact(
    evidence,
    ["sourceId", "activityAnalysisSha256", "staticFramePairs"],
    `editorial proposal.reviewTrimProposals[${index}].evidence`,
  );
  return {
    id: identifier(item.id, "editorial trim ID"),
    clipId: identifier(item.clipId, "editorial trim clip ID"),
    sourceRange: range(item.sourceRange, "editorial trim range"),
    action: literal(item.action, ["review-trim"] as const, "editorial trim action"),
    evidence: {
      sourceId: identifier(evidence.sourceId, "editorial trim source"),
      activityAnalysisSha256: sha256(evidence.activityAnalysisSha256, "editorial trim digest"),
      staticFramePairs: integer(evidence.staticFramePairs, "editorial trim static pairs", 1),
    },
  };
}

function parseTransitionSuggestion(value: unknown, index: number): EditorialTransitionSuggestion {
  const item = object(value, `editorial proposal.transitionSuggestions[${index}]`);
  exact(
    item,
    ["id", "fromClipId", "toClipId", "family", "durationUs", "evidence"],
    `editorial proposal.transitionSuggestions[${index}]`,
  );
  const evidence = object(
    item.evidence,
    `editorial proposal.transitionSuggestions[${index}].evidence`,
  );
  exact(
    evidence,
    ["fromSourceId", "toSourceId"],
    `editorial proposal.transitionSuggestions[${index}].evidence`,
  );
  return {
    id: identifier(item.id, "editorial transition ID"),
    fromClipId: identifier(item.fromClipId, "editorial transition source clip"),
    toClipId: identifier(item.toClipId, "editorial transition target clip"),
    family: literal(item.family, ["cut"] as const, "editorial transition family"),
    durationUs: integer(item.durationUs, "editorial transition duration", 0, 0) as 0,
    evidence: {
      fromSourceId: identifier(evidence.fromSourceId, "editorial transition source"),
      toSourceId: identifier(evidence.toSourceId, "editorial transition target"),
    },
  };
}

function parseAcceptedIds(value: unknown): string[] {
  const ids = array(value, "accepted editorial proposal IDs", MAX_ZOOM_PROPOSALS).map((id, index) =>
    identifier(id, `accepted editorial proposal ID ${index}`),
  );
  if (ids.length === 0) invalid("at least one accepted zoom proposal ID is required");
  unique(ids, "accepted editorial proposal IDs");
  return ids.sort();
}

function assertProposalFitsProject(
  proposal: EditorialZoomProposal,
  clips: ReadonlyMap<string, RecordingProjectV2["timeline"]["clips"][number]>,
  sources: ReadonlyMap<string, RecordingProjectV2["captureSources"][number]>,
): void {
  const clip = clips.get(proposal.clipId);
  if (clip === undefined || clip.sourceId !== proposal.evidence.sourceId)
    invalid("accepted proposal clip/source evidence does not match project");
  const source = sources.get(clip.sourceId);
  if (
    source === undefined ||
    proposal.sourceRange.startUs < clip.trim.startUs ||
    proposal.sourceRange.endUs > clip.trim.endUs ||
    proposal.sourceRange.endUs > source.durationUs
  )
    invalid("accepted proposal range does not fit project geometry");
}

function range(value: unknown, location: string): { startUs: number; endUs: number } {
  const item = object(value, location);
  exact(item, ["startUs", "endUs"], location);
  const startUs = integer(item.startUs, `${location}.startUs`, 0, MAX_CAPTURE_DURATION_US);
  const endUs = integer(item.endUs, `${location}.endUs`, 0, MAX_CAPTURE_DURATION_US);
  if (endUs <= startUs) invalid(`${location} must have a positive range`);
  return { startUs, endUs };
}

function point(value: unknown, location: string): { x: number; y: number } {
  const item = object(value, location);
  exact(item, ["x", "y"], location);
  return { x: finite(item.x, `${location}.x`, 0, 1), y: finite(item.y, `${location}.y`, 0, 1) };
}

function object(value: unknown, location: string): RecordValue {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  )
    invalid(`${location} must be an object`);
  return value as RecordValue;
}

function exact(
  value: RecordValue,
  required: readonly string[],
  location: string,
  optional: readonly string[] = [],
): void {
  const allowed = new Set([...required, ...optional]);
  if (Object.getOwnPropertySymbols(value).length > 0)
    invalid(`${location} cannot have symbol fields`);
  for (const key of Object.getOwnPropertyNames(value))
    if (!allowed.has(key)) invalid(`${location} has an unknown field`);
  for (const key of required)
    if (!Object.hasOwn(value, key)) invalid(`${location} is missing a required field`);
}

function array(value: unknown, location: string, maximum: number): unknown[] {
  if (
    !Array.isArray(value) ||
    value.length > maximum ||
    Object.keys(value).length !== value.length ||
    !Array.from({ length: value.length }, (_, index) => Object.hasOwn(value, index)).every(Boolean)
  )
    invalid(`${location} must be a bounded dense array`);
  return value;
}

function identifier(value: unknown, location: string): string {
  if (typeof value !== "string" || !identifierPattern.test(value))
    invalid(`${location} must be a safe identifier`);
  return value;
}

function sha256(value: unknown, location: string): string {
  if (typeof value !== "string" || !sha256Pattern.test(value))
    invalid(`${location} must be a SHA-256 digest`);
  return value.toLowerCase();
}

function integer(
  value: unknown,
  location: string,
  minimum: number,
  maximum = Number.MAX_SAFE_INTEGER,
): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum)
    invalid(`${location} is outside its allowed range`);
  return value as number;
}

function finite(value: unknown, location: string, minimum: number, maximum: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum)
    invalid(`${location} is outside its allowed geometry`);
  return value;
}

function literal<T extends string>(value: unknown, allowed: readonly T[], location: string): T {
  if (!allowed.includes(value as T)) invalid(`${location} has an unsupported value`);
  return value as T;
}

function unique(values: readonly string[], location: string): void {
  if (new Set(values).size !== values.length) invalid(`${location} must be unique`);
}

function assertNoOverlap(proposals: readonly EditorialZoomProposal[], location: string): void {
  const byClip = new Map<string, EditorialZoomProposal[]>();
  for (const proposal of proposals)
    byClip.set(proposal.clipId, [...(byClip.get(proposal.clipId) ?? []), proposal]);
  for (const entries of byClip.values()) {
    const sorted = [...entries].sort(
      (left, right) => left.sourceRange.startUs - right.sourceRange.startUs,
    );
    for (let index = 1; index < sorted.length; index += 1) {
      const previous = sorted[index - 1];
      const current = sorted[index];
      if (
        previous !== undefined &&
        current !== undefined &&
        overlaps(previous.sourceRange, current.sourceRange)
      )
        invalid(`${location} overlap`);
    }
  }
}

function overlaps(
  left: { startUs: number; endUs: number },
  right: { startUs: number; endUs: number },
): boolean {
  return left.startUs < right.endUs && right.startUs < left.endUs;
}

function overlapsOrTouches(
  left: { startUs: number; endUs: number },
  right: { startUs: number; endUs: number },
): boolean {
  return left.startUs <= right.endUs && right.startUs <= left.endUs;
}

function compareById<T extends { id: string }>(left: T, right: T): number {
  return left.id.localeCompare(right.id);
}

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
