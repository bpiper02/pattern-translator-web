import assert from "node:assert/strict";
import { buildPatternRenderPlan } from "../.qa-render-dist/patternRender.js";

const lanes = [
  { name: "KICK", steps: [true, false, false, false, true, false, false, false, true, false, false, false, true, false, false, false] },
  { name: "SNARE", steps: [false, false, false, false, true, false, false, false, false, false, false, false, true, false, false, false] },
  { name: "HAT", steps: Array.from({ length: 16 }, (_, i) => i % 2 === 0) },
];

const plan = buildPatternRenderPlan(lanes, 120, 4);
assert.equal(plan.bpm, 120);
assert.equal(plan.bars, 4);
assert.equal(plan.stepsPerBar, 16);
assert.equal(plan.secondsPerStep, 0.125);
assert.equal(plan.durationSeconds, 8);

// 4 kicks + 2 snares + 8 hats = 14 events per bar, repeated for 4 bars.
assert.equal(plan.events.length, 56);

const firstKick = plan.events.find((event) => event.lane === "KICK" && event.bar === 0 && event.step === 0);
const secondBarKick = plan.events.find((event) => event.lane === "KICK" && event.bar === 1 && event.step === 0);
const firstSnare = plan.events.find((event) => event.lane === "SNARE" && event.bar === 0 && event.step === 4);
assert.equal(firstKick?.timeSeconds, 0);
assert.equal(firstSnare?.timeSeconds, 0.5);
assert.equal(secondBarKick?.timeSeconds, 2);

// BPM fallback and invalid bar input should remain deterministic rather than
// producing NaN scheduling that preview/export could interpret differently.
const fallback = buildPatternRenderPlan([{ name: "X", steps: [true, false, false, false] }], Number.NaN, 0);
assert.equal(fallback.bpm, 120);
assert.equal(fallback.bars, 1);
assert.equal(fallback.events[0].timeSeconds, 0);

console.log("PATTERN RENDER PARITY REGRESSION: PASS");
