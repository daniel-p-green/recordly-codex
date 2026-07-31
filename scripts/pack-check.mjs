import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const allowlist = new Set(
  JSON.parse(readFileSync(join(root, "scripts/release-package-files.json"), "utf8")),
);
// npm always includes these even when `files` is set.
for (const always of ["package.json", "README.md", "LICENSE"]) {
  allowlist.add(always);
}

// Ignore lifecycle scripts so prepare/build noise cannot corrupt the JSON report.
const packed = execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
  cwd: root,
  encoding: "utf8",
  stdio: ["ignore", "pipe", "pipe"],
});
const jsonStart = packed.search(/[\[{]/u);
if (jsonStart < 0) {
  console.error(
    JSON.stringify({ ok: false, error: "npm pack did not emit JSON", packed }, null, 2),
  );
  process.exit(1);
}
const report = JSON.parse(packed.slice(jsonStart));
const entry = Array.isArray(report) ? report[0] : report;
const files = (entry?.files ?? []).map((file) => file.path.replaceAll("\\", "/")).sort();
const unexpected = files.filter((path) => !allowlist.has(path));
const missing = [...allowlist]
  .filter((path) => path !== "README.md" && path !== "package.json")
  .filter((path) => !files.includes(path))
  .sort();

if (unexpected.length > 0 || missing.length > 0) {
  console.error(
    JSON.stringify(
      {
        ok: false,
        packedCount: files.length,
        unexpected,
        missing,
        packed: files,
      },
      null,
      2,
    ),
  );
  process.exit(1);
}

console.log(
  JSON.stringify({
    ok: true,
    packedCount: files.length,
    packed: files,
  }),
);
