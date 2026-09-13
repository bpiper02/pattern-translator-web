import { monoSamples } from "../audio";
import { detectDrumOnsets } from "../analysis/drumOnsets";
import { analyzeRhythm } from "../analysis/rhythm";
import { alignHitsToBeatGrid, beatToStep } from "../analysis/drumGrid";
import { nextDistinctEventTime } from "./drumSlice";
import { selectRepresentativeDrumHit } from "./drumRepresentative";
import { applySafetyFadeOut, findAdaptiveDrumSliceBounds } from "./drumEnvelopeSlice";

export type AutoKitLane = "KICK" | "SNARE" | "HAT" | "PERC";

export type AutoKitResult = {
  lanes: Partial<Record<AutoKitLane, AudioBuffer>>;
  counts: Record<AutoKitLane, number>;
  totalOnsets: number;
  sourcePattern: Record<AutoKitLane, boolean[]>;
};

const STEPS = 16;
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
    const channelData = output.getChannelData(channel);
    channelData.set(source.getChannelData(channel).subarray(start, end));
    applySafetyFadeOut(channelData, sampleRate);
  }
  return output;
}

export function extractAutoDrumKit(source: AudioBuffer, bpm = 120): AutoKitResult {
  const samples = monoSamples(source);
  const detectedHits = detectDrumOnsets(samples, source.sampleRate, bpm);

  let hits = detectedHits;
  try {
    const rhythm = analyzeRhythm(samples, source.sampleRate);
    hits = alignHitsToBeatGrid(detectedHits, rhythm.beats, rhythm.bpm || bpm);
  } catch (error) {
    console.warn("Beat-grid alignment unavailable; using absolute-time fallback", error);
    hits = alignHitsToBeatGrid(detectedHits, [], bpm);
  }

  const grouped = new Map<AutoKitLane, typeof hits>();
  for (const lane of LANE_BY_ANALYSIS_INDEX) grouped.set(lane, []);

  const sourcePattern = {
    KICK: Array(STEPS).fill(false),
    SNARE: Array(STEPS).fill(false),
    HAT: Array(STEPS).fill(false),
    PERC: Array(STEPS).fill(false),
  } as Record<AutoKitLane, boolean[]>;

  for (const hit of hits) {
    const lane = LANE_BY_ANALYSIS_INDEX[Math.max(0, Math.min(LANE_BY_ANALYSIS_INDEX.length - 1, hit.lane))];
    grouped.get(lane)!.push(hit);

    const step = beatToStep(hit.beat);
    if (step >= 0 && step < STEPS) sourcePattern[lane][step] = true;
  }

  const lanes: Partial<Record<AutoKitLane, AudioBuffer>> = {};
  const counts = { KICK: 0, SNARE: 0, HAT: 0, PERC: 0 } as Record<AutoKitLane, number>;

  for (const lane of LANE_BY_ANALYSIS_INDEX) {
    const candidates = grouped.get(lane) ?? [];
    counts[lane] = candidates.length;
    if (!candidates.length) continue;

    const selected = selectRepresentativeDrumHit(candidates, hits);
    if (!selected) continue;

    const nextTime = nextDistinctEventTime(hits, selected.time);
    const bounds = findAdaptiveDrumSliceBounds(
      samples,
      source.sampleRate,
      selected.time,
      nextTime,
      {
        // A generous safety ceiling replaces the old lane-specific fixed tails.
        // Actual end time is determined from the source decay/noise envelope.
        maxTailSeconds: 1.8,
      },
    );

    if (bounds.endSeconds <= bounds.startSeconds) continue;
    lanes[lane] = copySlice(source, bounds.startSeconds, bounds.endSeconds);
  }

  return { lanes, counts, totalOnsets: hits.length, sourcePattern };
}
