export type RhythmCaptureGridOptions = {
  bpm: number;
  steps?: number;
  beatsPerBar?: number;
  captureOffsetSeconds?: number;
};

export function rhythmCaptureDurationSeconds(bpm: number, beatsPerBar = 4): number {
  if (!Number.isFinite(bpm) || bpm <= 0 || !Number.isFinite(beatsPerBar) || beatsPerBar <= 0) return 0;
  return beatsPerBar * 60 / bpm;
}

export function quantizeRhythmCapture(
  onsetSeconds: readonly number[],
  options: RhythmCaptureGridOptions,
): number[] {
  const steps = Math.max(1, Math.floor(options.steps ?? 16));
  const beatsPerBar = Math.max(1, options.beatsPerBar ?? 4);
  const bpm = options.bpm;
  if (!Number.isFinite(bpm) || bpm <= 0) return [];

  const captureOffset = Number.isFinite(options.captureOffsetSeconds)
    ? Math.max(0, options.captureOffsetSeconds ?? 0)
    : 0;
  const barDuration = rhythmCaptureDurationSeconds(bpm, beatsPerBar);
  const stepDuration = barDuration / steps;
  const maxAcceptedTime = captureOffset + barDuration + stepDuration * 0.45;
  const active = new Set<number>();

  for (const rawTime of onsetSeconds) {
    if (!Number.isFinite(rawTime) || rawTime < captureOffset || rawTime > maxAcceptedTime) continue;
    const relative = rawTime - captureOffset;
    const step = Math.round(relative / stepDuration);
    if (step < 0 || step >= steps) continue;
    active.add(step);
  }

  return [...active].sort((a, b) => a - b);
}
