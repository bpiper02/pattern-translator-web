import assert from "node:assert/strict";
import { addProjectAsset, removeProjectAsset } from "../.qa-project-dist/assets.js";

const song = new File([new Uint8Array(128)], "song.wav", { type: "audio/wav", lastModified: 100 });
const drums = new File([new Uint8Array(64)], "drums.wav", { type: "audio/wav", lastModified: 200 });
const kick = new File([new Uint8Array(16)], "kick.wav", { type: "audio/wav", lastModified: 300 });

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

// A retried derived result is intentionally idempotent even if the fetched
// browser File gets a fresh lastModified timestamp.
const retriedDrums = new File([new Uint8Array(64)], "drums.wav", { type: "audio/wav", lastModified: 999 });
const duplicate = addProjectAsset(state, { file: retriedDrums, kind: "drums", label: "DRUMS", origin: "split", parentId: "song" });
assert.equal(duplicate.added, false);
assert.equal(duplicate.assets.length, 3);
assert.equal(duplicate.asset.id, "drums");

// User uploads with the same name and byte size are not assumed identical when
// the browser reports a different source timestamp.
const alternateSong = new File([new Uint8Array(128)], "song.wav", { type: "audio/wav", lastModified: 101 });
const secondUpload = addProjectAsset(state, { id: "song-2", createdAt: 4, file: alternateSong, kind: "mix", label: "song.wav", origin: "upload" });
assert.equal(secondUpload.added, true);
assert.equal(secondUpload.assets.length, 4);

assert.throws(
  () => addProjectAsset(state, { file: kick, kind: "kick", label: "ORPHAN", origin: "split", parentId: "missing" }),
  /parent missing is missing/,
  "derived assets must never be stored without their parent",
);

assert.throws(
  () => addProjectAsset(state, { id: "song", file: alternateSong, kind: "mix", label: "other", origin: "upload" }),
  /id song already exists/,
  "asset ids must remain unique",
);

const removeChildOnly = removeProjectAsset(state, "kick");
assert.deepEqual(removeChildOnly.map((asset) => asset.id), ["song", "drums"]);

const unchanged = removeProjectAsset(state, "missing");
assert.equal(unchanged, state, "removing a missing id should be an idempotent no-op");

const removeParent = removeProjectAsset(state, "song");
assert.deepEqual(removeParent, [], "removing a source should remove derived descendants");

console.log("PROJECT ASSET REGRESSION: PASS");
