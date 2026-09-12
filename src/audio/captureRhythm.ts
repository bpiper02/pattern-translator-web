import { rhythmCaptureDurationSeconds } from "../analysis/rhythmCapture";

export type RhythmCapturePhase =
  | { phase: "count-in"; beat: number }
  | { phase: "recording" }
  | { phase: "processing" };

export type RecordRhythmBarOptions = {
  bpm: number;
  beatsPerBar?: number;
  signal?: AbortSignal;
  onPhase?: (phase: RhythmCapturePhase) => void;
};

function abortError() {
  return new DOMException("Rhythm capture cancelled", "AbortError");
}

function sleep(milliseconds: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError());
      return;
    }
    const onAbort = () => {
      window.clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
      reject(abortError());
    };
    const timeout = window.setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export async function recordOneBarRhythm(options: RecordRhythmBarOptions): Promise<Blob> {
  const beatsPerBar = Math.max(1, Math.floor(options.beatsPerBar ?? 4));
  if (!Number.isFinite(options.bpm) || options.bpm <= 0) throw new Error("BPM must be greater than zero");
  if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
    throw new Error("Voice input is not available in this browser");
  }

  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
      channelCount: 1,
    },
  });

  try {
    const quarterMs = 60_000 / options.bpm;
    for (let remaining = beatsPerBar; remaining >= 1; remaining--) {
      if (options.signal?.aborted) throw abortError();
      options.onPhase?.({ phase: "count-in", beat: remaining });
      await sleep(quarterMs, options.signal);
    }

    if (options.signal?.aborted) throw abortError();
    const recorder = new MediaRecorder(stream);
    const chunks: BlobPart[] = [];
    let aborted = false;

    const result = new Promise<Blob>((resolve, reject) => {
      const onAbort = () => {
        aborted = true;
        if (recorder.state !== "inactive") recorder.stop();
        else reject(abortError());
      };
      options.signal?.addEventListener("abort", onAbort, { once: true });
      recorder.ondataavailable = (event) => {
        if (event.data.size) chunks.push(event.data);
      };
      recorder.onerror = () => {
        options.signal?.removeEventListener("abort", onAbort);
        reject(new Error("Microphone recording failed"));
      };
      recorder.onstop = () => {
        options.signal?.removeEventListener("abort", onAbort);
        if (aborted) {
          reject(abortError());
          return;
        }
        options.onPhase?.({ phase: "processing" });
        resolve(new Blob(chunks, { type: recorder.mimeType || "audio/webm" }));
      };
    });

    recorder.start();
    options.onPhase?.({ phase: "recording" });
    const barMs = rhythmCaptureDurationSeconds(options.bpm, beatsPerBar) * 1000;
    try {
      await sleep(barMs, options.signal);
    } catch (error) {
      if (recorder.state !== "inactive") recorder.stop();
      try { await result; } catch { /* expected when aborted */ }
      throw error;
    }
    if (recorder.state !== "inactive") recorder.stop();
    return await result;
  } finally {
    stream.getTracks().forEach((track) => track.stop());
  }
}
