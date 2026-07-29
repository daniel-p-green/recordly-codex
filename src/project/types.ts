export type ProjectAssetReference = {
  assetId: string;
  sha256: string;
};

export type ProjectCaptureSource = {
  id: string;
  sessionId: string;
  manifestSha256: string;
  timelineSha256: string;
  frameSetSha256: string;
  /** Geometry from the sealed capture, never inferred from the delivery profile. */
  sourceWidth: number;
  sourceHeight: number;
  durationUs: number;
};

/** Text is authored editorial copy, never text extracted from the captured page. */
export type AuthoredProjectText = {
  value: string;
  provenance: "authored";
  exportDisposition: "allow" | "redact";
};

export type RecordingProjectV1 = {
  schemaVersion: 1;
  projectId: string;
  revision: number;
  revisionPolicy: {
    automatedRevisionLimit: number;
    automatedRevisionCount: number;
  };
  captureSources: ProjectCaptureSource[];
  output: {
    profile: "landscape-1080p" | "square-1080" | "vertical-1080";
    width: 1920 | 1080;
    height: 1920 | 1080;
    fps: 30 | 60;
    format: "mp4" | "gif";
    quality: "draft" | "standard" | "high";
  };
  timeline: {
    clips: Array<{
      id: string;
      sourceId: string;
      trim: { startUs: number; endUs: number };
      speedRegions: Array<{ startUs: number; endUs: number; startRate: number; endRate: number }>;
      zoomRegions: Array<{
        id: string;
        startUs: number;
        endUs: number;
        mode: "automatic" | "manual";
        focus: { x: number; y: number };
        scale: number;
        easing: "linear" | "ease-in-out" | "ease-out";
      }>;
      transitionAfter?: { kind: "cut" | "crossfade"; durationUs: number };
    }>;
  };
  presentation: {
    cursor: {
      visible: boolean;
      preset: "system" | "large";
      sizePx: number;
      motion: "source" | "smoothed";
      clickEffect: "none" | "ripple" | "bounce";
    };
    frame: {
      background:
        | { kind: "solid"; color: string }
        | { kind: "gradient"; startColor: string; endColor: string };
      paddingPx: number;
      radiusPx: number;
      shadow: "none" | "soft" | "strong";
    };
  };
  overlays: {
    annotations: Array<{
      id: string;
      clipId: string;
      /** Times are relative to the selected clip's source-time trim. */
      timeDomain: "clip-source-relative";
      startUs: number;
      endUs: number;
      text: AuthoredProjectText;
      position: "top" | "bottom";
      style: "default" | "emphasis";
    }>;
    captions: Array<{
      id: string;
      clipId: string;
      /** Times are relative to the selected clip's source-time trim. */
      timeDomain: "clip-source-relative";
      startUs: number;
      endUs: number;
      text: AuthoredProjectText;
    }>;
  };
  audioTracks: Array<{
    id: string;
    asset: ProjectAssetReference;
    /** Placement is in the assembled project output timeline. */
    timeDomain: "project-output-relative";
    startUs: number;
    trim: { startUs: number; endUs: number };
    gainDb: number;
  }>;
  pipTracks: Array<{
    id: string;
    asset: ProjectAssetReference;
    clipId: string;
    /** Times are relative to the selected clip's source-time trim. */
    timeDomain: "clip-source-relative";
    startUs: number;
    endUs: number;
    position: "top-left" | "top-right" | "bottom-left" | "bottom-right";
    scale: number;
  }>;
  renderHooks: Array<{
    id: string;
    kind: "metadata" | "watermark";
    permission: "explicit-local-render-hook";
    status: "declared";
  }>;
  preview:
    | { status: "not-requested" }
    | { status: "ready" | "stale" | "rendered"; revision: number };
};

export type ProjectMediaAsset =
  | {
      id: string;
      sha256: string;
      kind: "audio" | "image";
      provenance: "legacy-declared" | "explicit-local-import";
      durationUs: number;
    }
  | {
      id: string;
      sha256: string;
      kind: "video";
      provenance: "explicit-local-import";
      durationUs: number;
      width: number;
      height: number;
      fps: number;
    };

/**
 * V2 retains V1's executable fields until the renderer consumes the new media
 * contract. The extra fields are declarative, path-free, and strict so a
 * later renderer can add support without a second persistence migration.
 */
export type RecordingProjectV2 = Omit<RecordingProjectV1, "schemaVersion"> & {
  schemaVersion: 2;
  profile: import("./recording-profile.js").RecordingProfileReference;
  media: { assets: ProjectMediaAsset[] };
  visualTracks: Array<{
    id: string;
    mediaId: string;
    clipId: string;
    timeDomain: "clip-source-relative";
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
  }>;
  timelineTransitions: Array<{
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
  }>;
  zoomProposals: Array<{
    id: string;
    clipId: string;
    sourceRange: { startUs: number; endUs: number };
    focus: { x: number; y: number };
    scale: number;
    easing: "linear" | "ease-in-out" | "ease-out";
    review: {
      status: "proposed" | "accepted" | "rejected";
      basis: "observed-input" | "manual";
    };
  }>;
  presentationControls: {
    cursor: { emphasis: "none" | "spotlight" | "trail"; trailDurationUs: number };
    frame: { fit: "contain" | "cover"; border: "none" | "subtle" | "strong" };
    export: {
      audio: "include" | "mute";
      colorRange: "limited";
      metadata: "none" | "minimal";
    };
  };
  audioMix: {
    tracks: Array<{
      trackId: string;
      mediaId: string;
      role: "primary" | "bed" | "effect";
      pan: number;
      fadeInUs: number;
      fadeOutUs: number;
      ducking: "none" | "against-primary";
    }>;
  };
};

export type RecordingProject = RecordingProjectV1 | RecordingProjectV2;

/** Stable, path-free input a renderer may consume without access to capture storage. */
export type ProjectRenderInput = Omit<RecordingProject, "schemaVersion" | "preview">;
