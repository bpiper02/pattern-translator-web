export type AdaptiveDrumSliceOptions = {
  preRollSeconds?: number;
  minTailSeconds?: number;
  maxTailSeconds?: number;
  windowSeconds?: number;
  hopSeconds?: number;
  noiseLookbackSeconds?: number;
  releasePadSeconds?: number;
  relativeThreshold?: number;
  noiseMultiplier?: number;
  nextEventSafetySeconds?: number;
};

export type AdaptiveDrumSliceBounds = {
  startSeconds: number;
  endSeconds: number;
  noiseFloor: number;
  peakRms: number;
  threshold: number;
};

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function rms(samples: Float32Array, start: number, end: number) {
  const safeStart = Math.max(0, Math.min(samples.length, Math.floor(start)));
  const safeEnd = Math.max(safeStart + 1, Math.min(samples.length, Math.ceil(end)));
  let energy = 0;
  for (let i = safeStart; i < safeEnd; i++) energy += samples[i] * samples[i];
  return Math.sqrt(energy / Math.max(1, safeEnd - safeStart));
}

function median(values: number[]) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function windowRmsValues(
  samples: Float32Array,
  sampleRate: number,
  startSeconds: number,
  endSeconds: number,
  windowSeconds: number,
  hopSeconds: number,
) {
  const values: { time: number; rms: number }[] = [];
  const windowSamples = Math.max(1, Math.round(windowSeconds * sampleRate));
  const hopSamples = Math.max(1, Math.round(hopSeconds * sampleRate));
  const startSample = Math.max(0, Math.round(startSeconds * sampleRate));
  const endSample = Math.min(samples.length, Math.round(endSeconds * sampleRate));

  for (let cursor = startSample; cursor < endSample; cursor += hopSamples) {
    const windowEnd = Math.min(endSample, cursor + windowSamples);
    if (windowEnd <= cursor) break;
    values.push({
      time: cursor / sampleRate,
      rms: rms(samples, cursor, windowEnd),
    });
  }
  return values;
}

/**
 * Find a representative one-shot boundary from the source envelope rather than
 * a hard-coded kick/snare/hat duration. The last meaningful energy window wins,
 * so a later delay/reverb echo is retained even if the envelope dips in between.
 */
export function findAdaptiveDrumSliceBounds(
  samples: Float32Array,
  sampleRate: number,
  hitTimeSeconds: number,
  nextEventTimeSeconds: number | null = null,
  options: AdaptiveDrumSliceOptions = {},
): AdaptiveDrumSliceBounds {
  const duration = sampleRate > 0 ? samples.length / sampleRate : 0;
  if (!samples.length || !Number.isFinite(sampleRate) || sampleRate <= 0) {
    return { startSeconds: 0, endSeconds: 0, noiseFloor: 0, peakRms: 0, threshold: 0 };
  }

  const preRoll = Math.max(0, options.preRollSeconds ?? 0.004);
  const minTail = Math.max(0.02, options.minTailSeconds ?? 0.06);
  const maxTail = Math.max(minTail, options.maxTailSeconds ?? 1.8);
  const windowSeconds = Math.max(0.004, options.windowSeconds ?? 0.012);
  const hopSeconds = Math.max(0.002, options.hopSeconds ?? 0.006);
  const noiseLookback = Math.max(0.02, options.noiseLookbackSeconds ?? 0.10);
  const releasePad = Math.max(0, options.releasePadSeconds ?? 0.020);
  const relativeThreshold = Math.max(0.001, options.relativeThreshold ?? 0.012);
  const noiseMultiplier = Math.max(1, options.noiseMultiplier ?? 2.5);
  const nextSafety = Math.max(0, options.nextEventSafetySeconds ?? 0.004);

  const hitTime = clamp(Number.isFinite(hitTimeSeconds) ? hitTimeSeconds : 0, 0, duration);
  const startSeconds = Math.max(0, hitTime - preRoll);

  const preEnd = Math.max(0, hitTime - Math.max(preRoll, 0.008));
  const preStart = Math.max(0, preEnd - noiseLookback);
  const preWindows = windowRmsValues(
    samples,
    sampleRate,
    preStart,
    preEnd,
    windowSeconds,
    hopSeconds,
  );
  const noiseFloor = median(preWindows.map((window) => window.rms));

  let hardEnd = Math.min(duration, hitTime + maxTail);
  if (
    nextEventTimeSeconds != null &&
    Number.isFinite(nextEventTimeSeconds) &&
    nextEventTimeSeconds > hitTime + 0.015
  ) {
    hardEnd = Math.min(hardEnd, Math.max(startSeconds + 0.02, nextEventTimeSeconds - nextSafety));
  }

  const analysisWindows = windowRmsValues(
    samples,
    sampleRate,
    hitTime,
    hardEnd,
    windowSeconds,
    hopSeconds,
  );
  const peakRms = analysisWindows.reduce((peak, window) => Math.max(peak, window.rms), 0);
  const threshold = Math.max(1e-6, noiseFloor * noiseMultiplier, peakRms * relativeThreshold);

  const minimumEnd = Math.min(hardEnd, hitTime + minTail);
  let lastActiveEnd = minimumEnd;
  for (const window of analysisWindows) {
    if (window.time + windowSeconds < minimumEnd) continue;
    if (window.rms >= threshold) {
      lastActiveEnd = Math.min(hardEnd, window.time + windowSeconds);
    }
  }

  const endSeconds = Math.max(
    Math.min(hardEnd, lastActiveEnd + releasePad),
    Math.min(hardEnd, startSeconds + 0.02),
  );

  return { startSeconds, endSeconds, noiseFloor, peakRms, threshold };
}

/** Tiny click-prevention fade; preserves the body/timbre of the extracted hit. */
export function applySafetyFadeOut(
  samples: Float32Array,
  sampleRate: number,
  fadeSeconds = 0.006,
) {
  if (!samples.length || !Number.isFinite(sampleRate) || sampleRate <= 0) return;
  const fadeSamples = Math.min(samples.length, Math.max(1, Math.round(fadeSeconds * sampleRate)));
  const start = samples.length - fadeSamples;
  for (let i = 0; i < fadeSamples; i++) {
    const gain = 1 - (i + 1) / fadeSamples;
    samples[start + i] *= gain;
  }
}
