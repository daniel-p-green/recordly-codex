export type Rgb = { r: number; g: number; b: number };

export type PpmImage = {
  width: number;
  height: number;
  maxValue: 255;
  pixels: Buffer;
};

function isWhitespace(byte: number): boolean {
  return byte === 9 || byte === 10 || byte === 13 || byte === 32;
}

function skipWhitespaceAndComments(bytes: Buffer, offset: number): number {
  let next = offset;
  while (next < bytes.length) {
    const byte = bytes[next];
    if (byte === undefined) break;
    if (isWhitespace(byte)) {
      next += 1;
      continue;
    }
    if (byte === 35) {
      next += 1;
      while (next < bytes.length && bytes[next] !== 10 && bytes[next] !== 13) next += 1;
      continue;
    }
    break;
  }
  return next;
}

function readHeaderToken(bytes: Buffer, offset: number): { value: string; offset: number } {
  const start = skipWhitespaceAndComments(bytes, offset);
  let end = start;
  while (end < bytes.length) {
    const byte = bytes[end];
    if (byte === undefined || isWhitespace(byte) || byte === 35) break;
    if (byte > 127) throw new Error("PPM header must be ASCII");
    end += 1;
  }
  if (end === start) throw new Error("PPM header is missing a required token");
  return { value: bytes.subarray(start, end).toString("ascii"), offset: end };
}

function parsePositiveInteger(token: string, name: string): number {
  if (!/^[0-9]+$/u.test(token)) throw new Error(`PPM ${name} must be a positive integer`);
  const value = Number(token);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`PPM ${name} must be a positive safe integer`);
  }
  return value;
}

function pixelOffsetAfterMaxValue(bytes: Buffer, offset: number): number {
  const delimiter = bytes[offset];
  if (delimiter === undefined || !isWhitespace(delimiter)) {
    throw new Error("PPM max value must be followed by a whitespace delimiter");
  }
  if (delimiter === 13 && bytes[offset + 1] === 10) return offset + 2;
  return offset + 1;
}

export function parsePpm(bytes: Buffer): PpmImage {
  const magic = readHeaderToken(bytes, 0);
  if (magic.value !== "P6") throw new Error("PPM magic must be P6");
  const widthToken = readHeaderToken(bytes, magic.offset);
  const heightToken = readHeaderToken(bytes, widthToken.offset);
  const maxValueToken = readHeaderToken(bytes, heightToken.offset);
  const width = parsePositiveInteger(widthToken.value, "width");
  const height = parsePositiveInteger(heightToken.value, "height");
  if (maxValueToken.value !== "255") throw new Error("PPM max value must be 255");
  const pixelOffset = pixelOffsetAfterMaxValue(bytes, maxValueToken.offset);
  const expectedPixelBytes = width * height * 3;
  if (!Number.isSafeInteger(expectedPixelBytes))
    throw new Error("PPM dimensions overflow RGB payload");
  if (bytes.length - pixelOffset !== expectedPixelBytes) {
    throw new Error("PPM pixel payload length does not match its dimensions");
  }
  return { width, height, maxValue: 255, pixels: bytes.subarray(pixelOffset) };
}

function assertPixelBounds(image: PpmImage, x: number, y: number): void {
  if (
    !Number.isInteger(x) ||
    !Number.isInteger(y) ||
    x < 0 ||
    y < 0 ||
    x >= image.width ||
    y >= image.height
  ) {
    throw new RangeError("PPM pixel coordinate is outside image bounds");
  }
}

export function ppmPixelAt(image: PpmImage, x: number, y: number): Rgb {
  assertPixelBounds(image, x, y);
  const offset = (y * image.width + x) * 3;
  return {
    r: image.pixels[offset] ?? 0,
    g: image.pixels[offset + 1] ?? 0,
    b: image.pixels[offset + 2] ?? 0,
  };
}

export function averagePpmRegion(
  image: PpmImage,
  x: number,
  y: number,
  width: number,
  height: number,
): Rgb {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new RangeError("PPM region dimensions must be positive integers");
  }
  assertPixelBounds(image, x, y);
  assertPixelBounds(image, x + width - 1, y + height - 1);
  let red = 0;
  let green = 0;
  let blue = 0;
  for (let row = y; row < y + height; row += 1) {
    for (let column = x; column < x + width; column += 1) {
      const pixel = ppmPixelAt(image, column, row);
      red += pixel.r;
      green += pixel.g;
      blue += pixel.b;
    }
  }
  const count = width * height;
  return { r: red / count, g: green / count, b: blue / count };
}

export function isRgbWithin(actual: Rgb, expected: Rgb, tolerance: number): boolean {
  if (!Number.isFinite(tolerance) || tolerance < 0) {
    throw new RangeError("RGB tolerance must be a non-negative finite number");
  }
  return (
    Math.abs(actual.r - expected.r) <= tolerance &&
    Math.abs(actual.g - expected.g) <= tolerance &&
    Math.abs(actual.b - expected.b) <= tolerance
  );
}
