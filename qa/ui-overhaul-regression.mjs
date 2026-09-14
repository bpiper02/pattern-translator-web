import assert from "node:assert/strict";
import fs from "node:fs";

const read = (path) => fs.readFileSync(path, "utf8");

const index = read("index.html");
const main = read("src/main.tsx");
const crate = read("src/components/AssetBin.tsx");
const dock = read("src/components/UiDock.tsx");
const split = read("src/components/SplitWorkspace.tsx");
const sample = read("src/components/ResampleWorkspace.tsx");
const shell = read("src/chopsticks.css");
const copy = read("src/chopsticks-copy.css");
const sampler = read("src/chopsticks-sampler.css");
const qa = read("src/chopsticks-qa.css");

assert.match(index, /<title>Chopsticks/);
assert.match(main, /<UiDock \/>/);
assert.match(main, /chopsticks-qa\.css/);

assert.match(crate, /aria-label="Crate"/);
assert.match(crate, /aria-expanded=\{mobileOpen\}/);
assert.match(crate, /SAMPLE/);
assert.match(crate, /TRANSFORM/);

assert.match(shell, /grid-template-columns:260px minmax\(0,1fr\)/);
assert.match(shell, /\.machineShell>\.assetBin/);
assert.match(shell, /content:"CHOPSTICKS"/);
assert.match(shell, /content:"TRANSFORM"/);
assert.match(copy, /content:"SEQUENCER"/);
assert.match(copy, /\.machineFooter\{display:none!important\}/);

assert.match(sampler, /--cs-pad:/);
assert.match(sampler, /\.stepCell\.on/);
assert.match(sampler, /\.sampleSlot/);

assert.match(dock, /storageGet/);
assert.match(dock, /constrainPadColor/);
assert.match(dock, /chopsticks\.skin/);
assert.match(dock, /Appearance settings are local to this browser/);

// Runtime lifecycle guard: React StrictMode performs setup -> cleanup -> setup in
// development. Long-running async tools must reassert mounted ownership on setup
// or successful results are silently discarded on localhost.
assert.match(split, /useRef\(false\)/);
assert.match(split, /mountedRef\.current = true;/);
assert.match(sample, /useRef\(false\)/);
assert.match(sample, /mountedRef\.current = true;/);

assert.match(qa, /prefers-reduced-motion/);
assert.match(qa, /prefers-contrast:more/);
assert.match(qa, /safe-area-inset-bottom/);
assert.match(qa, /max-width:520px/);
assert.match(qa, /width:min\(1160px,calc\(100% - 22px\)\)/);
assert.match(qa, /grid-template-columns:218px minmax\(0,1fr\)/);
assert.match(qa, /\.modeModule/);
assert.match(qa, /min-height:112px/);
assert.match(qa, /border-radius:0!important/);

console.log("CHOPSTICKS UI REGRESSION: PASS");
