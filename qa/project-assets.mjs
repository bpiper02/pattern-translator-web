import assert from "node:assert/strict";
import { addProjectAsset, removeProjectAsset } from "../.qa-project-dist/assets.js";

const song = new File([new Uint8Array(128)], "song.wav", { type: "audio/wav" });
const drums = new File([new Uint8Array(64)], "drums.wav", { type: "audio/wav" });
const kick = new File([new Uint8Array(16)], "kick.wav", { type: "audio/wav" });

let state = [];
let result = addProjectAsset(state, { id: "song", createdAt: 1, file: song, kind: "mix", label: "song.wav", origin: "upload" });
state = result.assets;
assert.equal(state.length, 1);
assert.equal(result.asset.id, "song");

result = addProjectAsset(state, { id: "drums", createdAt: 2, file: drums, kind: "drums", label: "DRUMS", origin: "split", parentId: "song" });
state = result.assets;
result = addProjectAsset(state, { id: "kick", createdAt: 3, file: kick, kind: "kick", label: "KICK", origin: "split", parentId: "drums" });
state = result.assets;
assert.equal(state.length, 3);

const duplicate = addProjectAsset(state, { file: drums, kind: "drums", label: "DRUMS", origin: "split", parentId: "song" });
assert.equal(duplicate.added, false);
assert.equal(duplicate.assets.length, 3);
assert.equal(duplicate.asset.id, "drums");

const removeChildOnly = removeProjectAsset(state, "kick");
assert.deepEqual(removeChildOnly.map((asset) => asset.id), ["song", "drums"]);

const removeParent = removeProjectAsset(state, "song");
assert.deepEqual(removeParent, [], "removing a source should remove derived descendants");

console.log("PROJECT ASSET REGRESSION: PASS");
