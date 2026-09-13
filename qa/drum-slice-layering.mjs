import assert from "node:assert/strict";
import { nextDistinctEventTime } from "../.qa-slice-dist/drumSlice.js";

const events = [
  { time: 0.5, lane: 0 },
  { time: 0.5, lane: 3 },
  { time: 0.507, lane: 1 },
  { time: 0.9, lane: 2 },
  { time: 1.3, lane: 0 },
];

assert.equal(
  nextDistinctEventTime(events, 0.5),
  0.9,
  "simultaneous layered hits must not become the next slice boundary",
);
assert.equal(nextDistinctEventTime(events, 0.9), 1.3);
assert.equal(nextDistinctEventTime(events, 1.3), null);
assert.equal(nextDistinctEventTime([{ time: 0.51 }, { time: 0.53 }], 0.5, 0.02), 0.53);
assert.equal(nextDistinctEventTime([{ time: Number.NaN }, { time: 0.7 }], 0.5), 0.7);

console.log("DRUM SLICE LAYERING: PASS");
