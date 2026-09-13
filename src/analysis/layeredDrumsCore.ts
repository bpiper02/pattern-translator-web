import { classifyDrumTimbres, type DrumLane, type DrumTimbreFeatures } from "./drumTimbreCore";

export type LayeredDrumCandidate = DrumTimbreFeatures & {
  time: number;
  beat: number;
  velocity: number;
};

export type LayeredDrumHit = {
  id: string;
  time: number;
  beat: number;
  lane: DrumLane;
  velocity: number;
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
 * Expand a full-band onset into one or more UI drum lanes using independent
 * low/mid/high-band onset evidence plus the transient's full-band spectrum.
 *
 * The primary timbre classifier remains authoritative for the first lane. Extra
 * lanes require BOTH an onset in the corresponding frequency band and spectral
 * evidence strong enough to avoid turning one broadband snare into snare+hat.
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
    const lanes: DrumLane[] = [primary];
    const lowEvidence = hasNearbyOnset(candidate.time, bandOnsets.low, toleranceSeconds);
    const midEvidence = hasNearbyOnset(candidate.time, bandOnsets.mid, toleranceSeconds);
    const highEvidence = hasNearbyOnset(candidate.time, bandOnsets.high, toleranceSeconds);
    const upperEnergy = candidate.midHighRatio + candidate.highRatio;

    // Layered kick evidence. A true low-band attack plus meaningful low energy is
    // required; this keeps ordinary snares/toms from gaining phantom kicks.
    if (
      lowEvidence &&
      candidate.lowRatio >= 0.16 &&
      candidate.lowRatio >= upperEnergy * 0.55
    ) addLane(lanes, 0);

    // Layered hat/cymbal evidence. Snares are broadband and often trigger the
    // high-band detector, so the high band must also carry a substantial share
    // of the transient before a second HAT event is emitted.
    if (
      highEvidence &&
      candidate.highRatio >= 0.24 &&
      candidate.rolloffHz >= 5_500 &&
      candidate.zcr >= 0.07
    ) addLane(lanes, 3);

    // Layered snare/clap evidence. Mid-band onset + noisy upper energy separates
    // it from a low kick body or tonal midrange percussion.
    if (
      midEvidence &&
      upperEnergy >= 0.22 &&
      candidate.zcr >= 0.07 &&
      candidate.rolloffHz >= 1_800
    ) addLane(lanes, 1);

    lanes.forEach((lane, laneIndex) => {
      output.push({
        id: `${candidate.id}-layer-${lane}-${laneIndex}`,
        time: candidate.time,
        beat: candidate.beat,
        lane,
        velocity: lane === primary ? candidate.velocity : Math.max(48, Math.round(candidate.velocity * 0.92)),
      });
    });
  });

  return output.sort((a, b) => a.time - b.time || a.lane - b.lane);
}
