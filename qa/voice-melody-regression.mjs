import assert from "node:assert/strict";
import { detectVoiceMelody } from "../.qa-dist/voiceMelody.js";

const SAMPLE_RATE = 48_000;
const midiToHz = (midi) => 440 * 2 ** ((midi - 69) / 12);

function prng(seed = 0x12345678) {
  let state = seed >>> 0;
  return () => {
    state = (1664525 * state + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function synth(notes, { noise = 0, vibratoCents = 0 } = {}) {
  const duration = notes.reduce((sum, note) => sum + note.duration, 0);
  const output = new Float32Array(Math.ceil(duration * SAMPLE_RATE));
  const random = prng();
  let cursor = 0;

  for (const note of notes) {
    const count = Math.round(note.duration * SAMPLE_RATE);
    let phase = 0;
    for (let i = 0; i < count && cursor + i < output.length; i++) {
      if (note.midi == null) {
        output[cursor + i] = (random() * 2 - 1) * noise;
        continue;
      }

      const time = i / SAMPLE_RATE;
      const attack = Math.min(1, i / Math.max(1, SAMPLE_RATE * 0.02));
      const release = Math.min(1, (count - i - 1) / Math.max(1, SAMPLE_RATE * 0.03));
      const envelope = Math.max(0, Math.min(attack, release));
      const cents = vibratoCents * Math.sin(2 * Math.PI * 5.3 * time);
      const frequency = midiToHz(note.midi) * 2 ** (cents / 1200);
      const voiced = 0.58 * Math.sin(phase) + 0.24 * Math.sin(2 * phase) + 0.10 * Math.sin(3 * phase);
      output[cursor + i] = note.amplitude * envelope * voiced + (random() * 2 - 1) * noise;
      phase += 2 * Math.PI * frequency / SAMPLE_RATE;
      if (phase > Math.PI * 2) phase %= Math.PI * 2;
    }
    cursor += count;
  }
  return output;
}

function truthEvents(notes) {
  const events = [];
  let cursor = 0;
  for (const note of notes) {
    if (note.midi != null) events.push({ midi: note.midi, start: cursor, duration: note.duration });
    cursor += note.duration;
  }
  return events;
}

function overlapSeconds(a, b) {
  const aEnd = a.start + a.duration;
  const bEnd = b.start + b.duration;
  return Math.max(0, Math.min(aEnd, bEnd) - Math.max(a.start, b.start));
}

function temporalIou(a, b) {
  const overlap = overlapSeconds(a, b);
  if (!overlap) return 0;
  const union = Math.max(a.start + a.duration, b.start + b.duration) - Math.min(a.start, b.start);
  return union > 0 ? overlap / union : 0;
}

function scoreNotes(expected, actual) {
  const used = new Set();
  const onsetErrors = [];
  const ious = [];
  let matched = 0;

  for (const target of expected) {
    let best = -1;
    let bestScore = -Infinity;
    for (let index = 0; index < actual.length; index++) {
      if (used.has(index)) continue;
      const note = actual[index];
      if (note.midi !== target.midi) continue;
      const onsetError = Math.abs(note.start - target.start);
      const overlap = overlapSeconds(target, note);
      const coverage = overlap / Math.max(0.001, target.duration);
      const iou = temporalIou(target, note);
      if (onsetError > 0.18 || coverage < 0.45 || iou < 0.30) continue;
      const candidateScore = iou - onsetError * 0.25;
      if (candidateScore > bestScore) {
        bestScore = candidateScore;
        best = index;
      }
    }

    if (best >= 0) {
      const note = actual[best];
      used.add(best);
      matched++;
      onsetErrors.push(Math.abs(note.start - target.start));
      ious.push(temporalIou(target, note));
    }
  }

  const precision = actual.length ? matched / actual.length : expected.length ? 0 : 1;
  const recall = expected.length ? matched / expected.length : 1;
  const f1 = precision + recall ? 2 * precision * recall / (precision + recall) : 0;
  const mean = (values) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : Infinity;
  return { precision, recall, f1, onsetMaeMs: mean(onsetErrors) * 1000, meanIou: mean(ious) };
}

const fixtures = [
  { name: "scale-clean", notes: [60, 62, 64, 67, 69].flatMap((midi) => [{ midi, duration: 0.42, amplitude: 0.75 }, { midi: null, duration: 0.08, amplitude: 0 }]), options: {} },
  { name: "repeated-note", notes: [60, 60, 60, 60].flatMap((midi) => [{ midi, duration: 0.34, amplitude: 0.70 }, { midi: null, duration: 0.06, amplitude: 0 }]), options: {} },
  { name: "vibrato", notes: [{ midi: 64, duration: 1.50, amplitude: 0.72 }], options: { vibratoCents: 45 } },
  { name: "quiet-noisy", notes: [{ midi: 57, duration: 0.70, amplitude: 0.22 }, { midi: null, duration: 0.10, amplitude: 0 }, { midi: 60, duration: 0.70, amplitude: 0.20 }], options: { noise: 0.008 } },
  { name: "octave-jump", notes: [{ midi: 48, duration: 0.65, amplitude: 0.70 }, { midi: null, duration: 0.08, amplitude: 0 }, { midi: 60, duration: 0.65, amplitude: 0.70 }], options: {} },
  { name: "short-notes", notes: [60, 64, 67, 64].flatMap((midi) => [{ midi, duration: 0.18, amplitude: 0.72 }, { midi: null, duration: 0.055, amplitude: 0 }]), options: {} },
  { name: "legato-steps", notes: [60, 62, 64, 67].map((midi) => ({ midi, duration: 0.38, amplitude: 0.70 })), options: {} },
  { name: "low-voice", notes: [45, 48, 52, 55].flatMap((midi) => [{ midi, duration: 0.42, amplitude: 0.72 }, { midi: null, duration: 0.07, amplitude: 0 }]), options: { noise: 0.004 } },
];

const results = fixtures.map((fixture) => {
  const expected = truthEvents(fixture.notes);
  const actual = detectVoiceMelody(synth(fixture.notes, fixture.options), SAMPLE_RATE, { bpm: 120 });
  return { name: fixture.name, expected, actual, ...scoreNotes(expected, actual) };
});

console.table(results.map((result) => ({
  case: result.name,
  expected: result.expected.length,
  actual: result.actual.length,
  precision: result.precision.toFixed(3),
  recall: result.recall.toFixed(3),
  f1: result.f1.toFixed(3),
  onset_ms: Number.isFinite(result.onsetMaeMs) ? result.onsetMaeMs.toFixed(1) : "inf",
  iou: Number.isFinite(result.meanIou) ? result.meanIou.toFixed(3) : "inf",
})));

const macroF1 = results.reduce((sum, result) => sum + result.f1, 0) / results.length;
const minimumF1 = Math.min(...results.map((result) => result.f1));
const vibratoF1 = results.find((result) => result.name === "vibrato")?.f1 ?? 0;

assert.ok(macroF1 >= 0.85, `macro F1 ${macroF1.toFixed(3)} below gate`);
assert.ok(minimumF1 >= 0.70, `minimum fixture F1 ${minimumF1.toFixed(3)} below gate`);
assert.ok(vibratoF1 >= 0.80, `vibrato F1 ${vibratoF1.toFixed(3)} below gate`);
assert.deepEqual(detectVoiceMelody(new Float32Array(), SAMPLE_RATE), []);
assert.deepEqual(detectVoiceMelody(new Float32Array(4096), SAMPLE_RATE), []);

console.log(`VOICE MELODY REGRESSION: PASS (macro F1=${macroF1.toFixed(3)}, min F1=${minimumF1.toFixed(3)})`);
