import { readFileSync } from "node:fs";
import { isIP } from "node:net";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const workflowClasses = ["static-click", "spa-transition", "animated-scroll", "responsive-outputs"];
const digestPattern = /^[a-f0-9]{64}$/u;
const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

function fail(message) {
  throw new TypeError(`v1 acceptance evidence: ${message}`);
}

function object(value, label) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  ) {
    fail(`${label} must be a plain object`);
  }
  return value;
}

function exact(value, keys, label) {
  const actual = Object.keys(value);
  if (actual.length !== keys.length || keys.some((key) => !(key in value))) {
    fail(`${label} must contain exactly: ${keys.join(", ")}`);
  }
}

function text(value, label, maximum = 128) {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > maximum ||
    [...value].some((character) => {
      const code = character.charCodeAt(0);
      return code <= 31 || code === 127;
    })
  ) {
    fail(`${label} must be bounded printable text`);
  }
  return value;
}

function identifier(value, label) {
  const parsed = text(value, label);
  if (!identifierPattern.test(parsed)) fail(`${label} must be a safe identifier`);
  return parsed;
}

function digest(value, label) {
  if (typeof value !== "string" || !digestPattern.test(value)) {
    fail(`${label} must be a lowercase SHA-256`);
  }
  return value;
}

function integer(value, label, minimum = 0) {
  if (!Number.isSafeInteger(value) || value < minimum) {
    fail(`${label} must be a safe integer at least ${minimum}`);
  }
  return value;
}

function literal(value, expected, label) {
  if (value !== expected) fail(`${label} must be ${String(expected)}`);
  return value;
}

function oneOf(value, values, label) {
  if (!values.includes(value)) fail(`${label} is not supported`);
  return value;
}

function publicOrigin(value, label) {
  const parsed = text(value, label, 512);
  let url;
  try {
    url = new URL(parsed);
  } catch {
    fail(`${label} must be a public HTTPS origin`);
  }
  const hostname = url.hostname.toLowerCase();
  if (
    url.protocol !== "https:" ||
    url.origin !== parsed ||
    url.username !== "" ||
    url.password !== "" ||
    isIP(hostname) !== 0 ||
    !hostname.includes(".") ||
    hostname === "localhost" ||
    [".localhost", ".local", ".internal", ".test", ".invalid"].some((suffix) =>
      hostname.endsWith(suffix),
    )
  ) {
    fail(`${label} must be a public HTTPS origin`);
  }
  return parsed;
}

function timestamp(value, label) {
  const parsed = text(value, label, 40);
  const date = new Date(parsed);
  if (!Number.isFinite(date.valueOf()) || date.toISOString() !== parsed) {
    fail(`${label} must be a canonical UTC timestamp`);
  }
  return parsed;
}

function validateRun(value, candidateVersion, index) {
  const label = `runs[${index}]`;
  const run = object(value, label);
  exact(
    run,
    [
      "schemaVersion",
      "runId",
      "workflowClass",
      "repetition",
      "targetOrigin",
      "objectiveId",
      "occurredAt",
      "execution",
      "capture",
      "delivery",
      "safety",
      "deviations",
    ],
    label,
  );
  literal(run.schemaVersion, 1, `${label}.schemaVersion`);
  const runId = identifier(run.runId, `${label}.runId`);
  const workflowClass = oneOf(run.workflowClass, workflowClasses, `${label}.workflowClass`);
  const repetition = integer(run.repetition, `${label}.repetition`, 1);
  if (repetition > 3) fail(`${label}.repetition must be 1, 2, or 3`);
  publicOrigin(run.targetOrigin, `${label}.targetOrigin`);
  identifier(run.objectiveId, `${label}.objectiveId`);
  timestamp(run.occurredAt, `${label}.occurredAt`);

  const execution = object(run.execution, `${label}.execution`);
  exact(
    execution,
    [
      "surface",
      "pluginVersion",
      "codexDesktopVersion",
      "nodeVersion",
      "ffmpegVersion",
      "operatingSystem",
    ],
    `${label}.execution`,
  );
  if (execution.surface !== "codex-desktop-browser") {
    fail(`${label}.execution.surface must prove the actual Codex Desktop Browser path`);
  }
  literal(execution.pluginVersion, candidateVersion, `${label}.execution.pluginVersion`);
  text(execution.codexDesktopVersion, `${label}.execution.codexDesktopVersion`, 64);
  text(execution.nodeVersion, `${label}.execution.nodeVersion`, 64);
  text(execution.ffmpegVersion, `${label}.execution.ffmpegVersion`, 128);
  text(execution.operatingSystem, `${label}.execution.operatingSystem`, 128);

  const capture = object(run.capture, `${label}.capture`);
  exact(
    capture,
    ["phase", "receivedFrames", "acceptedFrames", "ackedFrames", "rejectedFrames", "sealStatus"],
    `${label}.capture`,
  );
  literal(capture.phase, "stopped", `${label}.capture.phase`);
  const receivedFrames = integer(capture.receivedFrames, `${label}.capture.receivedFrames`, 1);
  const acceptedFrames = integer(capture.acceptedFrames, `${label}.capture.acceptedFrames`, 1);
  const ackedFrames = integer(capture.ackedFrames, `${label}.capture.ackedFrames`, 1);
  literal(capture.rejectedFrames, 0, `${label}.capture.rejectedFrames`);
  if (receivedFrames !== acceptedFrames || receivedFrames !== ackedFrames) {
    fail(`${label}.capture frames must be fully accepted and acknowledged`);
  }
  literal(capture.sealStatus, "approved", `${label}.capture.sealStatus`);

  const delivery = object(run.delivery, `${label}.delivery`);
  exact(
    delivery,
    [
      "previewVerdict",
      "judgmentStatus",
      "previewArtifactSha256",
      "finalArtifactSha256",
      "finalDigestVerified",
    ],
    `${label}.delivery`,
  );
  literal(delivery.previewVerdict, "accept", `${label}.delivery.previewVerdict`);
  literal(delivery.judgmentStatus, "current", `${label}.delivery.judgmentStatus`);
  digest(delivery.previewArtifactSha256, `${label}.delivery.previewArtifactSha256`);
  digest(delivery.finalArtifactSha256, `${label}.delivery.finalArtifactSha256`);
  literal(delivery.finalDigestVerified, true, `${label}.delivery.finalDigestVerified`);

  const safety = object(run.safety, `${label}.safety`);
  exact(
    safety,
    ["authorized", "privateOrigin", "requiredStopEncountered", "sensitivePixelsObserved"],
    `${label}.safety`,
  );
  literal(safety.authorized, true, `${label}.safety.authorized`);
  literal(safety.privateOrigin, false, `${label}.safety.privateOrigin`);
  literal(safety.requiredStopEncountered, false, `${label}.safety.requiredStopEncountered`);
  literal(safety.sensitivePixelsObserved, false, `${label}.safety.sensitivePixelsObserved`);

  if (!Array.isArray(run.deviations) || run.deviations.length > 8) {
    fail(`${label}.deviations must be an array with at most 8 entries`);
  }
  run.deviations.forEach((entry, deviationIndex) => {
    text(entry, `${label}.deviations[${deviationIndex}]`, 240);
  });
  return { runId, workflowClass, repetition };
}

function parseV1AcceptanceLedger(value, requiredRunCount) {
  const ledger = object(value, "ledger");
  exact(ledger, ["schemaVersion", "kind", "candidateVersion", "bundleSha256", "runs"], "ledger");
  literal(ledger.schemaVersion, 1, "ledger.schemaVersion");
  literal(ledger.kind, "recordly-codex-v1-live-acceptance", "ledger.kind");
  literal(ledger.candidateVersion, "1.0.0", "ledger.candidateVersion");
  const bundleSha256 = digest(ledger.bundleSha256, "ledger.bundleSha256");
  if (
    !Array.isArray(ledger.runs) ||
    ledger.runs.length < 1 ||
    ledger.runs.length > 12
  ) {
    fail("ledger.runs must contain between 1 and 12 runs");
  }
  if (requiredRunCount !== undefined && ledger.runs.length !== requiredRunCount) {
    fail("ledger.runs must contain exactly 12 runs");
  }
  const runs = ledger.runs.map((run, index) => validateRun(run, ledger.candidateVersion, index));
  if (new Set(runs.map((run) => run.runId)).size !== runs.length) {
    fail("runId values must be unique");
  }
  if (new Set(runs.map((run) => `${run.workflowClass}:${run.repetition}`)).size !== runs.length) {
    fail("workflow class and repetition pairs must be unique");
  }
  return { ledger, bundleSha256, runs };
}

export function validateV1AcceptancePartialLedger(value) {
  const { ledger, bundleSha256, runs } = parseV1AcceptanceLedger(value);
  return {
    candidateVersion: ledger.candidateVersion,
    bundleSha256,
    runCount: runs.length,
    workflowCount: new Set(runs.map((run) => run.workflowClass)).size,
    complete: false,
  };
}

export function validateV1AcceptanceLedger(value) {
  const { ledger, bundleSha256, runs } = parseV1AcceptanceLedger(value, 12);
  for (const workflowClass of workflowClasses) {
    const repetitions = runs
      .filter((run) => run.workflowClass === workflowClass)
      .map((run) => run.repetition)
      .sort((left, right) => left - right);
    if (repetitions.join(",") !== "1,2,3") {
      fail(`${workflowClass} must contain exactly repetitions 1, 2, and 3`);
    }
  }
  return {
    candidateVersion: ledger.candidateVersion,
    bundleSha256,
    runCount: runs.length,
    workflowCount: workflowClasses.length,
  };
}

const invokedPath = process.argv[1] === undefined ? undefined : resolve(process.argv[1]);
if (invokedPath === fileURLToPath(import.meta.url)) {
  const partial = process.argv[2] === "--partial";
  const evidencePath = process.argv[partial ? 3 : 2];
  if (evidencePath === undefined) {
    throw new TypeError(
      "usage: npm run acceptance:v1:validate -- [--partial] <sanitized-live-evidence.json>",
    );
  }
  const evidence = JSON.parse(readFileSync(resolve(evidencePath), "utf8"));
  const result = partial
    ? validateV1AcceptancePartialLedger(evidence)
    : validateV1AcceptanceLedger(evidence);
  console.info(
    partial
      ? `Validated ${result.runCount} partial v1 acceptance runs across ${result.workflowCount} workflow classes for bundle ${result.bundleSha256}; this is not final 12/12 proof.`
      : `Validated ${result.runCount} v1 acceptance runs across ${result.workflowCount} workflow classes for bundle ${result.bundleSha256}.`,
  );
}
