import { describe, expect, it } from "vitest";
import {
  builtInRecordingProfiles,
  profileSnapshotSha256,
  validateRecordingProfileReference,
  validateRecordingProfileSnapshot,
} from "../../src/project/recording-profile.js";

function cleanBuiltin() {
  const profile = builtInRecordingProfiles().at(0);
  if (profile === undefined) throw new Error("clean built-in is missing");
  return profile;
}

describe("recording profile snapshots", () => {
  it("has deterministic validated built-ins", () => {
    const profiles = builtInRecordingProfiles();
    expect(profiles.map((profile) => profile.profileId)).toEqual(["clean", "product", "spotlight"]);
    for (const profile of profiles) {
      expect(validateRecordingProfileSnapshot(profile.snapshot)).toEqual(profile.snapshot);
      expect(profile.snapshotSha256).toMatch(/^[a-f0-9]{64}$/u);
    }
    expect(profiles.map((profile) => profile.snapshot.output.profile)).toEqual([
      "landscape-1080p",
      "square-1080",
      "vertical-1080",
    ]);
    expect(profiles[0]?.snapshot.defaultTransition).toEqual({
      family: "cut",
      durationUs: 0,
      easing: "linear",
    });
  });

  it("rejects unknown fields, unsafe text, and digest mismatches", () => {
    const profile = builtInRecordingProfiles()[0];
    expect(() =>
      validateRecordingProfileSnapshot({ ...profile?.snapshot, path: "/tmp/x" }),
    ).toThrow();
    expect(() =>
      validateRecordingProfileSnapshot({
        ...profile?.snapshot,
        visualLayout: { ...profile?.snapshot.visualLayout, localPath: "/tmp/webcam.mp4" },
      }),
    ).toThrow(/profile/i);
    expect(() =>
      validateRecordingProfileSnapshot({
        ...profile?.snapshot,
        audioDefaults: { ...profile?.snapshot.audioDefaults, sourceUrl: "https://example.test" },
      }),
    ).toThrow(/profile/i);
    expect(() =>
      validateRecordingProfileSnapshot({
        ...profile?.snapshot,
        frame: {
          ...profile?.snapshot.frame,
          background: { kind: "solid", color: "javascript:bad" },
        },
      }),
    ).toThrow();
  });

  it("rejects forged built-ins and isolates caller mutation", () => {
    const first = cleanBuiltin();
    const forged = {
      ...first,
      snapshot: {
        ...first.snapshot,
        frame: { ...first.snapshot.frame, paddingPx: first.snapshot.frame.paddingPx + 1 },
      },
    };
    expect(() => validateRecordingProfileReference(forged)).toThrow(/profile/i);

    first.snapshot.frame.paddingPx = 99;
    const later = cleanBuiltin();
    expect(later.snapshot.frame.paddingPx).not.toBe(99);
    expect(profileSnapshotSha256(later.snapshot)).toBe(later.snapshotSha256);
  });

  it("validates owner-local references without consulting built-ins", () => {
    const builtin = cleanBuiltin();
    const snapshot = {
      ...builtin.snapshot,
      output: {
        profile: "vertical-1080" as const,
        format: "gif" as const,
        quality: "draft" as const,
      },
      frame: {
        ...builtin.snapshot.frame,
        background: { kind: "gradient" as const, startColor: "#0f172a", endColor: "#1d4ed8" },
      },
      defaultTransition: {
        family: "wipe-left" as const,
        durationUs: 250_000,
        easing: "ease-out" as const,
      },
      audioDefaults: {
        role: "bed" as const,
        gainDb: -18,
        fadeInUs: 250_000,
        fadeOutUs: 250_000,
        ducking: "against-primary" as const,
      },
    };
    const ownerLocal = {
      ...builtin,
      source: "owner-local" as const,
      profileId: "team-demo",
      profileRevision: 7,
      snapshot,
      snapshotSha256: profileSnapshotSha256(snapshot),
    };
    expect(validateRecordingProfileReference(ownerLocal)).toEqual(ownerLocal);
    expect(() =>
      validateRecordingProfileReference({ ...ownerLocal, snapshotSha256: "0".repeat(64) }),
    ).toThrow(/profile/i);
  });
});
