// biome-ignore-all lint/complexity/useLiteralKeys: Exact runtime validation protects persisted project JSON.
import { ContractValidationError } from "../contracts/errors.js";
import { canonicalJson } from "../manifest/canonical-json.js";
import {
  isCaptureSourceGeometryBounded,
  MAX_CAPTURE_SOURCE_HEIGHT,
  MAX_CAPTURE_SOURCE_WIDTH,
  MIN_CAPTURE_SOURCE_DIMENSION,
} from "./capture-geometry.js";
import {
  builtInRecordingProfiles,
  validateRecordingProfileReference,
} from "./recording-profile.js";
import type {
  ProjectRenderInput,
  ProjectAssetReference,
  ProjectMediaAsset,
  RecordingProject,
  RecordingProjectV1,
  RecordingProjectV2,
} from "./types.js";

export const MAX_AUTOMATED_PROJECT_REVISIONS = 16;
const hashPattern = /^[a-f0-9]{64}$/iu;
const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const colorPattern = /^#[a-f0-9]{6}$/iu;
const v1ProjectFields = [
  "schemaVersion",
  "projectId",
  "revision",
  "revisionPolicy",
  "captureSources",
  "output",
  "timeline",
  "presentation",
  "overlays",
  "audioTracks",
  "pipTracks",
  "renderHooks",
  "preview",
] as const;

function invalid(code: string, message: string): never {
  throw new ContractValidationError(code, message);
}

function object(value: unknown, location: string): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  ) {
    invalid("invalid_shape", `${location} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exact(
  value: Record<string, unknown>,
  requiredKeys: readonly string[],
  location: string,
  optionalKeys: readonly string[] = [],
): void {
  const allowedKeys = [...requiredKeys, ...optionalKeys];
  if (Object.getOwnPropertySymbols(value).length > 0)
    invalid("unknown_field", `${location} cannot contain symbol fields`);
  for (const key of Object.getOwnPropertyNames(value))
    if (!allowedKeys.includes(key))
      invalid("unknown_field", `${location} has unknown field: ${key}`);
  for (const key of requiredKeys)
    if (!Object.hasOwn(value, key))
      invalid("missing_field", `${location} is missing required own field: ${key}`);
}

function identifier(value: unknown, location: string): string {
  if (typeof value !== "string" || !identifierPattern.test(value)) {
    invalid("invalid_identifier", `${location} must be a safe identifier`);
  }
  return value;
}

function text(value: unknown, location: string, maxLength = 500): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maxLength ||
    [...value].some((character) => character.charCodeAt(0) <= 31 || character.charCodeAt(0) === 127)
  )
    invalid("invalid_string", `${location} must be safe non-empty text`);
  return value;
}

function integer(
  value: unknown,
  location: string,
  minimum = 0,
  maximum = Number.MAX_SAFE_INTEGER,
): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    invalid("invalid_integer", `${location} is outside its allowed range`);
  }
  return value as number;
}

function number(value: unknown, location: string, minimum: number, maximum: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum) {
    invalid("invalid_number", `${location} is outside its allowed range`);
  }
  return value;
}

function oneOf<T extends string | number>(
  value: unknown,
  values: readonly T[],
  location: string,
): T {
  if (!values.includes(value as T))
    invalid("invalid_literal", `${location} has an unsupported value`);
  return value as T;
}

function hash(value: unknown, location: string): string {
  const digest = text(value, location, 64);
  if (!hashPattern.test(digest)) invalid("invalid_hash", `${location} must be a SHA-256 digest`);
  return digest.toLowerCase();
}

function boundedArray(value: unknown, location: string, maximum: number): unknown[] {
  if (
    !Array.isArray(value) ||
    value.length > maximum ||
    Object.keys(value).length !== value.length ||
    !Array.from({ length: value.length }, (_, index) => Object.hasOwn(value, index)).every(Boolean)
  )
    invalid("invalid_array", `${location} must be a bounded array`);
  return value;
}

function unique(values: readonly string[], location: string): void {
  if (new Set(values).size !== values.length)
    invalid("duplicate_identifier", `${location} contains duplicate identifiers`);
}

function range(
  value: unknown,
  location: string,
  minimum: number,
  maximum: number,
): { startUs: number; endUs: number } {
  const parsed = object(value, location);
  exact(parsed, ["startUs", "endUs"], location);
  const startUs = integer(parsed["startUs"], `${location}.startUs`, minimum, maximum);
  const endUs = integer(parsed["endUs"], `${location}.endUs`, minimum + 1, maximum);
  if (endUs <= startUs) invalid("invalid_range", `${location}.endUs must be after startUs`);
  return { startUs, endUs };
}

function noOverlaps(
  regions: readonly { startUs: number; endUs: number }[],
  location: string,
): void {
  for (let index = 1; index < regions.length; index += 1) {
    if (
      (regions[index - 1] as { endUs: number }).endUs >
      (regions[index] as { startUs: number }).startUs
    ) {
      invalid("overlapping_regions", `${location} must be ordered and non-overlapping`);
    }
  }
}

function captureSources(value: unknown): RecordingProject["captureSources"] {
  const sources = boundedArray(value, "project.captureSources", 8).map((entry, index) => {
    const parsed = object(entry, `project.captureSources[${index}]`);
    exact(
      parsed,
      [
        "id",
        "sessionId",
        "manifestSha256",
        "timelineSha256",
        "frameSetSha256",
        "sourceWidth",
        "sourceHeight",
        "durationUs",
      ],
      `project.captureSources[${index}]`,
    );
    const sourceWidth = integer(
      parsed["sourceWidth"],
      `project.captureSources[${index}].sourceWidth`,
      MIN_CAPTURE_SOURCE_DIMENSION,
      MAX_CAPTURE_SOURCE_WIDTH,
    );
    const sourceHeight = integer(
      parsed["sourceHeight"],
      `project.captureSources[${index}].sourceHeight`,
      MIN_CAPTURE_SOURCE_DIMENSION,
      MAX_CAPTURE_SOURCE_HEIGHT,
    );
    if (!isCaptureSourceGeometryBounded({ width: sourceWidth, height: sourceHeight })) {
      invalid(
        "invalid_capture_geometry",
        `project.captureSources[${index}] exceeds preview-renderable geometry bounds`,
      );
    }
    return {
      id: identifier(parsed["id"], `project.captureSources[${index}].id`),
      sessionId: identifier(parsed["sessionId"], `project.captureSources[${index}].sessionId`),
      manifestSha256: hash(
        parsed["manifestSha256"],
        `project.captureSources[${index}].manifestSha256`,
      ),
      timelineSha256: hash(
        parsed["timelineSha256"],
        `project.captureSources[${index}].timelineSha256`,
      ),
      frameSetSha256: hash(
        parsed["frameSetSha256"],
        `project.captureSources[${index}].frameSetSha256`,
      ),
      sourceWidth,
      sourceHeight,
      durationUs: integer(parsed["durationUs"], `project.captureSources[${index}].durationUs`, 1),
    };
  });
  if (sources.length === 0)
    invalid(
      "missing_capture_source",
      "project.captureSources must include at least one sealed capture",
    );
  unique(
    sources.map((source) => source.id),
    "project.captureSources",
  );
  return sources;
}

function output(value: unknown): RecordingProject["output"] {
  const parsed = object(value, "project.output");
  exact(parsed, ["profile", "width", "height", "fps", "format", "quality"], "project.output");
  const profile = oneOf(
    parsed["profile"],
    ["landscape-1080p", "square-1080", "vertical-1080"] as const,
    "project.output.profile",
  );
  const width = oneOf(parsed["width"], [1920, 1080] as never, "project.output.width") as
    | 1920
    | 1080;
  const height = oneOf(parsed["height"], [1080, 1920] as never, "project.output.height") as
    | 1080
    | 1920;
  const expected =
    profile === "landscape-1080p"
      ? [1920, 1080]
      : profile === "square-1080"
        ? [1080, 1080]
        : [1080, 1920];
  if (width !== expected[0] || height !== expected[1])
    invalid("invalid_profile_dimensions", "project.output dimensions do not match profile");
  return {
    profile,
    width,
    height,
    fps: oneOf(parsed["fps"], [30, 60] as never, "project.output.fps") as 30 | 60,
    format: oneOf(parsed["format"], ["mp4", "gif"] as const, "project.output.format"),
    quality: oneOf(
      parsed["quality"],
      ["draft", "standard", "high"] as const,
      "project.output.quality",
    ),
  };
}

function timeline(
  value: unknown,
  sources: readonly RecordingProject["captureSources"][number][],
): RecordingProject["timeline"] {
  const parsed = object(value, "project.timeline");
  exact(parsed, ["clips"], "project.timeline");
  const sourceById = new Map(sources.map((source) => [source.id, source]));
  const clips = boundedArray(parsed["clips"], "project.timeline.clips", 32).map((entry, index) => {
    const location = `project.timeline.clips[${index}]`;
    const clip = object(entry, location);
    exact(clip, ["id", "sourceId", "trim", "speedRegions", "zoomRegions"], location, [
      "transitionAfter",
    ]);
    const sourceId = identifier(clip["sourceId"], `${location}.sourceId`);
    const source = sourceById.get(sourceId);
    if (source === undefined)
      invalid("unknown_source", `${location}.sourceId does not reference a capture source`);
    const trim = range(clip["trim"], `${location}.trim`, 0, source.durationUs);
    const speedRegions = boundedArray(clip["speedRegions"], `${location}.speedRegions`, 32).map(
      (region, regionIndex) => {
        const item = object(region, `${location}.speedRegions[${regionIndex}]`);
        exact(
          item,
          ["startUs", "endUs", "startRate", "endRate"],
          `${location}.speedRegions[${regionIndex}]`,
        );
        const bounds = range(
          { startUs: item["startUs"], endUs: item["endUs"] },
          `${location}.speedRegions[${regionIndex}]`,
          trim.startUs,
          trim.endUs,
        );
        return {
          ...bounds,
          startRate: number(
            item["startRate"],
            `${location}.speedRegions[${regionIndex}].startRate`,
            0.1,
            8,
          ),
          endRate: number(
            item["endRate"],
            `${location}.speedRegions[${regionIndex}].endRate`,
            0.1,
            8,
          ),
        };
      },
    );
    noOverlaps(speedRegions, `${location}.speedRegions`);
    const zoomRegions = boundedArray(clip["zoomRegions"], `${location}.zoomRegions`, 32).map(
      (region, regionIndex) => {
        const item = object(region, `${location}.zoomRegions[${regionIndex}]`);
        exact(
          item,
          ["id", "startUs", "endUs", "mode", "focus", "scale", "easing"],
          `${location}.zoomRegions[${regionIndex}]`,
        );
        const bounds = range(
          { startUs: item["startUs"], endUs: item["endUs"] },
          `${location}.zoomRegions[${regionIndex}]`,
          trim.startUs,
          trim.endUs,
        );
        const focus = object(item["focus"], `${location}.zoomRegions[${regionIndex}].focus`);
        exact(focus, ["x", "y"], `${location}.zoomRegions[${regionIndex}].focus`);
        return {
          id: identifier(item["id"], `${location}.zoomRegions[${regionIndex}].id`),
          ...bounds,
          mode: oneOf(
            item["mode"],
            ["automatic", "manual"] as const,
            `${location}.zoomRegions[${regionIndex}].mode`,
          ),
          focus: {
            x: number(focus["x"], `${location}.zoomRegions[${regionIndex}].focus.x`, 0, 1),
            y: number(focus["y"], `${location}.zoomRegions[${regionIndex}].focus.y`, 0, 1),
          },
          scale: number(item["scale"], `${location}.zoomRegions[${regionIndex}].scale`, 1, 4),
          easing: oneOf(
            item["easing"],
            ["linear", "ease-in-out", "ease-out"] as const,
            `${location}.zoomRegions[${regionIndex}].easing`,
          ),
        };
      },
    );
    unique(
      zoomRegions.map((region) => region.id),
      `${location}.zoomRegions`,
    );
    noOverlaps(zoomRegions, `${location}.zoomRegions`);
    const transitionRaw = clip["transitionAfter"];
    let transitionAfter: { kind: "cut" | "crossfade"; durationUs: number } = {
      kind: "cut",
      durationUs: 0,
    };
    if (transitionRaw !== undefined) {
      const transition = object(transitionRaw, `${location}.transitionAfter`);
      exact(transition, ["kind", "durationUs"], `${location}.transitionAfter`);
      const kind = oneOf(
        transition["kind"],
        ["cut", "crossfade"] as const,
        `${location}.transitionAfter.kind`,
      );
      const durationUs = integer(
        transition["durationUs"],
        `${location}.transitionAfter.durationUs`,
        0,
        2_000_000,
      );
      if ((kind === "cut") !== (durationUs === 0))
        invalid("invalid_transition", `${location}.transitionAfter has invalid kind or duration`);
      transitionAfter = { kind, durationUs };
    }
    return {
      id: identifier(clip["id"], `${location}.id`),
      sourceId,
      trim,
      speedRegions,
      zoomRegions,
      transitionAfter,
    };
  });
  if (clips.length === 0)
    invalid("missing_clip", "project.timeline.clips must include at least one clip");
  unique(
    clips.map((clip) => clip.id),
    "project.timeline.clips",
  );
  return { clips };
}

function presentation(value: unknown): RecordingProject["presentation"] {
  const parsed = object(value, "project.presentation");
  exact(parsed, ["cursor", "frame"], "project.presentation");
  const cursor = object(parsed["cursor"], "project.presentation.cursor");
  exact(
    cursor,
    ["visible", "preset", "sizePx", "motion", "clickEffect"],
    "project.presentation.cursor",
  );
  if (typeof cursor["visible"] !== "boolean")
    invalid("invalid_boolean", "project.presentation.cursor.visible must be boolean");
  const frame = object(parsed["frame"], "project.presentation.frame");
  exact(frame, ["background", "paddingPx", "radiusPx", "shadow"], "project.presentation.frame");
  const background = object(frame["background"], "project.presentation.frame.background");
  const kind = oneOf(
    background["kind"],
    ["solid", "gradient"] as const,
    "project.presentation.frame.background.kind",
  );
  exact(
    background,
    kind === "solid" ? ["kind", "color"] : ["kind", "startColor", "endColor"],
    "project.presentation.frame.background",
  );
  const color = (value: unknown, location: string) => {
    const result = text(value, location, 7);
    if (!colorPattern.test(result))
      invalid("invalid_color", `${location} must be a six-digit hex color`);
    return result.toLowerCase();
  };
  return {
    cursor: {
      visible: cursor["visible"],
      preset: oneOf(
        cursor["preset"],
        ["system", "large"] as const,
        "project.presentation.cursor.preset",
      ),
      sizePx: integer(cursor["sizePx"], "project.presentation.cursor.sizePx", 12, 96),
      motion: oneOf(
        cursor["motion"],
        ["source", "smoothed"] as const,
        "project.presentation.cursor.motion",
      ),
      clickEffect: oneOf(
        cursor["clickEffect"],
        ["none", "ripple", "bounce"] as const,
        "project.presentation.cursor.clickEffect",
      ),
    },
    frame: {
      background:
        kind === "solid"
          ? {
              kind,
              color: color(background["color"], "project.presentation.frame.background.color"),
            }
          : {
              kind,
              startColor: color(
                background["startColor"],
                "project.presentation.frame.background.startColor",
              ),
              endColor: color(
                background["endColor"],
                "project.presentation.frame.background.endColor",
              ),
            },
      paddingPx: integer(frame["paddingPx"], "project.presentation.frame.paddingPx", 0, 240),
      radiusPx: integer(frame["radiusPx"], "project.presentation.frame.radiusPx", 0, 120),
      shadow: oneOf(
        frame["shadow"],
        ["none", "soft", "strong"] as const,
        "project.presentation.frame.shadow",
      ),
    },
  };
}

function asset(value: unknown, location: string): RecordingProject["audioTracks"][number]["asset"] {
  const parsed = object(value, location);
  exact(parsed, ["assetId", "sha256"], location);
  return {
    assetId: identifier(parsed["assetId"], `${location}.assetId`),
    sha256: hash(parsed["sha256"], `${location}.sha256`),
  };
}

function revisionPolicy(value: unknown): RecordingProject["revisionPolicy"] {
  const policy = object(value, "project.revisionPolicy");
  exact(policy, ["automatedRevisionLimit", "automatedRevisionCount"], "project.revisionPolicy");
  const automatedRevisionLimit = integer(
    policy["automatedRevisionLimit"],
    "project.revisionPolicy.automatedRevisionLimit",
    0,
    MAX_AUTOMATED_PROJECT_REVISIONS,
  );
  return {
    automatedRevisionLimit,
    automatedRevisionCount: integer(
      policy["automatedRevisionCount"],
      "project.revisionPolicy.automatedRevisionCount",
      0,
      automatedRevisionLimit,
    ),
  };
}

function authoredText(
  value: unknown,
  location: string,
): { value: string; provenance: "authored"; exportDisposition: "allow" | "redact" } {
  const authored = object(value, location);
  exact(authored, ["value", "provenance", "exportDisposition"], location);
  return {
    value: text(authored["value"], `${location}.value`, 500),
    provenance: oneOf(authored["provenance"], ["authored"] as const, `${location}.provenance`),
    exportDisposition: oneOf(
      authored["exportDisposition"],
      ["allow", "redact"] as const,
      `${location}.exportDisposition`,
    ),
  };
}

function remaining(
  value: Record<string, unknown>,
  clips: ReadonlyMap<string, RecordingProject["timeline"]["clips"][number]>,
): Pick<RecordingProject, "overlays" | "audioTracks" | "pipTracks" | "renderHooks" | "preview"> {
  const overlaysRaw = object(value["overlays"], "project.overlays");
  exact(overlaysRaw, ["annotations", "captions"], "project.overlays");
  const validateOverlay = (entry: unknown, index: number, caption: boolean) => {
    const location = `project.overlays.${caption ? "captions" : "annotations"}[${index}]`;
    const item = object(entry, location);
    exact(
      item,
      caption
        ? ["id", "clipId", "timeDomain", "startUs", "endUs", "text"]
        : ["id", "clipId", "timeDomain", "startUs", "endUs", "text", "position", "style"],
      location,
    );
    const clipId = identifier(item["clipId"], `${location}.clipId`);
    const clip = clips.get(clipId);
    if (clip === undefined) invalid("unknown_clip", `${location}.clipId does not reference a clip`);
    const timeDomain = oneOf(
      item["timeDomain"],
      ["clip-source-relative"] as const,
      `${location}.timeDomain`,
    );
    return {
      id: identifier(item["id"], `${location}.id`),
      clipId,
      timeDomain,
      ...range(
        { startUs: item["startUs"], endUs: item["endUs"] },
        location,
        0,
        clip.trim.endUs - clip.trim.startUs,
      ),
      text: authoredText(item["text"], `${location}.text`),
      ...(caption
        ? {}
        : {
            position: oneOf(item["position"], ["top", "bottom"] as const, `${location}.position`),
            style: oneOf(item["style"], ["default", "emphasis"] as const, `${location}.style`),
          }),
    };
  };
  const annotations = boundedArray(
    overlaysRaw["annotations"],
    "project.overlays.annotations",
    64,
  ).map((entry, index) =>
    validateOverlay(entry, index, false),
  ) as RecordingProject["overlays"]["annotations"];
  const captions = boundedArray(overlaysRaw["captions"], "project.overlays.captions", 256).map(
    (entry, index) => validateOverlay(entry, index, true),
  ) as RecordingProject["overlays"]["captions"];
  unique(
    annotations.map((item) => item.id),
    "project.overlays.annotations",
  );
  unique(
    captions.map((item) => item.id),
    "project.overlays.captions",
  );
  const audioTracks = boundedArray(value["audioTracks"], "project.audioTracks", 16).map(
    (entry, index) => {
      const location = `project.audioTracks[${index}]`;
      const item = object(entry, location);
      exact(item, ["id", "asset", "timeDomain", "startUs", "trim", "gainDb"], location);
      return {
        id: identifier(item["id"], `${location}.id`),
        asset: asset(item["asset"], `${location}.asset`),
        timeDomain: oneOf(
          item["timeDomain"],
          ["project-output-relative"] as const,
          `${location}.timeDomain`,
        ),
        startUs: integer(item["startUs"], `${location}.startUs`),
        trim: range(item["trim"], `${location}.trim`, 0, Number.MAX_SAFE_INTEGER),
        gainDb: number(item["gainDb"], `${location}.gainDb`, -60, 12),
      };
    },
  );
  unique(
    audioTracks.map((track) => track.id),
    "project.audioTracks",
  );
  const pipTracks = boundedArray(value["pipTracks"], "project.pipTracks", 8).map((entry, index) => {
    const location = `project.pipTracks[${index}]`;
    const item = object(entry, location);
    exact(
      item,
      ["id", "asset", "clipId", "timeDomain", "startUs", "endUs", "position", "scale"],
      location,
    );
    const clipId = identifier(item["clipId"], `${location}.clipId`);
    const clip = clips.get(clipId);
    if (clip === undefined) invalid("unknown_clip", `${location}.clipId does not reference a clip`);
    return {
      id: identifier(item["id"], `${location}.id`),
      asset: asset(item["asset"], `${location}.asset`),
      clipId,
      timeDomain: oneOf(
        item["timeDomain"],
        ["clip-source-relative"] as const,
        `${location}.timeDomain`,
      ),
      ...range(
        { startUs: item["startUs"], endUs: item["endUs"] },
        location,
        0,
        clip.trim.endUs - clip.trim.startUs,
      ),
      position: oneOf(
        item["position"],
        ["top-left", "top-right", "bottom-left", "bottom-right"] as const,
        `${location}.position`,
      ),
      scale: number(item["scale"], `${location}.scale`, 0.1, 0.5),
    };
  });
  unique(
    pipTracks.map((track) => track.id),
    "project.pipTracks",
  );
  const renderHooks = boundedArray(value["renderHooks"], "project.renderHooks", 8).map(
    (entry, index) => {
      const location = `project.renderHooks[${index}]`;
      const item = object(entry, location);
      exact(item, ["id", "kind", "permission", "status"], location);
      return {
        id: identifier(item["id"], `${location}.id`),
        kind: oneOf(item["kind"], ["metadata", "watermark"] as const, `${location}.kind`),
        permission: oneOf(
          item["permission"],
          ["explicit-local-render-hook"] as const,
          `${location}.permission`,
        ),
        status: oneOf(item["status"], ["declared"] as const, `${location}.status`),
      };
    },
  );
  unique(
    renderHooks.map((hook) => hook.id),
    "project.renderHooks",
  );
  const previewRaw = object(value["preview"], "project.preview");
  const status = oneOf(
    previewRaw["status"],
    ["not-requested", "ready", "stale", "rendered"] as const,
    "project.preview.status",
  );
  exact(
    previewRaw,
    status === "not-requested" ? ["status"] : ["status", "revision"],
    "project.preview",
  );
  const preview =
    status === "not-requested"
      ? { status }
      : {
          status,
          revision: integer(
            previewRaw["revision"],
            "project.preview.revision",
            0,
            Number.MAX_SAFE_INTEGER,
          ),
        };
  return { overlays: { annotations, captions }, audioTracks, pipTracks, renderHooks, preview };
}

function validateV1Project(value: unknown): RecordingProjectV1 {
  const project = object(value, "project");
  exact(project, v1ProjectFields, "project");
  const revision = integer(project["revision"], "project.revision", 0, Number.MAX_SAFE_INTEGER);
  const parsedRevisionPolicy = revisionPolicy(project["revisionPolicy"]);
  const sources = captureSources(project["captureSources"]);
  const parsedTimeline = timeline(project["timeline"], sources);
  const remainingParts = remaining(
    project,
    new Map(parsedTimeline.clips.map((clip) => [clip.id, clip])),
  );
  if (
    remainingParts.preview.status !== "not-requested" &&
    remainingParts.preview.revision > revision
  )
    invalid("invalid_preview_revision", "project.preview cannot refer to a future revision");
  return {
    schemaVersion: 1,
    projectId: identifier(project["projectId"], "project.projectId"),
    revision,
    revisionPolicy: parsedRevisionPolicy,
    captureSources: sources,
    output: output(project["output"]),
    timeline: parsedTimeline,
    presentation: presentation(project["presentation"]),
    ...remainingParts,
  };
}

function mediaAssets(value: unknown): ProjectMediaAsset[] {
  const media = object(value, "project.media");
  exact(media, ["assets"], "project.media");
  const assets = boundedArray(media["assets"], "project.media.assets", 32).map((entry, index) => {
    const location = `project.media.assets[${index}]`;
    const asset = object(entry, location);
    const kind = oneOf(asset["kind"], ["audio", "image", "video"] as const, `${location}.kind`);
    if (kind === "video") {
      exact(
        asset,
        ["id", "sha256", "kind", "provenance", "durationUs", "width", "height", "fps"],
        location,
      );
      return {
        id: identifier(asset["id"], `${location}.id`),
        sha256: hash(asset["sha256"], `${location}.sha256`),
        kind,
        provenance: oneOf(
          asset["provenance"],
          ["explicit-local-import"] as const,
          `${location}.provenance`,
        ),
        durationUs: integer(
          asset["durationUs"],
          `${location}.durationUs`,
          1,
          24 * 60 * 60 * 1_000_000,
        ),
        width: integer(asset["width"], `${location}.width`, 2, 4096),
        height: integer(asset["height"], `${location}.height`, 2, 4096),
        fps: number(asset["fps"], `${location}.fps`, 1, 60),
      } as ProjectMediaAsset;
    }
    exact(asset, ["id", "sha256", "kind", "provenance", "durationUs"], location);
    return {
      id: identifier(asset["id"], `${location}.id`),
      sha256: hash(asset["sha256"], `${location}.sha256`),
      kind,
      provenance: oneOf(
        asset["provenance"],
        ["legacy-declared", "explicit-local-import"] as const,
        `${location}.provenance`,
      ),
      durationUs: integer(
        asset["durationUs"],
        `${location}.durationUs`,
        1,
        24 * 60 * 60 * 1_000_000,
      ),
    } as ProjectMediaAsset;
  });
  unique(
    assets.map((asset) => asset.id),
    "project.media.assets",
  );
  return assets;
}

function validateV2Project(value: unknown): RecordingProjectV2 {
  const project = object(value, "project");
  exact(
    project,
    [
      ...v1ProjectFields,
      "media",
      "visualTracks",
      "timelineTransitions",
      "zoomProposals",
      "presentationControls",
      "audioMix",
      "profile",
    ],
    "project",
  );
  if (project["schemaVersion"] !== 2)
    invalid("unsupported_version", "project.schemaVersion must equal 2");
  const v1Payload = Object.fromEntries(
    v1ProjectFields.map((field) => [field, field === "schemaVersion" ? 1 : project[field]]),
  );
  const base = validateV1Project(v1Payload);
  const profile = validateRecordingProfileReference(project["profile"]);
  const assets = mediaAssets(project["media"]);
  const assetById = new Map(assets.map((asset) => [asset.id, asset]));
  const requireAsset = (
    assetId: string,
    expected: "audio" | "image" | "video",
    location: string,
  ) => {
    const asset = assetById.get(assetId);
    if (asset === undefined || asset.kind !== expected)
      invalid("unknown_media", `${location} must reference a registered ${expected} asset`);
    return asset;
  };
  for (const track of base.audioTracks) {
    const asset = requireAsset(
      track.asset.assetId,
      "audio",
      `project.audioTracks.${track.id}.asset`,
    );
    if (asset.sha256 !== track.asset.sha256)
      invalid("media_digest_mismatch", "project audio asset does not match media registry");
  }
  for (const track of base.pipTracks) {
    const asset = requireAsset(track.asset.assetId, "image", `project.pipTracks.${track.id}.asset`);
    if (asset.sha256 !== track.asset.sha256)
      invalid("media_digest_mismatch", "project PiP asset does not match media registry");
  }
  const clips = new Map(base.timeline.clips.map((clip) => [clip.id, clip]));
  const visualTracks = boundedArray(project["visualTracks"], "project.visualTracks", 16).map(
    (entry, index) => {
      const location = `project.visualTracks[${index}]`;
      const track = object(entry, location);
      exact(
        track,
        [
          "id",
          "mediaId",
          "clipId",
          "timeDomain",
          "startUs",
          "endUs",
          "mediaTrim",
          "sync",
          "layout",
          "motion",
        ],
        location,
      );
      const clipId = identifier(track["clipId"], `${location}.clipId`);
      const clip = clips.get(clipId);
      if (clip === undefined)
        invalid("unknown_clip", `${location}.clipId does not reference a clip`);
      const mediaId = identifier(track["mediaId"], `${location}.mediaId`);
      const asset = assetById.get(mediaId);
      if (asset === undefined || (asset.kind !== "image" && asset.kind !== "video"))
        invalid("unknown_media", `${location}.mediaId must reference a registered visual asset`);
      const sourceRange = range(
        { startUs: track["startUs"], endUs: track["endUs"] },
        location,
        0,
        clip.trim.endUs - clip.trim.startUs,
      );
      const mediaTrim = range(track["mediaTrim"], `${location}.mediaTrim`, 0, asset.durationUs);
      const sync = oneOf(
        track["sync"],
        ["source-time", "output-time"] as const,
        `${location}.sync`,
      );
      if (
        sync === "source-time" &&
        mediaTrim.endUs - mediaTrim.startUs !== sourceRange.endUs - sourceRange.startUs
      ) {
        invalid(
          "invalid_visual_sync",
          `${location}.source-time media trim must match its source range`,
        );
      }
      const layout = object(track["layout"], `${location}.layout`);
      exact(
        layout,
        ["position", "scale", "fit", "crop", "opacity", "radiusPx", "border"],
        `${location}.layout`,
      );
      const cropValue = layout["crop"];
      const crop: "none" | { x: number; y: number; width: number; height: number } =
        cropValue === "none"
          ? "none"
          : (() => {
              const value = object(cropValue, `${location}.layout.crop`);
              exact(value, ["x", "y", "width", "height"], `${location}.layout.crop`);
              const x = number(value["x"], `${location}.layout.crop.x`, 0, 1);
              const y = number(value["y"], `${location}.layout.crop.y`, 0, 1);
              const width = number(value["width"], `${location}.layout.crop.width`, 0.01, 1);
              const height = number(value["height"], `${location}.layout.crop.height`, 0.01, 1);
              if (x + width > 1 || y + height > 1)
                invalid(
                  "invalid_crop",
                  `${location}.layout.crop must remain within normalized media bounds`,
                );
              return { x, y, width, height };
            })();
      const motion = object(track["motion"], `${location}.motion`);
      exact(motion, ["preset", "durationUs"], `${location}.motion`);
      const preset = oneOf(
        motion["preset"],
        ["none", "fade", "pop"] as const,
        `${location}.motion.preset`,
      );
      const durationUs = integer(motion["durationUs"], `${location}.motion.durationUs`, 0, 500_000);
      if ((preset === "none") !== (durationUs === 0))
        invalid("invalid_motion", `${location}.motion must use zero duration only for none`);
      return {
        id: identifier(track["id"], `${location}.id`),
        mediaId,
        clipId,
        timeDomain: oneOf(
          track["timeDomain"],
          ["clip-source-relative"] as const,
          `${location}.timeDomain`,
        ),
        ...sourceRange,
        mediaTrim,
        sync,
        layout: {
          position: oneOf(
            layout["position"],
            ["top-left", "top-right", "bottom-left", "bottom-right"] as const,
            `${location}.layout.position`,
          ),
          scale: number(layout["scale"], `${location}.layout.scale`, 0.1, 0.6),
          fit: oneOf(layout["fit"], ["contain", "cover"] as const, `${location}.layout.fit`),
          crop,
          opacity: number(layout["opacity"], `${location}.layout.opacity`, 0.1, 1),
          radiusPx: integer(layout["radiusPx"], `${location}.layout.radiusPx`, 0, 120),
          border: oneOf(
            layout["border"],
            ["none", "light", "strong"] as const,
            `${location}.layout.border`,
          ),
        },
        motion: { preset, durationUs },
      };
    },
  );
  unique(
    visualTracks.map((track) => track.id),
    "project.visualTracks",
  );
  const timelineTransitions = boundedArray(
    project["timelineTransitions"],
    "project.timelineTransitions",
    base.timeline.clips.length,
  ).map((entry, index) => {
    const location = `project.timelineTransitions[${index}]`;
    const transition = object(entry, location);
    exact(transition, ["clipId", "family", "durationUs", "easing"], location, ["color"]);
    const clipId = identifier(transition["clipId"], `${location}.clipId`);
    const clip = clips.get(clipId);
    if (clip === undefined) invalid("unknown_clip", `${location}.clipId does not reference a clip`);
    const family = oneOf(
      transition["family"],
      [
        "cut",
        "crossfade",
        "dip-to-color",
        "wipe-left",
        "wipe-right",
        "slide-left",
        "slide-right",
      ] as const,
      `${location}.family`,
    );
    const durationUs = integer(transition["durationUs"], `${location}.durationUs`, 0, 2_000_000);
    if ((family === "cut") !== (durationUs === 0))
      invalid("invalid_transition", `${location} has invalid family or duration`);
    const transitionColor = transition["color"];
    if (family === "dip-to-color") {
      if (transitionColor === undefined)
        invalid("missing_field", `${location}.color is required for dip-to-color`);
      colorPattern.test(transitionColor as string) ||
        invalid("invalid_color", `${location}.color must be a #rrggbb color`);
    } else if (transitionColor !== undefined) {
      invalid("unknown_field", `${location}.color is only supported by dip-to-color`);
    }
    const fallback = clip.transitionAfter ?? { kind: "cut", durationUs: 0 };
    const expectedFallback = family === "cut" ? "cut" : "crossfade";
    if (fallback.kind !== expectedFallback || fallback.durationUs !== durationUs) {
      invalid(
        "transition_fallback_mismatch",
        `${location} must preserve its V1 fallback transition`,
      );
    }
    return {
      clipId,
      family,
      durationUs,
      easing: oneOf(
        transition["easing"],
        ["linear", "ease-in-out", "ease-out"] as const,
        `${location}.easing`,
      ),
      ...(transitionColor === undefined
        ? {}
        : { color: (transitionColor as string).toLowerCase() }),
    };
  });
  unique(
    timelineTransitions.map((transition) => transition.clipId),
    "project.timelineTransitions",
  );
  const zoomProposals = boundedArray(project["zoomProposals"], "project.zoomProposals", 64).map(
    (entry, index) => {
      const location = `project.zoomProposals[${index}]`;
      const proposal = object(entry, location);
      exact(
        proposal,
        ["id", "clipId", "sourceRange", "focus", "scale", "easing", "review"],
        location,
      );
      const clipId = identifier(proposal["clipId"], `${location}.clipId`);
      const clip = clips.get(clipId);
      if (clip === undefined)
        invalid("unknown_clip", `${location}.clipId does not reference a clip`);
      const focus = object(proposal["focus"], `${location}.focus`);
      exact(focus, ["x", "y"], `${location}.focus`);
      const review = object(proposal["review"], `${location}.review`);
      exact(review, ["status", "basis"], `${location}.review`);
      return {
        id: identifier(proposal["id"], `${location}.id`),
        clipId,
        sourceRange: range(
          proposal["sourceRange"],
          `${location}.sourceRange`,
          clip.trim.startUs,
          clip.trim.endUs,
        ),
        focus: {
          x: number(focus["x"], `${location}.focus.x`, 0, 1),
          y: number(focus["y"], `${location}.focus.y`, 0, 1),
        },
        scale: number(proposal["scale"], `${location}.scale`, 1, 4),
        easing: oneOf(
          proposal["easing"],
          ["linear", "ease-in-out", "ease-out"] as const,
          `${location}.easing`,
        ),
        review: {
          status: oneOf(
            review["status"],
            ["proposed", "accepted", "rejected"] as const,
            `${location}.review.status`,
          ),
          basis: oneOf(
            review["basis"],
            ["observed-input", "manual"] as const,
            `${location}.review.basis`,
          ),
        },
      };
    },
  );
  unique(
    zoomProposals.map((proposal) => proposal.id),
    "project.zoomProposals",
  );
  const controls = object(project["presentationControls"], "project.presentationControls");
  exact(controls, ["cursor", "frame", "export"], "project.presentationControls");
  const cursorControls = object(controls["cursor"], "project.presentationControls.cursor");
  const frameControls = object(controls["frame"], "project.presentationControls.frame");
  const exportControls = object(controls["export"], "project.presentationControls.export");
  exact(cursorControls, ["emphasis", "trailDurationUs"], "project.presentationControls.cursor");
  exact(frameControls, ["fit", "border"], "project.presentationControls.frame");
  exact(exportControls, ["audio", "colorRange", "metadata"], "project.presentationControls.export");
  const emphasis = oneOf(
    cursorControls["emphasis"],
    ["none", "spotlight", "trail"] as const,
    "project.presentationControls.cursor.emphasis",
  );
  const trailDurationUs = integer(
    cursorControls["trailDurationUs"],
    "project.presentationControls.cursor.trailDurationUs",
    0,
    1_000_000,
  );
  if ((emphasis === "trail") !== trailDurationUs > 0)
    invalid("invalid_cursor_control", "cursor trail duration is only valid for trail emphasis");
  const audioMix = object(project["audioMix"], "project.audioMix");
  exact(audioMix, ["tracks"], "project.audioMix");
  const audioTrackById = new Map(base.audioTracks.map((track) => [track.id, track]));
  const mixTracks = boundedArray(audioMix["tracks"], "project.audioMix.tracks", 16).map(
    (entry, index) => {
      const location = `project.audioMix.tracks[${index}]`;
      const track = object(entry, location);
      exact(
        track,
        ["trackId", "mediaId", "role", "pan", "fadeInUs", "fadeOutUs", "ducking"],
        location,
      );
      const trackId = identifier(track["trackId"], `${location}.trackId`);
      const legacyTrack = audioTrackById.get(trackId);
      if (legacyTrack === undefined)
        invalid("unknown_audio_track", `${location}.trackId is not a project audio track`);
      const mediaId = identifier(track["mediaId"], `${location}.mediaId`);
      const asset = requireAsset(mediaId, "audio", location);
      if (legacyTrack.asset.assetId !== mediaId || legacyTrack.asset.sha256 !== asset.sha256)
        invalid("media_digest_mismatch", `${location}.mediaId must match its project audio track`);
      const fadeInUs = integer(track["fadeInUs"], `${location}.fadeInUs`, 0, 2_000_000);
      const fadeOutUs = integer(track["fadeOutUs"], `${location}.fadeOutUs`, 0, 2_000_000);
      if (fadeInUs + fadeOutUs > legacyTrack.trim.endUs - legacyTrack.trim.startUs)
        invalid("invalid_audio_fades", `${location} fades exceed the selected audio trim`);
      const role = oneOf(track["role"], ["primary", "bed", "effect"] as const, `${location}.role`);
      const ducking = oneOf(
        track["ducking"],
        ["none", "against-primary"] as const,
        `${location}.ducking`,
      );
      if (role === "primary" && ducking !== "none")
        invalid("invalid_audio_ducking", `${location}.primary cannot duck against itself`);
      return {
        trackId,
        mediaId,
        role,
        pan: number(track["pan"], `${location}.pan`, -1, 1),
        fadeInUs,
        fadeOutUs,
        ducking,
      };
    },
  );
  unique(
    mixTracks.map((track) => track.trackId),
    "project.audioMix.tracks",
  );
  if (mixTracks.length !== base.audioTracks.length)
    invalid("incomplete_audio_mix", "project.audioMix must describe each project audio track");
  if (
    mixTracks.some((track) => track.ducking === "against-primary") &&
    !mixTracks.some((track) => track.role === "primary")
  ) {
    invalid("missing_primary_audio", "ducked audio requires a primary audio track");
  }
  return {
    ...base,
    schemaVersion: 2,
    profile,
    media: { assets },
    visualTracks,
    timelineTransitions,
    zoomProposals,
    presentationControls: {
      cursor: { emphasis, trailDurationUs },
      frame: {
        fit: oneOf(
          frameControls["fit"],
          ["contain", "cover"] as const,
          "project.presentationControls.frame.fit",
        ),
        border: oneOf(
          frameControls["border"],
          ["none", "subtle", "strong"] as const,
          "project.presentationControls.frame.border",
        ),
      },
      export: {
        audio: oneOf(
          exportControls["audio"],
          ["include", "mute"] as const,
          "project.presentationControls.export.audio",
        ),
        colorRange: oneOf(
          exportControls["colorRange"],
          ["limited"] as const,
          "project.presentationControls.export.colorRange",
        ),
        metadata: oneOf(
          exportControls["metadata"],
          ["none", "minimal"] as const,
          "project.presentationControls.export.metadata",
        ),
      },
    },
    audioMix: { tracks: mixTracks },
  };
}

const projectValidators: Readonly<Record<number, (value: unknown) => RecordingProject>> = {
  1: validateV1Project,
  2: validateV2Project,
};

/** Dispatches persisted project JSON by its own schema version. */
export function validateRecordingProject(value: unknown): RecordingProject {
  const project = object(value, "project");
  if (!Object.hasOwn(project, "schemaVersion") || !Number.isSafeInteger(project["schemaVersion"])) {
    invalid("unsupported_version", "project.schemaVersion must be a supported integer");
  }
  const validator = projectValidators[project["schemaVersion"] as number];
  if (validator === undefined)
    invalid("unsupported_version", "project.schemaVersion is not supported");
  return validator(value);
}

/**
 * Produces the V2 editorial envelope only when a caller explicitly asks to
 * migrate or revises a V1 project. Reading/validating V1 remains non-mutating.
 */
export function migrateV1RecordingProject(value: unknown): RecordingProjectV2 {
  // Compatibility decision: reject legacy capture geometry that preview rendering cannot consume
  // instead of producing a V2 revision that will deterministically fail at preview time.
  const project = validateRecordingProject(value);
  if (project.schemaVersion === 2) return project;
  const mediaByKey = new Map<
    string,
    { id: string; sha256: string; kind: "audio" | "image"; durationUs: number }
  >();
  const usedIds = new Set<string>();
  const mediaId = (kind: "audio" | "image", asset: ProjectAssetReference): string => {
    const key = `${kind}:${asset.assetId}:${asset.sha256}`;
    const existing = mediaByKey.get(key);
    if (existing !== undefined) return existing.id;
    const direct = asset.assetId;
    const id = usedIds.has(direct) ? `legacy-${kind}-${asset.sha256.slice(0, 24)}` : direct;
    usedIds.add(id);
    mediaByKey.set(key, { id, sha256: asset.sha256, kind, durationUs: 1 });
    return id;
  };
  for (const track of project.audioTracks) {
    const id = mediaId("audio", track.asset);
    const value = mediaByKey.get(`audio:${track.asset.assetId}:${track.asset.sha256}`);
    if (value === undefined) throw new Error("legacy media is unavailable");
    value.durationUs = Math.max(value.durationUs, track.trim.endUs);
    if (id !== value.id) throw new Error("legacy media identity is inconsistent");
  }
  for (const track of project.pipTracks) {
    const id = mediaId("image", track.asset);
    const value = mediaByKey.get(`image:${track.asset.assetId}:${track.asset.sha256}`);
    if (value === undefined) throw new Error("legacy media is unavailable");
    value.durationUs = Math.max(value.durationUs, track.endUs - track.startUs);
    if (id !== value.id) throw new Error("legacy media identity is inconsistent");
  }
  const media = [...mediaByKey.values()].map((asset) => ({
    ...asset,
    provenance: "legacy-declared" as const,
  }));
  const projectMediaId = (kind: "audio" | "image", asset: ProjectAssetReference): string => {
    const found = mediaByKey.get(`${kind}:${asset.assetId}:${asset.sha256}`);
    if (found === undefined) throw new Error("legacy media is unavailable");
    return found.id;
  };
  const cleanProfile = builtInRecordingProfiles().find((profile) => profile.profileId === "clean");
  if (cleanProfile === undefined)
    invalid("missing_builtin_profile", "clean built-in profile is unavailable");
  return validateV2Project({
    ...project,
    schemaVersion: 2,
    profile: cleanProfile,
    media: { assets: media },
    visualTracks: project.pipTracks.map((track) => ({
      id: track.id,
      mediaId: projectMediaId("image", track.asset),
      clipId: track.clipId,
      timeDomain: "clip-source-relative",
      startUs: track.startUs,
      endUs: track.endUs,
      mediaTrim: { startUs: 0, endUs: track.endUs - track.startUs },
      sync: "source-time",
      layout: {
        position: track.position,
        scale: track.scale,
        fit: "contain",
        crop: "none",
        opacity: 1,
        radiusPx: 0,
        border: "none",
      },
      motion: { preset: "none", durationUs: 0 },
    })),
    timelineTransitions: project.timeline.clips.map((clip) => ({
      clipId: clip.id,
      family: clip.transitionAfter?.kind ?? "cut",
      durationUs: clip.transitionAfter?.durationUs ?? 0,
      easing: "linear",
    })),
    zoomProposals: [],
    presentationControls: {
      cursor: { emphasis: "none", trailDurationUs: 0 },
      frame: { fit: "contain", border: "none" },
      export: { audio: "include", colorRange: "limited", metadata: "minimal" },
    },
    audioMix: {
      tracks: project.audioTracks.map((track, index) => ({
        trackId: track.id,
        mediaId: projectMediaId("audio", track.asset),
        role: index === 0 ? "primary" : "bed",
        pan: 0,
        fadeInUs: 0,
        fadeOutUs: 0,
        ducking: "none",
      })),
    },
  });
}

export function canonicalRecordingProject(value: unknown): string {
  return canonicalJson(validateRecordingProject(value));
}

function sameCaptureSources(
  left: RecordingProject["captureSources"],
  right: RecordingProject["captureSources"],
): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

/** Applies one immutable editorial revision without allowing capture evidence to be replaced. */
export function reviseRecordingProject(
  currentValue: unknown,
  nextValue: unknown,
  mode: "manual" | "automated" = "manual",
): RecordingProject {
  const current = validateRecordingProject(currentValue);
  const suppliedNext = validateRecordingProject(nextValue);
  if (current.schemaVersion === 2 && suppliedNext.schemaVersion === 1) {
    invalid("schema_downgrade", "project revisions cannot downgrade a V2 project");
  }
  const next =
    suppliedNext.schemaVersion === 1 ? migrateV1RecordingProject(suppliedNext) : suppliedNext;
  if (next.projectId !== current.projectId)
    invalid("project_identity_changed", "project revisions must preserve projectId");
  if (!sameCaptureSources(current.captureSources, next.captureSources))
    invalid("capture_sources_changed", "project revisions must preserve capture sources");
  if (next.revision !== current.revision + 1)
    invalid("invalid_revision", "project revisions must increase monotonically by one");
  if (canonicalJson(current.revisionPolicy) !== canonicalJson(next.revisionPolicy)) {
    const expectedCount =
      current.revisionPolicy.automatedRevisionCount + (mode === "automated" ? 1 : 0);
    if (
      next.revisionPolicy.automatedRevisionLimit !==
        current.revisionPolicy.automatedRevisionLimit ||
      next.revisionPolicy.automatedRevisionCount !== expectedCount ||
      expectedCount > current.revisionPolicy.automatedRevisionLimit
    )
      invalid("invalid_automated_revision_policy", "automated revision policy is invalid");
  } else if (mode === "automated") {
    invalid("invalid_automated_revision_policy", "automated revisions must consume policy budget");
  }
  return {
    ...next,
    preview:
      next.preview.status === "rendered" && next.preview.revision === next.revision
        ? next.preview
        : { status: "stale", revision: current.revision },
  };
}

/**
 * Export gate for explicitly authored editorial text. This does not inspect
 * text for secrets; callers must mark any text requiring removal as `redact`.
 */
export function assertProjectTextReadyForExport(value: unknown): void {
  const project = validateRecordingProject(value);
  const text = [...project.overlays.annotations, ...project.overlays.captions].map(
    (overlay) => overlay.text,
  );
  if (text.some((entry) => entry.exportDisposition !== "allow")) {
    invalid("redaction_required", "authored text marked redact cannot enter an export");
  }
}

export function toProjectRenderInput(value: unknown): ProjectRenderInput {
  const project = validateRecordingProject(value);
  assertProjectTextReadyForExport(project);
  const { schemaVersion: _schemaVersion, preview: _preview, ...renderInput } = project;
  return renderInput;
}
