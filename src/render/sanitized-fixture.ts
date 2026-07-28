import {
  cleanupFixtureArtifacts,
  createFixtureArtifactPaths,
  encodeFixtureFrames,
  fixtureVideoContract,
} from "../encoder/ffmpeg.js";
import {
  assertFixtureContract,
  extractFixtureSampleFrames,
  probeRenderedVideo,
} from "../encoder/probe.js";

const sourceWidth = 1440;
const sourceHeight = 810;
const sourceX = 240;
const sourceY = 135;
const bytesPerPixel = 3;

type Rgb = readonly [number, number, number];
type Point = { x: number; y: number };

const colors = {
  canvas: [15, 23, 42],
  canvasAccent: [30, 41, 59],
  shadow: [2, 6, 23],
  frame: [241, 245, 249],
  browserChrome: [226, 232, 240],
  surface: [255, 255, 255],
  sidebar: [248, 250, 252],
  text: [30, 41, 59],
  muted: [100, 116, 139],
  line: [226, 232, 240],
  blue: [37, 99, 235],
  cyan: [6, 182, 212],
  green: [16, 185, 129],
  click: [251, 113, 133],
  cursorBorder: [15, 23, 42],
  cursorFill: [255, 255, 255],
} satisfies Record<string, Rgb>;

function color(buffer: Buffer, offset: number, rgb: Rgb): void {
  buffer[offset] = rgb[0];
  buffer[offset + 1] = rgb[1];
  buffer[offset + 2] = rgb[2];
}

function fillRect(
  buffer: Buffer,
  width: number,
  height: number,
  x: number,
  y: number,
  rectWidth: number,
  rectHeight: number,
  rgb: Rgb,
): void {
  const left = Math.max(0, Math.floor(x));
  const top = Math.max(0, Math.floor(y));
  const right = Math.min(width, Math.ceil(x + rectWidth));
  const bottom = Math.min(height, Math.ceil(y + rectHeight));
  for (let row = top; row < bottom; row += 1) {
    for (let column = left; column < right; column += 1) {
      color(buffer, (row * width + column) * bytesPerPixel, rgb);
    }
  }
}

function fillCircle(
  buffer: Buffer,
  width: number,
  height: number,
  center: Point,
  radius: number,
  rgb: Rgb,
  outlineOnly = false,
): void {
  const squaredRadius = radius * radius;
  const innerSquaredRadius = (radius - 2) * (radius - 2);
  for (
    let y = Math.max(0, Math.floor(center.y - radius));
    y <= Math.min(height - 1, center.y + radius);
    y += 1
  ) {
    for (
      let x = Math.max(0, Math.floor(center.x - radius));
      x <= Math.min(width - 1, center.x + radius);
      x += 1
    ) {
      const distance = (x - center.x) ** 2 + (y - center.y) ** 2;
      if (distance <= squaredRadius && (!outlineOnly || distance >= innerSquaredRadius)) {
        color(buffer, (y * width + x) * bytesPerPixel, rgb);
      }
    }
  }
}

function createBrowserSourceFrame(): Buffer {
  const source = Buffer.alloc(sourceWidth * sourceHeight * bytesPerPixel);
  fillRect(source, sourceWidth, sourceHeight, 0, 0, sourceWidth, sourceHeight, colors.surface);
  fillRect(source, sourceWidth, sourceHeight, 0, 0, sourceWidth, 72, colors.browserChrome);
  fillRect(source, sourceWidth, sourceHeight, 24, 18, 18, 18, colors.click);
  fillCircle(source, sourceWidth, sourceHeight, { x: 72, y: 27 }, 9, colors.click);
  fillCircle(source, sourceWidth, sourceHeight, { x: 98, y: 27 }, 9, [251, 191, 36]);
  fillCircle(source, sourceWidth, sourceHeight, { x: 124, y: 27 }, 9, colors.green);
  fillRect(source, sourceWidth, sourceHeight, 202, 16, 440, 32, colors.surface);
  fillRect(source, sourceWidth, sourceHeight, 228, 29, 260, 6, colors.line);
  fillRect(source, sourceWidth, sourceHeight, 0, 72, 256, sourceHeight - 72, colors.sidebar);
  fillRect(source, sourceWidth, sourceHeight, 32, 116, 152, 22, colors.text);
  for (let index = 0; index < 5; index += 1) {
    fillRect(source, sourceWidth, sourceHeight, 34, 180 + index * 62, 164, 12, colors.muted);
    fillRect(
      source,
      sourceWidth,
      sourceHeight,
      34,
      202 + index * 62,
      100 + index * 10,
      7,
      colors.line,
    );
  }
  fillRect(source, sourceWidth, sourceHeight, 300, 112, 524, 32, colors.text);
  fillRect(source, sourceWidth, sourceHeight, 300, 166, 320, 14, colors.muted);
  fillRect(source, sourceWidth, sourceHeight, 300, 215, 732, 196, colors.sidebar);
  fillRect(source, sourceWidth, sourceHeight, 330, 248, 170, 13, colors.muted);
  fillRect(source, sourceWidth, sourceHeight, 330, 282, 620, 10, colors.line);
  fillRect(source, sourceWidth, sourceHeight, 330, 314, 480, 10, colors.line);
  fillRect(source, sourceWidth, sourceHeight, 330, 356, 224, 32, colors.blue);
  fillRect(source, sourceWidth, sourceHeight, 1080, 112, 176, 42, colors.blue);
  fillRect(source, sourceWidth, sourceHeight, 1080, 480, 272, 204, colors.sidebar);
  fillRect(source, sourceWidth, sourceHeight, 1112, 516, 126, 13, colors.muted);
  for (let index = 0; index < 4; index += 1) {
    fillRect(source, sourceWidth, sourceHeight, 1112, 556 + index * 28, 172, 10, colors.line);
  }
  fillRect(source, sourceWidth, sourceHeight, 300, 470, 730, 214, colors.sidebar);
  for (let index = 0; index < 5; index += 1) {
    const barHeight = 42 + index * 20;
    fillRect(
      source,
      sourceWidth,
      sourceHeight,
      354 + index * 112,
      640 - barHeight,
      64,
      barHeight,
      index % 2 === 0 ? colors.cyan : colors.green,
    );
  }
  return source;
}

function drawSourceFrame(target: Buffer, source: Buffer, frameIndex: number): Point {
  const zoomProgress = Math.max(0, Math.min(1, (frameIndex - 11) / 8));
  const zoom = 1 + zoomProgress * 0.12;
  const focus = { x: 780, y: 362 };
  for (let y = 0; y < sourceHeight; y += 1) {
    const sourceYPosition = Math.max(
      0,
      Math.min(sourceHeight - 1, Math.floor(focus.y + (y - focus.y) / zoom)),
    );
    for (let x = 0; x < sourceWidth; x += 1) {
      const sourceXPosition = Math.max(
        0,
        Math.min(sourceWidth - 1, Math.floor(focus.x + (x - focus.x) / zoom)),
      );
      const sourceOffset = (sourceYPosition * sourceWidth + sourceXPosition) * bytesPerPixel;
      const targetOffset =
        ((sourceY + y) * fixtureVideoContract.width + sourceX + x) * bytesPerPixel;
      target[targetOffset] = source[sourceOffset] ?? 0;
      target[targetOffset + 1] = source[sourceOffset + 1] ?? 0;
      target[targetOffset + 2] = source[sourceOffset + 2] ?? 0;
    }
  }
  return focus;
}

function pointInOutput(sourcePoint: Point, focus: Point, frameIndex: number): Point {
  const zoomProgress = Math.max(0, Math.min(1, (frameIndex - 11) / 8));
  const zoom = 1 + zoomProgress * 0.12;
  return {
    x: sourceX + focus.x + (sourcePoint.x - focus.x) * zoom,
    y: sourceY + focus.y + (sourcePoint.y - focus.y) * zoom,
  };
}

function drawCursor(target: Buffer, point: Point, frameIndex: number): void {
  const width = fixtureVideoContract.width;
  const height = fixtureVideoContract.height;
  const roundedX = Math.round(point.x);
  const roundedY = Math.round(point.y);
  for (let row = 0; row < 25; row += 1) {
    for (let column = 0; column <= Math.floor((24 - row) * 0.72); column += 1) {
      const isBorder = row < 2 || column < 2 || column >= Math.floor((24 - row) * 0.72) - 1;
      fillRect(
        target,
        width,
        height,
        roundedX + column,
        roundedY + row,
        1,
        1,
        isBorder ? colors.cursorBorder : colors.cursorFill,
      );
    }
  }
  const clickProgress = Math.max(0, 1 - Math.abs(frameIndex - 15) / 5);
  if (clickProgress > 0) {
    fillCircle(
      target,
      width,
      height,
      { x: roundedX + 7, y: roundedY + 8 },
      14 + Math.round((1 - clickProgress) * 26),
      colors.click,
      true,
    );
  }
}

function createOutputFrame(source: Buffer, frameIndex: number): Buffer {
  const target = Buffer.alloc(
    fixtureVideoContract.width * fixtureVideoContract.height * bytesPerPixel,
  );
  fillRect(
    target,
    fixtureVideoContract.width,
    fixtureVideoContract.height,
    0,
    0,
    fixtureVideoContract.width,
    fixtureVideoContract.height,
    colors.canvas,
  );
  fillRect(
    target,
    fixtureVideoContract.width,
    fixtureVideoContract.height,
    0,
    0,
    1920,
    130,
    colors.canvasAccent,
  );
  fillRect(
    target,
    fixtureVideoContract.width,
    fixtureVideoContract.height,
    0,
    950,
    1920,
    130,
    colors.canvasAccent,
  );
  fillCircle(
    target,
    fixtureVideoContract.width,
    fixtureVideoContract.height,
    { x: 1700, y: 120 },
    260,
    [30, 64, 175],
  );
  fillRect(
    target,
    fixtureVideoContract.width,
    fixtureVideoContract.height,
    sourceX - 18,
    sourceY - 18,
    sourceWidth + 36,
    sourceHeight + 36,
    colors.shadow,
  );
  fillRect(
    target,
    fixtureVideoContract.width,
    fixtureVideoContract.height,
    sourceX - 10,
    sourceY - 10,
    sourceWidth + 20,
    sourceHeight + 20,
    colors.frame,
  );
  const focus = drawSourceFrame(target, source, frameIndex);
  const cursor = pointInOutput(
    { x: 660 + frameIndex * 4, y: 320 + frameIndex * 1.5 },
    focus,
    frameIndex,
  );
  drawCursor(target, cursor, frameIndex);
  return target;
}

async function* renderedFrames(): AsyncGenerator<Buffer> {
  const source = createBrowserSourceFrame();
  for (let frameIndex = 0; frameIndex < fixtureVideoContract.frameCount; frameIndex += 1) {
    yield createOutputFrame(source, frameIndex);
  }
}

export type RenderedFixtureCandidate = {
  artifactRoot: string;
  outputPath: string;
  firstFramePath: string;
  clickFramePath: string;
};

export async function renderSanitizedFixtureCandidate(): Promise<RenderedFixtureCandidate> {
  const artifactPaths = await createFixtureArtifactPaths();
  try {
    await encodeFixtureFrames(renderedFrames(), artifactPaths);
    const probe = await probeRenderedVideo(artifactPaths.outputPath);
    assertFixtureContract(probe);
    await extractFixtureSampleFrames(artifactPaths.outputPath, artifactPaths);
    return artifactPaths;
  } catch (error) {
    await cleanupFixtureArtifacts(artifactPaths);
    throw error;
  }
}

export async function cleanupRenderedFixtureCandidate(
  candidate: RenderedFixtureCandidate,
): Promise<void> {
  await cleanupFixtureArtifacts(candidate);
}
