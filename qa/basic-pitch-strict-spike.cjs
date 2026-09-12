const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const tf = require("@tensorflow/tfjs");
const { BasicPitch, outputToNotesPoly, noteFramesToTime } = require("@spotify/basic-pitch");

const SR = 22050;
const CONFIG = {
  onset: 0.30,
  frame: 0.25,
  minLen: 8,
  inferOnsets: true,
  energyTolerance: 11,
};

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
      const voiced = 0.58 * Math.sin(phase) + 0.24 * Math.sin(2 * phase) + 0.10 * Math.sin(3 * phase);
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
    if (note.midi != null) {
      events.push({
        pitchMidi: note.midi,
        startTimeSeconds: cursor,
        durationSeconds: note.duration,
      });
    }
    cursor += note.duration;
  }
  return events;
}

function overlapSeconds(a, b) {
  const aEnd = a.startTimeSeconds + a.durationSeconds;
  const bEnd = b.startTimeSeconds + b.durationSeconds;
  return Math.max(0, Math.min(aEnd, bEnd) - Math.max(a.startTimeSeconds, b.startTimeSeconds));
}

function temporalIou(a, b) {
  const overlap = overlapSeconds(a, b);
  if (!overlap) return 0;
  const aEnd = a.startTimeSeconds + a.durationSeconds;
  const bEnd = b.startTimeSeconds + b.durationSeconds;
  const union = Math.max(aEnd, bEnd) - Math.min(a.startTimeSeconds, b.startTimeSeconds);
  return union > 0 ? overlap / union : 0;
}

function strictMatchNotes(expected, actual) {
  const used = new Set();
  const onsetErrors = [];
  const durationErrors = [];
  const ious = [];
  let matched = 0;

  for (const target of expected) {
    let best = -1;
    let bestScore = -Infinity;
    for (let i = 0; i < actual.length; i++) {
      if (used.has(i)) continue;
      const note = actual[i];
      if (note.pitchMidi !== target.pitchMidi) continue;

      const onsetError = Math.abs(note.startTimeSeconds - target.startTimeSeconds);
      const overlap = overlapSeconds(target, note);
      const targetCoverage = overlap / Math.max(0.001, target.durationSeconds);
      const iou = temporalIou(target, note);

      // Exact MIDI plus substantial temporal agreement. A tiny fragment at the
      // correct onset is not a successful transcription of a sustained note.
      if (onsetError > 0.16 || targetCoverage < 0.50 || iou < 0.30) continue;
      const score = iou - onsetError * 0.35;
      if (score > bestScore) {
        bestScore = score;
        best = i;
      }
    }

    if (best >= 0) {
      const note = actual[best];
      used.add(best);
      matched++;
      onsetErrors.push(Math.abs(note.startTimeSeconds - target.startTimeSeconds));
      durationErrors.push(Math.abs(note.durationSeconds - target.durationSeconds));
      ious.push(temporalIou(target, note));
    }
  }

  const precision = actual.length ? matched / actual.length : expected.length ? 0 : 1;
  const recall = expected.length ? matched / expected.length : 1;
  const f1 = precision + recall ? (2 * precision * recall) / (precision + recall) : 0;
  const mean = (values) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : Infinity;
  return {
    matched,
    precision,
    recall,
    f1,
    onsetMaeMs: mean(onsetErrors) * 1000,
    durationMaeMs: mean(durationErrors) * 1000,
    meanTemporalIou: mean(ious),
    unmatchedActual: actual.filter((_, index) => !used.has(index)),
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
  const values = [];
  for (let t = 0; t < samples.length / SR; t += 0.02) {
    values.push(windowRms(samples, t, Math.min(samples.length / SR, t + 0.02)));
  }
  values.sort((a, b) => a - b);
  const p20 = values[Math.floor(values.length * 0.20)] ?? 0;
  const p90 = values[Math.floor(values.length * 0.90)] ?? 0;
  return Math.max(0.003, p20 * 2.5, p90 * 0.10);
}

function hasEnergyDip(samples, boundarySeconds, threshold) {
  let minimum = Infinity;
  for (let t = boundarySeconds - 0.055; t <= boundarySeconds + 0.055; t += 0.01) {
    minimum = Math.min(minimum, windowRms(samples, t - 0.009, t + 0.009));
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

    if (pitchDistance <= 1 && (overlap >= -0.015 || gap <= 0.085) && !articulated) {
      out[out.length - 1] = mergePair(previous, note);
      continue;
    }

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
  return tf.loadGraphModel(tf.io.fromMemory({
    modelTopology: modelJson.modelTopology,
    format: modelJson.format,
    generatedBy: modelJson.generatedBy,
    convertedBy: modelJson.convertedBy,
    weightSpecs,
    weightData,
  }));
}

async function infer(engine, samples) {
  const frames = [];
  const onsets = [];
  const contours = [];
  await engine.evaluateModel(samples, (f, o, c) => {
    frames.push(...f);
    onsets.push(...o);
    contours.push(...c);
  }, () => {});
  return { frames, onsets, contours };
}

function decode(modelOutput) {
  const frameNotes = outputToNotesPoly(
    modelOutput.frames.map((row) => [...row]),
    modelOutput.onsets.map((row) => [...row]),
    CONFIG.onset,
    CONFIG.frame,
    CONFIG.minLen,
    CONFIG.inferOnsets,
    1000,
    55,
    true,
    CONFIG.energyTolerance,
  );
  return noteFramesToTime(frameNotes);
}

function compactNotes(notes) {
  return notes.map((note) => ({
    midi: note.pitchMidi,
    start_ms: Math.round(note.startTimeSeconds * 1000),
    duration_ms: Math.round(note.durationSeconds * 1000),
    amp: Number((note.amplitude ?? 0).toFixed(3)),
  }));
}

const fixtures = [
  { name: "scale-clean", notes: [60, 62, 64, 67, 69].flatMap((midi) => [{ midi, duration: 0.42, amplitude: 0.75 }, { midi: null, duration: 0.08, amplitude: 0 }]), options: {} },
  { name: "repeated-note", notes: [60, 60, 60, 60].flatMap((midi) => [{ midi, duration: 0.34, amplitude: 0.7 }, { midi: null, duration: 0.06, amplitude: 0 }]), options: {} },
  { name: "vibrato", notes: [{ midi: 64, duration: 1.5, amplitude: 0.72 }], options: { vibratoCents: 45 } },
  { name: "quiet-noisy", notes: [{ midi: 57, duration: 0.7, amplitude: 0.22 }, { midi: null, duration: 0.1, amplitude: 0 }, { midi: 60, duration: 0.7, amplitude: 0.2 }], options: { noise: 0.008 } },
  { name: "octave-jump", notes: [{ midi: 48, duration: 0.65, amplitude: 0.7 }, { midi: null, duration: 0.08, amplitude: 0 }, { midi: 60, duration: 0.65, amplitude: 0.7 }], options: {} },
  { name: "short-notes", notes: [60, 64, 67, 64].flatMap((midi) => [{ midi, duration: 0.18, amplitude: 0.72 }, { midi: null, duration: 0.055, amplitude: 0 }]), options: {} },
  { name: "legato-steps", notes: [60, 62, 64, 67].map((midi) => ({ midi, duration: 0.38, amplitude: 0.7 })), options: {} },
  { name: "low-voice", notes: [45, 48, 52, 55].flatMap((midi) => [{ midi, duration: 0.42, amplitude: 0.72 }, { midi: null, duration: 0.07, amplitude: 0 }]), options: { noise: 0.004 } },
];

(async () => {
  await tf.setBackend("cpu");
  await tf.ready();
  const model = await loadPackagedModel();
  const engine = new BasicPitch(Promise.resolve(model));
  const rows = [];

  for (const fixture of fixtures) {
    const samples = synth(fixture.notes, fixture.options);
    const started = Date.now();
    const output = await infer(engine, samples);
    const runtimeMs = Date.now() - started;
    const raw = decode(output);
    const actual = consolidateMonophonic(raw, samples);
    const expected = truthEvents(fixture.notes);
    const score = strictMatchNotes(expected, actual);

    rows.push({
      case: fixture.name,
      expected: expected.length,
      raw: raw.length,
      actual: actual.length,
      matched: score.matched,
      precision: score.precision,
      recall: score.recall,
      f1: score.f1,
      onsetMaeMs: score.onsetMaeMs,
      durationMaeMs: score.durationMaeMs,
      meanTemporalIou: score.meanTemporalIou,
      runtimeMs,
    });

    if (["repeated-note", "vibrato", "octave-jump", "low-voice"].includes(fixture.name)) {
      console.log(`\nDEBUG ${fixture.name}`);
      console.log("expected", compactNotes(expected));
      console.log("raw", compactNotes(raw));
      console.log("consolidated", compactNotes(actual));
      console.log("unmatched", compactNotes(score.unmatchedActual));
    }
  }

  console.log("\nSTRICT BASIC PITCH RESULTS");
  console.table(rows.map((row) => ({
    case: row.case,
    expected: row.expected,
    raw: row.raw,
    actual: row.actual,
    matched: row.matched,
    precision: row.precision.toFixed(3),
    recall: row.recall.toFixed(3),
    f1: row.f1.toFixed(3),
    onset_ms: Number.isFinite(row.onsetMaeMs) ? row.onsetMaeMs.toFixed(1) : "inf",
    duration_ms: Number.isFinite(row.durationMaeMs) ? row.durationMaeMs.toFixed(1) : "inf",
    temporal_iou: Number.isFinite(row.meanTemporalIou) ? row.meanTemporalIou.toFixed(3) : "inf",
    runtime_ms: row.runtimeMs,
  })));

  const macroF1 = rows.reduce((sum, row) => sum + row.f1, 0) / rows.length;
  const minF1 = Math.min(...rows.map((row) => row.f1));
  const meanIou = rows.filter((row) => Number.isFinite(row.meanTemporalIou)).reduce((sum, row) => sum + row.meanTemporalIou, 0) /
    Math.max(1, rows.filter((row) => Number.isFinite(row.meanTemporalIou)).length);
  console.log(`STRICT macro F1=${macroF1.toFixed(3)} min F1=${minF1.toFixed(3)} mean temporal IoU=${meanIou.toFixed(3)}`);

  // This is intentionally a hard gate. The spike should remain red until the
  // engine + monophonic decoder deserve production integration.
  assert.ok(macroF1 >= 0.88, `strict macro F1 ${macroF1.toFixed(3)} below gate`);
  assert.ok(minF1 >= 0.75, `strict minimum fixture F1 ${minF1.toFixed(3)} below gate`);
  assert.ok(meanIou >= 0.65, `strict mean temporal IoU ${meanIou.toFixed(3)} below gate`);
  console.log("STRICT BASIC PITCH SPIKE: PASS");

  model.dispose();
  tf.disposeVariables();
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
