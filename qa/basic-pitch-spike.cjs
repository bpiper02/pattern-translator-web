const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const tf = require("@tensorflow/tfjs");
const { BasicPitch, outputToNotesPoly, noteFramesToTime } = require("@spotify/basic-pitch");

const SR = 22050;
const midiToHz = (midi) => 440 * 2 ** ((midi - 69) / 12);

function synth(notes, { noise = 0, vibratoCents = 0 } = {}) {
  const duration = notes.reduce((sum, note) => sum + note.duration, 0);
  const output = new Float32Array(Math.ceil(duration * SR));
  let cursor = 0;
  let seed = 0x12345678;
  const random = () => ((seed = (1664525 * seed + 1013904223) >>> 0) / 0x100000000);

  for (const note of notes) {
    const count = Math.round(note.duration * SR);
    for (let i = 0; i < count && cursor + i < output.length; i++) {
      if (note.midi == null) {
        output[cursor + i] = (random() * 2 - 1) * noise;
        continue;
      }
      const time = i / SR;
      const attack = Math.min(1, i / Math.max(1, SR * 0.02));
      const release = Math.min(1, (count - i - 1) / Math.max(1, SR * 0.03));
      const envelope = Math.max(0, Math.min(attack, release));
      const cents = vibratoCents * Math.sin(2 * Math.PI * 5.3 * time);
      const frequency = midiToHz(note.midi) * 2 ** (cents / 1200);
      const phase = 2 * Math.PI * frequency * time;
      const voiced = 0.58 * Math.sin(phase) + 0.24 * Math.sin(2 * phase) + 0.1 * Math.sin(3 * phase);
      output[cursor + i] = note.amplitude * envelope * voiced + (random() * 2 - 1) * noise;
    }
    cursor += count;
  }
  return output;
}

function truthEvents(notes) {
  const events = [];
  let cursor = 0;
  for (const note of notes) {
    if (note.midi != null) events.push({ pitchMidi: note.midi, startTimeSeconds: cursor, durationSeconds: note.duration });
    cursor += note.duration;
  }
  return events;
}

function matchNotes(expected, actual) {
  const used = new Set();
  const pitchErrors = [];
  const onsetErrors = [];
  const durationErrors = [];
  let matched = 0;

  for (const target of expected) {
    let best = -1;
    let bestCost = Infinity;
    for (let i = 0; i < actual.length; i++) {
      if (used.has(i)) continue;
      const note = actual[i];
      const pitchError = Math.abs(note.pitchMidi - target.pitchMidi);
      const onsetError = Math.abs(note.startTimeSeconds - target.startTimeSeconds);
      if (pitchError > 1 || onsetError > 0.14) continue;
      const cost = pitchError * 0.5 + onsetError;
      if (cost < bestCost) {
        bestCost = cost;
        best = i;
      }
    }
    if (best >= 0) {
      const note = actual[best];
      used.add(best);
      matched++;
      pitchErrors.push(Math.abs(note.pitchMidi - target.pitchMidi));
      onsetErrors.push(Math.abs(note.startTimeSeconds - target.startTimeSeconds));
      durationErrors.push(Math.abs(note.durationSeconds - target.durationSeconds));
    }
  }

  const precision = actual.length ? matched / actual.length : expected.length ? 0 : 1;
  const recall = expected.length ? matched / expected.length : 1;
  const f1 = precision + recall ? 2 * precision * recall / (precision + recall) : 0;
  const mean = (values) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : Infinity;
  return {
    matched,
    precision,
    recall,
    f1,
    pitchMaeSemitones: mean(pitchErrors),
    onsetMaeMs: mean(onsetErrors) * 1000,
    durationMaeMs: mean(durationErrors) * 1000,
    fragmentation: Math.max(0, actual.length - expected.length),
  };
}

async function loadPackagedModel() {
  const packageDir = path.dirname(require.resolve("@spotify/basic-pitch/package.json"));
  const modelPath = path.join(packageDir, "model", "model.json");
  const modelJson = JSON.parse(fs.readFileSync(modelPath, "utf8"));
  const weightSpecs = [];
  const buffers = [];
  for (const group of modelJson.weightsManifest ?? []) {
    weightSpecs.push(...group.weights);
    for (const shard of group.paths) buffers.push(fs.readFileSync(path.join(path.dirname(modelPath), shard)));
  }
  const combined = Buffer.concat(buffers);
  const weightData = combined.buffer.slice(combined.byteOffset, combined.byteOffset + combined.byteLength);
  const handler = tf.io.fromMemory({
    modelTopology: modelJson.modelTopology,
    format: modelJson.format,
    generatedBy: modelJson.generatedBy,
    convertedBy: modelJson.convertedBy,
    weightSpecs,
    weightData,
  });
  return tf.loadGraphModel(handler);
}

async function transcribe(engine, samples) {
  const frames = [];
  const onsets = [];
  const contours = [];
  await engine.evaluateModel(
    samples,
    (nextFrames, nextOnsets, nextContours) => {
      frames.push(...nextFrames);
      onsets.push(...nextOnsets);
      contours.push(...nextContours);
    },
    () => {},
  );
  const frameNotes = outputToNotesPoly(frames, onsets, 0.5, 0.3, 5, true, 1000, 55, true, 11);
  return noteFramesToTime(frameNotes);
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

(async () => {
  await tf.setBackend("cpu");
  await tf.ready();
  const model = await loadPackagedModel();
  const engine = new BasicPitch(Promise.resolve(model));
  const rows = [];

  for (const fixture of fixtures) {
    const expected = truthEvents(fixture.notes);
    const started = Date.now();
    const actual = await transcribe(engine, synth(fixture.notes, fixture.options));
    const runtimeMs = Date.now() - started;
    rows.push({ name: fixture.name, expected: expected.length, actual: actual.length, runtimeMs, ...matchNotes(expected, actual) });
  }

  console.table(rows.map((row) => ({
    case: row.name,
    expected: row.expected,
    actual: row.actual,
    f1: row.f1.toFixed(3),
    pitch_semitones: Number.isFinite(row.pitchMaeSemitones) ? row.pitchMaeSemitones.toFixed(3) : "inf",
    onset_ms: Number.isFinite(row.onsetMaeMs) ? row.onsetMaeMs.toFixed(1) : "inf",
    duration_ms: Number.isFinite(row.durationMaeMs) ? row.durationMaeMs.toFixed(1) : "inf",
    extra_notes: row.fragmentation,
    runtime_ms: row.runtimeMs,
  })));

  const macroF1 = rows.reduce((sum, row) => sum + row.f1, 0) / rows.length;
  assert.ok(macroF1 >= 0.85, `Basic Pitch macro F1 ${macroF1.toFixed(3)} below bakeoff gate`);
  for (const row of rows) assert.ok(row.f1 >= 0.75, `${row.name}: F1 ${row.f1.toFixed(3)} below floor`);
  console.log(`BASIC PITCH SPIKE: PASS (macro F1=${macroF1.toFixed(3)})`);
  model.dispose();
  tf.disposeVariables();
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
