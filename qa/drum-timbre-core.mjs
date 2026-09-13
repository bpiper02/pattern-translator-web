import assert from "node:assert/strict";
import { classifyDrumTimbres } from "../.qa-timbre-dist/drumTimbreCore.js";

const K = (id, tweak = {}) => ({ id, lowRatio: 0.56, midLowRatio: 0.28, midHighRatio: 0.11, highRatio: 0.05, flatnessDb: -43, rolloffHz: 2300, zcr: 0.022, ...tweak });
const S = (id, tweak = {}) => ({ id, lowRatio: 0.08, midLowRatio: 0.20, midHighRatio: 0.43, highRatio: 0.29, flatnessDb: -13, rolloffHz: 9200, zcr: 0.15, ...tweak });
const H = (id, tweak = {}) => ({ id, lowRatio: 0.01, midLowRatio: 0.04, midHighRatio: 0.17, highRatio: 0.78, flatnessDb: -8, rolloffHz: 15100, zcr: 0.27, ...tweak });
const P = (id, tweak = {}) => ({ id, lowRatio: 0.12, midLowRatio: 0.42, midHighRatio: 0.34, highRatio: 0.12, flatnessDb: -36, rolloffHz: 4400, zcr: 0.05, ...tweak });

const singleTypeKick = [
  K("k1"),
  K("k2", { lowRatio: 0.59, midLowRatio: 0.25, rolloffHz: 2100 }),
  K("k3", { lowRatio: 0.52, midHighRatio: 0.15, highRatio: 0.06, zcr: 0.028 }),
  K("k4", { flatnessDb: -38, rolloffHz: 2700 }),
];
assert.deepEqual(classifyDrumTimbres(singleTypeKick), [0, 0, 0, 0], "identical kick family was split across lanes");

const singleTypeHat = [
  H("h1"), H("h2", { highRatio: 0.72, midHighRatio: 0.22 }), H("h3", { zcr: 0.22, rolloffHz: 14000 }),
];
assert.deepEqual(classifyDrumTimbres(singleTypeHat), [3, 3, 3], "hat family was split across lanes");

const mixed = [
  K("k1"), S("s1"), H("h1"), P("p1"),
  K("k2", { lowRatio: 0.53, rolloffHz: 2600 }),
  S("s2", { flatnessDb: -17, midHighRatio: 0.39, highRatio: 0.31 }),
  H("h2", { highRatio: 0.74, zcr: 0.24 }),
  P("p2", { midLowRatio: 0.38, midHighRatio: 0.37, rolloffHz: 4800 }),
];
assert.deepEqual(classifyDrumTimbres(mixed), [0, 1, 3, 2, 0, 1, 3, 2], "mixed kit lane assignment drifted");

const processedKick = K("processed", { lowRatio: 0.44, midLowRatio: 0.30, midHighRatio: 0.14, highRatio: 0.12, flatnessDb: -31, rolloffHz: 3900, zcr: 0.045 });
assert.deepEqual(classifyDrumTimbres([processedKick]), [0], "processed kick should remain kick-like");

const softSnare = S("soft", { flatnessDb: -22, midHighRatio: 0.38, highRatio: 0.24, midLowRatio: 0.30 });
assert.deepEqual(classifyDrumTimbres([softSnare]), [1], "processed snare should remain snare-like");

console.log("DRUM TIMBRE CORE: PASS");
