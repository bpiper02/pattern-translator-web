import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { classifyDrumTimbres } from "../.qa-timbre-dist/drumTimbreCore.js";

const require = createRequire(import.meta.url);
const { Essentia, EssentiaWASM } = require("essentia.js");
const essentia = new Essentia(EssentiaWASM);
const SR = 44_100;

function prng(seed = 0x1234abcd) {
  let state = seed >>> 0;
  return () => {
    state = (1664525 * state + 1013904223) >>> 0;
    return state / 0x100000000 * 2 - 1;
  };
}

function synthKick(variation = 0) {
  const duration = 0.18;
  const out = new Float32Array(Math.ceil(duration * SR));
  let phase = 0;
  for (let i = 0; i < out.length; i++) {
    const t = i / SR;
    const frequency = (95 + variation * 4) * Math.exp(-t * 10) + 43;
    phase += 2 * Math.PI * frequency / SR;
    const body = Math.sin(phase) * Math.exp(-t * 17);
    const click = i < 100 ? (1 - i / 100) * 0.18 * (i % 2 ? 1 : -1) : 0;
    out[i] = body * 0.88 + click;
  }
  return out;
}

function synthSnare(variation = 0) {
  const duration = 0.16;
  const out = new Float32Array(Math.ceil(duration * SR));
  const random = prng(0x9911 + variation);
  let lowPassed = 0;
  let phase = 0;
  for (let i = 0; i < out.length; i++) {
    const t = i / SR;
    const noise = random();
    lowPassed += 0.28 * (noise - lowPassed);
    phase += 2 * Math.PI * (185 + variation * 7) / SR;
    const tonal = Math.sin(phase) * 0.30;
    const envelope = Math.exp(-t * 22);
    out[i] = (lowPassed * 0.82 + tonal) * envelope;
  }
  return out;
}

function synthHat(variation = 0) {
  const duration = 0.09;
  const out = new Float32Array(Math.ceil(duration * SR));
  const random = prng(0x7711 + variation);
  let previous = 0;
  for (let i = 0; i < out.length; i++) {
    const t = i / SR;
    const noise = random();
    const highPassed = noise - previous * 0.92;
    previous = noise;
    out[i] = highPassed * 0.55 * Math.exp(-t * 42);
  }
  return out;
}

function synthPerc(variation = 0) {
  const duration = 0.14;
  const out = new Float32Array(Math.ceil(duration * SR));
  let phase1 = 0;
  let phase2 = 0;
  for (let i = 0; i < out.length; i++) {
    const t = i / SR;
    phase1 += 2 * Math.PI * (620 + variation * 20) / SR;
    phase2 += 2 * Math.PI * (1320 + variation * 35) / SR;
    out[i] = (Math.sin(phase1) * 0.68 + Math.sin(phase2) * 0.22) * Math.exp(-t * 24);
  }
  return out;
}

function meanVector(vector) {
  if (!vector) return 0;
  const values = Array.from(essentia.vectorToArray(vector));
  if (!values.length) return 0;
  return values.reduce((sum, value) => sum + Number(value), 0) / values.length;
}

function cleanupResult(result) {
  for (const value of Object.values(result ?? {})) value?.delete?.();
}

function extract(id, samples) {
  const signal = essentia.arrayToVector(samples);
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
      lowRatio: low / total,
      midLowRatio: midLow / total,
      midHighRatio: midHigh / total,
      highRatio: high / total,
      flatnessDb: meanVector(result.spectral_flatness_db),
      rolloffHz: meanVector(result.spectral_rolloff),
      zcr: meanVector(result.zerocrossingrate),
    };
  } finally {
    cleanupResult(result);
    signal.delete?.();
  }
}

const fixtures = [
  ...[0, 1, 2].map((variation) => ({ expected: 0, feature: extract(`kick-${variation}`, synthKick(variation)) })),
  ...[0, 1, 2].map((variation) => ({ expected: 1, feature: extract(`snare-${variation}`, synthSnare(variation)) })),
  ...[0, 1, 2].map((variation) => ({ expected: 3, feature: extract(`hat-${variation}`, synthHat(variation)) })),
  ...[0, 1, 2].map((variation) => ({ expected: 2, feature: extract(`perc-${variation}`, synthPerc(variation)) })),
];

const actual = classifyDrumTimbres(fixtures.map((fixture) => fixture.feature));
console.table(fixtures.map((fixture, index) => ({
  id: fixture.feature.id,
  expected: fixture.expected,
  actual: actual[index],
  low: fixture.feature.lowRatio.toFixed(3),
  midLow: fixture.feature.midLowRatio.toFixed(3),
  midHigh: fixture.feature.midHighRatio.toFixed(3),
  high: fixture.feature.highRatio.toFixed(3),
  flatDb: fixture.feature.flatnessDb.toFixed(1),
  rolloff: fixture.feature.rolloffHz.toFixed(0),
  zcr: fixture.feature.zcr.toFixed(3),
})));

const correct = fixtures.filter((fixture, index) => actual[index] === fixture.expected).length;
const accuracy = correct / fixtures.length;
assert.ok(accuracy >= 0.90, `Essentia timbre accuracy ${accuracy.toFixed(3)} below 0.90 gate`);

for (const lane of [0, 1, 2, 3]) {
  const familyIndexes = fixtures.map((fixture, index) => fixture.expected === lane ? index : -1).filter((index) => index >= 0);
  const familyActual = new Set(familyIndexes.map((index) => actual[index]));
  assert.equal(familyActual.size, 1, `lane ${lane} family split across ${[...familyActual].join(",")}`);
}

console.log(`DRUM TIMBRE ESSENTIA: PASS (accuracy=${accuracy.toFixed(3)})`);
