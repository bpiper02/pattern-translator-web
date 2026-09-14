import { useEffect, useMemo, useRef, useState } from "react";
import { Download, Pause, Play, Scissors, Upload } from "lucide-react";
import {
  splitDrumStem,
  splitFullMix,
  stemUrlToFile,
  type DrumSplitProfile,
  type FullSplitProfile,
  type SplitStem,
} from "../separation/client";
import {
  assetKindLabel,
  type AudioAssetKind,
  type NewProjectAudioAsset,
  type ProjectAudioAsset,
} from "../project/assets";
import { createOperationGate, type OperationGate, type OperationToken } from "../state/operationGate";

type SplitMode = "full" | "drums";
type DownloadedStem = { stem: SplitStem; file: File };

type SplitWorkspaceProps = {
  assets: ProjectAudioAsset[];
  onAddAsset: (input: NewProjectAudioAsset) => ProjectAudioAsset;
};

function downloadUrl(url: string, fileName: string) {
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.target = "_blank";
  anchor.rel = "noreferrer";
  anchor.click();
}

function sourceKind(mode: SplitMode): AudioAssetKind {
  return mode === "full" ? "mix" : "drums";
}

function shortEngine(engine: string) {
  if (engine.includes("MDX23C-DrumSep")) return "MDX23C DRUMSEP";
  if (engine.includes("ensemble:vocal_balanced") && engine.includes("htdemucs")) return "VOCAL BALANCED ENSEMBLE → HTDEMUCS";
  if (engine.includes("melband_roformer") && engine.includes("htdemucs")) return "MEL-ROFORMER → HTDEMUCS";
  if (engine.includes("htdemucs_ft")) return engine.startsWith("fallback:") ? "HTDEMUCS FT FALLBACK" : "HTDEMUCS FT";
  if (engine.includes("drumsep")) return engine.startsWith("fallback:") ? "RULE-BASED DRUMSEP FALLBACK" : "RULE-BASED DRUMSEP";
  return engine.toUpperCase();
}

export function SplitWorkspace({ assets, onAddAsset }: SplitWorkspaceProps) {
  const [mode, setMode] = useState<SplitMode>("full");
  const [fullProfile, setFullProfile] = useState<FullSplitProfile>("balanced");
  const [drumProfile, setDrumProfile] = useState<DrumSplitProfile>("hq");
  const [file, setFile] = useState<File | null>(null);
  const [sourceAssetId, setSourceAssetId] = useState<string | null>(null);
  const [drumsAssetId, setDrumsAssetId] = useState<string | null>(null);
  const [stems, setStems] = useState<SplitStem[]>([]);
  const [drumSubstems, setDrumSubstems] = useState<SplitStem[]>([]);
  const [busy, setBusy] = useState(false);
  const [splittingDrums, setSplittingDrums] = useState(false);
  const [playingUrl, setPlayingUrl] = useState<string | null>(null);
  const [message, setMessage] = useState("DROP A FULL MIX OR DRUM STEM");
  const [lastEngine, setLastEngine] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const splitGateRef = useRef(createOperationGate());
  const drumGateRef = useRef(createOperationGate());
  const splitLockedRef = useRef(false);
  const drumLockedRef = useRef(false);
  const mountedRef = useRef(false);

  const drumsStem = useMemo(() => stems.find((stem) => stem.kind === "drums") ?? null, [stems]);
  const active = busy || splittingDrums;

  function stopAudio() {
    audioRef.current?.pause();
    audioRef.current = null;
    setPlayingUrl(null);
  }

  function invalidateOperations() {
    splitGateRef.current.invalidate();
    drumGateRef.current.invalidate();
    splitLockedRef.current = false;
    drumLockedRef.current = false;
    setBusy(false);
    setSplittingDrums(false);
  }

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      splitGateRef.current.invalidate();
      drumGateRef.current.invalidate();
      splitLockedRef.current = false;
      drumLockedRef.current = false;
      audioRef.current?.pause();
      audioRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!sourceAssetId || assets.some((asset) => asset.id === sourceAssetId)) return;
    invalidateOperations();
    stopAudio();
    setFile(null);
    setSourceAssetId(null);
    setDrumsAssetId(null);
    setStems([]);
    setDrumSubstems([]);
    setLastEngine(null);
    setMessage("SOURCE REMOVED — CHOOSE NEW MATERIAL");
  }, [assets, sourceAssetId]);

  function chooseMode(next: SplitMode) {
    if (next === mode || active) return;
    invalidateOperations();
    stopAudio();
    setMode(next);
    setFile(null);
    setSourceAssetId(null);
    setDrumsAssetId(null);
    setStems([]);
    setDrumSubstems([]);
    setLastEngine(null);
    setMessage(next === "full" ? "DROP A FULL MIX OR CHOOSE ONE FROM THE BIN" : "DROP DRUM AUDIO OR CHOOSE IT FROM THE BIN");
  }

  function registerSource(nextFile: File, operationMode: SplitMode, existing?: ProjectAudioAsset) {
    if (existing) return existing;
    return onAddAsset({ file: nextFile, kind: sourceKind(operationMode), label: nextFile.name, origin: "upload" });
  }

  async function downloadStems(resultStems: SplitStem[], gate: OperationGate, token: OperationToken) {
    const downloaded = await Promise.all(
      resultStems.map(async (stem): Promise<DownloadedStem> => ({ stem, file: await stemUrlToFile(stem) })),
    );
    return mountedRef.current && gate.isCurrent(token) ? downloaded : [];
  }

  function publishDownloadedStems(downloaded: DownloadedStem[], parentId: string, gate: OperationGate, token: OperationToken) {
    if (!mountedRef.current || !gate.isCurrent(token)) return [];
    const published: ProjectAudioAsset[] = [];
    for (const { stem, file: stemFile } of downloaded) {
      if (!mountedRef.current || !gate.isCurrent(token)) return published;
      published.push(onAddAsset({ file: stemFile, kind: stem.kind, label: stem.label, origin: "split", parentId }));
    }
    return published;
  }

  async function runSplit(nextFile = file, existingAsset?: ProjectAudioAsset) {
    if (!nextFile || splitLockedRef.current || drumLockedRef.current) return;
    splitLockedRef.current = true;
    const token = splitGateRef.current.begin();
    drumGateRef.current.invalidate();
    const operationMode = mode;
    const operationFullProfile = fullProfile;
    const operationDrumProfile = drumProfile;

    stopAudio();
    setBusy(true);
    setFile(nextFile);
    setStems([]);
    setDrumSubstems([]);
    setDrumsAssetId(null);
    setLastEngine(null);
    setMessage(operationMode === "full"
      ? operationFullProfile === "hq" ? "HQ REMIX SPLIT — ROFORMER VOCALS + DEMUCS INSTRUMENTS…" : "SEPARATING FULL MIX…"
      : operationDrumProfile === "hq" ? "HQ DRUM SPLIT — MDX23C…" : "SPLITTING DRUM AUDIO…");

    try {
      const result = operationMode === "full"
        ? await splitFullMix(nextFile, operationFullProfile)
        : await splitDrumStem(nextFile, operationDrumProfile);
      if (!mountedRef.current || !splitGateRef.current.isCurrent(token)) return;

      // Fetch every returned WAV before committing any new Crate objects. This
      // makes backend/network failure a clean no-op for project state.
      const downloaded = await downloadStems(result.stems, splitGateRef.current, token);
      if (!mountedRef.current || !splitGateRef.current.isCurrent(token) || downloaded.length !== result.stems.length) return;

      const sourceAsset = registerSource(nextFile, operationMode, existingAsset);
      if (!splitGateRef.current.isCurrent(token)) return;
      const published = publishDownloadedStems(downloaded, sourceAsset.id, splitGateRef.current, token);
      if (!mountedRef.current || !splitGateRef.current.isCurrent(token)) return;

      setSourceAssetId(sourceAsset.id);
      if (operationMode === "full") setStems(result.stems);
      else setDrumSubstems(result.stems);
      const publishedDrums = published.find((asset) => asset.kind === "drums");
      if (publishedDrums) setDrumsAssetId(publishedDrums.id);

      setLastEngine(shortEngine(result.engine));
      const fallback = result.profile.includes("fallback") ? " // FALLBACK USED" : "";
      setMessage(`SPLIT READY — ${result.stems.length} STEMS ADDED TO PROJECT BIN${fallback}`);
    } catch (error) {
      if (!mountedRef.current || !splitGateRef.current.isCurrent(token)) return;
      console.error(error);
      setMessage(`ERROR — ${error instanceof Error ? error.message.toUpperCase() : "SPLIT FAILED"}`);
    } finally {
      if (splitGateRef.current.isCurrent(token)) {
        splitLockedRef.current = false;
        setBusy(false);
      }
    }
  }

  async function splitDetectedDrums() {
    if (!drumsStem || splitLockedRef.current || drumLockedRef.current) return;
    drumLockedRef.current = true;
    const token = drumGateRef.current.begin();
    const operationDrumProfile = drumProfile;
    const operationParentId = drumsAssetId ?? sourceAssetId;
    if (!operationParentId) {
      drumLockedRef.current = false;
      setMessage("ERROR — DRUM SOURCE IS NO LONGER AVAILABLE");
      return;
    }

    stopAudio();
    setSplittingDrums(true);
    setLastEngine(null);
    setMessage(operationDrumProfile === "hq"
      ? "HQ DRUM SUB-SPLIT → MDX23C KICK / SNARE / HAT / CYMBALS / TOMS…"
      : "SPLITTING DRUMS → KICK / SNARE / HAT / CYMBALS / TOMS…");
    try {
      const drumFile = await stemUrlToFile(drumsStem);
      if (!mountedRef.current || !drumGateRef.current.isCurrent(token)) return;
      const result = await splitDrumStem(drumFile, operationDrumProfile);
      if (!mountedRef.current || !drumGateRef.current.isCurrent(token)) return;
      const downloaded = await downloadStems(result.stems, drumGateRef.current, token);
      if (!mountedRef.current || !drumGateRef.current.isCurrent(token) || downloaded.length !== result.stems.length) return;
      publishDownloadedStems(downloaded, operationParentId, drumGateRef.current, token);
      if (!mountedRef.current || !drumGateRef.current.isCurrent(token)) return;

      setDrumSubstems(result.stems);
      setLastEngine(shortEngine(result.engine));
      const fallback = result.profile.includes("fallback") ? " // FALLBACK USED" : "";
      setMessage(`DRUM SUBSTEMS READY — ${result.stems.length} STEMS ADDED TO PROJECT BIN${fallback}`);
    } catch (error) {
      if (!mountedRef.current || !drumGateRef.current.isCurrent(token)) return;
      console.error(error);
      setMessage(`ERROR — ${error instanceof Error ? error.message.toUpperCase() : "DRUM SPLIT FAILED"}`);
    } finally {
      if (drumGateRef.current.isCurrent(token)) {
        drumLockedRef.current = false;
        setSplittingDrums(false);
      }
    }
  }

  function togglePreview(stem: SplitStem) {
    if (playingUrl === stem.url) {
      stopAudio();
      return;
    }
    stopAudio();
    const audio = new Audio(stem.url);
    audio.crossOrigin = "anonymous";
    audio.onended = () => {
      audioRef.current = null;
      if (mountedRef.current) setPlayingUrl(null);
    };
    audioRef.current = audio;
    setPlayingUrl(stem.url);
    void audio.play().catch((error) => {
      console.error(error);
      if (audioRef.current === audio) audioRef.current = null;
      if (mountedRef.current) setPlayingUrl(null);
    });
  }

  function renderStemRack(title: string, items: SplitStem[]) {
    if (!items.length) return null;
    return (
      <section className="splitRack">
        <div className="splitRackTitle">{title}</div>
        <div className="splitStemGrid">
          {items.map((stem) => (
            <div className="splitStemCard" key={`${stem.kind}-${stem.url}`}>
              <div className="splitStemReadout"><b>{stem.label}</b><span>{stem.fileName}</span></div>
              <button className="abPlayButton" onClick={() => togglePreview(stem)}>{playingUrl === stem.url ? <Pause size={13} /> : <Play size={13} />}{playingUrl === stem.url ? "STOP" : "PREVIEW"}</button>
              <button className="utilityButton" onClick={() => downloadUrl(stem.url, stem.fileName)}><Download size={13} /> WAV</button>
            </div>
          ))}
        </div>
      </section>
    );
  }

  return (
    <section className="splitWorkspace">
      <section className="module">
        <div className="moduleTitle">SPLIT // SOURCE SEPARATION</div>
        <div className="resampleIntro">Drop a full song for DRUMS / BASS / VOCALS / OTHER, or feed drum audio directly into the drum splitter. Every source and result is copied into the PROJECT BIN so it can be reused elsewhere without uploading again.</div>

        <div className="splitModeTabs">
          <button disabled={active} className={mode === "full" ? "active" : ""} onClick={() => chooseMode("full")}>FULL SONG / MIX</button>
          <button disabled={active} className={mode === "drums" ? "active" : ""} onClick={() => chooseMode("drums")}>DRUM AUDIO</button>
        </div>

        <div className="splitQualityRow">
          {mode === "full" ? (
            <><span>QUALITY</span><button className={fullProfile === "balanced" ? "utilityButton active" : "utilityButton"} disabled={active} onClick={() => setFullProfile("balanced")}>BALANCED // HTDEMUCS</button><button className={fullProfile === "hq" ? "utilityButton active" : "utilityButton"} disabled={active} onClick={() => setFullProfile("hq")}>HQ REMIX // ROFORMER + DEMUCS</button><small>HQ prioritizes cleaner vocals for sampling/remixing, then separates the instrumental remainder.</small></>
          ) : (
            <><span>QUALITY</span><button className={drumProfile === "standard" ? "utilityButton active" : "utilityButton"} disabled={active} onClick={() => setDrumProfile("standard")}>STANDARD // DSP</button><button className={drumProfile === "hq" ? "utilityButton active" : "utilityButton"} disabled={active} onClick={() => setDrumProfile("hq")}>HQ // MDX23C</button><small>HQ uses the neural DrumSep model; STANDARD remains the CPU-light deterministic fallback.</small></>
          )}
        </div>

        {assets.length > 0 && <div className="splitBinSource"><span>USE MATERIAL FROM PROJECT BIN</span><div className="splitBinChoices">{assets.map((asset) => <button key={asset.id} className={sourceAssetId === asset.id ? "utilityButton active" : "utilityButton"} disabled={active} title={asset.file.name} onClick={() => void runSplit(asset.file, asset)}>{assetKindLabel(asset.kind)} // {asset.label}</button>)}</div></div>}

        <label className="splitDrop">
          <Upload size={22} />
          <b>{file?.name ?? (mode === "full" ? "DROP / CHOOSE FULL SONG" : "DROP / CHOOSE DRUM AUDIO")}</b>
          <span>{mode === "full" ? "DRUMS / BASS / VOCALS / OTHER" : "KICK / SNARE / HI-HAT / CYMBALS / TOMS"}</span>
          <input type="file" accept="audio/*" hidden disabled={active} onChange={(event) => { const next = event.target.files?.[0]; event.currentTarget.value = ""; if (next) void runSplit(next); }} />
        </label>

        {active ? <div className="vintageProgress"><span>{message}</span><div className="progressTrack"><div className="progressBlocks" /></div></div> : <div className="lcdStatus">{message}</div>}
        {lastEngine && <div className="splitEngineReadout">ENGINE // {lastEngine}</div>}
      </section>

      {renderStemRack("01 // BROAD STEMS", stems)}

      {drumsStem && <section className="module splitDrumAction"><div className="moduleTitle">02 // DRUM SUB-SPLIT</div><div className="splitActionRow"><div className="midiWarning">This uses the separated DRUMS stem as a new child asset, then splits it into instrument-specific material. The original song and broad stems remain untouched in the bin. Current drum quality: {drumProfile === "hq" ? "HQ MDX23C" : "STANDARD DSP"}.</div><button className="processButton" disabled={active} onClick={() => void splitDetectedDrums()}><Scissors size={15} /> {splittingDrums ? "SPLITTING…" : "SPLIT DRUMS FURTHER"}</button></div></section>}

      {renderStemRack(stems.length ? "03 // DRUM SUBSTEMS" : "01 // DRUM SUBSTEMS", drumSubstems)}
    </section>
  );
}
