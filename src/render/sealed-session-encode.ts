import { chmod, lstat, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { resolveMediaExecutable } from "../encoder/ffmpeg.js";
import { MEDIA_PROCESS_POLICY, runMediaProcess } from "../encoder/media-process.js";
import { SealedSessionRenderError } from "./sealed-session-errors.js";

export type SealedEncodeFrame = {
  frameId: number;
  absolutePath: string;
};

export type PpmImage = { width: number; height: number; pixels: Buffer };

async function regularFile(path: string, label: string): Promise<void> {
  const status = await lstat(path).catch(() => {
    throw new SealedSessionRenderError(`${label} is missing`);
  });
  if (!status.isFile() || status.isSymbolicLink()) {
    throw new SealedSessionRenderError(`${label} must be a non-symlink regular file`);
  }
}

function ffconcatPath(path: string): string {
  return `'${path.replaceAll("'", "'\\''")}'`;
}

export async function encodeSealedTimeline(
  frames: readonly SealedEncodeFrame[],
  slots: readonly { sourceFrameId: number }[],
  workRoot: string,
): Promise<string> {
  const concatPath = join(workRoot, "timeline.ffconcat");
  const byId = new Map(frames.map((frame) => [frame.frameId, frame]));
  const lines = ["ffconcat version 1.0"];
  for (const slot of slots) {
    const frame = byId.get(slot.sourceFrameId);
    if (frame === undefined) throw new SealedSessionRenderError("CFR slot has no source evidence");
    lines.push(`file ${ffconcatPath(frame.absolutePath)}`, "duration 0.033333333");
  }
  const final = byId.get((slots.at(-1) as { sourceFrameId: number }).sourceFrameId);
  lines.push(`file ${ffconcatPath((final as SealedEncodeFrame).absolutePath)}`);
  await writeFile(concatPath, `${lines.join("\n")}\n`, { mode: 0o600 });
  const outputPath = join(workRoot, "recording.mp4");
  const ffmpeg = await resolveMediaExecutable("ffmpeg");
  await runMediaProcess({
    executable: ffmpeg,
    label: "sealed session encoder",
    timeoutMs: MEDIA_PROCESS_POLICY.sealedEncodeDeadlineMs,
    args: [
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "concat",
      "-safe",
      "0",
      "-i",
      concatPath,
      "-an",
      "-vf",
      "fps=30,scale=1740:980:force_original_aspect_ratio=decrease:force_divisible_by=2:in_range=auto:out_range=limited,pad=iw+24:ih+24:12:12:color=0xf8fafc,pad=1920:1080:(ow-iw)/2:(oh-ih)/2:color=0x0f172a,format=yuv420p",
      "-c:v",
      "libx264",
      "-preset",
      "medium",
      "-pix_fmt",
      "yuv420p",
      "-color_range",
      "tv",
      "-bsf:v",
      "h264_metadata=video_full_range_flag=0",
      "-movflags",
      "+faststart",
      "-frames:v",
      String(slots.length),
      "-y",
      outputPath,
    ],
  });
  await chmod(outputPath, 0o600);
  return outputPath;
}

export async function sampleFrame(
  videoPath: string,
  frameIndex: number,
  outputPath: string,
): Promise<void> {
  const ffmpeg = await resolveMediaExecutable("ffmpeg");
  await runMediaProcess({
    executable: ffmpeg,
    label: "sealed session QA frame extraction",
    timeoutMs: MEDIA_PROCESS_POLICY.inspectionDeadlineMs,
    args: [
      "-hide_banner",
      "-loglevel",
      "error",
      "-i",
      videoPath,
      "-vf",
      `select=eq(n\\,${frameIndex})`,
      "-vsync",
      "0",
      "-frames:v",
      "1",
      "-f",
      "image2",
      "-vcodec",
      "ppm",
      "-y",
      outputPath,
    ],
  });
  await chmod(outputPath, 0o600);
  await regularFile(outputPath, "decoded QA sample");
}

export async function sampleScaledFrame(
  videoPath: string,
  frameIndex: number,
  outputPath: string,
): Promise<PpmImage> {
  const ffmpeg = await resolveMediaExecutable("ffmpeg");
  await runMediaProcess({
    executable: ffmpeg,
    label: "sealed session QA scaled frame extraction",
    timeoutMs: MEDIA_PROCESS_POLICY.inspectionDeadlineMs,
    args: [
      "-hide_banner",
      "-loglevel",
      "error",
      "-i",
      videoPath,
      "-vf",
      `select=eq(n\\,${frameIndex}),scale=160:90`,
      "-vsync",
      "0",
      "-frames:v",
      "1",
      "-f",
      "image2",
      "-vcodec",
      "ppm",
      "-y",
      outputPath,
    ],
  });
  await chmod(outputPath, 0o600);
  return parsePpm(await readFile(outputPath));
}

export async function decodeSourceFrame(
  inputPath: string,
  outputPath: string,
  width?: number,
  height?: number,
): Promise<PpmImage> {
  const ffmpeg = await resolveMediaExecutable("ffmpeg");
  await runMediaProcess({
    executable: ffmpeg,
    label: "sealed session source frame decode",
    timeoutMs: MEDIA_PROCESS_POLICY.inspectionDeadlineMs,
    args: [
      "-hide_banner",
      "-loglevel",
      "error",
      "-i",
      inputPath,
      ...(width === undefined || height === undefined
        ? []
        : ["-vf", `scale=${width}:${height}:in_range=auto:out_range=limited`]),
      "-frames:v",
      "1",
      "-f",
      "image2",
      "-vcodec",
      "ppm",
      "-y",
      outputPath,
    ],
  });
  await chmod(outputPath, 0o600);
  return parsePpm(await readFile(outputPath));
}

export function parsePpm(buffer: Buffer): PpmImage {
  let offset = 0;
  const token = (): string => {
    while (offset < buffer.length) {
      const byte = buffer[offset] as number;
      if (byte === 35) {
        while (offset < buffer.length && buffer[offset] !== 10) offset += 1;
      } else if (byte <= 32) {
        offset += 1;
      } else {
        break;
      }
    }
    const start = offset;
    while (offset < buffer.length && (buffer[offset] as number) > 32) offset += 1;
    return buffer.subarray(start, offset).toString("ascii");
  };
  if (token() !== "P6") throw new SealedSessionRenderError("decoded QA frame must be binary PPM");
  const width = Number(token());
  const height = Number(token());
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || token() !== "255") {
    throw new SealedSessionRenderError("decoded QA frame has invalid PPM geometry");
  }
  if (buffer[offset] === 13 && buffer[offset + 1] === 10) {
    offset += 2;
  } else if ((buffer[offset] as number) <= 32) {
    offset += 1;
  }
  const pixels = buffer.subarray(offset);
  if (pixels.length !== width * height * 3) {
    throw new SealedSessionRenderError("decoded QA frame has invalid PPM pixel data");
  }
  return { width, height, pixels };
}
