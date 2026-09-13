import assert from "node:assert/strict";
import { classifyDrumTimbres } from "../.qa-timbre-dist/drumTimbreCore.js";

// These fixtures intentionally resemble the ranges observed from Essentia's
// LowLevelSpectralExtractor in the companion end-to-end regression.
const K = (id, tweak = {}) => ({ id, lowRatio: 0.72, midLowRatio: 0.22, midHighRatio: 0.04, highRatio: 0.02, flatnessDb: 0.65, rolloffHz: 1600, zcr: 0.022, ...tweak });
const S = (id, tweak = {}) => ({ id, lowRatio: 0.06, midLowRatio: 0.52, midHighRatio: 0.27, highRatio: 0.15, flatnessDb: 0.15, rolloffHz: 3900, zcr: 0.14, ...tweak });
const H = (id, tweak = {}) => ({ id, lowRatio: 0.01, midLowRatio: 0.03, midHighRatio: 0.14, highRatio: 0.82, flatnessDb: 0.30, rolloffHz: 15000, zcr: 0.27, ...tweak });
const P = (id, tweak = {}) => ({ id, lowRatio: 0.04, midLowRatio: 0.72, midHighRatio: 0.20, highRatio: 0.04, flatnessDb: 0.58, rolloffHz: 2400, zcr: 0.04, ...tweak });

const singleTypeKick = [
  K("k1"),
  K("k2", { lowRatio: 0.76, midLowRatio: 0.18, rolloffHz: 1300 }),
  K("k3", { lowRatio: 0.65, midHighRatio: 0.07, highRatio: 0.03, zcr: 0.028 }),
  K("k4", { flatnessDb: 0.55, rolloffHz: 2100 }),
];
assert.deepEqual(classifyDrumTimbres(singleTypeKick), [0, 0, 0, 0], "identical kick family was split across lanes");

const singleTypeHat = [
  H("h1"), H("h2", { highRatio: 0.76, midHighRatio: 0.19 }), H("h3", { zcr: 0.22, rolloffHz: 14000 }),
];
assert.deepEqual(classifyDrumTimbres(singleTypeHat), [3, 3, 3], "hat family was split across lanes");

const mixed = [
  K("k1"), S("s1"), H("h1"), P("p1"),
  K("k2", { lowRatio: 0.68, rolloffHz: 2200 }),
  S("s2", { midLowRatio: 0.48, midHighRatio: 0.30, highRatio: 0.16 }),
  H("h2", { highRatio: 0.77, zcr: 0.24 }),
  P("p2", { midLowRatio: 0.68, midHighRatio: 0.24, rolloffHz: 3000 }),
];
assert.deepEqual(classifyDrumTimbres(mixed), [0, 1, 3, 2, 0, 1, 3, 2], "mixed kit lane assignment drifted");

const processedKick = K("processed", { lowRatio: 0.44, midLowRatio: 0.30, midHighRatio: 0.14, highRatio: 0.12, flatnessDb: 0.38, rolloffHz: 3900, zcr: 0.045 });
assert.deepEqual(classifyDrumTimbres([processedKick]), [0], "processed kick should remain kick-like");

const softSnare = S("soft", { midLowRatio: 0.52, midHighRatio: 0.24, highRatio: 0.12, rolloffHz: 3100, zcr: 0.10 });
assert.deepEqual(classifyDrumTimbres([softSnare]), [1], "processed snare should remain snare-like");

const midPerc = P("mid-perc", { midLowRatio: 0.62, midHighRatio: 0.27, highRatio: 0.07, rolloffHz: 3300, zcr: 0.045 });
assert.deepEqual(classifyDrumTimbres([midPerc]), [2], "midrange tonal percussion should not become kick/snare");

console.log("DRUM TIMBRE CORE: PASS");
