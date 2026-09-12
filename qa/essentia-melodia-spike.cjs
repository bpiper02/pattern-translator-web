const assert = require("node:assert/strict");
const { Essentia, EssentiaWASM } = require("essentia.js");

const SR = 44100;
const HOP = 128;
const essentia = new Essentia(EssentiaWASM);
const midiToHz = (m) => 440 * 2 ** ((m - 69) / 12);
const hzToMidi = (hz) => hz > 0 ? 69 + 12 * Math.log2(hz / 440) : NaN;

function synth(notes, { noise = 0, vibratoCents = 0 } = {}) {
  const out = new Float32Array(Math.ceil(notes.reduce((s, n) => s + n.duration, 0) * SR));
  let cursor = 0, seed = 0x12345678;
  const random = () => ((seed = (1664525 * seed + 1013904223) >>> 0) / 0x100000000);
  for (const note of notes) {
    const count = Math.round(note.duration * SR);
    for (let i = 0; i < count && cursor + i < out.length; i++) {
      if (note.midi == null) { out[cursor + i] = (random() * 2 - 1) * noise; continue; }
      const t = i / SR;
      const env = Math.max(0, Math.min(1, i / (SR * .02), (count - i - 1) / (SR * .03)));
      const cents = vibratoCents * Math.sin(2 * Math.PI * 5.3 * t);
      const f = midiToHz(note.midi) * 2 ** (cents / 1200);
      const phase = 2 * Math.PI * f * t;
      out[cursor + i] = note.amplitude * env * (.58 * Math.sin(phase) + .24 * Math.sin(2 * phase) + .1 * Math.sin(3 * phase)) + (random() * 2 - 1) * noise;
    }
    cursor += count;
  }
  return out;
}

function track(samples) {
  const signal = essentia.arrayToVector(samples);
  let pitch = null, confidence = null;
  try {
    const result = essentia.PitchMelodia(signal, 10, 3, 2048, false, .8, HOP, 1, 40, 1200, 80, 50, 20, .9, .9, 27.5625, 55, SR, 100);
    pitch = result.pitch; confidence = result.pitchConfidence;
    const p = Array.from(essentia.vectorToArray(pitch));
    const c = Array.from(essentia.vectorToArray(confidence));
    return p.map((hz, i) => ({ time: i * HOP / SR, hz, midi: hzToMidi(hz), confidence: c[i] ?? 0 }));
  } finally { pitch?.delete?.(); confidence?.delete?.(); signal.delete?.(); }
}

function score(frames, notes) {
  const edges = []; let t = 0;
  for (const n of notes) { edges.push({ start: t, end: t + n.duration, midi: n.midi }); t += n.duration; }
  let voicedFrames = 0, correct = 0, falseVoiced = 0; const cents = [];
  for (const frame of frames) {
    const expected = edges.find((e) => frame.time >= e.start && frame.time < e.end); if (!expected) continue;
    const voiced = frame.hz > 0 && Number.isFinite(frame.midi) && frame.confidence > 0;
    if (expected.midi == null) { if (voiced) falseVoiced++; continue; }
    voicedFrames++;
    if (!voiced) continue;
    const error = Math.abs(frame.midi - expected.midi) * 100; cents.push(error); if (error <= 50) correct++;
  }
  cents.sort((a,b)=>a-b);
  return { voicedAccuracy: voicedFrames ? correct / voicedFrames : 0, medianCents: cents.length ? cents[Math.floor(cents.length / 2)] : Infinity, falseVoiced };
}

const fixtures = [
  { name:"scale-clean", notes:[60,62,64,67,69].flatMap(m=>[{midi:m,duration:.42,amplitude:.75},{midi:null,duration:.08,amplitude:0}]), options:{} },
  { name:"repeated-note", notes:[60,60,60,60].flatMap(m=>[{midi:m,duration:.34,amplitude:.7},{midi:null,duration:.06,amplitude:0}]), options:{} },
  { name:"vibrato", notes:[{midi:64,duration:1.5,amplitude:.72}], options:{vibratoCents:45} },
  { name:"quiet-noisy", notes:[{midi:57,duration:.7,amplitude:.22},{midi:null,duration:.1,amplitude:0},{midi:60,duration:.7,amplitude:.2}], options:{noise:.008} },
  { name:"octave-jump", notes:[{midi:48,duration:.65,amplitude:.7},{midi:null,duration:.08,amplitude:0},{midi:60,duration:.65,amplitude:.7}], options:{} },
];

const rows = fixtures.map(f => ({ name:f.name, ...score(track(synth(f.notes,f.options)), f.notes) }));
console.table(rows.map(r=>({case:r.name, voiced_accuracy:r.voicedAccuracy.toFixed(3), median_cents:Number.isFinite(r.medianCents)?r.medianCents.toFixed(1):"inf", false_voiced:r.falseVoiced})));
for (const r of rows) { assert.ok(r.voicedAccuracy >= .85, `${r.name}: accuracy ${r.voicedAccuracy.toFixed(3)}`); assert.ok(r.medianCents <= 25, `${r.name}: median ${r.medianCents.toFixed(1)} cents`); }
console.log("ESSENTIA MELODIA SPIKE: PASS");
