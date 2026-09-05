import { monoSamples } from "../audio";
import { detectDrumOnsets } from "../analysis/drumOnsets";

export type AutoKitLane = "KICK" | "SNARE" | "HAT" | "PERC";

export type AutoKitResult = {
  lanes: Partial<Record<AutoKitLane, AudioBuffer>>;
  counts: Record<AutoKitLane, number>;
  totalOnsets: number;
};

const LANE_BY_ANALYSIS_INDEX: AutoKitLane[] = ["KICK", "SNARE", "PERC", "HAT"];

function copySlice(source: AudioBuffer, startSeconds: number, endSeconds: number): AudioBuffer {
  const sampleRate = source.sampleRate;
  const start = Math.max(0, Math.floor(startSeconds * sampleRate));
  const end = Math.min(source.length, Math.max(start + 1, Math.ceil(endSeconds * sampleRate)));
  const length = Math.max(1, end - start);
  const output = new AudioBuffer({
    length,
    numberOfChannels: source.numberOfChannels,
    sampleRate,
  });

  for (let channel = 0; channel < source.numberOfChannels; channel++) {
    output.getChannelData(channel).set(source.getChannelData(channel).subarray(start, end));
  }
  return output;
}

function laneTailSeconds(lane: AutoKitLane) {
  if (lane === "KICK") return 0.42;
  if (lane === "SNARE") return 0.32;
  if (lane === "HAT") return 0.20;
  return 0.28;
}

export function extractAutoDrumKit(source: AudioBuffer, bpm = 120): AutoKitResult {
  const samples = monoSamples(source);
  const hits = detectDrumOnsets(samples, source.sampleRate, bpm);

  const grouped = new Map<AutoKitLane, typeof hits>();
  for (const lane of LANE_BY_ANALYSIS_INDEX) grouped.set(lane, []);

  for (const hit of hits) {
    const lane = LANE_BY_ANALYSIS_INDEX[Math.max(0, Math.min(LANE_BY_ANALYSIS_INDEX.length - 1, hit.lane))];
    grouped.get(lane)!.push(hit);
  }

  const lanes: Partial<Record<AutoKitLane, AudioBuffer>> = {};
  const counts = { KICK: 0, SNARE: 0, HAT: 0, PERC: 0 } as Record<AutoKitLane, number>;

  for (const lane of LANE_BY_ANALYSIS_INDEX) {
    const candidates = grouped.get(lane) ?? [];
    counts[lane] = candidates.length;
    if (!candidates.length) continue;

    // Prefer a strong, isolated transient rather than blindly taking the first hit.
    const ordered = [...candidates].sort((a, b) => b.velocity - a.velocity);
    const selected = ordered[0];
    const chronological = [...hits].sort((a, b) => a.time - b.time);
    const index = chronological.findIndex((hit) => hit.id === selected.id);
    const next = index >= 0 ? chronological[index + 1] : undefined;
    const preRoll = 0.004;
    const maxTail = laneTailSeconds(lane);
    const start = Math.max(0, selected.time - preRoll);
    const nextBoundary = next ? Math.max(start + 0.025, next.time - preRoll) : selected.time + maxTail;
    const end = Math.min(source.duration, selected.time + maxTail, nextBoundary);
    lanes[lane] = copySlice(source, start, end);
  }

  return { lanes, counts, totalOnsets: hits.length };
}
