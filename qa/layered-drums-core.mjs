import assert from "node:assert/strict";
import { recoverLayeredDrumHits } from "../.qa-layer-dist/layeredDrumsCore.js";

function candidate(id, overrides = {}) {
  return {
    id,
    time: 1,
    beat: 2,
    velocity: 110,
    lowRatio: 0.04,
    midLowRatio: 0.65,
    midHighRatio: 0.22,
    highRatio: 0.09,
    flatnessDb: 0.2,
    rolloffHz: 3500,
    zcr: 0.12,
    ...overrides,
  };
}

function lanes(result) {
  return result.map((hit) => hit.lane).sort((a, b) => a - b);
}

const singleKick = candidate("kick", {
  lowRatio: 0.86, midLowRatio: 0.12, midHighRatio: 0.015, highRatio: 0.005,
  rolloffHz: 180, zcr: 0.01,
});
assert.deepEqual(lanes(recoverLayeredDrumHits([singleKick], { low: [1.002], mid: [], high: [] })), [0]);

const singleSnare = candidate("snare", {
  lowRatio: 0.05, midLowRatio: 0.58, midHighRatio: 0.23, highRatio: 0.14,
  rolloffHz: 3900, zcr: 0.14,
});
assert.deepEqual(
  lanes(recoverLayeredDrumHits([singleSnare], { low: [], mid: [0.994], high: [1.006] })),
  [1],
  "broadband snare must not become snare+hat",
);

const singleHat = candidate("hat", {
  lowRatio: 0, midLowRatio: 0.01, midHighRatio: 0.04, highRatio: 0.95,
  rolloffHz: 16000, zcr: 0.42,
});
assert.deepEqual(lanes(recoverLayeredDrumHits([singleHat], { low: [], mid: [], high: [1.001] })), [3]);

const kickHat = candidate("kick-hat", {
  lowRatio: 0.38, midLowRatio: 0.10, midHighRatio: 0.08, highRatio: 0.44,
  rolloffHz: 12500, zcr: 0.22,
});
assert.deepEqual(
  lanes(recoverLayeredDrumHits([kickHat], { low: [0.997], mid: [], high: [1.004] })),
  [0, 3],
  "simultaneous kick+hat should create two pads",
);

const snareHat = candidate("snare-hat", {
  lowRatio: 0.02, midLowRatio: 0.31, midHighRatio: 0.20, highRatio: 0.47,
  rolloffHz: 13500, zcr: 0.31,
});
assert.deepEqual(
  lanes(recoverLayeredDrumHits([snareHat], { low: [], mid: [1.008], high: [0.996] })),
  [1, 3],
  "simultaneous snare+hat should create two pads",
);

const kickSnare = candidate("kick-snare", {
  lowRatio: 0.35, midLowRatio: 0.30, midHighRatio: 0.22, highRatio: 0.13,
  rolloffHz: 4200, zcr: 0.13,
});
assert.deepEqual(
  lanes(recoverLayeredDrumHits([kickSnare], { low: [1.003], mid: [0.999], high: [1.004] })),
  [0, 1],
  "simultaneous kick+snare should create two pads without phantom hat",
);

const highBleedKick = candidate("clicky-kick", {
  lowRatio: 0.68, midLowRatio: 0.20, midHighRatio: 0.08, highRatio: 0.04,
  rolloffHz: 4500, zcr: 0.09,
});
assert.deepEqual(
  lanes(recoverLayeredDrumHits([highBleedKick], { low: [1], mid: [], high: [1] })),
  [0],
  "a kick click triggering the high detector must not invent a hat",
);

const outsideTolerance = recoverLayeredDrumHits(
  [kickHat],
  { low: [0.90], mid: [], high: [1.10] },
  0.035,
);
assert.deepEqual(lanes(outsideTolerance), [3], "distant band onsets must not be attached as layers");

console.log("LAYERED DRUM CORE: PASS");
