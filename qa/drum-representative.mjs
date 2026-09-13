import assert from "node:assert/strict";
import { selectRepresentativeDrumHit, scoreRepresentativeHit } from "../.qa-representative-dist/drumRepresentative.js";

function kick(id, time, velocity, overrides = {}) {
  return {
    id,
    sourceEventId: id.split("-")[0],
    time,
    beat: time * 2,
    lane: 0,
    velocity,
    lowRatio: 0.86,
    midLowRatio: 0.09,
    midHighRatio: 0.03,
    highRatio: 0.02,
    flatnessDb: 0.08,
    rolloffHz: 820,
    zcr: 0.018,
    ...overrides,
  };
}

function hat(id, time, velocity) {
  return {
    id,
    sourceEventId: id.split("-")[0],
    time,
    beat: time * 2,
    lane: 3,
    velocity,
    lowRatio: 0.01,
    midLowRatio: 0.01,
    midHighRatio: 0.08,
    highRatio: 0.90,
    flatnessDb: 0.75,
    rolloffHz: 11_500,
    zcr: 0.28,
  };
}

// Loudest kick is layered with a hat. A slightly softer isolated, typical kick
// should win because it is much more representative of the actual kick family.
const layered = kick("evt1-kick", 0.50, 127);
const layeredHat = hat("evt1-hat", 0.50, 112);
const clean = kick("evt2-kick", 1.20, 105, { lowRatio: 0.84, midLowRatio: 0.10 });
const weak = kick("evt3-kick", 2.00, 58, { lowRatio: 0.85, midLowRatio: 0.09 });
const outlier = kick("evt4-kick", 2.60, 116, {
  lowRatio: 0.34,
  midLowRatio: 0.31,
  midHighRatio: 0.20,
  highRatio: 0.15,
  rolloffHz: 4_800,
  zcr: 0.09,
});
const kickLane = [layered, clean, weak, outlier];
const all = [...kickLane, layeredHat];
const selected = selectRepresentativeDrumHit(kickLane, all);
assert.equal(selected?.id, clean.id, "isolated timbre-medoid kick should beat loud layered/outlier hits");

const layeredScore = scoreRepresentativeHit(layered, kickLane, all);
const cleanScore = scoreRepresentativeHit(clean, kickLane, all);
assert.ok(cleanScore.isolation > layeredScore.isolation, "layered event must carry an isolation penalty");
assert.ok(cleanScore.total > layeredScore.total, "clean representative should outrank loud layered hit");

// Timbre centrality should beat an atypical accent even when all hits are clean.
const centerA = kick("a", 0.4, 104, { lowRatio: 0.82, midLowRatio: 0.11, rolloffHz: 900 });
const centerB = kick("b", 1.0, 108, { lowRatio: 0.84, midLowRatio: 0.10, rolloffHz: 860 });
const brightAccent = kick("c", 1.6, 126, {
  lowRatio: 0.48,
  midLowRatio: 0.27,
  midHighRatio: 0.16,
  highRatio: 0.09,
  rolloffHz: 3_700,
  zcr: 0.07,
});
const central = selectRepresentativeDrumHit([centerA, centerB, brightAccent], [centerA, centerB, brightAccent]);
assert.notEqual(central?.id, brightAccent.id, "loud timbre outlier should not become the lane sample");

// Degenerate lane remains deterministic.
assert.equal(selectRepresentativeDrumHit([clean], [clean])?.id, clean.id);
assert.equal(selectRepresentativeDrumHit([], all), null);

console.log("DRUM REPRESENTATIVE REGRESSION: PASS");
