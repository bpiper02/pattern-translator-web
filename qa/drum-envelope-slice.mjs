import assert from "node:assert/strict";
import { applySafetyFadeOut, findAdaptiveDrumSliceBounds } from "../.qa-envelope-dist/drumEnvelopeSlice.js";

const SR = 8_000;

function blank(seconds = 3) {
  return new Float32Array(Math.ceil(seconds * SR));
}

function addSineNoise(samples, amplitude = 0.0015, frequency = 317) {
  for (let i = 0; i < samples.length; i++) {
    samples[i] += amplitude * Math.sin(2 * Math.PI * frequency * i / SR);
  }
}

function addDecay(samples, startSeconds, durationSeconds, amplitude, decayRate, frequency = 120) {
  const start = Math.round(startSeconds * SR);
  const count = Math.round(durationSeconds * SR);
  for (let i = 0; i < count && start + i < samples.length; i++) {
    const t = i / SR;
    const envelope = amplitude * Math.exp(-decayRate * t);
    samples[start + i] += envelope * Math.sin(2 * Math.PI * frequency * t);
  }
}

// Dry kick: adaptive end should follow the actual decay, not a fixed 420 ms table.
{
  const samples = blank();
  addSineNoise(samples);
  addDecay(samples, 0.50, 0.30, 0.95, 13, 85);
  const bounds = findAdaptiveDrumSliceBounds(samples, SR, 0.50);
  assert.ok(bounds.startSeconds <= 0.50 && bounds.startSeconds >= 0.49);
  assert.ok(bounds.endSeconds > 0.68 && bounds.endSeconds < 0.90, `dry end=${bounds.endSeconds}`);
}

// Long open-hat/reverb style tail should survive far beyond the previous 200 ms hat cap.
{
  const samples = blank();
  addSineNoise(samples);
  addDecay(samples, 0.40, 1.05, 0.80, 4.2, 2_200);
  const bounds = findAdaptiveDrumSliceBounds(samples, SR, 0.40);
  assert.ok(bounds.endSeconds > 1.15, `long tail was cut at ${bounds.endSeconds}`);
  assert.ok(bounds.endSeconds < 1.75, `long tail ran away to ${bounds.endSeconds}`);
}

// A delayed echo after an energy dip must still count as meaningful tail energy.
{
  const samples = blank();
  addSineNoise(samples);
  addDecay(samples, 0.40, 0.14, 0.90, 18, 180);
  addDecay(samples, 0.86, 0.14, 0.18, 10, 180);
  const bounds = findAdaptiveDrumSliceBounds(samples, SR, 0.40);
  assert.ok(bounds.endSeconds > 0.94, `delay echo was lost at ${bounds.endSeconds}`);
}

// A genuinely later transient remains a hard cap even if the first hit still rings.
{
  const samples = blank();
  addSineNoise(samples);
  addDecay(samples, 0.50, 0.80, 0.90, 4.5, 150);
  const nextEvent = 0.78;
  const bounds = findAdaptiveDrumSliceBounds(samples, SR, 0.50, nextEvent);
  assert.ok(bounds.endSeconds <= nextEvent - 0.003, `slice crossed next event: ${bounds.endSeconds}`);
  assert.ok(bounds.endSeconds > 0.65, `slice was over-truncated: ${bounds.endSeconds}`);
}

// Local noise floor should prevent quiet background texture from stretching to maxTail.
{
  const samples = blank();
  addSineNoise(samples, 0.004);
  addDecay(samples, 0.60, 0.22, 0.65, 15, 105);
  const bounds = findAdaptiveDrumSliceBounds(samples, SR, 0.60);
  assert.ok(bounds.noiseFloor > 0);
  assert.ok(bounds.endSeconds < 1.10, `noise floor caused runaway tail: ${bounds.endSeconds}`);
}

// Click-prevention fade touches only the tail and reaches zero.
{
  const samples = new Float32Array(100).fill(1);
  applySafetyFadeOut(samples, 1_000, 0.01);
  assert.equal(samples[89], 1);
  assert.ok(samples[90] < 1 && samples[90] > 0);
  assert.equal(samples[99], 0);
}

const empty = findAdaptiveDrumSliceBounds(new Float32Array(), SR, 0.5);
assert.deepEqual(empty, { startSeconds: 0, endSeconds: 0, noiseFloor: 0, peakRms: 0, threshold: 0 });

console.log("DRUM ENVELOPE SLICE REGRESSION: PASS");
