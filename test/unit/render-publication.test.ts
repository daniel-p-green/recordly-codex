import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  createRenderPublication,
  publishThenCompareAndSwap,
} from "../../mcp/render-publication.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("private render publication", () => {
  it("does not chmod a symlinked ancestor before rejecting it", async () => {
    const root = await mkdtemp(join(tmpdir(), "recordly-render-publication-"));
    const external = await mkdtemp(join(tmpdir(), "recordly-render-external-"));
    roots.push(root, external);
    await chmod(external, 0o755);
    await symlink(external, join(root, "projects"));

    await expect(
      createRenderPublication({ artifactRoot: root, fileName: "project-r0-preview.mp4" }),
    ).rejects.toThrow(/private|symlink|escape/i);
    expect((await stat(external)).mode & 0o777).toBe(0o755);
  });

  it("refuses a symlinked render root or publication destination", async () => {
    const root = await mkdtemp(join(tmpdir(), "recordly-render-publication-"));
    const external = await mkdtemp(join(tmpdir(), "recordly-render-external-"));
    roots.push(root, external);
    await writeFile(join(external, "outside.mp4"), "unchanged");
    await mkdir(join(root, "projects"), { mode: 0o700 });
    await symlink(external, join(root, "projects", "renders"));
    await expect(
      createRenderPublication({
        artifactRoot: root,
        fileName: "project-r0-preview.mp4",
      }),
    ).rejects.toThrow(/private|symlink|escape/i);

    await rm(join(root, "projects", "renders"));
    const publication = await createRenderPublication({
      artifactRoot: root,
      fileName: "project-r0-preview.mp4",
    });
    expect(publication.temporaryPath).toMatch(/\.tmp\.mp4$/u);
    await writeFile(publication.temporaryPath, "candidate", { mode: 0o600 });
    await symlink(join(external, "outside.mp4"), publication.outputPath);
    let casCalls = 0;
    await expect(publication.publish()).rejects.toThrow(/symlink/i);
    await expect(
      publishThenCompareAndSwap(publication, async () => {
        casCalls += 1;
      }),
    ).rejects.toThrow(/symlink/i);
    expect(casCalls).toBe(0);
    expect(await readFile(join(external, "outside.mp4"), "utf8")).toBe("unchanged");
    expect((await lstat(publication.temporaryPath)).isFile()).toBe(true);
    await publication.cleanup();
  });

  it("removes only its own published candidate when CAS fails after publication", async () => {
    const root = await mkdtemp(join(tmpdir(), "recordly-render-publication-"));
    roots.push(root);
    const publication = await createRenderPublication({
      artifactRoot: root,
      fileName: "project-r0-preview.mp4",
    });
    await writeFile(publication.temporaryPath, "candidate", { mode: 0o600 });
    await expect(
      publishThenCompareAndSwap(publication, async () => {
        throw new RangeError("stale project revision");
      }),
    ).rejects.toThrow(/stale/i);
    await expect(lstat(publication.outputPath)).rejects.toMatchObject({ code: "ENOENT" });
    await publication.cleanup();
  });
});
