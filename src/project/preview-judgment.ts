// biome-ignore-all lint/complexity/useLiteralKeys: untrusted persisted judgment dictionaries require exact key checks.
import { createHash } from "node:crypto";

import { canonicalJson } from "../manifest/index.js";
import { toProjectRenderInput, validateRecordingProject } from "./recording-project.js";
import type { RecordingProject } from "./types.js";

const DIGEST = /^[a-f0-9]{64}$/u;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const ISSUE_CODE = /^[a-z][a-z0-9_-]{0,63}$/u;
const MAX_ISSUES = 12;
const MAX_EVIDENCE = 240;
const MAX_TIME_US = 86_400_000_000;

export type PreviewJudgmentVerdict = "accept" | "revise" | "reject";
export type PreviewJudgmentSeverity = "blocking" | "major" | "minor";
export type PreviewJudgmentRegion = "timeline" | "presentation" | "audio" | "captions" | "output";

export type PreviewJudgmentIssue = {
  code: string;
  severity: PreviewJudgmentSeverity;
  region: PreviewJudgmentRegion;
  startUs: number;
  endUs: number;
  evidence: string;
};

export type PreviewJudgment = {
  schemaVersion: 1;
  projectId: string;
  revision: number;
  projectSha256: string;
  renderInputSha256: string;
  previewArtifactSha256: string;
  renderRecipeSha256: string;
  verdict: PreviewJudgmentVerdict;
  issues: readonly PreviewJudgmentIssue[];
};

export type PreviewJudgmentDigests = Pick<
  PreviewJudgment,
  "projectSha256" | "renderInputSha256" | "renderRecipeSha256"
>;

function invalid(message: string): never {
  throw new RangeError(`preview judgment ${message}`);
}

function object(value: unknown, location: string): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  ) {
    invalid(`${location} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exact(value: Record<string, unknown>, fields: readonly string[], location: string): void {
  if (
    Object.getOwnPropertySymbols(value).length > 0 ||
    Object.getOwnPropertyNames(value).length !== fields.length ||
    fields.some((field) => !Object.hasOwn(value, field)) ||
    Object.getOwnPropertyNames(value).some((field) => !fields.includes(field))
  ) {
    invalid(`${location} has an invalid shape`);
  }
}

function digest(value: unknown, location: string): string {
  if (typeof value !== "string" || !DIGEST.test(value))
    invalid(`${location} must be a SHA-256 digest`);
  return value.toLowerCase();
}

function boundedText(value: unknown, location: string): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > MAX_EVIDENCE ||
    [...value].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
  ) {
    invalid(`${location} must be bounded text`);
  }
  return value;
}

function judgmentIssue(value: unknown, location: string): PreviewJudgmentIssue {
  const issue = object(value, location);
  exact(issue, ["code", "severity", "region", "startUs", "endUs", "evidence"], location);
  if (typeof issue["code"] !== "string" || !ISSUE_CODE.test(issue["code"])) {
    invalid(`${location}.code is invalid`);
  }
  if (
    !(["blocking", "major", "minor"] as const).includes(
      issue["severity"] as PreviewJudgmentSeverity,
    )
  ) {
    invalid(`${location}.severity is invalid`);
  }
  if (
    !(["timeline", "presentation", "audio", "captions", "output"] as const).includes(
      issue["region"] as PreviewJudgmentRegion,
    )
  ) {
    invalid(`${location}.region is invalid`);
  }
  if (
    !Number.isSafeInteger(issue["startUs"]) ||
    !Number.isSafeInteger(issue["endUs"]) ||
    (issue["startUs"] as number) < 0 ||
    (issue["endUs"] as number) < (issue["startUs"] as number) ||
    (issue["endUs"] as number) > MAX_TIME_US
  ) {
    invalid(`${location} time range is invalid`);
  }
  return {
    code: issue["code"],
    severity: issue["severity"] as PreviewJudgmentSeverity,
    region: issue["region"] as PreviewJudgmentRegion,
    startUs: issue["startUs"] as number,
    endUs: issue["endUs"] as number,
    evidence: boundedText(issue["evidence"], `${location}.evidence`),
  };
}

function sha256(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

export function previewJudgmentDigests(value: unknown): PreviewJudgmentDigests {
  const project = validateRecordingProject(value);
  return {
    projectSha256: sha256(project),
    renderInputSha256: sha256(toProjectRenderInput(project)),
    renderRecipeSha256: sha256({
      schemaVersion: 1,
      output: project.output,
      presentation: project.presentation,
      renderHooks: project.renderHooks,
    }),
  };
}

export function validatePreviewJudgment(value: unknown): PreviewJudgment {
  const judgment = object(value, "judgment");
  exact(
    judgment,
    [
      "schemaVersion",
      "projectId",
      "revision",
      "projectSha256",
      "renderInputSha256",
      "previewArtifactSha256",
      "renderRecipeSha256",
      "verdict",
      "issues",
    ],
    "judgment",
  );
  if (judgment["schemaVersion"] !== 1) invalid("schema version is invalid");
  if (typeof judgment["projectId"] !== "string" || !IDENTIFIER.test(judgment["projectId"])) {
    invalid("project ID is invalid");
  }
  if (!Number.isSafeInteger(judgment["revision"]) || (judgment["revision"] as number) < 0) {
    invalid("revision is invalid");
  }
  if (
    !(["accept", "revise", "reject"] as const).includes(
      judgment["verdict"] as PreviewJudgmentVerdict,
    )
  ) {
    invalid("verdict is invalid");
  }
  if (!Array.isArray(judgment["issues"]) || judgment["issues"].length > MAX_ISSUES) {
    invalid("issues are invalid");
  }
  const issues = judgment["issues"].map((issue, index) =>
    judgmentIssue(issue, `judgment.issues[${index}]`),
  );
  const verdict = judgment["verdict"] as PreviewJudgmentVerdict;
  if (verdict === "accept" && issues.some((issue) => issue.severity === "blocking")) {
    invalid("accept cannot contain blocking issues");
  }
  if ((verdict === "revise" || verdict === "reject") && issues.length === 0) {
    invalid(`${verdict} requires at least one issue`);
  }
  return {
    schemaVersion: 1,
    projectId: judgment["projectId"],
    revision: judgment["revision"] as number,
    projectSha256: digest(judgment["projectSha256"], "project digest"),
    renderInputSha256: digest(judgment["renderInputSha256"], "render input digest"),
    previewArtifactSha256: digest(judgment["previewArtifactSha256"], "preview artifact digest"),
    renderRecipeSha256: digest(judgment["renderRecipeSha256"], "render recipe digest"),
    verdict,
    issues,
  };
}

export function previewJudgmentSummary(judgment: PreviewJudgment, project: RecordingProject) {
  if (judgment.projectId !== project.projectId || judgment.revision !== project.revision) {
    invalid("does not match project identity");
  }
  return {
    verdict: judgment.verdict,
    revision: judgment.revision,
    issues: judgment.issues,
    remainingAutomatedRevisionBudget:
      project.revisionPolicy.automatedRevisionLimit - project.revisionPolicy.automatedRevisionCount,
  };
}
