export type SourceFrame = { frameId: number; tUs: number };

export type FrameGridOptions = {
  fps: number;
  durationUs: number;
  cadenceGapUs?: number;
};

export type FrameSlot = {
  outputIndex: number;
  tUs: number;
  sourceFrameId: number | undefined;
  isDistinctSource: boolean;
};

export type CadenceGap = { fromFrameId: number; toFrameId: number; gapUs: number };

export type FrameGrid = {
  slots: FrameSlot[];
  health: {
    longestInterFrameGapUs: number;
    cadenceGaps: CadenceGap[];
    distinctSourceSlotRatio: number;
  };
};

function assertPositiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
}

function assertFrames(frames: readonly SourceFrame[]): void {
  let previous: SourceFrame | undefined;
  for (const frame of frames) {
    assertPositiveInteger(frame.frameId, "frame.frameId");
    if (!Number.isSafeInteger(frame.tUs) || frame.tUs < 0) {
      throw new RangeError("frame.tUs must be a non-negative safe integer");
    }
    if (previous !== undefined && frame.tUs <= previous.tUs) {
      throw new RangeError("source frame timestamps must be strictly increasing");
    }
    previous = frame;
  }
}

export function normalizeFrameGrid(
  frames: readonly SourceFrame[],
  options: FrameGridOptions,
): FrameGrid {
  assertFrames(frames);
  assertPositiveInteger(options.fps, "fps");
  assertPositiveInteger(options.durationUs, "durationUs");
  const cadenceGapUs = options.cadenceGapUs ?? 500_000;
  assertPositiveInteger(cadenceGapUs, "cadenceGapUs");

  const slotCount = Math.ceil((options.durationUs * options.fps) / 1_000_000);
  const slots: FrameSlot[] = [];
  let frameIndex = 0;
  let activeIndex = -1;
  let lastSelectedIndex = -1;
  for (let outputIndex = 0; outputIndex < slotCount; outputIndex += 1) {
    const tUs = Math.floor((outputIndex * 1_000_000) / options.fps);
    let next = frames[frameIndex];
    while (next !== undefined && next.tUs <= tUs) {
      activeIndex = frameIndex;
      frameIndex += 1;
      next = frames[frameIndex];
    }
    const active = activeIndex >= 0 ? frames[activeIndex] : undefined;
    const isDistinctSource = activeIndex >= 0 && activeIndex !== lastSelectedIndex;
    if (isDistinctSource) lastSelectedIndex = activeIndex;
    slots.push({ outputIndex, tUs, sourceFrameId: active?.frameId, isDistinctSource });
  }

  const cadenceGaps: CadenceGap[] = [];
  let longestInterFrameGapUs = 0;
  for (let index = 1; index < frames.length; index += 1) {
    const previous = frames[index - 1];
    const current = frames[index];
    if (previous === undefined || current === undefined) continue;
    const gapUs = current.tUs - previous.tUs;
    longestInterFrameGapUs = Math.max(longestInterFrameGapUs, gapUs);
    if (gapUs > cadenceGapUs) {
      cadenceGaps.push({ fromFrameId: previous.frameId, toFrameId: current.frameId, gapUs });
    }
  }
  const distinctSourceSlotCount = slots.filter((slot) => slot.isDistinctSource).length;
  return {
    slots,
    health: {
      longestInterFrameGapUs,
      cadenceGaps,
      distinctSourceSlotRatio: slots.length === 0 ? 0 : distinctSourceSlotCount / slots.length,
    },
  };
}
