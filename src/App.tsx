import { useEffect, useRef, useState } from "react";
import {
  Download,
  Drum,
  Music2,
  Pause,
  Play,
  RotateCcw,
  SlidersHorizontal,
  Upload,
  Wand2,
} from "lucide-react";
import { decodeAudio, monoSamples } from "./audio";
import { audioBufferToWav } from "./audio/wav";
import { analyzeRhythm, type RhythmAnalysis } from "./analysis/rhythm";
import { transformAudio } from "./audio/transformAudio";
import { playRenderedPreview, type DrumPlayback } from "./audio/reconstructDrums";
import { StemEditor } from "./components/StemEditor";

type Workspace = "translate" | "edit";
type Mode = "beat" | "drums" | "bass" | "melody";

const ROOTS = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
const SEMITONES = Array.from({ length: 25 }, (_, index) => index - 12);

function downloadBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 500);
}

function semitoneDistance(source: string, target: string) {
  let diff = ROOTS.indexOf(target) - ROOTS.indexOf(source);
  if (diff > 6) diff -= 12;
  if (diff < -6) diff += 12;
  return diff;
}

function VintageProgress({ label }: { label: string }) {
  return (
    <div className="vintageProgress" role="status" aria-live="polite">
      <span>{label}</span>
      <div className="progressTrack"><div className="progressBlocks" /></div>
    </div>
  );
}

function Waveform({ samples, currentRatio }: { samples: Float32Array | null; currentRatio: number }) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas || !samples) return;

    const dpr = Math.max(1, window.devicePixelRatio || 1);
    const rect = canvas.getBoundingClientRect();
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, rect.width, rect.height);

    const mid = rect.height / 2;
    const step = Math.ceil(samples.length / Math.max(1, rect.width));
    ctx.strokeStyle = "#b8c6b1";
    ctx.lineWidth = 1;
    ctx.beginPath();

    for (let x = 0; x < rect.width; x++) {
      let min = 1;
      let max = -1;
      const start = x * step;
      const end = Math.min(samples.length, start + step);
      for (let i = start; i < end; i++) {
        const value = samples[i];
        if (value < min) min = value;
        if (value > max) max = value;
      }
      ctx.moveTo(x, mid + min * mid * 0.82);
      ctx.lineTo(x, mid + max * mid * 0.82);
    }

    ctx.stroke();

    if (currentRatio > 0) {
      ctx.strokeStyle = "#ffb000";
      ctx.lineWidth = 2;
      const x = rect.width * currentRatio;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, rect.height);
      ctx.stroke();
    }
  }, [samples, currentRatio]);

  return <canvas ref={ref} className="wave" />;
}

export function App() {
  const [workspace, setWorkspace] = useState<Workspace>("translate");
  const [mode, setMode] = useState<Mode>("beat");
  const [file, setFile] = useState<File | null>(null);
  const [buffer, setBuffer] = useState<AudioBuffer | null>(null);
  const [samples, setSamples] = useState<Float32Array | null>(null);
  const [rhythm, setRhythm] = useState<RhythmAnalysis | null>(null);
  const [sourceBpm, setSourceBpm] = useState(120);
  const [targetBpm, setTargetBpm] = useState(120);
  const [sourceRoot, setSourceRoot] = useState("C");
  const [targetRoot, setTargetRoot] = useState("C");
  const [drumPitchShift, setDrumPitchShift] = useState(0);
  const [translatedBuffer, setTranslatedBuffer] = useState<AudioBuffer | null>(null);
  const [busy, setBusy] = useState(false);
  const [drag, setDrag] = useState(false);
  const [playingOriginal, setPlayingOriginal] = useState(false);
  const [playingTranslated, setPlayingTranslated] = useState(false);
  const [ratio, setRatio] = useState(0);
  const [message, setMessage] = useState("READY — DROP A BEAT OR STEM");

  const inputRef = useRef<HTMLInputElement | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const audioUrlRef = useRef<string | null>(null);
  const translatedPlaybackRef = useRef<DrumPlayback | null>(null);

  const tonalMode = mode !== "drums";
  const pitchShift = tonalMode ? semitoneDistance(sourceRoot, targetRoot) : drumPitchShift;

  function stopPlayback() {
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.currentTime = 0;
      audioRef.current = null;
    }
    if (audioUrlRef.current) {
      URL.revokeObjectURL(audioUrlRef.current);
      audioUrlRef.current = null;
    }
    translatedPlaybackRef.current?.stop();
    translatedPlaybackRef.current = null;
    setPlayingOriginal(false);
    setPlayingTranslated(false);
    setRatio(0);
  }

  function invalidateTranslation(nextMessage = "TARGET CHANGED — TRANSLATE AGAIN") {
    translatedPlaybackRef.current?.stop();
    translatedPlaybackRef.current = null;
    setPlayingTranslated(false);
    setTranslatedBuffer(null);
    setMessage(nextMessage);
  }

  async function ingest(nextFile: File) {
    stopPlayback();
    setTranslatedBuffer(null);
    setBusy(true);
    setMessage("DECODING + DETECTING BPM…");
    try {
      const decoded = await decodeAudio(nextFile);
      const mono = monoSamples(decoded);
      const rhythmResult = analyzeRhythm(mono, decoded.sampleRate);
      const detectedBpm = Math.round(rhythmResult.bpm * 10) / 10;
      setFile(nextFile);
      setBuffer(decoded);
      setSamples(mono);
      setRhythm(rhythmResult);
      setSourceBpm(detectedBpm);
      setTargetBpm(detectedBpm);
      setMessage(`READY — ${detectedBpm} BPM DETECTED`);
    } catch (error) {
      console.error(error);
      setMessage("ERROR — COULD NOT READ AUDIO");
    } finally {
      setBusy(false);
    }
  }

  async function translate() {
    if (!buffer) return;
    stopPlayback();
    setBusy(true);
    setMessage("TRANSFORMING ORIGINAL AUDIO…");
    try {
      const bpmUnchanged = Math.abs(targetBpm - sourceBpm) < 0.001;
      const pitchUnchanged = pitchShift === 0;
      if (bpmUnchanged && pitchUnchanged) {
        setTranslatedBuffer(buffer);
        setMessage("TRANSLATED READY — SOURCE SETTINGS UNCHANGED");
        return;
      }
      const transformed = await transformAudio({ input: buffer, sourceBpm, targetBpm, semitones: pitchShift });
      setTranslatedBuffer(transformed);
      const pitchText = pitchShift === 0 ? "PITCH UNCHANGED" : `${pitchShift > 0 ? "+" : ""}${pitchShift} SEMITONES`;
      setMessage(`TRANSLATED READY — ${targetBpm} BPM // ${pitchText}`);
    } catch (error) {
      console.error(error);
      setMessage(`ERROR — ${error instanceof Error ? error.message.toUpperCase() : "TRANSLATION FAILED"}`);
    } finally {
      setBusy(false);
    }
  }

  function playOriginal() {
    if (!file) return;
    translatedPlaybackRef.current?.stop();
    translatedPlaybackRef.current = null;
    setPlayingTranslated(false);
    if (!audioRef.current) {
      const url = URL.createObjectURL(file);
      audioUrlRef.current = url;
      audioRef.current = new Audio(url);
      audioRef.current.ontimeupdate = () => {
        const audio = audioRef.current;
        if (audio) setRatio(audio.duration ? audio.currentTime / audio.duration : 0);
      };
      audioRef.current.onended = () => {
        setPlayingOriginal(false);
        setRatio(0);
      };
    }
    if (playingOriginal) {
      audioRef.current.pause();
      setPlayingOriginal(false);
    } else {
      void audioRef.current.play();
      setPlayingOriginal(true);
    }
  }

  function playTranslated() {
    if (!translatedBuffer) return;
    if (audioRef.current) {
      audioRef.current.pause();
      setPlayingOriginal(false);
    }
    if (playingTranslated) {
      translatedPlaybackRef.current?.stop();
      translatedPlaybackRef.current = null;
      setPlayingTranslated(false);
      return;
    }
    translatedPlaybackRef.current?.stop();
    translatedPlaybackRef.current = playRenderedPreview(translatedBuffer, () => {
      setPlayingTranslated(false);
      translatedPlaybackRef.current = null;
    });
    setPlayingTranslated(true);
  }

  function exportTranslated() {
    if (!translatedBuffer) return;
    const pitchPart = tonalMode ? `-${targetRoot.replace("#", "sharp")}` : `-${drumPitchShift >= 0 ? "+" : ""}${drumPitchShift}st`;
    downloadBlob(audioBufferToWav(translatedBuffer), `pattern-translator-${targetBpm}bpm${pitchPart}.wav`);
  }

  function replaceFile() {
    stopPlayback();
    setFile(null);
    setBuffer(null);
    setSamples(null);
    setRhythm(null);
    setTranslatedBuffer(null);
    setMessage("READY — DROP A BEAT OR STEM");
  }

  function switchMode(next: Mode) {
    stopPlayback();
    setMode(next);
    setTranslatedBuffer(null);
    setMessage(file ? `READY — TRANSLATE ${next.toUpperCase()} AUDIO` : "READY — DROP A BEAT OR STEM");
  }

  function switchWorkspace(next: Workspace) {
    if (next === workspace) return;
    stopPlayback();
    setWorkspace(next);
  }

  return (
    <main className="machineShell">
      <header className="machineHeader">
        <div>
          <div className="brandLine"><span>PT</span> PATTERN TRANSLATOR</div>
          <div className="versionLine">DIRECT AUDIO WORKSTATION // BUILD 0.6</div>
        </div>
        <div className="statusTag">LOCAL DSP</div>
      </header>

      <nav className="workspaceTabs" aria-label="Workspace">
        <button className={workspace === "translate" ? "active" : ""} onClick={() => switchWorkspace("translate")}>TRANSLATE</button>
        <button className={workspace === "edit" ? "active" : ""} onClick={() => switchWorkspace("edit")}>EDIT</button>
      </nav>

      {workspace === "edit" ? (
        <StemEditor />
      ) : (
        <>
          <section className="module modeModule">
            <div className="moduleTitle">01 // TRANSLATE MODE</div>
            <div className="modeButtons">
              <button className={mode === "beat" ? "active" : ""} onClick={() => switchMode("beat")}><SlidersHorizontal size={16} /> FULL BEAT</button>
              <button className={mode === "drums" ? "active" : ""} onClick={() => switchMode("drums")}><Drum size={16} /> DRUMS</button>
              <button className={mode === "bass" ? "active" : ""} onClick={() => switchMode("bass")}><Music2 size={16} /> BASS</button>
              <button className={mode === "melody" ? "active" : ""} onClick={() => switchMode("melody")}><Music2 size={16} /> MELODY</button>
            </div>
          </section>

          <section className="module sourceModule">
            <div className="moduleTitle">02 // SOURCE AUDIO</div>
            {!file ? (
              <div className={`dropZone ${drag ? "drag" : ""}`} onDragOver={(event) => { event.preventDefault(); setDrag(true); }} onDragLeave={() => setDrag(false)} onDrop={(event) => { event.preventDefault(); setDrag(false); const next = event.dataTransfer.files[0]; if (next) void ingest(next); }} onClick={() => inputRef.current?.click()}>
                <input ref={inputRef} type="file" accept="audio/*" hidden onChange={(event) => { const next = event.target.files?.[0]; if (next) void ingest(next); }} />
                <Upload size={22} />
                <b>DROP {mode === "beat" ? "FULL BEAT" : mode.toUpperCase()}</b>
                <span>WAV / MP3 / M4A — AUDIO STAYS LOCAL</span>
              </div>
            ) : (
              <>
                <div className="abDeck">
                  <div className="abChannel originalChannel">
                    <span className="abLabel">A // ORIGINAL SOURCE</span>
                    <button className="abPlayButton" onClick={playOriginal}>{playingOriginal ? <Pause size={15} /> : <Play size={15} />}{playingOriginal ? "PAUSE ORIGINAL" : "PLAY ORIGINAL"}</button>
                  </div>
                  <div className="fileReadout"><b>{file.name}</b><span>{buffer?.duration.toFixed(1)} SEC // {buffer?.sampleRate.toLocaleString()} HZ // {rhythm?.beats.length ?? 0} BEATS</span></div>
                  <div className="abChannel rebuiltChannel">
                    <span className="abLabel">B // TRANSLATED WAV</span>
                    <button className="abPlayButton rebuilt" onClick={playTranslated} disabled={!translatedBuffer}>{playingTranslated ? <Pause size={15} /> : <Play size={15} />}{playingTranslated ? "STOP TRANSLATED" : "PLAY TRANSLATED"}</button>
                  </div>
                  <button className="utilityButton" onClick={replaceFile}><RotateCcw size={14} /> EJECT</button>
                </div>
                <Waveform samples={samples} currentRatio={ratio} />
              </>
            )}
          </section>

          <section className="module translateModule">
            <div className="moduleTitle">03 // SET TARGET</div>
            <div className="translateGrid">
              <label className="digitalControl">
                <span>SOURCE BPM</span>
                <input type="number" min="20" max="300" step="0.1" value={sourceBpm} onChange={(event) => { setSourceBpm(+event.target.value); invalidateTranslation("SOURCE BPM CHANGED — TRANSLATE AGAIN"); }} />
              </label>
              <div className="flowArrow">▶</div>
              <label className="digitalControl targetControl">
                <span>TARGET BPM</span>
                <input type="number" min="20" max="300" step="0.1" value={targetBpm} onChange={(event) => { setTargetBpm(+event.target.value); invalidateTranslation(); }} />
              </label>

              {tonalMode ? (
                <>
                  <label className="keyControl">
                    <span>SOURCE KEY</span>
                    <select value={sourceRoot} onChange={(event) => { setSourceRoot(event.target.value); invalidateTranslation("SOURCE KEY CHANGED — TRANSLATE AGAIN"); }}>{ROOTS.map((root) => <option key={root}>{root}</option>)}</select>
                  </label>
                  <div className="flowArrow">▶</div>
                  <label className="keyControl targetControl">
                    <span>TARGET KEY</span>
                    <select value={targetRoot} onChange={(event) => { setTargetRoot(event.target.value); invalidateTranslation(); }}>{ROOTS.map((root) => <option key={root}>{root}</option>)}</select>
                  </label>
                </>
              ) : (
                <>
                  <div className="keyControl passiveControl"><span>SOURCE PITCH</span><b>ORIGINAL</b></div>
                  <div className="flowArrow">▶</div>
                  <label className="keyControl targetControl">
                    <span>DRUM PITCH SHIFT</span>
                    <select value={drumPitchShift} onChange={(event) => { setDrumPitchShift(+event.target.value); invalidateTranslation(); }}>{SEMITONES.map((value) => <option key={value} value={value}>{value > 0 ? `+${value}` : value} semitones</option>)}</select>
                  </label>
                </>
              )}
            </div>

            <div className="actionRail">
              {busy ? <VintageProgress label={message} /> : <div className="lcdStatus">{message}</div>}
              <button className="processButton" disabled={!file || busy} onClick={() => void translate()}><Wand2 size={17} /> {busy ? "PROCESSING…" : "TRANSLATE AUDIO"}</button>
            </div>

            {mode === "beat" && <div className="midiWarning">FULL BEAT MODE transforms the whole mix. For cleaner key changes that leave drums untouched, use separated stems in the EDIT workspace.</div>}
          </section>

          <section className="module patternModule">
            <div className="moduleTitle">04 // RESULT</div>
            <div className="resultPanel">
              <div>
                <b>{translatedBuffer ? "TRANSLATED WAV READY" : "NO TRANSLATED WAV YET"}</b>
                <span>{translatedBuffer ? `${translatedBuffer.duration.toFixed(1)} SEC // ${targetBpm} BPM // ${tonalMode ? targetRoot : `${drumPitchShift >= 0 ? "+" : ""}${drumPitchShift} ST`}` : "SET TARGETS, THEN PRESS TRANSLATE AUDIO"}</span>
              </div>
              <button className="exportButton primaryExport" disabled={!translatedBuffer} onClick={exportTranslated}><Download size={15} /> EXPORT TRANSLATED WAV</button>
            </div>
          </section>
        </>
      )}

      <footer className="machineFooter">
        <span><SlidersHorizontal size={12} /> DIRECT AUDIO WORKSTATION</span>
        <span>{workspace === "translate" ? "TRANSLATE BPM / PITCH / KEY" : "EDIT STEMS / PREVIEW / EXPORT WAV"}</span>
      </footer>
    </main>
  );
}
