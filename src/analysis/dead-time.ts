import { createHash } from "node:crypto";

import { canonicalJson } from "../manifest/index.js";

export const ACTIVITY_ANALYSIS_SCHEMA_VERSION = 1 as const;

const MAX_CAPTURE_DURATION_US = 86_400_000_000;
const MAX_SAMPLES = 10_000;
const MAX_INTERVALS = 2_048;

const actionKinds = ["pointer", "scroll", "click", "key", "navigation"] as const;
const classifications = ["idle", "static-reading", "active"] as const;
const suggestedActions = ["keep", "review-trim"] as const;

export type ObservedActionKind = (typeof actionKinds)[number];
export type ActivityClassification = (typeof classifications)[number];
export type SuggestedAction = (typeof suggestedActions)[number];

export interface FrameSample {
  readonly tUs: number;
  readonly sha256: string;
  readonly visualChangeScore?: number;
}

export interface ObservedActionSample {
  readonly tUs: number;
  readonly kind: ObservedActionKind;
}

export interface ActivityAnalysisConfig {
  readonly openingContextUs: number;
  readonly endingContextUs: number;
  readonly actionContextUs: number;
  readonly clickNavigationContextUs: number;
  readonly staticVisualChangeScore: number;
  readonly readingVisualChangeScore: number;
  readonly idleReviewDurationUs: number;
  readonly staticReadingReviewDurationUs: number;
  readonly mergeGapUs: number;
}

export interface ActivityAnalysisInput {
  readonly schemaVersion: typeof ACTIVITY_ANALYSIS_SCHEMA_VERSION;
  readonly captureDurationUs: number;
  readonly frameSamples: readonly FrameSample[];
  readonly actionSamples: readonly ObservedActionSample[];
  readonly config?: Partial<ActivityAnalysisConfig>;
}

export interface ActivityEvidenceCounts {
  readonly frameSamples: number;
  readonly actionSamples: number;
  readonly staticFramePairs: number;
}

export interface ActivityInterval {
  readonly startUs: number;
  readonly endUs: number;
  readonly classification: ActivityClassification;
  readonly confidence: number;
  readonly evidence: ActivityEvidenceCounts;
  readonly suggestedAction: SuggestedAction;
}

export interface ActivityAnalysisResult {
  readonly schemaVersion: typeof ACTIVITY_ANALYSIS_SCHEMA_VERSION;
  readonly captureDurationUs: number;
  readonly config: ActivityAnalysisConfig;
  readonly intervals: readonly ActivityInterval[];
  readonly analysisSha256: string;
}

const defaultConfig: ActivityAnalysisConfig = {
  openingContextUs: 2_000_000,
  endingContextUs: 2_000_000,
  actionContextUs: 1_000_000,
  clickNavigationContextUs: 2_000_000,
  staticVisualChangeScore: 0.02,
  readingVisualChangeScore: 0.15,
  idleReviewDurationUs: 5_000_000,
  staticReadingReviewDurationUs: 15_000_000,
  mergeGapUs: 250_000,
};

type RecordValue = Record<string, unknown>;

interface InputRecord extends RecordValue {
  readonly schemaVersion?: unknown;
  readonly captureDurationUs?: unknown;
  readonly frameSamples?: unknown;
  readonly actionSamples?: unknown;
  readonly config?: unknown;
}

interface FrameSampleRecord extends RecordValue {
  readonly tUs?: unknown;
  readonly sha256?: unknown;
  readonly visualChangeScore?: unknown;
}

interface ActionSampleRecord extends RecordValue {
  readonly tUs?: unknown;
  readonly kind?: unknown;
}

interface NormalizedInput {
  readonly captureDurationUs: number;
  readonly frameSamples: readonly FrameSample[];
  readonly actionSamples: readonly ObservedActionSample[];
  readonly config: ActivityAnalysisConfig;
}

interface IntervalDraft extends ActivityInterval {
  readonly protectedContext: boolean;
  readonly visualEvidenceSupported: boolean;
}

interface VisualEvidence {
  readonly score: number;
  readonly hasBracketingPair: boolean;
}

/**
 * Classifies bounded, source-relative capture evidence into review candidates.
 * It intentionally only recommends review-trim; it never edits media or returns a cut list.
 */
export function analyzeDeadTime(input: unknown): ActivityAnalysisResult {
  const normalized = normalizeInput(input);
  const intervals = mergeCompatibleIntervals(buildIntervals(normalized), normalized.config);

  if (intervals.length > MAX_INTERVALS) {
    throw new Error(`Activity analysis may produce at most ${MAX_INTERVALS} intervals.`);
  }

  const digestPayload = {
    schemaVersion: ACTIVITY_ANALYSIS_SCHEMA_VERSION,
    captureDurationUs: normalized.captureDurationUs,
    config: normalized.config,
    intervals,
  };
  const analysisSha256 = createHash("sha256")
    .update(canonicalJson(digestPayload), "utf8")
    .digest("hex");

  return { ...digestPayload, analysisSha256 };
}

function normalizeInput(value: unknown): NormalizedInput {
  const input = expectRecord(value, "Activity analysis input") as InputRecord;
  rejectUnknownFields(
    input,
    ["schemaVersion", "captureDurationUs", "frameSamples", "actionSamples", "config"],
    "Activity analysis input",
  );

  if (input.schemaVersion !== ACTIVITY_ANALYSIS_SCHEMA_VERSION) {
    throw new Error(`Activity analysis schemaVersion must be ${ACTIVITY_ANALYSIS_SCHEMA_VERSION}.`);
  }

  const captureDurationUs = expectIntegerInRange(
    input.captureDurationUs,
    "captureDurationUs",
    1,
    MAX_CAPTURE_DURATION_US,
  );
  const frameSamples = parseFrameSamples(input.frameSamples, captureDurationUs);
  const actionSamples = parseActionSamples(input.actionSamples, captureDurationUs);
  const config = parseConfig(input.config);

  return { captureDurationUs, frameSamples, actionSamples, config };
}

function parseFrameSamples(value: unknown, captureDurationUs: number): readonly FrameSample[] {
  const samples = expectArray(value, "frameSamples");
  if (samples.length === 0) {
    throw new Error("frameSamples must contain at least one sample.");
  }
  if (samples.length > MAX_SAMPLES) {
    throw new Error(`frameSamples may contain at most ${MAX_SAMPLES} samples.`);
  }

  const parsed = samples.map((sample, index) => {
    const record = expectRecord(sample, `frameSamples[${index}]`) as FrameSampleRecord;
    rejectUnknownFields(record, ["tUs", "sha256", "visualChangeScore"], `frameSamples[${index}]`);
    const tUs = expectIntegerInRange(
      record.tUs,
      `frameSamples[${index}].tUs`,
      0,
      captureDurationUs,
    );
    const sha256 = expectSha256(record.sha256, `frameSamples[${index}].sha256`);
    const visualChangeScore =
      record.visualChangeScore === undefined
        ? undefined
        : expectNumberInRange(
            record.visualChangeScore,
            `frameSamples[${index}].visualChangeScore`,
            0,
            1,
          );

    return visualChangeScore === undefined ? { tUs, sha256 } : { tUs, sha256, visualChangeScore };
  });

  requireStrictlyIncreasing(parsed, "frameSamples");
  return parsed;
}

function parseActionSamples(
  value: unknown,
  captureDurationUs: number,
): readonly ObservedActionSample[] {
  const samples = expectArray(value, "actionSamples");
  if (samples.length > MAX_SAMPLES) {
    throw new Error(`actionSamples may contain at most ${MAX_SAMPLES} samples.`);
  }

  const parsed = samples.map((sample, index) => {
    const record = expectRecord(sample, `actionSamples[${index}]`) as ActionSampleRecord;
    rejectUnknownFields(record, ["tUs", "kind"], `actionSamples[${index}]`);
    const tUs = expectIntegerInRange(
      record.tUs,
      `actionSamples[${index}].tUs`,
      0,
      captureDurationUs,
    );
    if (
      typeof record.kind !== "string" ||
      !actionKinds.includes(record.kind as ObservedActionKind)
    ) {
      throw new Error(`actionSamples[${index}].kind must be a known observed action kind.`);
    }
    return { tUs, kind: record.kind as ObservedActionKind };
  });

  requireStrictlyIncreasing(parsed, "actionSamples");
  return parsed;
}

function parseConfig(value: unknown): ActivityAnalysisConfig {
  if (value === undefined) {
    return { ...defaultConfig };
  }

  const config = expectRecord(value, "config");
  const keys = Object.keys(defaultConfig) as (keyof ActivityAnalysisConfig)[];
  rejectUnknownFields(config, keys, "config");
  const resolved = { ...defaultConfig } as {
    -readonly [K in keyof ActivityAnalysisConfig]: number;
  };

  for (const key of keys) {
    const candidate = config[key];
    if (candidate === undefined) {
      continue;
    }
    const isScore = key === "staticVisualChangeScore" || key === "readingVisualChangeScore";
    resolved[key] = isScore
      ? expectNumberInRange(candidate, `config.${key}`, 0, 1)
      : expectIntegerInRange(candidate, `config.${key}`, 0, MAX_CAPTURE_DURATION_US);
  }

  if (resolved.staticVisualChangeScore >= resolved.readingVisualChangeScore) {
    throw new Error(
      "config.staticVisualChangeScore must be lower than config.readingVisualChangeScore.",
    );
  }
  return resolved;
}

function buildIntervals(input: NormalizedInput): readonly IntervalDraft[] {
  const { captureDurationUs, frameSamples, actionSamples, config } = input;
  const openingEndUs = Math.min(config.openingContextUs, captureDurationUs);
  const endingStartUs = Math.max(0, captureDurationUs - config.endingContextUs);
  const boundaries = new Set<number>([0, captureDurationUs, openingEndUs, endingStartUs]);

  for (const frame of frameSamples) {
    boundaries.add(frame.tUs);
  }
  for (const action of actionSamples) {
    const contextUs =
      action.kind === "click" || action.kind === "navigation"
        ? config.clickNavigationContextUs
        : config.actionContextUs;
    boundaries.add(Math.max(0, action.tUs - contextUs));
    boundaries.add(Math.min(captureDurationUs, action.tUs + contextUs));
  }

  const sortedBoundaries = [...boundaries].sort((left, right) => left - right);
  const drafts: IntervalDraft[] = [];
  for (let index = 0; index < sortedBoundaries.length - 1; index += 1) {
    const startUs = sortedBoundaries[index];
    const endUs = sortedBoundaries[index + 1];
    if (startUs === undefined || endUs === undefined || endUs <= startUs) {
      continue;
    }
    drafts.push(
      classifyInterval({
        startUs,
        endUs,
        frameSamples,
        actionSamples,
        openingEndUs,
        endingStartUs,
        config,
      }),
    );
  }
  return drafts;
}

function classifyInterval(args: {
  readonly startUs: number;
  readonly endUs: number;
  readonly frameSamples: readonly FrameSample[];
  readonly actionSamples: readonly ObservedActionSample[];
  readonly openingEndUs: number;
  readonly endingStartUs: number;
  readonly config: ActivityAnalysisConfig;
}): IntervalDraft {
  const { startUs, endUs, frameSamples, actionSamples, openingEndUs, endingStartUs, config } = args;
  const protectedContext = startUs < openingEndUs || endUs > endingStartUs;
  const matchingActions = actionSamples.filter((action) =>
    actionOverlaps(action, startUs, endUs, config),
  );
  const windowFrames = frameSamples.filter((frame) => frame.tUs >= startUs && frame.tUs <= endUs);
  const visualEvidence = scoreForWindow(frameSamples, startUs);
  const visualChangeScore = visualEvidence.score;
  const discreteAction = matchingActions.some(
    (action) => action.kind === "click" || action.kind === "key" || action.kind === "navigation",
  );

  const classification: ActivityClassification =
    protectedContext || discreteAction || visualChangeScore > config.readingVisualChangeScore
      ? "active"
      : matchingActions.length > 0 || visualChangeScore > config.staticVisualChangeScore
        ? "static-reading"
        : "idle";
  const durationUs = endUs - startUs;
  const suggestedAction: SuggestedAction =
    classification === "active" || !visualEvidence.hasBracketingPair
      ? "keep"
      : classification === "idle"
        ? durationUs >= config.idleReviewDurationUs
          ? "review-trim"
          : "keep"
        : durationUs >= config.staticReadingReviewDurationUs
          ? "review-trim"
          : "keep";

  const evidence: ActivityEvidenceCounts = {
    frameSamples: windowFrames.length,
    actionSamples: matchingActions.length,
    staticFramePairs:
      visualEvidence.hasBracketingPair && visualChangeScore <= config.staticVisualChangeScore
        ? 1
        : 0,
  };

  return {
    startUs,
    endUs,
    classification,
    confidence: confidenceFor(
      classification,
      evidence,
      protectedContext,
      visualEvidence.hasBracketingPair,
    ),
    evidence,
    suggestedAction,
    protectedContext,
    visualEvidenceSupported: visualEvidence.hasBracketingPair,
  };
}

function actionOverlaps(
  action: ObservedActionSample,
  startUs: number,
  endUs: number,
  config: ActivityAnalysisConfig,
): boolean {
  const contextUs =
    action.kind === "click" || action.kind === "navigation"
      ? config.clickNavigationContextUs
      : config.actionContextUs;
  return action.tUs + contextUs > startUs && action.tUs - contextUs < endUs;
}

function scoreForWindow(frameSamples: readonly FrameSample[], startUs: number): VisualEvidence {
  let prior: FrameSample | undefined;
  let next: FrameSample | undefined;
  for (const frame of frameSamples) {
    if (frame.tUs <= startUs) {
      prior = frame;
      continue;
    }
    next = frame;
    break;
  }
  if (prior === undefined || next === undefined) {
    return { score: 0, hasBracketingPair: false };
  }
  if (next.visualChangeScore !== undefined) {
    return { score: next.visualChangeScore, hasBracketingPair: true };
  }
  return { score: prior.sha256 === next.sha256 ? 0 : 1, hasBracketingPair: true };
}

function mergeCompatibleIntervals(
  intervals: readonly IntervalDraft[],
  config: ActivityAnalysisConfig,
): readonly ActivityInterval[] {
  const merged: IntervalDraft[] = [];
  for (const interval of intervals) {
    const previous = merged.at(-1);
    if (
      previous !== undefined &&
      previous.classification === interval.classification &&
      previous.suggestedAction === interval.suggestedAction &&
      previous.visualEvidenceSupported === interval.visualEvidenceSupported &&
      interval.startUs - previous.endUs <= config.mergeGapUs &&
      !previous.protectedContext &&
      !interval.protectedContext
    ) {
      const evidence: ActivityEvidenceCounts = {
        frameSamples: previous.evidence.frameSamples + interval.evidence.frameSamples,
        actionSamples: previous.evidence.actionSamples + interval.evidence.actionSamples,
        staticFramePairs: previous.evidence.staticFramePairs + interval.evidence.staticFramePairs,
      };
      merged[merged.length - 1] = {
        startUs: previous.startUs,
        endUs: interval.endUs,
        classification: previous.classification,
        confidence: confidenceFor(
          previous.classification,
          evidence,
          false,
          previous.visualEvidenceSupported,
        ),
        evidence,
        suggestedAction: previous.suggestedAction,
        protectedContext: false,
        visualEvidenceSupported: previous.visualEvidenceSupported,
      };
      continue;
    }
    merged.push(interval);
  }
  return merged.map(
    ({
      protectedContext: _protectedContext,
      visualEvidenceSupported: _visualEvidenceSupported,
      ...interval
    }) => interval,
  );
}

function confidenceFor(
  classification: ActivityClassification,
  evidence: ActivityEvidenceCounts,
  protectedContext: boolean,
  visualEvidenceSupported: boolean,
): number {
  if (protectedContext) {
    return 1;
  }
  if (!visualEvidenceSupported && evidence.actionSamples === 0) {
    return 0.35;
  }
  const sampleSupport = Math.min(0.2, evidence.frameSamples * 0.04 + evidence.actionSamples * 0.06);
  const baseline =
    classification === "active" ? 0.78 : classification === "static-reading" ? 0.68 : 0.62;
  return roundConfidence(Math.min(0.98, baseline + sampleSupport));
}

function roundConfidence(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function expectRecord(value: unknown, name: string): RecordValue {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${name} must be an object.`);
  }
  return value as RecordValue;
}

function rejectUnknownFields(record: RecordValue, allowed: readonly string[], name: string): void {
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) {
      throw new Error(`${name} contains unknown field ${key}.`);
    }
  }
}

function expectArray(value: unknown, name: string): readonly unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`${name} must be an array.`);
  }
  return value;
}

function expectIntegerInRange(
  value: unknown,
  name: string,
  minimum: number,
  maximum: number,
): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw new Error(`${name} must be an integer within ${minimum}..${maximum}.`);
  }
  return value;
}

function expectNumberInRange(
  value: unknown,
  name: string,
  minimum: number,
  maximum: number,
): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be a finite number within ${minimum}..${maximum}.`);
  }
  return value;
}

function expectSha256(value: unknown, name: string): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) {
    throw new Error(`${name} must be a lowercase SHA-256 digest.`);
  }
  return value;
}

function requireStrictlyIncreasing(
  samples: readonly { readonly tUs: number }[],
  name: string,
): void {
  for (let index = 1; index < samples.length; index += 1) {
    const previous = samples[index - 1];
    const current = samples[index];
    if (previous === undefined || current === undefined || current.tUs <= previous.tUs) {
      throw new Error(`${name} timestamps must be strictly increasing.`);
    }
  }
}
