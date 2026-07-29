import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { encodePresentationFrames } from "../../src/encoder/presentation.js";
import { probeRenderedVideo } from "../../src/encoder/probe.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function toneWav(
  frequencyHz: number,
  durationUs: number,
  amplitude = 12_000,
  activeRangeUs?: { startUs: number; endUs: number },
): Buffer {
  const sampleRate = 48_000;
  const samples = Math.round((durationUs * sampleRate) / 1_000_000);
  const wav = Buffer.alloc(44 + samples * 4);
  wav.write("RIFF", 0, "ascii");
  wav.writeUInt32LE(wav.length - 8, 4);
  wav.write("WAVEfmt ", 8, "ascii");
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(2, 22);
  wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(sampleRate * 4, 28);
  wav.writeUInt16LE(4, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36, "ascii");
  wav.writeUInt32LE(samples * 4, 40);
  for (let index = 0; index < samples; index += 1) {
    const tUs = Math.round((index * 1_000_000) / sampleRate);
    const active =
      activeRangeUs === undefined || (tUs >= activeRangeUs.startUs && tUs < activeRangeUs.endUs);
    const value = active
      ? Math.round(Math.sin((2 * Math.PI * frequencyHz * index) / sampleRate) * amplitude)
      : 0;
    wav.writeInt16LE(value, 44 + index * 4);
    wav.writeInt16LE(value, 46 + index * 4);
  }
  return wav;
}

function decodeStereoPcm(path: string): Float32Array {
  const pcm = execFileSync(
    "ffmpeg",
    ["-v", "error", "-i", path, "-f", "f32le", "-ac", "2", "-ar", "48000", "pipe:1"],
    { encoding: "buffer", maxBuffer: 16 * 1024 * 1024 },
  );
  const values = new Float32Array(pcm.buffer, pcm.byteOffset, Math.floor(pcm.length / 4));
  return Float32Array.from(values);
}

function channelRms(pcm: Float32Array, startUs: number, endUs: number, channel: 0 | 1): number {
  const start = Math.max(0, Math.floor((startUs * 48_000) / 1_000_000));
  const end = Math.min(Math.floor((endUs * 48_000) / 1_000_000), Math.floor(pcm.length / 2));
  let sum = 0;
  for (let index = start; index < end; index += 1) {
    const value = pcm[index * 2 + channel] ?? 0;
    sum += value * value;
  }
  return Math.sqrt(sum / Math.max(1, end - start));
}

function peak(pcm: Float32Array): number {
  return pcm.reduce((maximum, value) => Math.max(maximum, Math.abs(value)), 0);
}

async function encodeMix(
  root: string,
  outputName: string,
  durationUs: number,
  audioTracks: Parameters<typeof encodePresentationFrames>[0]["audioTracks"],
): Promise<string> {
  const outputPath = join(root, outputName);
  await encodePresentationFrames({
    frames: Array.from({ length: Math.ceil((durationUs * 30) / 1_000_000) }, () =>
      Buffer.alloc(2 * 2 * 3),
    ),
    width: 2,
    height: 2,
    fps: 30,
    format: "mp4",
    quality: "draft",
    durationUs,
    outputPath,
    ...(audioTracks === undefined ? {} : { audioTracks }),
  });
  return outputPath;
}

describe("professional presentation audio encoding", () => {
  it("writes only deterministic safe metadata when requested and always encodes limited range", async () => {
    const root = await mkdtemp(join(tmpdir(), "recordly-export-metadata-"));
    roots.push(root);
    const frames = [Buffer.alloc(2 * 2 * 3), Buffer.alloc(2 * 2 * 3), Buffer.alloc(2 * 2 * 3)];
    const minimal = join(root, "minimal.mp4");
    const none = join(root, "none.mp4");
    for (const [outputPath, metadata] of [
      [minimal, "minimal"],
      [none, "none"],
    ] as const) {
      await encodePresentationFrames({
        frames,
        width: 2,
        height: 2,
        fps: 30,
        format: "mp4",
        quality: "draft",
        durationUs: 100_000,
        outputPath,
        colorRange: "limited",
        metadata,
      });
    }
    const formatTags = (
      path: string,
    ): Record<string, string> & { title?: string; comment?: string } => {
      const value = JSON.parse(
        execFileSync(
          "ffprobe",
          ["-v", "error", "-show_entries", "format_tags", "-of", "json", path],
          { encoding: "utf8" },
        ),
      ) as { format?: { tags?: Record<string, string> } };
      return value.format?.tags ?? {};
    };
    const minimalTags = formatTags(minimal);
    const noneTags = formatTags(none);
    expect(minimalTags.title).toBe("Recordly recording");
    expect(minimalTags.comment).toBe("Generated locally");
    expect(JSON.stringify(minimalTags)).not.toContain(root);
    expect(noneTags.title).toBeUndefined();
    expect(noneTags.comment).toBeUndefined();
    expect(await probeRenderedVideo(minimal)).toMatchObject({ colorRange: "tv", hasAudio: false });
    expect(await probeRenderedVideo(none)).toMatchObject({ colorRange: "tv", hasAudio: false });
  }, 30_000);

  it("decodes a deterministic 48 kHz stereo limited V2 mix", async () => {
    const root = await mkdtemp(join(tmpdir(), "recordly-audio-mix-"));
    roots.push(root);
    const durationUs = 200_000;
    const primaryPath = join(root, "primary.wav");
    const bedPath = join(root, "bed.wav");
    const outputPath = join(root, "mix.mp4");
    await writeFile(primaryPath, toneWav(440, durationUs));
    await writeFile(bedPath, toneWav(220, durationUs));

    await encodeMix(root, "mix.mp4", durationUs, [
      {
        path: primaryPath,
        startUs: 0,
        trim: { startUs: 0, endUs: durationUs },
        gainDb: 0,
        role: "primary",
        pan: -1,
        fadeInUs: 20_000,
        fadeOutUs: 20_000,
        ducking: "none",
      },
      {
        path: bedPath,
        startUs: 0,
        trim: { startUs: 0, endUs: durationUs },
        gainDb: 0,
        role: "bed",
        pan: 1,
        fadeInUs: 0,
        fadeOutUs: 0,
        ducking: "against-primary",
      },
    ]);

    expect((await readFile(outputPath)).subarray(4, 8).toString("ascii")).toBe("ftyp");
    expect(
      execFileSync(
        "ffprobe",
        [
          "-v",
          "error",
          "-select_streams",
          "a:0",
          "-show_entries",
          "stream=sample_rate,channels",
          "-of",
          "csv=p=0",
          outputPath,
        ],
        { encoding: "utf8" },
      ).trim(),
    ).toBe("48000,2");
  }, 30_000);

  it("applies start/trim, gain, fade, and equal-power pan inside the presentation duration", async () => {
    const root = await mkdtemp(join(tmpdir(), "recordly-audio-envelope-"));
    roots.push(root);
    const source = join(root, "tone.wav");
    await writeFile(source, toneWav(440, 300_000));
    const output = await encodeMix(root, "envelope.mp4", 500_000, [
      {
        path: source,
        startUs: 100_000,
        trim: { startUs: 0, endUs: 300_000 },
        gainDb: -6,
        role: "primary",
        pan: -1,
        fadeInUs: 100_000,
        fadeOutUs: 100_000,
        ducking: "none",
      },
    ]);
    const pcm = decodeStereoPcm(output);
    const silent = channelRms(pcm, 10_000, 70_000, 0);
    const fadeIn = channelRms(pcm, 130_000, 170_000, 0);
    const middle = channelRms(pcm, 220_000, 260_000, 0);
    const fadeOut = channelRms(pcm, 330_000, 370_000, 0);

    expect(silent).toBeLessThan(0.01);
    expect(middle).toBeGreaterThan(fadeIn * 1.7);
    expect(middle).toBeGreaterThan(fadeOut * 1.7);
    expect(middle).toBeLessThan(0.3);
    expect(middle).toBeGreaterThan(channelRms(pcm, 220_000, 260_000, 1) * 8);
    expect(channelRms(pcm, 440_000, 480_000, 0)).toBeLessThan(0.01);
  }, 30_000);

  it("ducks a right-panned bed during primary activity, recovers, and limits peaks", async () => {
    const root = await mkdtemp(join(tmpdir(), "recordly-audio-duck-"));
    roots.push(root);
    const durationUs = 900_000;
    const primary = join(root, "primary.wav");
    const bed = join(root, "bed.wav");
    await writeFile(
      primary,
      toneWav(440, durationUs, 18_000, { startUs: 200_000, endUs: 400_000 }),
    );
    await writeFile(bed, toneWav(220, durationUs, 28_000));
    const output = await encodeMix(root, "duck.mp4", durationUs, [
      {
        path: primary,
        startUs: 0,
        trim: { startUs: 0, endUs: durationUs },
        gainDb: 6,
        role: "primary",
        pan: -1,
        fadeInUs: 0,
        fadeOutUs: 0,
        ducking: "none",
      },
      {
        path: bed,
        startUs: 0,
        trim: { startUs: 0, endUs: durationUs },
        gainDb: 6,
        role: "bed",
        pan: 1,
        fadeInUs: 0,
        fadeOutUs: 0,
        ducking: "against-primary",
      },
    ]);
    const pcm = decodeStereoPcm(output);
    const before = channelRms(pcm, 80_000, 160_000, 1);
    const ducked = channelRms(pcm, 300_000, 380_000, 1);
    const recovered = channelRms(pcm, 780_000, 850_000, 1);

    expect(ducked).toBeLessThan(before * 0.75);
    expect(recovered, `pcmFrames=${pcm.length / 2}`).toBeGreaterThan(ducked * 1.3);
    expect(peak(pcm)).toBeLessThanOrEqual(0.99);
  }, 30_000);

  it("keeps ducking recovery deterministic across concurrent encodes", async () => {
    const root = await mkdtemp(join(tmpdir(), "recordly-audio-duck-concurrent-"));
    roots.push(root);
    const durationUs = 900_000;
    const primary = join(root, "primary.wav");
    const bed = join(root, "bed.wav");
    await writeFile(
      primary,
      toneWav(440, durationUs, 18_000, { startUs: 200_000, endUs: 400_000 }),
    );
    await writeFile(bed, toneWav(220, durationUs, 28_000));
    const tracks = [
      {
        path: primary,
        startUs: 0,
        trim: { startUs: 0, endUs: durationUs },
        gainDb: 6,
        role: "primary" as const,
        pan: -1,
        fadeInUs: 0,
        fadeOutUs: 0,
        ducking: "none" as const,
      },
      {
        path: bed,
        startUs: 0,
        trim: { startUs: 0, endUs: durationUs },
        gainDb: 6,
        role: "bed" as const,
        pan: 1,
        fadeInUs: 0,
        fadeOutUs: 0,
        ducking: "against-primary" as const,
      },
    ];
    const outputs = await Promise.all(
      Array.from({ length: 4 }, (_value, index) =>
        encodeMix(root, `duck-${index}.mp4`, durationUs, tracks),
      ),
    );

    for (const output of outputs) {
      const pcm = decodeStereoPcm(output);
      const before = channelRms(pcm, 80_000, 160_000, 1);
      const ducked = channelRms(pcm, 300_000, 380_000, 1);
      const recovered = channelRms(pcm, 780_000, 850_000, 1);
      expect(ducked).toBeLessThan(before * 0.75);
      expect(recovered).toBeGreaterThan(ducked * 1.3);
      expect(peak(pcm)).toBeLessThanOrEqual(0.99);
    }
  }, 30_000);
});
