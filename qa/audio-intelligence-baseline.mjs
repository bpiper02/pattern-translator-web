import assert from 'node:assert/strict';

const SAMPLE_RATE = 48000;

// Exact baseline copy of the current ResampleWorkspace voice onset detector.
function detectVoiceOnsetsCurrent(samples, sampleRate) {
  const frame = Math.max(128, Math.round(sampleRate * 0.012));
  const hop = Math.max(64, Math.round(frame / 2));
  const energies = [];
  for (let start = 0; start + frame < samples.length; start += hop) {
    let sum = 0;
    for (let i = start; i < start + frame; i++) sum += samples[i] * samples[i];
    energies.push(Math.sqrt(sum / frame));
  }
  if (!energies.length) return [];
  const sorted = [...energies].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)] ?? 0;
  const threshold = Math.max(0.015, median * 2.4);
  const minGapFrames = Math.max(1, Math.round(0.09 * sampleRate / hop));
  const onsets = [];
  let last = -minGapFrames;
  for (let i = 1; i < energies.length - 1; i++) {
    const rising = energies[i] > threshold && energies[i] > energies[i - 1] * 1.2;
    const peak = energies[i] >= energies[i + 1];
    if (rising && peak && i - last >= minGapFrames) {
      onsets.push((i * hop) / sampleRate);
      last = i;
    }
  }
  return onsets;
}

function prng(seed = 123456789) {
  let state = seed >>> 0;
  return () => {
    state = (1664525 * state + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function synthPercussion({ times, amplitudes, duration = 2.5, noise = 0, decay = 0.025, seed = 1 }) {
  const length = Math.ceil(duration * SAMPLE_RATE);
  const samples = new Float32Array(length);
  const random = prng(seed);

  if (noise > 0) {
    for (let i = 0; i < length; i++) samples[i] = (random() * 2 - 1) * noise;
  }

  times.forEach((time, index) => {
    const start = Math.round(time * SAMPLE_RATE);
    const amp = amplitudes[index] ?? amplitudes.at(-1) ?? 0.8;
    const tail = Math.round(decay * SAMPLE_RATE);
    for (let j = 0; j < tail && start + j < length; j++) {
      const env = Math.exp(-6 * j / Math.max(1, tail));
      const carrier = Math.sin(2 * Math.PI * 180 * j / SAMPLE_RATE) + 0.55 * Math.sin(2 * Math.PI * 2100 * j / SAMPLE_RATE);
      samples[start + j] += amp * env * carrier * 0.6;
    }
  });
  return samples;
}

function matchEvents(expected, actual, tolerance = 0.05) {
  const used = new Set();
  const errors = [];
  let tp = 0;
  for (const e of expected) {
    let bestIndex = -1;
    let bestError = Infinity;
    for (let i = 0; i < actual.length; i++) {
      if (used.has(i)) continue;
      const error = Math.abs(actual[i] - e);
      if (error <= tolerance && error < bestError) {
        bestError = error;
        bestIndex = i;
      }
    }
    if (bestIndex >= 0) {
      used.add(bestIndex);
      tp++;
      errors.push(bestError);
    }
  }
  const fp = actual.length - tp;
  const fn = expected.length - tp;
  const precision = tp + fp ? tp / (tp + fp) : expected.length ? 0 : 1;
  const recall = tp + fn ? tp / (tp + fn) : 1;
  const f1 = precision + recall ? 2 * precision * recall / (precision + recall) : 0;
  const timingMaeMs = errors.length ? errors.reduce((a, b) => a + b, 0) / errors.length * 1000 : null;
  return { tp, fp, fn, precision, recall, f1, timingMaeMs };
}

function quantizeCurrent(onsetsSeconds, bpm, steps = 16) {
  const stepSeconds = 60 / bpm / 4;
  return [...new Set(onsetsSeconds.map((seconds) => Math.max(0, Math.min(steps - 1, Math.round(seconds / stepSeconds) % steps))))];
}

const cases = [
  {
    name: 'clean-quarter-hits',
    expected: [0.25, 0.75, 1.25, 1.75],
    amplitudes: [0.8, 0.8, 0.8, 0.8],
    noise: 0,
  },
  {
    name: 'dynamic-soft-loud',
    expected: [0.25, 0.75, 1.25, 1.75],
    amplitudes: [0.22, 0.85, 0.16, 0.72],
    noise: 0.002,
  },
  {
    name: 'background-noise',
    expected: [0.25, 0.75, 1.25, 1.75],
    amplitudes: [0.65, 0.65, 0.65, 0.65],
    noise: 0.018,
  },
  {
    name: 'fast-16th-like',
    expected: [0.25, 0.375, 0.5, 0.625, 0.75, 0.875, 1.0, 1.125],
    amplitudes: Array(8).fill(0.7),
    noise: 0.002,
  },
  {
    name: 'ghost-notes',
    expected: [0.25, 0.5, 0.75, 1.0, 1.25],
    amplitudes: [0.8, 0.11, 0.8, 0.10, 0.8],
    noise: 0.003,
  },
];

const report = [];
for (const testCase of cases) {
  const samples = synthPercussion({ ...testCase, times: testCase.expected });
  const actual = detectVoiceOnsetsCurrent(samples, SAMPLE_RATE);
  const metrics = matchEvents(testCase.expected, actual);
  report.push({ name: testCase.name, expected: testCase.expected.length, detected: actual.length, ...metrics });
}

const intendedBpm = 120;
const musicalOnsets = [0, 0.5, 1.0, 1.5];
const recorderLeadIn = 0.18;
const recordedOnsets = musicalOnsets.map((x) => x + recorderLeadIn);
const currentSteps = quantizeCurrent(recordedOnsets, intendedBpm);
const idealSteps = [0, 4, 8, 12];

console.table(report.map((r) => ({
  case: r.name,
  expected: r.expected,
  detected: r.detected,
  precision: r.precision.toFixed(3),
  recall: r.recall.toFixed(3),
  f1: r.f1.toFixed(3),
  timing_ms: r.timingMaeMs == null ? 'n/a' : r.timingMaeMs.toFixed(1),
})));
console.log('\nQuantization logic fixture');
console.log({ recorderLeadIn, idealSteps, currentSteps });

const macroF1 = report.reduce((sum, r) => sum + r.f1, 0) / report.length;
const macroRecall = report.reduce((sum, r) => sum + r.recall, 0) / report.length;
console.log(`\nBASELINE macro F1=${macroF1.toFixed(3)} recall=${macroRecall.toFixed(3)}`);

assert.deepEqual(matchEvents([0.1, 0.2], [0.1, 0.2], 0.001), {
  tp: 2, fp: 0, fn: 0, precision: 1, recall: 1, f1: 1, timingMaeMs: 0,
});
assert.equal(report.length, cases.length);
assert.ok(Number.isFinite(macroF1));
assert.ok(Number.isFinite(macroRecall));

console.log('HARNESS SELF-CHECK: PASS');
