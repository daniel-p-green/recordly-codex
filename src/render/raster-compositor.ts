import type { CompositionPlan } from "./composition.js";
import {
  buildClipSchedule,
  presentationTimeForSource,
  sourceTimeForPresentation,
} from "./timeline-mapping.js";

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

/** A translucent halo calls attention to the observed pointer without obscuring source pixels. */
function drawCursorSpotlight(
  target: Buffer,
  width: number,
  point: { x: number; y: number },
  scale: number,
): void {
  const radius = Math.max(22, Math.round(46 * scale));
  const radiusSquared = radius ** 2;
  for (let y = Math.floor(point.y - radius); y <= Math.ceil(point.y + radius); y += 1) {
    for (let x = Math.floor(point.x - radius); x <= Math.ceil(point.x + radius); x += 1) {
      const distance = (x - point.x) ** 2 + (y - point.y) ** 2;
      if (distance > radiusSquared) continue;
      const progress = Math.sqrt(distance) / radius;
      // Keep at least 76% of the source visible at the centre of the halo.
      blendPixel(target, width, x, y, { r: 37, g: 99, b: 235 }, 0.24 * (1 - progress));
    }
  }
}

function drawCursorTrailPoint(
  target: Buffer,
  width: number,
  point: { x: number; y: number },
  scale: number,
  alpha: number,
): void {
  const radius = Math.max(3, Math.round(5 * scale));
  for (let y = Math.floor(point.y - radius); y <= Math.ceil(point.y + radius); y += 1)
    for (let x = Math.floor(point.x - radius); x <= Math.ceil(point.x + radius); x += 1)
      if ((x - point.x) ** 2 + (y - point.y) ** 2 <= radius ** 2)
        blendPixel(target, width, x, y, { r: 37, g: 99, b: 235 }, alpha);
}

function drawFrameBorder(
  target: Buffer,
  width: number,
  contentX: number,
  contentY: number,
  contentWidth: number,
  contentHeight: number,
  radius: number,
  border: "subtle" | "strong",
): void {
  const thickness = border === "strong" ? 4 : 2;
  const tint = border === "strong" ? { r: 15, g: 23, b: 42 } : { r: 255, g: 255, b: 255 };
  const alpha = border === "strong" ? 0.9 : 0.6;
  for (let y = 0; y < contentHeight; y += 1) {
    for (let x = 0; x < contentWidth; x += 1) {
      const inside = roundedRectContains(x, y, contentWidth, contentHeight, radius);
      const inset =
        x >= thickness &&
        y >= thickness &&
        x < contentWidth - thickness &&
        y < contentHeight - thickness &&
        roundedRectContains(
          x - thickness,
          y - thickness,
          contentWidth - thickness * 2,
          contentHeight - thickness * 2,
          Math.max(0, radius - thickness),
        );
      if (inside && !inset) blendPixel(target, width, contentX + x, contentY + y, tint, alpha);
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
  const fit = plan.presentationControls?.frame.fit ?? "contain";
  const scale =
    fit === "cover"
      ? Math.max(contentMaxWidth / source.width, contentMaxHeight / source.height)
      : Math.min(contentMaxWidth / source.width, contentMaxHeight / source.height);
  const scaledWidth = Math.max(2, Math.floor(source.width * scale));
  const scaledHeight = Math.max(2, Math.floor(source.height * scale));
  const contentWidth = fit === "cover" ? contentMaxWidth : scaledWidth;
  const contentHeight = fit === "cover" ? contentMaxHeight : scaledHeight;
  const contentX = Math.floor((width - contentWidth) / 2);
  const contentY = Math.floor((height - contentHeight) / 2);
  const cropX = fit === "cover" ? Math.max(0, (scaledWidth - contentWidth) / 2) : 0;
  const cropY = fit === "cover" ? Math.max(0, (scaledHeight - contentHeight) / 2) : 0;
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
        Math.min(
          source.width - 1,
          Math.floor(focus.x + ((x + cropX) / scale - focus.x) / zoomScale),
        ),
      );
      const sourceY = Math.max(
        0,
        Math.min(
          source.height - 1,
          Math.floor(focus.y + ((y + cropY) / scale - focus.y) / zoomScale),
        ),
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
    x: contentX + (focus.x + (point.x - focus.x) * zoomScale) * scale - cropX,
    y: contentY + (focus.y + (point.y - focus.y) * zoomScale) * scale - cropY,
  });
  const cursor =
    sourceTimeUs === undefined
      ? plan.cursorAt(tUs)
      : (plan.cursorAtSource?.(source.id, sourceTimeUs) ?? plan.cursorAt(tUs));
  const cursorControls = plan.presentationControls?.cursor;
  if (cursorControls?.emphasis === "trail" && cursor !== undefined) {
    const history =
      sourceTimeUs === undefined
        ? (plan.cursorHistoryAt?.(tUs, cursorControls.trailDurationUs) ?? [])
        : (plan.cursorHistoryAtSource?.(source.id, sourceTimeUs, cursorControls.trailDurationUs) ??
          plan.cursorHistoryAt?.(tUs, cursorControls.trailDurationUs) ??
          []);
    const latestTimeUs = sourceTimeUs ?? tUs;
    for (const sample of history.slice(-96)) {
      if (sample.tUs >= latestTimeUs || sample.tUs < latestTimeUs - cursorControls.trailDurationUs)
        continue;
      const age = latestTimeUs - sample.tUs;
      drawCursorTrailPoint(
        target,
        width,
        toOutput(sample),
        plan.style.cursor.size,
        0.08 + 0.32 * (1 - age / cursorControls.trailDurationUs),
      );
    }
  }
  if (cursorControls?.emphasis === "spotlight" && cursor !== undefined)
    drawCursorSpotlight(target, width, toOutput(cursor), plan.style.cursor.size);
  if (plan.cursorVisible && cursor !== undefined) {
    drawCursor(target, width, toOutput(cursor), plan.style.cursor.size);
  }
  const frameBorder = plan.presentationControls?.frame.border;
  if (frameBorder === "subtle" || frameBorder === "strong")
    drawFrameBorder(
      target,
      width,
      contentX,
      contentY,
      contentWidth,
      contentHeight,
      Math.min(plan.style.radius, Math.min(contentWidth, contentHeight) / 2),
      frameBorder,
    );
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

function transitionProgress(value: number, easing: "linear" | "ease-in-out" | "ease-out"): number {
  const clamped = Math.min(1, Math.max(0, value));
  if (easing === "ease-in-out") return clamped * clamped * (3 - 2 * clamped);
  if (easing === "ease-out") return 1 - (1 - clamped) ** 2;
  return clamped;
}

function composeReviewedTransition(input: {
  outgoing: Buffer;
  incoming: Buffer;
  width: number;
  family: NonNullable<CompositionPlan["reviewedTransitions"]>[number]["family"];
  easing: "linear" | "ease-in-out" | "ease-out";
  color?: string;
  rawProgress: number;
}): Buffer {
  const progress = transitionProgress(input.rawProgress, input.easing);
  if (input.family === "cut") return input.rawProgress >= 1 ? input.incoming : input.outgoing;
  if (input.family === "crossfade")
    return blendFramesInPlace(input.outgoing, input.incoming, progress);
  if (input.family === "dip-to-color") {
    const dip = Buffer.alloc(input.outgoing.length);
    dip.fill(Buffer.from(Object.values(color(input.color ?? "#000000"))));
    return progress <= 0.5
      ? blendFramesInPlace(input.outgoing, dip, progress * 2)
      : blendFramesInPlace(dip, input.incoming, (progress - 0.5) * 2);
  }
  const height = input.outgoing.length / (input.width * 3);
  if (input.family === "wipe-left" || input.family === "wipe-right") {
    const result = Buffer.from(input.outgoing);
    const edge = Math.round(input.width * progress);
    for (let y = 0; y < height; y += 1)
      for (let x = 0; x < input.width; x += 1) {
        const revealIncoming = input.family === "wipe-left" ? x < edge : x >= input.width - edge;
        if (!revealIncoming) continue;
        const offset = (y * input.width + x) * 3;
        input.incoming.copy(result, offset, offset, offset + 3);
      }
    return result;
  }
  const result = Buffer.alloc(input.outgoing.length);
  const offset = Math.round(input.width * progress);
  for (let y = 0; y < height; y += 1)
    for (let x = 0; x < input.width; x += 1) {
      const sourceX =
        input.family === "slide-left"
          ? x < input.width - offset
            ? x + offset
            : x - (input.width - offset)
          : x < offset
            ? x + (input.width - offset)
            : x - offset;
      const source =
        input.family === "slide-left"
          ? x < input.width - offset
            ? input.outgoing
            : input.incoming
          : x < offset
            ? input.incoming
            : input.outgoing;
      const targetOffset = (y * input.width + x) * 3;
      const sourceOffset = (y * input.width + sourceX) * 3;
      source.copy(result, targetOffset, sourceOffset, sourceOffset + 3);
    }
  return result;
}

async function overlayPipTracks(input: {
  composed: Buffer;
  plan: CompositionPlan;
  sourcesById: ReadonlyMap<string, RasterSource>;
  sourceTimeUs: number;
  clip: CompositionPlan["clips"][number];
}): Promise<void> {
  for (const pip of input.plan.pipTracks) {
    const clipRelativeUs = input.sourceTimeUs - input.clip.startUs;
    if (pip.clipId !== undefined && pip.clipId !== input.clip.id) continue;
    if (clipRelativeUs < pip.startUs || clipRelativeUs > pip.endUs) continue;
    const pipSource = input.sourcesById.get(pip.assetId);
    if (pipSource === undefined) throw new RangeError("verified PiP source is not available");
    const pipFrame = await nearestFrame(pipSource, clipRelativeUs - pip.startUs);
    const pipWidth = Math.max(2, Math.round(input.plan.output.width * pip.scale));
    const pipHeight = Math.max(2, Math.round((pipWidth * pipSource.height) / pipSource.width));
    const inset = 24;
    const left = pip.corner.includes("left") ? inset : input.plan.output.width - pipWidth - inset;
    const top = pip.corner.includes("top") ? inset : input.plan.output.height - pipHeight - inset;
    for (let y = 0; y < pipHeight; y += 1)
      for (let x = 0; x < pipWidth; x += 1) {
        const sourceX = Math.floor((x / pipWidth) * pipSource.width);
        const sourceY = Math.floor((y / pipHeight) * pipSource.height);
        const offset = (sourceY * pipSource.width + sourceX) * 3;
        setPixel(input.composed, input.plan.output.width, left + x, top + y, {
          r: pipFrame.pixels[offset] as number,
          g: pipFrame.pixels[offset + 1] as number,
          b: pipFrame.pixels[offset + 2] as number,
        });
      }
  }
}

function smoothstep(value: number): number {
  const clamped = Math.min(1, Math.max(0, value));
  return clamped * clamped * (3 - 2 * clamped);
}

async function overlayVisualTracks(input: {
  composed: Buffer;
  plan: CompositionPlan;
  sourcesById: ReadonlyMap<string, RasterSource>;
  sourceTimeUs: number;
  clipPresentationUs: number;
  presentationTimeForClipSource: (sourceTimeUs: number) => number;
  clip: CompositionPlan["clips"][number];
}): Promise<void> {
  for (const track of input.plan.visualTracks ?? []) {
    if (track.clipId !== input.clip.id) continue;
    if (track.media.kind !== "image" && track.media.kind !== "video") {
      throw new RangeError("resolved visual source has an unsupported media kind");
    }
    const clipRelativeUs = input.sourceTimeUs - input.clip.startUs;
    if (clipRelativeUs < track.startUs || clipRelativeUs > track.endUs) continue;
    const source = input.sourcesById.get(track.mediaId);
    if (source === undefined) throw new RangeError("resolved visual source is unavailable");
    if (
      !Number.isSafeInteger(source.width) ||
      !Number.isSafeInteger(source.height) ||
      source.width < 2 ||
      source.height < 2
    ) {
      throw new RangeError("resolved visual source geometry is invalid");
    }
    if (
      track.media.kind === "video" &&
      (source.width !== track.media.width || source.height !== track.media.height)
    ) {
      throw new RangeError("resolved video visual source geometry does not match registered media");
    }
    const trackStartPresentationUs = input.presentationTimeForClipSource(
      input.clip.startUs + track.startUs,
    );
    const visualOffsetUs =
      track.sync === "source-time"
        ? clipRelativeUs - track.startUs
        : input.clipPresentationUs - trackStartPresentationUs;
    const mediaTimeUs =
      track.media.kind === "image"
        ? track.mediaTrim.startUs
        : track.mediaTrim.startUs + visualOffsetUs;
    if (
      track.media.kind === "video" &&
      (mediaTimeUs < track.mediaTrim.startUs || mediaTimeUs > track.mediaTrim.endUs)
    ) {
      throw new RangeError("visual frame request is outside the declared media trim");
    }
    const frame = await nearestFrame(source, mediaTimeUs);
    const motionOffsetUs = input.clipPresentationUs - trackStartPresentationUs;
    const motionProgress =
      track.motion.preset === "none"
        ? 1
        : smoothstep(Math.min(1, motionOffsetUs / track.motion.durationUs));
    const alpha = track.layout.opacity * (track.motion.preset === "none" ? 1 : motionProgress);
    if (alpha <= 0) continue;
    const motionScale = track.motion.preset === "pop" ? 0.85 + 0.15 * motionProgress : 1;
    const boxWidth = Math.max(2, Math.round(input.plan.output.width * track.layout.scale));
    const boxHeight = Math.max(2, Math.round(input.plan.output.height * track.layout.scale));
    const crop =
      track.layout.crop === "none" ? { x: 0, y: 0, width: 1, height: 1 } : track.layout.crop;
    const cropWidth = source.width * crop.width;
    const cropHeight = source.height * crop.height;
    const fitScale =
      track.layout.fit === "contain"
        ? Math.min(boxWidth / cropWidth, boxHeight / cropHeight)
        : Math.max(boxWidth / cropWidth, boxHeight / cropHeight);
    const drawWidth = Math.max(2, Math.round(cropWidth * fitScale * motionScale));
    const drawHeight = Math.max(2, Math.round(cropHeight * fitScale * motionScale));
    const inset = 24;
    const boxLeft = track.layout.position.includes("left")
      ? inset
      : input.plan.output.width - boxWidth - inset;
    const boxTop = track.layout.position.includes("top")
      ? inset
      : input.plan.output.height - boxHeight - inset;
    const drawLeft = Math.round(boxLeft + (boxWidth - drawWidth) / 2);
    const drawTop = Math.round(boxTop + (boxHeight - drawHeight) / 2);
    const left = Math.max(boxLeft, drawLeft);
    const top = Math.max(boxTop, drawTop);
    const right = Math.min(boxLeft + boxWidth, drawLeft + drawWidth);
    const bottom = Math.min(boxTop + boxHeight, drawTop + drawHeight);
    const borderWidth =
      track.layout.border === "strong" ? 4 : track.layout.border === "light" ? 2 : 0;
    const borderColor =
      track.layout.border === "strong" ? { r: 15, g: 23, b: 42 } : { r: 255, g: 255, b: 255 };
    for (let y = top; y < bottom; y += 1)
      for (let x = left; x < right; x += 1) {
        const drawLocalX = x - drawLeft;
        const drawLocalY = y - drawTop;
        const layoutLocalX = x - boxLeft;
        const layoutLocalY = y - boxTop;
        const roundedWidth = track.layout.fit === "cover" ? boxWidth : drawWidth;
        const roundedHeight = track.layout.fit === "cover" ? boxHeight : drawHeight;
        const roundedX = track.layout.fit === "cover" ? layoutLocalX : drawLocalX;
        const roundedY = track.layout.fit === "cover" ? layoutLocalY : drawLocalY;
        if (
          !roundedRectContains(
            roundedX,
            roundedY,
            roundedWidth,
            roundedHeight,
            track.layout.radiusPx,
          )
        )
          continue;
        const sourceX = Math.min(
          source.width - 1,
          Math.max(0, Math.floor((crop.x + (drawLocalX / drawWidth) * crop.width) * source.width)),
        );
        const sourceY = Math.min(
          source.height - 1,
          Math.max(
            0,
            Math.floor((crop.y + (drawLocalY / drawHeight) * crop.height) * source.height),
          ),
        );
        const offset = (sourceY * source.width + sourceX) * 3;
        const isBorder =
          borderWidth > 0 &&
          (roundedX < borderWidth ||
            roundedY < borderWidth ||
            roundedX >= roundedWidth - borderWidth ||
            roundedY >= roundedHeight - borderWidth);
        blendPixel(
          input.composed,
          input.plan.output.width,
          x,
          y,
          isBorder
            ? borderColor
            : {
                r: frame.pixels[offset] as number,
                g: frame.pixels[offset + 1] as number,
                b: frame.pixels[offset + 2] as number,
              },
          alpha,
        );
      }
  }
}

async function composeCompleteScene(input: {
  plan: CompositionPlan;
  sourcesById: ReadonlyMap<string, RasterSource>;
  source: RasterSource;
  clip: CompositionPlan["clips"][number];
  sourceTimeUs: number;
  clipPresentationUs: number;
  presentationTimeForClipSource: (sourceTimeUs: number) => number;
  tUs: number;
}): Promise<Buffer> {
  const composed = composeRasterFrame({
    plan: input.plan,
    source: input.source,
    sourceFrame: await nearestFrame(input.source, input.sourceTimeUs),
    tUs: input.tUs,
    clipId: input.clip.id,
    clipSourceRelativeUs: input.sourceTimeUs - input.clip.startUs,
    sourceTimeUs: input.sourceTimeUs,
  });
  await overlayPipTracks({
    composed,
    plan: input.plan,
    sourcesById: input.sourcesById,
    sourceTimeUs: input.sourceTimeUs,
    clip: input.clip,
  });
  await overlayVisualTracks({
    composed,
    plan: input.plan,
    sourcesById: input.sourcesById,
    sourceTimeUs: input.sourceTimeUs,
    clipPresentationUs: input.clipPresentationUs,
    presentationTimeForClipSource: input.presentationTimeForClipSource,
    clip: input.clip,
  });
  return composed;
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
      await overlayPipTracks({
        composed,
        plan: input.plan,
        sourcesById: byId,
        sourceTimeUs,
        clip,
      });
      const presentationTimeForClipSource = (clipSourceTimeUs: number): number =>
        presentationTimeForSource(timing, clipSourceTimeUs) - timing.presentationStartUs;
      await overlayVisualTracks({
        composed,
        plan: input.plan,
        sourcesById: byId,
        sourceTimeUs,
        clipPresentationUs: localPresentationUs,
        presentationTimeForClipSource,
        clip,
      });
      const transition = clip.transitionAfter;
      const next = input.plan.clips[clipIndex + 1];
      const nextTiming = schedule[clipIndex + 1];
      const reviewedTransition = input.plan.reviewedTransitions?.find(
        (candidate) => candidate.clipId === clip.id,
      );
      if (
        reviewedTransition !== undefined &&
        reviewedTransition.family !== "cut" &&
        next !== undefined &&
        nextTiming !== undefined &&
        reviewedTransition.durationUs > 0 &&
        localPresentationUs >= durationUs - reviewedTransition.durationUs
      ) {
        const nextSource = byId.get(next.sourceId ?? input.sources[0]?.id ?? "");
        if (nextSource === undefined) throw new RangeError("transition source is not available");
        const nextPresentationUs =
          localPresentationUs - (durationUs - reviewedTransition.durationUs);
        const nextSourceUs = Math.round(sourceTimeForPresentation(next, nextPresentationUs));
        const nextScene = await composeCompleteScene({
          plan: input.plan,
          sourcesById: byId,
          source: nextSource,
          clip: next,
          sourceTimeUs: nextSourceUs,
          clipPresentationUs: nextPresentationUs,
          presentationTimeForClipSource: (nextClipSourceTimeUs) =>
            presentationTimeForSource(nextTiming, nextClipSourceTimeUs) -
            nextTiming.presentationStartUs,
          tUs,
        });
        composed = composeReviewedTransition({
          outgoing: composed,
          incoming: nextScene,
          width: input.plan.output.width,
          family: reviewedTransition.family,
          easing: reviewedTransition.easing,
          ...(reviewedTransition.color === undefined ? {} : { color: reviewedTransition.color }),
          rawProgress: nextPresentationUs / reviewedTransition.durationUs,
        });
      } else if (
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
