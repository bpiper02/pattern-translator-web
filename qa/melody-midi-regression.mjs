import assert from "node:assert/strict";
import { melodyMidi } from "../.qa-midi-dist/midi.js";

const notes = [
  { id: "vm-0", start: 0, duration: 0.5, beat: 0, durationBeats: 1, midi: 60, confidence: 0.95 },
  { id: "vm-1", start: 0.5, duration: 0.25, beat: 1, durationBeats: 0.5, midi: 64, confidence: 0.8 },
  { id: "vm-2", start: 0.75, duration: 0.5, beat: 1.5, durationBeats: 1, midi: 67, confidence: 0.7 },
];

const blob = melodyMidi(notes, 120);
assert.equal(blob.type, "audio/midi");
const bytes = new Uint8Array(await blob.arrayBuffer());
const text = new TextDecoder().decode(bytes);

assert.equal(text.slice(0, 4), "MThd", "missing MIDI header");
assert.ok(text.includes("MTrk"), "missing MIDI track chunk");
assert.ok(text.includes("Pattern Translator Voice Melody"), "missing melody track name");

const noteOns = [];
const noteOffs = [];
for (let index = 0; index < bytes.length - 2; index++) {
  if (bytes[index] === 0x90 && bytes[index + 2] > 0) noteOns.push(bytes[index + 1]);
  if (bytes[index] === 0x80) noteOffs.push(bytes[index + 1]);
}
assert.deepEqual(noteOns, [60, 64, 67]);
assert.deepEqual(noteOffs, [60, 64, 67]);

let tempoFound = false;
for (let index = 0; index < bytes.length - 5; index++) {
  if (
    bytes[index] === 0xff && bytes[index + 1] === 0x51 && bytes[index + 2] === 0x03 &&
    bytes[index + 3] === 0x07 && bytes[index + 4] === 0xa1 && bytes[index + 5] === 0x20
  ) {
    tempoFound = true;
    break;
  }
}
assert.ok(tempoFound, "120 BPM tempo event missing");

console.log("MELODY MIDI REGRESSION: PASS");
