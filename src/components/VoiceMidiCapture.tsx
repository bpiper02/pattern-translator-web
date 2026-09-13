import { useEffect, useRef, useState } from "react";
import { Download, Mic, Play, RotateCcw, Square } from "lucide-react";
import { monoSamples } from "../audio";
import { detectVoiceMelody, type VoiceMelodyNote } from "../analysis/voiceMelody";
import { recordOneBarRhythm as recordOneBarVoice, type RhythmCapturePhase } from "../audio/captureRhythm";
import { melodyMidi } from "../midi";

type VoiceMidiCaptureProps = {
  bpm: number;
};

type CaptureState = "idle" | "count-in" | "recording" | "processing" | "ready" | "error";

const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

function pitchName(midi: number) {
  const rounded = Math.max(0, Math.min(127, Math.round(midi)));
  return `${NOTE_NAMES[rounded % 12]}${Math.floor(rounded / 12) - 1}`;
}

function midiToHz(midi: number) {
  return 440 * 2 ** ((midi - 69) / 12);
}

function downloadBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 500);
}

async function decodeCapture(blob: Blob) {
  const context = new AudioContext();
  try {
    const bytes = await blob.arrayBuffer();
    return await context.decodeAudioData(bytes.slice(0));
  } finally {
    await context.close();
  }
}

function signalLevel(samples: Float32Array) {
  if (!samples.length) return { rms: 0, peak: 0 };
  let energy = 0;
  let peak = 0;
  for (const sample of samples) {
    energy += sample * sample;
    peak = Math.max(peak, Math.abs(sample));
  }
  return { rms: Math.sqrt(energy / samples.length), peak };
}

function phaseMessage(phase: RhythmCapturePhase) {
  if (phase.phase === "count-in") return `COUNT IN — ${phase.beat}`;
  if (phase.phase === "recording") return "RECORDING ONE BAR — HUM / SING NOW";
  return "ANALYZING PITCH + NOTE TIMING…";
}

function throwIfAborted(signal: AbortSignal) {
  if (signal.aborted) throw new DOMException("Voice capture cancelled", "AbortError");
}

export function VoiceMidiCapture({ bpm }: VoiceMidiCaptureProps) {
  const [state, setState] = useState<CaptureState>("idle");
  const [message, setMessage] = useState("READY — ONE-BAR VOICE CAPTURE");
  const [notes, setNotes] = useState<VoiceMelodyNote[]>([]);
  const [capturedBpm, setCapturedBpm] = useState(bpm);
  const [previewing, setPreviewing] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const previewContextRef = useRef<AudioContext | null>(null);
  const previewTimerRef = useRef<number | null>(null);

  function stopPreview() {
    if (previewTimerRef.current != null) {
      window.clearTimeout(previewTimerRef.current);
      previewTimerRef.current = null;
    }
    const context = previewContextRef.current;
    previewContextRef.current = null;
    if (context && context.state !== "closed") void context.close();
    setPreviewing(false);
  }

  useEffect(() => () => {
    abortRef.current?.abort();
    if (previewTimerRef.current != null) window.clearTimeout(previewTimerRef.current);
    const context = previewContextRef.current;
    if (context && context.state !== "closed") void context.close();
  }, []);

  const active = state === "count-in" || state === "recording" || state === "processing";

  function handlePhase(phase: RhythmCapturePhase) {
    setMessage(phaseMessage(phase));
    if (phase.phase === "count-in") setState("count-in");
    if (phase.phase === "recording") setState("recording");
    if (phase.phase === "processing") setState("processing");
  }

  async function startCapture() {
    if (active) return;
    stopPreview();
    const captureBpm = Number.isFinite(bpm) && bpm > 0 ? bpm : 120;
    const controller = new AbortController();
    abortRef.current = controller;
    setNotes([]);
    setCapturedBpm(captureBpm);
    setState("count-in");
    setMessage("REQUESTING MICROPHONE…");

    try {
      const recording = await recordOneBarVoice({
        bpm: captureBpm,
        beatsPerBar: 4,
        signal: controller.signal,
        onPhase: handlePhase,
      });
      throwIfAborted(controller.signal);

      setState("processing");
      setMessage("DECODING VOICE CAPTURE…");
      const decoded = await decodeCapture(recording);
      throwIfAborted(controller.signal);
      const mono = monoSamples(decoded);
      const level = signalLevel(mono);

      // Fail early instead of asking Melodia to invent pitch from room noise.
      if (level.peak < 0.02 || level.rms < 0.003) {
        throw new Error("INPUT TOO QUIET — SING CLOSER TO THE MIC AND RETAKE");
      }

      setMessage("ANALYZING PITCH + NOTE TIMING…");
      const detected = detectVoiceMelody(mono, decoded.sampleRate, {
        bpm: captureBpm,
        quantizeStepBeats: 0.25,
      });
      throwIfAborted(controller.signal);

      if (!detected.length) {
        throw new Error('NO STABLE PITCH — HUM OR SING "AH", ONE NOTE AT A TIME');
      }

      setNotes(detected);
      setState("ready");
      setMessage(`MIDI READY — ${detected.length} NOTE${detected.length === 1 ? "" : "S"} DETECTED`);
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        setState("idle");
        setMessage("CAPTURE CANCELLED — READY");
        return;
      }
      console.error(error);
      setState("error");
      setMessage(error instanceof Error ? error.message.toUpperCase() : "VOICE CAPTURE FAILED");
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
    }
  }

  function cancelCapture() {
    abortRef.current?.abort();
  }

  function resetCapture() {
    abortRef.current?.abort();
    abortRef.current = null;
    stopPreview();
    setNotes([]);
    setState("idle");
    setMessage("READY — ONE-BAR VOICE CAPTURE");
  }

  function previewMidi() {
    if (!notes.length) return;
    if (previewing) {
      stopPreview();
      return;
    }

    const context = new AudioContext();
    previewContextRef.current = context;
    const master = context.createGain();
    master.gain.setValueAtTime(0.16, context.currentTime);
    master.connect(context.destination);
    const beatSeconds = 60 / capturedBpm;
    const startAt = context.currentTime + 0.04;
    let previewEnd = 0;

    for (const note of notes) {
      const noteStart = Math.max(0, note.beat) * beatSeconds;
      const noteDuration = Math.max(0.04, note.durationBeats * beatSeconds);
      const oscillator = context.createOscillator();
      const envelope = context.createGain();
      oscillator.type = "triangle";
      oscillator.frequency.setValueAtTime(midiToHz(note.midi), startAt + noteStart);
      envelope.gain.setValueAtTime(0.0001, startAt + noteStart);
      envelope.gain.exponentialRampToValueAtTime(0.85, startAt + noteStart + 0.012);
      envelope.gain.setValueAtTime(0.85, startAt + noteStart + Math.max(0.013, noteDuration - 0.025));
      envelope.gain.exponentialRampToValueAtTime(0.0001, startAt + noteStart + noteDuration);
      oscillator.connect(envelope);
      envelope.connect(master);
      oscillator.start(startAt + noteStart);
      oscillator.stop(startAt + noteStart + noteDuration + 0.01);
      previewEnd = Math.max(previewEnd, noteStart + noteDuration);
    }

    setPreviewing(true);
    previewTimerRef.current = window.setTimeout(() => {
      previewTimerRef.current = null;
      const activeContext = previewContextRef.current;
      previewContextRef.current = null;
      if (activeContext && activeContext.state !== "closed") void activeContext.close();
      setPreviewing(false);
    }, Math.ceil((previewEnd + 0.12) * 1000));
  }

  function exportMidi() {
    if (!notes.length) return;
    downloadBlob(melodyMidi(notes, capturedBpm), `pattern-translator-voice-${Math.round(capturedBpm)}bpm.mid`);
  }

  const pitchSequence = notes.map((note) => pitchName(note.midi)).join(" · ");

  return (
    <section className="module patternModule">
      <div className="moduleTitle">01B // VOICE → MIDI</div>
      <div className="midiWarning">ONE BAR • HUM / SING “AH” • ONE NOTE AT A TIME • NO CHORDS OR BACKING TRACK</div>
      <div className="actionRail">
        <div className="lcdStatus" role="status" aria-live="polite">{message}</div>
        {active ? (
          <button className="processButton" onClick={cancelCapture}><Square size={16} /> CANCEL CAPTURE</button>
        ) : (
          <button className="processButton" onClick={() => void startCapture()}><Mic size={17} /> {notes.length ? "RETAKE VOICE" : "START VOICE CAPTURE"}</button>
        )}
      </div>
      <div className="resultPanel">
        <div>
          <b>{notes.length ? `${notes.length} MIDI NOTE${notes.length === 1 ? "" : "S"} READY` : "NO VOICE MIDI YET"}</b>
          <span>{notes.length ? `${Math.round(capturedBpm)} BPM // ${pitchSequence}` : "4-BEAT COUNT-IN → RECORD ONE BAR → LOCAL PITCH ANALYSIS"}</span>
        </div>
        <button className="utilityButton" disabled={!notes.length || active} onClick={previewMidi}>{previewing ? <Square size={14} /> : <Play size={14} />} {previewing ? "STOP MIDI" : "PLAY DETECTED"}</button>
        <button className="exportButton primaryExport" disabled={!notes.length || active} onClick={exportMidi}><Download size={15} /> EXPORT MIDI</button>
        {(notes.length > 0 || state === "error") && <button className="utilityButton" onClick={resetCapture}><RotateCcw size={14} /> RESET</button>}
      </div>
    </section>
  );
}
