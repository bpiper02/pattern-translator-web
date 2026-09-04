export type DrumHit = {
  id: string;
  time: number;
  beat: number;
  lane: number;
  velocity: number;
};

export type BassNote = {
  id: string;
  start: number;
  duration: number;
  beat: number;
  durationBeats: number;
  midi: number;
  confidence: number;
};

export async function decodeAudio(file: File): Promise<AudioBuffer> {
  const ctx = new AudioContext();
  const ab = await file.arrayBuffer();
  const buffer = await ctx.decodeAudioData(ab.slice(0));
  await ctx.close();
  return buffer;
}

export function monoSamples(buffer: AudioBuffer): Float32Array {
  const len = buffer.length;
  const out = new Float32Array(len);
  for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
    const src = buffer.getChannelData(ch);
    for (let i = 0; i < len; i++) out[i] += src[i] / buffer.numberOfChannels;
  }
  return out;
}

export function estimateBpm(samples: Float32Array, sr: number): number {
  // Envelope based pulse estimate. Deliberately editable in UI because half/double time is common.
  const hop = Math.max(128, Math.floor(sr / 200));
  const env: number[] = [];
  for (let i = 0; i < samples.length; i += hop) {
    let sum = 0;
    const end = Math.min(samples.length, i + hop);
    for (let j = i; j < end; j++) sum += samples[j] * samples[j];
    env.push(Math.sqrt(sum / Math.max(1, end - i)));
  }

  const diff = env.map((v, i) => Math.max(0, v - (i ? env[i - 1] : v)));
  const rate = sr / hop;
  let bestBpm = 120;
  let bestScore = -Infinity;

  for (let bpm = 55; bpm <= 180; bpm += 0.5) {
    const lag = Math.max(1, Math.round((60 / bpm) * rate));
    let score = 0;
    for (let i = lag; i < diff.length; i++) score += diff[i] * diff[i - lag];
    if (score > bestScore) {
      bestScore = score;
      bestBpm = bpm;
    }
  }
  return Math.round(bestBpm * 10) / 10;
}

function localFeatures(samples: Float32Array, sr: number, center: number) {
  const start = Math.max(0, center);
  const end = Math.min(samples.length, start + Math.floor(sr * 0.12));
  let rms = 0;
  let zc = 0;
  let peak = 0;
  let prev = samples[start] || 0;

  for (let i = start; i < end; i++) {
    const x = samples[i];
    rms += x * x;
    peak = Math.max(peak, Math.abs(x));
    if ((x >= 0) !== (prev >= 0)) zc++;
    prev = x;
  }
  const n = Math.max(1, end - start);
  return { rms: Math.sqrt(rms / n), zcr: zc / n, peak };
}

function quantizeBeat(beat: number, step: number | null) {
  return step ? Math.round(beat / step) * step : beat;
}

export function detectDrums(
  samples: Float32Array,
  sr: number,
  bpm: number,
  sensitivity: number,
  lanes: number,
  quantizeStep: number | null
): DrumHit[] {
  const frame = Math.max(256, Math.floor(sr * 0.012));
  const hop = Math.floor(frame / 2);
  const energy: number[] = [];

  for (let i = 0; i + frame < samples.length; i += hop) {
    let e = 0;
    for (let j = 0; j < frame; j++) e += Math.abs(samples[i + j]);
    energy.push(e / frame);
  }

  const smooth = energy.map((_, i) => {
    const a = Math.max(0, i - 2), b = Math.min(energy.length, i + 3);
    let s = 0;
    for (let k = a; k < b; k++) s += energy[k];
    return s / Math.max(1, b - a);
  });

  const mean = smooth.reduce((a, b) => a + b, 0) / Math.max(1, smooth.length);
  const variance = smooth.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, smooth.length);
  const sd = Math.sqrt(variance);
  const threshold = mean + sd * (1.7 - sensitivity * 1.35);

  const raw: { sample: number; strength: number }[] = [];
  const minGapFrames = Math.max(1, Math.round((sr * 0.045) / hop));

  for (let i = 1; i < smooth.length - 1; i++) {
    if (smooth[i] > threshold && smooth[i] >= smooth[i - 1] && smooth[i] > smooth[i + 1]) {
      const prev = raw[raw.length - 1];
      if (!prev || i - prev.sample / hop >= minGapFrames) {
        raw.push({ sample: i * hop, strength: smooth[i] });
      } else if (smooth[i] > prev.strength) {
        raw[raw.length - 1] = { sample: i * hop, strength: smooth[i] };
      }
    }
  }

  if (!raw.length) return [];
  const feats = raw.map(r => localFeatures(samples, sr, r.sample));
  const rmsVals = feats.map(f => f.rms);
  const zVals = feats.map(f => f.zcr);
  const peakVals = feats.map(f => f.peak);

  const minMax = (v: number[], x: number) => {
    const lo = Math.min(...v), hi = Math.max(...v);
    return hi === lo ? 0.5 : (x - lo) / (hi - lo);
  };

  // Lightweight unsupervised-ish lane assignment:
  // combine rough transient brightness + body into a scalar and bucket by quantiles.
  const scores = feats.map(f =>
    0.65 * minMax(zVals, f.zcr) +
    0.20 * (1 - minMax(rmsVals, f.rms)) +
    0.15 * minMax(peakVals, f.peak)
  );
  const sorted = [...scores].sort((a, b) => a - b);

  const laneOf = (score: number) => {
    for (let lane = 0; lane < lanes - 1; lane++) {
      const idx = Math.floor(((lane + 1) / lanes) * (sorted.length - 1));
      if (score <= sorted[idx]) return lane;
    }
    return lanes - 1;
  };

  const firstTime = raw[0].sample / sr;
  const maxStrength = Math.max(...raw.map(r => r.strength));

  return raw.map((r, i) => {
    const time = r.sample / sr;
    const beat = quantizeBeat((time - firstTime) * bpm / 60, quantizeStep);
    return {
      id: `d-${i}-${r.sample}`,
      time,
      beat,
      lane: laneOf(scores[i]),
      velocity: Math.max(30, Math.min(127, Math.round(35 + (r.strength / maxStrength) * 92)))
    };
  });
}

function autocorrelatePitch(segment: Float32Array, sr: number): { midi: number; confidence: number } | null {
  let rms = 0;
  for (let i = 0; i < segment.length; i++) rms += segment[i] * segment[i];
  rms = Math.sqrt(rms / Math.max(1, segment.length));
  if (rms < 0.01) return null;

  const minHz = 35;
  const maxHz = 350;
  const minLag = Math.floor(sr / maxHz);
  const maxLag = Math.min(Math.floor(sr / minHz), segment.length - 2);

  let bestLag = -1;
  let best = -Infinity;
  let zeroLag = 0;
  for (let i = 0; i < segment.length; i++) zeroLag += segment[i] * segment[i];

  for (let lag = minLag; lag <= maxLag; lag++) {
    let sum = 0;
    for (let i = 0; i < segment.length - lag; i++) sum += segment[i] * segment[i + lag];
    if (sum > best) {
      best = sum;
      bestLag = lag;
    }
  }

  if (bestLag <= 0 || zeroLag <= 0) return null;
  const hz = sr / bestLag;
  const midi = Math.round(69 + 12 * Math.log2(hz / 440));
  const confidence = Math.max(0, Math.min(1, best / zeroLag));
  return { midi, confidence };
}

export function detectBass(
  samples: Float32Array,
  sr: number,
  bpm: number,
  quantizeStep: number | null
): BassNote[] {
  const win = Math.floor(sr * 0.09);
  const hop = Math.floor(sr * 0.025);
  const rms: number[] = [];
  for (let i = 0; i + win < samples.length; i += hop) {
    let e = 0;
    for (let j = 0; j < win; j++) e += samples[i + j] * samples[i + j];
    rms.push(Math.sqrt(e / win));
  }
  if (!rms.length) return [];
  const mean = rms.reduce((a,b)=>a+b,0)/rms.length;
  const starts: number[] = [];
  for (let i = 1; i < rms.length; i++) {
    const rise = rms[i] - rms[i-1];
    if (rms[i] > mean * 0.8 && rise > mean * 0.18) {
      const sample = i * hop;
      if (!starts.length || sample - starts[starts.length - 1] > sr * 0.08) starts.push(sample);
    }
  }
  if (!starts.length) starts.push(0);

  const first = starts[0] / sr;
  const out: BassNote[] = [];

  for (let i = 0; i < starts.length; i++) {
    const s = starts[i];
    const e = i + 1 < starts.length ? starts[i+1] : Math.min(samples.length, s + Math.floor(sr * 0.6));
    const length = Math.min(e - s, Math.floor(sr * 0.35));
    if (length < 512) continue;
    const pitch = autocorrelatePitch(samples.slice(s, s + length), sr);
    if (!pitch) continue;
    const startSec = s / sr;
    const endSec = Math.max(startSec + 0.06, e / sr);
    const beat = quantizeBeat((startSec - first) * bpm / 60, quantizeStep);
    const endBeat = quantizeBeat((endSec - first) * bpm / 60, quantizeStep);
    out.push({
      id: `b-${i}-${s}`,
      start: startSec,
      duration: endSec - startSec,
      beat,
      durationBeats: Math.max(0.125, endBeat - beat),
      midi: pitch.midi,
      confidence: pitch.confidence
    });
  }
  return out;
}

export function transposeNotes(notes: BassNote[], semitones: number): BassNote[] {
  return notes.map(n => ({ ...n, midi: Math.max(0, Math.min(127, n.midi + semitones)) }));
}

export function midiNoteName(n: number): string {
  const names = ["C","C#","D","D#","E","F","F#","G","G#","A","A#","B"];
  return `${names[((n % 12) + 12) % 12]}${Math.floor(n / 12) - 1}`;
}
