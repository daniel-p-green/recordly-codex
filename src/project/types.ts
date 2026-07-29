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

export type RecordingProject = {
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

/** Stable, path-free input a renderer may consume without access to capture storage. */
export type ProjectRenderInput = Omit<RecordingProject, "schemaVersion" | "preview">;
