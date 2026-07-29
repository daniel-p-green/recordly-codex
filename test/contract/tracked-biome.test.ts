import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runTrackedBiome, trackedBiomeFiles } from "../../scripts/run-tracked-biome.mjs";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
describe("tracked Biome selector", () => {
  it("passes only tracked supported files and propagates Biome failure", async () => {
    const root = await mkdtemp(join(tmpdir(), "recordly-tracked-biome-"));
    roots.push(root);
    execFileSync("git", ["init"], { cwd: root });
    await writeFile(join(root, "tracked.ts"), "export const good = true;\n");
    await writeFile(join(root, "ugly 2.ts"), "{ bad\n");
    await writeFile(join(root, "ignored.bin"), "x");
    execFileSync("git", ["add", "tracked.ts"], { cwd: root });
    expect(trackedBiomeFiles(root)).toEqual(["tracked.ts"]);
    const run = vi.fn((file: string, args: string[]) => {
      if (file !== "git") throw new Error(`bad tracked path: ${args.join(" ")}`);
      return Buffer.from("tracked.ts\0");
    });
    expect(() =>
      runTrackedBiome({ root, command: "lint", biome: "fake-biome", run: run as never }),
    ).toThrow(/bad tracked path/);
    expect(run.mock.calls[1]?.[1]).toEqual(["lint", "tracked.ts"]);
  });
  it("fails closed outside a Git worktree", async () => {
    const root = await mkdtemp(join(tmpdir(), "recordly-no-git-"));
    roots.push(root);
    await mkdir(join(root, "src"));
    expect(() => trackedBiomeFiles(root)).toThrow(/Git worktree/i);
  });
});
