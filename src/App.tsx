import { useEffect, useMemo, useRef, useState } from "react";
import {
  Download,
  Drum,
  Music2,
  Pause,
  Play,
  RotateCcw,
  Scissors,
  SlidersHorizontal,
  Upload,
  Wand2,
} from "lucide-react";
import {
  decodeAudio,
  monoSamples,
  detectBass,
  transposeNotes,
  midiNoteName,
  type DrumHit,
  type BassNote,
} from "./audio";
import { drumsMidi, bassMidi } from "./midi";
import { audioBufferToWav } from "./audio/wav";
import { analyzeRhythm, secondsToBeatPosition, type RhythmAnalysis } from "./analysis/rhythm";
import { detectDrumOnsets } from "./analysis/drumOnsets";
import {
  extractDrumSlices,
  renderDrumPreview,
  playRenderedPreview,
  type DrumPlayback,
  type DrumSlice,
} from "./audio/reconstructDrums";

type Mode = "drums" | "bass";
const ROOTS = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
const AUTO_DRUM_LANES = 4;

function downloadBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 500);
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
    const ctx = canvas.getContext("2d")!;
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

function DrumPattern({ hits }: { hits: DrumHit[] }) {
  const windowBeats = 16;
  return (
    <div className="patternPanel">
      <div className="ruler"><span />{[1, 2, 3, 4].map((bar) => <b key={bar}>BAR {bar}</b>)}</div>
      {Array.from({ length: AUTO_DRUM_LANES }, (_, lane) => {
        const laneHits = hits.filter((hit) => hit.lane === lane && hit.beat >= 0 && hit.beat < windowBeats);
        return (
          <div className="patternLane" key={lane}>
            <span className="laneName">{String.fromCharCode(65 + lane)}</span>
            <div className="laneTrack">
              <i className="barLine b1" /><i className="barLine b2" /><i className="barLine b3" />
              {laneHits.map((hit) => (
                <button key={hit.id} className="eventLamp" style={{ left: `${Math.max(0, Math.min(99.2, (hit.beat / windowBeats) * 100))}%` }} title={`Beat ${hit.beat.toFixed(3)} · velocity ${hit.velocity}`} />
              ))}
            </div>
          </div>
        );
      })}
      <div className="patternHint">First 4 bars · lane letters are non-semantic until drum substem separation lands</div>
    </div>
  );
}

export function App() {
  const [mode, setMode] = useState<Mode>("drums");
  const [file, setFile] = useState<File | null>(null);
  const [buffer, setBuffer] = useState<AudioBuffer | null>(null);
  const [samples, setSamples] = useState<Float32Array | null>(null);
  const [rhythm, setRhythm] = useState<RhythmAnalysis | null>(null);
  const [sourceBpm, setSourceBpm] = useState(120);
  const [targetBpm, setTargetBpm] = useState(120);
  const [sourceRoot, setSourceRoot] = useState("C");
  const [targetRoot, setTargetRoot] = useState("C");
  const [drumHits, setDrumHits] = useState<DrumHit[]>([]);
  const [drumSlices, setDrumSlices] = useState<DrumSlice[]>([]);
  const [bassNotes, setBassNotes] = useState<BassNote[]>([]);
  const [previewBuffer, setPreviewBuffer] = useState<AudioBuffer | null>(null);
  const [busy, setBusy] = useState(false);
  const [drag, setDrag] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [previewPlaying, setPreviewPlaying] = useState(false);
  const [ratio, setRatio] = useState(0);
  const [message, setMessage] = useState("READY — DROP A CLEAN STEM");

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const audioUrlRef = useRef<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const previewPlaybackRef = useRef<DrumPlayback | null>(null);

  const semitone = ROOTS.indexOf(targetRoot) - ROOTS.indexOf(sourceRoot);
  const transformedBass = useMemo(() => transposeNotes(bassNotes, semitone), [bassNotes, semitone]);

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
    previewPlaybackRef.current?.stop();
    previewPlaybackRef.current = null;
    setPlaying(false);
    setPreviewPlaying(false);
    setRatio(0);
  }

  function clearAnalysis() {
    setDrumHits([]);
    setDrumSlices([]);
    setBassNotes([]);
    setPreviewBuffer(null);
    setPreviewPlaying(false);
  }

  async function ingest(nextFile: File) {
    stopPlayback();
    clearAnalysis();
    setBusy(true);
    setMessage("DECODING + TRACKING TEMPO…");
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
      setMessage(`READY — ${rhythmResult.beats.length} BEATS TRACKED`);
    } catch (error) {
      console.error(error);
      setMessage("ERROR — COULD NOT READ AUDIO");
      alert("Couldn't analyze that file. WAV/MP3/M4A work best in Chrome.");
    } finally {
      setBusy(false);
    }
  }

  async function processStem() {
    if (!samples || !buffer) return;
    stopPlayback();
    setBusy(true);
    setMessage(mode === "drums" ? "SUPERFLUX ONSET PASS…" : "TRANSCRIBING BASS…");
    await new Promise((resolve) => setTimeout(resolve, 30));
    try {
      if (mode === "drums") {
        const rawHits = detectDrumOnsets(samples, buffer.sampleRate, sourceBpm);
        if (!rawHits.length) {
          setDrumHits([]); setDrumSlices([]); setPreviewBuffer(null);
          setMessage("NO CLEAN ONSETS FOUND — TRY A CLEANER DRUM STEM");
          return;
        }
        const alignedHits = rhythm && rhythm.beats.length > 1
          ? rawHits.map((hit) => ({ ...hit, beat: secondsToBeatPosition(hit.time, rhythm.beats) }))
          : rawHits;
        const slices = extractDrumSlices(buffer, alignedHits);
        if (!slices.length) { setMessage("NO PREVIEW SLICES CREATED"); return; }
        setMessage(`RENDERING REBUILT AUDIO — ${alignedHits.length} CLEAN ONSETS…`);
        const rendered = await renderDrumPreview(slices, targetBpm, buffer.sampleRate);
        setDrumHits(alignedHits);
        setDrumSlices(slices);
        setPreviewBuffer(rendered);
        setMessage(`REBUILT AUDIO READY — ${alignedHits.length} CLEAN ONSETS`);
      } else {
        const notes = detectBass(samples, buffer.sampleRate, sourceBpm, null);
        setBassNotes(notes);
        setMessage(`TRANSCRIPTION READY — ${notes.length} NOTES`);
      }
    } catch (error) {
      console.error(error);
      setMessage(`ERROR — ${error instanceof Error ? error.message.toUpperCase() : "PROCESSING FAILED"}`);
    } finally {
      setBusy(false);
    }
  }

  function playOriginal() {
    if (!file) return;
    previewPlaybackRef.current?.stop();
    previewPlaybackRef.current = null;
    setPreviewPlaying(false);
    if (!audioRef.current) {
      const url = URL.createObjectURL(file);
      audioUrlRef.current = url;
      audioRef.current = new Audio(url);
      audioRef.current.ontimeupdate = () => {
        const audio = audioRef.current;
        if (audio) setRatio(audio.duration ? audio.currentTime / audio.duration : 0);
      };
      audioRef.current.onended = () => { setPlaying(false); setRatio(0); };
    }
    if (playing) { audioRef.current.pause(); setPlaying(false); }
    else { void audioRef.current.play(); setPlaying(true); }
  }

  function playPreview() {
    if (!previewBuffer) return;
    if (audioRef.current) { audioRef.current.pause(); setPlaying(false); }
    if (previewPlaying) {
      previewPlaybackRef.current?.stop();
      previewPlaybackRef.current = null;
      setPreviewPlaying(false);
      return;
    }
    previewPlaybackRef.current?.stop();
    previewPlaybackRef.current = playRenderedPreview(previewBuffer, () => {
      setPreviewPlaying(false);
      previewPlaybackRef.current = null;
    });
    setPreviewPlaying(true);
  }

  function exportRebuiltWav() {
    if (!previewBuffer) return;
    downloadBlob(audioBufferToWav(previewBuffer), `pattern-translator-rebuilt-${targetBpm}bpm.wav`);
  }

  function replaceFile() {
    stopPlayback();
    setFile(null); setBuffer(null); setSamples(null); setRhythm(null);
    clearAnalysis();
    setMessage("READY — DROP A CLEAN STEM");
  }

  function exportMidi() {
    if (mode === "drums") downloadBlob(drumsMidi(drumHits, targetBpm), `drums-pattern-${targetBpm}bpm.mid`);
    else downloadBlob(bassMidi(transformedBass, targetBpm), `bass-${targetRoot}-${targetBpm}bpm.mid`);
  }

  function switchMode(nextMode: Mode) {
    if (nextMode === mode) return;
    stopPlayback();
    setMode(nextMode);
    clearAnalysis();
    setMessage(file ? `READY — PROCESS ${nextMode.toUpperCase()} STEM` : "READY — DROP A CLEAN STEM");
  }

  function changeTargetBpm(value: number) {
    setTargetBpm(value);
    if (previewBuffer) {
      setPreviewBuffer(null);
      previewPlaybackRef.current?.stop();
      previewPlaybackRef.current = null;
      setPreviewPlaying(false);
      setMessage("TARGET CHANGED — REBUILD AUDIO");
    }
  }

  return (
    <main className="machineShell">
      <header className="machineHeader">
        <div>
          <div className="brandLine"><span>PT</span> PATTERN TRANSLATOR</div>
          <div className="versionLine">DIGITAL GROOVE WORKSTATION // BUILD 0.4</div>
        </div>
        <div className="statusLed"><i /> LOCAL DSP</div>
      </header>

      <section className="module modeModule">
        <div className="moduleTitle">01 // SOURCE TYPE</div>
        <div className="modeButtons">
          <button className={mode === "drums" ? "active" : ""} onClick={() => switchMode("drums")}><Drum size={16} /> DRUMS</button>
          <button className={mode === "bass" ? "active" : ""} onClick={() => switchMode("bass")}><Music2 size={16} /> BASS</button>
          <button className="disabledTool" disabled title="Full mix + drum substem separator service is next"><Scissors size={16} /> SPLIT FULL MIX // NEXT</button>
        </div>
      </section>

      <section className="module sourceModule">
        <div className="moduleTitle">02 // A/B AUDIO</div>
        {!file ? (
          <div className={`dropZone ${drag ? "drag" : ""}`} onDragOver={(e) => { e.preventDefault(); setDrag(true); }} onDragLeave={() => setDrag(false)} onDrop={(e) => { e.preventDefault(); setDrag(false); const next = e.dataTransfer.files[0]; if (next) void ingest(next); }} onClick={() => inputRef.current?.click()}>
            <input ref={inputRef} type="file" accept="audio/*" hidden onChange={(e) => { const next = e.target.files?.[0]; if (next) void ingest(next); }} />
            <Upload size={22} /><b>DROP {mode.toUpperCase()} STEM</b><span>WAV / MP3 / M4A — LOCAL ANALYSIS</span>
          </div>
        ) : (
          <>
            <div className="abDeck">
              <div className="abChannel originalChannel">
                <span className="abLabel">A // ORIGINAL SOURCE</span>
                <button className="abPlayButton" onClick={playOriginal}>{playing ? <Pause size={15} /> : <Play size={15} />}{playing ? "PAUSE ORIGINAL" : "PLAY ORIGINAL"}</button>
              </div>
              <div className="fileReadout"><b>{file.name}</b><span>{buffer?.duration.toFixed(1)} SEC // {buffer?.sampleRate.toLocaleString()} HZ</span></div>
              <div className="abChannel rebuiltChannel">
                <span className="abLabel">B // REBUILT AUDIO</span>
                <button className="abPlayButton rebuilt" onClick={playPreview} disabled={!previewBuffer}>{previewPlaying ? <Pause size={15} /> : <Play size={15} />}{previewPlaying ? "STOP REBUILT" : "PLAY REBUILT"}</button>
              </div>
              <button className="utilityButton" onClick={replaceFile}><RotateCcw size={14} /> EJECT</button>
            </div>
            <Waveform samples={samples} currentRatio={ratio} />
          </>
        )}
      </section>

      <section className="module translateModule">
        <div className="moduleTitle">03 // TRANSLATE</div>
        <div className="translateGrid">
          <label className="digitalControl"><span>SOURCE BPM</span><input type="number" min="20" max="300" step="0.1" value={sourceBpm} onChange={(e) => setSourceBpm(+e.target.value)} /></label>
          <div className="flowArrow">▶</div>
          <label className="digitalControl targetControl"><span>TARGET BPM</span><input type="number" min="20" max="300" step="0.1" value={targetBpm} onChange={(e) => changeTargetBpm(+e.target.value)} /></label>
          {mode === "bass" && <><label className="keyControl"><span>SOURCE ROOT</span><select value={sourceRoot} onChange={(e) => setSourceRoot(e.target.value)}>{ROOTS.map((root) => <option key={root}>{root}</option>)}</select></label><div className="flowArrow">▶</div><label className="keyControl targetControl"><span>TARGET ROOT</span><select value={targetRoot} onChange={(e) => setTargetRoot(e.target.value)}>{ROOTS.map((root) => <option key={root}>{root}</option>)}</select></label></>}
        </div>
        <div className="actionRail">
          <div className="lcdStatus"><i className={busy ? "blink" : ""} /> {message}</div>
          <button className="processButton" disabled={!file || busy} onClick={() => void processStem()}><Wand2 size={17} /> {busy ? "WORKING…" : mode === "drums" ? "ANALYZE + REBUILD" : "TRANSCRIBE"}</button>
        </div>
      </section>

      <section className="module patternModule">
        <div className="moduleTitle">04 // EVENT MONITOR</div>
        {mode === "drums" ? (drumHits.length ? <DrumPattern hits={drumHits} /> : <div className="emptyMonitor">NO EVENTS — PROCESS STEM</div>) : transformedBass.length ? <div className="noteMonitor">{transformedBass.slice(0, 40).map((note) => <span key={note.id}>{midiNoteName(note.midi)} <small>@{note.beat.toFixed(2)}</small></span>)}</div> : <div className="emptyMonitor">NO NOTES — PROCESS STEM</div>}
        <div className="monitorFooter">
          <div className="miniReadouts"><span>BEATS <b>{rhythm?.beats.length ?? 0}</b></span><span>{mode === "drums" ? "HITS" : "NOTES"} <b>{mode === "drums" ? drumHits.length : transformedBass.length}</b></span><span>GRID <b>FREE</b></span></div>
          <div className="exportGroup">
            {mode === "drums" && <button className="exportButton primaryExport" disabled={!previewBuffer} onClick={exportRebuiltWav}><Download size={15} /> EXPORT REBUILT WAV</button>}
            <button className="exportButton secondaryExport" disabled={mode === "drums" ? !drumHits.length : !transformedBass.length} onClick={exportMidi}><Download size={15} /> EXPORT PATTERN MIDI</button>
          </div>
        </div>
        {mode === "drums" && <div className="midiWarning">MIDI = editable timing only. It does not contain the source drum sounds. Drum lanes are generic until kick/snare/hat substem separation is implemented.</div>}
      </section>

      <footer className="machineFooter">
        <span><SlidersHorizontal size={12} /> A/B AUDIO FIRST // MIDI IS PATTERN DATA</span>
        <span>DRUM SUBSTEMS: KICK / SNARE / HATS / CYMBALS / TOMS → NEXT</span>
      </footer>
    </main>
  );
}
