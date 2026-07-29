import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { MEDIA_PROCESS_POLICY, runMediaProcess } from "../../src/encoder/media-process.js";

const fixturePath = fileURLToPath(new URL("../support/media-process-fixture.mjs", import.meta.url));

describe("bounded local media processes", () => {
  it("kills a noisy non-exiting process, bounds its diagnostic, and frees its permit", async () => {
    const started = Date.now();
    let failure: Error | undefined;
    try {
      await runMediaProcess({
        executable: process.execPath,
        args: [fixturePath, "overflow"],
        label: "overflow fixture",
        timeoutMs: 100,
        terminateGraceMs: 75,
        maxOutputBytes: 1_024,
      });
    } catch (error) {
      failure = error as Error;
    }
    expect(failure?.message).toMatch(/output exceeded|timed out/u);
    expect(failure?.message.length).toBeLessThanOrEqual(1_400);
    expect(Date.now() - started).toBeLessThan(2_000);

    await expect(
      runMediaProcess({
        executable: process.execPath,
        args: [fixturePath, "succeed"],
        label: "following fixture",
        timeoutMs: 1_000,
      }),
    ).resolves.toMatchObject({ stdout: "completed" });
  });

  it("uses a fair shared cap and releases a permit after SIGKILL fallback", async () => {
    const controllers = [new AbortController(), new AbortController()];
    const blocked = controllers.map((controller) =>
      runMediaProcess({
        executable: process.execPath,
        args: [fixturePath, "hang"],
        label: "hanging fixture",
        timeoutMs: 5_000,
        terminateGraceMs: 75,
        signal: controller.signal,
      }),
    );
    const following = runMediaProcess({
      executable: process.execPath,
      args: [fixturePath, "succeed"],
      label: "queued fixture",
      timeoutMs: 1_000,
    });

    await new Promise<void>((resolve) => setTimeout(resolve, 75));
    controllers[0]?.abort();
    await expect(blocked[0]).rejects.toThrow(/cancelled/u);
    await expect(following).resolves.toMatchObject({ stdout: "completed" });
    controllers[1]?.abort();
    await expect(blocked[1]).rejects.toThrow(/cancelled/u);
    expect(MEDIA_PROCESS_POLICY.maxConcurrent).toBeGreaterThanOrEqual(2);
  });
});
