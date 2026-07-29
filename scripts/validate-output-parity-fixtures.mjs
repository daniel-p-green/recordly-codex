import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const defaultManifestPath = resolve(
  repositoryRoot,
  "fixtures/output-parity-v1/fixture-manifest.json",
);

const profiles = {
  "landscape-1080p": { width: 1920, height: 1080 },
  "square-1080": { width: 1080, height: 1080 },
  "vertical-1080": { width: 1080, height: 1920 },
};
const requiredEffects = [
  "trim",
  "speed",
  "crossfade",
  "reviewed-zoom",
  "cursor",
  "click-effect",
  "frame-style",
  "caption",
  "annotation",
];
const requiredExclusions = [
  "native-display-or-window-capture",
  "microphone-or-system-audio-capture",
  "graphical-timeline-editor",
  "recordly-project-file-compatibility",
];

function positiveInteger(value, label, minimum, maximum) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum)
    fail(`${label} must be a safe integer between ${minimum} and ${maximum}`);
  return value;
}

function renderAcceptance(value) {
  const parsed = object(value, "renderAcceptance");
  exactKeys(parsed, "renderAcceptance", [
    "durationMs",
    "durationToleranceMs",
    "checkpointToleranceMs",
    "codec",
  ]);
  const durationMs = positiveInteger(parsed.durationMs, "renderAcceptance.durationMs", 500, 10_000);
  const durationToleranceMs = positiveInteger(
    parsed.durationToleranceMs,
    "renderAcceptance.durationToleranceMs",
    1,
    500,
  );
  const checkpointToleranceMs = positiveInteger(
    parsed.checkpointToleranceMs,
    "renderAcceptance.checkpointToleranceMs",
    1,
    250,
  );
  const codec = object(parsed.codec, "renderAcceptance.codec");
  exactKeys(codec, "renderAcceptance.codec", ["channelTolerance", "minimumDominance"]);
  return {
    durationMs,
    durationToleranceMs,
    checkpointToleranceMs,
    codec: {
      channelTolerance: positiveInteger(
        codec.channelTolerance,
        "renderAcceptance.codec.channelTolerance",
        1,
        127,
      ),
      minimumDominance: positiveInteger(
        codec.minimumDominance,
        "renderAcceptance.codec.minimumDominance",
        1,
        255,
      ),
    },
  };
}

function fail(message) {
  throw new Error(`Invalid output-parity fixture manifest: ${message}`);
}

function object(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    fail(`${label} must be an object`);
  return value;
}

function text(value, label) {
  if (typeof value !== "string" || value.length === 0 || value.length > 512)
    fail(`${label} must be text`);
  return value;
}

function array(value, label) {
  if (!Array.isArray(value) || value.length === 0) fail(`${label} must be a non-empty array`);
  return value;
}

function exactKeys(value, label, keys) {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    fail(`${label} must contain only ${expected.join(", ")}`);
  }
}

function identifier(value, label) {
  const result = text(value, label);
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/u.test(result)) fail(`${label} must be a bounded identifier`);
  return result;
}

function nonNegativeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0)
    fail(`${label} must be a non-negative safe integer`);
  return value;
}

function contained(root, path) {
  const value = relative(root, path);
  return value.length > 0 && !value.startsWith("..") && !value.startsWith("/");
}

async function validateAsset(asset, index, fixtureRoot) {
  const label = `assets[${index}]`;
  const value = object(asset, label);
  exactKeys(value, label, ["id", "path", "mediaType", "sha256"]);
  const id = identifier(value.id, `${label}.id`);
  const assetPath = text(value.path, `${label}.path`);
  if (!assetPath.startsWith("assets/") || assetPath.includes("\\\\") || assetPath.includes("..")) {
    fail(`${label}.path must be a contained asset path`);
  }
  if (value.mediaType !== "image/x-portable-pixmap")
    fail(`${label}.mediaType must be image/x-portable-pixmap`);
  const sha256 = text(value.sha256, `${label}.sha256`);
  if (!/^[a-f0-9]{64}$/u.test(sha256)) fail(`${label}.sha256 must be lowercase SHA-256`);
  const resolved = resolve(fixtureRoot, assetPath);
  if (!contained(fixtureRoot, resolved)) fail(`${label}.path escapes the fixture root`);
  const bytes = await readFile(resolved);
  if (bytes.length === 0 || bytes.length > 4096) fail(`${label} must be a small fixture asset`);
  if (!bytes.toString("ascii").startsWith("P3\n")) fail(`${label} must be an ASCII P3 PPM fixture`);
  if (createHash("sha256").update(bytes).digest("hex") !== sha256)
    fail(`${label}.sha256 does not match`);
  return { id, path: assetPath, mediaType: value.mediaType, sha256 };
}

function validateFixture(fixture, index, assetIds) {
  const label = `fixtures[${index}]`;
  const value = object(fixture, label);
  exactKeys(value, label, [
    "id",
    "profile",
    "output",
    "sourceAssetId",
    "requiredEffects",
    "decodedCheckpoints",
  ]);
  const id = identifier(value.id, `${label}.id`);
  if (!(value.profile in profiles)) fail(`${label}.profile is unsupported`);
  const profile = value.profile;
  const output = object(value.output, `${label}.output`);
  exactKeys(output, `${label}.output`, ["width", "height", "fps", "format"]);
  const expected = profiles[profile];
  if (output.width !== expected.width || output.height !== expected.height) {
    fail(`${label}.output dimensions must match ${profile}`);
  }
  if (output.fps !== 30 && output.fps !== 60) fail(`${label}.output.fps must be 30 or 60`);
  if (output.format !== "mp4" && output.format !== "gif")
    fail(`${label}.output.format must be mp4 or gif`);
  const sourceAssetId = identifier(value.sourceAssetId, `${label}.sourceAssetId`);
  if (!assetIds.has(sourceAssetId)) fail(`${label}.sourceAssetId must reference a manifest asset`);
  const effects = array(value.requiredEffects, `${label}.requiredEffects`).map(
    (effect, effectIndex) => text(effect, `${label}.requiredEffects[${effectIndex}]`),
  );
  if (new Set(effects).size !== effects.length) fail(`${label}.requiredEffects must be unique`);
  for (const effect of requiredEffects) {
    if (!effects.includes(effect)) fail(`${label}.requiredEffects must include ${effect}`);
  }
  const checkpoints = array(value.decodedCheckpoints, `${label}.decodedCheckpoints`);
  if (checkpoints.length !== 3)
    fail(`${label}.decodedCheckpoints must define opening, effect, and final`);
  const expectedKinds = ["opening", "effect", "final"];
  let previousAtOutputMs = -1;
  const decodedCheckpoints = checkpoints.map((checkpoint, checkpointIndex) => {
    const checkpointLabel = `${label}.decodedCheckpoints[${checkpointIndex}]`;
    const parsed = object(checkpoint, checkpointLabel);
    exactKeys(parsed, checkpointLabel, ["id", "kind", "atOutputMs", "assertions"]);
    if (parsed.kind !== expectedKinds[checkpointIndex])
      fail(`${checkpointLabel}.kind is out of order`);
    const atOutputMs = nonNegativeInteger(parsed.atOutputMs, `${checkpointLabel}.atOutputMs`);
    if (atOutputMs <= previousAtOutputMs) fail(`${checkpointLabel}.atOutputMs must increase`);
    previousAtOutputMs = atOutputMs;
    const assertions = array(parsed.assertions, `${checkpointLabel}.assertions`).map(
      (assertion, assertionIndex) =>
        text(assertion, `${checkpointLabel}.assertions[${assertionIndex}]`),
    );
    if (!assertions.includes("decoded-frame"))
      fail(`${checkpointLabel}.assertions must include decoded-frame`);
    return {
      id: identifier(parsed.id, `${checkpointLabel}.id`),
      kind: parsed.kind,
      atOutputMs,
      assertions,
    };
  });
  return {
    id,
    profile,
    output: { width: output.width, height: output.height, fps: output.fps, format: output.format },
    sourceAssetId,
    requiredEffects: effects,
    decodedCheckpoints,
  };
}

export async function validateOutputParityFixtureManifest(manifestPath = defaultManifestPath) {
  const resolvedManifestPath = resolve(manifestPath);
  const fixtureRoot = dirname(resolvedManifestPath);
  const manifest = JSON.parse(await readFile(resolvedManifestPath, "utf8"));
  const value = object(manifest, "manifest");
  exactKeys(value, "manifest", [
    "schemaVersion",
    "kind",
    "suite",
    "description",
    "outputParityDefinition",
    "renderAcceptance",
    "provenance",
    "exclusions",
    "assets",
    "fixtures",
  ]);
  if (value.schemaVersion !== 1) fail("schemaVersion must be 1");
  if (value.kind !== "recordly-codex-output-parity-fixture-manifest") fail("kind is unsupported");
  if (value.suite !== "output-parity-v1") fail("suite is unsupported");
  const acceptedRender = renderAcceptance(value.renderAcceptance);
  const provenance = object(value.provenance, "provenance");
  exactKeys(provenance, "provenance", ["origin", "recordlyMaterial", "assetPolicy"]);
  if (provenance.origin !== "independently-authored-sanitized")
    fail("provenance.origin is unsupported");
  if (provenance.recordlyMaterial !== "none") fail("provenance.recordlyMaterial must be none");
  if (provenance.assetPolicy !== "repository-owned-minimal-fixtures")
    fail("provenance.assetPolicy is unsupported");
  const exclusions = array(value.exclusions, "exclusions").map((exclusion, index) =>
    text(exclusion, `exclusions[${index}]`),
  );
  for (const exclusion of requiredExclusions) {
    if (!exclusions.includes(exclusion)) fail(`exclusions must include ${exclusion}`);
  }
  const assets = await Promise.all(
    array(value.assets, "assets").map((asset, index) => validateAsset(asset, index, fixtureRoot)),
  );
  if (new Set(assets.map((asset) => asset.id)).size !== assets.length)
    fail("assets IDs must be unique");
  const fixtures = array(value.fixtures, "fixtures").map((fixture, index) =>
    validateFixture(fixture, index, new Set(assets.map((asset) => asset.id))),
  );
  if (new Set(fixtures.map((fixture) => fixture.id)).size !== fixtures.length)
    fail("fixture IDs must be unique");
  for (const profile of Object.keys(profiles)) {
    if (!fixtures.some((fixture) => fixture.profile === profile))
      fail(`fixtures must cover ${profile}`);
  }
  for (const format of ["mp4", "gif"]) {
    if (!fixtures.some((fixture) => fixture.output.format === format))
      fail(`fixtures must cover ${format}`);
  }
  return {
    schemaVersion: value.schemaVersion,
    kind: value.kind,
    suite: value.suite,
    description: text(value.description, "description"),
    outputParityDefinition: text(value.outputParityDefinition, "outputParityDefinition"),
    renderAcceptance: acceptedRender,
    provenance,
    exclusions,
    assets,
    fixtures,
  };
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await validateOutputParityFixtureManifest();
  const asset = await stat(resolve(dirname(defaultManifestPath), "assets/independent-checker.ppm"));
  console.log(`Output-parity v1 fixture manifest is valid (${asset.size} byte asset).`);
}
