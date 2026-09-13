import Essentia from "essentia.js/dist/essentia.js-core.es.js";
import { EssentiaWASM } from "essentia.js/dist/essentia-wasm.es.js";

export type VoiceMelodyNote = {
  id: string;
  start: number;
  duration: number;
  beat: number;
  durationBeats: number;
  midi: number;
  confidence: number;
};

export type VoiceMelodyOptions = {
  bpm?: number;
  quantizeStepBeats?: number | null;
  confidenceThreshold?: number;
};

type PitchFrame = {
  time: number;
  hz: number;
  midi: number;
  confidence: number;
};

type PitchSegment = {
  pitchMidi: number;
  startTimeSeconds: number;
  endTimeSeconds: number;
  confidences: number[];
};

const ANALYSIS_SAMPLE_RATE = 44_100;
const FRAME_SIZE = 2_048;
const HOP_SIZE = 128;
const DEFAULT_CONFIDENCE_THRESHOLD = 0.001;
let essentiaInstance: any | null = null;

function getEssentia() {
  if (!essentiaInstance) essentiaInstance = new Essentia(EssentiaWASM);
  return essentiaInstance;
}

function resampleLinear(input: Float32Array, sourceRate: number, targetRate: number) {
  if (sourceRate === targetRate) return input;
  if (!Number.isFinite(sourceRate) || sourceRate <= 0) throw new Error("Invalid source sample rate");

  const ratio = targetRate / sourceRate;
  const output = new Float32Array(Math.max(1, Math.round(input.length * ratio)));
  for (let i = 0; i < output.length; i++) {
    const sourcePosition = i / ratio;
    const left = Math.min(input.length - 1, Math.floor(sourcePosition));
    const right = Math.min(left + 1, input.length - 1);
    const fraction = sourcePosition - left;
    output[i] = input[left] + (input[right] - input[left]) * fraction;
  }
  return output;
}

function hzToMidi(hz: number) {
  return hz > 0 ? 69 + 12 * Math.log2(hz / 440) : Number.NaN;
}

function median(values: number[]) {
  if (!values.length) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function quantize(value: number, step: number | null | undefined) {
  if (!step || step <= 0) return value;
  return Math.round(value / step) * step;
}

function trackMelody(samples: Float32Array, sampleRate: number): PitchFrame[] {
  if (!samples.length) return [];

  const essentia = getEssentia();
  const analysisSamples = resampleLinear(samples, sampleRate, ANALYSIS_SAMPLE_RATE);
  const signal = essentia.arrayToVector(analysisSamples);
  let pitch: any | null = null;
  let confidence: any | null = null;

  try {
    // Parameters are the winner from the corrected Sprint 2 bakeoff. Keep this
    // call centralized so engine/config changes remain isolated from product UI.
    const result = essentia.PitchMelodia(
      signal,
      10,
      3,
      FRAME_SIZE,
      false,
      0.8,
      HOP_SIZE,
      1,
      40,
      1200,
      80,
      50,
      20,
      0.9,
      0.9,
      27.5625,
      55,
      ANALYSIS_SAMPLE_RATE,
      100,
    );

    pitch = result.pitch;
    confidence = result.pitchConfidence;
    const pitches = Array.from(essentia.vectorToArray(pitch) as ArrayLike<number>);
    const confidences = Array.from(essentia.vectorToArray(confidence) as ArrayLike<number>);

    return pitches.map((hz, index) => ({
      time: index * HOP_SIZE / ANALYSIS_SAMPLE_RATE,
      hz,
      midi: hzToMidi(hz),
      confidence: confidences[index] ?? 0,
    }));
  } finally {
    pitch?.delete?.();
    confidence?.delete?.();
    signal.delete?.();
  }
}

function framesToSegments(frames: PitchFrame[], confidenceThreshold: number) {
  const hopSeconds = HOP_SIZE / ANALYSIS_SAMPLE_RATE;
  const voiced = frames.map((frame) => ({
    ...frame,
    usableMidi:
      frame.hz > 0 && Number.isFinite(frame.midi) && frame.confidence >= confidenceThreshold
        ? frame.midi
        : Number.NaN,
  }));

  // Five-frame median smoothing removes isolated harmonic/octave glitches while
  // staying much shorter than the shortest accepted note (60 ms).
  const smoothed = voiced.map((frame, index) => {
    if (!Number.isFinite(frame.usableMidi)) return { ...frame, smoothedMidi: Number.NaN };
    const values: number[] = [];
    for (let offset = Math.max(0, index - 2); offset <= Math.min(voiced.length - 1, index + 2); offset++) {
      if (Number.isFinite(voiced[offset].usableMidi)) values.push(voiced[offset].usableMidi);
    }
    return { ...frame, smoothedMidi: median(values) };
  });

  const raw: PitchSegment[] = [];
  let active: PitchSegment | null = null;

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

  // Repair only tiny one-note excursions surrounded by the same note. This is
  // intentionally conservative: real pitch changes and re-articulations survive.
  const repaired: PitchSegment[] = [];
  for (let index = 0; index < raw.length; index++) {
    const segment = raw[index];
    const duration = segment.endTimeSeconds - segment.startTimeSeconds;
    const previous = repaired[repaired.length - 1];
    const next = raw[index + 1];
    if (
      duration <= Math.max(0.05, hopSeconds * 5) &&
      previous &&
      next &&
      previous.pitchMidi === next.pitchMidi
    ) {
      previous.endTimeSeconds = next.endTimeSeconds;
      previous.confidences.push(...segment.confidences, ...next.confidences);
      index++;
      continue;
    }
    repaired.push({ ...segment, confidences: [...segment.confidences] });
  }

  const minDuration = Math.max(0.06, hopSeconds * 3);
  const compact = repaired
    .map((segment) => ({
      pitchMidi: Math.max(0, Math.min(127, segment.pitchMidi)),
      startTimeSeconds: segment.startTimeSeconds,
      durationSeconds: Math.max(0, segment.endTimeSeconds - segment.startTimeSeconds),
      confidence:
        segment.confidences.reduce((sum, value) => sum + value, 0) /
        Math.max(1, segment.confidences.length),
    }))
    .filter((note) => note.durationSeconds >= minDuration);

  // Bridge only very small tracking dropouts. A ~60 ms silence still creates a
  // distinct repeated note instead of being swallowed into one long note.
  const merged: typeof compact = [];
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

export function detectVoiceMelody(
  samples: Float32Array,
  sampleRate: number,
  options: VoiceMelodyOptions = {},
): VoiceMelodyNote[] {
  if (!samples.length) return [];
  const bpm = Number.isFinite(options.bpm) && (options.bpm ?? 0) > 0 ? options.bpm! : 120;
  const confidenceThreshold = Math.max(0, options.confidenceThreshold ?? DEFAULT_CONFIDENCE_THRESHOLD);
  const frames = trackMelody(samples, sampleRate);
  const notes = framesToSegments(frames, confidenceThreshold);

  return notes.map((note, index) => {
    const rawBeat = note.startTimeSeconds * bpm / 60;
    const rawDurationBeats = note.durationSeconds * bpm / 60;
    const beat = quantize(rawBeat, options.quantizeStepBeats);
    const endBeat = quantize(rawBeat + rawDurationBeats, options.quantizeStepBeats);
    return {
      id: `vm-${index}-${Math.round(note.startTimeSeconds * 1000)}`,
      start: note.startTimeSeconds,
      duration: note.durationSeconds,
      beat,
      durationBeats: Math.max(0.0625, endBeat - beat),
      midi: note.pitchMidi,
      confidence: note.confidence,
    };
  });
}
