// biome-ignore-all lint/complexity/useLiteralKeys: persisted delivery and project evidence is untrusted dictionary data.
import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";

import { buildEditorialProposal, type EditorialProposal } from "../src/analysis/index.js";
import { canonicalJson } from "../src/manifest/index.js";
import {
  builtInRecordingProfiles,
  type RecordingProject,
  validateRecordingProject,
} from "../src/project/index.js";
import { previewJudgmentDigests, previewJudgmentSummary } from "../src/project/preview-judgment.js";
import { RecordingServiceUnavailableError } from "./handlers.js";
import { digestPrivateArtifact } from "./private-artifact.js";
import { PreviewJudgmentStore } from "./project-preview-judgment-store.js";
import { readVerifiedCaptureEditorialEvidence } from "./project-render-source.js";
import { RecordingProfileStore } from "./recording-profile-store.js";
import type { RecordingProjectView } from "./types.js";

function sha256(content: string | Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

export async function approvedSealedDeliveryManifest(input: {
  artifactRoot: string;
  sessionId: string;
}): Promise<{ manifestPath: string; manifest: unknown; manifestSha256: string }> {
  const artifacts = join(input.artifactRoot, input.sessionId, "artifacts");
  const manifestPath = join(artifacts, "recording-manifest.json");
  const qualityPath = join(artifacts, "quality-report.json");
  const videoPath = join(artifacts, "recording.mp4");
  for (const path of [manifestPath, qualityPath, videoPath]) {
    const status = await lstat(path);
    if (!status.isFile() || status.isSymbolicLink() || (status.mode & 0o077) !== 0) {
      throw new RecordingServiceUnavailableError();
    }
  }
  const manifestText = await readFile(manifestPath, "utf8");
  const quality = JSON.parse(await readFile(qualityPath, "utf8")) as Record<string, unknown>;
  const timing = quality["timing"] as Record<string, unknown> | undefined;
  const artifactHashes = quality["artifactHashes"] as Record<string, unknown> | undefined;
  const manifest = JSON.parse(manifestText) as Record<string, unknown>;
  const artifact = manifest["artifact"] as Record<string, unknown> | undefined;
  if (
    quality["schemaVersion"] !== 1 ||
    quality["kind"] !== "recordly-codex-quality-report" ||
    quality["status"] !== "approved" ||
    timing?.["mode"] !== "broker-receipt-offsets" ||
    timing?.["eligibleForApproval"] !== true ||
    typeof artifactHashes?.["videoSha256"] !== "string" ||
    typeof artifactHashes?.["manifestSha256"] !== "string" ||
    artifact?.["file"] !== "recording.mp4" ||
    artifact?.["sha256"] !== artifactHashes["videoSha256"] ||
    sha256(manifestText) !== artifactHashes["manifestSha256"] ||
    sha256(await readFile(videoPath)) !== artifactHashes["videoSha256"]
  ) {
    throw new RecordingServiceUnavailableError();
  }
  return { manifestPath, manifest, manifestSha256: sha256(manifestText) };
}

export function manifestProjectSource(input: {
  sessionId: string;
  projectId: string;
  automatedRevisionLimit: number;
  manifest: unknown;
  manifestSha256: string;
}): RecordingProject {
  if (
    input.manifest === null ||
    typeof input.manifest !== "object" ||
    Array.isArray(input.manifest)
  ) {
    throw new RecordingServiceUnavailableError();
  }
  const manifest = input.manifest as Record<string, unknown>;
  const source = manifest["source"];
  const timeline = manifest["timeline"];
  if (
    manifest["schemaVersion"] !== 1 ||
    manifest["kind"] !== "recordly-codex-delivery" ||
    manifest["sessionId"] !== input.sessionId ||
    source === null ||
    typeof source !== "object" ||
    Array.isArray(source) ||
    timeline === null ||
    typeof timeline !== "object" ||
    Array.isArray(timeline)
  ) {
    throw new RecordingServiceUnavailableError();
  }
  const sourceValue = source as Record<string, unknown>;
  const timelineValue = timeline as Record<string, unknown>;
  const cursorEvidence = manifest["cursorTrack"];
  const actionEvidence = manifest["observedActions"];
  const width = sourceValue["width"];
  const height = sourceValue["height"];
  const frameSetSha256 = sourceValue["aggregateSha256"];
  const durationUs = timelineValue["durationUs"];
  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    !Number.isSafeInteger(durationUs) ||
    (width as number) < 1 ||
    (height as number) < 1 ||
    (durationUs as number) < 1 ||
    typeof frameSetSha256 !== "string" ||
    !/^[a-f0-9]{64}$/iu.test(frameSetSha256) ||
    (cursorEvidence !== undefined && !Array.isArray(cursorEvidence)) ||
    !Array.isArray(actionEvidence)
  ) {
    throw new RecordingServiceUnavailableError();
  }
  const captureId = `capture-${sha256(input.sessionId).slice(0, 24)}`;
  return validateRecordingProject({
    schemaVersion: 1,
    projectId: input.projectId,
    revision: 0,
    revisionPolicy: {
      automatedRevisionLimit: input.automatedRevisionLimit,
      automatedRevisionCount: 0,
    },
    captureSources: [
      {
        id: captureId,
        sessionId: input.sessionId,
        manifestSha256: input.manifestSha256,
        timelineSha256: sha256(canonicalJson(timelineValue)),
        frameSetSha256,
        sourceWidth: width,
        sourceHeight: height,
        durationUs,
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
          id: `clip-${sha256(input.sessionId).slice(0, 24)}`,
          sourceId: captureId,
          trim: { startUs: 0, endUs: durationUs },
          speedRegions: [],
          zoomRegions: [],
          transitionAfter: { kind: "cut", durationUs: 0 },
        },
      ],
    },
    presentation: {
      cursor: {
        visible: Array.isArray(cursorEvidence) && cursorEvidence.length > 0,
        preset: "system",
        sizePx: 28,
        motion: "smoothed",
        clickEffect: actionEvidence.some(
          (event) =>
            event !== null &&
            typeof event === "object" &&
            (event as { type?: unknown }).type === "click",
        )
          ? "ripple"
          : "none",
      },
      frame: {
        background: { kind: "gradient", startColor: "#111827", endColor: "#312e81" },
        paddingPx: 40,
        radiusPx: 24,
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

export function projectView(
  project: RecordingProject,
  projectSha256: string,
  judgment?: RecordingProjectView["previewJudgment"],
): RecordingProjectView {
  return {
    project,
    projectSha256,
    ...(judgment === undefined ? {} : { previewJudgment: judgment }),
  };
}

export async function canonicalEditorialProposal(
  artifactRoot: string,
  project: RecordingProject,
): Promise<EditorialProposal> {
  if (project.schemaVersion !== 2) throw new RecordingServiceUnavailableError();
  const evidence = await Promise.all(
    project.captureSources.map((source) =>
      readVerifiedCaptureEditorialEvidence({ artifactRoot, source }),
    ),
  );
  const observedEvents = evidence
    .flatMap((entry) => entry.observedEvents)
    .sort(
      (left, right) =>
        left.sourceId.localeCompare(right.sourceId) ||
        left.tUs - right.tUs ||
        left.id.localeCompare(right.id),
    )
    .slice(0, 2_048);
  return buildEditorialProposal({
    schemaVersion: 1,
    project,
    observedEvents,
    deadTimeBySource: project.captureSources.map((source, index) => ({
      sourceId: source.id,
      analysis: (
        evidence[index] as Awaited<ReturnType<typeof readVerifiedCaptureEditorialEvidence>>
      ).deadTime,
    })),
  });
}

export function profileSummary(profile: {
  source: "builtin" | "owner-local";
  profileId: string;
  profileRevision: number;
  snapshotSha256: string;
}): {
  source: "builtin" | "owner-local";
  profileId: string;
  profileRevision: number;
  snapshotSha256: string;
} {
  return {
    source: profile.source,
    profileId: profile.profileId,
    profileRevision: profile.profileRevision,
    snapshotSha256: profile.snapshotSha256,
  };
}

export async function resolveCanonicalProfile(
  artifactRoot: string,
  ownerToken: string,
  locator: {
    source: "builtin" | "owner-local";
    profileId: string;
    profileRevision?: number;
    snapshotSha256?: string;
  },
) {
  const profile =
    locator.source === "builtin"
      ? builtInRecordingProfiles().find((candidate) => candidate.profileId === locator.profileId)
      : await new RecordingProfileStore(artifactRoot, ownerToken).load(locator.profileId);
  if (profile === undefined || profile.source !== locator.source)
    throw new RecordingServiceUnavailableError();
  if (
    (locator.profileRevision !== undefined &&
      profile.profileRevision !== locator.profileRevision) ||
    (locator.snapshotSha256 !== undefined &&
      profile.snapshotSha256 !== locator.snapshotSha256.toLowerCase())
  ) {
    throw new RecordingServiceUnavailableError();
  }
  return profile;
}

export async function previewArtifactDigest(
  artifactRoot: string,
  project: RecordingProject,
): Promise<string> {
  return (
    await digestPrivateArtifact({
      root: artifactRoot,
      relativePath: previewArtifactRelativePath(project),
      maximumBytes: 512 * 1024 * 1024,
    })
  ).sha256;
}

export function previewArtifactRelativePath(project: RecordingProject): string {
  return `projects/renders/${project.projectId}-r${project.revision}-preview.${project.output.format}`;
}

export async function inspectedPreviewJudgment(
  artifactRoot: string,
  ownerToken: string,
  project: RecordingProject,
): Promise<RecordingProjectView["previewJudgment"]> {
  const judgment = await new PreviewJudgmentStore(artifactRoot, ownerToken).load(
    project.projectId,
    project.revision,
  );
  if (judgment === undefined) return undefined;
  const summary = previewJudgmentSummary(judgment, project);
  try {
    const digests = previewJudgmentDigests(project);
    const artifactDigest = await previewArtifactDigest(artifactRoot, project);
    const current =
      judgment.projectSha256 === digests.projectSha256 &&
      judgment.renderInputSha256 === digests.renderInputSha256 &&
      judgment.renderRecipeSha256 === digests.renderRecipeSha256 &&
      judgment.previewArtifactSha256 === artifactDigest;
    return { ...summary, status: current ? "current" : "stale" };
  } catch {
    return { ...summary, status: "stale" };
  }
}
