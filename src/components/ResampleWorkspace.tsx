import { useEffect, useMemo, useRef, useState } from "react";
import { Copy, Download, Mic, Pause, Play, Scissors, Square, Upload } from "lucide-react";
import * as Tone from "tone";
import { decodeAudio, monoSamples, type DrumHit } from "../audio";
import { quantizeRhythmCapture } from "../analysis/rhythmCapture";
import { detectVoiceRhythmOnsets } from "../analysis/voiceRhythm";
import { recordOneBarRhythm } from "../audio/captureRhythm";
import { audioBufferToWav } from "../audio/wav";
import { extractAutoDrumKit, type AutoKitLane } from "../audio/autoDrumKit";
import { renderPatternBuffer } from "../audio/patternRender";
import { drumsMidi } from "../midi";
import type { ProjectAudioAsset } from "../project/assets";
import { createOperationGate } from "../state/operationGate";
import { DraftNumberInput } from "./DraftNumberInput";

const STEPS = 16;
const LANES = ["KICK", "SNARE", "HAT", "PERC"] as const;
type LaneName = typeof LANES[number];
type PreviewMode = "source" | "working";

type LaneState = {
  name: LaneName;
  file: File | null;
  buffer: AudioBuffer | null;
  steps: boolean[];
};

type SourcePattern = Record<LaneName, boolean[]>;

type ResampleWorkspaceProps = {
  routedAsset?: ProjectAudioAsset | null;
};

function blankLane(name: LaneName): LaneState {
  return { name, file: null, buffer: null, steps: Array(STEPS).fill(false) };
}

function blankSourcePattern(): SourcePattern {
  return {
    KICK: Array(STEPS).fill(false),
    SNARE: Array(STEPS).fill(false),
    HAT: Array(STEPS).fill(false),
    PERC: Array(STEPS).fill(false),
  };
}

function blankLaneLoadGeneration(): Record<LaneName, number> {
  return { KICK: 0, SNARE: 0, HAT: 0, PERC: 0 };
}

function directLaneForAsset(asset: ProjectAudioAsset): LaneName | null {
  if (asset.kind === "kick") return "KICK";
  if (asset.kind === "snare") return "SNARE";
  if (asset.kind === "hihat" || asset.kind === "cymbals") return "HAT";
  if (asset.kind === "toms") return "PERC";
  return null;
}

function downloadBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 500);
}

function abortError() {
  return new DOMException("Operation cancelled", "AbortError");
}

export function ResampleWorkspace({ routedAsset = null }: ResampleWorkspaceProps) {
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
  const [message, setMessage] = useState("DROP AUDIO TO BUILD A KIT, OR LOAD YOUR OWN ONE-SHOTS");

  const playersRef = useRef<Map<LaneName, Tone.Player>>(new Map());
  const playerUrlsRef = useRef<Map<LaneName, string>>(new Map());
  const scheduleRef = useRef<number | null>(null);
  const patternRef = useRef(lanes);
  const sourcePatternRef = useRef(sourcePattern);
  const voiceCaptureAbortRef = useRef<AbortController | null>(null);
  const routedAssetRef = useRef<string | null>(null);
  const extractGateRef = useRef(createOperationGate());
  const laneLoadGenerationRef = useRef<Record<LaneName, number>>(blankLaneLoadGeneration());
  const mountedRef = useRef(false);

  useEffect(() => { patternRef.current = lanes; }, [lanes]);
  useEffect(() => { sourcePatternRef.current = sourcePattern; }, [sourcePattern]);

  function disposePlayer(name: LaneName) {
    playersRef.current.get(name)?.dispose();
    playersRef.current.delete(name);
    const url = playerUrlsRef.current.get(name);
    if (url) URL.revokeObjectURL(url);
    playerUrlsRef.current.delete(name);
  }

  function stopSequencer() {
    const transport = Tone.getTransport();
    transport.stop();
    if (scheduleRef.current !== null) transport.clear(scheduleRef.current);
    scheduleRef.current = null;
    setCurrentStep(-1);
    setPlayingMode(null);
  }

  function invalidateLaneLoads() {
    for (const lane of LANES) laneLoadGenerationRef.current[lane] += 1;
  }

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      extractGateRef.current.invalidate();
      invalidateLaneLoads();
      stopSequencer();
      for (const lane of LANES) disposePlayer(lane);
      voiceCaptureAbortRef.current?.abort();
    };
  }, []);

  useEffect(() => {
    if (!routedAsset) {
      routedAssetRef.current = null;
      return;
    }
    if (routedAssetRef.current === routedAsset.id) return;
    routedAssetRef.current = routedAsset.id;
    const directLane = directLaneForAsset(routedAsset);
    if (directLane) {
      void loadSample(directLane, routedAsset.file);
      return;
    }
    void extractStem(routedAsset.file);
  }, [routedAsset]);

  const loadedCount = useMemo(() => lanes.filter((lane) => lane.buffer).length, [lanes]);
  const hasSourcePattern = useMemo(
    () => LANES.some((lane) => sourcePattern[lane].some(Boolean)),
    [sourcePattern],
  );
  const voiceCaptureActive = recording || countIn !== null;

  function invalidateExport(next = "PATTERN CHANGED — LOOP KEEPS PLAYING; EXPORT WILL USE CURRENT STEPS") {
    setRendered(null);
    setMessage(next);
  }

  function updateLanes(updater: (current: LaneState[]) => LaneState[]) {
    setLanes((current) => {
      const next = updater(current);
      patternRef.current = next;
      return next;
    });
  }

  function updateSourcePattern(next: SourcePattern) {
    sourcePatternRef.current = next;
    setSourcePattern(next);
  }

  async function installPlayer(name: LaneName, file: File) {
    const url = URL.createObjectURL(file);
    const player = new Tone.Player(url).toDestination();
    try {
      await Tone.loaded();
    } catch (error) {
      player.dispose();
      URL.revokeObjectURL(url);
      throw error;
    }
    disposePlayer(name);
    playersRef.current.set(name, player);
    playerUrlsRef.current.set(name, url);
  }

  async function loadSample(name: LaneName, file: File) {
    extractGateRef.current.invalidate();
    setExtracting(false);
    const generation = ++laneLoadGenerationRef.current[name];
    try {
      const buffer = await decodeAudio(file);
      if (!mountedRef.current || generation !== laneLoadGenerationRef.current[name]) return;
      await installPlayer(name, file);
      if (!mountedRef.current || generation !== laneLoadGenerationRef.current[name]) {
        disposePlayer(name);
        return;
      }
      updateLanes((current) => current.map((lane) => lane.name === name ? { ...lane, file, buffer } : lane));
      invalidateExport(`${name} SAMPLE READY — LIVE LOOP CAN KEEP RUNNING`);
    } catch (error) {
      if (!mountedRef.current || generation !== laneLoadGenerationRef.current[name]) return;
      console.error(error);
      setMessage(`ERROR — COULD NOT LOAD ${name}`);
    }
  }

  async function extractStem(file: File) {
    const token = extractGateRef.current.begin();
    invalidateLaneLoads();
    stopSequencer();
    setSourceStem(file);
    setExtracting(true);
    setRendered(null);
    updateSourcePattern(blankSourcePattern());
    for (const lane of LANES) disposePlayer(lane);
    updateLanes((current) => current.map((lane) => ({ ...blankLane(lane.name), steps: [...lane.steps] })));
    setMessage("ANALYZING SOURCE + EXTRACTING KIT…");

    try {
      const buffer = await decodeAudio(file);
      if (!mountedRef.current || !extractGateRef.current.isCurrent(token)) return;
      const result = extractAutoDrumKit(buffer, bpm);
      if (!mountedRef.current || !extractGateRef.current.isCurrent(token)) return;
      const entries = Object.entries(result.lanes) as [AutoKitLane, AudioBuffer][];
      if (!entries.length) throw new Error("No clean transient samples found");

      const extracted = new Map<LaneName, { file: File; buffer: AudioBuffer }>();
      for (const [name, sampleBuffer] of entries) {
        const blob = audioBufferToWav(sampleBuffer);
        const sampleFile = new File([blob], `${name.toLowerCase()}-auto.wav`, { type: "audio/wav" });
        await installPlayer(name, sampleFile);
        if (!mountedRef.current || !extractGateRef.current.isCurrent(token)) return;
        extracted.set(name, { file: sampleFile, buffer: sampleBuffer });
      }

      if (!mountedRef.current || !extractGateRef.current.isCurrent(token)) return;
      updateLanes((current) => current.map((lane) => {
        const sample = extracted.get(lane.name);
        return sample ? { ...lane, file: sample.file, buffer: sample.buffer } : blankLane(lane.name);
      }));
      updateSourcePattern(result.sourcePattern as SourcePattern);
      const detail = LANES.map((name) => `${name}:${result.counts[name]}`).join("  ");
      setMessage(`AUTO KIT + SOURCE GRID READY — ${result.totalOnsets} ONSETS // ${detail}`);
    } catch (error) {
      if (!mountedRef.current || !extractGateRef.current.isCurrent(token)) return;
      console.error(error);
      for (const lane of LANES) disposePlayer(lane);
      updateLanes(() => LANES.map(blankLane));
      updateSourcePattern(blankSourcePattern());
      setMessage(`ERROR — ${error instanceof Error ? error.message.toUpperCase() : "KIT EXTRACTION FAILED"}`);
    } finally {
      if (mountedRef.current && extractGateRef.current.isCurrent(token)) setExtracting(false);
    }
  }

  async function audition(name: LaneName) {
    const player = playersRef.current.get(name);
    if (!player) return;
    await Tone.start();
    player.start();
  }

  function toggleStep(name: LaneName, step: number) {
    updateLanes((current) => current.map((lane) => lane.name === name ? {
      ...lane,
      steps: lane.steps.map((value, index) => index === step ? !value : value),
    } : lane));
    invalidateExport();
  }

  function copySourcePattern() {
    updateLanes((current) => current.map((lane) => ({
      ...lane,
      steps: [...sourcePatternRef.current[lane.name]],
    })));
    invalidateExport("SOURCE PATTERN COPIED — EDIT IT WHILE THE LOOP RUNS");
  }

  function clearPattern() {
    updateLanes((current) => current.map((lane) => ({ ...lane, steps: Array(STEPS).fill(false) })));
    invalidateExport("WORKING PATTERN CLEARED — LIVE LOOP REMAINS ACTIVE");
  }

  async function togglePlayback(mode: PreviewMode) {
    if (playingMode === mode) {
      stopSequencer();
      setMessage(mode === "source" ? "SOURCE PREVIEW STOPPED" : "WORKING LOOP STOPPED");
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
      const livePattern = patternRef.current;
      const liveSource = sourcePatternRef.current;
      for (const lane of livePattern) {
        const enabled = mode === "source"
          ? liveSource[lane.name][activeStep]
          : lane.steps[activeStep];
        if (enabled) playersRef.current.get(lane.name)?.start(time);
      }
      Tone.getDraw().schedule(() => {
        if (mountedRef.current) setCurrentStep(activeStep);
      }, time);
      step += 1;
    }, "16n");

    transport.start();
    setPlayingMode(mode);
    setMessage(mode === "source" ? "PLAYING SOURCE GROOVE" : "LIVE WORKING LOOP — EDIT STEPS WHILE IT PLAYS");
  }

  function changeBpm(value: number) {
    setBpm(value);
    if (playingMode) Tone.getTransport().bpm.rampTo(value, 0.03);
    invalidateExport("BPM CHANGED — LIVE LOOP UPDATED; RE-EXTRACT IF SOURCE GRID LOOKS OFF");
  }

  async function buildWav() {
    if (rendered) {
      setMessage(`WAV READY — ${rendered.duration.toFixed(1)} SEC`);
      return;
    }
    setRendering(true);
    setMessage("RENDERING 4-BAR WAV…");
    try {
      const output = await renderPatternBuffer(patternRef.current, bpm, 4);
      if (!mountedRef.current) return;
      setRendered(output);
      setMessage(`WAV READY — ${output.duration.toFixed(1)} SEC`);
    } catch (error) {
      console.error(error);
      if (mountedRef.current) setMessage(`ERROR — ${error instanceof Error ? error.message.toUpperCase() : "RENDER FAILED"}`);
    } finally {
      if (mountedRef.current) setRendering(false);
    }
  }

  function exportWav() {
    if (!rendered) return;
    downloadBlob(audioBufferToWav(rendered), `chopsticks-pattern-${bpm}bpm.wav`);
  }

  function exportMidi() {
    const hits: DrumHit[] = [];
    patternRef.current.forEach((lane, laneIndex) => {
      lane.steps.forEach((enabled, step) => {
        if (!enabled) return;
        hits.push({ id: `${lane.name}-${step}`, lane: laneIndex, beat: step / 4, time: 0, velocity: 110 });
      });
    });
    if (!hits.length) return;
    downloadBlob(drumsMidi(hits, bpm), `chopsticks-pattern-${bpm}bpm.mid`);
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
      if (controller.signal.aborted) throw abortError();

      const voiceFile = new File([blob], "voice-pattern.webm", { type: blob.type });
      const voiceBuffer = await decodeAudio(voiceFile);
      if (controller.signal.aborted) throw abortError();
      const mono = monoSamples(voiceBuffer);
      const onsets = detectVoiceRhythmOnsets(mono, voiceBuffer.sampleRate);
      const activeSteps = new Set(quantizeRhythmCapture(onsets, { bpm: captureBpm, steps: STEPS }));
      if (controller.signal.aborted) throw abortError();
      updateLanes((current) => current.map((lane) => lane.name === voiceLane ? {
        ...lane,
        steps: lane.steps.map((value, step) => value || activeSteps.has(step)),
      } : lane));
      invalidateExport(`VOICE → ${voiceLane} PATTERN — ${activeSteps.size} STEPS CAPTURED`);
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        if (mountedRef.current) setMessage("VOICE CAPTURE CANCELLED");
      } else if (mountedRef.current) {
        console.error(error);
        setMessage(`ERROR — ${error instanceof Error ? error.message.toUpperCase() : "COULD NOT ANALYZE VOICE INPUT"}`);
      }
    } finally {
      if (mountedRef.current) {
        setRecording(false);
        setCountIn(null);
        setProcessingVoice(false);
      }
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
        <div className="resampleIntro">Drop audio or send material from the CRATE. Broad material is analyzed for reusable transient samples; separated drum assets load directly into their matching pad.</div>

        <div className="autoKitSource">
          <div className="autoKitReadout">
            <b>{sourceStem?.name ?? "NO SOURCE LOADED"}</b>
            <span>{sourceStem ? "KIT + SOURCE GRID READY AFTER ANALYSIS" : "WAV / MP3 / M4A AUDIO"}</span>
          </div>
          <label className="processButton autoKitButton">
            <Scissors size={15} /> {extracting ? "EXTRACTING…" : sourceStem ? "RE-EXTRACT KIT" : "LOAD AUDIO"}
            <input type="file" accept="audio/*" hidden disabled={extracting} onChange={(event) => { const nextFile = event.target.files?.[0]; event.currentTarget.value = ""; if (nextFile) void extractStem(nextFile); }} />
          </label>
        </div>

        {extracting && <div className="vintageProgress"><span>ANALYZING TRANSIENTS + BUILDING KIT</span><div className="progressTrack"><div className="progressBlocks" /></div></div>}

        <div className="sampleRack">
          {lanes.map((lane) => (
            <div className="sampleSlot" key={lane.name}>
              <b>{lane.name}</b>
              <span>{lane.file?.name ?? "NOT FOUND / NO SAMPLE"}</span>
              <label className="stemUploadButton"><Upload size={13} /> {lane.buffer ? "REPLACE" : "LOAD MANUALLY"}<input type="file" accept="audio/*" hidden onChange={(event) => { const nextFile = event.target.files?.[0]; event.currentTarget.value = ""; if (nextFile) void loadSample(lane.name, nextFile); }} /></label>
              <button className="utilityButton" disabled={!lane.buffer} onClick={() => void audition(lane.name)}><Play size={12} /> HIT</button>
            </div>
          ))}
        </div>
      </section>

      <section className="module">
        <div className="moduleTitle">02 // SEQUENCER</div>
        <div className="sequencerTopbar">
          <label className="miniControl"><span>BPM</span><DraftNumberInput value={bpm} min={40} max={240} onCommit={changeBpm} ariaLabel="Sampler BPM" /></label>
          <button className="utilityButton sourcePreviewButton" disabled={!hasSourcePattern} onClick={() => void togglePlayback("source")}>
            {playingMode === "source" ? <Pause size={14} /> : <Play size={14} />}{playingMode === "source" ? "STOP SOURCE" : "PREVIEW SOURCE"}
          </button>
          <button className="utilityButton" disabled={!hasSourcePattern} onClick={copySourcePattern}><Copy size={13} /> COPY SOURCE</button>
          <button className="processButton" disabled={!loadedCount} onClick={() => void togglePlayback("working")}>
            {playingMode === "working" ? <Pause size={14} /> : <Play size={14} />}{playingMode === "working" ? "STOP LOOP" : "PREVIEW WORKING"}
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
        <div className="voiceNote sourceGridNote">PREVIEW WORKING is a live loop. Add or remove steps while it runs; changes are heard immediately on the next pass.</div>
      </section>

      <section className="module">
        <div className="moduleTitle">03 // VOICE → PATTERN</div>
        <div className="voiceCapture">
          <label className="miniControl"><span>VOICE TARGET</span><select value={voiceLane} disabled={voiceCaptureActive || processingVoice || rendering} onChange={(event) => setVoiceLane(event.target.value as LaneName)}>{LANES.map((lane) => <option key={lane}>{lane}</option>)}</select></label>
          <button
            className={voiceCaptureActive ? "recordButton active" : "recordButton"}
            disabled={processingVoice || rendering}
            onClick={() => voiceCaptureActive ? cancelVoiceCapture() : void startVoiceCapture()}
          >
            {voiceCaptureActive ? <Square size={14} /> : <Mic size={14} />}
            {countIn !== null ? `START IN ${countIn}` : recording ? "CANCEL CAPTURE" : processingVoice ? "ANALYZING…" : "RECORD 1 BAR"}
          </button>
          <div className="voiceNote">Follow the 4-beat count-in, then beatbox or tap exactly one bar.</div>
        </div>
      </section>

      <section className="module">
        <div className="moduleTitle">04 // EXPORT</div>
        <div className="resampleStatus">{rendering ? <><span>{message}</span><div className="progressTrack"><div className="progressBlocks" /></div></> : message}</div>
        <div className="resampleActions">
          <button className="processButton" disabled={rendering || !loadedCount} onClick={() => void buildWav()}>BUILD 4-BAR WAV</button>
          <button className="exportButton primaryExport" disabled={!rendered || rendering} onClick={exportWav}><Download size={14} /> EXPORT WAV</button>
          <button className="exportButton" disabled={rendering} onClick={exportMidi}>EXPORT MIDI</button>
        </div>
      </section>
    </section>
  );
}
