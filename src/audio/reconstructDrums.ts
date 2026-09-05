import type { DrumHit } from "../audio";

export type DrumSlice = {
  id: string;
  beat: number;
  velocity: number;
  buffer: AudioBuffer;
};

export type DrumPlayback = { stop: () => void };

const PRE_ROLL = 0.004;
const MIN_SLICE = 0.05;
const MAX_SLICE = 0.24;
const FADE_OUT = 0.012;

function copySlice(source: AudioBuffer, startSeconds: number, endSeconds: number) {
  const sr = source.sampleRate;
  const start = Math.max(0, Math.floor(startSeconds * sr));
  const end = Math.min(source.length, Math.ceil(endSeconds * sr));
  const length = Math.max(1, end - start);
  const out = new AudioBuffer({ length, numberOfChannels: source.numberOfChannels, sampleRate: sr });

  for (let ch = 0; ch < source.numberOfChannels; ch++) {
    const src = source.getChannelData(ch).subarray(start, end);
    const dst = out.getChannelData(ch);
    dst.set(src);

    const fadeSamples = Math.min(Math.floor(FADE_OUT * sr), dst.length);
    for (let i = 0; i < fadeSamples; i++) {
      const idx = dst.length - fadeSamples + i;
      dst[idx] *= 1 - i / Math.max(1, fadeSamples - 1);
    }
  }

  return out;
}

export function extractDrumSlices(source: AudioBuffer, hits: DrumHit[]): DrumSlice[] {
  const ordered = [...hits].sort((a, b) => a.time - b.time);

  return ordered.map((hit, index) => {
    const next = ordered[index + 1];
    const start = Math.max(0, hit.time - PRE_ROLL);
    const gap = next ? next.time - hit.time : MAX_SLICE;
    const duration = Math.min(MAX_SLICE, Math.max(MIN_SLICE, gap * 0.82));
    const end = Math.min(source.duration, hit.time + duration);

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
    const gain = context.createGain();
    source.buffer = slice.buffer;
    gain.gain.value = Math.max(0.25, Math.min(1, slice.velocity / 127));
    source.connect(gain);
    gain.connect(context.destination);
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
