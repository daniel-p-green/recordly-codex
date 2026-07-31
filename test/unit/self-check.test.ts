import { describe, expect, it } from "vitest";

import {
  evaluateMediaVersions,
  evaluateNodeVersion,
  parseSemanticVersion,
} from "../../scripts/self-check.mjs";

describe("read-only v1 self-check policy", () => {
  it("accepts only the Node release lines exercised by the v1 CI contract", () => {
    expect(evaluateNodeVersion("v22.17.0")).toMatchObject({ ok: true });
    expect(evaluateNodeVersion("v22.16.9")).toMatchObject({ ok: false });
    expect(evaluateNodeVersion("v24.4.0")).toMatchObject({ ok: true });
    expect(evaluateNodeVersion("v23.11.1")).toMatchObject({ ok: false });
    expect(evaluateNodeVersion("v26.5.0")).toMatchObject({ ok: false });
  });

  it("requires bounded matching FFmpeg and FFprobe release lines", () => {
    expect(
      evaluateMediaVersions("ffmpeg version 6.1.1 Copyright", "ffprobe version 6.1.1 Copyright"),
    ).toMatchObject({ ok: true, ffmpegVersion: "6.1.1", ffprobeVersion: "6.1.1" });
    expect(
      evaluateMediaVersions("ffmpeg version 8.1.2 Copyright", "ffprobe version 8.0 Copyright"),
    ).toMatchObject({ ok: true });
    expect(
      evaluateMediaVersions("ffmpeg version 5.1.6 Copyright", "ffprobe version 5.1.6 Copyright"),
    ).toMatchObject({ ok: false });
    expect(
      evaluateMediaVersions("ffmpeg version 8.1.2 Copyright", "ffprobe version 7.1.1 Copyright"),
    ).toMatchObject({ ok: false });
  });

  it("parses canonical semantic versions without accepting partial values", () => {
    expect(parseSemanticVersion("v24.4.0")).toEqual({ major: 24, minor: 4, patch: 0 });
    expect(() => parseSemanticVersion("24")).toThrow(/semantic version/i);
    expect(() => parseSemanticVersion("24.4.0-beta")).toThrow(/semantic version/i);
  });
});
