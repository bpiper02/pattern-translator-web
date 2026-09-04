import type { DrumHit, BassNote } from "./audio";

function strBytes(s: string) {
  return Array.from(new TextEncoder().encode(s));
}
function u32(n: number) {
  return [(n>>>24)&255,(n>>>16)&255,(n>>>8)&255,n&255];
}
function u16(n: number) {
  return [(n>>>8)&255,n&255];
}
function vlq(value: number) {
  let buffer = value & 0x7f;
  const bytes = [];
  while ((value >>= 7)) {
    buffer <<= 8;
    buffer |= ((value & 0x7f) | 0x80);
  }
  while (true) {
    bytes.push(buffer & 0xff);
    if (buffer & 0x80) buffer >>= 8; else break;
  }
  return bytes;
}
function makeMidi(events: {tick:number; bytes:number[]}[], bpm: number, name: string) {
  const tpq = 480;
  const mpqn = Math.round(60000000 / bpm);
  const track: number[] = [];
  track.push(...vlq(0), 0xff, 0x03, ...vlq(name.length), ...strBytes(name));
  track.push(...vlq(0), 0xff, 0x51, 0x03, (mpqn>>16)&255, (mpqn>>8)&255, mpqn&255);

  events.sort((a,b)=>a.tick-b.tick);
  let last = 0;
  for (const e of events) {
    track.push(...vlq(Math.max(0, e.tick-last)), ...e.bytes);
    last = e.tick;
  }
  track.push(...vlq(0),0xff,0x2f,0x00);

  const out: number[] = [];
  out.push(...strBytes("MThd"), ...u32(6), ...u16(0), ...u16(1), ...u16(tpq));
  out.push(...strBytes("MTrk"), ...u32(track.length), ...track);
  return new Blob([new Uint8Array(out)], { type: "audio/midi" });
}

export function drumsMidi(hits: DrumHit[], bpm: number) {
  const notes = [36, 38, 42, 46, 39, 37];
  const ev: {tick:number; bytes:number[]}[] = [];
  for (const h of hits) {
    const t = Math.round(h.beat * 480);
    const note = notes[h.lane % notes.length];
    ev.push({tick:t, bytes:[0x99,note,h.velocity]});
    ev.push({tick:t+45, bytes:[0x89,note,0]});
  }
  return makeMidi(ev,bpm,"Pattern Translator Drums");
}

export function bassMidi(notes: BassNote[], bpm: number) {
  const ev: {tick:number; bytes:number[]}[] = [];
  for (const n of notes) {
    const t = Math.round(n.beat * 480);
    const end = t + Math.max(40, Math.round(n.durationBeats * 480));
    const vel = Math.max(50, Math.min(115, Math.round(60 + n.confidence * 55)));
    ev.push({tick:t, bytes:[0x90,n.midi,vel]});
    ev.push({tick:end, bytes:[0x80,n.midi,0]});
  }
  return makeMidi(ev,bpm,"Pattern Translator Bass");
}
