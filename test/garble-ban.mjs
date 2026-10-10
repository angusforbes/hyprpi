// node test/garble-ban.mjs  (J394: a garbled first reply bans the exact model and moves the job on, once; ladder models need two flags)
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "j394-")), cfg = path.join(tmp, "cfg"), state = path.join(tmp, "state");
fs.mkdirSync(path.join(cfg, "hyprpi"), { recursive: true }); fs.mkdirSync(state, { recursive: true });
process.env.XDG_CONFIG_HOME = cfg;
fs.copyFileSync(path.join(os.homedir(), ".config/hyprpi/hyprpi.jsonc"), path.join(cfg, "hyprpi/hyprpi.jsonc")); // a real policy: comments, ladder, modelDeny
const { loadPolicy, policyFile } = await import("../lib/policy.mjs");
const { createOrch } = await import("../lib/orch.mjs");
const { banModel } = await import("../lib/modelban.mjs");
const { deniedBy, denial } = await import("../lib/modelcheck.mjs");
const ok = (m) => console.log("ok " + m);
const notes = [], reports = [], sets = [], sent = [];
const orch = createOrch({ stateDir: state, deps: { open: (o) => ({ name: "Helper" + o.id.slice(-2), icon: "🤖", workspace: 3 }), note: (r, t) => notes.push(t), thoughtsReport: (r, x) => reports.push(x.text),
  send: (id, ev, d) => { sent.push({ id, ev, d }); return true; }, agentName: () => "P", liveAgent: () => null, roomOf: () => "B", agentInfo: () => null,
  setModel: async (id, model, thinking) => { sets.push({ id, model, thinking }); }, banModel: (m, o) => banModel(policyFile(), m, o) } });
const tick = () => new Promise((r) => setTimeout(r, 120));
const before = fs.readFileSync(policyFile(), "utf8");
// W1: an off-ladder model is banned at once, exact id, with a comment; a new spawn on it is refused
const bad = "nvidia/acme/word-salad-9";
assert.equal(deniedBy(bad, loadPolicy().modelDeny), "");
const a = orch.spawn({ prompt: "do a thing", model: bad }, "thoughts:B");
orch.stalled(a.id, "model output garbled: a leaked template token (<|close|>)"); await tick();
const pol = loadPolicy(); assert.ok(pol.modelDeny.includes(bad), "exact id added"); assert.ok(pol.modelDeny.includes("*kimi*"), "older entries kept");
const txt = fs.readFileSync(policyFile(), "utf8"); assert.match(txt, /\/\* J394 [\d-]+ [\d:]+: banned automatically after a garbled first reply \(helper Helper\w+\): a leaked template token/);
assert.ok(fs.readdirSync(path.dirname(policyFile())).some((f) => /\.bak-J394-/.test(f)), "backup kept");
assert.equal(txt.replace(/"modelDeny": \[[^\]]*\]/, "").length > 0, true);
assert.match(denial(bad, deniedBy(bad, pol.modelDeny), "x"), /deny list/);
ok("W1: the exact model id is in modelDeny with a comment (when/helper/reason), a backup exists, and the deny check now refuses it: " + deniedBy(bad, pol.modelDeny));
// W2: the helper's job continues on the next model, once
assert.equal(sets.length, 1, "one switch"); assert.notEqual(sets[0].model, bad);
assert.ok(sent.some((x) => x.id === a.id && x.ev === "orch.report" && /Start the job from the beginning/.test(x.d.text)), "the helper is told to start over");
orch.stalled(a.id, "model output garbled: again"); await tick();
assert.equal(sets.length, 1, "not moved a second time"); assert.equal(loadPolicy().modelDeny.filter((m) => m === bad).length, 1);
ok(`W2: moved once to ${sets[0].model}/${sets[0].thinking}, told to restart its job; a second flag does nothing`);
// W3: a routing-ladder model is not banned on one flag (loud note), is on the second; the helper still moves one step
const ladder = loadPolicy().routing.ladder, lm = ladder[1].replace(/:(off|minimal|low|medium|high|xhigh|max)$/, "");
const b = orch.spawn({ prompt: "x", model: lm, thinking: "medium" }, "thoughts:B"); sets.length = 0; reports.length = 0;
orch.stalled(b.id, "model output garbled: salad"); await tick();
assert.equal(deniedBy(lm, loadPolicy().modelDeny), "", "a ladder model isn't banned on one flag");
assert.ok(reports.some((r) => /ROUTING LADDER model.*NOT banned/.test(r)), "Thoughts is told loudly"); assert.equal(sets.length, 1); assert.notEqual(`${sets[0].model}/${sets[0].thinking}`, `${lm}/medium`);
const c = orch.spawn({ prompt: "y", model: lm, thinking: "medium" }, "thoughts:B"); sets.length = 0; reports.length = 0;
orch.stalled(c.id, "model output garbled: salad again"); await tick();
assert.ok(deniedBy(lm, loadPolicy().modelDeny), "banned on the second flag"); assert.ok(reports.some((r) => /banned/.test(r)));
assert.ok(sets.length === 1 && !deniedBy(sets[0].model, loadPolicy().modelDeny), "and the helper isn't moved onto a denied model");
ok(`W3: ladder model ${lm}: first flag = not banned + loud note to Thoughts + helper moved on; second flag = banned; note: ${reports.at(-1).slice(0, 150)}`);
// a plain stall (not garbled) triggers nothing
const d = orch.spawn({ prompt: "z", model: "nvidia/acme/other-1" }, "thoughts:B"); sets.length = 0; orch.stalled(d.id, "idle for 12 min without a final report"); await tick();
assert.equal(sets.length, 0); assert.equal(deniedBy("nvidia/acme/other-1", loadPolicy().modelDeny), "");
ok("a non-garbled stall changes nothing");
// the file still parses and keeps its other settings
assert.deepEqual(loadPolicy().routing.ladder, ladder); assert.equal(loadPolicy().error, "");
console.log("garble-ban: all pass");
