import { useMemo, useRef, useState } from "react";
import { Download, Pause, Play, Scissors, Upload } from "lucide-react";
import {
  splitDrumStem,
  splitFullMix,
  stemUrlToFile,
  type SplitStem,
} from "../separation/client";
import {
  assetKindLabel,
  type AudioAssetKind,
  type NewProjectAudioAsset,
  type ProjectAudioAsset,
} from "../project/assets";

type SplitMode = "full" | "drums";

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

export function SplitWorkspace({ assets, onAddAsset }: SplitWorkspaceProps) {
  const [mode, setMode] = useState<SplitMode>("full");
  const [file, setFile] = useState<File | null>(null);
  const [sourceAssetId, setSourceAssetId] = useState<string | null>(null);
  const [drumsAssetId, setDrumsAssetId] = useState<string | null>(null);
  const [stems, setStems] = useState<SplitStem[]>([]);
  const [drumSubstems, setDrumSubstems] = useState<SplitStem[]>([]);
  const [busy, setBusy] = useState(false);
  const [splittingDrums, setSplittingDrums] = useState(false);
  const [playingUrl, setPlayingUrl] = useState<string | null>(null);
  const [message, setMessage] = useState("DROP A FULL MIX OR DRUM STEM");
  const audioRef = useRef<HTMLAudioElement | null>(null);

  const drumsStem = useMemo(() => stems.find((stem) => stem.kind === "drums") ?? null, [stems]);

  function stopAudio() {
    audioRef.current?.pause();
    audioRef.current = null;
    setPlayingUrl(null);
  }

  function chooseMode(next: SplitMode) {
    stopAudio();
    setMode(next);
    setFile(null);
    setSourceAssetId(null);
    setDrumsAssetId(null);
    setStems([]);
    setDrumSubstems([]);
    setMessage(next === "full" ? "DROP A FULL MIX OR CHOOSE ONE FROM THE BIN" : "DROP DRUM AUDIO OR CHOOSE IT FROM THE BIN");
  }

  function registerSource(nextFile: File, existing?: ProjectAudioAsset) {
    if (existing) return existing;
    return onAddAsset({
      file: nextFile,
      kind: sourceKind(mode),
      label: nextFile.name,
      origin: "upload",
    });
  }

  async function publishStems(resultStems: SplitStem[], parentId: string) {
    const files = await Promise.all(resultStems.map(async (stem) => ({
      stem,
      file: await stemUrlToFile(stem),
    })));

    return files.map(({ stem, file: stemFile }) => onAddAsset({
      file: stemFile,
      kind: stem.kind,
      label: stem.label,
      origin: "split",
      parentId,
    }));
  }

  async function runSplit(nextFile = file, existingAsset?: ProjectAudioAsset) {
    if (!nextFile) return;
    stopAudio();
    setBusy(true);
    setFile(nextFile);
    setStems([]);
    setDrumSubstems([]);
    setDrumsAssetId(null);
    setMessage(mode === "full" ? "SEPARATING FULL MIX…" : "SPLITTING DRUM AUDIO…");

    const sourceAsset = registerSource(nextFile, existingAsset);
    setSourceAssetId(sourceAsset.id);

    try {
      const result = mode === "full" ? await splitFullMix(nextFile) : await splitDrumStem(nextFile);
      if (mode === "full") setStems(result.stems);
      else setDrumSubstems(result.stems);

      const published = await publishStems(result.stems, sourceAsset.id);
      const publishedDrums = published.find((asset) => asset.kind === "drums");
      if (publishedDrums) setDrumsAssetId(publishedDrums.id);

      setMessage(`SPLIT READY — ${result.stems.length} STEMS ADDED TO PROJECT BIN`);
    } catch (error) {
      console.error(error);
      setMessage(`ERROR — ${error instanceof Error ? error.message.toUpperCase() : "SPLIT FAILED"}`);
    } finally {
      setBusy(false);
    }
  }

  async function splitDetectedDrums() {
    if (!drumsStem) return;
    stopAudio();
    setSplittingDrums(true);
    setMessage("SPLITTING DRUMS → KICK / SNARE / HAT / CYMBALS / TOMS…");
    try {
      const drumFile = await stemUrlToFile(drumsStem);
      const result = await splitDrumStem(drumFile);
      setDrumSubstems(result.stems);
      const parentId = drumsAssetId ?? sourceAssetId;
      if (parentId) await publishStems(result.stems, parentId);
      setMessage(`DRUM SUBSTEMS READY — ${result.stems.length} STEMS ADDED TO PROJECT BIN`);
    } catch (error) {
      console.error(error);
      setMessage(`ERROR — ${error instanceof Error ? error.message.toUpperCase() : "DRUM SPLIT FAILED"}`);
    } finally {
      setSplittingDrums(false);
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
      setPlayingUrl(null);
    };
    audioRef.current = audio;
    setPlayingUrl(stem.url);
    void audio.play();
  }

  function renderStemRack(title: string, items: SplitStem[]) {
    if (!items.length) return null;
    return (
      <section className="splitRack">
        <div className="splitRackTitle">{title}</div>
        <div className="splitStemGrid">
          {items.map((stem) => (
            <div className="splitStemCard" key={`${stem.kind}-${stem.url}`}>
              <div className="splitStemReadout">
                <b>{stem.label}</b>
                <span>{stem.fileName}</span>
              </div>
              <button className="abPlayButton" onClick={() => togglePreview(stem)}>
                {playingUrl === stem.url ? <Pause size={13} /> : <Play size={13} />}
                {playingUrl === stem.url ? "STOP" : "PREVIEW"}
              </button>
              <button className="utilityButton" onClick={() => downloadUrl(stem.url, stem.fileName)}>
                <Download size={13} /> WAV
              </button>
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
        <div className="resampleIntro">
          Drop a full song for DRUMS / BASS / VOCALS / OTHER, or feed drum audio directly into the drum splitter. Every source and result is copied into the PROJECT BIN so it can be reused elsewhere without uploading again.
        </div>

        <div className="splitModeTabs">
          <button className={mode === "full" ? "active" : ""} onClick={() => chooseMode("full")}>FULL SONG / MIX</button>
          <button className={mode === "drums" ? "active" : ""} onClick={() => chooseMode("drums")}>DRUM AUDIO</button>
        </div>

        {assets.length > 0 && (
          <div className="splitBinSource">
            <span>USE MATERIAL FROM PROJECT BIN</span>
            <div className="splitBinChoices">
              {assets.map((asset) => (
                <button
                  key={asset.id}
                  className={sourceAssetId === asset.id ? "utilityButton active" : "utilityButton"}
                  disabled={busy || splittingDrums}
                  title={asset.file.name}
                  onClick={() => void runSplit(asset.file, asset)}
                >
                  {assetKindLabel(asset.kind)} // {asset.label}
                </button>
              ))}
            </div>
          </div>
        )}

        <label className="splitDrop">
          <Upload size={22} />
          <b>{file?.name ?? (mode === "full" ? "DROP / CHOOSE FULL SONG" : "DROP / CHOOSE DRUM AUDIO")}</b>
          <span>{mode === "full" ? "DRUMS / BASS / VOCALS / OTHER" : "KICK / SNARE / HI-HAT / CYMBALS / TOMS"}</span>
          <input
            type="file"
            accept="audio/*"
            hidden
            disabled={busy || splittingDrums}
            onChange={(event) => {
              const next = event.target.files?.[0];
              if (!next) return;
              void runSplit(next);
              event.currentTarget.value = "";
            }}
          />
        </label>

        {(busy || splittingDrums) ? (
          <div className="vintageProgress">
            <span>{message}</span>
            <div className="progressTrack"><div className="progressBlocks" /></div>
          </div>
        ) : (
          <div className="lcdStatus">{message}</div>
        )}
      </section>

      {renderStemRack("01 // BROAD STEMS", stems)}

      {drumsStem && (
        <section className="module splitDrumAction">
          <div className="moduleTitle">02 // DRUM SUB-SPLIT</div>
          <div className="splitActionRow">
            <div className="midiWarning">This uses the separated DRUMS stem as a new child asset, then splits it into instrument-specific material. The original song and broad stems remain untouched in the bin.</div>
            <button className="processButton" disabled={splittingDrums || busy} onClick={() => void splitDetectedDrums()}>
              <Scissors size={15} /> {splittingDrums ? "SPLITTING…" : "SPLIT DRUMS FURTHER"}
            </button>
          </div>
        </section>
      )}

      {renderStemRack(stems.length ? "03 // DRUM SUBSTEMS" : "01 // DRUM SUBSTEMS", drumSubstems)}
    </section>
  );
}
