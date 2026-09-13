import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { recoverLayeredDrumHits } from "../.qa-layer-dist/layeredDrumsCore.js";

const require = createRequire(import.meta.url);
const { Essentia, EssentiaWASM } = require("essentia.js");
const essentia = new Essentia(EssentiaWASM);
const SR = 44_100;
const DURATION = 3.2;

function prng(seed = 0x12345678) {
  let state = seed >>> 0;
  return () => {
    state = (1664525 * state + 1013904223) >>> 0;
    return state / 0x100000000 * 2 - 1;
  };
}

function kick() {
  const out = new Float32Array(Math.round(0.20 * SR));
  let phase = 0;
  for (let i = 0; i < out.length; i++) {
    const t = i / SR;
    const frequency = 105 * Math.exp(-t * 11) + 42;
    phase += 2 * Math.PI * frequency / SR;
    const click = i < 90 ? (1 - i / 90) * 0.08 * (i % 2 ? 1 : -1) : 0;
    out[i] = Math.sin(phase) * Math.exp(-t * 18) * 0.78 + click;
  }
  return out;
}

function snare(seed = 0x4411) {
  const out = new Float32Array(Math.round(0.18 * SR));
  const random = prng(seed);
  let smooth = 0;
  let phase = 0;
  for (let i = 0; i < out.length; i++) {
    const t = i / SR;
    const noise = random();
    smooth += 0.30 * (noise - smooth);
    phase += 2 * Math.PI * 190 / SR;
    out[i] = (smooth * 0.72 + Math.sin(phase) * 0.22) * Math.exp(-t * 21);
  }
  return out;
}

function hat(seed = 0x7722) {
  const out = new Float32Array(Math.round(0.10 * SR));
  const random = prng(seed);
  let previous = 0;
  for (let i = 0; i < out.length; i++) {
    const t = i / SR;
    const noise = random();
    const high = noise - previous * 0.94;
    previous = noise;
    out[i] = high * 0.40 * Math.exp(-t * 43);
  }
  return out;
}

function perc() {
  const out = new Float32Array(Math.round(0.15 * SR));
  let phase1 = 0;
  let phase2 = 0;
  for (let i = 0; i < out.length; i++) {
    const t = i / SR;
    phase1 += 2 * Math.PI * 690 / SR;
    phase2 += 2 * Math.PI * 1410 / SR;
    out[i] = (Math.sin(phase1) * 0.56 + Math.sin(phase2) * 0.18) * Math.exp(-t * 25);
  }
  return out;
}

function addAt(target, source, time, gain = 1) {
  const start = Math.round(time * SR);
  for (let i = 0; i < source.length && start + i < target.length; i++) {
    target[start + i] += source[i] * gain;
  }
}

const expected = [
  { time: 0.35, lanes: [0], sounds: [[kick(), 1]] },
  { time: 0.75, lanes: [1], sounds: [[snare(), 1]] },
  { time: 1.15, lanes: [3], sounds: [[hat(), 1]] },
  { time: 1.55, lanes: [0, 3], sounds: [[kick(), 0.85], [hat(0x7733), 1.15]] },
  { time: 1.95, lanes: [1, 3], sounds: [[snare(0x4422), 0.90], [hat(0x7744), 1.10]] },
  { time: 2.35, lanes: [0, 1], sounds: [[kick(), 0.95], [snare(0x4433), 0.90]] },
  { time: 2.75, lanes: [2], sounds: [[perc(), 1]] },
];

const audio = new Float32Array(Math.ceil(DURATION * SR));
for (const event of expected) {
  for (const [sound, gain] of event.sounds) addAt(audio, sound, event.time, gain);
}

function vectorValues(vector) {
  return vector ? Array.from(essentia.vectorToArray(vector)) : [];
}

function deleteResult(result) {
  for (const value of Object.values(result ?? {})) value?.delete?.();
}

function superFlux(signal) {
  let result;
  try {
    result = essentia.SuperFluxExtractor(signal, 30, 2048, 256, 8, SR, 0.02);
    return vectorValues(result.onsets).filter(Number.isFinite);
  } finally {
    result?.onsets?.delete?.();
  }
}

function filteredOnsets(signal, kind) {
  let first;
  let second;
  try {
    if (kind === "low") {
      first = essentia.LowPass(signal, 190, SR);
      return superFlux(first.signal);
    }
    if (kind === "high") {
      first = essentia.HighPass(signal, 5_000, SR);
      return superFlux(first.signal);
    }
    first = essentia.HighPass(signal, 160, SR);
    second = essentia.LowPass(first.signal, 5_000, SR);
    return superFlux(second.signal);
  } finally {
    second?.signal?.delete?.();
    first?.signal?.delete?.();
  }
}

function meanVector(vector) {
  const values = vectorValues(vector);
  return values.length ? values.reduce((sum, value) => sum + Number(value), 0) / values.length : 0;
}

function extractFeature(id, time) {
  const pre = 0.004;
  const tail = 0.064;
  const start = Math.max(0, Math.floor((time - pre) * SR));
  const end = Math.min(audio.length, Math.ceil((time + tail) * SR));
  const slice = new Float32Array(Math.max(2048, end - start));
  slice.set(audio.subarray(start, end));
  const signal = essentia.arrayToVector(slice);
  let result;
  try {
    result = essentia.LowLevelSpectralExtractor(signal, 2048, 512, SR);
    const low = meanVector(result.spectral_energyband_low);
    const midLow = meanVector(result.spectral_energyband_middle_low);
    const midHigh = meanVector(result.spectral_energyband_middle_high);
    const high = meanVector(result.spectral_energyband_high);
    const total = Math.max(1e-12, low + midLow + midHigh + high);
    return {
      id,
      time,
      beat: time * 2,
      velocity: 110,
      lowRatio: low / total,
      midLowRatio: midLow / total,
      midHighRatio: midHigh / total,
      highRatio: high / total,
      flatnessDb: meanVector(result.spectral_flatness_db),
      rolloffHz: meanVector(result.spectral_rolloff),
      zcr: meanVector(result.zerocrossingrate),
    };
  } finally {
    deleteResult(result);
    signal.delete?.();
  }
}

const fullSignal = essentia.arrayToVector(audio);
let fullOnsets;
let lowOnsets;
let midOnsets;
let highOnsets;
try {
  fullOnsets = superFlux(fullSignal);
  lowOnsets = filteredOnsets(fullSignal, "low");
  midOnsets = filteredOnsets(fullSignal, "mid");
  highOnsets = filteredOnsets(fullSignal, "high");
} finally {
  fullSignal.delete?.();
}

function nearestOnset(time) {
  return fullOnsets.reduce((best, onset) => (
    Math.abs(onset - time) < Math.abs(best - time) ? onset : best
  ), fullOnsets[0] ?? Number.POSITIVE_INFINITY);
}

const candidates = expected.map((event, index) => {
  const detectedTime = nearestOnset(event.time);
  assert.ok(Math.abs(detectedTime - event.time) <= 0.06, `full-band onset missing near ${event.time}s; got ${detectedTime}`);
  return extractFeature(`event-${index}`, detectedTime);
});

const recovered = recoverLayeredDrumHits(candidates, {
  low: lowOnsets,
  mid: midOnsets,
  high: highOnsets,
}, 0.045);

console.log("band onset counts", {
  full: fullOnsets.length,
  low: lowOnsets.length,
  mid: midOnsets.length,
  high: highOnsets.length,
});
console.table(candidates.map((candidate, index) => ({
  time: expected[index].time.toFixed(2),
  expected: expected[index].lanes.join("+"),
  recovered: recovered.filter((hit) => Math.abs(hit.time - candidate.time) < 0.01).map((hit) => hit.lane).sort().join("+"),
  low: candidate.lowRatio.toFixed(3),
  midLow: candidate.midLowRatio.toFixed(3),
  midHigh: candidate.midHighRatio.toFixed(3),
  high: candidate.highRatio.toFixed(3),
  rolloff: candidate.rolloffHz.toFixed(0),
  zcr: candidate.zcr.toFixed(3),
})));

let correctEvents = 0;
for (let index = 0; index < candidates.length; index++) {
  const actualLanes = recovered
    .filter((hit) => Math.abs(hit.time - candidates[index].time) < 0.01)
    .map((hit) => hit.lane)
    .sort((a, b) => a - b);
  const expectedLanes = [...expected[index].lanes].sort((a, b) => a - b);
  if (JSON.stringify(actualLanes) === JSON.stringify(expectedLanes)) correctEvents++;
}

const accuracy = correctEvents / expected.length;
assert.ok(accuracy >= 0.85, `layered event accuracy ${accuracy.toFixed(3)} below 0.85 gate`);
assert.deepEqual(
  recovered.filter((hit) => Math.abs(hit.time - candidates[3].time) < 0.01).map((hit) => hit.lane).sort(),
  [0, 3],
  "kick+hat recovery failed",
);
assert.deepEqual(
  recovered.filter((hit) => Math.abs(hit.time - candidates[4].time) < 0.01).map((hit) => hit.lane).sort(),
  [1, 3],
  "snare+hat recovery failed",
);

console.log(`LAYERED DRUM ESSENTIA: PASS (event accuracy=${accuracy.toFixed(3)})`);
