import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parse } from "yaml";

const pluginRoot = process.cwd();
const manifestPath = resolve(pluginRoot, ".codex-plugin/plugin.json");
const skillPath = resolve(pluginRoot, "skills/recordly-codex/SKILL.md");
const skillAgentPath = resolve(pluginRoot, "skills/recordly-codex/agents/openai.yaml");

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
