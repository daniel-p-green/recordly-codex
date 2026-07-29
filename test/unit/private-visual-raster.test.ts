import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it, vi } from "vitest";

import { resolveMediaExecutable } from "../../src/encoder/ffmpeg.js";
import { createPrivateMediaLibrary } from "../../src/media/private-media-library.js";
import {
  BoundedRgbFrameAssembler,
  closePrivateVisualChild,
  createPrivateVisualRasterAdapter,
} from "../../src/media/private-visual-raster.js";

const execFileAsync = promisify(execFile);
const roots: string[] = [];

async function temporaryRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("private visual raster adapter", () => {
  it("assembles chunked RGB frames with bounded pending bytes and no full-buffer reassembly", () => {
    // Small deterministic chunks exercise the same boundary crossings as a 4096x2160 RGB frame
    // without allocating a timing-sensitive 26 MiB test buffer.
    const assembler = new BoundedRgbFrameAssembler({ frameBytes: 31, maximumChunkBytes: 7 });
    const expected = Buffer.from(Array.from({ length: 62 }, (_, index) => index));
    const frames: Buffer[] = [];

    for (let offset = 0; offset < expected.length; offset += 7) {
      assembler.push(expected.subarray(offset, Math.min(offset + 7, expected.length)));
      let frame = assembler.take();
      while (frame !== undefined) {
        frames.push(frame);
        frame = assembler.take();
      }
    }

    expect(frames).toEqual([expected.subarray(0, 31), expected.subarray(31)]);
    expect(assembler.take()).toBeUndefined();
    expect(assembler.metrics).toMatchObject({
      bytesCopied: expected.length,
      framesCompleted: 2,
      pendingBytes: 0,
    });
    expect(assembler.metrics.maximumPendingBytes).toBeLessThanOrEqual(7);
  });

  it("rejects teardown if a terminated decoder never closes", async () => {
    const kill = vi.fn(() => true);
    const child = {
      exitCode: null,
      killed: false,
      kill,
      once: vi.fn(),
      stdout: { destroy: vi.fn() },
      stderr: { destroy: vi.fn() },
    };
    await expect(closePrivateVisualChild(child as never)).rejects.toThrow(/SIGKILL/i);
    expect(kill).toHaveBeenNthCalledWith(1, "SIGTERM");
    expect(kill).toHaveBeenNthCalledWith(2, "SIGKILL");
  }, 2_000);

  it("decodes and reuses one private still frame without exposing paths", async () => {
    const root = await temporaryRoot("recordly-private-raster-still-");
    const authorizedRoot = join(root, "authorized");
    const libraryRoot = join(root, "library");
    const sourcePath = join(authorizedRoot, "still.png");
    await mkdir(authorizedRoot, { mode: 0o700 });
    await mkdir(libraryRoot, { mode: 0o700 });
    await execFileAsync(await resolveMediaExecutable("ffmpeg"), [
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "lavfi",
      "-i",
      "color=c=red:s=4x2",
      "-frames:v",
      "1",
      "-y",
      sourcePath,
    ]);
    const library = await createPrivateMediaLibrary({ libraryRoot });
    const media = await library.ingest({
      authorizedRoot,
      relativePath: "still.png",
      maximumBytes: 1024 * 1024,
    });
    const adapter = await createPrivateVisualRasterAdapter({ libraryRoot });
    const handle = await adapter.open({
      media,
      expected: { mediaKind: "image", extension: "png", width: 4, height: 2 },
    });

    const first = await handle.source.frameAt(0);
    const repeated = await handle.source.frameAt(5_000_000);
    expect(handle.source).toMatchObject({ id: media.mediaId, width: 4, height: 2 });
    expect(first).toBe(repeated);
    expect(first.pixels).toHaveLength(4 * 2 * 3);
    expect(JSON.stringify(handle.source)).not.toContain(root);
    expect(handle.decoderSpawnCount()).toBe(1);
    await handle.dispose();
  });

  it("inspects decoded visual metadata through the private library without exposing a path", async () => {
    const root = await temporaryRoot("recordly-private-raster-inspect-");
    const authorizedRoot = join(root, "authorized");
    const libraryRoot = join(root, "library");
    const sourcePath = join(authorizedRoot, "still.png");
    await mkdir(authorizedRoot, { mode: 0o700 });
    await mkdir(libraryRoot, { mode: 0o700 });
    await execFileAsync(await resolveMediaExecutable("ffmpeg"), [
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "lavfi",
      "-i",
      "color=c=red:s=4x2",
      "-frames:v",
      "1",
      "-y",
      sourcePath,
    ]);
    const media = await (await createPrivateMediaLibrary({ libraryRoot })).ingest({
      authorizedRoot,
      relativePath: "still.png",
      maximumBytes: 1024 * 1024,
    });

    const inspected = await (await createPrivateVisualRasterAdapter({ libraryRoot })).inspect({
      media,
    });

    expect(inspected).toEqual({
      mediaId: media.mediaId,
      sha256: media.sha256,
      mediaKind: "image",
      extension: "png",
      durationUs: 1,
      width: 4,
      height: 2,
    });
    expect(JSON.stringify(inspected)).not.toContain(root);
  });

  it("streams distinct video frames sequentially and restarts only for a backward seek", async () => {
    const root = await temporaryRoot("recordly-private-raster-video-");
    const authorizedRoot = join(root, "authorized");
    const libraryRoot = join(root, "library");
    const sourcePath = join(authorizedRoot, "motion.mp4");
    await mkdir(authorizedRoot, { mode: 0o700 });
    await mkdir(libraryRoot, { mode: 0o700 });
    await execFileAsync(await resolveMediaExecutable("ffmpeg"), [
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "lavfi",
      "-i",
      "testsrc=s=64x32:r=2:d=1",
      "-an",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-y",
      sourcePath,
    ]);
    const library = await createPrivateMediaLibrary({ libraryRoot });
    const media = await library.ingest({
      authorizedRoot,
      relativePath: "motion.mp4",
      maximumBytes: 1024 * 1024,
    });
    const adapter = await createPrivateVisualRasterAdapter({ libraryRoot });
    const handle = await adapter.open({
      media,
      expected: {
        mediaKind: "video",
        extension: "mp4",
        width: 64,
        height: 32,
        fps: 2,
        durationSeconds: 1,
      },
    });

    const first = await handle.source.frameAt(0);
    const second = await handle.source.frameAt(500_000);
    expect(first.pixels.equals(second.pixels)).toBe(false);
    expect(handle.decoderSpawnCount()).toBe(1);
    await expect(handle.source.frameAt(0)).resolves.toMatchObject({ tUs: 0 });
    expect(handle.decoderSpawnCount()).toBe(2);
    await handle.dispose();
  });

  it("fails closed for tampered library metadata and extension/content disagreement", async () => {
    const root = await temporaryRoot("recordly-private-raster-reject-");
    const authorizedRoot = join(root, "authorized");
    const libraryRoot = join(root, "library");
    const sourcePath = join(authorizedRoot, "motion.mp4");
    await mkdir(authorizedRoot, { mode: 0o700 });
    await mkdir(libraryRoot, { mode: 0o700 });
    await execFileAsync(await resolveMediaExecutable("ffmpeg"), [
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "lavfi",
      "-i",
      "testsrc2=s=4x2:r=2:d=1",
      "-an",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-y",
      sourcePath,
    ]);
    const library = await createPrivateMediaLibrary({ libraryRoot });
    const media = await library.ingest({
      authorizedRoot,
      relativePath: "motion.mp4",
      maximumBytes: 1024 * 1024,
    });
    const adapter = await createPrivateVisualRasterAdapter({ libraryRoot });
    await expect(
      adapter.open({
        media,
        expected: { mediaKind: "image", extension: "png", width: 4, height: 2 },
      }),
    ).rejects.toThrow(/reference|metadata|extension|image/i);

    const metadataPath = join(libraryRoot, "objects", `${media.sha256}.json`);
    const metadata = JSON.parse(await readFile(metadataPath, "utf8")) as object;
    await writeFile(metadataPath, JSON.stringify({ ...metadata, sourcePath: sourcePath }), {
      mode: 0o600,
    });
    await expect(
      adapter.open({
        media,
        expected: {
          mediaKind: "video",
          extension: "mp4",
          width: 4,
          height: 2,
          fps: 2,
          durationSeconds: 1,
        },
      }),
    ).rejects.toThrow(/metadata|invalid/i);
  });

  it("rejects multi-stream input and rejects disposal after a valid object replacement", async () => {
    const root = await temporaryRoot("recordly-private-raster-streams-");
    const authorizedRoot = join(root, "authorized");
    const libraryRoot = join(root, "library");
    const multiPath = join(authorizedRoot, "multi.mp4");
    const videoPath = join(authorizedRoot, "video.mp4");
    const replacementPath = join(authorizedRoot, "replacement.mp4");
    await mkdir(authorizedRoot, { mode: 0o700 });
    await mkdir(libraryRoot, { mode: 0o700 });
    const ffmpeg = await resolveMediaExecutable("ffmpeg");
    await execFileAsync(ffmpeg, [
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "lavfi",
      "-i",
      "testsrc=s=64x32:r=2:d=1",
      "-f",
      "lavfi",
      "-i",
      "anullsrc=r=48000:cl=mono",
      "-shortest",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      "-y",
      multiPath,
    ]);
    await execFileAsync(ffmpeg, [
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "lavfi",
      "-i",
      "testsrc=s=64x32:r=2:d=1",
      "-an",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-y",
      videoPath,
    ]);
    await execFileAsync(ffmpeg, [
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "lavfi",
      "-i",
      "color=c=blue:s=64x32:r=2:d=1",
      "-an",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-y",
      replacementPath,
    ]);
    const library = await createPrivateMediaLibrary({ libraryRoot });
    const multi = await library.ingest({
      authorizedRoot,
      relativePath: "multi.mp4",
      maximumBytes: 1024 * 1024,
    });
    const video = await library.ingest({
      authorizedRoot,
      relativePath: "video.mp4",
      maximumBytes: 1024 * 1024,
    });
    const adapter = await createPrivateVisualRasterAdapter({ libraryRoot });
    await expect(
      adapter.open({
        media: multi,
        expected: {
          mediaKind: "video",
          extension: "mp4",
          width: 64,
          height: 32,
          fps: 2,
          durationSeconds: 1,
        },
      }),
    ).rejects.toThrow(/exactly one|stream/i);

    const handle = await adapter.open({
      media: video,
      expected: {
        mediaKind: "video",
        extension: "mp4",
        width: 64,
        height: 32,
        fps: 2,
        durationSeconds: 1,
      },
    });
    await writeFile(join(libraryRoot, "objects", video.sha256), await readFile(replacementPath), {
      mode: 0o600,
    });
    await expect(handle.source.frameAt(0)).resolves.toMatchObject({ tUs: 0 });
    await expect(handle.dispose()).rejects.toThrow(/reference|metadata|disagree/i);
  });
});
