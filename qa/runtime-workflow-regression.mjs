import assert from "node:assert/strict";
import fs from "node:fs";

const sampler = fs.readFileSync("src/components/ResampleWorkspace.tsx", "utf8");
const splitterClient = fs.readFileSync("src/separation/client.ts", "utf8");
const backend = fs.readFileSync("backend/app.py", "utf8");
const devScript = fs.readFileSync("scripts/dev.mjs", "utf8");

// SAMPLE is an instrument: working preview must read mutable pattern state on
// every 16th rather than playing a pre-rendered four-bar buffer.
assert.match(sampler, /scheduleRepeat/);
assert.match(sampler, /patternRef\.current/);
assert.match(sampler, /LIVE WORKING LOOP/);
assert.doesNotMatch(sampler, /playPatternBuffer/);

const invalidateMatch = sampler.match(/function invalidateExport[\s\S]*?\n  }/);
assert.ok(invalidateMatch, "invalidateExport must exist");
assert.doesNotMatch(invalidateMatch[0], /stopSequencer/);
assert.match(invalidateMatch[0], /renderGateRef\.current\.invalidate/);

const toggleStepMatch = sampler.match(/function toggleStep[\s\S]*?\n  }/);
assert.ok(toggleStepMatch, "toggleStep must exist");
assert.doesNotMatch(toggleStepMatch[0], /stopSequencer/);
assert.match(toggleStepMatch[0], /invalidateExport/);

// Offline WAV rendering takes an immutable snapshot. An edit during rendering
// invalidates that render instead of publishing stale audio afterwards.
const buildWavMatch = sampler.match(/async function buildWav[\s\S]*?\n  }/);
assert.ok(buildWavMatch, "buildWav must exist");
assert.match(buildWavMatch[0], /renderGateRef\.current\.begin/);
assert.match(buildWavMatch[0], /const renderBpm = bpm/);
assert.match(buildWavMatch[0], /const renderLanes = patternRef\.current\.map/);
assert.match(buildWavMatch[0], /renderPatternBuffer\(renderLanes, renderBpm, 4\)/);
assert.match(buildWavMatch[0], /renderGateRef\.current\.isCurrent/);

// Vite may select 5174+ when 5173 is occupied. Local splitter CORS must not
// hard-code one frontend port and client failures must be diagnosable.
assert.match(backend, /allow_origin_regex/);
assert.match(backend, /localhost\|127/);
assert.doesNotMatch(backend, /allow_origins=\["http:\/\/localhost:5173"/);
assert.match(splitterClient, /\/health/);
assert.match(splitterClient, /Splitter backend unavailable/);

// `npm run dev` is a full-app command. The launcher must probe the splitter,
// verify dynamic-port CORS compatibility and the backend code revision, reject
// stale servers, and launch both backend and Vite when the backend is offline.
assert.match(devScript, /SPLITTER_URL = "http:\/\/127\.0\.0\.1:8788"/);
assert.match(devScript, /CORS_PROBE_ORIGIN = "http:\/\/localhost:5174"/);
assert.match(devScript, /EXPECTED_SPLITTER_REVISION = "split-runtime-v2"/);
assert.match(devScript, /\$\{SPLITTER_URL\}\/health/);
assert.match(devScript, /access-control-allow-origin/);
assert.match(devScript, /health\?\.revision === EXPECTED_SPLITTER_REVISION/);
assert.match(devScript, /backendState === "stale"/);
assert.match(devScript, /uvicorn/);
assert.match(devScript, /vite/);
assert.match(devScript, /audio_separator/);
assert.match(backend, /API_REVISION = "split-runtime-v2"/);
assert.match(backend, /"revision": API_REVISION/);

console.log("RUNTIME WORKFLOW REGRESSION: PASS");
