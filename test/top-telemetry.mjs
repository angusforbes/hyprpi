#!/usr/bin/env node
// J557: lib/top-telemetry.mjs on fixtures only (a fake daemon `request`, a temp STATE, a temp Pi model catalog
// and a synthetic /proc). No daemon, no network, nothing outside the temp folder is read or written.
//   node test/top-telemetry.mjs   (exit 0 = pass)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createTelemetryReader, createContextReader, scorePriority, calculateContextTokens, PRIORITY_FORMULA, PRIORITY_MAX } from "../lib/top-telemetry.mjs";

let fails = 0, n = 0;
const eq = (name, got, want) => { n++; const ok = JSON.stringify(got) === JSON.stringify(want); if (!ok) fails++; console.log(`${ok ? "ok  " : "FAIL"} ${name}: ${JSON.stringify(got)}${ok ? "" : ` (want ${JSON.stringify(want)})`}`); };
const yes = (name, cond, info = "") => eq(name + (info ? ` [${info}]` : ""), !!cond, true);

const T = fs.mkdtempSync(path.join(os.tmpdir(), "j557-telemetry-"));
const STATE = path.join(T, "state"), PI = path.join(T, "pi"), PROC = path.join(T, "proc");
const w = (f, data) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, typeof data === "string" ? data : JSON.stringify(data)); return f; };
const jl = (rows) => rows.map((r) => JSON.stringify(r)).join("\n") + "\n";
const NOW = 1_800_000_000_000;
const iso = (ms) => new Date(ms).toISOString();
const SECRET = "sk-THIS-MUST-NEVER-APPEAR", PROMPT = "PROMPT-TEXT-MUST-NOT-LEAK";

// ---- session entries ----
let seq = 0;
const hdr = (ms = NOW - 3600e3) => ({ type: "session", version: 3, id: "s1", timestamp: iso(ms), cwd: "/tmp" });
const msg = (parentId, role, extra = {}, id = `e${++seq}`) => ({ type: "message", id, parentId, timestamp: iso(NOW - 1000), message: { role, content: [{ type: "text", text: "x".repeat(10) }], timestamp: NOW - 1000, ...extra } });
const asst = (parentId, usage, extra = {}, id) => msg(parentId, "assistant", { provider: "anthropic", model: "claude-test", usage, stopReason: "stop", ...extra }, id);
const U = (input, output, cacheRead, cacheWrite, totalTokens) => ({ input, output, cacheRead, cacheWrite, ...(totalTokens != null ? { totalTokens } : {}), cost: { total: 0 } });

// ---- Pi model catalog (models.json holds a fake key: it must never come out) ----
w(path.join(PI, "models-store.json"), { anthropic: { models: [{ id: "claude-test", contextWindow: 200000, headers: { "x-api-key": SECRET } }, { id: "claude-big", contextWindow: 1000000 }] }, other: { models: [{ id: "claude-test", contextWindow: 7 }] } });
w(path.join(PI, "models.json"), { providers: { custom: { apiKey: SECRET, baseUrl: "http://x", models: [{ id: "cm", contextWindow: 50000 }] } } });

// =========================================================================== 1. context accounting ===
{
  const ctx = createContextReader();
  const f = (name, rows) => w(path.join(T, "ses", name + ".jsonl"), jl(rows));
  const u1 = msg(null, "user"), a1 = asst(u1.id, U(10, 20, 1000, 70, 1100));
  eq("totalTokens wins (Pi calculateContextTokens)", ctx.read(f("total", [hdr(), u1, a1])).tokens, 1100);
  eq("sum of input+output+cacheRead+cacheWrite without totalTokens", calculateContextTokens(U(10, 20, 1000, 70)), 1100);
  const u2 = msg(null, "user"), a2 = asst(u2.id, U(1, 2, 300, 4)), t2 = msg(a2.id, "toolResult"), a3 = asst(t2.id, U(0, 0, 0, 0), { stopReason: "aborted" }), a4 = asst(a3.id, U(5, 5, 5, 5), { stopReason: "error" });
  const r2 = ctx.read(f("skip", [hdr(), u2, a2, t2, a3, a4]));
  eq("aborted / error / zero-usage responses are skipped", [r2.status, r2.tokens, r2.trailingMessages], ["measured", 307, 3]);
  eq("cache accounting kept as reported", r2.usage, { input: 1, output: 2, cacheRead: 300, cacheWrite: 4, totalTokens: null });
  const u3 = msg(null, "user"), a5 = asst(u3.id, U(1, 1, 1, 1, 5000)), cp = { type: "compaction", id: "c1", parentId: a5.id, timestamp: iso(NOW - 500), summary: "s", firstKeptEntryId: u3.id, tokensBefore: 5000 };
  const r3 = ctx.read(f("compacted", [hdr(), u3, a5, cp]));
  eq("compaction newer than the last usage -> null (awaiting)", [r3.status, r3.tokens], ["awaiting", null]);
  const u4 = msg(cp.id, "user"), a6 = asst(u4.id, U(1, 1, 1, 1, 900));
  eq("a response after the compaction -> measured again", ctx.read(f("compacted2", [hdr(), u3, a5, cp, u4, a6])).tokens, 900);
  // branches: the leaf is on the older branch; the abandoned branch's newer usage must not count
  const u5 = msg(null, "user"), a7 = asst(u5.id, U(0, 0, 0, 0, 111)), u6 = msg(a7.id, "user"), a8 = asst(u6.id, U(0, 0, 0, 0, 999)), bs = { type: "branch_summary", id: "b1", parentId: a7.id, timestamp: iso(NOW), fromId: a8.id, summary: "s" };
  eq("branch: usage from the current leaf's path only", ctx.read(f("branch", [hdr(), u5, a7, u6, a8, bs])).tokens, 111);
  // model change after the usage: Pi measures against the current model's window
  const u7 = msg(null, "user"), a9 = asst(u7.id, U(0, 0, 0, 0, 100000)), mc = { type: "model_change", id: "m1", parentId: a9.id, timestamp: iso(NOW), provider: "anthropic", modelId: "claude-big" };
  const r4 = ctx.read(f("modelchange", [hdr(), u7, a9, mc]));
  eq("model_change after the usage -> its model", [r4.provider, r4.model, r4.responseModel], ["anthropic", "claude-big", "claude-test"]);
  // incomplete last line (still being written) is ignored
  const u8 = msg(null, "user"), a10 = asst(u8.id, U(0, 0, 0, 0, 4242));
  const inc = w(path.join(T, "ses", "partial.jsonl"), jl([hdr(), u8, a10]) + JSON.stringify(asst(a10.id, U(0, 0, 0, 0, 1))).slice(0, 40));
  eq("a half-written last line is ignored", ctx.read(inc).tokens, 4242);
  eq("no session file -> missing, null", [ctx.read(path.join(T, "nope.jsonl")).status, ctx.read(path.join(T, "nope.jsonl")).tokens], ["missing", null]);
  const ro = f("unreadable", [hdr(), u1, a1]); fs.chmodSync(ro, 0);
  const rr = ctx.read(ro); fs.chmodSync(ro, 0o644);
  eq("unreadable session -> unreadable, null", [rr.status, rr.tokens], process.getuid?.() === 0 ? ["measured", 1100] : ["unreadable", null]);
  eq("no response yet -> unknown, null", [ctx.read(f("fresh", [hdr(), msg(null, "user")])).status, ctx.read(f("fresh", [hdr(), msg(null, "user")])).tokens], ["unknown", null]);
}
// ---- bounded tails, growth, incremental reads, caching ----
{
  const ctx = createContextReader({ firstTailBytes: 2048, maxTailBytes: 64 * 1024 });
  const u = msg(null, "user"), a = asst(u.id, U(0, 0, 0, 0, 777)); let last = a.id; const rows = [hdr(), u, a];
  for (let i = 0; i < 40; i++) { const t = msg(last, "toolResult", { content: [{ type: "text", text: "y".repeat(500) }] }); rows.push(t); last = t.id; }
  const f = w(path.join(T, "ses", "deep.jsonl"), jl(rows));
  const r = ctx.read(f);
  eq("usage found beyond the first tail (tail grows x8)", [r.tokens, r.trailingMessages, ctx.stats.fullReads], [777, 40, 1]);
  ctx.read(f); eq("unchanged file -> cache hit, no read", ctx.stats.cacheHits, 1);
  const b1 = ctx.stats.bytesRead, a2 = asst(last, U(0, 0, 0, 0, 888)); fs.appendFileSync(f, jl([a2]));
  const r2 = ctx.read(f);
  eq("appended response -> incremental read of the new bytes only", [r2.tokens, ctx.stats.incrementalReads, ctx.stats.fullReads, ctx.stats.bytesRead - b1 === Buffer.byteLength(jl([a2]))], [888, 1, 1, true]);
  const t3 = msg(a2.id, "toolResult"); fs.appendFileSync(f, jl([t3]));
  eq("appended tool result -> same figure, trailing +1, still incremental", [ctx.read(f).tokens, ctx.read(f).trailingMessages, ctx.stats.fullReads], [888, 1, 1]);
  const cp = { type: "compaction", id: "c9", parentId: t3.id, timestamp: iso(NOW), summary: "s", firstKeptEntryId: t3.id, tokensBefore: 1 };
  fs.appendFileSync(f, JSON.stringify(cp).slice(0, 30)); // half a line
  eq("half-written appended line -> old figure kept", ctx.read(f).tokens, 888);
  fs.appendFileSync(f, JSON.stringify(cp).slice(30) + "\n");
  eq("line completed: compaction -> null", [ctx.read(f).status, ctx.read(f).tokens], ["awaiting", null]);
  w(f, jl([hdr(), msg(null, "user")])); // replaced by a shorter file
  eq("replaced/shrunk file -> full re-read", [ctx.read(f).status, ctx.stats.fullReads], ["unknown", 2]);
  const big = createContextReader({ firstTailBytes: 1024, maxTailBytes: 4096 });
  eq("no usage within maxTailBytes -> unknown with the reason", big.read(path.join(T, "ses", "deep.jsonl")).status, "unknown");
  const rows2 = [hdr(), u, a]; last = a.id;
  for (let i = 0; i < 40; i++) { const t = msg(last, "toolResult", { content: [{ type: "text", text: "y".repeat(500) }] }); rows2.push(t); last = t.id; }
  const r5 = big.read(w(path.join(T, "ses", "deep2.jsonl"), jl(rows2)));
  eq("usage past the cap -> unknown, not a guess", [r5.status, r5.tokens, /last 0 MB|last/.test(r5.reason)], ["unknown", null, true]);
}

// =============================================================================== 2. priority ===
{
  eq("max total is 100", Object.values(PRIORITY_MAX).reduce((s, x) => s + x, 0), 100);
  const all = scorePriority({ status: "working", lastTurnAt: NOW - 60e3, turnsLastHour: 9, ownedProjects: 5, runningJobs: 4, blocked: true, openDecides: 2, pendingDemands: 3, liveHelpers: 2 }, NOW);
  eq("everything at once is capped at 100", [all.priority, all.details.missing], [100, []]);
  const mid = scorePriority({ status: "done", lastTurnAt: NOW - 20 * 60e3, turnsLastHour: 1, ownedProjects: 1, runningJobs: 1, blocked: false, openDecides: 0, pendingDemands: 0, liveHelpers: 0 }, NOW);
  eq("done, 20 min ago, 1 turn, 1 project, 1 job = 0+8+2+5+5", mid.priority, 20);
  const bg = scorePriority({ status: "background", lastTurnAt: null, turnsLastHour: 0, ownedProjects: 0, runningJobs: 0, blocked: false, openDecides: 0, pendingDemands: 1, liveHelpers: 1 }, NOW);
  eq("background 15 + demand 6 + helpers 6", bg.priority, 27);
  const miss = scorePriority({ status: "idle" }, NOW);
  eq("missing sources add 0 and are listed", [miss.priority, miss.details.missing], [0, ["recency", "turns", "projects", "jobs", "angus", "demands", "helpers"]]);
  eq("old turn (> 30 min) gives no recency", scorePriority({ status: "idle", lastTurnAt: NOW - 31 * 60e3 }, NOW).details.components.recency.points, 0);
  eq("formula text documents every component", Object.keys(PRIORITY_MAX).every((k) => PRIORITY_FORMULA.includes(k + " ")), true);
}

// ======================================================================= 3. the whole reader ===
const SES = path.join(T, "agent-sessions");
const sA = w(path.join(SES, "a.jsonl"), jl([hdr(), msg(null, "user", {}, "ua"), asst("ua", U(10, 90, 150000, 0), {}, "aa")])); // 150100 / 200000
const sC = w(path.join(SES, "c.jsonl"), jl([hdr(), msg(null, "user", {}, "uc"), asst("uc", U(0, 0, 0, 0, 10), { provider: "nowhere", model: "nomodel" }, "ac")]));
const LIST = {
  agents: [
    { id: "hp-a", name: "Alpha", room: "A", status: "working", model: "claude-test", topic: "t", session: sA, pid: 1001, host_pid: 0, container: "", compactions: 7, session_start: NOW - 2 * 86400e3, session_bytes: 10, refresh_due: true, helpers: [{ type: "Explore" }], children: [{ id: "hp-kid", name: "Kid", status: "running" }, { id: "hp-old", name: "Old", status: "closed" }], parent: "", parent_id: "" },
    { id: "hp-kid", name: "Kid", room: "A", status: "done", model: "claude-test", session: path.join(SES, "missing.jsonl"), pid: 1002, host_pid: 0, container: "", compactions: null, session_start: 0, session_bytes: 0, refresh_due: false, helpers: [], children: [], parent: "Alpha", parent_id: "hp-a" },
    { id: "hp-dock", name: "Docked", room: "B", status: "idle", model: "claude-test", session: sC, pid: 7, host_pid: 2002, container: "box1", compactions: 0, session_start: NOW - 60e3, refresh_due: false, helpers: [], children: [] },
    { id: "hp-dock2", name: "Docked2", room: "B", status: "idle", model: "x", session: "", pid: 8, host_pid: 0, container: "box2", compactions: null, session_start: 0, refresh_due: false, helpers: [], children: [] },
    { id: "sbx-world-g", name: "world-g", room: "G", status: "idle", model: "sandboxed", session: "", pid: 3003, host_pid: 0, container: "pi-sbx:world G", address: "", compactions: null, session_start: 0, refresh_due: false, helpers: [], children: [] },
    { id: "sbx-doorman-g", name: "Doorman-G", room: "G", status: "idle", model: "sandboxed", session: "", pid: 3003, host_pid: 0, container: "pi-sbx", address: "", compactions: null, session_start: 0, refresh_due: false, helpers: [], children: [] },
    { id: "H-ghost", name: "Ghost", room: "H", status: "working", model: "m", session: "", pid: 4242, host_pid: 4243, container: "", compactions: null, session_start: 0, refresh_due: false, helpers: [], children: [] },
  ],
  thoughts: [{ room: "A", name: "Thoughts-A", running: true }, { room: "B", name: "Thoughts-B", running: false }, { room: "G", name: "Thoughts-G", running: false, sandboxed: "world-g" }, { room: "H", name: "Thoughts-H", running: false, remote: true }],
  rooms: [{ id: "A" }, { id: "B" }, { id: "G" }, { id: "H", remote: true }, { id: "Q" }],
};
const ORCH = { children: [
  { id: "hp-kid", name: "Kid", parent: "hp-a", status: "running", budget: { tokens: 1500000, minutes: 180 }, used: { tokens: 123456 }, started_at: NOW - 600e3, job: "J9", last_report: PROMPT },
  { id: "hp-t1", name: "TKid", parent: "thoughts:A", status: "running", budget: { tokens: 1000, minutes: 1 }, used: { tokens: 1 } },
  { id: "hp-t2", name: "TOld", parent: "thoughts:A", status: "closed", budget: { tokens: 1000, minutes: 1 }, used: { tokens: 1 } },
] };
const calls = { list: 0, "orch.all": 0, other: [] };
const request = async (m) => { if (m === "list") { calls.list++; return LIST; } if (m === "orch.all") { calls["orch.all"]++; return ORCH; } calls.other.push(m); throw new Error("not allowed in this test: " + m); };
// persisted state
w(path.join(STATE, "boards", "A.json"), { room: "A", projects: [
  { name: "p1", status: "active", writer: "hp-a", items: [{ sec: "decide", text: PROMPT, by: { id: "hp-kid" } }, { sec: "decide", archived: 1, by: { id: "hp-a" } }] },
  { name: "p2", status: "new", writer: "hp-a", items: [] }, { name: "p3", status: "archived", writer: "hp-a", items: [] }, { name: "p4", status: "active", writer: "thoughts:A", items: [] }] });
w(path.join(STATE, "briefs.json"), { briefs: { J1: { id: "J1", state: "running", agent: "hp-a", updated: 5, fields: { angus: PROMPT } }, J2: { id: "J2", state: "running", agent: "hp-a", updated: 9 }, J3: { id: "J3", state: "verified", agent: "hp-a" } } });
w(path.join(STATE, "requests.json"), [
  ["r1", { mode: "demand", recipients: ["hp-kid"], replies: [], ts: NOW - 60e3, text: PROMPT }], ["r2", { mode: "demand", recipients: ["hp-a"], replies: [["hp-a", {}]], ts: NOW - 60e3 }],
  ["r3", { mode: "demand", recipients: ["hp-a"], replies: [], ts: NOW - 2 * 3600e3 }], ["r4", { mode: "talk", recipients: ["hp-a"], replies: [], ts: NOW }], ["r5", { mode: "demand", recipients: ["hp-a"], replies: [], ts: NOW, cancelled: true }]]);
w(path.join(STATE, "upkeep.json"), { agents: { "hp-a": { history: [NOW - 86400e3, NOW - 3 * 86400e3, NOW - 9 * 86400e3] } }, thoughts: {}, paused: [] });
const ev = (ts, kind, id, extra = {}) => ({ v: 1, ts, room: "A", kind, text: PROMPT, agent: { id, name: id }, ...extra });
w(path.join(STATE, "activity", "A.jsonl"), jl([ev(NOW - 10 * 86400e3, "restarted", "hp-a"), ev(NOW - 2 * 86400e3, "restarted", "hp-a"), ev(NOW - 50 * 60e3, "done", "hp-a"), ev(NOW - 20 * 60e3, "tool", "hp-a"), ev(NOW - 3 * 60e3, "done", "hp-a"), ev(NOW - 2 * 60e3, "turn", "hp-a"), ev(NOW - 90 * 60e3, "done", "hp-kid")]));
w(path.join(STATE, "activity", "B.jsonl"), jl([ev(NOW - 3600e3, "restarted", "hp-dock")]) + '{"v":1,"ts":'); // a torn last line
// Thoughts A: session + model marker; its process is a child of the daemon with the identity arguments
w(path.join(STATE, "thoughts", "A", "x_thoughts-A.jsonl"), jl([hdr(NOW - 7200e3), msg(null, "user", {}, "tu"), asst("tu", U(0, 0, 0, 0, 20000), {}, "ta")]) + '{"type":"compaction","id":"tc1","parentId":"ta","timestamp":"' + iso(NOW) + '","summary":"s","firstKeptEntryId":"tu","tokensBefore":1}\n');
w(path.join(STATE, "thoughts", "A.model.json"), { model: "claude-test", thinking: "" });
const proc = (pid, argv) => w(path.join(PROC, String(pid), "cmdline"), argv.join("\0") + "\0");
const DAEMON = 900;
w(path.join(PROC, String(DAEMON), "task", String(DAEMON), "children"), "5001 5002 5003 ");
proc(5001, ["pi", "--mode", "rpc", "--session-dir", path.join(STATE, "thoughts", "A"), "--session-id", "thoughts-A", "--system-prompt", PROMPT]);
proc(5002, ["pi", "--mode", "rpc", "--session-dir", path.join(T, "elsewhere"), "--session-id", "thoughts-B"]); // wrong session dir: not Thoughts-B
proc(5003, ["node", "something-else"]);
proc(6001, ["pi", "--session-id", "thoughts-B", "--session-dir", path.join(STATE, "thoughts", "B")]); // right args but NOT the daemon's child
// remote world H mirror + transport, sandboxed world G mirror
const HD = path.join(STATE, "worlds", "world-h"), GD = path.join(STATE, "worlds", "world-g");
w(path.join(HD, "agents.json"), { world: "H", room: "H", at: NOW - 5e3, agents: [{ id: "h-1", name: "Hana", status: "working", model: "m", pid: 4444 }], thoughts: "idle" });
w(path.join(HD, "status.pid"), "7001"); proc(7001, ["node", "/x/omnistation/world-status.mjs", "H"]);
w(path.join(HD, "windows.json"), { world: "H", windows: { "0xa": { kind: "agent", home: 71, pid: 7002 }, "0xb": { kind: "agent", home: 72, pid: 7999 } } }); proc(7002, ["kitty"]); // 7999 doesn't exist
fs.utimesSync(path.join(HD, "windows.json"), new Date(NOW), new Date(NOW));
w(path.join(GD, "agents.json"), { world: "G", room: "G", at: NOW - 999e3, agents: [{ name: "Gee", status: "idle", model: "m" }], thoughts: "off" });
w(path.join(GD, "status.pid"), "7101"); proc(7101, ["node", "/x/omnistation/world-status.mjs", "H"]); // wrong world letter: not G's helper

let clock = NOW;
const reader = createTelemetryReader({ request, statePath: STATE, home: T, piDir: PI, procRoot: PROC, daemonPid: DAEMON, now: () => clock });
const r = await reader.read();
const row = (id) => r.agents.find((a) => a.id === id);
const A = row("hp-a"), K = row("hp-kid"), D = row("hp-dock"), D2 = row("hp-dock2"), TA = row("thoughts:A");
eq("API shape", Object.keys(r).filter((k) => ["timestampMs", "agents", "warnings", "priorityFormula", "worlds"].includes(k)).length, 5);
eq("every row carries the agreed fields", r.agents.every((a) => ["id", "name", "world", "status", "model", "topic", "job", "remote", "pids", "envIds", "helpers", "registeredHelpers", "inProcessHelpers", "contextTokens", "contextWindow", "contextPercent", "compactions", "sessionAgeSeconds", "restarts", "refreshes", "refreshDue", "budgetUsed", "budgetLimit", "priority", "priorityDetails"].every((k) => k in a)), true);
eq("only list + orch.all are called", [calls.list, calls["orch.all"], calls.other], [1, 1, []]);
// daemon field parity
eq("daemon parity: compactions, session age, refresh_due", [A.compactions, A.sessionAgeSeconds, A.refreshDue, A.status, A.model, A.topic, A.world], [7, 172800, true, "working", "claude-test", "t", "A"]);
eq("unknown compactions -> refreshDue null (daemon says false), session age null", [K.compactions, K.refreshDue, K.source.refresh_due, K.sessionAgeSeconds], [null, null, false, null]);
// context
eq("context: tokens / window / percent from the exact catalog entry", [A.contextTokens, A.contextWindow, A.contextPercent], [150100, 200000, 75.1]);
eq("missing session -> null context, not 0", [K.contextTokens, K.contextPercent, K.context.status], [null, null, "missing"]);
eq("model not in the catalog -> window null, tokens kept, warned", [D.contextTokens, D.contextWindow, D.contextPercent, r.warnings.some((x) => /Docked: context window unknown/.test(x))], [10, null, null, true]);
// helpers + budgets
eq("helpers: registered live children + in-process subagents", [A.helpers, A.registeredHelpers, A.inProcessHelpers], [2, ["hp-kid"], 1]);
eq("helper budget exactly from orch.all", [K.budgetUsed, K.budgetLimit, K.budget.minutesLimit, A.budgetUsed, A.budgetLimit], [123456, 1500000, 180, null, null]);
eq("job: newest running brief, else the orch job", [A.job, A.jobs, K.job], ["J2", ["J2", "J1"], "J9"]);
// restarts / refreshes with windows
eq("restarts in the 7-day window from activity; refreshes from upkeep history", [A.restarts, A.refreshes, D.restarts, D.refreshes], [1, 2, 1, 0]);
eq("windows say where and since when", [A.windows.restarts.sinceMs, A.windows.refreshes.sinceMs, /activity/.test(A.windows.restarts.source)], [NOW - 7 * 86400e3, NOW - 7 * 86400e3, true]);
// priority from the sources
const pc = A.priorityDetails.components;
eq("priority components for Alpha", [pc.active.points, pc.recency.points, pc.turns.points, pc.projects.points, pc.jobs.points, pc.angus.points, pc.demands.points, pc.helpers.points, A.priority], [35, 15, 4, 10, 10, 0, 0, 6, 80]);
eq("Kid: open decide item -> waiting on Angus; live demand; old turn", [K.priorityDetails.components.angus.points, K.priorityDetails.components.demands.points, K.priorityDetails.components.recency.points, K.priority], [8, 6, 0, 14]);
// PIDs
eq("normal agent: its pid; container: host_pid", [A.pids, D.pids], [[1001], [2002]]);
eq("container agent without host_pid: no laptop root, warned", [D2.pids, r.warnings.some((x) => /Docked2: container agent without a host pid/.test(x))], [[], true]);
eq("sandbox placeholders share the relay pid: counted once", [row("sbx-world-g").pids, row("sbx-doorman-g").pids], [[3003], []]);
const ghost = row("H-ghost");
eq("an agent listed in a remote world never gets a laptop root", [ghost.pids, ghost.remote, ghost.envIds], [[], true, []]);
const hana = r.agents.find((a) => a.kind === "remote-agent");
eq("remote mirror agent: remote, no pids, no context", [hana.name, hana.world, hana.remote, hana.pids, hana.contextTokens, hana.envWorld ?? null], ["Hana", "H", true, [], null, null]);
const envH = row("env:H"), envG = row("env:G");
eq("remote world transport row: verified helper + live window pids only", [envH.pids, envH.envWorld, envH.remote], [[7001, 7002], "H", true]);
eq("sandbox world: mirror agents share the placeholders' envIds; stale mirror warned; wrong helper not a root", [r.agents.find((a) => a.name === "Gee").envIds, envG.pids, r.warnings.some((x) => /world G: mirror is stale/.test(x))], [["sbx-world-g", "sbx-doorman-g"], [], true]);
eq("no Thoughts row for remote/sandboxed worlds", [!!row("thoughts:H"), !!row("thoughts:G")], [false, false]);
// Thoughts
eq("Thoughts-A: daemon child with its identity args; model marker; compactions counted", [TA.pids, TA.model, TA.compactions, TA.status, TA.sessionAgeSeconds], [[5001], "claude-test", 1, "running", 7200]);
eq("Thoughts-A context after its compaction -> null (awaiting)", [TA.contextTokens, TA.context.status], [null, "awaiting"]);
eq("Thoughts-A helpers + owned project", [TA.registeredHelpers, TA.priorityDetails.components.projects.points], [["hp-t1"], 5]);
eq("a not-running Thoughts whose look-alike process isn't the daemon's child: no row", !!row("thoughts:B"), false);
eq("worlds list covers empty and remote worlds", r.worlds.map((x) => `${x.id}:${x.remote ? "r" : x.sandboxed ? "s" : "l"}:${x.agentCount}`), ["A:l:2", "B:l:2", "G:s:1", "H:r:1", "Q:l:0"]);
// no leaks
const out = JSON.stringify(r);
eq("no secret, prompt or report text in the output", [out.includes(SECRET), out.includes(PROMPT)], [false, false]);

// caching of slow sources: board/jobs/requests/upkeep/activity/orch at most every slowMs (10 s); list every read
w(path.join(STATE, "briefs.json"), { briefs: {} });
clock = NOW + 5e3; const r2 = await reader.read();
eq("within 10 s: slow sources cached, list read again", [r2.agents.find((a) => a.id === "hp-a").jobs, calls.list, calls["orch.all"]], [["J2", "J1"], 2, 1]);
clock = NOW + 11e3; const r3 = await reader.read();
eq("after 10 s: re-read", [r3.agents.find((a) => a.id === "hp-a").jobs, calls.list, calls["orch.all"]], [[], 3, 2]);
fs.appendFileSync(path.join(STATE, "activity", "A.jsonl"), jl([ev(NOW + 12e3, "restarted", "hp-a")]));
fs.appendFileSync(path.join(STATE, "activity", "B.jsonl"), '"x":1}\n' + jl([ev(NOW + 12e3, "restarted", "hp-dock")])); // the torn line completes (bad JSON) then a real one
clock = NOW + 22e3; const r4 = await reader.read();
eq("activity read incrementally (appended restarts counted)", [r4.agents.find((a) => a.id === "hp-a").restarts, r4.agents.find((a) => a.id === "hp-dock").restarts], [2, 2]);
eq("session files cached across reads", r4.cache.cacheHits >= 4, true);
// daemon down -> empty list + a warning, no throw
const down = createTelemetryReader({ request: async () => { throw new Error("ECONNREFUSED"); }, statePath: STATE, piDir: PI, procRoot: PROC, daemonPid: DAEMON, now: () => NOW });
const rd = await down.read();
eq("daemon not answering -> no rows, a warning", [rd.agents.length, /daemon not answering/.test(rd.warnings[0])], [0, true]);
reader.close?.();

fs.rmSync(T, { recursive: true, force: true });
console.log(`${n - fails}/${n} passed`);
process.exit(fails ? 1 : 0);
