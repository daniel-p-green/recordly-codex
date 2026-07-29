import { describe, expect, it } from "vitest";

import {
  compileLegacyPresentationAudioFilter,
  compileProfessionalAudioFilter,
  PRESENTATION_DUCKING,
  type PresentationAudioTrack,
} from "../../src/encoder/presentation.js";

const professionalTracks = (): readonly [PresentationAudioTrack, PresentationAudioTrack] => [
  {
    path: "/private/input-primary.wav;[unsafe]",
    startUs: 0,
    trim: { startUs: 0, endUs: 2_000_000 },
    gainDb: -3,
    role: "primary",
    pan: -1,
    fadeInUs: 100_000,
    fadeOutUs: 200_000,
    ducking: "none",
  },
  {
    path: "/private/input-bed.wav",
    startUs: 500_000,
    trim: { startUs: 0, endUs: 2_000_000 },
    gainDb: -12,
    role: "bed",
    pan: 1,
    fadeInUs: 0,
    fadeOutUs: 0,
    ducking: "against-primary",
  },
];

describe("professional presentation audio filter", () => {
  it("preserves the V1 gain/delay/amix recipe exactly", () => {
    expect(
      compileLegacyPresentationAudioFilter([
        { startUs: 0, gainDb: -3 },
        { startUs: 25_000, gainDb: -6 },
      ]),
    ).toBe(
      "[1:a]asetpts=PTS-STARTPTS,volume=-3dB,adelay=0:all=1[a0];[2:a]asetpts=PTS-STARTPTS,volume=-6dB,adelay=25:all=1[a1];[a0][a1]amix=inputs=2:normalize=0[a]",
    );
  });

  it("compiles deterministic 48 kHz stereo pan, fade, ducking, and limiter controls", () => {
    const first = compileProfessionalAudioFilter(professionalTracks());
    const second = compileProfessionalAudioFilter(professionalTracks());

    expect(first).toBe(second);
    expect(first).toContain("aformat=sample_rates=48000:channel_layouts=stereo");
    expect(first).toContain("pan=stereo|c0=1.000000*c0|c1=0.000000*c1");
    expect(first).toContain("pan=stereo|c0=0.000000*c0|c1=1.000000*c1");
    expect(first).toContain("afade=t=in:st=0:d=0.100000");
    expect(first).toContain("afade=t=out:st=1.800000:d=0.200000");
    expect(first).toContain(
      `sidechaincompress=threshold=${PRESENTATION_DUCKING.threshold}:ratio=${PRESENTATION_DUCKING.ratio}:attack=${PRESENTATION_DUCKING.attackMs}:release=${PRESENTATION_DUCKING.releaseMs}`,
    );
    expect(first).toContain("[p0mix]anull[primary]");
    expect(first).toContain("alimiter=limit=0.6");
    expect(first).not.toContain("/private/input-primary.wav");

    const centered = compileProfessionalAudioFilter(
      professionalTracks().map((track) => ({ ...track, pan: 0 })),
    );
    expect(centered).toContain("pan=stereo|c0=0.707107*c0|c1=0.707107*c1");
  });

  it("fails closed when ducking has no primary sidechain", () => {
    const tracks: readonly PresentationAudioTrack[] = professionalTracks().map((track) => ({
      ...track,
      role: "bed" as const,
    }));

    expect(() => compileProfessionalAudioFilter(tracks)).toThrow(/requires a primary/u);
  });

  it("fails closed for partial V2 controls and fans out multiple primary sidechains", () => {
    expect(() =>
      compileProfessionalAudioFilter([
        ...professionalTracks(),
        {
          path: "/private/legacy.wav",
          startUs: 0,
          trim: { startUs: 0, endUs: 2_000_000 },
          gainDb: 0,
        },
      ]),
    ).toThrow(/professional audio mix/u);

    const [primary, bed] = professionalTracks();
    const graph = compileProfessionalAudioFilter([
      primary,
      bed,
      {
        ...primary,
        path: "/private/second-primary.wav",
        role: "primary",
        ducking: "none",
      },
      {
        ...bed,
        path: "/private/second-bed.wav",
        role: "effect",
        ducking: "against-primary",
      },
    ]);
    expect(graph).toContain("amix=inputs=2:normalize=0[primary]");
    expect(graph).toContain("[primary]asplit=2[side1][side3]");
  });
});
