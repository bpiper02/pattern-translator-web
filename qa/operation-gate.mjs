import assert from "node:assert/strict";
import { createOperationGate } from "../.qa-state-dist/operationGate.js";

const gate = createOperationGate();
const first = gate.begin();
assert.equal(gate.isCurrent(first), true, "first token should be current");

const second = gate.begin();
assert.equal(gate.isCurrent(first), false, "starting a newer operation must stale the old token");
assert.equal(gate.isCurrent(second), true, "newest token should be current");

gate.invalidate();
assert.equal(gate.isCurrent(second), false, "explicit invalidation must stale in-flight work");

const third = gate.begin();
assert.equal(gate.isCurrent(third), true, "gate should remain reusable after invalidation");

console.log("OPERATION GATE REGRESSION: PASS");
