import type { DrumHit } from "../audio";

export type DrumSlice = {
  id: string;
  beat: number;
  velocity: number;
  buffer: AudioBuffer;
};

export type DrumPlayback = { stop: () => void };

const PRE_ROLL = 0.004;
const MAX_TAIL = 0.65;

function copySlice(source: AudioBuffer, startSeconds: number, endSeconds: number) {
  const sr = source.sampleRate;
  const start = Math.max(0, Math.floor(startSeconds * sr));
  const end = Math.min(source.length, Math.ceil(endSeconds * sr));
  const length = Math.max(1, end - start);
  const out = new AudioBuffer({ length, numberOfChannels: source.numberOfChannels, sampleRate: sr });

  for (let ch = 0; ch < source.numberOfChannels; ch++) {
    const src = source.getChannelData(ch).subarray(start, end);
    out.getChannelData(ch).set(src);
  }

  return out;
}

export function extractDrumSlices(source: AudioBuffer, hits: DrumHit[]): DrumSlice[] {
  const ordered = [...hits].sort((a, b) => a.time - b.time);

  return ordered.map((hit, index) => {
    const next = ordered[index + 1];
    const start = Math.max(0, hit.time - PRE_ROLL);
    const nextBoundary = next ? Math.max(start + 0.012, next.time - PRE_ROLL) : hit.time + MAX_TAIL;
    const end = Math.min(source.duration, nextBoundary, hit.time + MAX_TAIL);

    return {
      id: hit.id,
      beat: hit.beat,
      velocity: hit.velocity,
      buffer: copySlice(source, start, end),
    };
  });
}

export function playDrumRebuild(slices: DrumSlice[], bpm: number): DrumPlayback {
  const context = new AudioContext();
  const sources: AudioBufferSourceNode[] = [];
  const origin = context.currentTime + 0.06;
  const secondsPerBeat = 60 / bpm;

  for (const slice of slices) {
    const source = context.createBufferSource();
    source.buffer = slice.buffer;
    source.connect(context.destination);
    source.start(origin + Math.max(0, slice.beat) * secondsPerBeat);
    sources.push(source);
  }

  return {
    stop() {
      for (const source of sources) {
        try { source.stop(); } catch { /* already stopped */ }
      }
      void context.close();
    },
  };
}
