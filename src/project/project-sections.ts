// biome-ignore-all lint/complexity/useLiteralKeys: Exact runtime validation protects persisted project JSON.
import {
  isCaptureSourceGeometryBounded,
  MAX_CAPTURE_SOURCE_HEIGHT,
  MAX_CAPTURE_SOURCE_WIDTH,
  MIN_CAPTURE_SOURCE_DIMENSION,
} from "./capture-geometry.js";
import type { RecordingProject } from "./types.js";
import {
  boundedArray,
  colorPattern,
  exact,
  hash,
  identifier,
  integer,
  invalid,
  noOverlaps,
  number,
  object,
  oneOf,
  range,
  text,
  unique,
} from "./validation-primitives.js";

export function captureSources(value: unknown): RecordingProject["captureSources"] {
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

export function output(value: unknown): RecordingProject["output"] {
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

export function timeline(
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

export function presentation(value: unknown): RecordingProject["presentation"] {
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
