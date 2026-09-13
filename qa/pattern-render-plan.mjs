import assert from "node:assert/strict";
import { buildPatternRenderPlan } from "../.qa-render-dist/patternRender.js";

const lanes = [
  { name: "KICK", steps: [true, false, false, false, true, false, false, false, true, false, false, false, true, false, false, false] },
  { name: "SNARE", steps: [false, false, false, false, true, false, false, false, false, false, false, false, true, false, false, false] },
  { name: "HAT", steps: [true, false, true, false, true, false, true, false, true, false, true, false, true, false, true, false] },
];

const previewPlan = buildPatternRenderPlan(lanes, 120, 4);
const exportPlan = buildPatternRenderPlan(lanes, 120, 4);
assert.deepEqual(previewPlan, exportPlan, "preview/export render plans diverged");
assert.equal(previewPlan.secondsPerStep, 0.125);
assert.equal(previewPlan.durationSeconds, 8);
assert.equal(previewPlan.events.length, 56);
assert.deepEqual(
  previewPlan.events.slice(0, 4).map((event) => [event.lane, event.step, event.timeSeconds]),
  [["KICK", 0, 0], ["KICK", 4, 0.5], ["KICK", 8, 1], ["KICK", 12, 1.5]],
);

const source = [{ name: "KICK", steps: [false, true, false, true] }];
const sourcePlan = buildPatternRenderPlan(source, 60, 2);
assert.deepEqual(sourcePlan.events.map((event) => event.timeSeconds), [0.25, 0.75, 1.25, 1.75]);

const fallback = buildPatternRenderPlan([{ name: "X", steps: [true, false] }], Number.NaN, 0);
assert.equal(fallback.bpm, 120);
assert.equal(fallback.bars, 1);
assert.equal(fallback.events[0].timeSeconds, 0);

console.log("PATTERN RENDER PLAN: PASS — PREVIEW/EXPORT USE ONE EVENT PLAN");
