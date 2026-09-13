export type TimedEvent = { time: number };

/**
 * Return the first genuinely later event after a selected transient. Layered
 * hits can share one timestamp, so they must not truncate each other's sample
 * tails when the auto-kit chooses a representative slice.
 */
export function nextDistinctEventTime(
  events: TimedEvent[],
  selectedTime: number,
  simultaneousToleranceSeconds = 0.015,
): number | null {
  const threshold = selectedTime + Math.max(0, simultaneousToleranceSeconds);
  let next = Number.POSITIVE_INFINITY;
  for (const event of events) {
    if (!Number.isFinite(event.time)) continue;
    if (event.time > threshold && event.time < next) next = event.time;
  }
  return Number.isFinite(next) ? next : null;
}
