import type { ProjectRenderInput } from "../project/index.js";
import { buildClipSchedule, presentationTimeForSource } from "./timeline-mapping.js";

/**
 * Deterministic presentation planning. This module is intentionally independent
 * of capture paths, browser APIs, and user supplied code: it turns a sanitized
 * project snapshot into values an encoder can consume.
 */

export type RenderProfile = "landscape" | "square" | "vertical";
export type RenderFormat = "mp4" | "gif";
export type CursorState = "default" | "pressed";
export type RenderHook = "safe-title-card" | "safe-end-card" | "focus-ring";

export type CompositionPoint = { x: number; y: number };
export type CursorSample = CompositionPoint & { tUs: number; state: CursorState };
export type ClickSample = CompositionPoint & { tUs: number; button: 0 | 1 | 2 };
export type SourceCursorSample = CompositionPoint & {
  sourceId: string;
  sourceTimeUs: number;
  state: CursorState;
};
export type SourceClickSample = CompositionPoint & {
  sourceId: string;
  sourceTimeUs: number;
};
export type ZoomRegion = CompositionPoint & {
  id: string;
  tUs: number;
  clipId?: string;
  scale?: number;
  startUs?: number;
  endUs?: number;
  mode?: "automatic" | "manual";
  easing?: "linear" | "ease-in-out" | "ease-out";
};
export type Caption = {
  id: string;
  clipId?: string;
  timeDomain?: "clip-source-relative";
  startUs: number;
  endUs: number;
  text: string;
};
export type Annotation = Caption & {
  kind: "label" | "highlight" | "arrow";
  x: number;
  y: number;
  style?: "default" | "emphasis";
};
export type SourceClip = {
  id: string;
  startUs: number;
  endUs: number;
  sourceId?: string;
  speedRegions?: readonly {
    startUs: number;
    endUs: number;
    startRate: number;
    endRate: number;
  }[];
  transitionAfter?: { kind: "cut" | "crossfade"; durationUs: number };
};

export type ReviewedTransition = {
  clipId: string;
  family:
    | "cut"
    | "crossfade"
    | "dip-to-color"
    | "wipe-left"
    | "wipe-right"
    | "slide-left"
    | "slide-right";
  durationUs: number;
  easing: "linear" | "ease-in-out" | "ease-out";
  color?: string;
};

export type VisualTrack = {
  id: string;
  mediaId: string;
  media: {
    kind: "image" | "video";
    durationUs: number;
    width?: number;
    height?: number;
  };
  clipId: string;
  startUs: number;
  endUs: number;
  mediaTrim: { startUs: number; endUs: number };
  sync: "source-time" | "output-time";
  layout: {
    position: "top-left" | "top-right" | "bottom-left" | "bottom-right";
    scale: number;
    fit: "contain" | "cover";
    crop: "none" | { x: number; y: number; width: number; height: number };
    opacity: number;
    radiusPx: number;
    border: "none" | "light" | "strong";
  };
  motion: { preset: "none" | "fade" | "pop"; durationUs: number };
};

export type CompositionSource = {
  width: number;
  height: number;
  fps: number;
  durationUs: number;
};
export type CompositionSourceGeometry = {
  id: string;
  width: number;
  height: number;
  durationUs: number;
};

export type CompositionInput = {
  schemaVersion: 1;
  source: CompositionSource;
  sourceGeometries?: readonly CompositionSourceGeometry[];
  clips: readonly SourceClip[];
  preset?: string;
  profile?: RenderProfile;
  format?: RenderFormat;
  cursorTrack?: readonly CursorSample[];
  cursorVisible?: boolean;
  clickTrack?: readonly ClickSample[];
  zoomRegions?: readonly ZoomRegion[];
  /** V2 reviewed proposals may request up to 4x; the V1 public default remains 2x. */
  maxZoomScale?: 2 | 4;
  captions?: readonly Caption[];
  annotations?: readonly Annotation[];
  audioTracks?: readonly {
    assetId: string;
    sha256: string;
    startUs: number;
    trim?: { startUs: number; endUs: number };
    gainDb?: number;
  }[];
  pipTracks?: readonly {
    assetId: string;
    sha256: string;
    clipId?: string;
    startUs: number;
    endUs: number;
    corner?: "top-left" | "top-right" | "bottom-left" | "bottom-right";
    scale?: number;
  }[];
  hooks?: readonly string[];
  frame?: {
    background: ResolvedRenderStyle["background"];
    padding: number;
    radius: number;
    shadow: "none" | "soft" | "strong";
  };
  /**
   * V2-only presentation controls. V1 callers omit this field and retain the
   * original composition recipe exactly.
   */
  presentationControls?: PresentationControls;
};

export type PresentationControls = {
  cursor: { emphasis: "none" | "spotlight" | "trail"; trailDurationUs: number };
  frame: { fit: "contain" | "cover"; border: "none" | "subtle" | "strong" };
  export: {
    audio: "include" | "mute";
    colorRange: "limited";
    metadata: "none" | "minimal";
  };
};

export type ResolvedRenderStyle = {
  background: { kind: "solid"; color: string } | { kind: "gradient"; from: string; to: string };
  padding: number;
  radius: number;
  shadow: { opacity: number; blur: number; offsetY: number };
  cursor: {
    size: number;
    smoothing: number;
    clickColor: string;
    clickEffect: "none" | "ripple" | "bounce";
  };
  zoom: { scale: number; windowUs: number };
};

export type PresentationSegment = {
  sourceStartUs: number;
  sourceEndUs: number;
  presentationStartUs: number;
  speed: number;
};

export type PresentationTimeline = { durationUs: number; segments: PresentationSegment[] };

export type CompositionPlan = {
  schemaVersion: 1;
  output: {
    format: RenderFormat;
    width: number;
    height: number;
    fps: number;
    quality: "draft" | "standard" | "high";
  };
  style: ResolvedRenderStyle;
  sourceGeometries: CompositionSourceGeometry[];
  clips: SourceClip[];
  /** Present only for a validated V2 project. V1 keeps its legacy compositor path. */
  reviewedTransitions?: ReviewedTransition[];
  /** Path-free V2 overlay declarations; decoded sources are resolved separately by media ID. */
  visualTracks?: VisualTrack[];
  captions: Caption[];
  annotations: Annotation[];
  audioTracks: Array<{
    assetId: string;
    sha256: string;
    startUs: number;
    trim?: { startUs: number; endUs: number };
    gainDb: number;
  }>;
  pipTracks: Array<{
    assetId: string;
    sha256: string;
    clipId?: string;
    startUs: number;
    endUs: number;
    corner: "top-left" | "top-right" | "bottom-left" | "bottom-right";
    scale: number;
  }>;
  hooks: RenderHook[];
  /** Defined only for validated V2 input. Its absence is the V1 compatibility boundary. */
  presentationControls?: PresentationControls;
  cursorVisible: boolean;
  clickEffects: Array<
    CompositionPoint & {
      clipId?: string;
      startUs: number;
      durationUs: number;
      color: string;
      kind: "ripple" | "bounce";
    }
  >;
  cursorAt: (tUs: number) => CursorSample | undefined;
  cursorAtSource?: (sourceId: string, sourceTimeUs: number) => CursorSample | undefined;
  /** Bounded observed-only samples for an optional V2 cursor trail. */
  cursorHistoryAt?: (tUs: number, durationUs: number) => readonly CursorSample[];
  cursorHistoryAtSource?: (
    sourceId: string,
    sourceTimeUs: number,
    durationUs: number,
  ) => readonly CursorSample[];
  zoomAt: (
    tUs: number,
    clipId?: string,
    clipSourceTimeUs?: number,
  ) => (CompositionPoint & { scale: number }) | undefined;
};

const profiles: Record<RenderProfile, { width: number; height: number }> = {
  landscape: { width: 1920, height: 1080 },
  square: { width: 1080, height: 1080 },
  vertical: { width: 1080, height: 1920 },
};

const presets = {
  studio: {
    background: { kind: "gradient", from: "#0f172a", to: "#1e3a8a" },
    padding: 64,
    radius: 28,
    shadow: { opacity: 0.32, blur: 36, offsetY: 18 },
    cursor: { size: 1.2, smoothing: 0.82, clickColor: "#fb7185", clickEffect: "ripple" },
    zoom: { scale: 1.16, windowUs: 600_000 },
  },
  minimal: {
    background: { kind: "solid", color: "#f8fafc" },
    padding: 40,
    radius: 18,
    shadow: { opacity: 0.18, blur: 20, offsetY: 10 },
    cursor: { size: 1, smoothing: 0.72, clickColor: "#2563eb", clickEffect: "ripple" },
    zoom: { scale: 1.1, windowUs: 450_000 },
  },
  social: {
    background: { kind: "gradient", from: "#312e81", to: "#be123c" },
    padding: 72,
    radius: 32,
    shadow: { opacity: 0.4, blur: 44, offsetY: 20 },
    cursor: { size: 1.28, smoothing: 0.86, clickColor: "#fbbf24", clickEffect: "ripple" },
    zoom: { scale: 1.2, windowUs: 700_000 },
  },
} as const satisfies Record<string, ResolvedRenderStyle>;

const renderHooks = new Set<RenderHook>(["safe-title-card", "safe-end-card", "focus-ring"]);

function finite(value: number, label: string, minimum = 0): void {
  if (!Number.isFinite(value) || value < minimum) throw new RangeError(`${label} must be finite`);
}

function boundedId(value: string, label: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u.test(value)) {
    throw new RangeError(`${label} must be a bounded identifier`);
  }
}

function singleLineText(value: string, label: string): void {
  const hasControl = [...value].some((character) => {
    const code = character.charCodeAt(0);
    return code <= 31 || code === 127;
  });
  if (value.length === 0 || value.length > 240 || hasControl) {
    throw new RangeError(`${label} must be non-empty, bounded single line text`);
  }
}

function validColor(value: string, label: string): void {
  if (!/^#[0-9a-f]{6}$/iu.test(value)) throw new RangeError(`${label} must be a #rrggbb color`);
}

function sorted<T extends { tUs: number }>(samples: readonly T[], label: string): T[] {
  const values = [...samples];
  for (let index = 0; index < values.length; index += 1) {
    const sample = values[index] as T;
    finite(sample.tUs, `${label} timestamp`);
    if (index > 0 && sample.tUs <= (values[index - 1] as T).tUs) {
      throw new RangeError(`${label} timestamps must be strictly increasing`);
    }
  }
  return values;
}

function smoothstep(value: number): number {
  const clamped = Math.min(1, Math.max(0, value));
  return clamped * clamped * (3 - 2 * clamped);
}

function interpolateCursor(
  samples: readonly CursorSample[],
  tUs: number,
  smoothed = true,
): CursorSample | undefined {
  if (samples.length === 0) return undefined;
  if (tUs <= (samples[0] as CursorSample).tUs) return samples[0];
  const final = samples.at(-1) as CursorSample;
  if (tUs >= final.tUs) return final;
  for (let index = 1; index < samples.length; index += 1) {
    const next = samples[index] as CursorSample;
    const previous = samples[index - 1] as CursorSample;
    if (tUs > next.tUs) continue;
    const raw = (tUs - previous.tUs) / (next.tUs - previous.tUs);
    const progress = smoothed ? smoothstep(raw) : raw;
    return {
      tUs,
      x: previous.x + (next.x - previous.x) * progress,
      y: previous.y + (next.y - previous.y) * progress,
      state: tUs < next.tUs ? previous.state : next.state,
    };
  }
  return final;
}

function zoomAt(
  regions: readonly ZoomRegion[],
  style: ResolvedRenderStyle,
  tUs: number,
  clipId?: string,
  clipSourceTimeUs?: number,
): (CompositionPoint & { scale: number }) | undefined {
  const clipRegions =
    clipId === undefined ? regions : regions.filter((region) => region.clipId === clipId);
  if (clipSourceTimeUs !== undefined) {
    const region = clipRegions.find(
      (candidate) =>
        candidate.startUs !== undefined &&
        candidate.endUs !== undefined &&
        clipSourceTimeUs >= candidate.startUs &&
        clipSourceTimeUs <= candidate.endUs,
    );
    if (region !== undefined) {
      const raw =
        (clipSourceTimeUs - (region.startUs as number)) /
        ((region.endUs as number) - (region.startUs as number));
      const eased =
        region.easing === "ease-out"
          ? 1 - (1 - raw) ** 2
          : region.easing === "ease-in-out"
            ? smoothstep(raw)
            : raw;
      const requestedScale = region.scale ?? style.zoom.scale;
      const automaticScale = 1 + (requestedScale - 1) * 0.85;
      const targetScale = region.mode === "automatic" ? automaticScale : requestedScale;
      return { x: region.x, y: region.y, scale: 1 + (targetScale - 1) * eased };
    }
    if (clipId !== undefined) return undefined;
  }
  let winner: ZoomRegion | undefined;
  let strength = 0;
  for (const region of regions) {
    const distance = Math.abs(tUs - region.tUs);
    if (distance > style.zoom.windowUs) continue;
    const candidateStrength = 1 - smoothstep(distance / style.zoom.windowUs);
    if (candidateStrength > strength) {
      winner = region;
      strength = candidateStrength;
    }
  }
  if (winner === undefined) return undefined;
  return {
    x: winner.x,
    y: winner.y,
    scale: 1 + ((winner.scale ?? style.zoom.scale) - 1) * strength,
  };
}

export function resolveRenderPreset(name: string | undefined): ResolvedRenderStyle {
  const presetName = name ?? "studio";
  if (!(presetName in presets)) throw new RangeError("render preset is not supported");
  const selected = presets[presetName as keyof typeof presets];
  if (selected === undefined) throw new RangeError("render preset is not supported");
  return structuredClone(selected);
}

export function resolveRenderHooks(hooks: readonly string[] | undefined): RenderHook[] {
  if (hooks === undefined) return [];
  const resolved: RenderHook[] = [];
  for (const hook of hooks) {
    if (!renderHooks.has(hook as RenderHook)) throw new RangeError("render hook is not supported");
    if (!resolved.includes(hook as RenderHook)) resolved.push(hook as RenderHook);
  }
  return resolved;
}

/** Maps long gaps after trusted actions to deterministic speed-up segments. */
export function mapPresentationTimeline(input: {
  durationUs: number;
  actions: readonly { tUs: number; sourceFrameId: number }[];
  maximumHoldUs: number;
  idleSpeed: number;
}): PresentationTimeline {
  finite(input.durationUs, "source duration");
  finite(input.maximumHoldUs, "maximum hold");
  if (!Number.isFinite(input.idleSpeed) || input.idleSpeed < 1 || input.idleSpeed > 16) {
    throw new RangeError("idle speed must be between 1 and 16");
  }
  const actions = sorted(input.actions, "action");
  if (actions.some((action) => action.tUs > input.durationUs)) {
    throw new RangeError("action timestamp exceeds source duration");
  }
  const segments: PresentationSegment[] = [];
  let sourceStartUs = 0;
  let presentationStartUs = 0;
  for (const action of actions) {
    const normalEndUs = Math.min(action.tUs, sourceStartUs + input.maximumHoldUs);
    if (normalEndUs > sourceStartUs) {
      segments.push({ sourceStartUs, sourceEndUs: normalEndUs, presentationStartUs, speed: 1 });
      presentationStartUs += normalEndUs - sourceStartUs;
    }
    if (action.tUs > normalEndUs) {
      segments.push({
        sourceStartUs: normalEndUs,
        sourceEndUs: action.tUs,
        presentationStartUs,
        speed: input.idleSpeed,
      });
      presentationStartUs += (action.tUs - normalEndUs) / input.idleSpeed;
    }
    sourceStartUs = action.tUs;
  }
  if (sourceStartUs < input.durationUs) {
    segments.push({
      sourceStartUs,
      sourceEndUs: input.durationUs,
      presentationStartUs,
      speed: 1,
    });
    presentationStartUs += input.durationUs - sourceStartUs;
  }
  return { durationUs: Math.round(presentationStartUs), segments };
}

function resolvePresentationControls(
  value: PresentationControls | undefined,
): PresentationControls | undefined {
  if (value === undefined) return undefined;
  const { cursor, frame, export: exportControls } = value;
  if (
    !["none", "spotlight", "trail"].includes(cursor.emphasis) ||
    !Number.isSafeInteger(cursor.trailDurationUs) ||
    cursor.trailDurationUs < 0 ||
    cursor.trailDurationUs > 1_000_000 ||
    (cursor.emphasis === "trail") !== cursor.trailDurationUs > 0 ||
    !["contain", "cover"].includes(frame.fit) ||
    !["none", "subtle", "strong"].includes(frame.border) ||
    !["include", "mute"].includes(exportControls.audio) ||
    exportControls.colorRange !== "limited" ||
    !["none", "minimal"].includes(exportControls.metadata)
  ) {
    throw new RangeError("presentation controls are invalid");
  }
  return structuredClone(value);
}

function boundedCursorHistory(
  values: readonly CursorSample[],
  sourceTimeUs: number,
  durationUs: number,
): readonly CursorSample[] {
  if (!Number.isSafeInteger(sourceTimeUs) || !Number.isSafeInteger(durationUs) || durationUs < 1)
    return [];
  const earliest = sourceTimeUs - durationUs;
  const matching = values.filter((sample) => sample.tUs >= earliest && sample.tUs <= sourceTimeUs);
  // A trail is a visual accent, not an unbounded evidence cache. Keep the most
  // recent observed samples in their original deterministic order.
  return matching.slice(-96);
}

export function buildCompositionPlan(input: CompositionInput): CompositionPlan {
  if (input.schemaVersion !== 1) throw new RangeError("composition schema is unsupported");
  finite(input.source.width, "source width", 1);
  finite(input.source.height, "source height", 1);
  finite(input.source.fps, "source fps", 1);
  finite(input.source.durationUs, "source duration");
  const sourceGeometries = [...(input.sourceGeometries ?? [])];
  const geometryById = new Map(sourceGeometries.map((source) => [source.id, source]));
  for (const geometry of sourceGeometries) {
    boundedId(geometry.id, "source ID");
    finite(geometry.width, "source width", 1);
    finite(geometry.height, "source height", 1);
    finite(geometry.durationUs, "source duration");
  }
  const clips = [...input.clips];
  if (clips.length === 0) throw new RangeError("composition requires at least one clip");
  for (const clip of clips) {
    boundedId(clip.id, "clip ID");
    finite(clip.startUs, "clip start");
    finite(clip.endUs, "clip end", 1);
    const sourceDurationUs =
      clip.sourceId === undefined
        ? input.source.durationUs
        : (geometryById.get(clip.sourceId)?.durationUs ?? input.source.durationUs);
    if (
      sourceDurationUs === undefined ||
      clip.endUs <= clip.startUs ||
      clip.endUs > sourceDurationUs
    ) {
      throw new RangeError("clips must have valid ranges inside the source duration");
    }
    if (clip.sourceId !== undefined) boundedId(clip.sourceId, "clip source ID");
    for (const region of clip.speedRegions ?? []) {
      finite(region.startUs, "speed region start");
      finite(region.endUs, "speed region end", 1);
      if (
        region.startUs < clip.startUs ||
        region.endUs > clip.endUs ||
        region.endUs <= region.startUs ||
        region.startRate < 0.1 ||
        region.startRate > 16 ||
        region.endRate < 0.1 ||
        region.endRate > 16
      ) {
        throw new RangeError("speed region is invalid");
      }
    }
  }
  const style = resolveRenderPreset(input.preset);
  if (input.frame !== undefined) {
    if (input.frame.background.kind === "solid")
      validColor(input.frame.background.color, "background");
    else {
      validColor(input.frame.background.from, "gradient start");
      validColor(input.frame.background.to, "gradient end");
    }
    finite(input.frame.padding, "frame padding");
    finite(input.frame.radius, "frame radius");
    style.background = structuredClone(input.frame.background);
    style.padding = input.frame.padding;
    style.radius = input.frame.radius;
    style.shadow =
      input.frame.shadow === "none"
        ? { opacity: 0, blur: 0, offsetY: 0 }
        : input.frame.shadow === "soft"
          ? { opacity: 0.18, blur: 20, offsetY: 10 }
          : { opacity: 0.4, blur: 44, offsetY: 20 };
  }
  const cursorTrack = sorted(input.cursorTrack ?? [], "cursor");
  for (const cursor of cursorTrack) {
    finite(cursor.x, "cursor x", -1_000_000);
    finite(cursor.y, "cursor y", -1_000_000);
    if (cursor.state !== "default" && cursor.state !== "pressed")
      throw new RangeError("cursor state");
  }
  const clickTrack = sorted(input.clickTrack ?? [], "click");
  for (const click of clickTrack) {
    finite(click.x, "click x", -1_000_000);
    finite(click.y, "click y", -1_000_000);
    if (click.button !== 0 && click.button !== 1 && click.button !== 2)
      throw new RangeError("click button");
  }
  const maxZoomScale = input.maxZoomScale ?? 2;
  const zoomRegions = sorted(input.zoomRegions ?? [], "zoom region");
  for (const region of zoomRegions) {
    boundedId(region.id, "zoom region ID");
    finite(region.x, "zoom x", -1_000_000);
    finite(region.y, "zoom y", -1_000_000);
    if (region.scale !== undefined && (region.scale < 1 || region.scale > maxZoomScale)) {
      throw new RangeError(`zoom scale must be between 1 and ${maxZoomScale}`);
    }
  }
  const validateOverlay = (overlay: Caption | Annotation, label: string): void => {
    boundedId(overlay.id, `${label} ID`);
    finite(overlay.startUs, `${label} start`);
    finite(overlay.endUs, `${label} end`, 1);
    if (overlay.endUs <= overlay.startUs || overlay.endUs > input.source.durationUs) {
      throw new RangeError(`${label} timing is invalid`);
    }
    singleLineText(overlay.text, `${label} text`);
  };
  const captions = [...(input.captions ?? [])];
  for (const caption of captions) validateOverlay(caption, "caption");
  const annotations = [...(input.annotations ?? [])];
  annotations.forEach((annotation) => {
    validateOverlay(annotation, "annotation");
    finite(annotation.x, "annotation x", -1_000_000);
    finite(annotation.y, "annotation y", -1_000_000);
  });
  const audioTracks = (input.audioTracks ?? []).map((track) => {
    boundedId(track.assetId, "audio asset ID");
    if (!/^[0-9a-f]{64}$/u.test(track.sha256)) throw new RangeError("audio digest is invalid");
    finite(track.startUs, "audio start");
    const gainDb = track.gainDb ?? 0;
    if (!Number.isFinite(gainDb) || gainDb < -48 || gainDb > 24) throw new RangeError("audio gain");
    return { ...track, gainDb };
  });
  const pipTracks = (input.pipTracks ?? []).map((track) => {
    boundedId(track.assetId, "PiP asset ID");
    if (!/^[0-9a-f]{64}$/u.test(track.sha256)) throw new RangeError("PiP digest is invalid");
    finite(track.startUs, "PiP start");
    finite(track.endUs, "PiP end", 1);
    if (track.endUs <= track.startUs || track.endUs > input.source.durationUs) {
      throw new RangeError("PiP timing is invalid");
    }
    return { ...track, corner: track.corner ?? "bottom-right", scale: track.scale ?? 0.25 };
  });
  const profile = input.profile ?? "landscape";
  const output = {
    format: input.format ?? "mp4",
    ...profiles[profile],
    fps: Math.round(input.source.fps),
    quality: "standard" as const,
  };
  const presentationControls = resolvePresentationControls(input.presentationControls);
  const clickEffect = style.cursor.clickEffect;
  const clickEffects =
    clickEffect === "none"
      ? []
      : clickTrack.map((click) => ({
          x: click.x,
          y: click.y,
          startUs: click.tUs,
          durationUs: 450_000,
          color: style.cursor.clickColor,
          kind: clickEffect,
        }));
  return {
    schemaVersion: 1,
    output,
    style,
    sourceGeometries,
    clips,
    captions,
    annotations,
    audioTracks,
    pipTracks,
    hooks: resolveRenderHooks(input.hooks),
    ...(presentationControls === undefined ? {} : { presentationControls }),
    cursorVisible: input.cursorVisible ?? true,
    clickEffects,
    cursorAt: (tUs) => interpolateCursor(cursorTrack, tUs, style.cursor.smoothing > 0),
    cursorHistoryAt: (tUs, durationUs) => boundedCursorHistory(cursorTrack, tUs, durationUs),
    zoomAt: (tUs, clipId, clipSourceTimeUs) =>
      zoomAt(zoomRegions, style, tUs, clipId, clipSourceTimeUs),
  };
}

/**
 * Adapts the path-free project contract into this renderer's neutral plan. The
 * media resolver owns asset lookup separately, so no local paths can enter a
 * persisted project or this deterministic planning boundary.
 */
export function buildCompositionPlanFromProject(
  input: ProjectRenderInput,
  evidence: {
    cursorTrack?: readonly SourceCursorSample[];
    clickTrack?: readonly SourceClickSample[];
  } = {},
): CompositionPlan {
  if (input.captureSources.length === 0) throw new RangeError("project has no capture sources");
  const sourceGeometries = input.captureSources.map((capture) => ({
    id: capture.id,
    width: capture.sourceWidth,
    height: capture.sourceHeight,
    durationUs: capture.durationUs,
  }));
  const sourceDurationUs = Math.max(...sourceGeometries.map((source) => source.durationUs));
  const profile: RenderProfile =
    input.output.profile === "vertical-1080"
      ? "vertical"
      : input.output.profile === "square-1080"
        ? "square"
        : "landscape";
  const projectHooks = input.renderHooks.map((hook) => {
    if (hook.permission !== "explicit-local-render-hook" || hook.status !== "declared") {
      throw new RangeError("project render hook is not permitted");
    }
    return hook.kind === "metadata" ? "safe-title-card" : "focus-ring";
  });
  const source = {
    width: sourceGeometries[0]?.width as number,
    height: sourceGeometries[0]?.height as number,
    fps: input.output.fps,
    durationUs: sourceDurationUs,
  };
  const clips: SourceClip[] = input.timeline.clips.map((clip) => ({
    id: clip.id,
    sourceId: clip.sourceId,
    startUs: clip.trim.startUs,
    endUs: clip.trim.endUs,
    speedRegions: clip.speedRegions,
    ...(clip.transitionAfter === undefined ? {} : { transitionAfter: clip.transitionAfter }),
  }));
  type V2ProjectExtensions = {
    presentationControls?: PresentationControls;
    media?: {
      assets?: readonly {
        id: string;
        kind: "audio" | "image" | "video";
        durationUs: number;
        width?: number;
        height?: number;
      }[];
    };
    visualTracks?: readonly Omit<VisualTrack, "media">[];
    timelineTransitions?: readonly ReviewedTransition[];
    zoomProposals?: readonly {
      id: string;
      clipId: string;
      sourceRange: { startUs: number; endUs: number };
      focus: { x: number; y: number };
      scale: number;
      easing: "linear" | "ease-in-out" | "ease-out";
      review: { status: "proposed" | "accepted" | "rejected" };
    }[];
  };
  const v2 = input as ProjectRenderInput & V2ProjectExtensions;
  const reviewedTransitions =
    Array.isArray(v2.timelineTransitions) &&
    Array.isArray(v2.zoomProposals) &&
    Array.isArray(v2.visualTracks) &&
    Array.isArray(v2.media?.assets)
      ? [...v2.timelineTransitions]
      : undefined;
  if (reviewedTransitions !== undefined && v2.presentationControls === undefined)
    throw new RangeError("V2 project presentation controls are unavailable");
  if (
    reviewedTransitions !== undefined &&
    v2.presentationControls?.cursor.emphasis !== "none" &&
    !input.presentation.cursor.visible
  ) {
    throw new RangeError("V2 cursor emphasis requires an observed visible cursor");
  }
  const visualTracks =
    reviewedTransitions === undefined
      ? undefined
      : (v2.visualTracks ?? []).map((track) => {
          const media = v2.media?.assets?.find((asset) => asset.id === track.mediaId);
          if (media === undefined || (media.kind !== "image" && media.kind !== "video"))
            throw new RangeError("visual track media is unavailable");
          return {
            ...track,
            media: {
              kind: media.kind,
              durationUs: media.durationUs,
              ...(media.width === undefined ? {} : { width: media.width }),
              ...(media.height === undefined ? {} : { height: media.height }),
            },
          };
        });
  const legacyZoomRegions = input.timeline.clips.flatMap((clip) => {
    const geometry = sourceGeometries.find((candidate) => candidate.id === clip.sourceId);
    if (geometry === undefined) throw new RangeError("zoom clip source is unavailable");
    return clip.zoomRegions.map((region) => ({
      id: region.id,
      tUs: Math.round((region.startUs + region.endUs) / 2),
      clipId: clip.id,
      x: region.focus.x * geometry.width,
      y: region.focus.y * geometry.height,
      scale: region.scale,
      startUs: region.startUs,
      endUs: region.endUs,
      mode: region.mode,
      easing: region.easing,
    }));
  });
  const zoomRegions =
    reviewedTransitions === undefined
      ? legacyZoomRegions
      : (v2.zoomProposals ?? [])
          .filter((proposal) => proposal.review.status === "accepted")
          .map((proposal) => {
            const clip = input.timeline.clips.find((candidate) => candidate.id === proposal.clipId);
            if (clip === undefined) throw new RangeError("reviewed zoom clip is unavailable");
            const geometry = sourceGeometries.find((candidate) => candidate.id === clip.sourceId);
            if (geometry === undefined) throw new RangeError("reviewed zoom source is unavailable");
            return {
              id: proposal.id,
              tUs: Math.round((proposal.sourceRange.startUs + proposal.sourceRange.endUs) / 2),
              clipId: proposal.clipId,
              x: proposal.focus.x * geometry.width,
              y: proposal.focus.y * geometry.height,
              scale: proposal.scale,
              startUs: proposal.sourceRange.startUs,
              endUs: proposal.sourceRange.endUs,
              mode: "manual" as const,
              easing: proposal.easing,
            };
          });
  const geometryForClip = (clipId: string): CompositionSourceGeometry => {
    const sourceId = input.timeline.clips.find((clip) => clip.id === clipId)?.sourceId;
    const geometry = sourceGeometries.find((candidate) => candidate.id === sourceId);
    if (geometry === undefined) throw new RangeError("overlay clip source is unavailable");
    return geometry;
  };
  const captions = input.overlays.captions.map((caption) => ({
    id: caption.id,
    clipId: caption.clipId,
    timeDomain: caption.timeDomain,
    startUs: caption.startUs,
    endUs: caption.endUs,
    text: caption.text.value,
  }));
  const annotations = input.overlays.annotations.map((annotation) => {
    const geometry = geometryForClip(annotation.clipId);
    return {
      id: annotation.id,
      clipId: annotation.clipId,
      timeDomain: annotation.timeDomain,
      startUs: annotation.startUs,
      endUs: annotation.endUs,
      text: annotation.text.value,
      kind: "label" as const,
      x: geometry.width / 2,
      y: annotation.position === "top" ? geometry.height * 0.14 : geometry.height * 0.86,
      style: annotation.style,
    };
  });
  const plan = buildCompositionPlan({
    schemaVersion: 1,
    source,
    sourceGeometries,
    clips,
    profile,
    format: input.output.format,
    zoomRegions,
    ...(reviewedTransitions === undefined ? {} : { maxZoomScale: 4 as const }),
    ...(reviewedTransitions === undefined ? {} : { presentationControls: v2.presentationControls }),
    cursorVisible: input.presentation.cursor.visible,
    captions,
    annotations,
    audioTracks: input.audioTracks.map((track) => ({
      assetId: track.asset.assetId,
      sha256: track.asset.sha256,
      startUs: track.startUs,
      trim: track.trim,
      gainDb: track.gainDb,
    })),
    pipTracks: input.pipTracks.map((track) => ({
      assetId: track.asset.assetId,
      sha256: track.asset.sha256,
      clipId: track.clipId,
      startUs: track.startUs,
      endUs: track.endUs,
      corner: track.position,
      scale: track.scale,
    })),
    hooks: projectHooks,
    frame: {
      background:
        input.presentation.frame.background.kind === "solid"
          ? { kind: "solid", color: input.presentation.frame.background.color }
          : {
              kind: "gradient",
              from: input.presentation.frame.background.startColor,
              to: input.presentation.frame.background.endColor,
            },
      padding: input.presentation.frame.paddingPx,
      radius: input.presentation.frame.radiusPx,
      shadow: input.presentation.frame.shadow,
    },
  });
  plan.style.cursor.size =
    (input.presentation.cursor.sizePx / 24) *
    (input.presentation.cursor.preset === "large" ? 1.45 : 1);
  plan.style.cursor.smoothing = input.presentation.cursor.motion === "smoothed" ? 0.82 : 0;
  plan.style.cursor.clickEffect = input.presentation.cursor.clickEffect;
  const projectClickEffect = input.presentation.cursor.clickEffect;
  if ((evidence.cursorTrack?.length ?? 0) > 10_000 || (evidence.clickTrack?.length ?? 0) > 10_000) {
    throw new RangeError("project presentation evidence exceeds its bound");
  }
  const geometryBySourceId = new Map(sourceGeometries.map((geometry) => [geometry.id, geometry]));
  const validateSourceEvidence = (
    sample: {
      sourceId: string;
      sourceTimeUs: number;
      x: number;
      y: number;
    },
    label: string,
  ): void => {
    const geometry = geometryBySourceId.get(sample.sourceId);
    if (geometry === undefined) throw new RangeError(`${label} source is unknown`);
    if (
      !Number.isSafeInteger(sample.sourceTimeUs) ||
      sample.sourceTimeUs < 0 ||
      sample.sourceTimeUs > geometry.durationUs ||
      !Number.isFinite(sample.x) ||
      !Number.isFinite(sample.y) ||
      sample.x < 0 ||
      sample.y < 0 ||
      sample.x > geometry.width ||
      sample.y > geometry.height
    ) {
      throw new RangeError(`${label} is outside its source bounds`);
    }
  };
  const cursorBySource = new Map<string, CursorSample[]>();
  for (const sample of evidence.cursorTrack ?? []) {
    validateSourceEvidence(sample, "cursor evidence");
    if (sample.state !== "default" && sample.state !== "pressed")
      throw new RangeError("cursor evidence state is invalid");
    const values = cursorBySource.get(sample.sourceId) ?? [];
    values.push({ tUs: sample.sourceTimeUs, x: sample.x, y: sample.y, state: sample.state });
    cursorBySource.set(sample.sourceId, values);
  }
  for (const [sourceId, values] of cursorBySource) {
    cursorBySource.set(sourceId, sorted(values, `cursor evidence for ${sourceId}`));
  }
  plan.cursorAtSource = (sourceId, sourceTimeUs) =>
    interpolateCursor(
      cursorBySource.get(sourceId) ?? [],
      sourceTimeUs,
      plan.style.cursor.smoothing > 0,
    );
  plan.cursorHistoryAtSource = (sourceId, sourceTimeUs, durationUs) =>
    boundedCursorHistory(cursorBySource.get(sourceId) ?? [], sourceTimeUs, durationUs);
  const schedule = buildClipSchedule(plan);
  plan.clickEffects =
    projectClickEffect === "none"
      ? []
      : (evidence.clickTrack ?? []).flatMap((sample) => {
          validateSourceEvidence(sample, "click evidence");
          return schedule
            .filter(
              ({ clip }) =>
                clip.sourceId === sample.sourceId &&
                sample.sourceTimeUs >= clip.startUs &&
                sample.sourceTimeUs <= clip.endUs,
            )
            .map((timing) => ({
              clipId: timing.clip.id,
              x: sample.x,
              y: sample.y,
              startUs: presentationTimeForSource(timing, sample.sourceTimeUs),
              durationUs: 450_000,
              color: plan.style.cursor.clickColor,
              kind: projectClickEffect,
            }));
        });
  if (input.presentation.cursor.visible && (evidence.cursorTrack?.length ?? 0) === 0)
    throw new RangeError("visible project cursor requires observed cursor evidence");
  if (input.presentation.cursor.clickEffect !== "none" && (evidence.clickTrack?.length ?? 0) === 0)
    throw new RangeError("project click effect requires observed click evidence");
  if (
    input.presentation.cursor.visible &&
    !(evidence.cursorTrack ?? []).some((sample) =>
      plan.clips.some(
        (clip) =>
          clip.sourceId === sample.sourceId &&
          sample.sourceTimeUs >= clip.startUs &&
          sample.sourceTimeUs <= clip.endUs,
      ),
    )
  ) {
    throw new RangeError("cursor evidence does not intersect a rendered clip");
  }
  if (projectClickEffect !== "none" && plan.clickEffects.length === 0) {
    throw new RangeError("click evidence does not intersect a rendered clip");
  }
  return {
    ...plan,
    ...(reviewedTransitions === undefined ? {} : { reviewedTransitions }),
    ...(visualTracks === undefined ? {} : { visualTracks }),
    output: { ...plan.output, quality: input.output.quality },
  };
}
