import assert from "node:assert/strict";
import { alignHitsToBeatGrid, beatToStep } from "../.qa-beat-dist/drumGrid.js";

function hits(times) {
  return times.map((time, index) => ({ id: `h${index}`, time, beat: 0, lane: 0, velocity: 100 }));
}

function legacyAlign(input, bpm) {
  if (!input.length) return [];
  const first = input[0].time;
  return input.map((hit) => ({ ...hit, beat: (hit.time - first) * bpm / 60 }));
}

const fixtures = [
  {
    name: "missing-first-beat",
    bpm: 120,
    ticks: [0.5, 1.0, 1.5, 2.0, 2.5],
    times: [1.0, 1.5, 2.0, 2.5],
    expectedBeats: [1, 2, 3, 4],
  },
  {
    name: "pickup-after-leading-silence",
    bpm: 120,
    ticks: [0.5, 1.0, 1.5, 2.0, 2.5],
    times: [0.75, 1.0, 1.5, 2.0],
    expectedBeats: [0.5, 1, 2, 3],
  },
  {
    name: "irregular-beat-spacing",
    bpm: 120,
    ticks: [0.4, 0.92, 1.41, 1.93, 2.44],
    times: [0.4, 0.66, 0.92, 1.67, 1.93],
    expectedBeats: [0, 0.5, 1, 2.5, 3],
  },
  {
    name: "swing-microtiming-preserved",
    bpm: 100,
    ticks: [0.3, 0.9, 1.5, 2.1, 2.7],
    times: [0.3, 0.70, 0.9, 1.30, 1.5],
    expectedBeats: [0, 2 / 3, 1, 5 / 3, 2],
  },
];

let legacyStepErrors = 0;
let alignedStepErrors = 0;

for (const fixture of fixtures) {
  const source = hits(fixture.times);
  const aligned = alignHitsToBeatGrid(source, fixture.ticks, fixture.bpm);
  const legacy = legacyAlign(source, fixture.bpm);

  aligned.forEach((hit, index) => {
    assert.ok(
      Math.abs(hit.beat - fixture.expectedBeats[index]) < 0.015,
      `${fixture.name} hit ${index}: expected beat ${fixture.expectedBeats[index]}, got ${hit.beat}`,
    );
    const expectedStep = beatToStep(fixture.expectedBeats[index]);
    if (beatToStep(hit.beat) !== expectedStep) alignedStepErrors++;
    if (beatToStep(legacy[index].beat) !== expectedStep) legacyStepErrors++;
  });
}

const fallback = alignHitsToBeatGrid(hits([0.5, 1.0, 1.5]), [], 120);
assert.deepEqual(fallback.map((hit) => hit.beat), [1, 2, 3]);
assert.equal(beatToStep(0.625), 3);
assert.equal(beatToStep(Number.NaN), -1);
assert.equal(alignedStepErrors, 0, `aligned grid still has ${alignedStepErrors} step errors`);
assert.ok(legacyStepErrors >= 5, `baseline fixture is not exposing enough legacy errors (${legacyStepErrors})`);

console.log(`DRUM GRID ALIGNMENT: PASS (legacy step errors=${legacyStepErrors}, aligned=${alignedStepErrors})`);
