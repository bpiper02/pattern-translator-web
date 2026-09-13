const assert = require("node:assert/strict");
const { Essentia, EssentiaWASM } = require("essentia.js");

const SR = 44100;
const essentia = new Essentia(EssentiaWASM);
const midiToHz = (midi) => 440 * 2 ** ((midi - 69) / 12);
const hzToMidi = (hz) => hz > 0 ? 69 + 12 * Math.log2(hz / 440) : NaN;

// v2 fixture oscillator: frequency modulation must be integrated into phase.
// Using phase = 2*pi*f(t)*t adds a spurious t*f'(t) term and turns a small
// vibrato into extreme pitch excursions, invalidating the benchmark.
function synth(notes, { noise = 0, vibratoCents = 0 } = {}) {
  const duration = notes.reduce((sum, note) => sum + note.duration, 0);
  const output = new Float32Array(Math.ceil(duration * SR));
  let cursor = 0;
  let seed = 0x12345678;
  const random = () => ((seed = (1664525 * seed + 1013904223) >>> 0) / 0x100000000);

  for (const note of notes) {
    const count = Math.round(note.duration * SR);
    let phase = 0;
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
      const voiced = 0.58 * Math.sin(phase) + 0.24 * Math.sin(2 * phase) + 0.10 * Math.sin(3 * phase);
      output[cursor + i] = note.amplitude * envelope * voiced + (random() * 2 - 1) * noise;
      phase += 2 * Math.PI * frequency / SR;
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
    if (note.midi != null) events.push({ pitchMidi: note.midi, startTimeSeconds: cursor, durationSeconds: note.duration });
    cursor += note.duration;
  }
  return events;
}

function truthAt(notes, time) {
  let cursor = 0;
  for (const note of notes) {
    const end = cursor + note.duration;
    if (time >= cursor && time < end) return { ...note, start: cursor, end };
    cursor = end;
  }
  return null;
}

function trackMelodia(samples) {
  const signal = essentia.arrayToVector(samples);
  let pitch = null;
  let confidence = null;
  const started = Date.now();
  try {
    const result = essentia.PitchMelodia(signal, 10, 3, 2048, false, 0.8, 128, 1, 40, 1200, 80, 50, 20, 0.9, 0.9, 27.5625, 55, SR, 100);
    pitch = result.pitch;
    confidence = result.pitchConfidence;
    const pitches = Array.from(essentia.vectorToArray(pitch));
    const confidences = Array.from(essentia.vectorToArray(confidence));
    const runtimeMs = Date.now() - started;
    return pitches.map((hz, index) => ({
      time: index * 128 / SR,
      hz,
      midi: hzToMidi(hz),
      confidence: confidences[index] ?? 0,
      runtimeMs,
    }));
  } finally {
    pitch?.delete?.();
    confidence?.delete?.();
    signal.delete?.();
  }
}

function trackPyin(samples, hopSize) {
  const signal = essentia.arrayToVector(samples);
  let pitch = null;
  let probabilities = null;
  const started = Date.now();
  try {
    const result = essentia.PitchYinProbabilistic(signal, 2048, hopSize, 0.01, "zero", false, SR);
    pitch = result.pitch;
    probabilities = result.voicedProbabilities;
    const pitches = Array.from(essentia.vectorToArray(pitch));
    const probs = Array.from(essentia.vectorToArray(probabilities));
    const runtimeMs = Date.now() - started;
    // PitchYinProbabilistic accepts the full signal and performs FrameCutter
    // internally. Treat vector index 0 as t=0; do not add a guessed half-frame
    // delay on top of the algorithm's own framing.
    return pitches.map((hz, index) => ({
      time: index * hopSize / SR,
      hz,
      midi: hzToMidi(hz),
      confidence: probs[index] ?? 0,
      runtimeMs,
    }));
  } finally {
    pitch?.delete?.();
    probabilities?.delete?.();
    signal.delete?.();
  }
}

function median(values) {
  if (!values.length) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function scoreFrames(frames, notes, candidate) {
  const boundaryMargin = Math.max(0.03, candidate.frameSize / SR * 0.35);
  let expectedVoiced = 0;
  let correctlyVoiced = 0;
  let pitchCorrect = 0;
  let expectedRest = 0;
  let falseVoiced = 0;
  const cents = [];

  for (const frame of frames) {
    const expected = truthAt(notes, frame.time);
    if (!expected) continue;
    const nearBoundary = frame.time - expected.start < boundaryMargin || expected.end - frame.time < boundaryMargin;
    if (nearBoundary) continue;
    const voiced = frame.hz > 0 && Number.isFinite(frame.midi) && frame.confidence >= candidate.confidenceThreshold;

    if (expected.midi == null) {
      expectedRest++;
      if (voiced) falseVoiced++;
      continue;
    }

    expectedVoiced++;
    if (!voiced) continue;
    correctlyVoiced++;
    const errorCents = Math.abs(frame.midi - expected.midi) * 100;
    cents.push(errorCents);
    if (errorCents <= 50) pitchCorrect++;
  }

  cents.sort((a, b) => a - b);
  return {
    voicedRecall: expectedVoiced ? correctlyVoiced / expectedVoiced : 1,
    pitchAccuracy: expectedVoiced ? pitchCorrect / expectedVoiced : 1,
    medianCents: cents.length ? cents[Math.floor(cents.length / 2)] : Infinity,
    falseVoicedRate: expectedRest ? falseVoiced / expectedRest : 0,
  };
}

function framesToNotes(frames, candidate) {
  const hopSeconds = candidate.hopSize / SR;
  const voiced = frames.map((frame) => ({
    ...frame,
    usableMidi: frame.hz > 0 && Number.isFinite(frame.midi) && frame.confidence >= candidate.confidenceThreshold ? frame.midi : NaN,
  }));

  // Short median smoothing suppresses single-frame harmonic/octave glitches but
  // remains far shorter than the shortest fixture note.
  const smoothed = voiced.map((frame, index) => {
    if (!Number.isFinite(frame.usableMidi)) return { ...frame, smoothedMidi: NaN };
    const values = [];
    for (let j = Math.max(0, index - 2); j <= Math.min(voiced.length - 1, index + 2); j++) {
      if (Number.isFinite(voiced[j].usableMidi)) values.push(voiced[j].usableMidi);
    }
    return { ...frame, smoothedMidi: median(values) };
  });

  const raw = [];
  let active = null;
  for (const frame of smoothed) {
    const midi = Number.isFinite(frame.smoothedMidi) ? Math.round(frame.smoothedMidi) : null;
    if (midi == null) {
      if (active) raw.push(active);
      active = null;
      continue;
    }
    if (!active || midi !== active.pitchMidi) {
      if (active) raw.push(active);
      active = {
        pitchMidi: midi,
        startTimeSeconds: Math.max(0, frame.time - hopSeconds / 2),
        endTimeSeconds: frame.time + hopSeconds / 2,
        confidences: [frame.confidence],
      };
    } else {
      active.endTimeSeconds = frame.time + hopSeconds / 2;
      active.confidences.push(frame.confidence);
    }
  }
  if (active) raw.push(active);

  // Collapse a tiny one-note pitch excursion when the surrounding segments are
  // the same note. This treats vibrato/harmonic glitches as contour noise while
  // preserving genuine pitch changes and silence-separated re-articulation.
  const repaired = [];
  for (let i = 0; i < raw.length; i++) {
    const segment = raw[i];
    const duration = segment.endTimeSeconds - segment.startTimeSeconds;
    const previous = repaired[repaired.length - 1];
    const next = raw[i + 1];
    if (duration <= Math.max(0.05, hopSeconds * 5) && previous && next && previous.pitchMidi === next.pitchMidi) {
      previous.endTimeSeconds = next.endTimeSeconds;
      previous.confidences.push(...segment.confidences, ...next.confidences);
      i++;
      continue;
    }
    repaired.push({ ...segment, confidences: [...segment.confidences] });
  }

  const minDuration = Math.max(0.06, hopSeconds * 3);
  const compact = repaired
    .map((segment) => ({
      pitchMidi: segment.pitchMidi,
      startTimeSeconds: segment.startTimeSeconds,
      durationSeconds: Math.max(0, segment.endTimeSeconds - segment.startTimeSeconds),
      confidence: segment.confidences.reduce((sum, value) => sum + value, 0) / Math.max(1, segment.confidences.length),
    }))
    .filter((note) => note.durationSeconds >= minDuration);

  // Only bridge tiny unvoiced gaps. The repeated-note fixture has 60 ms gaps,
  // so a genuine re-articulation remains separate.
  const merged = [];
  for (const note of compact) {
    const previous = merged[merged.length - 1];
    if (previous && previous.pitchMidi === note.pitchMidi) {
      const previousEnd = previous.startTimeSeconds + previous.durationSeconds;
      const gap = note.startTimeSeconds - previousEnd;
      if (gap >= 0 && gap <= Math.max(0.03, hopSeconds * 2.5)) {
        previous.durationSeconds = note.startTimeSeconds + note.durationSeconds - previous.startTimeSeconds;
        previous.confidence = Math.max(previous.confidence, note.confidence);
        continue;
      }
    }
    merged.push({ ...note });
  }
  return merged;
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

function scoreNotes(expected, actual) {
  const used = new Set();
  const ious = [];
  const onsetErrors = [];
  let matched = 0;

  for (const target of expected) {
    let best = -1;
    let bestScore = -Infinity;
    for (let index = 0; index < actual.length; index++) {
      if (used.has(index)) continue;
      const note = actual[index];
      if (note.pitchMidi !== target.pitchMidi) continue;
      const onsetError = Math.abs(note.startTimeSeconds - target.startTimeSeconds);
      const overlap = overlapSeconds(target, note);
      const coverage = overlap / Math.max(0.001, target.durationSeconds);
      const iou = temporalIou(target, note);
      if (onsetError > 0.18 || coverage < 0.45 || iou < 0.30) continue;
      const score = iou - onsetError * 0.25;
      if (score > bestScore) {
        bestScore = score;
        best = index;
      }
    }
    if (best >= 0) {
      const note = actual[best];
      used.add(best);
      matched++;
      ious.push(temporalIou(target, note));
      onsetErrors.push(Math.abs(note.startTimeSeconds - target.startTimeSeconds));
    }
  }

  const precision = actual.length ? matched / actual.length : expected.length ? 0 : 1;
  const recall = expected.length ? matched / expected.length : 1;
  const f1 = precision + recall ? 2 * precision * recall / (precision + recall) : 0;
  const mean = (values) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : Infinity;
  return { matched, precision, recall, f1, meanIou: mean(ious), onsetMaeMs: mean(onsetErrors) * 1000 };
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

const candidates = [
  { name: "melodia", frameSize: 2048, hopSize: 128, confidenceThreshold: 0.001, track: trackMelodia },
  { name: "pyin-128", frameSize: 2048, hopSize: 128, confidenceThreshold: 0.45, track: (samples) => trackPyin(samples, 128) },
  { name: "pyin-256", frameSize: 2048, hopSize: 256, confidenceThreshold: 0.45, track: (samples) => trackPyin(samples, 256) },
];

const summaries = [];
for (const candidate of candidates) {
  const rows = [];
  for (const fixture of fixtures) {
    const samples = synth(fixture.notes, fixture.options);
    const frames = candidate.track(samples);
    const frameScore = scoreFrames(frames, fixture.notes, candidate);
    const expected = truthEvents(fixture.notes);
    const actual = framesToNotes(frames, candidate);
    const noteScore = scoreNotes(expected, actual);
    rows.push({
      case: fixture.name,
      expected: expected.length,
      actual: actual.length,
      runtimeMs: frames[0]?.runtimeMs ?? 0,
      ...frameScore,
      ...noteScore,
    });
  }

  const macroF1 = rows.reduce((sum, row) => sum + row.f1, 0) / rows.length;
  const minF1 = Math.min(...rows.map((row) => row.f1));
  const meanPitchAccuracy = rows.reduce((sum, row) => sum + row.pitchAccuracy, 0) / rows.length;
  const meanVoicedRecall = rows.reduce((sum, row) => sum + row.voicedRecall, 0) / rows.length;
  const falseVoicedRate = rows.reduce((sum, row) => sum + row.falseVoicedRate, 0) / rows.length;
  const totalRuntime = rows.reduce((sum, row) => sum + row.runtimeMs, 0);
  const vibratoF1 = rows.find((row) => row.case === "vibrato")?.f1 ?? 0;

  console.log(`\nCANDIDATE ${candidate.name}`);
  console.table(rows.map((row) => ({
    case: row.case,
    expected: row.expected,
    actual: row.actual,
    note_f1: row.f1.toFixed(3),
    pitch_acc: row.pitchAccuracy.toFixed(3),
    voiced_recall: row.voicedRecall.toFixed(3),
    median_cents: Number.isFinite(row.medianCents) ? row.medianCents.toFixed(1) : "inf",
    false_voiced: row.falseVoicedRate.toFixed(3),
    onset_ms: Number.isFinite(row.onsetMaeMs) ? row.onsetMaeMs.toFixed(1) : "inf",
    iou: Number.isFinite(row.meanIou) ? row.meanIou.toFixed(3) : "inf",
    runtime_ms: row.runtimeMs,
  })));
  console.log(`summary F1=${macroF1.toFixed(3)} min=${minF1.toFixed(3)} pitch=${meanPitchAccuracy.toFixed(3)} voiced=${meanVoicedRecall.toFixed(3)} falseVoiced=${falseVoicedRate.toFixed(3)} vibrato=${vibratoF1.toFixed(3)} runtime=${totalRuntime}ms`);
  summaries.push({ candidate, rows, macroF1, minF1, meanPitchAccuracy, meanVoicedRecall, falseVoicedRate, vibratoF1, totalRuntime });
}

summaries.sort((a, b) =>
  (b.macroF1 - a.macroF1) ||
  (b.minF1 - a.minF1) ||
  (b.meanPitchAccuracy - a.meanPitchAccuracy) ||
  (a.falseVoicedRate - b.falseVoicedRate) ||
  (a.totalRuntime - b.totalRuntime)
);

const best = summaries[0];
console.log(`\nBEST V2: ${best.candidate.name} macro F1=${best.macroF1.toFixed(3)} min=${best.minF1.toFixed(3)} pitch=${best.meanPitchAccuracy.toFixed(3)} voiced=${best.meanVoicedRecall.toFixed(3)} vibrato=${best.vibratoF1.toFixed(3)} runtime=${best.totalRuntime}ms`);

assert.ok(best.meanPitchAccuracy >= 0.90, `best pitch accuracy ${best.meanPitchAccuracy.toFixed(3)} below gate`);
assert.ok(best.meanVoicedRecall >= 0.85, `best voiced recall ${best.meanVoicedRecall.toFixed(3)} below gate`);
assert.ok(best.macroF1 >= 0.85, `best note macro F1 ${best.macroF1.toFixed(3)} below gate`);
assert.ok(best.minF1 >= 0.70, `best minimum fixture F1 ${best.minF1.toFixed(3)} below gate`);
assert.ok(best.vibratoF1 >= 0.80, `best vibrato F1 ${best.vibratoF1.toFixed(3)} below gate`);
console.log("MELODY BAKEOFF V2: PASS");
