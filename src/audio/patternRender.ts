export type PatternLaneInput = {
  name: string;
  buffer: AudioBuffer | null;
  steps: boolean[];
};

export type PatternRenderEvent = {
  lane: string;
  step: number;
  bar: number;
  timeSeconds: number;
};

export function buildPatternRenderPlan(
  lanes: Pick<PatternLaneInput, "name" | "steps">[],
  bpm: number,
  bars = 4,
) {
  const safeBpm = Number.isFinite(bpm) && bpm > 0 ? bpm : 120;
  const safeBars = Math.max(1, Math.floor(bars));
  const stepsPerBar = Math.max(1, ...lanes.map((lane) => lane.steps.length));
  const secondsPerStep = 60 / safeBpm / 4;
  const events: PatternRenderEvent[] = [];

  for (let bar = 0; bar < safeBars; bar++) {
    for (const lane of lanes) {
      lane.steps.forEach((enabled, step) => {
        if (!enabled) return;
        events.push({
          lane: lane.name,
          step,
          bar,
          timeSeconds: (bar * stepsPerBar + step) * secondsPerStep,
        });
      });
    }
  }

  return {
    bpm: safeBpm,
    bars: safeBars,
    stepsPerBar,
    secondsPerStep,
    durationSeconds: safeBars * stepsPerBar * secondsPerStep,
    events,
  };
}

/**
 * The single renderer used by both working-pattern preview and WAV export.
 * Preview should play the returned AudioBuffer directly; export should encode
 * that same buffer rather than reconstructing the pattern through another path.
 */
export async function renderPatternBuffer(
  lanes: PatternLaneInput[],
  bpm: number,
  bars = 4,
): Promise<AudioBuffer> {
  const activeLanes = lanes.filter((lane) => lane.buffer && lane.steps.some(Boolean));
  if (!activeLanes.length) throw new Error("Add a sample and program at least one step");

  const plan = buildPatternRenderPlan(activeLanes, bpm, bars);
  const sampleRate = Math.max(...activeLanes.map((lane) => lane.buffer!.sampleRate));
  const channels = Math.max(...activeLanes.map((lane) => lane.buffer!.numberOfChannels));
  const maxTail = Math.max(...activeLanes.map((lane) => lane.buffer!.duration), 0.08);
  const frames = Math.ceil((plan.durationSeconds + maxTail + 0.05) * sampleRate);
  const offline = new OfflineAudioContext(channels, Math.max(1, frames), sampleRate);
  const byName = new Map(activeLanes.map((lane) => [lane.name, lane]));

  for (const event of plan.events) {
    const lane = byName.get(event.lane);
    if (!lane?.buffer) continue;
    const source = offline.createBufferSource();
    source.buffer = lane.buffer;
    source.connect(offline.destination);
    source.start(event.timeSeconds);
  }

  return offline.startRendering();
}

export type PatternPlayback = {
  stop: () => void;
};

/**
 * Play an already rendered pattern buffer without re-decoding or re-scheduling
 * its hits. Callers may create/resume the context synchronously on the click and
 * pass it in after an async render, which avoids Safari/iOS autoplay rejection.
 */
export function playPatternBuffer(
  buffer: AudioBuffer,
  onEnded?: () => void,
  playbackContext?: AudioContext,
): PatternPlayback {
  const context = playbackContext ?? new AudioContext();
  const source = context.createBufferSource();
  source.buffer = buffer;
  source.connect(context.destination);
  let stopped = false;
  source.onended = () => {
    if (stopped) return;
    stopped = true;
    onEnded?.();
    void context.close();
  };
  source.start();

  return {
    stop() {
      if (stopped) return;
      stopped = true;
      try { source.stop(); } catch { /* source already stopped */ }
      void context.close();
    },
  };
}

/** Audition the exact in-memory lane sample used by the renderer. */
export function playPatternSample(buffer: AudioBuffer): PatternPlayback {
  return playPatternBuffer(buffer);
}
