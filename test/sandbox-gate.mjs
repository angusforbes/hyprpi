// J403 v2: lib/sandbox-gate.mjs: which `hyprpi new` calls open inside a sandbox, which are refused, which pass.
import fs from "node:fs"; import os from "node:os"; import path from "node:path"; import assert from "node:assert/strict";
import { gate, sandboxedWorldFor } from "../lib/sandbox-gate.mjs";
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gate-"));
fs.writeFileSync(path.join(dir, "world-g.json"), JSON.stringify({ sandbox: "world-g", workspaces: [61, 69] }));
fs.writeFileSync(path.join(dir, "world-q.json"), JSON.stringify({ sandbox: "bad name!", workspaces: [71, 79] }));
fs.writeFileSync(path.join(dir, "broken.json"), "{");
const env = {};
assert.equal(gate({ workspace: 3, env, dir }), null, "host workspace: not gated");
assert.equal(gate({ workspace: 60, env, dir }), null); assert.equal(gate({ workspace: 70, env, dir }), null);
assert.equal(gate({ workspace: null, env, dir }), null, "no workspace: not gated");
for (const ws of [61, 64, 69]) {
  const g = gate({ workspace: ws, env, dir });
  assert.equal(g.action, "sandbox"); assert.deepEqual(g.argv.slice(0, 2), ["exec", "world-g"]);
  assert.match(g.argv[4], new RegExp(`hyprpi new --workspace ${ws}$`)); assert.match(g.text, /🐳 sandboxed agent in world G/);
}
assert.match(gate({ workspace: 64, noFocus: true, env, dir }).argv[4], /--workspace 64 --no-focus$/, "--no-focus is kept");
assert.match(gate({ workspace: 64, silent: true, env, dir }).argv[4], /--workspace 64 --silent --no-focus$/, "--silent is kept");
assert.equal(gate({ workspace: 64, wantId: "hp-x", env, dir }).action, "refuse", "a host agent's resume there: refused");
assert.equal(gate({ workspace: 64, twinOf: "hp-x", env, dir }).action, "refuse", "a twin of a host agent: refused");
assert.equal(gate({ workspace: 64, beside: "Blink", env, dir }).action, "refuse", "beside a host agent: refused");
assert.equal(gate({ workspace: 64, env: { HYPRPI_SANDBOX_WORLD: "G" }, dir }), null, "inside the sandbox: off");
assert.equal(sandboxedWorldFor(74, dir).sandbox, "world-q", "an unsafe sandbox name falls back to the world's own name");
assert.equal(gate({ workspace: "64; rm -rf ~", env, dir }), null, "a non-integer workspace never reaches the shell");
fs.rmSync(dir, { recursive: true });
console.log("sandbox-gate: all pass");
