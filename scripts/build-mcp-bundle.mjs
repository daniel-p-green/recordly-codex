import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";
import ts from "typescript";

const pluginRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const outputPath = resolve(pluginRoot, "plugin-runtime/recordly-codex-mcp.mjs");
const noticesPath = resolve(pluginRoot, "THIRD_PARTY_NOTICES.md");
const checkOnly = process.argv.includes("--check");
const temporaryPath = `${outputPath}.next`;
const temporaryNoticesPath = `${noticesPath}.next`;
const maxBytes = 2 * 1024 * 1024;

const compareText = (left, right) => (left < right ? -1 : left > right ? 1 : 0);

function templateContentRange(node, sourceFile) {
  const start = node.getStart(sourceFile);
  const end = node.getEnd();
  const text = sourceFile.text.slice(start, end);
  if (ts.isNoSubstitutionTemplateLiteral(node)) {
    if (!text.startsWith("`") || !text.endsWith("`")) throw new Error("invalid template literal");
    return { start: start + 1, end: end - 1 };
  }
  if (ts.isTemplateHead(node) || ts.isTemplateMiddle(node)) {
    if (!text.endsWith("${")) throw new Error("invalid template interpolation");
    return { start: start + 1, end: end - 2 };
  }
  if (ts.isTemplateTail(node)) {
    if (!text.endsWith("`")) throw new Error("invalid template tail");
    return { start: start + 1, end: end - 1 };
  }
  throw new Error("unsupported template literal");
}

function escapeTrailingWhitespaceInUntaggedTemplateSegments(source) {
  const sourceFile = ts.createSourceFile(
    "recordly-codex-mcp.mjs",
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  if (sourceFile.parseDiagnostics.length > 0) {
    throw new Error("generated MCP bundle is not valid JavaScript");
  }
  const ranges = [];
  const collectTemplate = (template, tagged) => {
    if (ts.isNoSubstitutionTemplateLiteral(template)) {
      if (!tagged) ranges.push(templateContentRange(template, sourceFile));
      return;
    }
    if (!ts.isTemplateExpression(template)) throw new Error("unsupported template expression");
    if (!tagged) ranges.push(templateContentRange(template.head, sourceFile));
    for (const span of template.templateSpans) {
      visit(span.expression);
      if (!tagged) ranges.push(templateContentRange(span.literal, sourceFile));
    }
  };
  const visit = (node) => {
    if (ts.isTaggedTemplateExpression(node)) {
      visit(node.tag);
      collectTemplate(node.template, true);
      return;
    }
    if (ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateExpression(node)) {
      collectTemplate(node, false);
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);

  let normalized = source;
  for (const range of ranges.sort((left, right) => right.start - left.start)) {
    const content = source.slice(range.start, range.end);
    const escaped = content.replace(/[ \t]+(?=\r?\n)/gu, (whitespace) =>
      [...whitespace].map((character) => (character === " " ? "\\x20" : "\\t")).join(""),
    );
    normalized = `${normalized.slice(0, range.start)}${escaped}${normalized.slice(range.end)}`;
  }
  return normalized;
}

function packageRootForInput(inputPath) {
  const absoluteInputPath = resolve(pluginRoot, inputPath);
  const marker = `${sep}node_modules${sep}`;
  const markerIndex = absoluteInputPath.lastIndexOf(marker);
  if (markerIndex < 0) return undefined;

  const packageSegments = absoluteInputPath.slice(markerIndex + marker.length).split(sep);
  const packageLength = packageSegments[0]?.startsWith("@") ? 2 : 1;
  if (
    packageSegments.length < packageLength ||
    packageSegments.slice(0, packageLength).some((segment) => !segment)
  ) {
    throw new Error(`unable to resolve bundled package root for ${inputPath}`);
  }
  return resolve(
    absoluteInputPath.slice(0, markerIndex + marker.length),
    ...packageSegments.slice(0, packageLength),
  );
}

async function packageNotice(packageRoot) {
  const packageJsonPath = resolve(packageRoot, "package.json");
  const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8"));
  if (
    typeof packageJson.name !== "string" ||
    !packageJson.name ||
    typeof packageJson.version !== "string" ||
    !packageJson.version ||
    typeof packageJson.license !== "string" ||
    !packageJson.license.trim() ||
    packageJson.license === "UNLICENSED"
  ) {
    throw new Error(
      `unable to resolve name, version, or license for bundled package ${packageRoot}`,
    );
  }
  const licenseFiles = (await readdir(packageRoot, { withFileTypes: true }))
    .filter(
      (entry) =>
        entry.isFile() &&
        /^(license|licence|copying|copyright|notice)([._-].*)?$/iu.test(entry.name),
    )
    .map((entry) => entry.name)
    .sort(compareText);
  if (licenseFiles.length === 0) {
    throw new Error(
      `unable to resolve license or notice text for bundled package ${packageJson.name}`,
    );
  }
  const texts = await Promise.all(
    licenseFiles.map(async (name) => ({
      name,
      text: (await readFile(resolve(packageRoot, name), "utf8")).replaceAll("\r\n", "\n").trim(),
    })),
  );
  if (texts.some(({ text }) => text.length === 0)) {
    throw new Error(`bundled package ${packageJson.name} has an empty license or notice file`);
  }
  return {
    name: packageJson.name,
    version: packageJson.version,
    license: packageJson.license,
    texts,
  };
}

async function renderThirdPartyNotices(inputs) {
  const roots = new Set();
  for (const inputPath of Object.keys(inputs)) {
    const packageRoot = packageRootForInput(inputPath);
    if (packageRoot !== undefined) roots.add(packageRoot);
  }
  const packages = await Promise.all([...roots].sort(compareText).map(packageNotice));
  packages.sort(
    (left, right) => compareText(left.name, right.name) || compareText(left.version, right.version),
  );

  return [
    "# Third-Party Notices",
    "",
    "Generated by `npm run bundle` from the npm packages included in the standalone MCP bundle.",
    "Do not edit manually; `npm run bundle:check` verifies this file against esbuild's dependency graph.",
    "",
    ...packages.flatMap((item) => [
      `## ${item.name}@${item.version}`,
      "",
      `License: ${item.license}`,
      "",
      ...item.texts.flatMap(({ name, text }) => [`### ${name}`, "", text, ""]),
    ]),
  ]
    .join("\n")
    .replace(/\n+$/u, "");
}

await mkdir(dirname(outputPath), { recursive: true });
await rm(temporaryPath, { force: true });
await rm(temporaryNoticesPath, { force: true });
const buildResult = await build({
  absWorkingDir: pluginRoot,
  entryPoints: ["mcp/server.ts"],
  outfile: temporaryPath,
  bundle: true,
  format: "esm",
  legalComments: "none",
  minifyWhitespace: true,
  platform: "node",
  sourcemap: false,
  target: "node22",
  metafile: true,
});

const generated = await readFile(temporaryPath, "utf8");
const normalizedBundle = escapeTrailingWhitespaceInUntaggedTemplateSegments(generated);
const candidate = Buffer.from(normalizedBundle);
if (!candidate.equals(Buffer.from(generated))) {
  await writeFile(temporaryPath, candidate);
}
if (candidate.byteLength > maxBytes) {
  await rm(temporaryPath, { force: true });
  throw new Error(`MCP bundle exceeds ${maxBytes} bytes`);
}
const source = candidate.toString("utf8");
if (
  source.includes("sourceMappingURL") ||
  source.includes("/Users/") ||
  source.includes("\\\\Users\\\\")
) {
  await rm(temporaryPath, { force: true });
  throw new Error("MCP bundle contains a source map or local path");
}
if (/(?:^|\n)[^\n]*[ \t]+(?:\r?\n|$)/u.test(source)) {
  await rm(temporaryPath, { force: true });
  throw new Error("MCP bundle contains trailing horizontal whitespace");
}
const notices = await renderThirdPartyNotices(buildResult.metafile.inputs);
if (notices.includes("/Users/") || notices.includes("\\Users\\")) {
  await rm(temporaryPath, { force: true });
  throw new Error("third-party notices contain a local path");
}
await writeFile(temporaryNoticesPath, `${notices}\n`);

const hash = createHash("sha256").update(candidate).digest("hex");
if (checkOnly) {
  const [committedBundle, committedNotices] = await Promise.all([
    readFile(outputPath).catch(() => undefined),
    readFile(noticesPath).catch(() => undefined),
  ]);
  await Promise.all([
    rm(temporaryPath, { force: true }),
    rm(temporaryNoticesPath, { force: true }),
  ]);
  if (committedBundle === undefined || !committedBundle.equals(candidate)) {
    throw new Error(
      "MCP bundle is stale; run npm run bundle and commit plugin-runtime/recordly-codex-mcp.mjs",
    );
  }
  if (committedNotices === undefined || !committedNotices.equals(Buffer.from(`${notices}\n`))) {
    throw new Error(
      "third-party notices are stale; run npm run bundle and commit THIRD_PARTY_NOTICES.md",
    );
  }
} else {
  await Promise.all([rename(temporaryPath, outputPath), rename(temporaryNoticesPath, noticesPath)]);
}

console.info(`MCP bundle ${candidate.byteLength} bytes sha256:${hash}`);
