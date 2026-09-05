import { processOffline } from "@soundtouchjs/audio-worklet";
import processorUrl from "@soundtouchjs/audio-worklet/processor?url";

export type TransformAudioOptions = {
  input: AudioBuffer;
  sourceBpm: number;
  targetBpm: number;
  semitones?: number;
};

export async function transformAudio({
  input,
  sourceBpm,
  targetBpm,
  semitones = 0,
}: TransformAudioOptions): Promise<AudioBuffer> {
  if (!Number.isFinite(sourceBpm) || !Number.isFinite(targetBpm) || sourceBpm <= 0 || targetBpm <= 0) {
    throw new Error("BPM values must be greater than zero");
  }

  const playbackRate = targetBpm / sourceBpm;

  return processOffline({
    input,
    processorUrl,
    pitchSemitones: semitones,
    playbackRate,
    stretchParameters: {
      overlapMs: 12,
      quickSeek: false,
    },
  });
}
