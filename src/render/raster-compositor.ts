import type { CompositionPlan } from "./composition.js";
import { buildClipSchedule, sourceTimeForPresentation } from "./timeline-mapping.js";

export type RasterFrame = { tUs: number; pixels: Buffer };
export type RasterSource = {
  id: string;
  width: number;
  height: number;
  /** Test-fixture compatibility only. Production supplies frameAt instead. */
  frames?: readonly RasterFrame[];
  frameAt?: (tUs: number) => RasterFrame | Promise<RasterFrame>;
};

/** A bounded source-reader contract: no decoded frame array crosses the production boundary. */
export type LazyRasterSource = Omit<RasterSource, "frames" | "frameAt"> & {
  frames?: never;
  frameAt: (tUs: number) => RasterFrame | Promise<RasterFrame>;
};

const MAX_RENDER_FRAMES = 18_000;

type Rgb = { r: number; g: number; b: number };

function color(value: string): Rgb {
  return {
    r: Number.parseInt(value.slice(1, 3), 16),
    g: Number.parseInt(value.slice(3, 5), 16),
    b: Number.parseInt(value.slice(5, 7), 16),
  };
}

function setPixel(buffer: Buffer, width: number, x: number, y: number, value: Rgb): void {
  if (x < 0 || y < 0 || x >= width || y >= buffer.length / (width * 3)) return;
  const offset = (Math.floor(y) * width + Math.floor(x)) * 3;
  buffer[offset] = value.r;
  buffer[offset + 1] = value.g;
  buffer[offset + 2] = value.b;
}

function blendPixel(
  buffer: Buffer,
  width: number,
  x: number,
  y: number,
  value: Rgb,
  alpha: number,
): void {
  if (x < 0 || y < 0 || x >= width || y >= buffer.length / (width * 3)) return;
  const offset = (Math.floor(y) * width + Math.floor(x)) * 3;
  const blend = (previous: number, next: number): number =>
    Math.round(previous * (1 - alpha) + next * alpha);
  buffer[offset] = blend(buffer[offset] as number, value.r);
  buffer[offset + 1] = blend(buffer[offset + 1] as number, value.g);
  buffer[offset + 2] = blend(buffer[offset + 2] as number, value.b);
}

function roundedRectContains(
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
): boolean {
  const innerX = Math.min(Math.max(x, radius), width - radius);
  const innerY = Math.min(Math.max(y, radius), height - radius);
  return (x - innerX) ** 2 + (y - innerY) ** 2 <= radius ** 2;
}

function drawBackground(
  target: Buffer,
  width: number,
  height: number,
  plan: CompositionPlan,
): void {
  if (plan.style.background.kind === "solid") {
    target.fill(
      Buffer.from([
        color(plan.style.background.color).r,
        color(plan.style.background.color).g,
        color(plan.style.background.color).b,
      ]),
    );
    return;
  }
  const from = color(plan.style.background.from);
  const to = color(plan.style.background.to);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const progress = (x / Math.max(1, width - 1) + y / Math.max(1, height - 1)) / 2;
      setPixel(target, width, x, y, {
        r: Math.round(from.r + (to.r - from.r) * progress),
        g: Math.round(from.g + (to.g - from.g) * progress),
        b: Math.round(from.b + (to.b - from.b) * progress),
      });
    }
  }
}

function drawCursor(
  target: Buffer,
  width: number,
  point: { x: number; y: number },
  scale: number,
): void {
  const size = Math.max(10, Math.round(20 * scale));
  for (let row = 0; row < size; row += 1) {
    const right = Math.round((size - row) * 0.7);
    for (let column = 0; column <= right; column += 1) {
      const border = row < 2 || column < 2 || column >= right - 1;
      setPixel(
        target,
        width,
        Math.round(point.x) + column,
        Math.round(point.y) + row,
        border ? { r: 15, g: 23, b: 42 } : { r: 255, g: 255, b: 255 },
      );
    }
  }
}

function drawRing(
  target: Buffer,
  width: number,
  point: { x: number; y: number },
  radius: number,
  tint: Rgb,
): void {
  const inner = Math.max(0, radius - 2) ** 2;
  const outer = radius ** 2;
  for (let y = Math.floor(point.y - radius); y <= Math.ceil(point.y + radius); y += 1) {
    for (let x = Math.floor(point.x - radius); x <= Math.ceil(point.x + radius); x += 1) {
      const distance = (x - point.x) ** 2 + (y - point.y) ** 2;
      if (distance >= inner && distance <= outer) blendPixel(target, width, x, y, tint, 0.88);
    }
  }
}

function drawBounce(
  target: Buffer,
  width: number,
  point: { x: number; y: number },
  radius: number,
  tint: Rgb,
): void {
  for (let y = Math.floor(point.y - radius); y <= Math.ceil(point.y + radius); y += 1)
    for (let x = Math.floor(point.x - radius); x <= Math.ceil(point.x + radius); x += 1)
      if ((x - point.x) ** 2 + (y - point.y) ** 2 <= radius ** 2)
        blendPixel(target, width, x, y, tint, 0.55);
}

const glyphs: Record<string, readonly string[]> = {
  A: ["0110", "1001", "1001", "1111", "1001", "1001"],
  B: ["1110", "1001", "1110", "1001", "1001", "1110"],
  C: ["0111", "1000", "1000", "1000", "1000", "0111"],
  D: ["1110", "1001", "1001", "1001", "1001", "1110"],
  E: ["1111", "1000", "1110", "1000", "1000", "1111"],
  F: ["1111", "1000", "1110", "1000", "1000", "1000"],
  I: ["111", "010", "010", "010", "010", "111"],
  N: ["1001", "1101", "1101", "1011", "1011", "1001"],
  O: ["0110", "1001", "1001", "1001", "1001", "0110"],
  P: ["1110", "1001", "1001", "1110", "1000", "1000"],
  R: ["1110", "1001", "1110", "1010", "1001", "1001"],
  T: ["11111", "00100", "00100", "00100", "00100", "00100"],
  V: ["1001", "1001", "1001", "1001", "0110", "0110"],
  W: ["10001", "10001", "10101", "10101", "10101", "01010"],
  X: ["1001", "1001", "0110", "0110", "1001", "1001"],
  Y: ["1001", "1001", "0110", "0010", "0010", "0010"],
  " ": ["0", "0", "0", "0", "0", "0"],
};

function drawText(
  target: Buffer,
  width: number,
  x: number,
  y: number,
  text: string,
  tint: Rgb,
): void {
  let cursor = x;
  for (const character of text.toUpperCase()) {
    const glyph = (glyphs[character] ?? glyphs[" "]) as readonly string[];
    for (let row = 0; row < glyph.length; row += 1) {
      const line = glyph[row] as string;
      for (let column = 0; column < line.length; column += 1) {
        if (line[column] === "1") {
          for (let py = 0; py < 2; py += 1)
            for (let px = 0; px < 2; px += 1)
              setPixel(target, width, cursor + column * 2 + px, y + row * 2 + py, tint);
        }
      }
    }
    cursor += ((glyph[0] as string).length + 1) * 2;
  }
}

async function nearestFrame(source: RasterSource, tUs: number): Promise<RasterFrame> {
  if (source.frameAt !== undefined) {
    const selected = await source.frameAt(tUs);
    if (selected.pixels.length !== source.width * source.height * 3)
      throw new RangeError("source frame provider returned invalid RGB24 data");
    return selected;
  }
  const frames = source.frames;
  if (frames === undefined || frames.length === 0)
    throw new RangeError("raster source must provide frames");
  let selected = frames[0] as RasterFrame;
  for (const frame of frames) {
    if (Math.abs(frame.tUs - tUs) < Math.abs(selected.tUs - tUs)) selected = frame;
  }
  return selected;
}

/** Renders one safe source frame to the plan's output canvas. */
export function composeRasterFrame(input: {
  plan: CompositionPlan;
  source: RasterSource;
  sourceFrame: RasterFrame;
  tUs: number;
  clipId?: string;
  clipSourceRelativeUs?: number;
  sourceTimeUs?: number;
}): Buffer {
  const { plan, source, sourceFrame, tUs, clipId, clipSourceRelativeUs, sourceTimeUs } = input;
  if (sourceFrame.pixels.length !== source.width * source.height * 3)
    throw new RangeError("source frame is not packed RGB24");
  const { width, height } = plan.output;
  const target = Buffer.alloc(width * height * 3);
  drawBackground(target, width, height, plan);
  const contentMaxWidth = Math.max(2, width - plan.style.padding * 2);
  const contentMaxHeight = Math.max(2, height - plan.style.padding * 2);
  const scale = Math.min(contentMaxWidth / source.width, contentMaxHeight / source.height);
  const contentWidth = Math.max(2, Math.floor(source.width * scale));
  const contentHeight = Math.max(2, Math.floor(source.height * scale));
  const contentX = Math.floor((width - contentWidth) / 2);
  const contentY = Math.floor((height - contentHeight) / 2);
  const shadow = plan.style.shadow;
  if (shadow.opacity > 0) {
    const shadowColor = { r: 0, g: 0, b: 0 };
    for (let y = 0; y < contentHeight; y += 1)
      for (let x = 0; x < contentWidth; x += 1)
        blendPixel(
          target,
          width,
          contentX + x,
          contentY + y + shadow.offsetY,
          shadowColor,
          shadow.opacity,
        );
  }
  const zoom = plan.zoomAt(tUs, clipId, sourceTimeUs);
  const zoomScale = zoom?.scale ?? 1;
  const focus = zoom ?? { x: source.width / 2, y: source.height / 2 };
  for (let y = 0; y < contentHeight; y += 1) {
    for (let x = 0; x < contentWidth; x += 1) {
      if (
        !roundedRectContains(
          x,
          y,
          contentWidth,
          contentHeight,
          Math.min(plan.style.radius, Math.min(contentWidth, contentHeight) / 2),
        )
      )
        continue;
      const sourceX = Math.max(
        0,
        Math.min(source.width - 1, Math.floor(focus.x + (x / scale - focus.x) / zoomScale)),
      );
      const sourceY = Math.max(
        0,
        Math.min(source.height - 1, Math.floor(focus.y + (y / scale - focus.y) / zoomScale)),
      );
      const sourceOffset = (sourceY * source.width + sourceX) * 3;
      setPixel(target, width, contentX + x, contentY + y, {
        r: sourceFrame.pixels[sourceOffset] as number,
        g: sourceFrame.pixels[sourceOffset + 1] as number,
        b: sourceFrame.pixels[sourceOffset + 2] as number,
      });
    }
  }
  const toOutput = (point: { x: number; y: number }) => ({
    x: contentX + (focus.x + (point.x - focus.x) * zoomScale) * scale,
    y: contentY + (focus.y + (point.y - focus.y) * zoomScale) * scale,
  });
  const cursor =
    sourceTimeUs === undefined
      ? plan.cursorAt(tUs)
      : (plan.cursorAtSource?.(source.id, sourceTimeUs) ?? plan.cursorAt(tUs));
  if (plan.cursorVisible && cursor !== undefined) {
    drawCursor(target, width, toOutput(cursor), plan.style.cursor.size);
  }
  for (const effect of plan.clickEffects) {
    if (effect.clipId !== undefined && effect.clipId !== clipId) continue;
    const progress = (tUs - effect.startUs) / effect.durationUs;
    if (progress >= 0 && progress <= 1)
      if (effect.kind === "bounce")
        drawBounce(
          target,
          width,
          toOutput(effect),
          6 + 12 * Math.sin(Math.PI * progress),
          color(effect.color),
        );
      else drawRing(target, width, toOutput(effect), 12 + progress * 28, color(effect.color));
  }
  const active = (item: { clipId?: string; startUs: number; endUs: number }): boolean =>
    item.clipId === undefined
      ? tUs >= item.startUs && tUs <= item.endUs
      : item.clipId === clipId &&
        clipSourceRelativeUs !== undefined &&
        clipSourceRelativeUs >= item.startUs &&
        clipSourceRelativeUs <= item.endUs;
  for (const caption of plan.captions)
    if (active(caption))
      drawText(target, width, Math.round(width * 0.08), height - 44, caption.text, {
        r: 255,
        g: 255,
        b: 255,
      });
  for (const annotation of plan.annotations)
    if (active(annotation))
      drawText(
        target,
        width,
        Math.round(toOutput(annotation).x),
        Math.round(toOutput(annotation).y),
        annotation.text,
        annotation.style === "emphasis" ? { r: 220, g: 38, b: 38 } : { r: 15, g: 23, b: 42 },
      );
  if (plan.hooks.includes("focus-ring")) {
    const ring = { r: 37, g: 99, b: 235 };
    for (let x = 0; x < width; x += 1) {
      setPixel(target, width, x, 0, ring);
      setPixel(target, width, x, height - 1, ring);
    }
    for (let y = 0; y < height; y += 1) {
      setPixel(target, width, 0, y, ring);
      setPixel(target, width, width - 1, y, ring);
    }
  }
  if (plan.hooks.includes("safe-title-card")) {
    for (let y = 12; y < 40; y += 1)
      for (let x = 12; x < Math.min(width - 12, 180); x += 1)
        blendPixel(target, width, x, y, { r: 15, g: 23, b: 42 }, 0.8);
    drawText(target, width, 20, 20, "RECORDLY", { r: 255, g: 255, b: 255 });
  }
  return target;
}

function blendFramesInPlace(first: Buffer, second: Buffer, secondAlpha: number): Buffer {
  for (let index = 0; index < first.length; index += 1) {
    first[index] = Math.round(
      (first[index] as number) * (1 - secondAlpha) + (second[index] as number) * secondAlpha,
    );
  }
  return first;
}

/** Streams presentation CFR frames; output memory is bounded to one or two frames. */
export async function* streamPresentationFrames(input: {
  plan: CompositionPlan;
  sources: readonly RasterSource[];
}): AsyncGenerator<Buffer> {
  const byId = new Map(input.sources.map((source) => [source.id, source]));
  const schedule = buildClipSchedule(input.plan);
  let emitted = 0;
  for (const [clipIndex, timing] of schedule.entries()) {
    const clip = timing.clip;
    const source = byId.get(clip.sourceId ?? input.sources[0]?.id ?? "");
    if (source === undefined) throw new RangeError("clip source is not available");
    const durationUs = Math.round(timing.renderedDurationUs);
    const incomingTransitionUs = timing.incomingCrossfadeUs;
    const renderDurationUs = durationUs - incomingTransitionUs;
    const frameCount = Math.max(
      1,
      Math.round((renderDurationUs * input.plan.output.fps) / 1_000_000),
    );
    for (let frameIndex = 0; frameIndex < frameCount; frameIndex += 1) {
      const localPresentationUs =
        incomingTransitionUs + Math.round((frameIndex * 1_000_000) / input.plan.output.fps);
      const sourceTimeUs = Math.round(sourceTimeForPresentation(clip, localPresentationUs));
      const tUs = timing.presentationStartUs + localPresentationUs;
      let composed = composeRasterFrame({
        plan: input.plan,
        source,
        sourceFrame: await nearestFrame(source, sourceTimeUs),
        tUs,
        clipId: clip.id,
        clipSourceRelativeUs: sourceTimeUs - clip.startUs,
        sourceTimeUs,
      });
      for (const pip of input.plan.pipTracks) {
        const clipRelativeUs = sourceTimeUs - clip.startUs;
        if (pip.clipId !== undefined && pip.clipId !== clip.id) continue;
        if (clipRelativeUs < pip.startUs || clipRelativeUs > pip.endUs) continue;
        const pipSource = byId.get(pip.assetId);
        if (pipSource === undefined) throw new RangeError("verified PiP source is not available");
        const pipFrame = await nearestFrame(pipSource, clipRelativeUs - pip.startUs);
        const pipWidth = Math.max(2, Math.round(input.plan.output.width * pip.scale));
        const pipHeight = Math.max(2, Math.round((pipWidth * pipSource.height) / pipSource.width));
        const inset = 24;
        const left = pip.corner.includes("left")
          ? inset
          : input.plan.output.width - pipWidth - inset;
        const top = pip.corner.includes("top")
          ? inset
          : input.plan.output.height - pipHeight - inset;
        for (let y = 0; y < pipHeight; y += 1)
          for (let x = 0; x < pipWidth; x += 1) {
            const sourceX = Math.floor((x / pipWidth) * pipSource.width);
            const sourceY = Math.floor((y / pipHeight) * pipSource.height);
            const offset = (sourceY * pipSource.width + sourceX) * 3;
            setPixel(composed, input.plan.output.width, left + x, top + y, {
              r: pipFrame.pixels[offset] as number,
              g: pipFrame.pixels[offset + 1] as number,
              b: pipFrame.pixels[offset + 2] as number,
            });
          }
      }
      const transition = clip.transitionAfter;
      const next = input.plan.clips[clipIndex + 1];
      if (
        transition?.kind === "crossfade" &&
        next !== undefined &&
        transition.durationUs > 0 &&
        localPresentationUs >= durationUs - transition.durationUs
      ) {
        const nextSource = byId.get(next.sourceId ?? input.sources[0]?.id ?? "");
        if (nextSource === undefined) throw new RangeError("crossfade source is not available");
        const nextPresentationUs = localPresentationUs - (durationUs - transition.durationUs);
        const nextSourceUs = Math.round(sourceTimeForPresentation(next, nextPresentationUs));
        const nextFrame = composeRasterFrame({
          plan: input.plan,
          source: nextSource,
          sourceFrame: await nearestFrame(nextSource, nextSourceUs),
          tUs,
          clipId: next.id,
          clipSourceRelativeUs: nextSourceUs - next.startUs,
          sourceTimeUs: nextSourceUs,
        });
        composed = blendFramesInPlace(
          composed,
          nextFrame,
          nextPresentationUs / transition.durationUs,
        );
      }
      emitted += 1;
      if (emitted > MAX_RENDER_FRAMES)
        throw new RangeError("presentation exceeds the bounded render frame limit");
      yield composed;
    }
  }
}

/** Compatibility helper for small test fixtures. Production code uses streamPresentationFrames. */
export async function composePresentationFrames(input: {
  plan: CompositionPlan;
  sources: readonly RasterSource[];
}): Promise<Buffer[]> {
  const output: Buffer[] = [];
  for await (const frame of streamPresentationFrames(input)) output.push(frame);
  return output;
}
