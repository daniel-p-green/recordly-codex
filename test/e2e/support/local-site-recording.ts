import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { access, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { chromium } from "playwright-core";

import { type CompiledRecording, compileRecording } from "../../../src/compiler/index.js";
import { resolveMediaExecutable } from "../../../src/encoder/ffmpeg.js";
import { probeRenderedVideo, type RenderedVideoProbe } from "../../../src/encoder/probe.js";

const execFileAsync = promisify(execFile);
const artifactPrefix = "recordly-codex-e2e-";
const ownedArtifactRoots = new Set<string>();
const fixturePath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../fixtures/site/index.html",
);

type LocalServer = {
  origin: string;
  requests: string[];
  close: () => Promise<void>;
};

export type LocalSiteE2ERecording = {
  artifactRoot: string;
  outputPath: string;
  sampleFramePath: string;
  manifestPath: string;
  telemetryPath: string;
  states: readonly ["opening", "action", "result"];
  loopbackRequests: string[];
  externalRequests: string[];
  compiled: CompiledRecording;
  manifestSha256: string;
  video: RenderedVideoProbe;
};

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function startLocalServer(): Promise<LocalServer> {
  const html = await readFile(fixturePath);
  const requests: string[] = [];
  const server = createServer((request, response) => {
    requests.push(request.url ?? "");
    if (request.method !== "GET" || request.url !== "/") {
      response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      response.end("Not found");
      return;
    }
    response.writeHead(200, {
      "cache-control": "no-store",
      "content-security-policy":
        "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'",
      "content-type": "text/html; charset=utf-8",
    });
    response.end(html);
  });
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", rejectListen);
      resolveListen();
    });
  });
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("loopback fixture server has no port");
  return {
    origin: `http://127.0.0.1:${address.port}`,
    requests,
    close: async () =>
      new Promise((resolveClose, rejectClose) => {
        server.close((error) => (error === undefined ? resolveClose() : rejectClose(error)));
      }),
  };
}

async function browserExecutable(): Promise<string> {
  const candidates =
    process.platform === "darwin"
      ? ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"]
      : ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/opt/google/chrome/chrome"];
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Only fixed hosted-runner locations are considered.
    }
  }
  throw new Error(`No supported system Chrome executable found: ${candidates.join(", ")}`);
}

function assertOwnedRoot(artifactRoot: string): void {
  if (!ownedArtifactRoots.has(artifactRoot)) {
    throw new RangeError("refusing to use an E2E artifact root not created by this test process");
  }
}

async function encodeScreenshotSequence(
  artifactRoot: string,
  framePaths: readonly string[],
): Promise<string> {
  assertOwnedRoot(artifactRoot);
  if (framePaths.length !== 3)
    throw new RangeError("E2E capture requires opening, action, and result frames");
  const sourceFrames = join(artifactRoot, "frames", "video");
  const outputPath = join(artifactRoot, "local-site-recording.mp4");
  for (let index = 0; index < 30; index += 1) {
    const statePath = framePaths[Math.floor(index / 10)];
    if (statePath === undefined) throw new Error("missing deterministic state frame");
    await copyFile(statePath, join(sourceFrames, `frame-${String(index).padStart(3, "0")}.png`));
  }
  const ffmpeg = await resolveMediaExecutable("ffmpeg");
  await execFileAsync(ffmpeg, [
    "-hide_banner",
    "-loglevel",
    "error",
    "-framerate",
    "30",
    "-start_number",
    "0",
    "-i",
    join(sourceFrames, "frame-%03d.png"),
    "-vf",
    "scale=1728:1080:flags=neighbor,pad=1920:1080:96:0:color=0x0f172a",
    "-frames:v",
    "30",
    "-r",
    "30",
    "-an",
    "-c:v",
    "libx264",
    "-preset",
    "medium",
    "-pix_fmt",
    "yuv420p",
    "-movflags",
    "+faststart",
    "-y",
    outputPath,
  ]);
  return outputPath;
}

async function extractSampleFrame(inputPath: string, artifactRoot: string): Promise<string> {
  assertOwnedRoot(artifactRoot);
  const outputPath = join(artifactRoot, "sample-result.ppm");
  const ffmpeg = await resolveMediaExecutable("ffmpeg");
  await execFileAsync(ffmpeg, [
    "-hide_banner",
    "-loglevel",
    "error",
    "-i",
    inputPath,
    "-ss",
    "0.750000",
    "-frames:v",
    "1",
    "-f",
    "image2",
    "-vcodec",
    "ppm",
    "-y",
    outputPath,
  ]);
  return outputPath;
}

export async function runLocalSiteE2E(): Promise<LocalSiteE2ERecording> {
  const artifactRoot = await mkdtemp(join(tmpdir(), artifactPrefix));
  ownedArtifactRoots.add(artifactRoot);
  const rawFramesDirectory = join(artifactRoot, "frames", "raw");
  const videoFramesDirectory = join(artifactRoot, "frames", "video");
  await Promise.all([
    mkdir(rawFramesDirectory, { recursive: true }),
    mkdir(videoFramesDirectory, { recursive: true }),
  ]);

  let server: LocalServer | undefined;
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    server = await startLocalServer();
    const origin = server.origin;
    const executablePath = await browserExecutable();
    browser = await chromium.launch({
      executablePath,
      headless: true,
      args: [
        "--disable-background-networking",
        "--disable-component-update",
        "--disable-default-apps",
        "--disable-sync",
        "--metrics-recording-only",
        "--no-first-run",
        "--no-pings",
        "--host-resolver-rules=MAP * 0.0.0.0,EXCLUDE 127.0.0.1",
      ],
    });
    const page = await browser.newPage({
      viewport: { width: 1440, height: 900 },
      deviceScaleFactor: 1,
    });
    const externalRequests: string[] = [];
    await page.route("**/*", async (route) => {
      const url = new URL(route.request().url());
      if (url.origin !== server?.origin) {
        externalRequests.push(url.toString());
        await route.abort("blockedbyclient");
        return;
      }
      await route.continue();
    });

    await page.goto(`${origin}/`, { waitUntil: "networkidle" });
    const openingPath = join(rawFramesDirectory, "state-opening.png");
    await page.screenshot({ path: openingPath });
    await page.hover("#run-demo");
    const actionPath = join(rawFramesDirectory, "state-action.png");
    await page.screenshot({ path: actionPath });
    await page.click("#run-demo");
    await page.waitForSelector('#result[data-state="complete"]');
    const resultPath = join(rawFramesDirectory, "state-result.png");
    await page.screenshot({ path: resultPath });
    const loopbackRequests = [...server.requests];
    await browser.close();
    browser = undefined;
    await server.close();
    server = undefined;

    const statePaths = [openingPath, actionPath, resultPath] as const;
    const frameHashes = await Promise.all(
      statePaths.map(async (path, index) => ({
        frameId: index + 1,
        imagePath: `frames/raw/${["state-opening", "state-action", "state-result"][index]}.png`,
        sha256: sha256(await readFile(path)),
      })),
    );
    const [openingFrame, actionFrame, resultFrame] = frameHashes;
    if (openingFrame === undefined || actionFrame === undefined || resultFrame === undefined) {
      throw new Error("missing deterministic frame hash evidence");
    }
    const compiled = compileRecording({
      request: {
        schemaVersion: 1,
        requestId: "local-site-e2e-001",
        url: `${origin}/`,
        objective: "Show the deterministic local result action.",
        viewport: { width: 1440, height: 900, deviceScaleFactor: 1 },
        output: { width: 1920, height: 1080, fps: 30, format: "mp4" },
        policy: { allowPrivateOrigin: true, allowedOrigins: [origin], maxAttempts: 2 },
      },
      frameHashes,
      events: [
        {
          schemaVersion: 1,
          sessionId: "local-site-e2e-001",
          seq: 1,
          tUs: 0,
          type: "frame",
          data: {
            cdpSessionId: 1,
            frameId: 1,
            receivedAtUs: 0,
            imagePath: openingFrame.imagePath,
            sha256: openingFrame.sha256,
            width: 1440,
            height: 900,
          },
        },
        {
          schemaVersion: 1,
          sessionId: "local-site-e2e-001",
          seq: 2,
          tUs: 300_000,
          type: "pointer",
          data: { x: 720, y: 470, buttons: 0, source: "observed" },
        },
        {
          schemaVersion: 1,
          sessionId: "local-site-e2e-001",
          seq: 3,
          tUs: 400_000,
          type: "frame",
          data: {
            cdpSessionId: 2,
            frameId: 2,
            receivedAtUs: 400_000,
            imagePath: actionFrame.imagePath,
            sha256: actionFrame.sha256,
            width: 1440,
            height: 900,
          },
        },
        {
          schemaVersion: 1,
          sessionId: "local-site-e2e-001",
          seq: 4,
          tUs: 500_000,
          type: "click",
          data: { x: 720, y: 470, button: 0, targetLabel: "Generate result" },
        },
        {
          schemaVersion: 1,
          sessionId: "local-site-e2e-001",
          seq: 5,
          tUs: 550_000,
          type: "marker",
          data: { id: "result-ready" },
        },
        {
          schemaVersion: 1,
          sessionId: "local-site-e2e-001",
          seq: 6,
          tUs: 966_000,
          type: "frame",
          data: {
            cdpSessionId: 3,
            frameId: 3,
            receivedAtUs: 966_000,
            imagePath: resultFrame.imagePath,
            sha256: resultFrame.sha256,
            width: 1440,
            height: 900,
          },
        },
        {
          schemaVersion: 1,
          sessionId: "local-site-e2e-001",
          seq: 7,
          tUs: 966_001,
          type: "capture_health",
          data: { queueOccupancy: 0, ackLatencyUs: 1_000 },
        },
      ],
      provenance: {
        environment: {
          codexSurface: "desktop-browser",
          browserProtocol: "playwright-test-cdp",
          runtime: `node-${process.versions.node.split(".")[0]}`,
        },
        renderer: {
          name: "recordly-codex",
          version: "0.1.0",
          profile: "1080p30",
          implementationSha256: "e".repeat(64),
        },
      },
    });
    const manifestPath = join(artifactRoot, "recording-manifest.json");
    const telemetryPath = join(artifactRoot, "telemetry.json");
    await Promise.all([
      writeFile(manifestPath, compiled.canonical.manifest, "utf8"),
      writeFile(telemetryPath, `${JSON.stringify(compiled.manifest.events)}\n`, "utf8"),
    ]);
    const outputPath = await encodeScreenshotSequence(artifactRoot, statePaths);
    const video = await probeRenderedVideo(outputPath);
    const sampleFramePath = await extractSampleFrame(outputPath, artifactRoot);
    return {
      artifactRoot,
      outputPath,
      sampleFramePath,
      manifestPath,
      telemetryPath,
      states: ["opening", "action", "result"],
      loopbackRequests,
      externalRequests,
      compiled,
      manifestSha256: compiled.hashes.manifestSha256,
      video,
    };
  } catch (error) {
    await browser?.close();
    await server?.close();
    await cleanupLocalSiteE2E({ artifactRoot } as LocalSiteE2ERecording);
    throw error;
  }
}

export async function cleanupLocalSiteE2E(
  recording: Pick<LocalSiteE2ERecording, "artifactRoot">,
): Promise<void> {
  assertOwnedRoot(recording.artifactRoot);
  await rm(recording.artifactRoot, { recursive: true, force: true });
  ownedArtifactRoots.delete(recording.artifactRoot);
}
