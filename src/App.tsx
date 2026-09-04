import { useEffect, useMemo, useRef, useState } from "react";
import {
  Upload, Play, Pause, Download, Drum, Music2, RotateCcw,
  Sparkles, SlidersHorizontal, Plus, Minus, Trash2
} from "lucide-react";
import {
  decodeAudio, monoSamples, estimateBpm, detectDrums, detectBass,
  transposeNotes, midiNoteName, type DrumHit, type BassNote
} from "./audio";
import { drumsMidi, bassMidi } from "./midi";

type Mode = "drums" | "bass";
const ROOTS = ["C","C#","D","D#","E","F","F#","G","G#","A","A#","B"];

function downloadBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 500);
}

function Waveform({ samples, currentRatio }: { samples: Float32Array | null; currentRatio: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current;
    if (!c || !samples) return;
    const dpr = Math.max(1, window.devicePixelRatio || 1);
    const rect = c.getBoundingClientRect();
    c.width = rect.width * dpr;
    c.height = rect.height * dpr;
    const ctx = c.getContext("2d")!;
    ctx.scale(dpr,dpr);
    ctx.clearRect(0,0,rect.width,rect.height);

    const mid = rect.height/2;
    const step = Math.ceil(samples.length / rect.width);
    ctx.strokeStyle = "rgba(255,255,255,.62)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x=0; x<rect.width; x++) {
      let min=1,max=-1;
      const start=x*step, end=Math.min(samples.length,start+step);
      for (let i=start;i<end;i++){ const v=samples[i]; if(v<min)min=v;if(v>max)max=v; }
      ctx.moveTo(x, mid + min*mid*.82);
      ctx.lineTo(x, mid + max*mid*.82);
    }
    ctx.stroke();

    if (currentRatio > 0) {
      ctx.strokeStyle = "rgba(255,255,255,.95)";
      ctx.lineWidth = 2;
      const x = rect.width * currentRatio;
      ctx.beginPath(); ctx.moveTo(x,0); ctx.lineTo(x,rect.height); ctx.stroke();
    }
  }, [samples,currentRatio]);

  return <canvas ref={ref} className="wave" />;
}

function DrumGrid({ hits, lanes, onToggle }: {
  hits: DrumHit[]; lanes: number; onToggle: (lane:number, beat:number)=>void
}) {
  const maxBeat = Math.max(8, Math.ceil((Math.max(0,...hits.map(h=>h.beat))+1)/4)*4);
  const steps = maxBeat*4;
  return (
    <div className="gridScroll">
      <div className="drumGrid" style={{minWidth: Math.max(760, steps*28)}}>
        <div className="barRow">
          <div className="laneLabel ghost"></div>
          {Array.from({length:maxBeat},(_,b)=>
            <div className={"beatLabel "+(b%4===0?"barStart":"")} key={b}>{(b%4)+1}</div>
          )}
        </div>
        {Array.from({length:lanes},(_,lane)=>
          <div className="laneRow" key={lane}>
            <div className="laneLabel">{String.fromCharCode(65+lane)}</div>
            <div className="steps">
              {Array.from({length:steps},(_,i)=>{
                const beat=i/4;
                const hit=hits.find(h=>h.lane===lane && Math.abs(h.beat-beat)<0.06);
                return <button
                  key={i}
                  className={"step "+(i%4===0?"quarter ":"")+(hit?"active":"")}
                  title={`Lane ${String.fromCharCode(65+lane)} · beat ${beat.toFixed(2)}`}
                  onClick={()=>onToggle(lane,beat)}
                />;
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function BassGrid({ notes, onDelete }: { notes:BassNote[]; onDelete:(id:string)=>void }) {
  if (!notes.length) return <div className="emptyGrid">No bass notes detected yet.</div>;
  const min = Math.max(24, Math.min(...notes.map(n=>n.midi))-2);
  const max = Math.min(72, Math.max(...notes.map(n=>n.midi))+2);
  const maxBeat = Math.max(8, Math.ceil((Math.max(...notes.map(n=>n.beat+n.durationBeats))+1)/4)*4);
  const rows = max-min+1;
  return <div className="gridScroll">
    <div className="pianoGrid" style={{minWidth: Math.max(760,maxBeat*112), height: rows*28}}>
      {Array.from({length:rows},(_,r)=>{
        const midi=max-r;
        return <div className="pitchRow" key={midi} style={{top:r*28}}>
          <span>{midiNoteName(midi)}</span>
        </div>
      })}
      {Array.from({length:maxBeat*4},(_,i)=>
        <div className={"vline "+(i%4===0?"major":"")} key={i} style={{left:`${(i/(maxBeat*4))*100}%`}}/>
      )}
      {notes.map(n=>{
        const top=(max-n.midi)*28+4;
        const left=(n.beat/maxBeat)*100;
        const width=Math.max(.7,(n.durationBeats/maxBeat)*100);
        return <button className="bassNote" key={n.id}
          style={{top,left:`${left}%`,width:`${width}%`}}
          onClick={()=>onDelete(n.id)}
          title={`${midiNoteName(n.midi)} · ${n.beat.toFixed(2)} beats · click to remove`}
        >{midiNoteName(n.midi)}</button>
      })}
    </div>
  </div>
}

export function App() {
  const [mode,setMode]=useState<Mode>("drums");
  const [file,setFile]=useState<File|null>(null);
  const [buffer,setBuffer]=useState<AudioBuffer|null>(null);
  const [samples,setSamples]=useState<Float32Array|null>(null);
  const [sourceBpm,setSourceBpm]=useState(122);
  const [targetBpm,setTargetBpm]=useState(61);
  const [sensitivity,setSensitivity]=useState(.55);
  const [lanes,setLanes]=useState(3);
  const [quantize,setQuantize]=useState(.25);
  const [drumHits,setDrumHits]=useState<DrumHit[]>([]);
  const [bassNotes,setBassNotes]=useState<BassNote[]>([]);
  const [sourceRoot,setSourceRoot]=useState("C");
  const [targetRoot,setTargetRoot]=useState("F#");
  const [busy,setBusy]=useState(false);
  const [drag,setDrag]=useState(false);
  const [playing,setPlaying]=useState(false);
  const [ratio,setRatio]=useState(0);
  const audioRef=useRef<HTMLAudioElement|null>(null);
  const inputRef=useRef<HTMLInputElement|null>(null);

  const semitone = ROOTS.indexOf(targetRoot)-ROOTS.indexOf(sourceRoot);
  const transformedBass = useMemo(()=>transposeNotes(bassNotes,semitone),[bassNotes,semitone]);

  async function ingest(f:File) {
    setBusy(true);
    try {
      const b=await decodeAudio(f);
      const s=monoSamples(b);
      setFile(f); setBuffer(b); setSamples(s);
      setSourceBpm(estimateBpm(s,b.sampleRate));
      setDrumHits([]); setBassNotes([]);
    } catch(e) {
      alert("Couldn't read that file. WAV/MP3/M4A usually work best in Chrome.");
    } finally { setBusy(false); }
  }

  async function analyze() {
    if(!samples||!buffer)return;
    setBusy(true);
    await new Promise(r=>setTimeout(r,40));
    if(mode==="drums"){
      setDrumHits(detectDrums(samples,buffer.sampleRate,sourceBpm,sensitivity,lanes,quantize));
    } else {
      setBassNotes(detectBass(samples,buffer.sampleRate,sourceBpm,quantize));
    }
    setBusy(false);
  }

  function toggleDrum(lane:number,beat:number){
    const existing=drumHits.find(h=>h.lane===lane&&Math.abs(h.beat-beat)<.06);
    if(existing)setDrumHits(drumHits.filter(h=>h.id!==existing.id));
    else setDrumHits([...drumHits,{id:crypto.randomUUID(),time:beat*60/sourceBpm,beat,lane,velocity:95}].sort((a,b)=>a.beat-b.beat));
  }

  function exportMidi(){
    if(mode==="drums"){
      downloadBlob(drumsMidi(drumHits,targetBpm),`drums-${targetBpm}bpm.mid`);
    }else{
      downloadBlob(bassMidi(transformedBass,targetBpm),`bass-${targetRoot}-${targetBpm}bpm.mid`);
    }
  }

  function playOriginal(){
    if(!file)return;
    if(!audioRef.current){
      audioRef.current=new Audio(URL.createObjectURL(file));
      audioRef.current.ontimeupdate=()=>{
        const a=audioRef.current!;
        setRatio(a.duration? a.currentTime/a.duration:0);
      };
      audioRef.current.onended=()=>{setPlaying(false);setRatio(0)};
    }
    const a=audioRef.current;
    if(playing){a.pause();setPlaying(false)} else {a.play();setPlaying(true)}
  }

  return <main>
    <header className="topbar">
      <div>
        <div className="brand">Pattern Translator</div>
        <div className="subtitle">Reference groove → your BPM/key → editable MIDI.</div>
      </div>
      <div className="privacy">LOCAL PROCESSING</div>
    </header>

    <section className="hero">
      <div className="modeSwitch">
        <button className={mode==="drums"?"selected":""} onClick={()=>setMode("drums")}><Drum size={17}/> Drums</button>
        <button className={mode==="bass"?"selected":""} onClick={()=>setMode("bass")}><Music2 size={17}/> Bass</button>
      </div>

      {!file ? <div
        className={"drop "+(drag?"drag":"")}
        onDragOver={e=>{e.preventDefault();setDrag(true)}}
        onDragLeave={()=>setDrag(false)}
        onDrop={e=>{e.preventDefault();setDrag(false); const f=e.dataTransfer.files[0]; if(f)ingest(f)}}
        onClick={()=>inputRef.current?.click()}
      >
        <input ref={inputRef} type="file" accept="audio/*" hidden onChange={e=>e.target.files?.[0]&&ingest(e.target.files[0])}/>
        <div className="dropIcon"><Upload size={24}/></div>
        <strong>Drop a {mode==="drums"?"drum":"bass"} stem</strong>
        <span>WAV, MP3, M4A • processed in your browser</span>
      </div> :
      <>
        <div className="transport">
          <button className="playBtn" onClick={playOriginal}>{playing?<Pause size={18}/>:<Play size={18}/>}</button>
          <div className="fileMeta">
            <strong>{file.name}</strong>
            <span>{buffer?.duration.toFixed(1)}s · {buffer?.sampleRate.toLocaleString()} Hz</span>
          </div>
          <button className="textBtn" onClick={()=>{setFile(null);setSamples(null);setBuffer(null);setDrumHits([]);setBassNotes([])}}><RotateCcw size={15}/> Replace</button>
        </div>
        <Waveform samples={samples} currentRatio={ratio}/>
      </>}

      <div className="controls">
        <div className="controlCard">
          <label>SOURCE BPM</label>
          <input type="number" value={sourceBpm} onChange={e=>setSourceBpm(+e.target.value)} min="20" max="300" step=".1"/>
          <small>Editable for half/double-time mistakes</small>
        </div>
        <div className="arrow">→</div>
        <div className="controlCard target">
          <label>TARGET BPM</label>
          <input type="number" value={targetBpm} onChange={e=>setTargetBpm(+e.target.value)} min="20" max="300" step=".1"/>
          <small>MIDI timing is rebuilt, not stretched</small>
        </div>
        {mode==="bass" && <>
          <div className="keyBox">
            <label>SOURCE ROOT</label>
            <select value={sourceRoot} onChange={e=>setSourceRoot(e.target.value)}>{ROOTS.map(r=><option key={r}>{r}</option>)}</select>
          </div>
          <div className="arrow">→</div>
          <div className="keyBox targetKey">
            <label>TARGET ROOT</label>
            <select value={targetRoot} onChange={e=>setTargetRoot(e.target.value)}>{ROOTS.map(r=><option key={r}>{r}</option>)}</select>
          </div>
        </>}
      </div>

      <div className="analysisBar">
        <div className="analysisControls">
          {mode==="drums" && <>
            <label>LANES <b>{lanes}</b><input type="range" min="1" max="6" value={lanes} onChange={e=>setLanes(+e.target.value)}/></label>
            <label>SENSITIVITY <b>{Math.round(sensitivity*100)}%</b><input type="range" min="0" max="1" step=".05" value={sensitivity} onChange={e=>setSensitivity(+e.target.value)}/></label>
          </>}
          <label>GRID
            <select value={quantize} onChange={e=>setQuantize(+e.target.value)}>
              <option value=".25">1/16</option>
              <option value=".5">1/8</option>
              <option value=".125">1/32</option>
              <option value="1">1/4</option>
            </select>
          </label>
        </div>
        <button className="analyzeBtn" disabled={!file||busy} onClick={analyze}>
          <Sparkles size={17}/>{busy?"Analyzing…":`Analyze ${mode}`}
        </button>
      </div>
    </section>

    <section className="editor">
      <div className="editorHead">
        <div>
          <span className="eyebrow">PATTERN</span>
          <h2>{mode==="drums"?"Drum lanes":"Bass piano roll"}</h2>
          <p>{mode==="drums"
            ?"A/B/C are repeating sound classes. Click any cell to add or remove a hit."
            :"Detected notes are transposed non-destructively to the target root. Click a note to remove it."}</p>
        </div>
        <div className="editorActions">
          <button onClick={()=>mode==="drums"?setDrumHits([]):setBassNotes([])}><Trash2 size={15}/> Clear</button>
          <button className="export" disabled={mode==="drums"?drumHits.length===0:transformedBass.length===0} onClick={exportMidi}><Download size={16}/> Export MIDI</button>
        </div>
      </div>

      {mode==="drums"
        ? <DrumGrid hits={drumHits} lanes={lanes} onToggle={toggleDrum}/>
        : <BassGrid notes={transformedBass} onDelete={id=>setBassNotes(bassNotes.filter(n=>n.id!==id))}/>
      }

      <div className="statusStrip">
        <span><SlidersHorizontal size={14}/> {mode==="drums"?`${drumHits.length} hits · ${lanes} lanes`:`${transformedBass.length} notes · ${semitone>=0?"+":""}${semitone} semitones`}</span>
        <span>Target: <b>{targetBpm} BPM{mode==="bass"?` · ${targetRoot}`:""}</b></span>
      </div>
    </section>

    <footer>
      <span>V0.1 · local-first · no uploads</span>
      <span>Next: reference-song stem extraction + lane remapping</span>
    </footer>
  </main>
}
