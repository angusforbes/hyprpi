// node test/garble-ban.mjs  (J394/J397: a garbled first reply takes the exact model off the host's scoped list and moves the job on, once; ladder models need two flags)
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
const { knownModels: km0, setKnownModels: sk0 } = await import("../lib/modellist.mjs"); const KNOWN = km0(); // asked of the real pi, before the temp agent dir is set
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "j394-")), cfg = path.join(tmp, "cfg"), state = path.join(tmp, "state");
fs.mkdirSync(path.join(cfg, "hyprpi"), { recursive: true }); fs.mkdirSync(state, { recursive: true });
process.env.XDG_CONFIG_HOME = cfg;
const agent = path.join(tmp, "agent"); fs.mkdirSync(agent); process.env.PI_CODING_AGENT_DIR = agent; // the scoped model list lives in <agent>/settings.json
const real0 = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".pi/agent/settings.json"), "utf8"));
const bad = "nvidia/acme/word-salad-9", globBad = "nv-inference/acme/glob-salad-7";
fs.writeFileSync(path.join(agent, "settings.json"), JSON.stringify({ ...real0, theme: "keep-me", enabledModels: [...real0.enabledModels, bad, "nvidia/acme/healthy-1", "nvidia/acme/other-1", "nvidia/acme/race-x"] }, null, 2) + "\n");
fs.copyFileSync(path.join(os.homedir(), ".config/hyprpi/hyprpi.jsonc"), path.join(cfg, "hyprpi/hyprpi.jsonc")); // a real policy: comments, ladder, modelDeny
const { loadPolicy, policyFile } = await import("../lib/policy.mjs");
const { createOrch } = await import("../lib/orch.mjs");
const { allowedBy, readList, removeModel, setKnownModels, knownModels, settingsFile } = await import("../lib/modellist.mjs");
setKnownModels([...KNOWN, globBad, "nv-inference/acme/glob-keep-1", bad, "nvidia/acme/healthy-1", "nvidia/acme/other-1", "nvidia/acme/race-x"]); // the fake models must be "known" to pi for the list check to resolve them
const listed = (m) => !!allowedBy(m, readList());
const { firstReplyFromSession } = await import("../lib/garble.mjs");

const ok = (m) => console.log("ok " + m);
let slowMs = 0; const notes = [], reports = [], sets = [], sent = [], rooms = [], real = new Map(); // real: ids whose session really holds a garbled first reply
const orch = createOrch({ stateDir: state, deps: { open: (o) => ({ name: "Helper" + o.id.slice(-2), icon: "🤖", workspace: 3 }), note: (r, t) => notes.push(t), thoughtsReport: (r, x) => reports.push(x.text),
  send: (id, ev, d) => { sent.push({ id, ev, d }); return true; }, agentName: () => "P", liveAgent: () => null, roomOf: () => "B", agentInfo: () => null,
  setModel: async (id, model, thinking) => { if (slowMs) await new Promise((r) => setTimeout(r, slowMs)); sets.push({ id, model, thinking }); },
  roomPost: (r, t) => rooms.push(t), firstReply: async (id) => (real.has(id) ? { model: real.get(id), text: "<|close|>支持 strings +.Json?) Siri did field", usage: {}, prompt: "do a thing" } : { text: "All good, the job is done and nothing else is needed here.", usage: { output: 20 }, prompt: "do a thing" }), banModel: (m, o) => removeModel(m), allowed: (m) => listed(m) } });
const tick = () => new Promise((r) => setTimeout(r, 120));
// W1(J394/J397): an off-ladder model with a garbled first reply comes off the scoped list at once, exact id, with a backup
assert.ok(listed(bad), "on the list to start with");
const a = orch.spawn({ prompt: "do a thing", model: bad }, "thoughts:B"); real.set(a.id, bad);
orch.stalled(a.id, "model output garbled: a leaked template token (<|close|>)"); await tick();
assert.ok(!listed(bad), "taken off the list"); assert.ok(listed("nvidia/acme/healthy-1") && listed("nvidia/openai/gpt-oss-20b"), "the other entries stay");
assert.equal(JSON.parse(fs.readFileSync(settingsFile(), "utf8")).theme, "keep-me", "other settings untouched");
assert.ok(fs.readdirSync(agent).some((f) => /^settings\.json\.bak-J397-/.test(f)), "backup kept");
ok("the exact model id is off enabledModels, other entries and settings untouched, a backup exists");
// W2: the helper's job continues on the next model, once
assert.equal(sets.length, 1, "one switch"); assert.notEqual(sets[0].model, bad);
assert.ok(sent.some((x) => x.id === a.id && x.ev === "orch.report" && /Start the job from the beginning/.test(x.d.text)), "the helper is told to start over");
orch.stalled(a.id, "model output garbled: again"); await tick();
assert.equal(sets.length, 1, "not moved a second time");
ok(`W2: moved once to ${sets[0].model}/${sets[0].thinking}, told to restart its job; a second flag does nothing`);
// W3: a routing-ladder model is not banned on one flag (loud note), is on the second; the helper still moves one step
const ladder = loadPolicy().routing.ladder, lm = ladder[1].replace(/:(off|minimal|low|medium|high|xhigh|max)$/, "");
const b = orch.spawn({ prompt: "x", model: lm, thinking: "medium" }, "thoughts:B"); real.set(b.id, lm); sets.length = 0; reports.length = 0;
orch.stalled(b.id, "model output garbled: salad"); await tick();
assert.ok(listed(lm), "a ladder model isn't taken off on one flag");
assert.ok(reports.some((r) => /ROUTING LADDER model.*NOT banned/.test(r)), "Thoughts is told loudly"); assert.equal(sets.length, 1); assert.notEqual(`${sets[0].model}/${sets[0].thinking}`, `${lm}/medium`);
const c = orch.spawn({ prompt: "y", model: lm, thinking: "medium" }, "thoughts:B"); real.set(c.id, lm); sets.length = 0; reports.length = 0;
orch.stalled(c.id, "model output garbled: salad again"); await tick();
assert.ok(!listed(lm), "taken off on the second flag (glob replaced by its explicit expansion)"); assert.ok(listed("anthropic/claude-haiku-4-5") && !readList().includes("anthropic/*"), "the other anthropic models stay, the glob is gone"); assert.ok(reports.some((r) => /scoped model list.*replaced the pattern anthropic\/\*/.test(r)), "and the glob handling is explained to Thoughts");
assert.ok(sets.length === 1 && listed(sets[0].model), "and the helper isn't moved onto an unlisted model");
ok(`W3: ladder model ${lm}: first flag = not banned + loud note to Thoughts + helper moved on; second flag = banned; note: ${reports.at(-1).slice(0, 150)}`);
assert.ok(rooms.length >= 3 && rooms.every((t) => /^⛔/.test(t)), "a one-line room post each time");
// the child's word is not evidence: a healthy helper claiming "garbled" bans and moves nothing
const f = orch.spawn({ prompt: "w", model: "nvidia/acme/healthy-1" }, "thoughts:B"); sets.length = 0; rooms.length = 0;
orch.stalled(f.id, "model output garbled: fabricated"); await tick();
assert.ok(listed("nvidia/acme/healthy-1")); assert.equal(sets.length, 0); assert.ok(notes.at(-1).includes("couldn't confirm"));
ok("a fabricated 'garbled' claim (the session shows a normal reply) bans and moves nothing");
// races with a REAL escalation, both orders (setModel takes 300 ms)
const lad = loadPolicy().routing.ladder.map((x) => x.replace(/:(off|minimal|low|medium|high|xhigh|max)$/, "")), g = orch.spawn({ prompt: "v", model: lad[0], thinking: "low" }, "thoughts:B"); real.set(g.id, lad[0]); sets.length = 0; slowMs = 300;
const esc = orch.escalate(g.id, { reason: "t", explicit: true }); await new Promise((r) => setTimeout(r, 30)); orch.stalled(g.id, "model output garbled: x"); await esc; await new Promise((r) => setTimeout(r, 700));
assert.equal(sets.length, 1, "only the escalation moved it (escalation first)"); assert.match(reports.at(-1) || "", /already moved/);
const h = orch.spawn({ prompt: "v", model: lad[2], thinking: "medium" }, "thoughts:B"); real.set(h.id, lad[2]); sets.length = 0; slowMs = 300;
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
// removeModel edge cases
const f2 = path.join(tmp, "s2.json"), glob2 = JSON.stringify({ keep: 1, enabledModels: ["nv-inference/**", "nvidia/x/exact-1"] }, null, 4);
fs.writeFileSync(f2, glob2); const r1 = removeModel(globBad, { file: f2 }); assert.match(r1.how, /replaced the pattern nv-inference\/\*\*/);
const l2 = JSON.parse(fs.readFileSync(f2, "utf8")); assert.ok(!l2.enabledModels.includes(globBad) && l2.enabledModels.includes("nv-inference/acme/glob-keep-1") && l2.enabledModels.includes("nvidia/x/exact-1") && l2.keep === 1);
const r3 = removeModel("nvidia/x/exact-1", { file: f2 }); assert.match(r3.how, /removed the entry/); assert.equal(removeModel("nvidia/x/exact-1", { file: f2 }).already, true);
assert.throws(() => removeModel("bareid", { file: f2 }), /provider\/id/); assert.throws(() => removeModel("p/*", { file: f2 }), /exact/);
fs.writeFileSync(path.join(tmp, "n.json"), '{"a":1}'); assert.throws(() => removeModel("p/q", { file: path.join(tmp, "n.json") }), /no enabledModels list/);
fs.writeFileSync(path.join(tmp, "real.json"), glob2); fs.symlinkSync("real.json", path.join(tmp, "link.json")); removeModel("nvidia/x/exact-1", { file: path.join(tmp, "link.json") });
assert.ok(fs.lstatSync(path.join(tmp, "link.json")).isSymbolicLink() && !/exact-1/.test(fs.readFileSync(path.join(tmp, "real.json"), "utf8")));
ok("removeModel: a glob becomes its explicit expansion minus the model, an exact entry is deleted, a bare id / pattern / missing list is refused, a symlinked settings file stays a link");
// a plain stall (not garbled) triggers nothing
const d = orch.spawn({ prompt: "z", model: "nvidia/acme/other-1" }, "thoughts:B"); sets.length = 0; orch.stalled(d.id, "idle for 12 min without a final report"); await tick();
assert.equal(sets.length, 0); assert.ok(listed("nvidia/acme/other-1"));
ok("a non-garbled stall changes nothing");
// the file still parses and keeps its other settings
assert.deepEqual(loadPolicy().routing.ladder, ladder); assert.equal(loadPolicy().error, "");
console.log("garble-ban: all pass");
