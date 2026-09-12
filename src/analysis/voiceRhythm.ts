export type VoiceRhythmOnsetOptions = {
  frameSeconds?: number;
  hopSeconds?: number;
  minGapSeconds?: number;
};

function median(values: number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function mad(values: number[], center = median(values)): number {
  return median(values.map((value) => Math.abs(value - center)));
}

export function detectVoiceRhythmOnsets(
  samples: Float32Array,
  sampleRate: number,
  options: VoiceRhythmOnsetOptions = {},
): number[] {
  if (!samples.length || !Number.isFinite(sampleRate) || sampleRate <= 0) return [];

  const frame = Math.max(128, Math.round(sampleRate * (options.frameSeconds ?? 0.010)));
  const hop = Math.max(64, Math.round(sampleRate * (options.hopSeconds ?? 0.004)));
  const minGapFrames = Math.max(1, Math.round((options.minGapSeconds ?? 0.055) * sampleRate / hop));
  const rmsValues: number[] = [];
  const logEnergy: number[] = [];

  for (let start = 0; start + frame < samples.length; start += hop) {
    let sum = 0;
    let peak = 0;
    for (let i = start; i < start + frame; i++) {
      const value = samples[i];
      sum += value * value;
      peak = Math.max(peak, Math.abs(value));
    }
    const rms = Math.sqrt(sum / frame);
    rmsValues.push(rms);
    logEnergy.push(Math.log1p(rms * 80) + peak * 0.08);
  }

  if (logEnergy.length < 3) return [];

  const flux = new Array<number>(logEnergy.length).fill(0);
  for (let i = 1; i < logEnergy.length; i++) flux[i] = Math.max(0, logEnergy[i] - logEnergy[i - 1]);

  const smooth = flux.map((_, index) => {
    let sum = 0;
    let weight = 0;
    for (let offset = -1; offset <= 1; offset++) {
      const i = index + offset;
      if (i < 0 || i >= flux.length) continue;
      const currentWeight = offset === 0 ? 2 : 1;
      sum += flux[i] * currentWeight;
      weight += currentWeight;
    }
    return sum / weight;
  });

  const fluxMedian = median(smooth);
  const fluxMad = mad(smooth, fluxMedian);
  const rmsMedian = median(rmsValues);
  const rmsMad = mad(rmsValues, rmsMedian);
  const globalFluxThreshold = Math.max(0.008, fluxMedian + 3.2 * Math.max(fluxMad, 0.002));
  const levelThreshold = Math.max(0.008, rmsMedian + 4.0 * Math.max(rmsMad, 0.0008));
  const adaptiveWindowFrames = Math.max(3, Math.round(0.35 * sampleRate / hop));

  const picks: number[] = [];
  let lastPick = -minGapFrames;

  for (let i = 1; i < smooth.length - 1; i++) {
    const localStart = Math.max(0, i - adaptiveWindowFrames);
    const local = smooth.slice(localStart, i);
    const localMedian = median(local);
    const localMad = mad(local, localMedian);
    const localThreshold = Math.max(globalFluxThreshold, localMedian + 3.0 * Math.max(localMad, 0.0015));
    const isPeak = smooth[i] >= smooth[i - 1] && smooth[i] > smooth[i + 1];
    const isLoudEnough = rmsValues[i] >= levelThreshold;

    if (!isPeak || smooth[i] < localThreshold || !isLoudEnough) continue;

    if (i - lastPick >= minGapFrames) {
      picks.push(i);
      lastPick = i;
    } else {
      const previousIndex = picks[picks.length - 1];
      if (smooth[i] > smooth[previousIndex]) {
        picks[picks.length - 1] = i;
        lastPick = i;
      }
    }
  }

  return picks.map((index) => Math.max(0, (index * hop - frame * 0.45) / sampleRate));
}
