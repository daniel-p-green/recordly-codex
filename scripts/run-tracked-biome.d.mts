import type {
  ExecFileSyncOptions,
  ExecFileSyncOptionsWithBufferEncoding,
} from "node:child_process";

export type TrackedBiomeCommand = "format" | "lint";

export type TrackedBiomeGitExecOptions = ExecFileSyncOptionsWithBufferEncoding & {
  readonly cwd: string;
  readonly encoding: "buffer";
};

export type TrackedBiomeCommandExecOptions = ExecFileSyncOptions & {
  readonly cwd: string;
  readonly stdio: "inherit";
};

export interface TrackedBiomeExecRunner {
  (file: string, args: readonly string[], options: TrackedBiomeGitExecOptions): Buffer;
  (file: string, args: readonly string[], options: TrackedBiomeCommandExecOptions): string | Buffer;
}

export interface RunTrackedBiomeOptions {
  readonly root: string;
  readonly command: TrackedBiomeCommand;
  readonly biome?: string;
  readonly run?: TrackedBiomeExecRunner;
}

export function trackedBiomeFiles(root: string, run?: TrackedBiomeExecRunner): string[];

export function runTrackedBiome(options: RunTrackedBiomeOptions): void;
