import { chmod, copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { inspectPrivatePreview } from "../../mcp/preview-inspection.js";
import {
  cleanupRenderedFixtureCandidate,
  renderSanitizedFixtureCandidate,
} from "../../src/render/sanitized-fixture.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("private preview inspection", () => {
  it("decodes an exact private preview into a bounded contact-sheet image and path-free evidence", async () => {
    const candidate = await renderSanitizedFixtureCandidate();
    const root = await mkdtemp(join(tmpdir(), "recordly-preview-inspection-"));
    roots.push(root);
    await chmod(root, 0o700);
    const renders = join(root, "projects", "renders");
    await mkdir(renders, { recursive: true, mode: 0o700 });
    await chmod(join(root, "projects"), 0o700);
    await chmod(renders, 0o700);
    const target = join(renders, "project-1-r0-preview.mp4");
    await copyFile(candidate.outputPath, target, 0);
    await chmod(target, 0o600);
    try {
      const inspection = await inspectPrivatePreview({
        artifactRoot: root,
        relativePath: "projects/renders/project-1-r0-preview.mp4",
        projectId: "project-1",
        revision: 0,
        projectSha256: "a".repeat(64),
      });
      expect(inspection.evidence).toMatchObject({
        projectId: "project-1",
        revision: 0,
        projectSha256: "a".repeat(64),
        technicalQa: {
          decodeStatus: "passed",
          width: 1920,
          height: 1080,
          fps: 30,
          frameCount: 30,
          durationUs: 1_000_000,
        },
        contactSheet: { width: 960, height: 180, timestampsUs: [0, 500_000, 966_667] },
      });
      expect(inspection.image).toMatchObject({ mimeType: "image/png" });
      expect(Buffer.from(inspection.image.data, "base64").subarray(0, 8)).toEqual(
        Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      );
      expect(JSON.stringify(inspection.evidence)).not.toContain(root);
      expect(JSON.stringify(inspection.evidence)).not.toContain("base64");
    } finally {
      await cleanupRenderedFixtureCandidate(candidate);
    }
  }, 60_000);
});
