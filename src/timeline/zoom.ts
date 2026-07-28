export type ZoomCandidateKind = "marker" | "click" | "type" | "scroll";

export type ZoomCandidate = {
  id: string;
  tUs: number;
  kind: ZoomCandidateKind;
  x: number;
  y: number;
};

export type SelectedZoomCandidate = ZoomCandidate & {
  score: number;
  wonAgainst: string[];
};

const scores: Record<ZoomCandidateKind, number> = {
  marker: 4,
  click: 3,
  type: 2,
  scroll: 1,
};

function compareCandidates(left: ZoomCandidate, right: ZoomCandidate): number {
  const scoreDifference = scores[right.kind] - scores[left.kind];
  if (scoreDifference !== 0) return scoreDifference;
  return left.id.localeCompare(right.id);
}

export function selectZoomCandidates(
  candidates: readonly ZoomCandidate[],
  options: { minSeparationUs?: number } = {},
): SelectedZoomCandidate[] {
  const minSeparationUs = options.minSeparationUs ?? 1_200_000;
  if (!Number.isSafeInteger(minSeparationUs) || minSeparationUs < 0) {
    throw new RangeError("minSeparationUs must be a non-negative safe integer");
  }
  for (const candidate of candidates) {
    if (
      !candidate.id ||
      !Number.isSafeInteger(candidate.tUs) ||
      candidate.tUs < 0 ||
      !Number.isFinite(candidate.x) ||
      !Number.isFinite(candidate.y)
    ) {
      throw new RangeError("zoom candidates must have bounded IDs, timestamps, and coordinates");
    }
  }

  const remaining = [...candidates].sort(compareCandidates);
  const selected: SelectedZoomCandidate[] = [];
  while (remaining.length > 0) {
    const winner = remaining.shift();
    if (winner === undefined) break;
    const overlapping = remaining.filter(
      (candidate) => Math.abs(candidate.tUs - winner.tUs) < minSeparationUs,
    );
    selected.push({
      ...winner,
      score: scores[winner.kind],
      wonAgainst: overlapping.map((candidate) => candidate.id).sort(),
    });
    for (let index = remaining.length - 1; index >= 0; index -= 1) {
      const candidate = remaining[index];
      if (candidate !== undefined && Math.abs(candidate.tUs - winner.tUs) < minSeparationUs) {
        remaining.splice(index, 1);
      }
    }
  }
  return selected.sort((left, right) => left.tUs - right.tUs || left.id.localeCompare(right.id));
}
