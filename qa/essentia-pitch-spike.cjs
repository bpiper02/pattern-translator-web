const assert = require("node:assert/strict");
const { Essentia, EssentiaWASM } = require("essentia.js");

const SR = 44100;
const FRAME = 2048;
const HOP = 256;
const essentia = new Essentia(EssentiaWASM);

function midiToHz(midi) {
  return 440 * 2 ** ((midi - 69) / 12);
}

function hzToMidi(hz) {
  return hz > 0 ? 69 + 12 * Math.log2(hz / 440) : NaN;
}

function synthMelody(notes, { noise = 0, vibratoCents = 0 } = {}) {
  const total = notes.reduce((sum, note) => sum + note.duration, 0);
  const output = new Float32Array(Math.ceil(total * SR));
  let cursor = 0;
  let seed = 0x12345678;
  const random = () => {
    seed = (1664525 * seed + 1013904223) >>> 0;
    return seed / 0x100000000;
  };

  for (const note of notes) {
    const count = Math.round(note.duration * SR);
    for (let i = 0; i < count && cursor + i < output.length; i++) {
      const t = i / SR;
      if (note.midi == null) {
        output[cursor + i] = noise ? (random() * 2 - 1) * noise : 0;
        continue;
      }
      const attack = Math.min(1, i / Math.max(1, SR * 0.02));
      const release = Math.min(1, (count - i - 1) / Math.max(1, SR * 0.03));
      const envelope = Math.max(0, Math.min(attack, release));
      const cents = vibratoCents ? vibratoCents * Math.sin(2 * Math.PI * 5.3 * t) : 0;
      const frequency = midiToHz(note.midi) * 2 ** (cents / 1200);
      const phase = 2 * Math.PI * frequency * t;
      const voiced = 0.58 * Math.sin(phase) + 0.24 * Math.sin(2 * phase) + 0.1 * Math.sin(3 * phase);
      output[cursor + i] = note.amplitude * envelope * voiced + (random() * 2 - 1) * noise;
    }
    cursor += count;
  }
  return output;
}

function pitchTrack(samples) {
  const signal = essentia.arrayToVector(samples);
  let pitchVector = null;
  let probabilityVector = null;
  try {
    const result = essentia.PitchYinProbabilistic(signal, FRAME, HOP, 0.01, "zero", false, SR);
    pitchVector = result.pitch;
    probabilityVector = result.voicedProbabilities;
    const pitch = Array.from(essentia.vectorToArray(pitchVector));
    const probabilities = Array.from(essentia.vectorToArray(probabilityVector));
    return pitch.map((hz, index) => ({
      time: index * HOP / SR,
      hz,
      midi: hzToMidi(hz),
      probability: probabilities[index] ?? 0,
    }));
  } finally {
    pitchVector?.delete?.();
    probabilityVector?.delete?.();
    signal.delete?.();
  }
}

function scoreFrames(track, truth) {
  const edges = [];
  let cursor = 0;
  for (const note of truth) {
    edges.push({ start: cursor, end: cursor + note.duration, midi: note.midi });
    cursor += note.duration;
  }

  let voicedFrames = 0;
  let correctFrames = 0;
  const centsErrors = [];
  let falseVoiced = 0;
  for (const frame of track) {
    const expected = edges.find((edge) => frame.time >= edge.start && frame.time < edge.end);
    if (!expected) continue;
    const voiced = Number.isFinite(frame.midi) && frame.hz > 0 && frame.probability >= 0.45;
    if (expected.midi == null) {
      if (voiced) falseVoiced++;
      continue;
    }
    voicedFrames++;
    if (!voiced) continue;
    const semitoneError = Math.abs(frame.midi - expected.midi);
    centsErrors.push(semitoneError * 100);
    if (semitoneError <= 0.5) correctFrames++;
  }

  centsErrors.sort((a, b) => a - b);
  const medianCents = centsErrors.length ? centsErrors[Math.floor(centsErrors.length / 2)] : Infinity;
  return {
    voicedAccuracy: voicedFrames ? correctFrames / voicedFrames : 0,
    medianCents,
    falseVoiced,
  };
}

const fixtures = [
  {
    name: "scale-clean",
    notes: [60, 62, 64, 67, 69].flatMap((midi) => [{ midi, duration: 0.42, amplitude: 0.75 }, { midi: null, duration: 0.08, amplitude: 0 }]),
    options: {},
  },
  {
    name: "repeated-note",
    notes: [60, 60, 60, 60].flatMap((midi) => [{ midi, duration: 0.34, amplitude: 0.7 }, { midi: null, duration: 0.06, amplitude: 0 }]),
    options: {},
  },
  {
    name: "vibrato",
    notes: [{ midi: 64, duration: 1.5, amplitude: 0.72 }],
    options: { vibratoCents: 45 },
  },
  {
    name: "quiet-noisy",
    notes: [{ midi: 57, duration: 0.7, amplitude: 0.22 }, { midi: null, duration: 0.1, amplitude: 0 }, { midi: 60, duration: 0.7, amplitude: 0.2 }],
    options: { noise: 0.008 },
  },
  {
    name: "octave-jump",
    notes: [{ midi: 48, duration: 0.65, amplitude: 0.7 }, { midi: null, duration: 0.08, amplitude: 0 }, { midi: 60, duration: 0.65, amplitude: 0.7 }],
    options: {},
  },
];

const rows = fixtures.map((fixture) => {
  const samples = synthMelody(fixture.notes, fixture.options);
  return { name: fixture.name, ...scoreFrames(pitchTrack(samples), fixture.notes) };
});

console.table(rows.map((row) => ({
  case: row.name,
  voiced_accuracy: row.voicedAccuracy.toFixed(3),
  median_cents: Number.isFinite(row.medianCents) ? row.medianCents.toFixed(1) : "inf",
  false_voiced: row.falseVoiced,
})));

for (const row of rows) {
  assert.ok(row.voicedAccuracy >= 0.85, `${row.name}: voiced accuracy ${row.voicedAccuracy.toFixed(3)} below spike gate`);
  assert.ok(row.medianCents <= 25, `${row.name}: median pitch error ${row.medianCents.toFixed(1)} cents above gate`);
}

console.log("ESSENTIA PITCH SPIKE: PASS");
