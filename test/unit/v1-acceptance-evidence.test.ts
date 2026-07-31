// biome-ignore-all lint/complexity/useLiteralKeys: Test fixtures intentionally mutate untrusted dictionary-shaped evidence.
import { describe, expect, it } from "vitest";

import {
  validateV1AcceptanceLedger,
  validateV1AcceptancePartialLedger,
} from "../../scripts/validate-v1-acceptance.mjs";

const digest = "a".repeat(64);
const workflowClasses = [
  "static-click",
  "spa-transition",
  "animated-scroll",
  "responsive-outputs",
] as const;

function validLedger(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    kind: "recordly-codex-v1-live-acceptance",
    candidateVersion: "1.0.0",
    bundleSha256: digest,
    runs: workflowClasses.flatMap((workflowClass, workflowIndex) =>
      [1, 2, 3].map((repetition) => ({
        schemaVersion: 1,
        runId: `${workflowClass}-${repetition}`,
        workflowClass,
        repetition,
        targetOrigin: `https://acceptance-${workflowIndex + 1}.example.com`,
        objectiveId: `${workflowClass}-objective`,
        occurredAt: `2026-08-${String(workflowIndex * 3 + repetition).padStart(2, "0")}T12:00:00.000Z`,
        execution: {
          surface: "codex-desktop-browser",
          pluginVersion: "1.0.0",
          codexDesktopVersion: "2026.801.1",
          nodeVersion: "24.4.0",
          ffmpegVersion: "7.1.1",
          operatingSystem: "macOS 15.6 arm64",
        },
        capture: {
          phase: "stopped",
          receivedFrames: 300,
          acceptedFrames: 300,
          ackedFrames: 300,
          rejectedFrames: 0,
          sealStatus: "approved",
        },
        delivery: {
          previewVerdict: "accept",
          judgmentStatus: "current",
          previewArtifactSha256: digest,
          finalArtifactSha256: digest,
          finalDigestVerified: true,
        },
        safety: {
          authorized: true,
          privateOrigin: false,
          requiredStopEncountered: false,
          sensitivePixelsObserved: false,
        },
        deviations: [],
      })),
    ),
  };
}

describe("v1 live acceptance evidence", () => {
  it("validates an incomplete privacy-safe ledger without treating it as final proof", () => {
    const partial = validLedger();
    partial["runs"] = (partial["runs"] as unknown[]).slice(0, 1);

    expect(validateV1AcceptancePartialLedger(partial)).toEqual({
      candidateVersion: "1.0.0",
      bundleSha256: digest,
      runCount: 1,
      workflowCount: 1,
      complete: false,
    });
    expect(() => validateV1AcceptanceLedger(partial)).toThrow(/12 runs/i);
  });

  it("accepts exactly three proven Codex Desktop Browser runs for each workflow class", () => {
    expect(validateV1AcceptanceLedger(validLedger())).toEqual({
      candidateVersion: "1.0.0",
      bundleSha256: digest,
      runCount: 12,
      workflowCount: 4,
    });
  });

  it("rejects incomplete or duplicate workflow repetitions", () => {
    const incomplete = validLedger();
    (incomplete["runs"] as unknown[]).pop();
    expect(() => validateV1AcceptanceLedger(incomplete)).toThrow(/12 runs/i);

    const duplicate = validLedger();
    const runs = duplicate["runs"] as Array<Record<string, unknown>>;
    runs[1] = { ...runs[0] };
    expect(() => validateV1AcceptanceLedger(duplicate)).toThrow(/runId|repetition/i);
  });

  it("rejects helper-only execution, private targets, frame loss, and unverified delivery", () => {
    const cases = [
      { path: ["execution", "surface"], value: "playwright-helper", error: /Desktop Browser/i },
      { path: ["targetOrigin"], value: "https://localhost", error: /public HTTPS origin/i },
      { path: ["capture", "rejectedFrames"], value: 1, error: /rejectedFrames/i },
      { path: ["capture", "ackedFrames"], value: 299, error: /frames/i },
      { path: ["delivery", "judgmentStatus"], value: "stale", error: /judgmentStatus/i },
      { path: ["delivery", "finalDigestVerified"], value: false, error: /finalDigestVerified/i },
      { path: ["safety", "requiredStopEncountered"], value: true, error: /requiredStop/i },
    ];

    for (const testCase of cases) {
      const ledger = validLedger();
      const first = (ledger["runs"] as Array<Record<string, unknown>>)[0] as Record<
        string,
        unknown
      >;
      let target = first;
      for (const key of testCase.path.slice(0, -1)) {
        target = target[key] as Record<string, unknown>;
      }
      target[testCase.path.at(-1) as string] = testCase.value;
      expect(() => validateV1AcceptanceLedger(ledger), testCase.path.join(".")).toThrow(
        testCase.error,
      );
    }
  });

  it("rejects extra fields so evidence cannot silently widen", () => {
    const ledger = validLedger();
    const first = (ledger["runs"] as Array<Record<string, unknown>>)[0] as Record<string, unknown>;
    first["rawUrl"] = "https://acceptance-1.example.com/private?token=secret";
    expect(() => validateV1AcceptanceLedger(ledger)).toThrow(/exactly/i);
  });
});
