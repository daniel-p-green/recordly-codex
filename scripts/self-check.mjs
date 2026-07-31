import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, lstat, mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const pluginRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const hostContractPath = join(pluginRoot, "contracts", "host-support-v1-candidate.json");
const integrityContractPath = join(pluginRoot, "contracts", "runtime-integrity-v1-candidate.json");
const maxCommandOutput = 16 * 1024;
const commandTimeoutMs = 10_000;

function failure(code) {
  return { ok: false, code };
}

export function parseSemanticVersion(value) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/u.exec(value);
  if (match === null) throw new TypeError("value must be a canonical semantic version");
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  };
}

function compareVersion(left, right) {
  return left.major - right.major || left.minor - right.minor || left.patch - right.patch;
}

export function evaluateNodeVersion(value) {
  const requirement = "Node 22.17.0+ on major 22, or Node 24.x";
  try {
    const version = parseSemanticVersion(value);
    const minimum = parseSemanticVersion("22.17.0");
    const supportedMajor = version.major === 22 || version.major === 24;
    const meetsMinimum = version.major !== 22 || compareVersion(version, minimum) >= 0;
    return {
      ok: supportedMajor && meetsMinimum,
      version: `${version.major}.${version.minor}.${version.patch}`,
      requirement,
    };
  } catch {
    return { ok: false, version: "unparseable", requirement };
  }
}

function mediaVersion(output, executable) {
  const firstLine = output.split(/\r?\n/u)[0] ?? "";
  const match = new RegExp(`^${executable} version (\\d+)\\.(\\d+)(?:\\.(\\d+))?\\b`, "u").exec(
    firstLine,
  );
  if (match === null) throw new TypeError(`${executable} version output is invalid`);
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3] ?? 0),
  };
}

function versionText(value) {
  return `${value.major}.${value.minor}.${value.patch}`;
}

export function evaluateMediaVersions(ffmpegOutput, ffprobeOutput) {
  const requirement = "matching FFmpeg/FFprobe major, FFmpeg 6.1.1 through 8.x";
  try {
    const ffmpeg = mediaVersion(ffmpegOutput, "ffmpeg");
    const ffprobe = mediaVersion(ffprobeOutput, "ffprobe");
    const minimum = parseSemanticVersion("6.1.1");
    return {
      ok:
        compareVersion(ffmpeg, minimum) >= 0 && ffmpeg.major <= 8 && ffprobe.major === ffmpeg.major,
      ffmpegVersion: versionText(ffmpeg),
      ffprobeVersion: versionText(ffprobe),
      requirement,
    };
  } catch {
    return {
      ok: false,
      ffmpegVersion: "unparseable",
      ffprobeVersion: "unparseable",
      requirement,
    };
  }
}

function executableCandidates(name) {
  return process.platform === "win32"
    ? [`C:\\Program Files\\ffmpeg\\bin\\${name}.exe`]
    : [`/opt/homebrew/bin/${name}`, `/usr/local/bin/${name}`, `/usr/bin/${name}`];
}

async function resolveExecutable(name) {
  for (const candidate of executableCandidates(name)) {
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Try the next fixed, non-user-controlled installation location.
    }
  }
  throw new Error(`${name}_unavailable`);
}

function runCommand(executable, args, options = {}) {
  return new Promise((resolveCommand, rejectCommand) => {
    const child = spawn(executable, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (error === undefined) resolveCommand(value);
      else rejectCommand(error);
    };
    const append = (current, chunk) => {
      const next = current + chunk.toString("utf8");
      if (next.length > maxCommandOutput) {
        child.kill("SIGKILL");
        throw new Error("command_output_too_large");
      }
      return next;
    };
    child.stdout.on("data", (chunk) => {
      try {
        stdout = append(stdout, chunk);
      } catch (error) {
        finish(error);
      }
    });
    child.stderr.on("data", (chunk) => {
      try {
        stderr = append(stderr, chunk);
      } catch (error) {
        finish(error);
      }
    });
    child.once("error", (error) => finish(error));
    child.once("close", (code) => {
      if (code === 0) finish(undefined, { stdout, stderr });
      else finish(new Error(`command_exit_${String(code)}`));
    });
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      finish(new Error("command_timeout"));
    }, commandTimeoutMs);
  });
}

async function checkMedia() {
  try {
    const [ffmpeg, ffprobe] = await Promise.all([
      resolveExecutable("ffmpeg"),
      resolveExecutable("ffprobe"),
    ]);
    const [ffmpegResult, ffprobeResult] = await Promise.all([
      runCommand(ffmpeg, ["-version"]),
      runCommand(ffprobe, ["-version"]),
    ]);
    return evaluateMediaVersions(ffmpegResult.stdout, ffprobeResult.stdout);
  } catch {
    return failure("media_executables_unavailable");
  }
}

async function nearestExistingAncestor(path) {
  let candidate = path;
  for (;;) {
    try {
      return { path: candidate, status: await lstat(candidate) };
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    const parent = dirname(candidate);
    if (parent === candidate) throw new Error("artifact_parent_unavailable");
    candidate = parent;
  }
}

async function checkArtifactStorage(configuredRoot) {
  try {
    const root = resolve(configuredRoot);
    if (!isAbsolute(root) || root === "/") return failure("artifact_root_unsafe");
    const existing = await nearestExistingAncestor(root);
    if (
      !existing.status.isDirectory() ||
      existing.status.isSymbolicLink() ||
      (existing.path === root && (existing.status.mode & 0o077) !== 0)
    ) {
      return failure("artifact_storage_not_private");
    }
    await access(existing.path, constants.W_OK | constants.X_OK);
    return {
      ok: true,
      status: existing.path === root ? "existing-private-writable" : "parent-writable",
      configured: process.env.RECORDLY_CODEX_ARTIFACT_ROOT !== undefined,
    };
  } catch {
    return failure("artifact_storage_unavailable");
  }
}

async function checkLoopback() {
  const server = createServer();
  try {
    await new Promise((resolveListen, rejectListen) => {
      server.once("error", rejectListen);
      server.listen(0, "127.0.0.1", resolveListen);
    });
    return { ok: true, address: "127.0.0.1", port: "ephemeral" };
  } catch {
    return failure("loopback_bind_unavailable");
  } finally {
    await new Promise((resolveClose) => server.close(() => resolveClose())).catch(() => undefined);
  }
}

async function readContracts() {
  const [host, integrity] = await Promise.all([
    readFile(hostContractPath, "utf8"),
    readFile(integrityContractPath, "utf8"),
  ]);
  return { host: JSON.parse(host), integrity: JSON.parse(integrity) };
}

async function checkBundle(integrity) {
  try {
    const expected = integrity.bundle;
    const bundlePath = resolve(pluginRoot, expected.path);
    const bundle = await readFile(bundlePath);
    const sha256 = createHash("sha256").update(bundle).digest("hex");
    const source = bundle.toString("utf8");
    const ok =
      bundle.byteLength === expected.bytes &&
      bundle.byteLength <= expected.maximumBytes &&
      sha256 === expected.sha256 &&
      !source.includes("sourceMappingURL") &&
      !source.includes("/Users/") &&
      !source.includes("\\\\Users\\\\");
    return {
      ok,
      bytes: bundle.byteLength,
      sha256,
      maximumBytes: expected.maximumBytes,
    };
  } catch {
    return failure("bundle_integrity_unavailable");
  }
}

function rawMcp(bundlePath, artifactRoot) {
  const child = spawn(process.execPath, [bundlePath], {
    cwd: pluginRoot,
    env: { ...process.env, RECORDLY_CODEX_ARTIFACT_ROOT: artifactRoot },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let buffer = "";
  let stderr = "";
  let nextId = 1;
  const pending = new Map();
  child.stderr.on("data", (chunk) => {
    stderr = `${stderr}${chunk.toString("utf8")}`.slice(0, maxCommandOutput);
  });
  child.stdout.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (line.length === 0) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      if (typeof message.id === "number") pending.get(message.id)?.(message);
    }
  });
  return {
    call(method, params) {
      const id = nextId;
      nextId += 1;
      return new Promise((resolveCall, rejectCall) => {
        const timeout = setTimeout(() => {
          pending.delete(id);
          rejectCall(new Error("mcp_timeout"));
        }, commandTimeoutMs);
        pending.set(id, (message) => {
          clearTimeout(timeout);
          pending.delete(id);
          resolveCall(message);
        });
        child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      });
    },
    notify(method, params) {
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
    },
    close() {
      child.kill("SIGTERM");
    },
    stderr() {
      return stderr;
    },
  };
}

async function checkMcp(integrity) {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "recordly-codex-self-check-"));
  const transport = rawMcp(
    resolve(pluginRoot, integrity.bundle.path),
    join(temporaryRoot, "state"),
  );
  try {
    const initialized = await transport.call("initialize", {
      protocolVersion: integrity.mcp.protocolVersion,
      capabilities: {},
      clientInfo: { name: "recordly-codex-self-check", version: integrity.candidateVersion },
    });
    transport.notify("notifications/initialized", {});
    const listed = await transport.call("tools/list", {});
    const serverInfo = initialized.result?.serverInfo;
    const tools = listed.result?.tools;
    const names = Array.isArray(tools) ? tools.map((tool) => tool?.name) : [];
    const ok =
      serverInfo?.name === integrity.mcp.serverName &&
      serverInfo?.version === integrity.pluginVersion &&
      names.length === integrity.mcp.toolCount &&
      new Set(names).size === names.length &&
      transport.stderr() === "";
    return {
      ok,
      serverName: typeof serverInfo?.name === "string" ? serverInfo.name : "unavailable",
      serverVersion: typeof serverInfo?.version === "string" ? serverInfo.version : "unavailable",
      toolCount: names.length,
    };
  } catch {
    return failure("mcp_handshake_failed");
  } finally {
    transport.close();
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

export async function runSelfCheck(options = {}) {
  let contracts;
  try {
    contracts = await readContracts();
  } catch {
    return {
      schemaVersion: 1,
      ok: false,
      candidateVersion: "1.0.0",
      checks: { contracts: failure("support_contract_unavailable") },
    };
  }
  const artifactRoot =
    options.artifactRoot ??
    process.env.RECORDLY_CODEX_ARTIFACT_ROOT ??
    join(tmpdir(), "recordly-codex");
  const [media, artifactStorage, loopback, bundle] = await Promise.all([
    checkMedia(),
    checkArtifactStorage(artifactRoot),
    checkLoopback(),
    checkBundle(contracts.integrity),
  ]);
  const node = evaluateNodeVersion(process.version);
  const mcp = bundle.ok ? await checkMcp(contracts.integrity) : failure("bundle_integrity_failed");
  const checks = { node, media, artifactStorage, loopback, bundle, mcp };
  return {
    schemaVersion: 1,
    ok: Object.values(checks).every((check) => check.ok === true),
    candidateVersion: contracts.host.candidateVersion,
    checks,
  };
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await runSelfCheck();
  console.info(JSON.stringify(result, null, process.argv.includes("--json") ? 2 : 0));
  if (!result.ok) process.exitCode = 1;
}
