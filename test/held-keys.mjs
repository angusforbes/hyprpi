// node test/held-keys.mjs  (J355: the room panel's held strip never approves)
import assert from "node:assert/strict";
import fs from "node:fs";
import { heldKeyAction } from "../lib/held.mjs";
const h = [{ id: "a--111111" }], old = Date.now() - 5000, now = Date.now();
assert.equal(heldKeyAction("y", h, h, old, now), null); assert.equal(heldKeyAction("Y", h, h, old, now), null); assert.equal(heldKeyAction("approve", h, h, old, now), null);
assert.equal(heldKeyAction("n", h, h, old, now), "deny"); assert.equal(heldKeyAction("r", h, h, old, now), "review");
assert.equal(heldKeyAction("n", h, h, now - 500, now), null); assert.equal(heldKeyAction("n", [{ id: "other--222222" }], h, old, now), null); assert.equal(heldKeyAction("n", [], [], old, now), null);
const tui = fs.readFileSync(new URL("../mockups/room-tui.mjs", import.meta.url), "utf8");
assert.ok(!/decideHeld\([^)]*"approve"/.test(tui) && !/verdict = \/\^y/.test(tui), "room-tui has no approve call");
assert.ok(!/y \+ Enter/.test(tui), "the strip no longer offers y");
console.log("held-keys: all pass");
