import { monoSamples } from "../audio";
import { detectDrumOnsets } from "../analysis/drumOnsets";
import { analyzeRhythm } from "../analysis/rhythm";
import { alignHitsToBeatGrid, beatToStep } from "../analysis/drumGrid";
import { nextDistinctEventTime } from "./drumSlice";
import { selectRepresentativeDrumHit } from "./drumRepresentative";
import { applySafetyFadeOut, findAdaptiveDrumSliceBounds } from "./drumEnvelopeSlice";
import { detectLongSourceSamplerHits, type LightweightSamplerHit } from "./longSourceSampler";

export type AutoKitLane = "KICK" | "SNARE" | "HAT" | "PERC";

export type AutoKitResult = {
  lanes: Partial<Record<AutoKitLane, AudioBuffer>>;
  counts: Record<AutoKitLane, number>;
  totalOnsets: number;
  sourcePattern: Record<AutoKitLane, boolean[]>;
};

const STEPS = 16;
const LONG_SOURCE_SECONDS = 45;
const LANE_BY_ANALYSIS_INDEX: AutoKitLane[] = ["KICK", "SNARE", "PERC", "HAT"];

type BasicHit = {
  id: string;
  time: number;
  beat: number;
  lane: number;
  velocity: number;
};

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

function median(values: number[]) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function selectLongSourceRepresentative<T extends BasicHit>(candidates: T[], allHits: BasicHit[]): T | null {
  if (!candidates.length) return null;
  const indexById = new Map(allHits.map((hit, index) => [hit.id, index]));
  const velocityMedian = median(candidates.map((hit) => hit.velocity));

  return [...candidates]
    .map((hit) => {
      const index = indexById.get(hit.id) ?? -1;
      const previous = index > 0 ? allHits[index - 1] : null;
      const next = index >= 0 && index + 1 < allHits.length ? allHits[index + 1] : null;
      const before = previous ? Math.max(0, hit.time - previous.time) : 0.25;
      const after = next ? Math.max(0, next.time - hit.time) : 0.35;
      const isolation = Math.min(1, Math.min(before / 0.10, after / 0.18));
      const typical = Math.max(0, 1 - Math.abs(hit.velocity - velocityMedian) / 85);
      const strength = Math.max(0, Math.min(1, (hit.velocity - 42) / 85));
      return { hit, score: isolation * 0.58 + typical * 0.27 + strength * 0.15 };
    })
    .sort((a, b) => b.score - a.score || b.hit.velocity - a.hit.velocity)[0].hit;
}

export function extractAutoDrumKit(source: AudioBuffer, bpm = 120): AutoKitResult {
  const samples = monoSamples(source);
  const useLongSourcePath = source.duration > LONG_SOURCE_SECONDS;

  let hits: BasicHit[];
  if (useLongSourcePath) {
    // Full songs are a creative sample-finding problem, not a forensic drum
    // transcription problem. Avoid several full-track Essentia/WASM passes,
    // which can exhaust browser memory on ordinary laptops.
    hits = detectLongSourceSamplerHits(samples, source.sampleRate, bpm);
  } else {
    const detectedHits = detectDrumOnsets(samples, source.sampleRate, bpm);
    try {
      const rhythm = analyzeRhythm(samples, source.sampleRate);
      hits = alignHitsToBeatGrid(detectedHits, rhythm.beats, rhythm.bpm || bpm);
    } catch (error) {
      console.warn("Beat-grid alignment unavailable; using absolute-time fallback", error);
      hits = alignHitsToBeatGrid(detectedHits, [], bpm);
    }
  }

  const grouped = new Map<AutoKitLane, BasicHit[]>();
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

    const selected = useLongSourcePath
      ? selectLongSourceRepresentative(candidates, hits)
      : selectRepresentativeDrumHit(candidates as any, hits as any);
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
