// biome-ignore-all lint/complexity/useLiteralKeys: Exact runtime validation protects persisted project JSON.
import { ContractValidationError } from "../contracts/errors.js";
import { canonicalJson } from "../manifest/canonical-json.js";
import type { ProjectRenderInput, RecordingProject } from "./types.js";

export const MAX_AUTOMATED_PROJECT_REVISIONS = 16;
const hashPattern = /^[a-f0-9]{64}$/iu;
const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const colorPattern = /^#[a-f0-9]{6}$/iu;

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
      sourceWidth: integer(
        parsed["sourceWidth"],
        `project.captureSources[${index}].sourceWidth`,
        1,
        16_384,
      ),
      sourceHeight: integer(
        parsed["sourceHeight"],
        `project.captureSources[${index}].sourceHeight`,
        1,
        16_384,
      ),
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

function validateV1Project(value: unknown): RecordingProject {
  const project = object(value, "project");
  exact(
    project,
    [
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
    ],
    "project",
  );
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

const projectValidators: Readonly<Record<number, (value: unknown) => RecordingProject>> = {
  1: validateV1Project,
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
  const next = validateRecordingProject(nextValue);
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
