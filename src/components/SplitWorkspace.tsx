import { useMemo, useRef, useState } from "react";
import { Download, Pause, Play, Scissors, Upload } from "lucide-react";
import {
  splitDrumStem,
  splitFullMix,
  stemUrlToFile,
  type SplitStem,
} from "../separation/client";

type SplitMode = "full" | "drums";

function downloadUrl(url: string, fileName: string) {
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.target = "_blank";
  anchor.rel = "noreferrer";
  anchor.click();
}

export function SplitWorkspace() {
  const [mode, setMode] = useState<SplitMode>("full");
  const [file, setFile] = useState<File | null>(null);
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
    setStems([]);
    setDrumSubstems([]);
    setMessage(next === "full" ? "DROP A FULL MIX" : "DROP AN ISOLATED DRUM STEM");
  }

  async function runSplit(nextFile = file) {
    if (!nextFile) return;
    stopAudio();
    setBusy(true);
    setStems([]);
    setDrumSubstems([]);
    setMessage(mode === "full" ? "SEPARATING FULL MIX…" : "SPLITTING DRUM STEM…");

    try {
      const result = mode === "full" ? await splitFullMix(nextFile) : await splitDrumStem(nextFile);
      if (mode === "full") setStems(result.stems);
      else setDrumSubstems(result.stems);
      setMessage(`SPLIT READY — ${result.stems.length} STEMS`);
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
      setMessage(`DRUM SUBSTEMS READY — ${result.stems.length} STEMS`);
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
          Separate a full mix into broad stems, or split an already-isolated drum stem into real drum sub-stems before pattern detection. Preview uses the separated audio itself so timbre is preserved.
        </div>

        <div className="splitModeTabs">
          <button className={mode === "full" ? "active" : ""} onClick={() => chooseMode("full")}>FULL MIX</button>
          <button className={mode === "drums" ? "active" : ""} onClick={() => chooseMode("drums")}>DRUM STEM</button>
        </div>

        <label className="splitDrop">
          <Upload size={22} />
          <b>{file?.name ?? (mode === "full" ? "DROP / CHOOSE FULL MIX" : "DROP / CHOOSE DRUM STEM")}</b>
          <span>{mode === "full" ? "DRUMS / BASS / VOCALS / OTHER" : "KICK / SNARE / HI-HAT / CYMBALS / TOMS"}</span>
          <input
            type="file"
            accept="audio/*"
            hidden
            disabled={busy || splittingDrums}
            onChange={(event) => {
              const next = event.target.files?.[0];
              if (!next) return;
              setFile(next);
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
            <div className="midiWarning">Use the separated DRUMS audio as the source for instrument-specific splitting. This avoids guessing kick/snare/hat identity from one composite waveform.</div>
            <button className="processButton" disabled={splittingDrums || busy} onClick={() => void splitDetectedDrums()}>
              <Scissors size={15} /> {splittingDrums ? "SPLITTING…" : "SPLIT DRUMS FURTHER"}
            </button>
          </div>
        </section>
      )}

      {renderStemRack(stems.length ? "03 // DRUM SUBSTEMS" : "01 // DRUM SUBSTEMS", drumSubstems)}

      {(stems.length || drumSubstems.length) ? (
        <section className="module">
          <div className="moduleTitle">PREVIEW RULE</div>
          <div className="midiWarning">These previews play the separated WAV stems directly. No generic MIDI kit or reconstructed placeholder is used here. Pattern detection should run after separation, per stem, so the kick row comes from kick audio, the snare row from snare audio, and so on.</div>
        </section>
      ) : null}
    </section>
  );
}
