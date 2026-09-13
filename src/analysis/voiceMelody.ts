import Essentia from "essentia.js/dist/essentia.js-core.es.js";
import { EssentiaWASM } from "essentia.js/dist/essentia-wasm.es.js";
import {
  VOICE_MELODY_FRAME_SIZE,
  VOICE_MELODY_HOP_SIZE,
  VOICE_MELODY_SAMPLE_RATE,
  resampleVoiceMelodySamples,
  voiceMelodyFramesToNotes,
  voiceMelodyHzToMidi,
  type VoiceMelodyNote,
  type VoiceMelodyOptions,
  type VoiceMelodyPitchFrame,
} from "./voiceMelodyCore";

export type { VoiceMelodyNote, VoiceMelodyOptions } from "./voiceMelodyCore";

let essentiaInstance: any | null = null;

function getEssentia() {
  if (!essentiaInstance) essentiaInstance = new Essentia(EssentiaWASM);
  return essentiaInstance;
}

function trackMelody(samples: Float32Array, sampleRate: number): VoiceMelodyPitchFrame[] {
  if (!samples.length) return [];

  const essentia = getEssentia();
  const analysisSamples = resampleVoiceMelodySamples(samples, sampleRate, VOICE_MELODY_SAMPLE_RATE);
  const signal = essentia.arrayToVector(analysisSamples);
  let pitch: any | null = null;
  let confidence: any | null = null;

  try {
    // Parameters are the winner from the corrected Sprint 2 bakeoff. This file
    // is only the browser/WASM adapter; all note cleanup lives in the pure core.
    const result = essentia.PitchMelodia(
      signal,
      10,
      3,
      VOICE_MELODY_FRAME_SIZE,
      false,
      0.8,
      VOICE_MELODY_HOP_SIZE,
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
      VOICE_MELODY_SAMPLE_RATE,
      100,
    );

    pitch = result.pitch;
    confidence = result.pitchConfidence;
    const pitches = Array.from(essentia.vectorToArray(pitch) as ArrayLike<number>);
    const confidences = Array.from(essentia.vectorToArray(confidence) as ArrayLike<number>);

    return pitches.map((hz, index) => ({
      time: index * VOICE_MELODY_HOP_SIZE / VOICE_MELODY_SAMPLE_RATE,
      hz,
      midi: voiceMelodyHzToMidi(hz),
      confidence: confidences[index] ?? 0,
    }));
  } finally {
    pitch?.delete?.();
    confidence?.delete?.();
    signal.delete?.();
  }
}

export function detectVoiceMelody(
  samples: Float32Array,
  sampleRate: number,
  options: VoiceMelodyOptions = {},
): VoiceMelodyNote[] {
  if (!samples.length) return [];
  return voiceMelodyFramesToNotes(trackMelody(samples, sampleRate), options);
}
