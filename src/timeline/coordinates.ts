export type Point = { x: number; y: number };
export type Dimensions = { width: number; height: number };

function assertDimensions(value: Dimensions, name: string): void {
  if (
    !Number.isFinite(value.width) ||
    !Number.isFinite(value.height) ||
    value.width <= 0 ||
    value.height <= 0
  ) {
    throw new RangeError(`${name} dimensions must be positive finite numbers`);
  }
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum);
}

export function cssPointToCapturePoint(
  point: Point,
  viewport: Dimensions,
  capture: Dimensions,
): Point {
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) {
    throw new RangeError("point coordinates must be finite numbers");
  }
  assertDimensions(viewport, "viewport");
  assertDimensions(capture, "capture");
  return {
    x: clamp((point.x / viewport.width) * capture.width, 0, capture.width),
    y: clamp((point.y / viewport.height) * capture.height, 0, capture.height),
  };
}
