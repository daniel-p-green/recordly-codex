import { createHash } from "node:crypto";
import { access, readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { cleanupLocalSiteE2E, runLocalSiteE2E } from "./support/local-site-recording.js";

describe("local public-site recording fixture", () => {
  it("captures opening, action, and result evidence without external network access", async () => {
    const recording = await runLocalSiteE2E();
    try {
      expect(recording.states).toEqual(["opening", "action", "result"]);
      expect(recording.loopbackRequests).toEqual(["/"]);
      expect(recording.externalRequests).toEqual([]);
      expect(recording.compiled.timeline.qa.status).toBe("ready");
      expect(recording.compiled.manifest.artifacts).toHaveLength(3);
      expect(recording.compiled.manifest.events.map((event) => event.type)).toEqual(
        expect.arrayContaining(["frame", "pointer", "click", "marker", "capture_health"]),
      );
      expect(recording.video).toEqual({
        width: 1920,
        height: 1080,
        pixelFormat: "yuv420p",
        colorRange: "tv",
        fps: 30,
        frameCount: 30,
        durationSeconds: 1,
        hasAudio: false,
      });
      await access(recording.outputPath);
      await access(recording.manifestPath);
      await access(recording.telemetryPath);
      expect(recording.manifestSha256).toMatch(/^[a-f0-9]{64}$/);
      expect(JSON.parse(await readFile(recording.manifestPath, "utf8"))).toMatchObject({
        schemaVersion: 1,
        artifacts: expect.arrayContaining([expect.objectContaining({ frameId: 3 })]),
      });
      expect(
        createHash("sha256")
          .update(await readFile(recording.sampleFramePath))
          .digest("hex"),
      ).toMatch(/^[a-f0-9]{64}$/);
    } finally {
      await cleanupLocalSiteE2E(recording);
    }
  }, 90_000);
});
