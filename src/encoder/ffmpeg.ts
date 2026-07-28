import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const fixtureVideoContract = {
  width: 1920,
  height: 1080,
  fps: 30,
  frameCount: 30,
} as const;

const fixtureArtifactPrefix = "recordly-codex-render-";
const ownedArtifactRoots = new Set<string>();

export type FixtureArtifactPaths = {
  artifactRoot: string;
  outputPath: string;
  firstFramePath: string;
  clickFramePath: string;
};

export function assertOwnedFixtureArtifactPaths(artifactPaths: FixtureArtifactPaths): void {
  if (
    !ownedArtifactRoots.has(artifactPaths.artifactRoot) ||
    artifactPaths.outputPath !== join(artifactPaths.artifactRoot, "render-fixture-candidate.mp4") ||
    artifactPaths.firstFramePath !==
      join(artifactPaths.artifactRoot, "render-fixture-first-frame.ppm") ||
    artifactPaths.clickFramePath !==
      join(artifactPaths.artifactRoot, "render-fixture-click-frame.ppm")
  ) {
    throw new RangeError("fixture artifact paths must be renderer-owned deterministic paths");
  }
}

function executableCandidates(name: "ffmpeg" | "ffprobe"): readonly string[] {
  const executable = process.platform === "win32" ? `${name}.exe` : name;
  return process.platform === "win32"
    ? [`C:\\Program Files\\ffmpeg\\bin\\${executable}`]
    : [`/opt/homebrew/bin/${executable}`, `/usr/local/bin/${executable}`, `/usr/bin/${executable}`];
}

export async function resolveMediaExecutable(name: "ffmpeg" | "ffprobe"): Promise<string> {
  for (const candidate of executableCandidates(name)) {
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // The next fixed installation location is tried below.
    }
  }
  throw new Error(
    `${name} was not found in a supported fixed installation location: ${executableCandidates(name).join(", ")}`,
  );
}

function waitForDrain(stream: NodeJS.WritableStream): Promise<void> {
  return new Promise((resolveDrain, rejectDrain) => {
    const onDrain = (): void => {
      stream.off("error", onError);
      resolveDrain();
    };
    const onError = (error: Error): void => {
      stream.off("drain", onDrain);
      rejectDrain(error);
    };
    stream.once("drain", onDrain);
    stream.once("error", onError);
  });
}

export async function encodeFixtureFrames(
  frames: AsyncIterable<Buffer>,
  artifactPaths: FixtureArtifactPaths,
): Promise<string> {
  assertOwnedFixtureArtifactPaths(artifactPaths);
  const ffmpeg = await resolveMediaExecutable("ffmpeg");
  await mkdir(artifactPaths.artifactRoot, { recursive: true });
  const args = [
    "-hide_banner",
    "-loglevel",
    "error",
    "-f",
    "rawvideo",
    "-pixel_format",
    "rgb24",
    "-video_size",
    `${fixtureVideoContract.width}x${fixtureVideoContract.height}`,
    "-framerate",
    String(fixtureVideoContract.fps),
    "-i",
    "pipe:0",
    "-an",
    "-c:v",
    "libx264",
    "-preset",
    "medium",
    "-pix_fmt",
    "yuv420p",
    "-movflags",
    "+faststart",
    "-frames:v",
    String(fixtureVideoContract.frameCount),
    "-y",
    artifactPaths.outputPath,
  ];
  const child = spawn(ffmpeg, args, { stdio: ["pipe", "ignore", "pipe"] });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  const exited = new Promise<void>((resolveExit, rejectExit) => {
    child.once("error", rejectExit);
    child.once("close", (code) => {
      if (code === 0) {
        resolveExit();
      } else {
        rejectExit(new Error(`ffmpeg exited with code ${code}: ${stderr.trim()}`));
      }
    });
  });

  try {
    for await (const frame of frames) {
      if (frame.length !== fixtureVideoContract.width * fixtureVideoContract.height * 3) {
        throw new RangeError("fixture frames must be packed 1920x1080 RGB24 buffers");
      }
      if (!child.stdin.write(frame)) await waitForDrain(child.stdin);
    }
    child.stdin.end();
    await exited;
    return artifactPaths.outputPath;
  } catch (error) {
    child.stdin.destroy();
    child.kill("SIGTERM");
    await exited.catch(() => undefined);
    throw error;
  }
}

export async function createFixtureArtifactPaths(): Promise<FixtureArtifactPaths> {
  const artifactRoot = await mkdtemp(join(tmpdir(), fixtureArtifactPrefix));
  ownedArtifactRoots.add(artifactRoot);
  return {
    artifactRoot,
    outputPath: join(artifactRoot, "render-fixture-candidate.mp4"),
    firstFramePath: join(artifactRoot, "render-fixture-first-frame.ppm"),
    clickFramePath: join(artifactRoot, "render-fixture-click-frame.ppm"),
  };
}

export async function cleanupFixtureArtifacts(artifactPaths: FixtureArtifactPaths): Promise<void> {
  assertOwnedFixtureArtifactPaths(artifactPaths);
  await rm(artifactPaths.artifactRoot, { recursive: true, force: true });
  ownedArtifactRoots.delete(artifactPaths.artifactRoot);
}
