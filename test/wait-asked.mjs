#!/usr/bin/env node
// J729 (Tinker's J728 wait, Thoughts-C for Angus): a parent sent its idle child new work (talk) and called wait_report at the same
// moment; the wait returned AT ONCE, "no report yet … its turn ended without a report", because the child had been idle over a
// minute (J452's rule), and the child's reports half a minute later went past it. Now the parent's message counts as new work.
//  Q1 the exact sequence: child idle 4 min, parent asks it, then waits: the wait does NOT return at once
//  Q2 … and returns when the child reports (seconds later)
//  Q3 J452 still holds: a child idle a minute with no ask doesn't hold an "all" wait (back at once)
//  Q4 a child asked and still idle a minute after the ask: the wait ends then (doesn't hang to the limit)
//  Q5 the state says it was messaged and hasn't started, not "its turn ended without a report"
//  Q6 only the child's PARENT counts (a talk from someone else isn't new work for this wait)
//  Q7 the daemon wiring: a real talk from the parent through an isolated daemon sets askedAt (talkOut → orch.asked)
//   node test/run.mjs test/wait-asked.mjs   (exit 0 = pass)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { requireSandbox } from "./guard/sandbox.mjs";
await requireSandbox(import.meta.url);
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const T = fs.mkdtempSync(path.join(os.tmpdir(), "j729-"));
fs.mkdirSync(path.join(T, "cfg", "hyprpi"), { recursive: true });
fs.writeFileSync(path.join(T, "cfg", "hyprpi", "hyprpi.jsonc"), '{ "orchestration": { "waitDefaultSec": 600, "waitMaxSec": 3600 } }');
process.env.XDG_CONFIG_HOME = path.join(T, "cfg");
const { createOrch } = await import("../lib/orch.mjs");
const keepAlive = setInterval(() => {}, 1000);
let fails = 0; const ok = (n, c, x = "") => { if (!c) fails++; console.log(`${c ? "ok  " : "FAIL"} ${n}${x && !c ? ": " + x : ""}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const kid = (id, name) => ({ id, name, parent: "hp-mom", parentName: "Mom", room: "C", prompt: "check", model: "m", thinking: "", budget: { tokens: 0, minutes: 0 }, used: { tokens: 0 }, startedAt: Date.now() - 900000, status: "running", reports: [], escalations: 0, depth: 1 });
fs.writeFileSync(path.join(T, "orch.json"), JSON.stringify({ children: { "hp-chk": kid("hp-chk", "Checker"), "hp-old": kid("hp-old", "Oldie"), "hp-late": kid("hp-late", "Late"), "hp-other": kid("hp-other", "Other") } }));
const idle4 = { status: "done", since: Date.now() - 240000 };
const info = { "hp-chk": { ...idle4 }, "hp-old": { ...idle4 }, "hp-late": { ...idle4 }, "hp-other": { ...idle4 } };
const orch = createOrch({ stateDir: T, deps: { send: () => true, note: () => {}, liveAgent: () => null, agentName: () => "Mom", thoughtsReport: () => {}, roomOf: () => "C", agentInfo: (id) => info[id] || null } });
const race = (p, ms) => Promise.race([p.then((r) => ({ r })), sleep(ms).then(() => ({ pending: true }))]);

// Q1 + Q2
orch.asked("hp-chk", "hp-mom");
const w1 = orch.wait("hp-mom", ["hp-chk"], {});
const q1 = await race(w1, 1500);
ok("Q1 asked then waited: the wait does NOT return at once", q1.pending === true, JSON.stringify(q1));
info["hp-chk"] = { status: "working", since: Date.now() }; await sleep(200);
orch.report("hp-chk", { text: "re-check: PASS", final: true });
const q2 = await race(w1, 1500);
ok("Q2 … and returns with the child's report", q2.r && q2.r.reports.some((r) => /re-check: PASS/.test(r.text)), JSON.stringify(q2));

// Q3 (J452 unchanged)
const q3 = await race(orch.wait("hp-mom", ["hp-old"], {}), 1500);
ok("Q3 an idle child with no ask: back at once, as before (J452)", q3.r && q3.r.reports.length === 0 && /its turn ended without a report/.test(JSON.stringify(q3.r.still_working)), JSON.stringify(q3));

// Q5 state wording
orch.asked("hp-late", "hp-mom");
const st5 = orch.get("hp-late").state;
ok("Q5 the state says it was messaged and hasn't started", /you messaged it \d+ s ago and it hasn't started on that yet/.test(st5), st5);

// Q4: asked 59.5 s ago and never started → the wait ends about half a second later (not at the 600 s limit)
{ const o = JSON.parse(fs.readFileSync(path.join(T, "orch.json"), "utf8")); } // (state is in memory; move the ask back instead)
const c4 = orch.all().find((c) => c.id === "hp-late"); // view only; adjust through asked() timing instead
orch.asked("hp-late", "hp-mom");
const realNow = Date.now; Date.now = () => realNow() + 59000; // the ask was 59 s ago
const w4 = orch.wait("hp-mom", ["hp-late"], {});
const q4a = await race(w4, 300);
ok("Q4 asked 59 s ago: still held", q4a.pending === true, JSON.stringify(q4a));
Date.now = () => realNow() + 61000; // a minute after the ask, still idle
const q4b = await race(w4, 2500);
Date.now = realNow;
ok("Q4 … a minute after the ask with no start, the wait ends (no hang to the limit)", q4b.r && q4b.r.reports.length === 0, JSON.stringify(q4b).slice(0, 300));

// Q6 only the parent
ok("Q6 a talk from someone else isn't the parent's ask", orch.asked("hp-other", "hp-stranger") === false);
const q6 = await race(orch.wait("hp-mom", ["hp-other"], {}), 1500);
ok("Q6 … so the idle child doesn't hold the wait", q6.r && q6.r.reports.length === 0, JSON.stringify(q6));

// Q7 daemon wiring: an isolated daemon (temp socket/state/config, no pi, no window); Mom talks to her child Kid
const S = path.join(T, "d"), sock = path.join(S, "d.sock"), cfg = path.join(S, "cfg"); fs.mkdirSync(path.join(cfg, "hyprpi"), { recursive: true });
fs.writeFileSync(path.join(cfg, "hyprpi", "config.json"), JSON.stringify({ roomToThoughts: false, pi: "/bin/cat", worldSize: 10, cwd: S, turnLines: false, topics: false }));
fs.writeFileSync(path.join(cfg, "hyprpi", "hyprpi.jsonc"), JSON.stringify({ auth: { enabled: false }, upkeep: { refresh: { enabled: false, rssMB: 0 }, autoReload: { enabled: false } } }));
fs.writeFileSync(path.join(S, "orch.json"), JSON.stringify({ children: { "hp-kid": { ...kid("hp-kid", "Kid"), room: "A" } } }));
const env = { ...process.env, HYPRPI_SOCKET: sock, HYPRPI_STATE: S, XDG_CONFIG_HOME: cfg, HYPRLAND_INSTANCE_SIGNATURE: "j729-bogus", HYPRPI_NO_ENSURE: "1", HYPRPI_UPKEEP_MS: "3600000" };
delete env.HYPRPI_AGENT_ID; delete env.HYPRPI_WORKSPACE;
const d = spawn(process.execPath, [path.join(ROOT, "bin/hyprpi"), "daemon"], { env, stdio: ["ignore", fs.openSync(path.join(S, "d.log"), "a"), fs.openSync(path.join(S, "d.log"), "a")] });
try {
  for (let i = 0; i < 50 && !fs.existsSync(sock); i++) await sleep(200);
  const { connect } = await import(path.join(ROOT, "lib/client.mjs"));
  const kidC = await connect({ path: sock, onEvent: () => {} });
  await kidC.call("agent.hello", { agent_id: "hp-kid", pid: process.pid, name: "Kid", want_workspace: 2, cwd: S });
  await kidC.call("agent.update", { status: "working" }); await kidC.call("agent.update", { status: "done" });
  const mom = await connect({ path: sock, onEvent: () => {} });
  await mom.call("agent.hello", { agent_id: "hp-mom", pid: process.pid, name: "Mom", want_workspace: 1, cwd: S });
  await mom.call("talk", { to: ["Kid"], text: "please re-check" });
  await sleep(300);
  const ch = (await mom.call("orch.children", {})).children?.find?.((c) => c.id === "hp-kid") || null;
  const disk = () => JSON.parse(fs.readFileSync(path.join(S, "orch.json"), "utf8")).children["hp-kid"];
  for (let i = 0; i < 20 && !disk().askedAt; i++) await sleep(200);
  ok("Q7 a real talk from the parent sets the child's askedAt (talkOut → orch.asked)", disk().askedAt > Date.now() - 10000, JSON.stringify({ askedAt: disk().askedAt, ch }));
  kidC.close(); mom.close();
} finally { d.kill("SIGTERM"); await sleep(400); }

clearInterval(keepAlive);
fs.rmSync(T, { recursive: true, force: true });
console.log(fails ? `wait-asked: ${fails} FAILED` : "wait-asked: all pass");
process.exit(fails ? 1 : 0);
