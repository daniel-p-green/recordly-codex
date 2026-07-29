import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createPrivateAudioNormalizer,
  type MediaCommandRunner,
  normalizedAudioRecipeKey,
} from "../../src/media/private-audio-normalization.js";
import { createPrivateMediaLibrary } from "../../src/media/private-media-library.js";

const roots: string[] = [];

async function temporaryRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

function wav(sampleRate: number, channels: number, samples: number): Buffer {
  const bytesPerSample = 2;
  const dataBytes = samples * channels * bytesPerSample;
  const result = Buffer.alloc(44 + dataBytes);
  result.write("RIFF", 0, "ascii");
  result.writeUInt32LE(36 + dataBytes, 4);
  result.write("WAVEfmt ", 8, "ascii");
  result.writeUInt32LE(16, 16);
  result.writeUInt16LE(1, 20);
  result.writeUInt16LE(channels, 22);
  result.writeUInt32LE(sampleRate, 24);
  result.writeUInt32LE(sampleRate * channels * bytesPerSample, 28);
  result.writeUInt16LE(channels * bytesPerSample, 32);
  result.writeUInt16LE(16, 34);
  result.write("data", 36, "ascii");
  result.writeUInt32LE(dataBytes, 40);
  return result;
}

function audioProbeJson(input: { sampleRate: number; channels: number; duration: number }): string {
  return JSON.stringify({
    streams: [
      {
        codec_type: "audio",
        codec_name: "pcm_s16le",
        sample_rate: String(input.sampleRate),
        channels: input.channels,
        duration: input.duration.toFixed(6),
      },
    ],
    format: { duration: input.duration.toFixed(6), format_name: "wav" },
  });
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("private audio probing and normalization", () => {
  it("uses the versioned normalization recipe as part of output identity", () => {
    expect(normalizedAudioRecipeKey).toBe("recordly-codex-normalized-audio-v1");
  });

  it("decodes a generated WAV through the fixed ffprobe and ffmpeg toolchain", async () => {
    const root = await temporaryRoot("recordly-private-audio-real-tools-");
    const authorizedRoot = join(root, "authorized");
    const libraryRoot = join(root, "library");
    const outputRoot = join(root, "normalized");
    await mkdir(authorizedRoot, { mode: 0o700 });
    await mkdir(libraryRoot, { mode: 0o700 });
    await mkdir(outputRoot, { mode: 0o700 });
    await writeFile(join(authorizedRoot, "voice.wav"), wav(24_000, 1, 2400), { mode: 0o600 });
    const library = await createPrivateMediaLibrary({ libraryRoot });
    const media = await library.ingest({
      authorizedRoot,
      relativePath: "voice.wav",
      maximumBytes: 1024 * 1024,
    });
    const normalizer = await createPrivateAudioNormalizer({ libraryRoot });

    await expect(normalizer.probe({ media })).resolves.toMatchObject({
      codec: "pcm_s16le",
      sampleRate: 24_000,
      channels: 1,
      durationSeconds: 0.1,
    });
    await expect(normalizer.normalize({ media, outputRoot })).resolves.toMatchObject({
      audioId: expect.stringMatching(/^audio_[a-f0-9]{32}$/u),
      durationSeconds: 0.1,
      sampleRate: 48_000,
      channels: 2,
    });
  });

  it("validates a stored audio reference and publishes one deterministic 48 kHz stereo WAV", async () => {
    const root = await temporaryRoot("recordly-private-audio-");
    const authorizedRoot = join(root, "authorized");
    const libraryRoot = join(root, "library");
    const outputRoot = join(root, "normalized");
    await mkdir(authorizedRoot, { mode: 0o700 });
    await mkdir(libraryRoot, { mode: 0o700 });
    await mkdir(outputRoot, { mode: 0o700 });
    await writeFile(join(authorizedRoot, "voice.wav"), wav(24_000, 1, 240), { mode: 0o600 });
    const library = await createPrivateMediaLibrary({ libraryRoot });
    const media = await library.ingest({
      authorizedRoot,
      relativePath: "voice.wav",
      maximumBytes: 1024 * 1024,
    });
    const commandRunner = vi.fn<MediaCommandRunner>(async ({ executable, args }) => {
      expect(executable).toMatch(/^\/private\/tools\/ff/u);
      const protocolIndex = args.indexOf("-protocol_whitelist");
      expect(protocolIndex).toBeGreaterThanOrEqual(0);
      expect(args[protocolIndex + 1]).toBe("file");
      if (executable.endsWith("ffprobe")) {
        const inputPath = args.at(-1);
        expect(protocolIndex).toBeLessThan(args.lastIndexOf(inputPath as string));
        return {
          stdout:
            inputPath?.includes(".normalize-") || inputPath?.includes("/normalized/")
              ? audioProbeJson({ sampleRate: 48_000, channels: 2, duration: 0.01 })
              : audioProbeJson({ sampleRate: 24_000, channels: 1, duration: 0.01 }),
          stderr: "",
        };
      }
      expect(protocolIndex).toBeLessThan(args.indexOf("-i"));
      await writeFile(args.at(-1) as string, wav(48_000, 2, 480), { mode: 0o600 });
      return { stdout: "", stderr: "" };
    });
    const normalizer = await createPrivateAudioNormalizer({
      libraryRoot,
      toolchain: {
        resolveExecutable: async (name) => `/private/tools/${name}`,
        commandRunner,
      },
    });

    await expect(normalizer.probe({ media })).resolves.toMatchObject({
      sampleRate: 24_000,
      channels: 1,
      durationSeconds: 0.01,
    });
    const first = await normalizer.normalize({ media, outputRoot });
    const repeated = await normalizer.normalize({ media, outputRoot });

    expect(repeated).toEqual(first);
    expect(first).toEqual({
      audioId: expect.stringMatching(/^audio_[a-f0-9]{32}$/u),
      sha256: createHash("sha256")
        .update(wav(48_000, 2, 480))
        .digest("hex"),
      byteLength: 1964,
      durationSeconds: 0.01,
      sampleRate: 48_000,
      channels: 2,
    });
    expect(JSON.stringify(first)).not.toContain(root);
    expect(
      commandRunner.mock.calls.filter(([input]) => input.executable.endsWith("ffmpeg")),
    ).toHaveLength(1);
    expect(commandRunner.mock.calls[0]?.[0]).toMatchObject({
      timeoutMs: 15_000,
      maximumOutputBytes: 64 * 1024,
    });
    expect(await readFile(join(outputRoot, `${first.audioId}.wav`))).toEqual(wav(48_000, 2, 480));

    const metadataPath = join(outputRoot, `${first.audioId}.json`);
    const normalizedMetadata = JSON.parse(await readFile(metadataPath, "utf8")) as object;
    await writeFile(
      metadataPath,
      JSON.stringify({ ...normalizedMetadata, privateOutputPath: outputRoot }),
      { mode: 0o600 },
    );
    await expect(normalizer.normalize({ media, outputRoot })).rejects.toThrow(/metadata|invalid/i);
  });

  it("removes partial private output when ffmpeg times out", async () => {
    const root = await temporaryRoot("recordly-private-audio-timeout-");
    const authorizedRoot = join(root, "authorized");
    const libraryRoot = join(root, "library");
    const outputRoot = join(root, "normalized");
    await mkdir(authorizedRoot, { mode: 0o700 });
    await mkdir(libraryRoot, { mode: 0o700 });
    await mkdir(outputRoot, { mode: 0o700 });
    await writeFile(join(authorizedRoot, "voice.wav"), wav(48_000, 2, 480), { mode: 0o600 });
    const library = await createPrivateMediaLibrary({ libraryRoot });
    const media = await library.ingest({
      authorizedRoot,
      relativePath: "voice.wav",
      maximumBytes: 1024 * 1024,
    });
    const normalizer = await createPrivateAudioNormalizer({
      libraryRoot,
      toolchain: {
        resolveExecutable: async (name) => `/private/tools/${name}`,
        commandRunner: async ({ executable, args }) => {
          if (executable.endsWith("ffprobe")) {
            return {
              stdout: audioProbeJson({ sampleRate: 48_000, channels: 2, duration: 0.01 }),
              stderr: "",
            };
          }
          await writeFile(args.at(-1) as string, "partial output", { mode: 0o600 });
          throw new Error("tool timed out");
        },
      },
    });

    await expect(normalizer.normalize({ media, outputRoot })).rejects.toThrow(/failed|timeout/i);
    await expect(readdir(outputRoot)).resolves.toEqual([]);
  });

  it("fails closed for malformed probe output, audio-kind disagreement, and a timed-out tool", async () => {
    const root = await temporaryRoot("recordly-private-audio-reject-");
    const authorizedRoot = join(root, "authorized");
    const libraryRoot = join(root, "library");
    await mkdir(authorizedRoot, { mode: 0o700 });
    await mkdir(libraryRoot, { mode: 0o700 });
    await writeFile(join(authorizedRoot, "voice.wav"), wav(48_000, 2, 480), { mode: 0o600 });
    const library = await createPrivateMediaLibrary({ libraryRoot });
    const media = await library.ingest({
      authorizedRoot,
      relativePath: "voice.wav",
      maximumBytes: 1024 * 1024,
    });

    for (const outcome of [
      async (): Promise<{ stdout: string; stderr: string }> => ({ stdout: "not json", stderr: "" }),
      async (): Promise<{ stdout: string; stderr: string }> => ({
        stdout: JSON.stringify({
          streams: [{ codec_type: "video", width: 1920, height: 1080, avg_frame_rate: "30/1" }],
          format: { duration: "1", format_name: "wav" },
        }),
        stderr: "",
      }),
      async (): Promise<{ stdout: string; stderr: string }> => {
        throw new Error("tool timed out");
      },
    ]) {
      const normalizer = await createPrivateAudioNormalizer({
        libraryRoot,
        toolchain: {
          resolveExecutable: async (name) => `/private/tools/${name}`,
          commandRunner: async (_input) => outcome(),
        },
      });
      await expect(normalizer.probe({ media })).rejects.toThrow(/probe|tool|audio|timeout/i);
    }

    const mediaMetadataPath = join(libraryRoot, "objects", `${media.sha256}.json`);
    const mediaMetadata = JSON.parse(await readFile(mediaMetadataPath, "utf8")) as object;
    await writeFile(
      mediaMetadataPath,
      JSON.stringify({ ...mediaMetadata, originalSourcePath: join(authorizedRoot, "voice.wav") }),
      { mode: 0o600 },
    );
    const normalizer = await createPrivateAudioNormalizer({ libraryRoot });
    await expect(normalizer.probe({ media })).rejects.toThrow(/metadata|invalid/i);
  });
});
