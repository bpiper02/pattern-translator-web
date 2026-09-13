import { classifyDrumTimbres, type DrumLane, type DrumTimbreFeatures } from "./drumTimbreCore";

export type LayeredDrumCandidate = DrumTimbreFeatures & {
  time: number;
  beat: number;
  velocity: number;
};

export type LayeredDrumHit = DrumTimbreFeatures & {
  time: number;
  beat: number;
  lane: DrumLane;
  velocity: number;
  sourceEventId: string;
};

export type LayerBandOnsets = {
  low: number[];
  mid: number[];
  high: number[];
};

function hasNearbyOnset(time: number, onsets: number[], toleranceSeconds: number) {
  return onsets.some((onset) => Math.abs(onset - time) <= toleranceSeconds);
}

function addLane(lanes: DrumLane[], lane: DrumLane) {
  if (!lanes.includes(lane)) lanes.push(lane);
}

/**
 * Expand one full-band transient into one or more UI drum lanes using independent
 * low/mid/high-band onset evidence plus the transient's full-band spectrum.
 *
 * Evidence-backed lanes win over a weak mixed-spectrum primary label. The primary
 * classifier remains the fallback when the multiband evidence cannot justify any
 * canonical lane (for example, tonal percussion).
 */
export function recoverLayeredDrumHits(
  candidates: LayeredDrumCandidate[],
  bandOnsets: LayerBandOnsets,
  toleranceSeconds = 0.035,
): LayeredDrumHit[] {
  if (!candidates.length) return [];
  const primaryLanes = classifyDrumTimbres(candidates);
  const output: LayeredDrumHit[] = [];

  candidates.forEach((candidate, index) => {
    const primary = primaryLanes[index] ?? 2;
    const lanes: DrumLane[] = [];
    const lowEvidence = hasNearbyOnset(candidate.time, bandOnsets.low, toleranceSeconds);
    const midEvidence = hasNearbyOnset(candidate.time, bandOnsets.mid, toleranceSeconds);
    const highEvidence = hasNearbyOnset(candidate.time, bandOnsets.high, toleranceSeconds);
    const upperEnergy = candidate.midHighRatio + candidate.highRatio;

    if (
      lowEvidence &&
      candidate.lowRatio >= 0.16 &&
      candidate.lowRatio >= upperEnergy * 0.55
    ) addLane(lanes, 0);

    if (
      highEvidence &&
      candidate.highRatio >= 0.12 &&
      candidate.highRatio >= candidate.midHighRatio * 1.50 &&
      candidate.rolloffHz >= 5_500 &&
      candidate.zcr >= 0.07
    ) addLane(lanes, 3);

    if (
      midEvidence &&
      candidate.midLowRatio >= 0.12 &&
      upperEnergy >= 0.22 &&
      candidate.zcr >= 0.07 &&
      candidate.rolloffHz >= 1_800
    ) addLane(lanes, 1);

    if (!lanes.length) {
      addLane(lanes, primary);
    } else if (primary !== 2) {
      addLane(lanes, primary);
    }

    lanes.forEach((lane, laneIndex) => {
      output.push({
        ...candidate,
        id: `${candidate.id}-layer-${lane}-${laneIndex}`,
        sourceEventId: candidate.id,
        lane,
        velocity: lane === primary ? candidate.velocity : Math.max(48, Math.round(candidate.velocity * 0.92)),
      });
    });
  });

  return output.sort((a, b) => a.time - b.time || a.lane - b.lane);
}
