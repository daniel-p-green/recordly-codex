/**
 * Capture sources are decoded to packed RGB24 before preview rendering. Keep this
 * envelope aligned with the production source resolver so a validated revision
 * cannot be rejected later solely because its sealed capture is too large.
 */
export const MIN_CAPTURE_SOURCE_DIMENSION = 2;
export const MAX_CAPTURE_SOURCE_WIDTH = 4096;
export const MAX_CAPTURE_SOURCE_HEIGHT = 2160;
export const MAX_CAPTURE_SOURCE_PIXELS = MAX_CAPTURE_SOURCE_WIDTH * MAX_CAPTURE_SOURCE_HEIGHT;

export type CaptureSourceGeometry = { width: number; height: number };

export function isCaptureSourceGeometryBounded(value: CaptureSourceGeometry): boolean {
  return (
    Number.isSafeInteger(value.width) &&
    Number.isSafeInteger(value.height) &&
    value.width >= MIN_CAPTURE_SOURCE_DIMENSION &&
    value.height >= MIN_CAPTURE_SOURCE_DIMENSION &&
    value.width <= MAX_CAPTURE_SOURCE_WIDTH &&
    value.height <= MAX_CAPTURE_SOURCE_HEIGHT &&
    value.width * value.height <= MAX_CAPTURE_SOURCE_PIXELS
  );
}

export function assertCaptureSourceGeometryBounded(value: CaptureSourceGeometry): void {
  if (!isCaptureSourceGeometryBounded(value)) {
    throw new RangeError("capture source geometry exceeds renderer pixel bounds");
  }
}
