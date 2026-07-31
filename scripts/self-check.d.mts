export type VersionEvaluation = {
  ok: boolean;
  version: string;
  requirement: string;
};

export type MediaEvaluation = {
  ok: boolean;
  ffmpegVersion: string;
  ffprobeVersion: string;
  requirement: string;
};

export function parseSemanticVersion(value: string): {
  major: number;
  minor: number;
  patch: number;
};
export function evaluateNodeVersion(value: string): VersionEvaluation;
export function evaluateMediaVersions(ffmpegOutput: string, ffprobeOutput: string): MediaEvaluation;
export function runSelfCheck(options?: { artifactRoot?: string }): Promise<Record<string, unknown>>;
