#!/usr/bin/env node
// J391 proof (Ledger, J377: old budget / progress / stall notices kept arriving after it had taken its helpers'
// final reports and closed them).
// A) daemon side (lib/orch.mjs): once a child has given its final report and been closed, no new stall,
//    budget or late-progress notice is sent to its parent, and redeliver skips its stale reports.
// B) parent side (pi-extension/orch.ts): notices already queued (held while the parent was busy) are dropped
//    when the parent closes the child or takes its final report with wait_report; the final report stays.
//   node test/orch-stale.mjs   (exit 0 = pass)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createOrch } from "../lib/orch.mjs";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
let fails = 0; const ok = (n, c, x = "") => { if (!c) fails++; console.log(`${c ? "ok  " : "FAIL"} ${n}${x ? ": " + x : ""}`); };
const T = fs.mkdtempSync(path.join(os.tmpdir(), "j391-"));

// ---- A) daemon side
const child = { id: "hp-kid", name: "Kid", parent: "hp-mom", parentName: "Mom", room: "B", prompt: "x", model: "m", thinking: "", budget: { tokens: 1000, minutes: 10 }, used: { tokens: 0 }, startedAt: Date.now() - 60000, status: "running", reports: [], escalations: 0, depth: 1 };
fs.writeFileSync(path.join(T, "orch.json"), JSON.stringify({ children: { "hp-kid": child } }));
const sent = []; let connected = true;
const orch = createOrch({ stateDir: T, deps: { send: (to, ev, d) => { if (!connected) return false; sent.push({ to, ev, d }); return true; }, note: () => {}, liveAgent: () => null, agentName: () => "", thoughtsReport: () => {}, roomOf: () => "B" } });
orch.report("hp-kid", { text: "progress 1" });
orch.stalled("hp-kid", "idle for 10 min");
const before = sent.length;
orch.report("hp-kid", { text: "all done", final: true });
ok("final report delivered", sent.length === before + 1 && sent.at(-1).d.final === true);
const n0 = sent.length;
ok("no stall after final", orch.stalled("hp-kid", "its turn ended on an error") === false && sent.length === n0);
await orch.budgetHit("hp-kid", { what: "token budget" });
ok("no budget alert after final", sent.length === n0);
orch.close("hp-kid", "hp-mom");
const n1 = sent.filter((s) => s.to === "hp-mom").length;
orch.report("hp-kid", { text: "late progress after close" });
ok("no late progress after close", sent.filter((s) => s.to === "hp-mom").length === n1);
// redeliver: a non-final report kept while the parent was offline, then a final: only the final goes.
const st = JSON.parse(fs.readFileSync(path.join(T, "orch.json"), "utf8"));
const kid2 = { ...child, id: "hp-kid2", name: "Kid2", status: "running", reports: [] };
fs.writeFileSync(path.join(T, "orch.json"), JSON.stringify({ children: { ...st.children, "hp-kid2": kid2 } }));
sent.length = 0; connected = false;
const orch2 = createOrch({ stateDir: T, deps: { send: (to, ev, d) => { if (!connected) return false; sent.push({ to, ev, d }); return true; }, note: () => {}, liveAgent: () => null, agentName: () => "", thoughtsReport: () => {}, roomOf: () => "B" } });
orch2.report("hp-kid2", { text: "progress (parent offline)" });
orch2.report("hp-kid2", { text: "final (parent offline)", final: true });
connected = true; orch2.redeliver("hp-mom");
ok("redeliver: only the final", sent.length === 1 && /final \(parent offline\)/.test(sent[0].d.text), sent.map((s) => s.d.text.split("\n").pop()).join(" | "));

// ---- B) parent side: load pi-extension/orch.ts with a stand-in for typebox
const src = fs.readFileSync(path.join(ROOT, "pi-extension/orch.ts"), "utf8")
  .replace(/^import type .*$/m, "")
  .replace(/^import \{ Type \} from "typebox";$/m, "const Type: any = new Proxy({}, { get: () => (..._a: any[]) => ({}) });");
const tmp = path.join(T, "orch-ext.ts"); fs.writeFileSync(tmp, src);
const { orchAgent } = await import(tmp);
const tools = {}, held = [];
const pi = { registerTool: (t) => { tools[t.name] = t; }, on: () => {}, registerCommand: () => {} };
let callResult = {};
const ev = orchAgent(pi, { call: async (m) => callResult[m] || {}, inject: (m) => { held.push(m); }, idle: () => false, ctx: () => null, flushHeld: () => 0,
  dropHeld: (pred) => { let n = 0; for (let i = held.length - 1; i >= 0; i--) if (pred(held[i])) { held.splice(i, 1); n++; } return n; } });
const fire = (child, text, final = false) => ev("orch.report", { child, name: child, final, text });
fire("hp-a", "progress A"); fire("hp-a", "[hyprpi · your child A stalled: hit its budget]"); fire("hp-a", "A final", true);
fire("hp-b", "progress B"); fire("hp-b", "B budget alert");
callResult["orch.close"] = { id: "hp-a", name: "A", closing: true };
await tools.close_agent.execute("t1", { id: "hp-a" });
ok("close_agent drops A's queued notices, keeps its final", held.filter((m) => m.details.orch_child === "hp-a").map((m) => m.content).join("|") === "A final");
ok("B's notices untouched", held.filter((m) => m.details.orch_child === "hp-b").length === 2);
callResult["orch.wait"] = { reports: [{ id: "hp-b", name: "B", final: true, text: "B final" }], still_working: [], timed_out: false };
await tools.wait_report.execute("t2", { ids: ["hp-b"], timeout_sec: 1 });
ok("wait_report taking B's final drops B's queued notices", held.filter((m) => m.details.orch_child === "hp-b").length === 0);

fs.rmSync(T, { recursive: true, force: true });
console.log(fails ? `FAIL (${fails})` : "PASS"); process.exit(fails ? 1 : 0);
