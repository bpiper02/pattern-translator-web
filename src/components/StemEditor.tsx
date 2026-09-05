import { useMemo, useRef, useState } from "react";
import { Download, Pause, Play, Upload, Wand2 } from "lucide-react";
import { decodeAudio } from "../audio";
import { transformAudio } from "../audio/transformAudio";
import { audioBufferToWav } from "../audio/wav";
import { playRenderedPreview, type DrumPlayback } from "../audio/reconstructDrums";

type StemKind = "drums" | "bass" | "melody" | "other";

type StemState = {
  kind: StemKind;
  label: string;
  file: File | null;
  buffer: AudioBuffer | null;
  gain: number;
  muted: boolean;
  solo: boolean;
  semitoneOffset: number;
};

const INITIAL_STEMS: StemState[] = [
  { kind: "drums", label: "DRUMS", file: null, buffer: null, gain: 1, muted: false, solo: false, semitoneOffset: 0 },
  { kind: "bass", label: "BASS", file: null, buffer: null, gain: 1, muted: false, solo: false, semitoneOffset: 0 },
  { kind: "melody", label: "MELODY", file: null, buffer: null, gain: 1, muted: false, solo: false, semitoneOffset: 0 },
  { kind: "other", label: "OTHER", file: null, buffer: null, gain: 1, muted: false, solo: false, semitoneOffset: 0 },
];

function downloadBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 500);
}

async function renderMix(stems: StemState[], sourceBpm: number, targetBpm: number, globalPitchShift: number) {
  const populated = stems.filter((stem) => stem.buffer);
  if (!populated.length) throw new Error("Add at least one stem first");

  const anySolo = populated.some((stem) => stem.solo);
  const active = populated.filter((stem) => !stem.muted && (!anySolo || stem.solo));
  if (!active.length) throw new Error("No audible stems selected");

  const processed = await Promise.all(active.map(async (stem) => {
    const tonal = stem.kind !== "drums";
    const semitones = tonal ? globalPitchShift + stem.semitoneOffset : stem.semitoneOffset;
    const unchanged = Math.abs(sourceBpm - targetBpm) < 0.001 && semitones === 0;
    const buffer = unchanged
      ? stem.buffer!
      : await transformAudio({ input: stem.buffer!, sourceBpm, targetBpm, semitones });
    return { stem, buffer };
  }));

  const sampleRate = Math.max(...processed.map(({ buffer }) => buffer.sampleRate));
  const channels = Math.max(...processed.map(({ buffer }) => buffer.numberOfChannels));
  const duration = Math.max(...processed.map(({ buffer }) => buffer.duration));
  const frames = Math.max(1, Math.ceil(duration * sampleRate));
  const offline = new OfflineAudioContext(channels, frames, sampleRate);

  for (const { stem, buffer } of processed) {
    const source = offline.createBufferSource();
    const gain = offline.createGain();
    source.buffer = buffer;
    gain.gain.value = Math.max(0, Math.min(2, stem.gain));
    source.connect(gain);
    gain.connect(offline.destination);
    source.start(0);
  }

  return offline.startRendering();
}

export function StemEditor({ sourceBpm, targetBpm, globalPitchShift }: {
  sourceBpm: number;
  targetBpm: number;
  globalPitchShift: number;
}) {
  const [stems, setStems] = useState<StemState[]>(INITIAL_STEMS);
  const [mixBuffer, setMixBuffer] = useState<AudioBuffer | null>(null);
  const [busy, setBusy] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [message, setMessage] = useState("ADD SEPARATED STEMS TO EDIT THE BEAT");
  const playbackRef = useRef<DrumPlayback | null>(null);

  const loadedCount = useMemo(() => stems.filter((stem) => stem.buffer).length, [stems]);

  function updateStem(kind: StemKind, patch: Partial<StemState>) {
    playbackRef.current?.stop();
    playbackRef.current = null;
    setPlaying(false);
    setMixBuffer(null);
    setStems((current) => current.map((stem) => stem.kind === kind ? { ...stem, ...patch } : stem));
    setMessage("MIX CHANGED — BUILD PREVIEW AGAIN");
  }

  async function loadStem(kind: StemKind, file: File) {
    setBusy(true);
    setMessage(`LOADING ${kind.toUpperCase()}…`);
    try {
      const buffer = await decodeAudio(file);
      updateStem(kind, { file, buffer });
      setMessage(`${kind.toUpperCase()} READY — ${buffer.duration.toFixed(1)} SEC`);
    } catch (error) {
      console.error(error);
      setMessage(`ERROR — COULD NOT LOAD ${kind.toUpperCase()}`);
    } finally {
      setBusy(false);
    }
  }

  async function buildMix() {
    setBusy(true);
    setMessage("RENDERING EDITED MIX…");
    playbackRef.current?.stop();
    playbackRef.current = null;
    setPlaying(false);
    try {
      const rendered = await renderMix(stems, sourceBpm, targetBpm, globalPitchShift);
      setMixBuffer(rendered);
      setMessage(`EDITED MIX READY — ${rendered.duration.toFixed(1)} SEC`);
    } catch (error) {
      console.error(error);
      setMessage(`ERROR — ${error instanceof Error ? error.message.toUpperCase() : "MIX FAILED"}`);
    } finally {
      setBusy(false);
    }
  }

  function playMix() {
    if (!mixBuffer) return;
    if (playing) {
      playbackRef.current?.stop();
      playbackRef.current = null;
      setPlaying(false);
      return;
    }
    playbackRef.current = playRenderedPreview(mixBuffer, () => {
      playbackRef.current = null;
      setPlaying(false);
    });
    setPlaying(true);
  }

  function exportMix() {
    if (!mixBuffer) return;
    downloadBlob(audioBufferToWav(mixBuffer), `pattern-translator-edited-mix-${targetBpm}bpm.wav`);
  }

  return (
    <section className="module stemEditorModule">
      <div className="moduleTitle">05 // STEM EDITOR // MANUAL STEMS BETA</div>
      <div className="stemEditorIntro">
        Upload separated drum/bass/melody/other stems, edit each layer, preview the combined mix, then export one WAV. Automatic stem splitting is still the next backend step.
      </div>

      <div className="stemRows">
        {stems.map((stem) => (
          <div className="stemRow" key={stem.kind}>
            <div className="stemName">
              <b>{stem.label}</b>
              <span>{stem.file?.name ?? "NO STEM"}</span>
            </div>

            <label className="stemUploadButton">
              <Upload size={13} /> {stem.buffer ? "REPLACE" : "ADD"}
              <input
                type="file"
                accept="audio/*"
                hidden
                disabled={busy}
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file) void loadStem(stem.kind, file);
                  event.currentTarget.value = "";
                }}
              />
            </label>

            <label className="stemSlider">
              <span>LEVEL {Math.round(stem.gain * 100)}%</span>
              <input type="range" min="0" max="1.5" step="0.01" value={stem.gain} disabled={!stem.buffer} onChange={(event) => updateStem(stem.kind, { gain: +event.target.value })} />
            </label>

            {stem.kind !== "drums" ? (
              <label className="stemPitch">
                <span>EXTRA SHIFT</span>
                <select value={stem.semitoneOffset} disabled={!stem.buffer} onChange={(event) => updateStem(stem.kind, { semitoneOffset: +event.target.value })}>
                  {Array.from({ length: 25 }, (_, i) => i - 12).map((value) => <option key={value} value={value}>{value > 0 ? `+${value}` : value} st</option>)}
                </select>
              </label>
            ) : <div className="stemPitch passive"><span>PITCH</span><b>KEEP</b></div>}

            <button className={stem.muted ? "stemToggle active" : "stemToggle"} disabled={!stem.buffer} onClick={() => updateStem(stem.kind, { muted: !stem.muted })}>MUTE</button>
            <button className={stem.solo ? "stemToggle active" : "stemToggle"} disabled={!stem.buffer} onClick={() => updateStem(stem.kind, { solo: !stem.solo })}>SOLO</button>
          </div>
        ))}
      </div>

      <div className="stemEditorFooter">
        <div className="lcdStatus"><i className={busy ? "blink" : ""} /> {message}</div>
        <button className="processButton" disabled={!loadedCount || busy} onClick={() => void buildMix()}><Wand2 size={15} /> {busy ? "RENDERING…" : "BUILD MIX PREVIEW"}</button>
        <button className="abPlayButton rebuilt" disabled={!mixBuffer} onClick={playMix}>{playing ? <Pause size={14} /> : <Play size={14} />}{playing ? "STOP MIX" : "PLAY EDITED MIX"}</button>
        <button className="exportButton primaryExport" disabled={!mixBuffer} onClick={exportMix}><Download size={14} /> EXPORT EDITED WAV</button>
      </div>
    </section>
  );
}
