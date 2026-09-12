import assert from "node:assert/strict";
import { quantizeRhythmCapture, rhythmCaptureDurationSeconds } from "../.qa-dist/rhythmCapture.js";

assert.equal(rhythmCaptureDurationSeconds(120), 2);
assert.equal(rhythmCaptureDurationSeconds(60), 4);
assert.equal(rhythmCaptureDurationSeconds(0), 0);

assert.deepEqual(
  quantizeRhythmCapture([0, 0.5, 1, 1.5], { bpm: 120 }),
  [0, 4, 8, 12],
);

// Reproduces the old recorder lead-in bug and proves an explicit capture origin fixes it.
assert.deepEqual(
  quantizeRhythmCapture([0.18, 0.68, 1.18, 1.68], { bpm: 120, captureOffsetSeconds: 0.18 }),
  [0, 4, 8, 12],
);

// Events after the capture bar must be discarded, never modulo-wrapped into bar 1.
assert.deepEqual(
  quantizeRhythmCapture([0, 0.5, 2.15, 2.5], { bpm: 120 }),
  [0, 4],
);

// Multiple onsets that quantize to the same pad become one working step.
assert.deepEqual(
  quantizeRhythmCapture([0.497, 0.503, 1.001], { bpm: 120 }),
  [4, 8],
);

// Invalid events do not poison the grid.
assert.deepEqual(
  quantizeRhythmCapture([NaN, Infinity, -1, 0.25], { bpm: 120 }),
  [2],
);
assert.deepEqual(quantizeRhythmCapture([0.1], { bpm: 0 }), []);

console.log("RHYTHM CAPTURE GRID: PASS");
