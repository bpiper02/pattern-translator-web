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

function windowRms(samples, startSeconds, endSeconds) {
  const start = Math.max(0, Math.floor(startSeconds * SR));
  const end = Math.min(samples.length, Math.ceil(endSeconds * SR));
  if (end <= start) return 0;
  let sum = 0;
  for (let i = start; i < end; i++) sum += samples[i] * samples[i];
  return Math.sqrt(sum / (end - start));
}

function adaptiveSilenceThreshold(samples) {
  const windowSeconds = 0.02;
  const rms = [];
  for (let t = 0; t < samples.length / SR; t += windowSeconds) {
    rms.push(windowRms(samples, t, Math.min(samples.length / SR, t + windowSeconds)));
  }
  rms.sort((a, b) => a - b);
  const p20 = rms[Math.floor(rms.length * 0.2)] ?? 0;
  const p90 = rms[Math.floor(rms.length * 0.9)] ?? 0;
  return Math.max(0.003, p20 * 2.5, p90 * 0.10);
}

function hasEnergyDip(samples, boundarySeconds, threshold) {
  const radius = 0.055;
  const step = 0.01;
  const width = 0.018;
  let minimum = Infinity;
  for (let t = boundarySeconds - radius; t <= boundarySeconds + radius; t += step) {
    minimum = Math.min(minimum, windowRms(samples, t - width / 2, t + width / 2));
  }
  return minimum <= threshold;
}

function mergePair(a, b) {
  const aEnd = a.startTimeSeconds + a.durationSeconds;
  const bEnd = b.startTimeSeconds + b.durationSeconds;
  const aWeight = Math.max(0.001, a.durationSeconds * (a.amplitude ?? 1));
  const bWeight = Math.max(0.001, b.durationSeconds * (b.amplitude ?? 1));
  return {
    startTimeSeconds: Math.min(a.startTimeSeconds, b.startTimeSeconds),
    durationSeconds: Math.max(aEnd, bEnd) - Math.min(a.startTimeSeconds, b.startTimeSeconds),
    pitchMidi: Math.round((a.pitchMidi * aWeight + b.pitchMidi * bWeight) / (aWeight + bWeight)),
    amplitude: Math.max(a.amplitude ?? 0, b.amplitude ?? 0),
  };
}

function consolidateMonophonic(notes, samples) {
  const ordered = notes
    .filter((note) => Number.isFinite(note.pitchMidi) && note.durationSeconds > 0.035)
    .sort((a, b) => a.startTimeSeconds - b.startTimeSeconds || (b.amplitude ?? 0) - (a.amplitude ?? 0));
  if (ordered.length < 2) return ordered;

  const threshold = adaptiveSilenceThreshold(samples);
  const out = [];
  for (const note of ordered) {
    if (!out.length) {
      out.push({ ...note });
      continue;
    }
    const previous = out[out.length - 1];
    const previousEnd = previous.startTimeSeconds + previous.durationSeconds;
    const noteEnd = note.startTimeSeconds + note.durationSeconds;
    const overlap = Math.min(previousEnd, noteEnd) - Math.max(previous.startTimeSeconds, note.startTimeSeconds);
    const gap = note.startTimeSeconds - previousEnd;
    const pitchDistance = Math.abs(note.pitchMidi - previous.pitchMidi);
    const boundary = Math.max(previous.startTimeSeconds, Math.min(note.startTimeSeconds, previousEnd));
    const articulated = hasEnergyDip(samples, boundary, threshold);

    // Vocal hum/sing is monophonic: overlapping or tiny-gap candidates within one
    // semitone are normally vibrato/decoder fragmentation, unless the waveform
    // actually re-articulates through a low-energy boundary.
    const nearPitch = pitchDistance <= 1;
    const temporallyConnected = overlap >= -0.015 || gap <= 0.085;
    if (nearPitch && temporallyConnected && !articulated) {
      out[out.length - 1] = mergePair(previous, note);
      continue;
    }

    // When Basic Pitch emits simultaneous near-duplicate notes, keep the stronger
    // candidate instead of allowing impossible polyphony in monophonic mode.
    if (overlap > 0.04 && pitchDistance <= 2) {
      const previousStrength = (previous.amplitude ?? 0) * previous.durationSeconds;
      const nextStrength = (note.amplitude ?? 0) * note.durationSeconds;
      if (nextStrength > previousStrength) out[out.length - 1] = { ...note };
      continue;
    }
    out.push({ ...note });
  }
  return out;
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

async function infer(engine, samples) {
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
  return { frames, onsets, contours };
}

function decode(modelOutput, config) {
  const frameNotes = outputToNotesPoly(
    modelOutput.frames.map((row) => [...row]),
    modelOutput.onsets.map((row) => [...row]),
    config.onset,
    config.frame,
    config.minLen,
    config.inferOnsets,
    1000,
    55,
    true,
    config.energyTolerance,
  );
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
  {
    name: "short-notes",
    notes: [60, 64, 67, 64].flatMap((midi) => [{ midi, duration: 0.18, amplitude: 0.72 }, { midi: null, duration: 0.055, amplitude: 0 }]),
    options: {},
  },
  {
    name: "legato-steps",
    notes: [60, 62, 64, 67].map((midi) => ({ midi, duration: 0.38, amplitude: 0.7 })),
    options: {},
  },
  {
    name: "low-voice",
    notes: [45, 48, 52, 55].flatMap((midi) => [{ midi, duration: 0.42, amplitude: 0.72 }, { midi: null, duration: 0.07, amplitude: 0 }]),
    options: { noise: 0.004 },
  },
];

const configs = [
  { name: "spotify-readme", onset: 0.25, frame: 0.25, minLen: 5, inferOnsets: true, energyTolerance: 11 },
  { name: "balanced-035", onset: 0.35, frame: 0.25, minLen: 5, inferOnsets: true, energyTolerance: 11 },
  { name: "legacy-spike", onset: 0.5, frame: 0.3, minLen: 5, inferOnsets: true, energyTolerance: 11 },
  { name: "no-inferred", onset: 0.3, frame: 0.25, minLen: 5, inferOnsets: false, energyTolerance: 11 },
  { name: "longer-min", onset: 0.3, frame: 0.25, minLen: 8, inferOnsets: true, energyTolerance: 11 },
];

(async () => {
  await tf.setBackend("cpu");
  await tf.ready();
  const model = await loadPackagedModel();
  const engine = new BasicPitch(Promise.resolve(model));

  const inferredFixtures = [];
  for (const fixture of fixtures) {
    const samples = synth(fixture.notes, fixture.options);
    const started = Date.now();
    const modelOutput = await infer(engine, samples);
    inferredFixtures.push({ fixture, samples, modelOutput, runtimeMs: Date.now() - started });
  }

  const summaries = [];
  for (const config of configs) {
    const rows = [];
    for (const item of inferredFixtures) {
      const expected = truthEvents(item.fixture.notes);
      const raw = decode(item.modelOutput, config);
      const actual = consolidateMonophonic(raw, item.samples);
      rows.push({
        name: item.fixture.name,
        expected: expected.length,
        raw: raw.length,
        actual: actual.length,
        runtimeMs: item.runtimeMs,
        ...matchNotes(expected, actual),
      });
    }

    const macroF1 = rows.reduce((sum, row) => sum + row.f1, 0) / rows.length;
    const minF1 = Math.min(...rows.map((row) => row.f1));
    const extras = rows.reduce((sum, row) => sum + row.fragmentation, 0);
    summaries.push({ config, rows, macroF1, minF1, extras });

    console.log(`\nCONFIG ${config.name}`);
    console.table(rows.map((row) => ({
      case: row.name,
      expected: row.expected,
      raw: row.raw,
      consolidated: row.actual,
      f1: row.f1.toFixed(3),
      pitch_semitones: Number.isFinite(row.pitchMaeSemitones) ? row.pitchMaeSemitones.toFixed(3) : "inf",
      onset_ms: Number.isFinite(row.onsetMaeMs) ? row.onsetMaeMs.toFixed(1) : "inf",
      duration_ms: Number.isFinite(row.durationMaeMs) ? row.durationMaeMs.toFixed(1) : "inf",
      extra_notes: row.fragmentation,
      inference_ms: row.runtimeMs,
    })));
    console.log(`macro F1=${macroF1.toFixed(3)} min F1=${minF1.toFixed(3)} extras=${extras}`);
  }

  summaries.sort((a, b) => (b.macroF1 - a.macroF1) || (b.minF1 - a.minF1) || (a.extras - b.extras));
  const best = summaries[0];
  console.log(`\nBEST CONFIG: ${best.config.name} macro F1=${best.macroF1.toFixed(3)} min F1=${best.minF1.toFixed(3)} extras=${best.extras}`);

  assert.ok(best.macroF1 >= 0.88, `Basic Pitch best macro F1 ${best.macroF1.toFixed(3)} below bakeoff gate`);
  assert.ok(best.minF1 >= 0.75, `Basic Pitch best fixture F1 ${best.minF1.toFixed(3)} below floor`);
  assert.ok(best.rows.find((row) => row.name === "vibrato").f1 >= 0.8, "Basic Pitch vibrato still fragments badly");
  console.log("BASIC PITCH SPIKE: PASS");
  model.dispose();
  tf.disposeVariables();
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
