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
fs.writeFileSync(path.join(T, "orch.json"), JSON.stringify({ children: { kestrel: kid("kestrel"), osprey: kid("osprey"), marlin: kid("marlin"), quiet: kid("quiet"), gone: kid("gone", "hp-mom", "closing"), tk: kid("tk", "thoughts:C"), fast: kid("fast"), early: kid("early"), fin: kid("fin"), failed: kid("failed"), tfail: kid("tfail"), waited: kid("waited"), unread: kid("unread"), race: kid("race"), many: kid("many") } }));
const sent = [], toThoughts = [];
const orch = createOrch({ stateDir: T, deps: { send: (to, ev, d) => { sent.push({ to, ev, d }); return true; }, note: () => {}, liveAgent: () => null, agentName: () => "Mom", thoughtsReport: (room, r) => { toThoughts.push({ room, r }); }, roomOf: () => "C", agentInfo: () => ({ status: "done", since: Date.now() - 120000 }) } });

// a synthetic pi session: the turn's start (a user message or a hyprpi custom message), then assistant messages
let clock = Date.now() - 3600000; // real time (reports are stamped with Date.now())
const ts = () => new Date((clock += 1000)).toISOString();
let callN = 0;
function session(name, turns) {
  const f = path.join(T, name + ".jsonl"), lines = [{ type: "session", id: name, timestamp: ts() }];
  for (const t of turns) {
    lines.push(t.custom ? { type: "custom_message", customType: "hyprpi-talk", content: t.ask, timestamp: ts() } : { type: "message", timestamp: ts(), message: { role: "user", content: [{ type: "text", text: t.ask }] } });
    for (const m of t.says) {
      const id = "call" + (++callN);
      lines.push({ type: "message", timestamp: ts(), message: { role: "assistant", content: m.tool ? [{ type: "toolCall", id, name: m.tool, arguments: m.args || {} }] : [{ type: "text", text: m.text }] } });
      if (m.tool) lines.push({ type: "message", timestamp: ts(), message: { role: "toolResult", toolCallId: id, toolName: m.tool, isError: !!m.error, content: [{ type: "text", text: m.error || "ok" }] } });
    }
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

// A3: Osprey reports properly (its turn runs now)
clock = Date.now() - 5000;
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


// J728Check cases
// C1 a new turn begins right after the end: the turn that ended is the one forwarded (turnInput before = its end time)
clock = Date.now() - 30000;
const ff = session("fast", [{ ask: "[hyprpi · Mom spawned you] go", says: [{ text: "FIRST ANSWER" }] }, { ask: "next please", says: [{ text: "SECOND ANSWER" }] }]);
const lines = fs.readFileSync(ff, "utf8").trim().split("\n").map((l) => JSON.parse(l)), end1 = Date.parse(lines[2].timestamp) + 500;
const rc1 = orch.turnEnded("fast", turnInput(ff, { before: end1 }));
ok("C1 a quick next turn doesn't hide the turn that ended: FIRST ANSWER forwarded", rc1.sent && /FIRST ANSWER/.test(reportsTo("fast")[0]?.d.text || "") && !/SECOND/.test(reportsTo("fast")[0]?.d.text || ""), JSON.stringify(reportsTo("fast")));
const rc1b = orch.turnEnded("fast", turnInput(ff));
ok("C1 … and the next turn's own end forwards SECOND ANSWER", rc1b.sent && reportsTo("fast").length === 2 && /SECOND ANSWER/.test(reportsTo("fast")[1].d.text));
// C2 a real report made just BEFORE a new turn began doesn't suppress that turn
orch.report("early", { text: "day 1 report" });
await new Promise((r) => setTimeout(r, 30));
clock = Date.now() - 1000 + 10; // the turn starts ~10 ms after the report
const ef = session("early", [{ ask: "day 2?", says: [{ text: "DAY 2 PLAIN" }] }]);
const rc2 = orch.turnEnded("early", turnInput(ef));
ok("C2 a report just before the turn began doesn't suppress it", rc2.sent && /DAY 2 PLAIN/.test(reportsTo("early").at(-1)?.d.text || ""), JSON.stringify(rc2));
// C3 a finished (final) child's later plain turn is forwarded but it stays finished
orch.report("fin", { text: "done", final: true });
clock = Date.now() - 500;
const fnf = session("fin", [{ ask: "one more thing?", says: [{ text: "AFTER FINAL" }] }]);
const rc3 = orch.turnEnded("fin", turnInput(fnf));
ok("C3 a final child's later plain turn still reaches the parent and the child stays final", rc3.sent && orch.get("fin").final === true && /AFTER FINAL/.test(reportsTo("fin").at(-1)?.d.text || ""), JSON.stringify(orch.get("fin")));
// C4 a report_to_parent call that failed (no report recorded) doesn't suppress the auto report
clock = Date.now() - 500;
const flf = session("failed", [{ ask: "go", says: [{ tool: "report_to_parent", args: { text: "" }, error: "empty report" }, { text: "MY RESULT" }] }]);
const rc4 = orch.turnEnded("failed", turnInput(flf));
ok("C4 a failed report_to_parent call (no report made): the auto report still goes", rc4.sent && /MY RESULT/.test(reportsTo("failed")[0]?.d.text || ""), JSON.stringify(rc4));

// C5 a talk_reply call that FAILED doesn't count as answered
clock = Date.now() - 500;
const tff = session("tfail", [{ custom: true, ask: "[hyprpi demand from Mom · id y] move?", says: [{ tool: "talk_reply", args: { request_id: "y", text: "x" }, error: "no such request" }, { text: "MY MOVE" }] }]);
const rc5 = orch.turnEnded("tfail", turnInput(tff));
ok("C5 a failed talk_reply doesn't suppress the auto report", rc5.sent && /MY MOVE/.test(reportsTo("tfail")[0]?.d.text || ""), JSON.stringify(rc5));
// C6 the auto label survives the wait_report route
const pend = orch.wait("hp-mom", ["waited"], { timeoutSec: 5 });
clock = Date.now() - 500;
orch.turnEnded("waited", turnInput(session("waited", [{ ask: "go", says: [{ text: "WAITED ANSWER" }] }])));
const wres = await pend;
ok("C6 a waiting parent sees the auto label too", wres.reports.some((r) => r.id === "waited" && /\[auto: its turn ended without report_to_parent/.test(r.text) && /WAITED ANSWER/.test(r.text)), JSON.stringify(wres).slice(0, 300));
// C7 an unreadable session: the parent is told, once
const st7 = Date.now() - 2000;
const rc7 = orch.turnEnded("unread", { unreadable: true, startedAt: st7, final: "", toolNames: [] });
const rc7b = orch.turnEnded("unread", { unreadable: true, startedAt: st7, final: "", toolNames: [] });
ok("C7 an unreadable session: the parent gets one notice saying so", rc7.sent && reportsTo("unread").length === 1 && /couldn't read its session/.test(reportsTo("unread")[0].d.text), JSON.stringify(reportsTo("unread")));

// C8 (F6) turn 1 plain, turn 2 (begun within 800 ms) reports: turn 1 is still forwarded
clock = Date.now() - 4000;
const rf = session("race", [{ ask: "go", says: [{ text: "RACE FIRST" }] }]);
const end8 = Date.now() - 1500;
orch.report("race", { text: "second turn's real report" }); // made after turn 1 ended
const rc8 = orch.turnEnded("race", { ...turnInput(rf, { before: end8 }), endedAt: end8 });
ok("C8 a newer turn's report doesn't hide the earlier unreported turn", rc8.sent && reportsTo("race").some((e) => /RACE FIRST/.test(e.d.text)), JSON.stringify(rc8));
// C9 (F7) a final child stays final after 21+ auto reports
orch.report("many", { text: "the result", final: true });
for (let i = 0; i < 22; i++) orch.turnEnded("many", { final: "follow-up " + i, toolNames: [], startedAt: Date.now() + i, endedAt: Date.now() + i + 1 });
ok("C9 a final child stays final after 22 auto reports (buffer of 20)", orch.get("many").final === true && orch.get("many").reports === 20, JSON.stringify(orch.get("many")));

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
