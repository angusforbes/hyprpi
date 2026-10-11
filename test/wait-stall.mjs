#!/usr/bin/env node
// J452 proof, unit level (lib/orch.mjs wait, lib/stall.mjs). Throwaway state and config (XDG_CONFIG_HOME); no daemon, no agents.
//   W1: a report already in (it came before the wait, or while the parent was busy and got it as a message) returns AT ONCE,
//       in "all" mode too, and `since: now` can't hide it.
//   W2: a child that never reports: the wait ends at its limit (hyprpi.jsonc orchestration.waitDefaultSec / waitMaxSec) with
//       "no report from X after N" and X's state (working, over budget); a closed child or one idle a minute ends it at once.
//   W3 (logic): lib/stall.mjs fires once for a working agent with no output for N min, names what it waits on, goes to its own
//       room only, is rate-limited, and stays quiet for an agent that is streaming or running a tool that prints.
//   node test/wait-stall.mjs   (exit 0 = pass)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
const T = fs.mkdtempSync(path.join(os.tmpdir(), "j452-"));
fs.mkdirSync(path.join(T, "cfg", "hyprpi"), { recursive: true });
fs.writeFileSync(path.join(T, "cfg", "hyprpi", "hyprpi.jsonc"), '{ "orchestration": { "waitDefaultSec": 2, "waitMaxSec": 3 } }');
process.env.XDG_CONFIG_HOME = path.join(T, "cfg");
const { createOrch } = await import("../lib/orch.mjs");
const { createStallWatch } = await import("../lib/stall.mjs");
const keepAlive = setInterval(() => {}, 1000); // (the waits' timers are unref'd)
let fails = 0; const ok = (n, c, x = "") => { if (!c) fails++; console.log(`${c ? "ok  " : "FAIL"} ${n}${x ? ": " + x : ""}`); };

const kid = (id, name, extra = {}) => ({ id, name, parent: "hp-mom", parentName: "Mom", room: "B", prompt: "x", model: "m", thinking: "", budget: { tokens: 0, minutes: 0 }, used: { tokens: 0 }, startedAt: Date.now() - 600000, status: "running", reports: [], escalations: 0, ...extra });
const kids = { "hp-a": kid("hp-a", "Alpha"), "hp-b": kid("hp-b", "Bravo"), "hp-c": kid("hp-c", "Charlie"), "hp-d": kid("hp-d", "Delta", { status: "budget" }), "hp-e": kid("hp-e", "Echo"), "hp-f": kid("hp-f", "Foxtrot") };
fs.writeFileSync(path.join(T, "orch.json"), JSON.stringify({ children: kids }));
const sent = [], info = { "hp-a": { status: "working", since: Date.now() - 120000 }, "hp-b": { status: "working", since: Date.now() - 120000 }, "hp-c": { status: "working", since: Date.now() - 120000 }, "hp-d": { status: "idle", since: Date.now() - 30000 }, "hp-e": { status: "idle", since: Date.now() - 120000 }, "hp-f": { status: "working", since: Date.now() - 120000 } };
const orch = createOrch({ stateDir: T, deps: { send: (to, ev, d) => { sent.push({ to, ev, d }); return true; }, note: () => {}, liveAgent: () => null, agentName: () => "Mom", thoughtsReport: () => {}, agentInfo: (id) => info[id] || null } });
const timed = async (p) => { const t = Date.now(); const r = await p; return { r, ms: Date.now() - t }; };

// W1a: Alpha reports BEFORE Mom waits; Mom waits for ALL (Alpha and Bravo, Bravo still working): back at once with Alpha's report
orch.report("hp-a", { text: "alpha result" });
let { r, ms } = await timed(orch.wait("hp-mom", ["hp-a", "hp-b"], {}));
ok("W1a report before the wait: returned at once (all mode)", ms < 100 && r.reports.length === 1 && r.reports[0].text === "alpha result" && r.already === true, `${ms} ms`);
ok("W1a … and says who is still out, with its state", r.still_working.length === 1 && r.still_working[0].name === "Bravo" && /^working/.test(r.still_working[0].state), JSON.stringify(r.still_working));
// the same report isn't returned twice
({ r, ms } = await timed(orch.wait("hp-mom", ["hp-a"], { timeoutSec: 1, any: true })));
ok("W1a a read report isn't returned again", r.reports.length === 0 && r.timed_out, `${ms} ms`);

// W1b: Mom is mid-turn (not waiting): Charlie's report goes to her as a message; then she waits, even with since = now: back at once
orch.report("hp-c", { text: "charlie result" });
ok("W1b mid-turn: delivered as a message", sent.some((s) => s.to === "hp-mom" && s.ev === "orch.report" && /charlie result/.test(s.d.text)));
({ r, ms } = await timed(orch.wait("hp-mom", ["hp-c", "hp-b"], { since: Date.now() + 1000 })));
ok("W1b wait after it (since in the future): returned at once with Charlie's report", ms < 100 && r.reports.length === 1 && r.reports[0].name === "Charlie", `${ms} ms`);

// W1c: a report that arrives DURING a wait (any mode) wakes it at once
setTimeout(() => orch.report("hp-b", { text: "bravo result" }), 300);
({ r, ms } = await timed(orch.wait("hp-mom", ["hp-b"], { any: true })));
ok("W1c a report during the wait wakes it at once", r.reports[0]?.text === "bravo result" && ms < 800, `${ms} ms`);

// W2a: Foxtrot never reports and is working: the wait ends at waitDefaultSec (2 s) naming it and its state
({ r, ms } = await timed(orch.wait("hp-mom", ["hp-f"], {})));
ok("W2a no report: ends at the configured limit (2 s)", r.timed_out && ms >= 1900 && ms < 2600, `${ms} ms`);
ok("W2a … with a clear message naming the child and its state", /^no report from Foxtrot after 2 s; it is working/.test(r.note || ""), r.note);
// the limit is capped by waitMaxSec (3 s) even if the caller asks for 100
({ r, ms } = await timed(orch.wait("hp-mom", ["hp-f"], { timeoutSec: 100 })));
ok("W2a a longer limit is cut to waitMaxSec (3 s)", r.timed_out && ms >= 2900 && ms < 3600, `${ms} ms`);
// W2b: over budget
({ r } = await timed(orch.wait("hp-mom", ["hp-d"], {})));
ok("W2b over budget: named with its state", r.timed_out && /no report from Delta after \d s; it is over budget/.test(r.note || ""), r.note);
// W2c: idle a minute or more without a report: doesn't hold an "all" wait
({ r, ms } = await timed(orch.wait("hp-mom", ["hp-e"], {})));
ok("W2c idle 2 min without a report: the all-wait ends at once, saying so", ms < 100 && r.still_working[0]?.name === "Echo" && /idle 2 min \(its turn ended without a report\)/.test(r.still_working[0].state), `${ms} ms ${JSON.stringify(r.still_working)}`);
// W2d: closed (crashed or closed) ends it at once
orch.gone("hp-f");
({ r, ms } = await timed(orch.wait("hp-mom", ["hp-f"], {})));
ok("W2d closed: ends at once with state closed", ms < 100 && r.still_working[0]?.state === "closed", `${ms} ms`);
// my_children shows the live state
ok("my_children shows each child's live state", orch.children("hp-mom").find((c) => c.name === "Echo")?.state.startsWith("idle"));

// W3 logic: lib/stall.mjs with a fake clock
let now = 1e12; const alerts = [];
const ag = (id, room, extra) => ({ id, name: id, room, conn: {}, status: "working", statusSince: now, lastOutput: now, pulsed: true, ...extra });
const A = ag("Quiet", "B", { waitingOn: "wait_report (PageReview449)" }), S = ag("Streamer", "B"), L = ag("LongTool", "C", { waitingOn: "bash: npm test" }), O = ag("OldExt", "B", { pulsed: false }), I = ag("Idle", "B", { status: "idle" });
const all = [A, S, L, O, I];
const w = createStallWatch({ agents: () => all, policy: () => ({ orchestration: { stallAlertMinutes: 10, stallAlertRepeatMinutes: 30 } }), now: () => now, alert: (room, text, a) => alerts.push({ room, text, id: a.id }) });
for (let m = 1; m <= 40; m++) { now += 60000; S.lastOutput = now; if (m % 2) L.lastOutput = now; w.check(); } // Streamer streams every minute; LongTool's tool prints every 2 min
ok("W3 fires for the agent working with no output", alerts.filter((x) => x.id === "Quiet").length >= 1);
ok("W3 … after N minutes, not before", (() => { const first = alerts.find((x) => x.id === "Quiet"); return first && /working 10 min with no output/.test(first.text); })(), alerts[0]?.text);
ok("W3 … names what it waits on", /waiting on: wait_report \(PageReview449\)$/.test(alerts.find((x) => x.id === "Quiet")?.text || ""));
ok("W3 … goes only to its own world (room B)", alerts.filter((x) => x.id === "Quiet").every((x) => x.room === "B"));
ok("W3 … rate-limited: one per stall, again only after the repeat window (2 in 40 min, 30 min apart)", alerts.filter((x) => x.id === "Quiet").length === 2, JSON.stringify(alerts.map((x) => x.text)));
ok("W3 no alert for an agent streaming output", !alerts.some((x) => x.id === "Streamer"));
ok("W3 no alert for a long tool call that produces output", !alerts.some((x) => x.id === "LongTool"));
ok("W3 no alert for an agent whose extension sends no pulses, or one that is idle", !alerts.some((x) => x.id === "OldExt" || x.id === "Idle"));
// a new pulse ends the stall; a fresh stall alerts again (after the repeat window)
A.lastOutput = now; const n0 = alerts.length; for (let m = 1; m <= 9; m++) { now += 60000; S.lastOutput = now; L.lastOutput = now; w.check(); }
ok("W3 output again: no alert within N minutes of it", alerts.length === n0);
const off = createStallWatch({ agents: () => [ag("X", "B", { lastOutput: 0, statusSince: 1 })], policy: () => ({ orchestration: { stallAlertMinutes: 0 } }), now: () => now, alert: () => alerts.push("off") });
off.check(); ok("W3 stallAlertMinutes 0 turns it off", !alerts.includes("off"));

clearInterval(keepAlive); fs.rmSync(T, { recursive: true, force: true });
console.log(fails ? `wait-stall: ${fails} FAILED` : "wait-stall: all pass");
process.exit(fails ? 1 : 0);
