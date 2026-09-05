import Essentia from "essentia.js/dist/essentia.js-core.es.js";
import { EssentiaWASM } from "essentia.js/dist/essentia-wasm.es.js";
import type { DrumHit } from "../audio";

const ANALYSIS_SR = 44100;
const LANES = 4;
let essentiaInstance: any | null = null;

function getEssentia() {
  if (!essentiaInstance) essentiaInstance = new Essentia(EssentiaWASM);
  return essentiaInstance;
}

function resampleLinear(input: Float32Array, sourceRate: number, targetRate: number): Float32Array {
  if (sourceRate === targetRate) return input;
  const ratio = targetRate / sourceRate;
  const output = new Float32Array(Math.max(1, Math.round(input.length * ratio)));
  for (let i = 0; i < output.length; i++) {
    const pos = i / ratio;
    const left = Math.floor(pos);
    const right = Math.min(input.length - 1, left + 1);
    const frac = pos - left;
    output[i] = input[left] + (input[right] - input[left]) * frac;
  }
  return output;
}

function transientFeatures(samples: Float32Array, sr: number, time: number) {
  const center = Math.max(0, Math.min(samples.length - 1, Math.round(time * sr)));
  const preN = Math.max(1, Math.round(sr * 0.012));
  const postN = Math.max(1, Math.round(sr * 0.026));
  let pre = 0;
  let post = 0;
  let peak = 0;
  let zc = 0;
  let prev = samples[center] ?? 0;

  const preStart = Math.max(0, center - preN);
  for (let i = preStart; i < center; i++) pre += samples[i] * samples[i];
  pre = Math.sqrt(pre / Math.max(1, center - preStart));

  const postEnd = Math.min(samples.length, center + postN);
  for (let i = center; i < postEnd; i++) {
    const x = samples[i];
    post += x * x;
    peak = Math.max(peak, Math.abs(x));
    if ((x >= 0) !== (prev >= 0)) zc++;
    prev = x;
  }
  const count = Math.max(1, postEnd - center);
  post = Math.sqrt(post / count);

  return {
    score: Math.max(0, post - pre) + peak * 0.18,
    zcr: zc / count,
    body: post,
    peak,
  };
}

function median(values: number[]) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function vectorLength(vector: any): number {
  if (!vector) return 0;
  if (typeof vector.size === "function") return Number(vector.size());
  if (typeof vector.length === "number") return vector.length;
  return 0;
}

function runSuperFlux(essentia: any, signal: any, ratioThreshold: number, threshold: number): number[] {
  let onsetVector: any | null = null;
  try {
    const result = essentia.SuperFluxExtractor(
      signal,
      35,
      2048,
      256,
      ratioThreshold,
      ANALYSIS_SR,
      threshold,
    );
    onsetVector = result.onsets;
    if (!vectorLength(onsetVector)) return [];
    return Array.from(essentia.vectorToArray(onsetVector) as Float32Array) as number[];
  } finally {
    onsetVector?.delete?.();
  }
}

export function detectDrumOnsets(samples: Float32Array, sampleRate: number, bpm: number): DrumHit[] {
  if (!samples.length || !Number.isFinite(sampleRate) || sampleRate <= 0) return [];

  const essentia = getEssentia();
  const analysis = resampleLinear(samples, sampleRate, ANALYSIS_SR);
  if (!analysis.length) return [];

  const signal = essentia.arrayToVector(analysis);

  try {
    // First pass: near Essentia defaults. If the signal is unusually soft/sparse,
    // retry with a more permissive peak picker instead of crashing on an empty vector.
    let onsetTimes = runSuperFlux(essentia, signal, 16, 0.05);
    if (!onsetTimes.length) onsetTimes = runSuperFlux(essentia, signal, 8, 0.02);
    if (!onsetTimes.length) return [];

    const candidates = onsetTimes
      .filter((time) => Number.isFinite(time) && time >= 0 && time <= samples.length / sampleRate)
      .map((time) => ({ time, ...transientFeatures(samples, sampleRate, time) }));
    if (!candidates.length) return [];

    const scoreMedian = median(candidates.map((x) => x.score));
    const scoreFloor = Math.max(0.0015, scoreMedian * 0.45);
    const gated = candidates.filter((x) => x.score >= scoreFloor && x.peak >= 0.01);

    const deduped: typeof gated = [];
    const minGap = 0.055;
    for (const item of gated) {
      const prev = deduped[deduped.length - 1];
      if (!prev || item.time - prev.time >= minGap) {
        deduped.push(item);
      } else if (item.score > prev.score) {
        deduped[deduped.length - 1] = item;
      }
    }
    if (!deduped.length) return [];

    const brightness = deduped.map((x) => x.zcr * 0.72 + (1 - Math.min(1, x.body * 4)) * 0.18 + x.peak * 0.10);
    const sortedBrightness = [...brightness].sort((a, b) => a - b);
    const laneFor = (value: number) => {
      for (let lane = 0; lane < LANES - 1; lane++) {
        const idx = Math.floor(((lane + 1) / LANES) * (sortedBrightness.length - 1));
        if (value <= sortedBrightness[idx]) return lane;
      }
      return LANES - 1;
    };

    const maxScore = Math.max(...deduped.map((x) => x.score), 1e-6);
    const first = deduped[0].time;

    return deduped.map((item, index) => ({
      id: `sf-${index}-${Math.round(item.time * 1000)}`,
      time: item.time,
      beat: (item.time - first) * bpm / 60,
      lane: laneFor(brightness[index]),
      velocity: Math.max(48, Math.min(127, Math.round(48 + 79 * Math.sqrt(item.score / maxScore)))),
    }));
  } finally {
    signal.delete?.();
  }
}
