import { lstat, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { PreviewJudgmentStore } from "../../mcp/project-preview-judgment-store.js";

const roots: string[] = [];
const base = {
  schemaVersion: 1 as const,
  projectId: "project-1",
  revision: 0,
  projectSha256: "a".repeat(64),
  renderInputSha256: "b".repeat(64),
  previewArtifactSha256: "c".repeat(64),
  renderRecipeSha256: "d".repeat(64),
};

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("preview judgment persistence", () => {
  it("writes one immutable owner-bound judgment under a private root", async () => {
    const root = await mkdtemp(join(tmpdir(), "recordly-judgments-"));
    roots.push(root);
    const store = new PreviewJudgmentStore(root, "owner-1");
    const judgment = await store.create({ ...base, verdict: "accept", issues: [] });
    expect(judgment).toMatchObject({ verdict: "accept", projectId: "project-1" });
    const path = join(root, "projects", "judgments", "project-1-r0.json");
    expect((await lstat(path)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(path, "utf8"))).not.toHaveProperty("path");
    await expect(store.create({ ...base, verdict: "accept", issues: [] })).rejects.toThrow(
      /exists|immutable/i,
    );
  });

  it("permits only one concurrent verdict and matches exact final-gate digests", async () => {
    const root = await mkdtemp(join(tmpdir(), "recordly-judgments-"));
    roots.push(root);
    const first = new PreviewJudgmentStore(root, "owner-1");
    const second = new PreviewJudgmentStore(root, "owner-1");
    const results = await Promise.allSettled([
      first.create({ ...base, verdict: "accept", issues: [] }),
      second.create({ ...base, verdict: "reject", issues: [issue()] }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    const stored = await first.load("project-1", 0);
    expect(stored).toBeDefined();
    if (stored?.verdict === "accept") {
      await expect(first.assertAccepted({ ...base })).resolves.toMatchObject({ verdict: "accept" });
      await expect(
        first.assertAccepted({ ...base, projectSha256: "f".repeat(64) }),
      ).rejects.toThrow(/accepted|match/i);
      await expect(
        first.assertAccepted({ ...base, previewArtifactSha256: "f".repeat(64) }),
      ).rejects.toThrow(/accepted|match/i);
      await expect(first.assertAccepted({ ...base, revision: 1 })).rejects.toThrow(
        /accepted|match/i,
      );
    } else {
      await expect(first.assertAccepted({ ...base })).rejects.toThrow(/accepted/i);
    }
  });

  it("fails closed with an explicit diagnostic for unsupported envelope versions", async () => {
    const root = await mkdtemp(join(tmpdir(), "recordly-judgments-"));
    roots.push(root);
    const store = new PreviewJudgmentStore(root, "owner-1");
    await store.create({ ...base, verdict: "accept", issues: [] });
    const path = join(root, "projects", "judgments", "project-1-r0.json");
    const persisted = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    await writeFile(path, `${JSON.stringify({ ...persisted, schemaVersion: 2 })}\n`, {
      mode: 0o600,
    });

    await expect(store.load("project-1", 0)).rejects.toThrow(/version.*unsupported/i);
  });
});

function issue() {
  return {
    code: "framing",
    severity: "blocking" as const,
    region: "presentation" as const,
    startUs: 0,
    endUs: 1,
    evidence: "The subject is cropped.",
  };
}
