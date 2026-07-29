import { createHash } from "node:crypto";
import { canonicalJson } from "../manifest/canonical-json.js";
import {
  migrateV1RecordingProject,
  reviseRecordingProject,
  validateRecordingProject,
} from "./recording-project.js";
import type { RecordingProject, RecordingProjectV2 } from "./types.js";

type FrameBackground =
  | { kind: "solid"; color: string }
  | { kind: "gradient"; startColor: string; endColor: string };

type TransitionDefault =
  | { family: "cut"; durationUs: 0; easing: "linear" | "ease-in-out" | "ease-out" }
  | {
      family: "crossfade" | "wipe-left" | "wipe-right" | "slide-left" | "slide-right";
      durationUs: number;
      easing: "linear" | "ease-in-out" | "ease-out";
    }
  | {
      family: "dip-to-color";
      durationUs: number;
      easing: "linear" | "ease-in-out" | "ease-out";
      color: string;
    };

export type RecordingProfileSnapshot = {
  schemaVersion: 1;
  output: {
    profile: "landscape-1080p" | "square-1080" | "vertical-1080";
    format: "mp4" | "gif";
    quality: "draft" | "standard" | "high";
  };
  cursor: {
    visible: boolean;
    preset: "system" | "large";
    sizePx: number;
    motion: "source" | "smoothed";
    clickEffect: "none" | "ripple" | "bounce";
  };
  frame: {
    background: FrameBackground;
    paddingPx: number;
    radiusPx: number;
    shadow: "none" | "soft" | "strong";
  };
  defaultTransition: TransitionDefault;
  visualLayout: {
    position: "top-left" | "top-right" | "bottom-left" | "bottom-right";
    scale: number;
    fit: "contain" | "cover";
    crop: "none";
    opacity: number;
    radiusPx: number;
    border: "none" | "light" | "strong";
  };
  audioDefaults: {
    role: "primary" | "bed" | "effect";
    gainDb: number;
    fadeInUs: number;
    fadeOutUs: number;
    ducking: "none" | "against-primary";
  };
};

export type RecordingProfileReference = {
  source: "builtin" | "owner-local";
  profileId: string;
  profileRevision: number;
  snapshot: RecordingProfileSnapshot;
  snapshotSha256: string;
};

export type RecordingProfileApplicationMode = "manual" | "automated";

type Dictionary = Record<string, unknown>;

const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const colorPattern = /^#[a-f0-9]{6}$/iu;
const hashPattern = /^[a-f0-9]{64}$/u;
const outputProfiles = ["landscape-1080p", "square-1080", "vertical-1080"] as const;
const outputFormats = ["mp4", "gif"] as const;
const outputQualities = ["draft", "standard", "high"] as const;
const cursorPresets = ["system", "large"] as const;
const cursorMotions = ["source", "smoothed"] as const;
const clickEffects = ["none", "ripple", "bounce"] as const;
const shadows = ["none", "soft", "strong"] as const;
const transitionFamilies = [
  "cut",
  "crossfade",
  "dip-to-color",
  "wipe-left",
  "wipe-right",
  "slide-left",
  "slide-right",
] as const;
const easings = ["linear", "ease-in-out", "ease-out"] as const;
const positions = ["top-left", "top-right", "bottom-left", "bottom-right"] as const;
const fits = ["contain", "cover"] as const;
const borders = ["none", "light", "strong"] as const;
const audioRoles = ["primary", "bed", "effect"] as const;
const duckingModes = ["none", "against-primary"] as const;

function invalid(message: string): never {
  throw new RangeError(`invalid recording profile: ${message}`);
}

function object(value: unknown, location: string): Dictionary {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    invalid(`${location} must be an object`);
  return value as Dictionary;
}

function exact(value: Dictionary, keys: readonly string[], location: string): void {
  const actual = Reflect.ownKeys(value);
  if (
    actual.length !== keys.length ||
    actual.some((key) => typeof key !== "string" || !keys.includes(key)) ||
    keys.some((key) => !Object.hasOwn(value, key))
  ) {
    invalid(`${location} has unknown or missing fields`);
  }
}

function field(value: Dictionary, key: string): unknown {
  return value[key];
}

function oneOf<const T extends readonly string[]>(
  value: unknown,
  options: T,
  location: string,
): T[number] {
  if (typeof value !== "string" || !options.includes(value)) invalid(`${location} is unsupported`);
  return value as T[number];
}

function safeInteger(value: unknown, location: string, minimum: number, maximum: number): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  )
    invalid(`${location} is out of range`);
  return value;
}

function finiteNumber(value: unknown, location: string, minimum: number, maximum: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum)
    invalid(`${location} is out of range`);
  return value;
}

function hexColor(value: unknown, location: string): string {
  if (typeof value !== "string" || !colorPattern.test(value))
    invalid(`${location} must be hex color`);
  return value.toLowerCase();
}

function snapshotDigest(snapshot: RecordingProfileSnapshot): string {
  return createHash("sha256").update(canonicalJson(snapshot)).digest("hex");
}

function frameBackground(value: unknown): FrameBackground {
  const background = object(value, "snapshot.frame.background");
  const kind = oneOf(
    field(background, "kind"),
    ["solid", "gradient"] as const,
    "snapshot.frame.background.kind",
  );
  if (kind === "solid") {
    exact(background, ["kind", "color"], "snapshot.frame.background");
    return { kind, color: hexColor(field(background, "color"), "snapshot.frame.background.color") };
  }
  exact(background, ["kind", "startColor", "endColor"], "snapshot.frame.background");
  return {
    kind,
    startColor: hexColor(field(background, "startColor"), "snapshot.frame.background.startColor"),
    endColor: hexColor(field(background, "endColor"), "snapshot.frame.background.endColor"),
  };
}

function defaultTransition(value: unknown): TransitionDefault {
  const transition = object(value, "snapshot.defaultTransition");
  const family = oneOf(
    field(transition, "family"),
    transitionFamilies,
    "snapshot.defaultTransition.family",
  );
  const expectsColor = family === "dip-to-color";
  exact(
    transition,
    expectsColor ? ["family", "durationUs", "easing", "color"] : ["family", "durationUs", "easing"],
    "snapshot.defaultTransition",
  );
  const durationUs = safeInteger(
    field(transition, "durationUs"),
    "snapshot.defaultTransition.durationUs",
    0,
    2_000_000,
  );
  if ((family === "cut") !== (durationUs === 0))
    invalid("snapshot.defaultTransition has incompatible family and duration");
  const easing = oneOf(field(transition, "easing"), easings, "snapshot.defaultTransition.easing");
  if (family === "cut") return { family, durationUs: 0, easing };
  if (family === "dip-to-color") {
    return {
      family,
      durationUs,
      easing,
      color: hexColor(field(transition, "color"), "snapshot.defaultTransition.color"),
    };
  }
  return { family, durationUs, easing };
}

/** Strict, path-free profile snapshot validation that returns a normalized deep clone. */
export function validateRecordingProfileSnapshot(value: unknown): RecordingProfileSnapshot {
  const snapshot = object(value, "snapshot");
  exact(
    snapshot,
    [
      "schemaVersion",
      "output",
      "cursor",
      "frame",
      "defaultTransition",
      "visualLayout",
      "audioDefaults",
    ],
    "snapshot",
  );
  if (field(snapshot, "schemaVersion") !== 1) invalid("snapshot.schemaVersion is unsupported");

  const output = object(field(snapshot, "output"), "snapshot.output");
  exact(output, ["profile", "format", "quality"], "snapshot.output");
  const cursor = object(field(snapshot, "cursor"), "snapshot.cursor");
  exact(cursor, ["visible", "preset", "sizePx", "motion", "clickEffect"], "snapshot.cursor");
  if (typeof field(cursor, "visible") !== "boolean")
    invalid("snapshot.cursor.visible must be boolean");
  const frame = object(field(snapshot, "frame"), "snapshot.frame");
  exact(frame, ["background", "paddingPx", "radiusPx", "shadow"], "snapshot.frame");
  const visualLayout = object(field(snapshot, "visualLayout"), "snapshot.visualLayout");
  exact(
    visualLayout,
    ["position", "scale", "fit", "crop", "opacity", "radiusPx", "border"],
    "snapshot.visualLayout",
  );
  const audioDefaults = object(field(snapshot, "audioDefaults"), "snapshot.audioDefaults");
  exact(
    audioDefaults,
    ["role", "gainDb", "fadeInUs", "fadeOutUs", "ducking"],
    "snapshot.audioDefaults",
  );
  const role = oneOf(field(audioDefaults, "role"), audioRoles, "snapshot.audioDefaults.role");
  const ducking = oneOf(
    field(audioDefaults, "ducking"),
    duckingModes,
    "snapshot.audioDefaults.ducking",
  );
  if (role === "primary" && ducking !== "none")
    invalid("snapshot.audioDefaults.primary cannot duck against itself");

  return {
    schemaVersion: 1,
    output: {
      profile: oneOf(field(output, "profile"), outputProfiles, "snapshot.output.profile"),
      format: oneOf(field(output, "format"), outputFormats, "snapshot.output.format"),
      quality: oneOf(field(output, "quality"), outputQualities, "snapshot.output.quality"),
    },
    cursor: {
      visible: field(cursor, "visible") as boolean,
      preset: oneOf(field(cursor, "preset"), cursorPresets, "snapshot.cursor.preset"),
      sizePx: safeInteger(field(cursor, "sizePx"), "snapshot.cursor.sizePx", 12, 96),
      motion: oneOf(field(cursor, "motion"), cursorMotions, "snapshot.cursor.motion"),
      clickEffect: oneOf(field(cursor, "clickEffect"), clickEffects, "snapshot.cursor.clickEffect"),
    },
    frame: {
      background: frameBackground(field(frame, "background")),
      paddingPx: safeInteger(field(frame, "paddingPx"), "snapshot.frame.paddingPx", 0, 240),
      radiusPx: safeInteger(field(frame, "radiusPx"), "snapshot.frame.radiusPx", 0, 120),
      shadow: oneOf(field(frame, "shadow"), shadows, "snapshot.frame.shadow"),
    },
    defaultTransition: defaultTransition(field(snapshot, "defaultTransition")),
    visualLayout: {
      position: oneOf(field(visualLayout, "position"), positions, "snapshot.visualLayout.position"),
      scale: finiteNumber(field(visualLayout, "scale"), "snapshot.visualLayout.scale", 0.1, 0.6),
      fit: oneOf(field(visualLayout, "fit"), fits, "snapshot.visualLayout.fit"),
      crop: oneOf(field(visualLayout, "crop"), ["none"] as const, "snapshot.visualLayout.crop"),
      opacity: finiteNumber(
        field(visualLayout, "opacity"),
        "snapshot.visualLayout.opacity",
        0.1,
        1,
      ),
      radiusPx: safeInteger(
        field(visualLayout, "radiusPx"),
        "snapshot.visualLayout.radiusPx",
        0,
        120,
      ),
      border: oneOf(field(visualLayout, "border"), borders, "snapshot.visualLayout.border"),
    },
    audioDefaults: {
      role,
      gainDb: finiteNumber(
        field(audioDefaults, "gainDb"),
        "snapshot.audioDefaults.gainDb",
        -60,
        12,
      ),
      fadeInUs: safeInteger(
        field(audioDefaults, "fadeInUs"),
        "snapshot.audioDefaults.fadeInUs",
        0,
        2_000_000,
      ),
      fadeOutUs: safeInteger(
        field(audioDefaults, "fadeOutUs"),
        "snapshot.audioDefaults.fadeOutUs",
        0,
        2_000_000,
      ),
      ducking,
    },
  };
}

/** Hashes the canonical form of a validated snapshot, never arbitrary caller JSON. */
export function profileSnapshotSha256(snapshot: unknown): string {
  return snapshotDigest(validateRecordingProfileSnapshot(snapshot));
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function builtin(profileId: string, snapshot: RecordingProfileSnapshot): RecordingProfileReference {
  const validated = validateRecordingProfileSnapshot(snapshot);
  return deepFreeze({
    source: "builtin" as const,
    profileId,
    profileRevision: 1,
    snapshot: validated,
    snapshotSha256: snapshotDigest(validated),
  });
}

const BUILT_INS = deepFreeze([
  builtin("clean", {
    schemaVersion: 1,
    output: { profile: "landscape-1080p", format: "mp4", quality: "standard" },
    cursor: {
      visible: true,
      preset: "system",
      sizePx: 28,
      motion: "smoothed",
      clickEffect: "none",
    },
    frame: {
      background: { kind: "solid", color: "#111827" },
      paddingPx: 32,
      radiusPx: 16,
      shadow: "soft",
    },
    defaultTransition: { family: "cut", durationUs: 0, easing: "linear" },
    visualLayout: {
      position: "bottom-right",
      scale: 0.25,
      fit: "contain",
      crop: "none",
      opacity: 1,
      radiusPx: 0,
      border: "none",
    },
    audioDefaults: { role: "primary", gainDb: 0, fadeInUs: 0, fadeOutUs: 0, ducking: "none" },
  }),
  builtin("product", {
    schemaVersion: 1,
    output: { profile: "square-1080", format: "mp4", quality: "high" },
    cursor: {
      visible: true,
      preset: "system",
      sizePx: 32,
      motion: "smoothed",
      clickEffect: "ripple",
    },
    frame: {
      background: { kind: "gradient", startColor: "#111827", endColor: "#312e81" },
      paddingPx: 40,
      radiusPx: 24,
      shadow: "strong",
    },
    defaultTransition: { family: "crossfade", durationUs: 250_000, easing: "ease-in-out" },
    visualLayout: {
      position: "bottom-right",
      scale: 0.3,
      fit: "cover",
      crop: "none",
      opacity: 1,
      radiusPx: 16,
      border: "light",
    },
    audioDefaults: {
      role: "bed",
      gainDb: -18,
      fadeInUs: 200_000,
      fadeOutUs: 300_000,
      ducking: "against-primary",
    },
  }),
  builtin("spotlight", {
    schemaVersion: 1,
    output: { profile: "vertical-1080", format: "gif", quality: "high" },
    cursor: { visible: true, preset: "large", sizePx: 40, motion: "source", clickEffect: "bounce" },
    frame: {
      background: { kind: "solid", color: "#020617" },
      paddingPx: 40,
      radiusPx: 28,
      shadow: "strong",
    },
    defaultTransition: {
      family: "dip-to-color",
      durationUs: 300_000,
      easing: "ease-out",
      color: "#020617",
    },
    visualLayout: {
      position: "top-right",
      scale: 0.35,
      fit: "contain",
      crop: "none",
      opacity: 1,
      radiusPx: 20,
      border: "strong",
    },
    audioDefaults: {
      role: "effect",
      gainDb: -6,
      fadeInUs: 100_000,
      fadeOutUs: 100_000,
      ducking: "against-primary",
    },
  }),
] as RecordingProfileReference[]);

function sameBuiltin(reference: RecordingProfileReference): boolean {
  return BUILT_INS.some(
    (candidate) =>
      candidate.profileId === reference.profileId &&
      candidate.profileRevision === reference.profileRevision &&
      candidate.snapshotSha256 === reference.snapshotSha256 &&
      canonicalJson(candidate.snapshot) === canonicalJson(reference.snapshot),
  );
}

/** Validates a strict profile reference and rejects any forged built-in identity. */
export function validateRecordingProfileReference(value: unknown): RecordingProfileReference {
  const reference = object(value, "profile reference");
  exact(
    reference,
    ["source", "profileId", "profileRevision", "snapshot", "snapshotSha256"],
    "profile reference",
  );
  const source = oneOf(
    field(reference, "source"),
    ["builtin", "owner-local"] as const,
    "profile reference.source",
  );
  const profileId = field(reference, "profileId");
  if (typeof profileId !== "string" || !identifierPattern.test(profileId))
    invalid("profile reference.profileId is invalid");
  const profileRevision = safeInteger(
    field(reference, "profileRevision"),
    "profile reference.profileRevision",
    1,
    Number.MAX_SAFE_INTEGER,
  );
  const snapshot = validateRecordingProfileSnapshot(field(reference, "snapshot"));
  const suppliedDigest = field(reference, "snapshotSha256");
  if (typeof suppliedDigest !== "string" || !hashPattern.test(suppliedDigest))
    invalid("profile reference.snapshotSha256 is invalid");
  const snapshotSha256 = suppliedDigest.toLowerCase();
  if (snapshotDigest(snapshot) !== snapshotSha256)
    invalid("profile reference snapshot digest does not match");
  const parsed = { source, profileId, profileRevision, snapshot, snapshotSha256 };
  if (source === "builtin" && !sameBuiltin(parsed))
    invalid("builtin profile reference does not match");
  return parsed;
}

/** Returns validated deep clones, so callers cannot mutate the immutable built-in catalog. */
export function builtInRecordingProfiles(): readonly RecordingProfileReference[] {
  return BUILT_INS.map((profile) => validateRecordingProfileReference(profile));
}

function outputDimensions(profile: RecordingProfileSnapshot["output"]["profile"]): {
  width: 1920 | 1080;
  height: 1920 | 1080;
} {
  if (profile === "landscape-1080p") return { width: 1920, height: 1080 };
  if (profile === "square-1080") return { width: 1080, height: 1080 };
  return { width: 1080, height: 1920 };
}

/** Applies a profile as one explicit editorial revision without rewriting existing visual or audio content. */
export function applyRecordingProfile(
  currentValue: RecordingProject,
  targetValue: RecordingProfileReference,
  mode: RecordingProfileApplicationMode = "manual",
): RecordingProjectV2 {
  const current = validateRecordingProject(currentValue);
  const target = validateRecordingProfileReference(targetValue);
  const base = current.schemaVersion === 1 ? migrateV1RecordingProject(current) : current;
  if (target.snapshot.output.format === "gif" && base.audioTracks.length > 0)
    invalid("GIF profiles cannot be applied to projects with audio tracks");
  const dimensions = outputDimensions(target.snapshot.output.profile);
  const defaultTransition = target.snapshot.defaultTransition;
  const clips = base.timeline.clips.map((clip, index, entries) => {
    const isLast = index === entries.length - 1;
    return {
      ...clip,
      transitionAfter: isLast
        ? { kind: "cut" as const, durationUs: 0 }
        : {
            kind: defaultTransition.family === "cut" ? ("cut" as const) : ("crossfade" as const),
            durationUs: defaultTransition.durationUs,
          },
    };
  });
  const timelineTransitions = clips.map((clip, index, entries) => {
    const isLast = index === entries.length - 1;
    if (isLast)
      return { clipId: clip.id, family: "cut" as const, durationUs: 0, easing: "linear" as const };
    return {
      clipId: clip.id,
      family: defaultTransition.family,
      durationUs: defaultTransition.durationUs,
      easing: defaultTransition.easing,
      ...(defaultTransition.family === "dip-to-color" ? { color: defaultTransition.color } : {}),
    };
  });
  const next: RecordingProjectV2 = {
    ...base,
    revision: base.revision + 1,
    revisionPolicy:
      mode === "automated"
        ? {
            ...base.revisionPolicy,
            automatedRevisionCount: base.revisionPolicy.automatedRevisionCount + 1,
          }
        : base.revisionPolicy,
    profile: target,
    output: {
      ...base.output,
      ...dimensions,
      profile: target.snapshot.output.profile,
      format: target.snapshot.output.format,
      quality: target.snapshot.output.quality,
    },
    timeline: { clips },
    timelineTransitions,
    visualTracks: base.visualTracks.map((track) => ({
      ...track,
      layout: { ...track.layout, ...target.snapshot.visualLayout },
    })),
    audioTracks: base.audioTracks.map((track) => ({
      ...track,
      gainDb: target.snapshot.audioDefaults.gainDb,
    })),
    audioMix: {
      tracks: base.audioMix.tracks.map((track, index) => {
        const retainPrimary = index === 0 && target.snapshot.audioDefaults.role !== "primary";
        return {
          ...track,
          role: retainPrimary ? ("primary" as const) : target.snapshot.audioDefaults.role,
          fadeInUs: target.snapshot.audioDefaults.fadeInUs,
          fadeOutUs: target.snapshot.audioDefaults.fadeOutUs,
          ducking: retainPrimary ? ("none" as const) : target.snapshot.audioDefaults.ducking,
        };
      }),
    },
    presentation: {
      cursor: target.snapshot.cursor,
      frame: target.snapshot.frame,
    },
  };
  const revised = reviseRecordingProject(base, next, mode);
  if (revised.schemaVersion !== 2) throw new Error("profile application did not produce V2");
  return revised;
}
