import { useEffect, useMemo, useRef, useState } from "react";
import { Copy, Download, Mic, Pause, Play, Scissors, Square, Upload } from "lucide-react";
import * as Tone from "tone";
import { decodeAudio, monoSamples, type DrumHit } from "../audio";
import { quantizeRhythmCapture } from "../analysis/rhythmCapture";
import { detectVoiceRhythmOnsets } from "../analysis/voiceRhythm";
import { recordOneBarRhythm } from "../audio/captureRhythm";
import { audioBufferToWav } from "../audio/wav";
import { extractAutoDrumKit, type AutoKitLane } from "../audio/autoDrumKit";
import { drumsMidi } from "../midi";
import { DraftNumberInput } from "./DraftNumberInput";

const STEPS = 16;
const LANES = ["KICK", "SNARE", "HAT", "PERC"] as const;
type LaneName = typeof LANES[number];
type PreviewMode = "source" | "working";

type LaneState = {
  name: LaneName;
  file: File | null;
  buffer: AudioBuffer | null;
  url: string | null;
  steps: boolean[];
};

type SourcePattern = Record<LaneName, boolean[]>;

function blankLane(name: LaneName): LaneState {
  return { name, file: null, buffer: null, url: null, steps: Array(STEPS).fill(false) };
}

function blankSourcePattern(): SourcePattern {
  return {
    KICK: Array(STEPS).fill(false),
    SNARE: Array(STEPS).fill(false),
    HAT: Array(STEPS).fill(false),
    PERC: Array(STEPS).fill(false),
  };
}

function downloadBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 500);
}

async function renderPattern(lanes: LaneState[], bpm: number, bars = 4) {
  const activeLanes = lanes.filter((lane) => lane.buffer && lane.steps.some(Boolean));
  if (!activeLanes.length) throw new Error("Add a sample and program at least one step");

  const sampleRate = Math.max(...activeLanes.map((lane) => lane.buffer!.sampleRate));
  const channels = Math.max(...activeLanes.map((lane) => lane.buffer!.numberOfChannels));
  const secondsPerStep = 60 / bpm / 4;
  const duration = bars * STEPS * secondsPerStep;
  const offline = new OfflineAudioContext(channels, Math.ceil((duration + 1) * sampleRate), sampleRate);

  for (let bar = 0; bar < bars; bar++) {
    for (const lane of activeLanes) {
      lane.steps.forEach((enabled, step) => {
        if (!enabled || !lane.buffer) return;
        const source = offline.createBufferSource();
        source.buffer = lane.buffer;
        source.connect(offline.destination);
        source.start((bar * STEPS + step) * secondsPerStep);
      });
    }
  }

  return offline.startRendering();
}

export function ResampleWorkspace() {
  const [lanes, setLanes] = useState<LaneState[]>(() => LANES.map(blankLane));
  const [sourcePattern, setSourcePattern] = useState<SourcePattern>(() => blankSourcePattern());
  const [bpm, setBpm] = useState(100);
  const [playingMode, setPlayingMode] = useState<PreviewMode | null>(null);
  const [currentStep, setCurrentStep] = useState(-1);
  const [rendered, setRendered] = useState<AudioBuffer | null>(null);
  const [rendering, setRendering] = useState(false);
  const [extracting, setExtracting] = useState(false);
  const [sourceStem, setSourceStem] = useState<File | null>(null);
  const [recording, setRecording] = useState(false);
  const [countIn, setCountIn] = useState<number | null>(null);
  const [processingVoice, setProcessingVoice] = useState(false);
  const [voiceLane, setVoiceLane] = useState<LaneName>("KICK");
  const [message, setMessage] = useState("DROP ONE DRUM STEM TO BUILD A KIT, OR LOAD YOUR OWN ONE-SHOTS");

  const playersRef = useRef<Map<LaneName, Tone.Player>>(new Map());
  const scheduleRef = useRef<number | null>(null);
  const patternRef = useRef(lanes);
  const sourcePatternRef = useRef(sourcePattern);
  const voiceCaptureAbortRef = useRef<AbortController | null>(null);

  useEffect(() => { patternRef.current = lanes; }, [lanes]);
  useEffect(() => { sourcePatternRef.current = sourcePattern; }, [sourcePattern]);

  useEffect(() => () => {
    Tone.getTransport().stop();
    if (scheduleRef.current !== null) Tone.getTransport().clear(scheduleRef.current);
    playersRef.current.forEach((player) => player.dispose());
    patternRef.current.forEach((lane) => { if (lane.url) URL.revokeObjectURL(lane.url); });
    voiceCaptureAbortRef.current?.abort();
  }, []);

  const loadedCount = useMemo(() => lanes.filter((lane) => lane.buffer).length, [lanes]);
  const hasSourcePattern = useMemo(
    () => LANES.some((lane) => sourcePattern[lane].some(Boolean)),
    [sourcePattern],
  );
  const voiceCaptureActive = recording || countIn !== null;

  function invalidate(next = "PATTERN CHANGED — PREVIEW / EXPORT WILL USE CURRENT STEPS") {
    setRendered(null);
    setMessage(next);
  }

  async function installSample(name: LaneName, file: File, buffer: AudioBuffer) {
    const previous = patternRef.current.find((lane) => lane.name === name);
    if (previous?.url) URL.revokeObjectURL(previous.url);
    playersRef.current.get(name)?.dispose();

    const url = URL.createObjectURL(file);
    const player = new Tone.Player(url).toDestination();
    playersRef.current.set(name, player);
    await Tone.loaded();

    setLanes((current) => current.map((lane) => lane.name === name ? { ...lane, file, buffer, url } : lane));
  }

  async function loadSample(name: LaneName, file: File) {
    try {
      const buffer = await decodeAudio(file);
      await installSample(name, file, buffer);
      invalidate(`${name} SAMPLE READY — CLICK STEPS OR USE VOICE INPUT`);
    } catch (error) {
      console.error(error);
      setMessage(`ERROR — COULD NOT LOAD ${name}`);
    }
  }

  async function extractStem(file: File) {
    setSourceStem(file);
    setExtracting(true);
    setRendered(null);
    setMessage("ANALYZING DRUM STEM + EXTRACTING KIT…");
    try {
      const buffer = await decodeAudio(file);
      const result = extractAutoDrumKit(buffer, bpm);
      const entries = Object.entries(result.lanes) as [AutoKitLane, AudioBuffer][];
      if (!entries.length) throw new Error("No clean drum hits found");

      const installed: LaneName[] = [];
      for (const [name, sampleBuffer] of entries) {
        const blob = audioBufferToWav(sampleBuffer);
        const sampleFile = new File([blob], `${name.toLowerCase()}-auto.wav`, { type: "audio/wav" });
        await installSample(name, sampleFile, sampleBuffer);
        installed.push(name);
      }

      setSourcePattern(result.sourcePattern as SourcePattern);
      const detail = LANES.map((name) => `${name}:${result.counts[name]}`).join("  ");
      setMessage(`AUTO KIT + SOURCE GRID READY — ${result.totalOnsets} ONSETS // ${detail}`);
    } catch (error) {
      console.error(error);
      setSourcePattern(blankSourcePattern());
      setMessage(`ERROR — ${error instanceof Error ? error.message.toUpperCase() : "KIT EXTRACTION FAILED"}`);
    } finally {
      setExtracting(false);
    }
  }

  async function audition(name: LaneName) {
    const player = playersRef.current.get(name);
    if (!player) return;
    await Tone.start();
    player.start();
  }

  function toggleStep(name: LaneName, step: number) {
    setLanes((current) => current.map((lane) => lane.name === name ? {
      ...lane,
      steps: lane.steps.map((value, index) => index === step ? !value : value),
    } : lane));
    invalidate();
  }

  function copySourcePattern() {
    setLanes((current) => current.map((lane) => ({
      ...lane,
      steps: [...sourcePattern[lane.name]],
    })));
    invalidate("SOURCE PATTERN COPIED — EDIT ANY AMBER STEP");
  }

  function clearPattern() {
    setLanes((current) => current.map((lane) => ({ ...lane, steps: Array(STEPS).fill(false) })));
    invalidate("WORKING PATTERN CLEARED — SOURCE MARKERS ARE STILL VISIBLE");
  }

  function stopSequencer() {
    const transport = Tone.getTransport();
    transport.stop();
    if (scheduleRef.current !== null) transport.clear(scheduleRef.current);
    scheduleRef.current = null;
    setCurrentStep(-1);
    setPlayingMode(null);
  }

  async function togglePlayback(mode: PreviewMode) {
    if (playingMode === mode) {
      stopSequencer();
      return;
    }

    if (!loadedCount) {
      setMessage("EXTRACT OR LOAD AT LEAST ONE SAMPLE FIRST");
      return;
    }
    if (mode === "source" && !hasSourcePattern) {
      setMessage("NO SOURCE PATTERN DETECTED YET");
      return;
    }

    stopSequencer();
    await Tone.start();
    const transport = Tone.getTransport();
    transport.cancel();
    transport.bpm.value = bpm;
    transport.position = 0;
    let step = 0;
    scheduleRef.current = transport.scheduleRepeat((time) => {
      const activeStep = step % STEPS;
      patternRef.current.forEach((lane) => {
        const enabled = mode === "source"
          ? sourcePatternRef.current[lane.name][activeStep]
          : lane.steps[activeStep];
        if (enabled) playersRef.current.get(lane.name)?.start(time);
      });
      Tone.getDraw().schedule(() => setCurrentStep(activeStep), time);
      step += 1;
    }, "16n");
    transport.start();
    setPlayingMode(mode);
    setMessage(mode === "source" ? "PLAYING DETECTED SOURCE PATTERN" : "PLAYING WORKING PATTERN");
  }

  async function buildWav() {
    setRendering(true);
    setMessage("RENDERING 4-BAR WAV…");
    try {
      const output = await renderPattern(lanes, bpm, 4);
      setRendered(output);
      setMessage(`WAV READY — ${output.duration.toFixed(1)} SEC`);
    } catch (error) {
      console.error(error);
      setMessage(`ERROR — ${error instanceof Error ? error.message.toUpperCase() : "RENDER FAILED"}`);
    } finally {
      setRendering(false);
    }
  }

  function exportWav() {
    if (!rendered) return;
    downloadBlob(audioBufferToWav(rendered), `pattern-translator-resample-${bpm}bpm.wav`);
  }

  function exportMidi() {
    const hits: DrumHit[] = [];
    lanes.forEach((lane, laneIndex) => {
      lane.steps.forEach((enabled, step) => {
        if (!enabled) return;
        hits.push({ id: `${lane.name}-${step}`, lane: laneIndex, beat: step / 4, time: 0, velocity: 110 });
      });
    });
    if (!hits.length) return;
    downloadBlob(drumsMidi(hits, bpm), `pattern-translator-pattern-${bpm}bpm.mid`);
  }

  async function startVoiceCapture() {
    if (voiceCaptureActive || processingVoice) return;
    const controller = new AbortController();
    voiceCaptureAbortRef.current = controller;
    const captureBpm = bpm;

    try {
      const blob = await recordOneBarRhythm({
        bpm: captureBpm,
        signal: controller.signal,
        onPhase: (phase) => {
          if (phase.phase === "count-in") {
            setCountIn(phase.beat);
            setRecording(false);
            setProcessingVoice(false);
            setMessage(`COUNT-IN ${phase.beat} — GET READY FOR ${voiceLane}`);
          } else if (phase.phase === "recording") {
            setCountIn(null);
            setRecording(true);
            setProcessingVoice(false);
            setMessage(`GO — BEATBOX / TAP ${voiceLane} FOR ONE BAR`);
          } else {
            setCountIn(null);
            setRecording(false);
            setProcessingVoice(true);
            setMessage("ANALYZING VOICE RHYTHM…");
          }
        },
      });

      const file = new File([blob], "voice-pattern.webm", { type: blob.type });
      const buffer = await decodeAudio(file);
      const mono = monoSamples(buffer);
      const onsets = detectVoiceRhythmOnsets(mono, buffer.sampleRate);
      const activeSteps = new Set(quantizeRhythmCapture(onsets, { bpm: captureBpm, steps: STEPS }));
      setLanes((current) => current.map((lane) => lane.name === voiceLane ? {
        ...lane,
        steps: lane.steps.map((value, step) => value || activeSteps.has(step)),
      } : lane));
      invalidate(`VOICE → ${voiceLane} PATTERN — ${activeSteps.size} STEPS CAPTURED`);
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        setMessage("VOICE CAPTURE CANCELLED");
      } else {
        console.error(error);
        setMessage(`ERROR — ${error instanceof Error ? error.message.toUpperCase() : "COULD NOT ANALYZE VOICE INPUT"}`);
      }
    } finally {
      setRecording(false);
      setCountIn(null);
      setProcessingVoice(false);
      if (voiceCaptureAbortRef.current === controller) voiceCaptureAbortRef.current = null;
    }
  }

  function cancelVoiceCapture() {
    voiceCaptureAbortRef.current?.abort();
  }

  return (
    <section className="resampleWorkspace">
      <section className="module">
        <div className="moduleTitle">01 // SOURCE → AUTO SOUND KIT</div>
        <div className="resampleIntro">Drop one clean DRUM STEM. Pattern Translator extracts a kit and maps the first detected bar onto the grid as faint SOURCE markers. You can audition, copy and edit that pattern below.</div>

        <div className="autoKitSource">
          <div className="autoKitReadout">
            <b>{sourceStem?.name ?? "NO DRUM STEM LOADED"}</b>
            <span>{sourceStem ? "AUTO-EXTRACTION + SOURCE GRID READY AFTER ANALYSIS" : "WAV / MP3 / M4A DRUM STEM"}</span>
          </div>
          <label className="processButton autoKitButton">
            <Scissors size={15} /> {extracting ? "EXTRACTING…" : sourceStem ? "RE-EXTRACT KIT" : "LOAD DRUM STEM"}
            <input type="file" accept="audio/*" hidden disabled={extracting} onChange={(event) => { const file = event.target.files?.[0]; if (file) void extractStem(file); event.currentTarget.value = ""; }} />
          </label>
        </div>

        {extracting && <div className="vintageProgress"><span>ANALYZING TRANSIENTS + BUILDING KIT</span><div className="progressTrack"><div className="progressBlocks" /></div></div>}

        <div className="sampleRack">
          {lanes.map((lane) => (
            <div className="sampleSlot" key={lane.name}>
              <b>{lane.name}</b>
              <span>{lane.file?.name ?? "NOT FOUND / NO SAMPLE"}</span>
              <label className="stemUploadButton"><Upload size={13} /> {lane.buffer ? "REPLACE" : "LOAD MANUALLY"}<input type="file" accept="audio/*" hidden onChange={(event) => { const file = event.target.files?.[0]; if (file) void loadSample(lane.name, file); event.currentTarget.value = ""; }} /></label>
              <button className="utilityButton" disabled={!lane.buffer} onClick={() => void audition(lane.name)}><Play size={12} /> HIT</button>
            </div>
          ))}
        </div>
      </section>

      <section className="module">
        <div className="moduleTitle">02 // SOURCE PATTERN → WORKING PATTERN</div>
        <div className="sequencerTopbar">
          <label className="miniControl"><span>BPM</span><DraftNumberInput value={bpm} min={40} max={240} onCommit={(value) => { setBpm(value); invalidate("BPM CHANGED — RE-EXTRACT IF SOURCE GRID LOOKS OFF"); }} ariaLabel="Resample BPM" /></label>
          <button className="utilityButton sourcePreviewButton" disabled={!hasSourcePattern} onClick={() => void togglePlayback("source")}>
            {playingMode === "source" ? <Pause size={14} /> : <Play size={14} />}{playingMode === "source" ? "STOP SOURCE" : "PREVIEW SOURCE"}
          </button>
          <button className="utilityButton" disabled={!hasSourcePattern} onClick={copySourcePattern}><Copy size={13} /> COPY SOURCE</button>
          <button className="processButton" onClick={() => void togglePlayback("working")}>
            {playingMode === "working" ? <Pause size={14} /> : <Play size={14} />}{playingMode === "working" ? "STOP" : "PREVIEW WORKING"}
          </button>
          <button className="utilityButton" onClick={clearPattern}>CLEAR WORKING</button>
        </div>

        <div className="patternLegend">
          <span><i className="legendSource" /> SOURCE DETECTION</span>
          <span><i className="legendWorking" /> YOUR WORKING HIT</span>
        </div>

        <div className="stepGrid">
          <div className="stepHeader"><span />{Array.from({ length: STEPS }, (_, step) => <b key={step}>{step + 1}</b>)}</div>
          {lanes.map((lane) => (
            <div className="stepRow" key={lane.name}>
              <button className="laneAudition" disabled={!lane.buffer} onClick={() => void audition(lane.name)}>{lane.name}</button>
              {lane.steps.map((enabled, step) => {
                const sourceHit = sourcePattern[lane.name][step];
                return (
                  <button
                    key={step}
                    disabled={!lane.buffer}
                    aria-label={`${lane.name} step ${step + 1}${sourceHit ? ", source hit detected" : ""}`}
                    className={`stepCell ${sourceHit ? "sourceHit" : ""} ${enabled ? "on" : ""} ${currentStep === step ? "playhead" : ""}`}
                    onClick={() => toggleStep(lane.name, step)}
                  />
                );
              })}
            </div>
          ))}
        </div>
        <div className="voiceNote sourceGridNote">Faint source markers are a visual transcription of the first detected bar, not locked steps. Click COPY SOURCE to start from it, or build a different pattern while keeping the original groove visible underneath.</div>
      </section>

      <section className="module">
        <div className="moduleTitle">03 // VOICE → PATTERN BETA</div>
        <div className="voiceCapture">
          <label className="miniControl"><span>VOICE TARGET</span><select value={voiceLane} disabled={voiceCaptureActive || processingVoice} onChange={(event) => setVoiceLane(event.target.value as LaneName)}>{LANES.map((lane) => <option key={lane}>{lane}</option>)}</select></label>
          <button
            className={voiceCaptureActive ? "recordButton active" : "recordButton"}
            disabled={processingVoice}
            onClick={() => voiceCaptureActive ? cancelVoiceCapture() : void startVoiceCapture()}
          >
            {voiceCaptureActive ? <Square size={14} /> : <Mic size={14} />}
            {countIn !== null ? `START IN ${countIn}` : recording ? "CANCEL CAPTURE" : processingVoice ? "ANALYZING…" : "RECORD 1 BAR"}
          </button>
          <div className="voiceNote">One sound at a time. Follow the 4-beat visual count-in, then beatbox/tap exactly one bar. Capture auto-stops; echo cancellation, noise suppression and auto-gain are disabled when the browser allows it.</div>
        </div>
      </section>

      <section className="module">
        <div className="moduleTitle">04 // PREVIEW + EXPORT</div>
        <div className="resampleStatus">{rendering ? <><span>RENDERING 4-BAR WAV</span><div className="progressTrack"><div className="progressBlocks" /></div></div></> : message}</div>
        <div className="resampleActions">
          <button className="processButton" disabled={rendering || !loadedCount} onClick={() => void buildWav()}>BUILD 4-BAR WAV</button>
          <button className="exportButton primaryExport" disabled={!rendered} onClick={exportWav}><Download size={14} /> EXPORT WAV</button>
          <button className="exportButton" onClick={exportMidi}>EXPORT MIDI</button>
        </div>
        <div className="midiWarning">SOURCE markers depend on the BPM shown above and the current transient classifier. If the source grid is obviously shifted, correct BPM and re-extract. Manual steps remain the final truth for exported WAV/MIDI.</div>
      </section>
    </section>
  );
}
