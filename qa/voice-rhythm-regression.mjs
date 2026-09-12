import assert from "node:assert/strict";
import { detectVoiceRhythmOnsets } from "../.qa-dist/voiceRhythm.js";

const SAMPLE_RATE = 48_000;

function prng(seed = 123456789) {
  let state = seed >>> 0;
  return () => {
    state = (1664525 * state + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function synth({ times, amplitudes, noise = 0, decay = 0.025, duration = 2.5 }) {
  const samples = new Float32Array(Math.ceil(duration * SAMPLE_RATE));
  const random = prng(7);
  if (noise) {
    for (let i = 0; i < samples.length; i++) samples[i] = (random() * 2 - 1) * noise;
  }
  times.forEach((time, index) => {
    const start = Math.round(time * SAMPLE_RATE);
    const tail = Math.round(decay * SAMPLE_RATE);
    const amplitude = amplitudes[index] ?? amplitudes.at(-1) ?? 0.8;
    for (let j = 0; j < tail && start + j < samples.length; j++) {
      const envelope = Math.exp(-6 * j / Math.max(1, tail));
      const carrier = Math.sin(2 * Math.PI * 180 * j / SAMPLE_RATE)
        + 0.55 * Math.sin(2 * Math.PI * 2100 * j / SAMPLE_RATE);
      samples[start + j] += amplitude * envelope * carrier * 0.6;
    }
  });
  return samples;
}

function score(expected, actual, tolerance = 0.035) {
  const used = new Set();
  let truePositives = 0;
  const errors = [];
  for (const expectedTime of expected) {
    let bestIndex = -1;
    let bestError = Infinity;
    actual.forEach((actualTime, index) => {
      if (used.has(index)) return;
      const error = Math.abs(actualTime - expectedTime);
      if (error <= tolerance && error < bestError) {
        bestError = error;
        bestIndex = index;
      }
    });
    if (bestIndex >= 0) {
      used.add(bestIndex);
      truePositives++;
      errors.push(bestError);
    }
  }
  const falsePositives = actual.length - truePositives;
  const falseNegatives = expected.length - truePositives;
  const precision = truePositives + falsePositives
    ? truePositives / (truePositives + falsePositives)
    : expected.length ? 0 : 1;
  const recall = truePositives + falseNegatives
    ? truePositives / (truePositives + falseNegatives)
    : 1;
  const f1 = precision + recall ? 2 * precision * recall / (precision + recall) : 0;
  const maeMs = errors.length
    ? errors.reduce((sum, value) => sum + value, 0) / errors.length * 1000
    : 0;
  return { precision, recall, f1, maeMs };
}

const fixtures = [
  { name: "clean-quarter", times: [0.25, 0.75, 1.25, 1.75], amplitudes: [0.8, 0.8, 0.8, 0.8] },
  { name: "dynamic", times: [0.25, 0.75, 1.25, 1.75], amplitudes: [0.22, 0.85, 0.16, 0.72], noise: 0.002 },
  { name: "heavy-noise", times: [0.25, 0.75, 1.25, 1.75], amplitudes: [0.65, 0.65, 0.65, 0.65], noise: 0.018 },
  { name: "16ths", times: [0.25, 0.375, 0.5, 0.625, 0.75, 0.875, 1, 1.125], amplitudes: Array(8).fill(0.7), noise: 0.002 },
  { name: "ghosts", times: [0.25, 0.5, 0.75, 1, 1.25], amplitudes: [0.8, 0.11, 0.8, 0.10, 0.8], noise: 0.003 },
  { name: "rapid-80ms", times: [0.3, 0.38, 0.46, 0.54, 0.62, 0.70], amplitudes: Array(6).fill(0.75), noise: 0.001, decay: 0.018 },
];

const results = fixtures.map((fixture) => {
  const actual = detectVoiceRhythmOnsets(synth(fixture), SAMPLE_RATE);
  return { name: fixture.name, actual, ...score(fixture.times, actual) };
});

console.table(results.map((result) => ({
  case: result.name,
  detected: result.actual.length,
  precision: result.precision.toFixed(3),
  recall: result.recall.toFixed(3),
  f1: result.f1.toFixed(3),
  timing_ms: result.maeMs.toFixed(1),
})));

const macroF1 = results.reduce((sum, result) => sum + result.f1, 0) / results.length;
assert.ok(macroF1 >= 0.95, `macro F1 ${macroF1.toFixed(3)} below gate`);
for (const result of results) {
  assert.ok(result.f1 >= 0.9, `${result.name} F1 ${result.f1.toFixed(3)} below gate`);
}

const noiseOnly = detectVoiceRhythmOnsets(
  synth({ name: "noise-only", times: [], amplitudes: [], noise: 0.02, duration: 2 }),
  SAMPLE_RATE,
);
assert.equal(noiseOnly.length, 0, "noise-only fixture produced false hits");
assert.deepEqual(detectVoiceRhythmOnsets(new Float32Array(), SAMPLE_RATE), []);
assert.deepEqual(detectVoiceRhythmOnsets(new Float32Array(100), 0), []);

console.log(`VOICE RHYTHM REGRESSION: PASS (macro F1=${macroF1.toFixed(3)})`);
