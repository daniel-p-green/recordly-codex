export type OutputParityProfile = "landscape-1080p" | "square-1080" | "vertical-1080";
export type OutputParityFormat = "gif" | "mp4";
export type OutputParityCheckpointKind = "opening" | "effect" | "final";

export type OutputParityAsset = {
  id: string;
  path: string;
  mediaType: "image/x-portable-pixmap";
  sha256: string;
};

export type OutputParityCheckpoint = {
  id: string;
  kind: OutputParityCheckpointKind;
  atOutputMs: number;
  assertions: string[];
};

export type OutputParityFixture = {
  id: string;
  profile: OutputParityProfile;
  output: { width: number; height: number; fps: 30 | 60; format: OutputParityFormat };
  sourceAssetId: string;
  requiredEffects: string[];
  decodedCheckpoints: OutputParityCheckpoint[];
};

export type OutputParityFixtureManifest = {
  schemaVersion: 1;
  kind: "recordly-codex-output-parity-fixture-manifest";
  suite: "output-parity-v1";
  description: string;
  outputParityDefinition: string;
  renderAcceptance: {
    durationMs: number;
    durationToleranceMs: number;
    checkpointToleranceMs: number;
    codec: { channelTolerance: number; minimumDominance: number };
  };
  provenance: {
    origin: "independently-authored-sanitized";
    recordlyMaterial: "none";
    assetPolicy: "repository-owned-minimal-fixtures";
  };
  exclusions: string[];
  assets: OutputParityAsset[];
  fixtures: OutputParityFixture[];
};

export function validateOutputParityFixtureManifest(
  manifestPath?: string,
): Promise<OutputParityFixtureManifest>;
