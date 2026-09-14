export type LightweightSamplerHit = {
  id: string;
  time: number;
  beat: number;
  lane: number;
  velocity: number;
};

type RawHit = { sample: number; strength: number };
type Feature = { rms: number; zcr: number; peak: number };

const MAX_HITS = 2048;

function finiteBpm(value: number) {
  return Number.isFinite(value) && value > 0 ? value : 120;
}

function localFeatures(samples: Float32Array, sr: number, center: number): Feature {
  const start = Math.max(0, center);
  const end = Math.min(samples.length, start + Math.floor(sr * 0.10));
  let sumSquares = 0;
  let zeroCrossings = 0;
  let peak = 0;
  let previous = samples[start] || 0;

  for (let i = start; i < end; i++) {
    const value = samples[i];
    sumSquares += value * value;
    peak = Math.max(peak, Math.abs(value));
    if ((value >= 0) !== (previous >= 0)) zeroCrossings += 1;
    previous = value;
  }

  const count = Math.max(1, end - start);
  return {
    rms: Math.sqrt(sumSquares / count),
    zcr: zeroCrossings / count,
    peak,
  };
}

function range(values: number[]) {
  if (!values.length) return { min: 0, max: 0 };
  let min = values[0];
  let max = values[0];
  for (let i = 1; i < values.length; i++) {
    if (values[i] < min) min = values[i];
    if (values[i] > max) max = values[i];
  }
  return { min, max };
}

function normalize(value: number, bounds: { min: number; max: number }) {
  return bounds.max === bounds.min ? 0.5 : (value - bounds.min) / (bounds.max - bounds.min);
}

/**
 * Full songs need a very different performance profile from short drum stems.
 * This detector stays in plain JS, keeps memory bounded, and intentionally
 * favors interesting transients over forensic drum classification. It is used
 * only for long sources so the high-fidelity Essentia path remains untouched
 * for short stems.
 */
export function detectLongSourceSamplerHits(
  samples: Float32Array,
  sampleRate: number,
  bpm: number,
): LightweightSamplerHit[] {
  if (!samples.length || !Number.isFinite(sampleRate) || sampleRate <= 0) return [];

  const frame = Math.max(256, Math.floor(sampleRate * 0.012));
  const hop = Math.max(128, Math.floor(frame / 2));
  const frameCount = Math.max(0, Math.floor((samples.length - frame) / hop));
  if (!frameCount) return [];

  const energy = new Float32Array(frameCount);
  let energySum = 0;
  for (let frameIndex = 0; frameIndex < frameCount; frameIndex++) {
    const start = frameIndex * hop;
    let total = 0;
    for (let i = 0; i < frame; i++) total += Math.abs(samples[start + i]);
    const value = total / frame;
    energy[frameIndex] = value;
    energySum += value;
  }

  const mean = energySum / frameCount;
  let varianceSum = 0;
  for (let i = 0; i < energy.length; i++) {
    const delta = energy[i] - mean;
    varianceSum += delta * delta;
  }
  const sd = Math.sqrt(varianceSum / frameCount);
  const threshold = mean + sd * 0.55;
  const minGapFrames = Math.max(1, Math.round((sampleRate * 0.055) / hop));

  const raw: RawHit[] = [];
  for (let i = 1; i < energy.length - 1; i++) {
    const value = energy[i];
    if (value <= threshold || value < energy[i - 1] || value <= energy[i + 1]) continue;
    const previous = raw[raw.length - 1];
    if (!previous || i - previous.sample / hop >= minGapFrames) {
      raw.push({ sample: i * hop, strength: value });
    } else if (value > previous.strength) {
      raw[raw.length - 1] = { sample: i * hop, strength: value };
    }
  }
  if (!raw.length) return [];

  // Dense mastered tracks can contain thousands of candidate peaks. Keep the
  // strongest bounded set, then restore chronological order for gap/slicing
  // logic. This prevents a pathological song from turning analysis quadratic.
  const bounded = raw.length > MAX_HITS
    ? [...raw].sort((a, b) => b.strength - a.strength).slice(0, MAX_HITS).sort((a, b) => a.sample - b.sample)
    : raw;

  const features = bounded.map((hit) => localFeatures(samples, sampleRate, hit.sample));
  const rmsBounds = range(features.map((feature) => feature.rms));
  const zcrBounds = range(features.map((feature) => feature.zcr));
  const peakBounds = range(features.map((feature) => feature.peak));

  const scores = features.map((feature) =>
    0.62 * normalize(feature.zcr, zcrBounds)
      + 0.23 * (1 - normalize(feature.rms, rmsBounds))
      + 0.15 * normalize(feature.peak, peakBounds),
  );
  const sortedScores = [...scores].sort((a, b) => a - b);
  const quartiles = [0.25, 0.5, 0.75].map((fraction) =>
    sortedScores[Math.min(sortedScores.length - 1, Math.floor(fraction * (sortedScores.length - 1)))],
  );

  const maxStrength = bounded.reduce((max, hit) => Math.max(max, hit.strength), 1e-6);
  const safeBpm = finiteBpm(bpm);

  return bounded.map((hit, index) => {
    const score = scores[index];
    const lane = score <= quartiles[0] ? 0 : score <= quartiles[1] ? 1 : score <= quartiles[2] ? 2 : 3;
    const time = hit.sample / sampleRate;
    return {
      id: `long-${index}-${hit.sample}`,
      time,
      beat: time * safeBpm / 60,
      lane,
      velocity: Math.max(42, Math.min(127, Math.round(42 + 85 * Math.sqrt(hit.strength / maxStrength)))),
    };
  });
}
