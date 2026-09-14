import assert from "node:assert/strict";
import fs from "node:fs";
import { detectLongSourceSamplerHits } from "../.qa-long-source-dist/longSourceSampler.js";

const sampleRate = 44_100;
const durationSeconds = 180;
const samples = new Float32Array(sampleRate * durationSeconds);

// Dense three-minute fixture: alternating sharp and noisy transients every
// quarter second. This is intentionally much longer than the high-fidelity
// browser/WASM path should ever receive.
for (let event = 0, time = 0.25; time < durationSeconds - 0.25; event++, time += 0.25) {
  const start = Math.floor(time * sampleRate);
  const length = Math.floor(sampleRate * 0.012);
  const amplitude = event % 4 === 0 ? 0.95 : event % 4 === 1 ? 0.72 : event % 4 === 2 ? 0.55 : 0.42;
  for (let i = 0; i < length && start + i < samples.length; i++) {
    const envelope = 1 - i / length;
    const carrier = event % 2 === 0
      ? Math.sin(2 * Math.PI * 90 * i / sampleRate)
      : Math.sin(2 * Math.PI * 3_800 * i / sampleRate);
    samples[start + i] += amplitude * envelope * carrier;
  }
}

const started = performance.now();
const hits = detectLongSourceSamplerHits(samples, sampleRate, 120);
const elapsedMs = performance.now() - started;

assert.ok(hits.length > 100, `expected many usable transients, got ${hits.length}`);
assert.ok(hits.length <= 2048, `long-source detector must stay bounded, got ${hits.length}`);
assert.ok(hits.every((hit) => Number.isFinite(hit.time) && hit.time >= 0 && hit.time <= durationSeconds));
assert.ok(hits.every((hit) => Number.isInteger(hit.lane) && hit.lane >= 0 && hit.lane <= 3));
assert.ok(hits.every((hit) => Number.isFinite(hit.velocity) && hit.velocity >= 42 && hit.velocity <= 127));

const autoKitSource = fs.readFileSync("src/audio/autoDrumKit.ts", "utf8");
assert.match(autoKitSource, /LONG_SOURCE_SECONDS\s*=\s*45/);
assert.match(autoKitSource, /source\.duration\s*>\s*LONG_SOURCE_SECONDS/);
assert.match(autoKitSource, /detectLongSourceSamplerHits/);

console.log(`LONG SOURCE SAMPLER REGRESSION: PASS (${hits.length} hits, ${elapsedMs.toFixed(0)} ms)`);
