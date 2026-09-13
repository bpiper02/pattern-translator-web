import type { DrumTimbreFeatures } from "./drumTimbreCore";

const ANALYSIS_SR = 44_100;
const FRAME_SIZE = 2_048;
const HOP_SIZE = 512;
const PRE_ROLL_SECONDS = 0.004;
const FEATURE_TAIL_SECONDS = 0.064;

function meanVector(essentia: any, vector: any) {
  if (!vector) return 0;
  const values = Array.from(essentia.vectorToArray(vector) as ArrayLike<number>);
  if (!values.length) return 0;
  return values.reduce((sum, value) => sum + Number(value), 0) / values.length;
}

function cleanupResult(result: any) {
  for (const value of Object.values(result ?? {})) (value as any)?.delete?.();
}

function transientWindow(samples: Float32Array, time: number) {
  const start = Math.max(0, Math.floor((time - PRE_ROLL_SECONDS) * ANALYSIS_SR));
  const desiredEnd = Math.min(samples.length, Math.ceil((time + FEATURE_TAIL_SECONDS) * ANALYSIS_SR));
  const sourceLength = Math.max(0, desiredEnd - start);
  const length = Math.max(FRAME_SIZE, sourceLength);
  const output = new Float32Array(length);
  if (sourceLength > 0) output.set(samples.subarray(start, desiredEnd));
  return output;
}

/**
 * Compute source-independent acoustic descriptors for each onset. The caller
 * owns the Essentia instance so onset detection and timbre analysis share one
 * WASM runtime instead of instantiating a second engine.
 */
export function extractDrumTimbreFeatures(
  essentia: any,
  samples44100: Float32Array,
  hits: { id: string; time: number }[],
): DrumTimbreFeatures[] {
  return hits.map((hit) => {
    const window = transientWindow(samples44100, hit.time);
    const signal = essentia.arrayToVector(window);
    let result: any | null = null;
    try {
      result = essentia.LowLevelSpectralExtractor(signal, FRAME_SIZE, HOP_SIZE, ANALYSIS_SR);
      const low = meanVector(essentia, result.spectral_energyband_low);
      const midLow = meanVector(essentia, result.spectral_energyband_middle_low);
      const midHigh = meanVector(essentia, result.spectral_energyband_middle_high);
      const high = meanVector(essentia, result.spectral_energyband_high);
      const total = Math.max(1e-12, low + midLow + midHigh + high);
      return {
        id: hit.id,
        lowRatio: low / total,
        midLowRatio: midLow / total,
        midHighRatio: midHigh / total,
        highRatio: high / total,
        flatnessDb: meanVector(essentia, result.spectral_flatness_db),
        rolloffHz: meanVector(essentia, result.spectral_rolloff),
        zcr: meanVector(essentia, result.zerocrossingrate),
      };
    } finally {
      cleanupResult(result);
      signal.delete?.();
    }
  });
}
