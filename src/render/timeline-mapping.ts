import type { CompositionPlan, SourceClip } from "./composition.js";

type RatePart = {
  startUs: number;
  endUs: number;
  startRate: number;
  endRate: number;
};

export type ClipSchedule = {
  clip: SourceClip;
  presentationStartUs: number;
  renderedDurationUs: number;
  incomingCrossfadeUs: number;
};

function rateParts(clip: SourceClip): RatePart[] {
  const parts: RatePart[] = [];
  let cursor = clip.startUs;
  for (const region of clip.speedRegions ?? []) {
    if (region.startUs > cursor) {
      parts.push({ startUs: cursor, endUs: region.startUs, startRate: 1, endRate: 1 });
    }
    parts.push(region);
    cursor = region.endUs;
  }
  if (cursor < clip.endUs) {
    parts.push({ startUs: cursor, endUs: clip.endUs, startRate: 1, endRate: 1 });
  }
  return parts;
}

function partDurationUs(part: RatePart): number {
  const length = part.endUs - part.startUs;
  const delta = part.endRate - part.startRate;
  return Math.abs(delta) < 1e-9
    ? length / part.startRate
    : (length / delta) * Math.log(part.endRate / part.startRate);
}

export function renderedClipDurationUs(clip: SourceClip): number {
  return rateParts(clip).reduce((total, part) => total + partDurationUs(part), 0);
}

export function presentationTimeForSource(schedule: ClipSchedule, sourceTimeUs: number): number {
  if (sourceTimeUs < schedule.clip.startUs || sourceTimeUs > schedule.clip.endUs) {
    throw new RangeError("source time is outside the clip trim");
  }
  let elapsedUs = 0;
  for (const part of rateParts(schedule.clip)) {
    if (sourceTimeUs >= part.endUs) {
      elapsedUs += partDurationUs(part);
      continue;
    }
    if (sourceTimeUs <= part.startUs) break;
    const fraction = (sourceTimeUs - part.startUs) / (part.endUs - part.startUs);
    elapsedUs += partDurationUs({
      ...part,
      endUs: sourceTimeUs,
      endRate: part.startRate + (part.endRate - part.startRate) * fraction,
    });
    break;
  }
  return schedule.presentationStartUs + elapsedUs;
}

export function sourceTimeForPresentation(clip: SourceClip, localPresentationUs: number): number {
  let remainingUs = localPresentationUs;
  for (const part of rateParts(clip)) {
    const durationUs = partDurationUs(part);
    if (remainingUs > durationUs) {
      remainingUs -= durationUs;
      continue;
    }
    const length = part.endUs - part.startUs;
    const delta = part.endRate - part.startRate;
    const advanceUs =
      Math.abs(delta) < 1e-9
        ? remainingUs * part.startRate
        : ((length * part.startRate) / delta) * Math.expm1((remainingUs * delta) / length);
    return Math.min(part.endUs, part.startUs + advanceUs);
  }
  return clip.endUs;
}

export function buildClipSchedule(plan: CompositionPlan): ClipSchedule[] {
  const durations = plan.clips.map((clip) => renderedClipDurationUs(clip));
  const schedule: ClipSchedule[] = [];
  let presentationStartUs = 0;
  for (const [index, clip] of plan.clips.entries()) {
    const previous = plan.clips[index - 1];
    const incomingCrossfadeUs =
      previous?.transitionAfter?.kind === "crossfade" ? previous.transitionAfter.durationUs : 0;
    const outgoingCrossfadeUs =
      clip.transitionAfter?.kind === "crossfade" ? clip.transitionAfter.durationUs : 0;
    if (outgoingCrossfadeUs > 0) {
      const nextDurationUs = durations[index + 1];
      if (
        nextDurationUs === undefined ||
        outgoingCrossfadeUs > (durations[index] as number) ||
        outgoingCrossfadeUs > nextDurationUs ||
        outgoingCrossfadeUs < 1_000_000 / plan.output.fps
      ) {
        throw new RangeError("crossfade must fit both adjacent rendered clip durations");
      }
    }
    schedule.push({
      clip,
      presentationStartUs,
      renderedDurationUs: durations[index] as number,
      incomingCrossfadeUs,
    });
    presentationStartUs += (durations[index] as number) - outgoingCrossfadeUs;
  }
  return schedule;
}

export function assembledPresentationDurationUs(plan: CompositionPlan): number {
  const schedule = buildClipSchedule(plan);
  const final = schedule.at(-1);
  return final === undefined ? 0 : final.presentationStartUs + final.renderedDurationUs;
}
