import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { parse } from "yaml";

const pluginRoot = process.cwd();
const manifestPath = resolve(pluginRoot, ".codex-plugin/plugin.json");
const mcpConfigPath = resolve(pluginRoot, ".mcp.json");
const marketplacePath = resolve(pluginRoot, ".agents/plugins/marketplace.json");
const skillPath = resolve(pluginRoot, "skills/recordly-codex/SKILL.md");
const skillAgentPath = resolve(pluginRoot, "skills/recordly-codex/agents/openai.yaml");
const execFileAsync = promisify(execFile);

const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
const allowedManifestKeys = new Set([
  "id",
  "name",
  "version",
  "description",
  "skills",
  "apps",
  "mcpServers",
  "interface",
  "author",
  "homepage",
  "repository",
  "license",
  "keywords",
]);
const requiredInterfaceFields = [
  "displayName",
  "shortDescription",
  "longDescription",
  "developerName",
  "category",
];

const fail = (message) => {
  throw new Error(`Plugin validation failed: ${message}`);
};

for (const key of Object.keys(manifest)) {
  if (!allowedManifestKeys.has(key)) fail(`unsupported manifest field \`${key}\``);
}

if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(manifest.name ?? "")) {
  fail("name must be non-empty kebab-case");
}
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(manifest.version ?? "")) {
  fail("version must be strict semver");
}
if (typeof manifest.description !== "string" || !manifest.description.trim()) {
  fail("description must be non-empty");
}
if (typeof manifest.author?.name !== "string" || !manifest.author.name.trim()) {
  fail("author.name must be non-empty");
}
if (manifest.skills !== "./skills/") fail("skills must point to ./skills/");
if (manifest.mcpServers !== "./.mcp.json") fail("mcpServers must point to ./.mcp.json");
if (typeof manifest.interface !== "object" || manifest.interface === null) {
  fail("interface must be an object");
}
for (const field of requiredInterfaceFields) {
  if (typeof manifest.interface[field] !== "string" || !manifest.interface[field].trim()) {
    fail(`interface.${field} must be non-empty`);
  }
}
if (
  !Array.isArray(manifest.interface.capabilities) ||
  manifest.interface.capabilities.length === 0
) {
  fail("interface.capabilities must be a non-empty array");
}
if (
  !Array.isArray(manifest.interface.defaultPrompt) ||
  manifest.interface.defaultPrompt.length === 0
) {
  fail("interface.defaultPrompt must be a non-empty array");
}
if (!/^#[0-9A-F]{6}$/i.test(manifest.interface.brandColor ?? "")) {
  fail("interface.brandColor must be #RRGGBB");
}

const mcpConfig = JSON.parse(await readFile(mcpConfigPath, "utf8"));
if (
  mcpConfig === null ||
  typeof mcpConfig !== "object" ||
  Array.isArray(mcpConfig) ||
  Object.keys(mcpConfig).length !== 1 ||
  !("mcpServers" in mcpConfig)
) {
  fail(".mcp.json must contain only the mcpServers object");
}

const marketplace = JSON.parse(await readFile(marketplacePath, "utf8"));
if (
  marketplace?.name !== "recordly-codex" ||
  marketplace?.interface?.displayName !== "Recordly Codex" ||
  !Array.isArray(marketplace.plugins) ||
  marketplace.plugins.length !== 1
) {
  fail("marketplace must declare the one recordly-codex plugin");
}
const marketplacePlugin = marketplace.plugins[0];
if (
  marketplacePlugin?.name !== "recordly-codex" ||
  marketplacePlugin?.source?.source !== "local" ||
  marketplacePlugin?.source?.path !== "." ||
  marketplacePlugin?.policy?.installation !== "AVAILABLE" ||
  marketplacePlugin?.policy?.authentication !== "ON_INSTALL" ||
  marketplacePlugin?.category !== "Productivity"
) {
  fail("marketplace plugin must point at the repository root with install policy metadata");
}
const mcpServers = mcpConfig.mcpServers;
if (
  mcpServers === null ||
  typeof mcpServers !== "object" ||
  Array.isArray(mcpServers) ||
  Object.keys(mcpServers).length !== 1 ||
  !("recordly-codex" in mcpServers)
) {
  fail(".mcp.json must contain only the recordly-codex server");
}
const localServer = mcpServers["recordly-codex"];
if (
  localServer === null ||
  typeof localServer !== "object" ||
  Array.isArray(localServer) ||
  Object.keys(localServer).length !== 3 ||
  localServer.command !== "node" ||
  localServer.cwd !== "." ||
  !Array.isArray(localServer.args) ||
  localServer.args.length !== 1 ||
  localServer.args[0] !== "./plugin-runtime/recordly-codex-mcp.mjs"
) {
  fail(".mcp.json must use the committed standalone MCP server command");
}
let bundledMcp;
try {
  bundledMcp = await readFile(resolve(pluginRoot, "plugin-runtime/recordly-codex-mcp.mjs"));
} catch {
  fail("the committed MCP bundle must exist at plugin-runtime/recordly-codex-mcp.mjs");
}
if (bundledMcp.byteLength > 2 * 1024 * 1024) {
  fail("the committed MCP bundle must be at most 2 MiB");
}
const bundledSource = bundledMcp.toString("utf8");
if (
  bundledSource.includes("sourceMappingURL") ||
  bundledSource.includes("/Users/") ||
  bundledSource.includes("\\\\Users\\\\")
) {
  fail("the committed MCP bundle must not contain source maps or local paths");
}
try {
  await execFileAsync(process.execPath, ["scripts/build-mcp-bundle.mjs", "--check"], {
    cwd: pluginRoot,
  });
} catch {
  fail("the committed MCP bundle or third-party notices are stale or incomplete");
}

const skill = await readFile(skillPath, "utf8");
const frontmatterMatch = /^---\n([\s\S]*?)\n---\n/.exec(skill);
if (frontmatterMatch?.[1] === undefined) {
  fail("skill must contain the required recordly-codex YAML frontmatter");
}
const frontmatter = parse(frontmatterMatch[1]);
if (frontmatter?.name !== "recordly-codex" || typeof frontmatter.description !== "string") {
  fail("skill frontmatter must declare the recordly-codex name and a description");
}
if (skill.includes("[TODO:")) fail("skill must not contain TODO placeholders");

const skillAgent = parse(await readFile(skillAgentPath, "utf8"));
if (
  typeof skillAgent?.interface?.display_name !== "string" ||
  typeof skillAgent.interface.short_description !== "string" ||
  typeof skillAgent.interface.default_prompt !== "string" ||
  skillAgent.policy?.allow_implicit_invocation !== true
) {
  fail("skill agent metadata must define its UI details and implicit-invocation policy");
}

console.info("Plugin validation passed: recordly-codex");
