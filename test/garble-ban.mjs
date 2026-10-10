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
const { firstReplyFromSession } = await import("../lib/garble.mjs");
const { deniedBy, denial } = await import("../lib/modelcheck.mjs");
const ok = (m) => console.log("ok " + m);
let slowMs = 0; const notes = [], reports = [], sets = [], sent = [], rooms = [], real = new Set(); // real: ids whose session really holds a garbled first reply
const orch = createOrch({ stateDir: state, deps: { open: (o) => ({ name: "Helper" + o.id.slice(-2), icon: "🤖", workspace: 3 }), note: (r, t) => notes.push(t), thoughtsReport: (r, x) => reports.push(x.text),
  send: (id, ev, d) => { sent.push({ id, ev, d }); return true; }, agentName: () => "P", liveAgent: () => null, roomOf: () => "B", agentInfo: () => null,
  setModel: async (id, model, thinking) => { if (slowMs) await new Promise((r) => setTimeout(r, slowMs)); sets.push({ id, model, thinking }); },
  roomPost: (r, t) => rooms.push(t), firstReply: async (id) => (real.has(id) ? { text: "<|close|>支持 strings +.Json?) Siri did field", usage: {}, prompt: "do a thing" } : { text: "All good, the job is done and nothing else is needed here.", usage: { output: 20 }, prompt: "do a thing" }), banModel: (m, o) => banModel(policyFile(), m, o) } });
const tick = () => new Promise((r) => setTimeout(r, 120));
const before = fs.readFileSync(policyFile(), "utf8");
// W1: an off-ladder model is banned at once, exact id, with a comment; a new spawn on it is refused
const bad = "nvidia/acme/word-salad-9";
assert.equal(deniedBy(bad, loadPolicy().modelDeny), "");
const a = orch.spawn({ prompt: "do a thing", model: bad }, "thoughts:B"); real.add(a.id);
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
const b = orch.spawn({ prompt: "x", model: lm, thinking: "medium" }, "thoughts:B"); real.add(b.id); sets.length = 0; reports.length = 0;
orch.stalled(b.id, "model output garbled: salad"); await tick();
assert.equal(deniedBy(lm, loadPolicy().modelDeny), "", "a ladder model isn't banned on one flag");
assert.ok(reports.some((r) => /ROUTING LADDER model.*NOT banned/.test(r)), "Thoughts is told loudly"); assert.equal(sets.length, 1); assert.notEqual(`${sets[0].model}/${sets[0].thinking}`, `${lm}/medium`);
const c = orch.spawn({ prompt: "y", model: lm, thinking: "medium" }, "thoughts:B"); real.add(c.id); sets.length = 0; reports.length = 0;
orch.stalled(c.id, "model output garbled: salad again"); await tick();
assert.ok(deniedBy(lm, loadPolicy().modelDeny), "banned on the second flag"); assert.ok(reports.some((r) => /banned/.test(r)));
assert.ok(sets.length === 1 && !deniedBy(sets[0].model, loadPolicy().modelDeny), "and the helper isn't moved onto a denied model");
ok(`W3: ladder model ${lm}: first flag = not banned + loud note to Thoughts + helper moved on; second flag = banned; note: ${reports.at(-1).slice(0, 150)}`);
assert.ok(rooms.length >= 3 && rooms.every((t) => /^⛔/.test(t)), "a one-line room post each time");
// the child's word is not evidence: a healthy helper claiming "garbled" bans and moves nothing
const f = orch.spawn({ prompt: "w", model: "nvidia/acme/healthy-1" }, "thoughts:B"); sets.length = 0; rooms.length = 0;
orch.stalled(f.id, "model output garbled: fabricated"); await tick();
assert.equal(deniedBy("nvidia/acme/healthy-1", loadPolicy().modelDeny), ""); assert.equal(sets.length, 0); assert.ok(notes.at(-1).includes("couldn't confirm"));
ok("a fabricated 'garbled' claim (the session shows a normal reply) bans and moves nothing");
// races with a REAL escalation, both orders (setModel takes 300 ms)
const lad = loadPolicy().routing.ladder.map((x) => x.replace(/:(off|minimal|low|medium|high|xhigh|max)$/, "")), g = orch.spawn({ prompt: "v", model: lad[0], thinking: "low" }, "thoughts:B"); real.add(g.id); sets.length = 0; slowMs = 300;
const esc = orch.escalate(g.id, { reason: "t", explicit: true }); await new Promise((r) => setTimeout(r, 30)); orch.stalled(g.id, "model output garbled: x"); await esc; await new Promise((r) => setTimeout(r, 700));
assert.equal(sets.length, 1, "only the escalation moved it (escalation first)"); assert.match(reports.at(-1) || "", /already moved/);
const h = orch.spawn({ prompt: "v", model: lad[2], thinking: "medium" }, "thoughts:B"); real.add(h.id); sets.length = 0; slowMs = 300;
orch.stalled(h.id, "model output garbled: x"); await new Promise((r) => setTimeout(r, 60)); const r2 = await orch.escalate(h.id, { reason: "t", explicit: true }).catch((e) => ({ err: e.message })); await new Promise((r) => setTimeout(r, 700));
assert.match(String(r2.skipped || r2.err || ""), /already under way|escalat/i, "the escalation is refused while recovery moves it"); assert.equal(sets.length, 1, "moved once"); slowMs = 0;
ok("races with a real escalation in both orders: the helper is moved exactly once");
// a fork's inherited history is not the helper's reply; evidence must come after its spawn prompt, from the same model
const L = (o) => JSON.stringify({ type: "message", message: o });
const fork = [L({ role: "user", content: "old parent task" }), L({ role: "assistant", content: [{ type: "text", text: "a perfectly normal parent reply" }], model: "p" }),
  L({ role: "user", content: [{ type: "text", text: "[hyprpi · Boss spawned you (spawn_agent) · you are its child]\nreview it\n\n(How this works: x. Never move Angus's focus.)" }] }),
  L({ role: "assistant", content: [{ type: "text", text: "<|close|>broken salad" }], model: "acme-9", usage: {} })].join("\n");
const fr = firstReplyFromSession(fork); assert.match(fr.text, /close/); assert.equal(fr.model, "acme-9"); assert.match(fr.prompt, /review it/);
assert.equal(firstReplyFromSession(L({ role: "assistant", content: "x" })), null, "no spawn prompt -> no evidence");
ok("firstReplyFromSession: the reply after the spawn prompt, not the inherited ancestor reply");
// modelban edge cases
const f2 = path.join(tmp, "x.jsonc"); fs.writeFileSync(f2, '// "modelDeny": []\n{ // {\n "modelDeny": ["a/b",] }\n');
banModel(f2, "p/c"); assert.deepEqual(JSON.parse(fs.readFileSync(f2, "utf8").replace(/\/\*.*?\*\/|\/\/.*$/gm, "").replace(/,(\s*\])/, "$1")).modelDeny, ["a/b", "p/c"]);
assert.throws(() => banModel(f2, "bareid"), /provider\/id/); assert.throws(() => banModel(f2, "p/*"), /provider\/id|exact/);
fs.writeFileSync(path.join(tmp, "real.jsonc"), '{ "modelDeny": [] }'); fs.symlinkSync("real.jsonc", path.join(tmp, "link.jsonc")); banModel(path.join(tmp, "link.jsonc"), "p/z");
assert.ok(fs.lstatSync(path.join(tmp, "link.jsonc")).isSymbolicLink() && /p\/z/.test(fs.readFileSync(path.join(tmp, "real.jsonc"), "utf8")));
ok("modelban: comments containing the key or a brace don't confuse it, a bare id is refused, a symlinked policy stays a link");
// a plain stall (not garbled) triggers nothing
const d = orch.spawn({ prompt: "z", model: "nvidia/acme/other-1" }, "thoughts:B"); sets.length = 0; orch.stalled(d.id, "idle for 12 min without a final report"); await tick();
assert.equal(sets.length, 0); assert.equal(deniedBy("nvidia/acme/other-1", loadPolicy().modelDeny), "");
ok("a non-garbled stall changes nothing");
// the file still parses and keeps its other settings
assert.deepEqual(loadPolicy().routing.ladder, ladder); assert.equal(loadPolicy().error, "");
console.log("garble-ban: all pass");
