export type TimedHit = {
  time: number;
  beat: number;
};

function secondsToBeatPosition(timeSeconds: number, beats: number[]) {
  if (beats.length < 2) return 0;

  if (timeSeconds <= beats[0]) {
    const beatLength = beats[1] - beats[0];
    return beatLength > 0 ? (timeSeconds - beats[0]) / beatLength : 0;
  }

  for (let i = 0; i < beats.length - 1; i++) {
    const start = beats[i];
    const end = beats[i + 1];
    if (timeSeconds >= start && timeSeconds < end) {
      const beatLength = end - start;
      return beatLength > 0 ? i + (timeSeconds - start) / beatLength : i;
    }
  }

  const last = beats.length - 1;
  const beatLength = beats[last] - beats[last - 1];
  return beatLength > 0
    ? last + (timeSeconds - beats[last]) / beatLength
    : last;
}

/**
 * Map absolute onset times onto musical beat positions.
 *
 * Beat ticks are authoritative when available. If beat tracking is unavailable,
 * fall back to absolute audio time at the supplied tempo. We intentionally do
 * NOT anchor to the first detected transient: a missing/late first hit must not
 * shift every later pad in the visual pattern.
 */
export function alignHitsToBeatGrid<T extends TimedHit>(
  hits: T[],
  beatTicks: number[],
  fallbackBpm: number,
): T[] {
  const validTicks = beatTicks.filter((time) => Number.isFinite(time));
  const hasBeatGrid = validTicks.length >= 2;
  const safeBpm = Number.isFinite(fallbackBpm) && fallbackBpm > 0 ? fallbackBpm : 120;

  return hits.map((hit) => ({
    ...hit,
    beat: hasBeatGrid
      ? secondsToBeatPosition(hit.time, validTicks)
      : hit.time * safeBpm / 60,
  }));
}

export function beatToStep(beat: number, stepsPerBeat = 4) {
  if (!Number.isFinite(beat)) return -1;
  return Math.round(beat * stepsPerBeat);
}
