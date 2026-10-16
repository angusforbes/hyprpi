#!/usr/bin/env node
// J728 (Angus "105a y"): a spawned child's turn that ends without report_to_parent still reaches its parent. lib/topics.mjs
// turnInput reads the turn from a (synthetic) session file; lib/orch.mjs turnEnded forwards its last text ONCE as an automatic,
// non-final report, and not when the turn reported or answered (talk_reply / room_reply). The parent is a stand-in send seam.
//  A1 plain-text turn → exactly one auto report to the parent, with the child's final text and the auto mark
//  A2 the same turn again (a second status flip) → no duplicate
//  A3 a turn that called report_to_parent → no auto report (the real report is the only one)
//  A4 a turn answered with talk_reply (an ask_agent / demand) → no auto report
//  A5 a turn with no text and no report → one auto report saying so (no silent nothing)
//  A6 a closing child → nothing; a Thoughts parent → delivered through thoughtsReport
//  A7 the spawn welcome says window text doesn't reach the parent (F3)
//  A8 a wait_report on the child returns with the auto report
//   node test/run.mjs test/orch-auto-report.mjs   (exit 0 = pass)
import fs from "node:fs"; import os from "node:os"; import path from "node:path";
import { requireSandbox } from "./guard/sandbox.mjs";
await requireSandbox(import.meta.url);
import { createOrch } from "../lib/orch.mjs";
import { turnInput } from "../lib/topics.mjs";
let fails = 0; const ok = (n, c, x = "") => { if (!c) fails++; console.log(`${c ? "ok  " : "FAIL"} ${n}${x && !c ? ": " + x : ""}`); };
const T = fs.mkdtempSync(path.join(os.tmpdir(), "j728-"));
const kid = (id, parent = "hp-mom", status = "running") => ({ id, name: id, parent, parentName: parent.startsWith("thoughts:") ? "Thoughts-C" : "Mom", room: "C", prompt: "play", model: "m", thinking: "", budget: {}, used: { tokens: 0 }, startedAt: Date.now() - 60000, status, reports: [], escalations: 0, depth: 1 });
fs.writeFileSync(path.join(T, "orch.json"), JSON.stringify({ children: { kestrel: kid("kestrel"), osprey: kid("osprey"), marlin: kid("marlin"), quiet: kid("quiet"), gone: kid("gone", "hp-mom", "closing"), tk: kid("tk", "thoughts:C") } }));
const sent = [], toThoughts = [];
const orch = createOrch({ stateDir: T, deps: { send: (to, ev, d) => { sent.push({ to, ev, d }); return true; }, note: () => {}, liveAgent: () => null, agentName: () => "Mom", thoughtsReport: (room, r) => { toThoughts.push({ room, r }); }, roomOf: () => "C", agentInfo: () => ({ status: "done", since: Date.now() - 120000 }) } });

// a synthetic pi session: the turn's start (a user message or a hyprpi custom message), then assistant messages
let clock = Date.parse("2026-10-17T10:00:00Z");
const ts = () => new Date((clock += 1000)).toISOString();
function session(name, turns) {
  const f = path.join(T, name + ".jsonl"), lines = [{ type: "session", id: name, timestamp: ts() }];
  for (const t of turns) {
    lines.push(t.custom ? { type: "custom_message", customType: "hyprpi-talk", content: t.ask, timestamp: ts() } : { type: "message", timestamp: ts(), message: { role: "user", content: [{ type: "text", text: t.ask }] } });
    for (const m of t.says) lines.push({ type: "message", timestamp: ts(), message: { role: "assistant", content: m.tool ? [{ type: "toolCall", name: m.tool, arguments: m.args || {} }] : [{ type: "text", text: m.text }] } });
  }
  fs.writeFileSync(f, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  return f;
}
const reportsTo = (who) => sent.filter((s) => s.ev === "orch.report" && s.d.child === who);

// A1 + A2: Kestrel answers in its window only
const kf = session("kestrel", [{ ask: "[hyprpi · Mom spawned you] play as KESTREL", says: [{ text: "GUESS: Iris, cinema, ? SHARE: K2 REASON: Nina's phone was near both places." }] }]);
const kin = turnInput(kf);
ok("turnInput gives the final text, the tool names and the start time", kin && /GUESS: Iris/.test(kin.final) && Array.isArray(kin.toolNames) && kin.startedAt > 0, JSON.stringify(kin));
const r1 = orch.turnEnded("kestrel", kin);
const k1 = reportsTo("kestrel");
ok("A1 one auto report to the parent with the child's final text", r1.sent && k1.length === 1 && /GUESS: Iris, cinema/.test(k1[0].d.text) && /auto: its turn ended without report_to_parent/.test(k1[0].d.text) && k1[0].d.final === false && k1[0].to === "hp-mom", JSON.stringify(k1));
ok("A1 the send says where it went (no silent success)", /handed to its window/.test(r1.delivered || ""), JSON.stringify(r1));
const r2 = orch.turnEnded("kestrel", turnInput(kf));
ok("A2 the same turn again: no duplicate", !r2.sent && reportsTo("kestrel").length === 1, JSON.stringify(r2));

// A3: Osprey reports properly
const of = session("osprey", [{ ask: "[hyprpi · Mom spawned you] play as OSPREY", says: [{ tool: "report_to_parent", args: { text: "GUESS: ?, bakery, scarf" } }, { text: "Reported." }] }]);
orch.report("osprey", { text: "GUESS: ?, bakery, scarf" }); // what the tool call did
const r3 = orch.turnEnded("osprey", turnInput(of));
ok("A3 a turn that reported: no auto duplicate", !r3.sent && reportsTo("osprey").length === 1 && !/auto:/.test(reportsTo("osprey")[0].d.text), JSON.stringify(r3));

// A4: Marlin answers an ask_agent demand with talk_reply
const mf = session("marlin", [{ custom: true, ask: "[hyprpi demand from Mom · id x] your move?", says: [{ tool: "talk_reply", args: { request_id: "x", text: "GUESS: Nina, ?, scarf" } }, { text: "Ready for day 2." }] }]);
const r4 = orch.turnEnded("marlin", turnInput(mf));
ok("A4 a talk_reply turn: no auto duplicate", !r4.sent && reportsTo("marlin").length === 0, JSON.stringify(r4));
// …but Marlin's NEXT turn in plain text again is forwarded (the day-3 case)
clock += 60000;
const mf2 = session("marlin", [{ custom: true, ask: "[hyprpi demand from Mom · id x] your move?", says: [{ tool: "talk_reply", args: { request_id: "x", text: "GUESS: Nina, ?, scarf" } }] }, { ask: "DAY 3 board …", says: [{ text: "GUESS: Nina, bakery, scarf SHARE: M2" }] }]);
const r4b = orch.turnEnded("marlin", turnInput(mf2));
ok("A4 a later plain-text turn of the same child is forwarded", r4b.sent && reportsTo("marlin").length === 1 && /GUESS: Nina, bakery, scarf/.test(reportsTo("marlin")[0].d.text), JSON.stringify(r4b));

// A5: no text at all
const qf = session("quiet", [{ ask: "[hyprpi · Mom spawned you] check x", says: [{ tool: "bash", args: { command: "ls" } }] }]);
const r5 = orch.turnEnded("quiet", turnInput(qf));
ok("A5 a turn with no text and no report: one auto report saying so", r5.sent && reportsTo("quiet").length === 1 && /ended with no text and no report/.test(reportsTo("quiet")[0].d.text), JSON.stringify(reportsTo("quiet")));

// A6: closing child, Thoughts parent
const r6 = orch.turnEnded("gone", turnInput(kf));
ok("A6 a closing child: nothing sent", !r6.sent && reportsTo("gone").length === 0, JSON.stringify(r6));
const r6b = orch.turnEnded("tk", turnInput(kf));
ok("A6 a Thoughts parent gets it through thoughtsReport", r6b.sent && toThoughts.length === 1 && toThoughts[0].room === "C" && /auto: its turn ended without report_to_parent/.test(toThoughts[0].r.text), JSON.stringify(toThoughts));
ok("A6 not a child: nothing", !orch.turnEnded("nobody", turnInput(kf)).sent);

// A7: the welcome (F3)
const src = fs.readFileSync(new URL("../lib/orch.mjs", import.meta.url), "utf8");
ok("A7 the welcome says window text doesn't reach the parent", /your parent does NOT see what you write in your own window/.test(src));

// A8: a waiting parent gets the auto report
const w0 = await orch.wait("hp-mom", ["kestrel"], { timeoutSec: 5 });
ok("A8 an unread auto report returns a wait at once", w0.reports.some((r) => r.id === "kestrel" && /GUESS: Iris/.test(r.text)), JSON.stringify(w0).slice(0, 300));
const w = orch.wait("hp-mom", ["kestrel"], { timeoutSec: 5 });
clock += 60000;
const kf2 = session("kestrel", [{ ask: "DAY 2 board", says: [{ text: "GUESS: Leon, bakery, scarf" }] }]);
orch.turnEnded("kestrel", turnInput(kf2));
const wr = await w;
ok("A8 a waiting wait_report returns with the next auto report", wr.reports.some((r) => r.id === "kestrel" && /GUESS: Leon/.test(r.text)), JSON.stringify(wr).slice(0, 400));

fs.rmSync(T, { recursive: true, force: true });
console.log(fails ? `orch-auto-report: ${fails} FAILED` : "orch-auto-report: all pass");
process.exit(fails ? 1 : 0);
