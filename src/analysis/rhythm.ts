import Essentia from "essentia.js/dist/essentia.js-core.es.js";
import { EssentiaWASM } from "essentia.js/dist/essentia-wasm.es.js";

export type RhythmAnalysis = {
  bpm: number;
  beats: number[];
  confidence: number;
};

const ESSENTIA_SAMPLE_RATE = 44100;
let essentiaInstance: any | null = null;

function getEssentia() {
  if (!essentiaInstance) essentiaInstance = new Essentia(EssentiaWASM);
  return essentiaInstance;
}

function resampleLinear(input: Float32Array, sourceRate: number, targetRate: number) {
  if (sourceRate === targetRate) return input;
  const ratio = targetRate / sourceRate;
  const output = new Float32Array(Math.round(input.length * ratio));
  for (let i = 0; i < output.length; i++) {
    const sourcePosition = i / ratio;
    const left = Math.floor(sourcePosition);
    const right = Math.min(left + 1, input.length - 1);
    const fraction = sourcePosition - left;
    output[i] = input[left] + (input[right] - input[left]) * fraction;
  }
  return output;
}

export function analyzeRhythm(samples: Float32Array, sampleRate: number): RhythmAnalysis {
  const essentia = getEssentia();
  const analysisSamples = resampleLinear(samples, sampleRate, ESSENTIA_SAMPLE_RATE);
  const signal = essentia.arrayToVector(analysisSamples);

  let ticks: any | null = null;
  let estimates: any | null = null;
  let intervals: any | null = null;

  try {
    const result = essentia.RhythmExtractor2013(signal, 208, "multifeature", 40);
    ticks = result.ticks;
    estimates = result.estimates;
    intervals = result.bpmIntervals;
    const beats = Array.from(essentia.vectorToArray(ticks) as ArrayLike<number>);
    return {
      bpm: Number(result.bpm),
      beats,
      confidence: Number(result.confidence ?? 0),
    };
  } finally {
    ticks?.delete?.();
    estimates?.delete?.();
    intervals?.delete?.();
    signal.delete?.();
  }
}

export function secondsToBeatPosition(timeSeconds: number, beats: number[]): number {
  if (beats.length < 2) return 0;

  if (timeSeconds <= beats[0]) {
    const beatLength = beats[1] - beats[0];
    return (timeSeconds - beats[0]) / beatLength;
  }

  for (let i = 0; i < beats.length - 1; i++) {
    const start = beats[i];
    const end = beats[i + 1];
    if (timeSeconds >= start && timeSeconds < end) {
      return i + (timeSeconds - start) / (end - start);
    }
  }

  const last = beats.length - 1;
  const beatLength = beats[last] - beats[last - 1];
  return last + (timeSeconds - beats[last]) / beatLength;
}
