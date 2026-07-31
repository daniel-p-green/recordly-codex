import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

describe("candidate v1 host support contract", () => {
  it("matches the reviewed Desktop, runtime, media, and CI boundaries", () => {
    const actual = JSON.parse(
      readFileSync("contracts/host-support-v1-candidate.json", "utf8"),
    ) as unknown;

    expect(actual).toEqual({
      schemaVersion: 1,
      candidateVersion: "1.0.0",
      productHost: {
        surface: "codex-desktop-browser",
        platform: "darwin",
        architecture: "arm64",
        observedBaseline: {
          operatingSystem: "macOS 26.5.2",
          codexDesktopVersion: "26.715.31251",
        },
        proofStatus: "live-acceptance-required",
      },
      runtime: {
        node: {
          supportedMajors: [22, 24],
          minimum: "22.17.0",
        },
        ffmpeg: {
          minimum: "6.1.1",
          maximumMajor: 8,
          requireMatchingFfprobeMajor: true,
        },
        artifactStorage: "private-owner-local",
        loopback: "127.0.0.1-ephemeral",
      },
      ci: {
        operatingSystem: "ubuntu-latest",
        architecture: "x64",
        nodeMajors: [22, 24],
        requiredJobs: ["quality-node-22", "quality-node-24", "plugin-contract"],
        consecutiveMainRunsRequired: 3,
      },
      unsupported: [
        "codex-cli-browser-control",
        "codex-ide-browser-control",
        "windows-product-host",
        "native-display-or-window-capture",
      ],
    });
  });
});
