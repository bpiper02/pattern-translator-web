import assert from "node:assert/strict";
import fs from "node:fs";

const sampler = fs.readFileSync("src/components/ResampleWorkspace.tsx", "utf8");
const splitterClient = fs.readFileSync("src/separation/client.ts", "utf8");
const backend = fs.readFileSync("backend/app.py", "utf8");

// The sampler is an instrument: working preview must read mutable pattern state
// on every 16th rather than playing a pre-rendered four-bar buffer.
assert.match(sampler, /scheduleRepeat/);
assert.match(sampler, /patternRef\.current/);
assert.match(sampler, /LIVE WORKING LOOP/);
assert.doesNotMatch(sampler, /playPatternBuffer/);

const invalidateMatch = sampler.match(/function invalidateExport[\s\S]*?\n  }/);
assert.ok(invalidateMatch, "invalidateExport must exist");
assert.doesNotMatch(invalidateMatch[0], /stopSequencer/);

const toggleStepMatch = sampler.match(/function toggleStep[\s\S]*?\n  }/);
assert.ok(toggleStepMatch, "toggleStep must exist");
assert.doesNotMatch(toggleStepMatch[0], /stopSequencer/);
assert.match(toggleStepMatch[0], /invalidateExport/);

// Offline rendering is reserved for explicit WAV creation/export.
assert.match(sampler, /async function buildWav/);
assert.match(sampler, /renderPatternBuffer\(patternRef\.current, bpm, 4\)/);

// Vite may select 5174+ when 5173 is occupied. Local splitter CORS must not
// hard-code one frontend port and client failures must be diagnosable.
assert.match(backend, /allow_origin_regex/);
assert.match(backend, /localhost\|127/);
assert.doesNotMatch(backend, /allow_origins=\["http:\/\/localhost:5173"/);
assert.match(splitterClient, /\/health/);
assert.match(splitterClient, /Splitter backend unavailable/);

console.log("RUNTIME WORKFLOW REGRESSION: PASS");
