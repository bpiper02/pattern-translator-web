import { drumTimbreDistance, type DrumLane, type DrumTimbreFeatures } from "../analysis/drumTimbreCore";

export type RepresentativeDrumHit = DrumTimbreFeatures & {
  time: number;
  beat: number;
  lane: DrumLane;
  velocity: number;
  sourceEventId?: string;
};

export type RepresentativeScore = {
  total: number;
  timbre: number;
  isolation: number;
  tailSpace: number;
  preSpace: number;
  typicalVelocity: number;
  strength: number;
};

function clamp01(value: number) {
  return Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
}

function median(values: number[]) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function meanTimbreDistance(hit: RepresentativeDrumHit, laneHits: RepresentativeDrumHit[]) {
  const peers = laneHits.filter((candidate) => candidate.id !== hit.id);
  if (!peers.length) return 0;
  return peers.reduce((sum, peer) => sum + drumTimbreDistance(hit, peer), 0) / peers.length;
}

function nearestGap(hit: RepresentativeDrumHit, allHits: RepresentativeDrumHit[]) {
  let nearest = Number.POSITIVE_INFINITY;
  for (const candidate of allHits) {
    if (candidate.id === hit.id) continue;
    nearest = Math.min(nearest, Math.abs(candidate.time - hit.time));
  }
  return nearest;
}

function directionalGap(
  hit: RepresentativeDrumHit,
  allHits: RepresentativeDrumHit[],
  direction: "before" | "after",
) {
  let gap = Number.POSITIVE_INFINITY;
  for (const candidate of allHits) {
    if (candidate.id === hit.id) continue;
    const delta = candidate.time - hit.time;
    // Simultaneous layered observations share one source transient and should
    // penalize isolation, but they are not a future/past slice boundary.
    if (Math.abs(delta) <= 0.005) continue;
    if (direction === "after" && delta > 0) gap = Math.min(gap, delta);
    if (direction === "before" && delta < 0) gap = Math.min(gap, -delta);
  }
  return gap;
}

export function scoreRepresentativeHit(
  hit: RepresentativeDrumHit,
  laneHits: RepresentativeDrumHit[],
  allHits: RepresentativeDrumHit[],
): RepresentativeScore {
  const laneVelocityMedian = median(laneHits.map((candidate) => candidate.velocity));
  const timbreDistance = meanTimbreDistance(hit, laneHits);
  const timbre = 1 / (1 + timbreDistance * 2.2);
  const isolation = clamp01(nearestGap(hit, allHits) / 0.14);
  const tailSpace = clamp01(directionalGap(hit, allHits, "after") / 0.35);
  const preSpace = clamp01(directionalGap(hit, allHits, "before") / 0.08);
  const typicalVelocity = clamp01(1 - Math.abs(hit.velocity - laneVelocityMedian) / 79);
  const strength = clamp01((hit.velocity - 48) / 79);

  // Timbre centrality and isolation dominate. Loudness is intentionally a small
  // cue: the loudest accent is often the worst representative sample because it
  // is layered, clipped or atypical.
  const total =
    timbre * 0.34 +
    isolation * 0.28 +
    tailSpace * 0.16 +
    preSpace * 0.07 +
    typicalVelocity * 0.10 +
    strength * 0.05;

  return { total, timbre, isolation, tailSpace, preSpace, typicalVelocity, strength };
}

export function selectRepresentativeDrumHit<T extends RepresentativeDrumHit>(
  laneHits: T[],
  allHits: RepresentativeDrumHit[],
): T | null {
  if (!laneHits.length) return null;

  return [...laneHits]
    .map((hit) => ({ hit, score: scoreRepresentativeHit(hit, laneHits, allHits) }))
    .sort((a, b) => b.score.total - a.score.total || b.hit.velocity - a.hit.velocity)[0].hit;
}
