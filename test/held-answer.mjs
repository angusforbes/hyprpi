// node test/held-answer.mjs  (J385: "a <answer>" on a host agent's question; isolated state, never the live relay)
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
const base = fs.mkdtempSync(path.join(os.tmpdir(), "j385-")); process.env.XDG_STATE_HOME = path.join(base, "state"); process.env.XDG_CONFIG_HOME = path.join(base, "cfg");
const PEND = path.join(base, "state", "hyprpi", "sbx-relay", "pending"); fs.mkdirSync(PEND, { recursive: true });
fs.mkdirSync(path.join(base, "cfg", "hyprpi"), { recursive: true });
fs.writeFileSync(path.join(base, "cfg", "hyprpi", "sbx-relay.json"), JSON.stringify({ sandboxes: [{ name: "door-t", doorman_for: "world-t", host_agents: "bridge" }] }));
const put = (id, m) => fs.writeFileSync(path.join(PEND, id + ".json"), JSON.stringify({ id, sandbox: "door-t", at: new Date().toISOString(), to: ["Angus"], shown: ["Angus"], mode: "talk", ...m }));
put("door-t--a11111", { text: "Question from the host agent working job door-t--b22222 (question 1): Which profile?", hostJob: { id: "door-t--b22222", n: 1 } });
put("door-t--c33333", { text: "hello from a sandbox agent", targets: [{ kind: "agent", id: "x" }] });
const { heldForSandboxes, actOnHeld } = await import("../lib/held.mjs");
const rp = (await import("../docker/doorman/review-provider.mjs")).default("door-t");
const ok = (m) => console.log("ok " + m);
const items = heldForSandboxes(["door-t", "world-t"]), q = items.find((x) => x.id === "door-t--a11111"), m = items.find((x) => x.id === "door-t--c33333");
assert.equal(q.kind, "host agent's question"); assert.deepEqual(q.choices, ["a", "2"]); assert.equal(q.answer, true); assert.equal(q.editable, false);
assert.ok(!m.choices.includes("a")); assert.equal(m.answer, false);
ok("a held question offers only a (answer) and 2 (decline); other items don't offer a");
// review-provider: a only on the question on screen, and only with text
assert.match(rp.decide("door-t--a11111", "a", undefined, "").text, /a needs your answer/);
assert.match(rp.decide("door-t--a11111", "a", undefined, undefined).text, /a needs your answer/);
const cur = rp.current(); assert.equal(cur.id, "door-t--a11111"); assert.equal(cur.answer, true);
assert.match(rp.decide("door-t--a11111", "1").text, /isn't a decision for this request/, "no approve on a question");
ok("the window's provider: a needs text; 1 isn't offered on a question");
// the guarded CLI: refuses a non-question and too-long text before anything; under an agent, the guard refuses (only Angus answers)
const RELAY = new URL("../docker/sbx-relay.mjs", import.meta.url).pathname, env = { ...process.env };
const cli = (...a) => spawnSync(process.execPath, [RELAY, ...a], { env, encoding: "utf8", timeout: 20000 });
let r = cli("answer", "door-t--c33333", "--note", "sure"); assert.equal(r.status, 4); assert.match(r.stderr, /only fits a host agent's question/);
r = cli("answer", "door-t--a11111", "--note", "x".repeat(501)); assert.equal(r.status, 4); assert.match(r.stderr, /at most 500/);
r = cli("answer", "door-t--a11111"); assert.equal(r.status, 4); assert.match(r.stderr, /needs --note/);
r = cli("answer", "door-t--a11111", "--note", "use G's profile"); assert.equal(r.status, 3, r.stderr); assert.match(r.stderr, /only Angus can approve/);
assert.equal(fs.readdirSync(path.join(base, "state", "hyprpi", "sbx-relay")).includes("decisions") ? fs.readdirSync(path.join(base, "state", "hyprpi", "sbx-relay", "decisions")).filter((n) => !n.startsWith(".")).length : 0, 0, "no decision written by an agent");
assert.equal(actOnHeld("door-t--a11111", { verdict: "answer" }, "doorman window", undefined, "").ok, false, "actOnHeld: an answer needs text");
ok("CLI answer: non-question, too long and empty refused; the agent/terminal guard stops anyone but Angus; no decision written");
fs.rmSync(base, { recursive: true, force: true });
console.log("held-answer: all pass");
