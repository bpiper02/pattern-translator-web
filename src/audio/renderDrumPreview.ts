import type { DrumSlice } from "./reconstructDrums";

export async function renderDrumPreview(
  slices: DrumSlice[],
  bpm: number,
  sampleRate = 44100,
): Promise<AudioBuffer> {
  if (!slices.length) {
    return new AudioBuffer({ length: 1, numberOfChannels: 2, sampleRate });
  }

  const secondsPerBeat = 60 / bpm;
  const channels = Math.max(1, ...slices.map((slice) => slice.buffer.numberOfChannels));
  const duration = Math.max(
    0.25,
    ...slices.map((slice) => Math.max(0, slice.beat) * secondsPerBeat + slice.buffer.duration + 0.08),
  );
  const frames = Math.ceil(duration * sampleRate);
  const offline = new OfflineAudioContext(channels, frames, sampleRate);

  for (const slice of slices) {
    const source = offline.createBufferSource();
    source.buffer = slice.buffer;
    source.connect(offline.destination);
    source.start(Math.max(0, slice.beat) * secondsPerBeat);
  }

  return offline.startRendering();
}

export type PreviewPlayback = {
  stop: () => void;
};

export function playPreviewBuffer(buffer: AudioBuffer, onEnded?: () => void): PreviewPlayback {
  const context = new AudioContext();
  const source = context.createBufferSource();
  source.buffer = buffer;
  source.connect(context.destination);
  source.onended = () => {
    onEnded?.();
    void context.close();
  };
  source.start();

  return {
    stop() {
      try { source.stop(); } catch { /* already stopped */ }
      void context.close();
    },
  };
}
