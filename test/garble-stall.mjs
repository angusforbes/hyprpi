// node test/garble-stall.mjs  (J392 W2: a spawned agent whose first reply is garbled calls orch.stalled "model output garbled",
// and the daemon side marks the child stalled and tells its parent)
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
const R = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "j392-"));
const ok = (m) => console.log("ok " + m);
const fx = JSON.parse(fs.readFileSync(path.join(R, "test/fixtures/garbled-kimi-k3.json"), "utf8"));
// --- agent side: the real pi-extension/orch.ts with typebox stubbed and a fake pi
let src = fs.readFileSync(path.join(R, "pi-extension/orch.ts"), "utf8")
  .replace('import { Type } from "typebox";', "const Type: any = new Proxy({}, { get: () => () => ({}) });")
  .replace('"../lib/garble.mjs"', JSON.stringify(pathToFileURL(path.join(R, "lib/garble.mjs")).href));
const f = path.join(tmp, "orch-under-test.ts"); fs.writeFileSync(f, src);
const { orchAgent } = await import(pathToFileURL(f).href);
async function run(messages, { spawned = true } = {}) {
  const handlers = {}, calls = [];
  const pi = { on: (e, h) => (handlers[e] ||= []).push(h), registerTool: () => {} };
  const call = async (m, p) => { calls.push({ m, p }); if (m === "orch.me") return spawned ? { budget: { tokens: 0 }, parent: "p" } : null; return {}; };
  orchAgent(pi, { call, inject: () => {}, idle: () => true, ctx: () => null });
  // let the extension learn it is spawned (the daemon's orch.me answer), whichever way it asks
  for (const h of handlers["session_start"] || []) await h({}, { sessionManager: {} });
  await new Promise((r) => setTimeout(r, 50));
  for (const m of messages) for (const h of handlers["message_end"] || []) await h({ message: m });
  for (const h of handlers["agent_end"] || []) await h({ messages });
  await new Promise((r) => setTimeout(r, 20));
  return calls.filter((c) => c.m === "orch.stalled");
}
const task = { role: "user", content: [{ type: "text", text: "[hyprpi · X spawned you] Please review the repository and report what you find about the build." }] };
let s = await run([task, { role: "assistant", content: [{ type: "text", text: fx.replies[0] }], usage: fx.usage }]);
assert.equal(s.length, 1, "RTConfig3's reply makes the child report a stall"); assert.match(s[0].p.why, /^model output garbled: /);
ok("agent side: a garbled first reply calls orch.stalled: " + s[0].p.why);
s = await run([task, { role: "assistant", content: [], usage: {} }]); assert.equal(s.length, 1); assert.match(s[0].p.why, /garbled: an empty reply/);
s = await run([task, { role: "assistant", content: [{ type: "text", text: "I read the files and the build is fine, all of the tests pass today." }], usage: { output: 30 } }]); assert.equal(s.length, 0);
s = await run([task, { role: "assistant", content: [{ type: "text", text: fx.replies[0] }], usage: {} }], { spawned: false }); assert.equal(s.length, 0, "an agent that wasn't spawned never reports a stall");
s = await run([task, { role: "assistant", content: [{ type: "text", text: "fine reply about the build and the tests, all green today." }], usage: { output: 9 } }, { role: "assistant", content: [{ type: "text", text: fx.replies[0] }], usage: {} }]); assert.equal(s.length, 0, "only the FIRST reply is judged");
ok("agent side: empty-no-usage flagged; a good reply, a non-spawned agent and a later reply are not");
// --- daemon side: the existing stall path tells the parent
const { createOrch } = await import(pathToFileURL(path.join(R, "lib/orch.mjs")).href);
const notes = [], sent = [], reports = [];
const orch = createOrch({ stateDir: tmp, deps: { open: (o) => ({ name: "RTChild", icon: "🤖", workspace: 3 }), note: (room, t) => notes.push(t), thoughtsReport: (w, r) => reports.push(r), send: (to, ev, p) => { sent.push({ to, ev, p }); return true; },
  agentName: () => "Parent", liveAgent: () => null, roomOf: () => "B", agentInfo: () => null, setModel: async () => {} } });
const sp = orch.spawn({ prompt: "review it", model: "openai/gpt-x" }, "thoughts:B");
assert.equal(orch.stalled(sp.id, "model output garbled: a leaked template token (<|close|>)"), true);
assert.match(reports[0].text, /RTChild .* stalled: model output garbled/); assert.ok(notes.some((n) => /⚠ .*model output garbled/.test(n)));
ok("daemon side: the child is marked stalled and its parent is told 'model output garbled': " + reports[0].text.split("\n")[0]);
console.log("garble-stall: all pass");
