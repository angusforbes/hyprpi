#!/usr/bin/env node
// J564 v3 (Angus: "a version of hyprpi top to also be a TUI so i can navigate it and kill highlighted agents" … "also does hyprpi
// top show other agents like pi, cc, or codex agents? … yes"). Rewritten after J565, where the v2 test, against the LIVE /proc,
// pressed x/y on a row it hadn't found and could close a real pi. This test touches NO real process, daemon or window:
//   - /proc is a SYNTHETIC folder (stat, cmdline, environ, cwd per pid) read by the real ProcSampler (procRoot seam);
//   - the daemon is a fake request(); Hyprland is fake clients/focus/close; every signal goes to a spy that only edits the
//     synthetic /proc; process.kill itself is replaced by a tripwire that throws for any call during the test;
//   - every key press that could act (x, y, Enter) is preceded by select(), which ABORTS the test unless the highlighted row
//     is exactly the expected one (by id), so a failed search can never confirm a close on the wrong row.
//   node test/top-tui.mjs   (exit 0 = pass)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";

// ---- tripwire: no real signal can leave this test
const realKill = process.kill.bind(process);
process.kill = (pid, sig) => { if (pid === process.pid && (sig === 0 || sig == null)) return realKill(pid, 0); throw new Error(`J565 tripwire: process.kill(${pid}, ${sig}) attempted in a synthetic test`); };

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
let fails = 0; const ok = (n, c, x = "") => { if (!c) fails++; console.log(`${c ? "ok  " : "FAIL"} ${n}${x ? ": " + x : ""}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const { ProcSampler, toolOfArgv } = await import(path.join(ROOT, "lib/top-proc.mjs"));
const real = await import(path.join(ROOT, "lib/top-actions.mjs"));
const { runTop } = await import(path.join(ROOT, "lib/top.mjs"));

// ---- a synthetic /proc
const P = fs.mkdtempSync(path.join(os.tmpdir(), "j564v3-proc-")), WORK = fs.mkdtempSync(path.join(os.tmpdir(), "j564v3-work-"));
fs.writeFileSync(path.join(P, "stat"), "cpu  1000 0 1000 10000 0 0 0 0\ncpu0 500 0 500 5000 0 0 0 0\ncpu1 500 0 500 5000 0 0 0 0\n");
fs.writeFileSync(path.join(P, "loadavg"), "0.50 0.40 0.30 1/100 999\n");
fs.writeFileSync(path.join(P, "uptime"), "100000.00 90000.00\n");
fs.writeFileSync(path.join(P, "meminfo"), "MemTotal: 16000000 kB\nMemAvailable: 8000000 kB\nSwapTotal: 0 kB\nSwapFree: 0 kB\n");
const procs = new Map(); // pid -> { comm, ppid, start, argv, env, cwd }
function put(pid, { comm, ppid = 1, start = 1000 + pid, argv = [comm], env = {}, cwd = WORK }) {
  const d = path.join(P, String(pid)); fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, "stat"), `${pid} (${comm}) S ${ppid} ${pid} ${pid} 0 -1 0 0 0 0 0 10 5 0 0 20 0 1 0 ${start} 1000000 2500 0\n`);
  fs.writeFileSync(path.join(d, "cmdline"), argv.join("\0") + "\0");
  fs.writeFileSync(path.join(d, "environ"), Object.entries(env).map(([k, v]) => `${k}=${v}`).join("\0") + "\0");
  try { fs.rmSync(path.join(d, "cwd"), { force: true }); } catch { /* none */ } fs.symlinkSync(cwd, path.join(d, "cwd"));
  procs.set(pid, { comm, ppid, start, argv, env, cwd });
}
const drop = (pid) => { fs.rmSync(path.join(P, String(pid)), { recursive: true, force: true }); procs.delete(pid); };
const has = (pid) => fs.existsSync(path.join(P, String(pid)));
fs.mkdirSync(path.join(WORK, "pi-proj")); fs.mkdirSync(path.join(WORK, "cc-proj")); fs.mkdirSync(path.join(WORK, "codex-proj"));
put(1, { comm: "systemd" });
put(500, { comm: "kitty", argv: ["kitty"] });                                                       // a terminal
put(501, { comm: "pi", ppid: 500, argv: ["pi"], env: { HYPRPI_AGENT_ID: "hp-atlas" } });             // agent Atlas (world A)
put(511, { comm: "pi", ppid: 500, argv: ["pi"], env: { HYPRPI_AGENT_ID: "hp-bolt" } });              // agent Bolt (world B): briefs, projects, helpers
put(521, { comm: "pi", ppid: 500, argv: ["pi"], env: { HYPRPI_AGENT_ID: "hp-stale" } });             // agent Stale: its registered pid gets reused later
put(560, { comm: "pi", ppid: 500, argv: ["pi"], env: { HYPRPI_AGENT_ID: "hp-parent" } });           // agent Parent, in the kitty window
put(561, { comm: "pi", ppid: 560, argv: ["pi"], env: { HYPRPI_AGENT_ID: "hp-kid" } });              // agent Kid: headless, nested under Parent
put(570, { comm: "bash", ppid: 500, argv: ["bash", "/opt/tools/claude"], cwd: WORK });                // a claude launcher run as `bash /…/claude`
put(600, { comm: "pi", ppid: 500, argv: ["pi"], cwd: path.join(WORK, "pi-proj") });                  // a plain pi (Other agents)
put(601, { comm: "sleep", ppid: 600, argv: ["sleep", "600"] });                                      //   … with a child
put(610, { comm: "pi", ppid: 500, argv: ["pi"], cwd: WORK });                                        // a decoy plain pi: must survive
put(611, { comm: "sleep", ppid: 610, argv: ["sleep", "600"] });
put(620, { comm: "claude", ppid: 500, argv: ["/usr/bin/claude"], cwd: path.join(WORK, "cc-proj") }); // Claude Code
put(630, { comm: "node", ppid: 500, argv: ["node", "/x/node_modules/@openai/codex/bin/codex.js"], cwd: path.join(WORK, "codex-proj") }); // Codex wrapper
put(631, { comm: "codex-x86_64-un", ppid: 630, argv: ["/x/codex-x86_64-unknown-linux-musl"], cwd: path.join(WORK, "codex-proj") });     // … its native binary
put(640, { comm: "vim", ppid: 500, argv: ["vim", "claude.md"] });                                     // not agents
put(641, { comm: "bash", ppid: 500, argv: ["bash", "-lc", "claude"] });
put(642, { comm: "claudette", ppid: 500, argv: ["claudette"] });
put(900, { comm: "node", ppid: 1, argv: ["node", "top"] });                                           // the monitor itself (selfPid)

// ---- fake daemon, telemetry, Hyprland, signals
const agentsMeta = () => [
  { id: "hp-atlas", kind: "agent", name: "Atlas", world: "A", status: "idle", pids: [501], envIds: ["hp-atlas"], registeredHelpers: [], priorityDetails: { components: {} } },
  { id: "hp-bolt", kind: "agent", name: "Bolt", world: "B", status: "working", pids: [511], envIds: ["hp-bolt"], registeredHelpers: ["hp-kid"], priorityDetails: { components: { jobs: { value: 2 }, projects: { value: 1 } } } },
  { id: "hp-stale", kind: "agent", name: "Stale", world: "B", status: "idle", pids: [521], envIds: ["hp-stale"], registeredHelpers: [], priorityDetails: { components: {} } },
  { id: "hp-aardvark", kind: "agent", name: "Aardvark", world: "B", status: "working", pids: [531], envIds: ["hp-aardvark"], registeredHelpers: [], priorityDetails: { components: {} } },
  { id: "hp-parent", kind: "agent", name: "Parent", world: "C", status: "idle", pids: [560], envIds: ["hp-parent"], registeredHelpers: ["hp-kid"], priorityDetails: { components: {} } },
  { id: "hp-kid", kind: "agent", name: "Kid", world: "C", status: "idle", pids: [561], envIds: ["hp-kid"], registeredHelpers: [], priorityDetails: { components: {} } },
  { id: "thoughts:A", kind: "thoughts", name: "Thoughts-A", world: "A", status: "idle", pids: [], envIds: [], priorityDetails: { components: {} } },
].filter((a) => listedIds.has(a.id));
let listedIds = new Set(["hp-atlas", "hp-bolt", "hp-stale", "hp-parent", "hp-kid", "thoughts:A"]);
const calls = { kill: [], close: [], focus: [], agentFocus: [] };
const request = async (m, p) => {
  if (m === "list") return { agents: [...listedIds].filter((x) => x.startsWith("hp-")).map((id) => ({ id })) };
  if (m === "agent.focus") { calls.agentFocus.push(p.agent); return { ok: true }; }
  throw new Error(`fake daemon: no ${m}`);
};
const windows = [{ address: "0xaaa", pid: 500, class: "kitty" }];
const spyKill = (pid, sig) => { calls.kill.push([pid, sig]); if (!stubborn.has(pid) || sig === "SIGKILL") drop(pid); };
const stubborn = new Set();
const seams = { procRoot: P, kill: spyKill };
const actions = {
  ...real,
  endTree: (t, sig) => real.endTree(t, sig, seams),
  aliveOf: (t) => real.aliveOf(t, P),
  closeAgent: (t) => real.closeAgent(t, { ...seams, request, sleep: (ms) => sleep(Math.min(ms, 20)), timeoutMs: 2000, clients: async () => windows, blocked: () => false,
    windowForPid: (pid) => { for (let p = pid, g = 0; p > 1 && g < 10; p = procs.get(p)?.ppid ?? 0, g++) { const w = windows.find((x) => x.pid === p); if (w) return w; } return null; },
    closeWindow: async (addr) => { calls.close.push([t.id, addr]); listedIds.delete(t.id); for (const p of t.rootPids) drop(p); } }),
  focusRow: (a) => real.focusRow(a, { request, procRoot: P, clients: async () => windows, blocked: () => false, focusWindow: async (addr) => { calls.focus.push(addr); },
    windowForPid: (pid) => { for (let p = pid, g = 0; p > 1 && g < 10; p = procs.get(p)?.ppid ?? 0, g++) { const w = windows.find((x) => x.pid === p); if (w) return w; } return null; } }),
};
const telemetry = { read: async () => ({ agents: agentsMeta(), worlds: [], warnings: [] }), close: () => {} };
let clock = 0;
const sampler = new ProcSampler({ procRoot: P, clockTicks: 100, pageSize: 4096, selfPid: 900, fullScanEvery: 1, now: () => (clock += 500) });

// ---- unit: detection
ok("detection: claude, codex (script + native), pi; not vim claude.md / bash -lc claude / claudette", toolOfArgv(["/usr/bin/claude"]) === "Claude Code" && toolOfArgv(["node", "/x/node_modules/@openai/codex/bin/codex.js"]) === "Codex"
  && toolOfArgv(["/x/codex-x86_64-unknown-linux-musl"]) === "Codex" && toolOfArgv(["pi"]) === "Pi" && toolOfArgv(["vim", "claude.md"]) === null && toolOfArgv(["bash", "-lc", "claude"]) === null && toolOfArgv(["claudette"]) === null);

// ---- --once --json (W5)
{ let out = ""; const o = new PassThrough(); o.on("data", (x) => { out += x; });
  await runTop(["--once", "--json"], { stdout: o, stdin: new PassThrough(), telemetry, sampler: new ProcSampler({ procRoot: P, clockTicks: 100, pageSize: 4096, selfPid: 900, fullScanEvery: 1, now: () => (clock += 500) }), sleep: async () => {} });
  const snap = JSON.parse(out.trim().split("\n").at(-1)), other = snap.agents.filter((a) => a.world === "Unattributed");
  const by = (root) => other.find((a) => a.rootPid === root);
  ok("W5 --json: plain pi with folder, tree (2 pids), uptime, RSS", by(600)?.tool === "Pi" && by(600).cwd === path.join(WORK, "pi-proj") && by(600).processCount === 2 && by(600).uptimeSeconds > 0 && by(600).rssBytes > 0);
  ok("W5 --json: Claude Code with its folder and terminal", by(620)?.tool === "Claude Code" && by(620).cwd === path.join(WORK, "cc-proj") && by(620).terminal === "kitty");
  ok("W5 --json: Codex wrapper + native binary are ONE row rooted at the wrapper (TopCheck564)", by(630)?.tool === "Codex" && by(630).processCount === 2 && !by(631));
  ok("W5 --json: `bash /opt/tools/claude` is Claude Code (TopCheck564b)", by(570)?.tool === "Claude Code");
  ok("W5 --json: vim claude.md, bash -lc claude, claudette aren't agents", !other.some((a) => [640, 641, 642].includes(a.rootPid)));
  ok("W5 --json: the agents' own pi processes aren't Other agents", !other.some((a) => [501, 511, 521].includes(a.rootPid)));
}

// ---- the live TUI in a fake terminal
const out = new PassThrough(), inp = new PassThrough(); let screen = "";
Object.assign(out, { isTTY: true, columns: 220, rows: 70 }); Object.assign(inp, { isTTY: true, isRaw: false, setRawMode(v) { this.isRaw = v; return this; } });
out.on("data", (x) => { screen = String(x).startsWith("\x1b[H") ? String(x) : screen + x; });
const run = runTop(["--interval", "0.5"], { stdout: out, stdin: inp, telemetry, sampler, actions, request, sleep: (ms) => sleep(Math.min(ms, 50)) });
const key = (name) => inp.emit("keypress", name.length === 1 ? name : "", { name });
const hl = () => (/\x1b\[7m([^\x1b]*)\x1b\[27m/.exec(screen) || [])[1] || "";
const footer = () => screen.slice(screen.lastIndexOf("\n") + 1).replace(/\x1b\[[0-9;]*m/g, "");
const until = async (f, ms = 5000) => { const t = Date.now(); while (Date.now() - t < ms) { const v = await f(); if (v) return v; await sleep(25); } return f(); };
// select(re): Home, then down until the highlight matches; THROWS (aborting the whole test, before any x/y) if it never does
class Abort extends Error {}
async function select(re) {
  key("home"); await sleep(30);
  for (let i = 0, last = null; i < 60; i++) { if (re.test(hl())) return; if (hl() === last) break; last = hl(); key("down"); await sleep(15); }
  if (!re.test(hl())) throw new Abort(`select ${re}: not found (highlight: "${hl().slice(0, 30)}"); aborting before any action`);
}
try {
  await until(() => hl());
  ok("W1 a row is highlighted", !!hl().trim());
  const first = hl(); key("down"); await sleep(30); ok("W1 down moves it", hl() !== first); key("up"); await sleep(30); ok("W1 up moves it back", hl() === first);
  key("end"); await sleep(30); ok("W1 End: the last row (Other agents)", /\(pid \d+\)/.test(hl()), hl().slice(0, 30));
  await select(/^Bolt\b/); ok("W1 it reaches world B's row", true);
  ok("W1 the help line lists the keys", /Enter focus its window \| x or Del close it \(asks first\)/.test(screen.replace(/\x1b\[[0-9;]*m/g, "")));

  // W2: the confirm warns; n cancels; y closes (through the window)
  await select(/^Bolt\b/); key("x"); await sleep(40);
  ok("W2 the confirm names Bolt and warns: 2 running briefs, owns 1 project, 1 live helper, working", /^Close Bolt \(world B\)\? ! 2 running briefs; owns 1 project; 1 live helper; it's working right now \[y\/N\]/.test(footer()), footer());
  key("n"); await sleep(40);
  ok("W2 n cancels: nothing closed", /cancelled: nothing closed/.test(footer()) && calls.close.length === 0 && calls.kill.length === 0 && listedIds.has("hp-bolt"));
  await select(/^Thoughts-A\b/); key("x"); await sleep(40);
  ok("W2 a Thoughts row can't be closed from top, and it says why", /can't close: Thoughts-A is a world's Thoughts agent/.test(footer()) && calls.close.length === 0, footer());
  await select(/^Atlas\b/); key("x"); await sleep(40); key("y");
  await until(() => /closed Atlas/.test(footer()), 4000);
  ok("W2 y closes Atlas through its window (the confirmed agent only); the daemon no longer lists it", calls.close.length === 1 && calls.close[0][0] === "hp-atlas" && calls.close[0][1] === "0xaaa" && !listedIds.has("hp-atlas") && calls.kill.length === 0, JSON.stringify(calls.close));

  // W4: the target is frozen at x: a re-sort and a new row during the confirm don't change what is closed
  await select(/^Bolt\b/); key("x"); await sleep(40);
  // no key (any key but y cancels): the DATA changes under the confirm: a new agent sorts above Bolt in world B and a new pi
  // row appears, so the highlighted line now shows another row; refreshes run meanwhile
  listedIds.add("hp-aardvark"); put(531, { comm: "pi", ppid: 500, argv: ["pi"], env: { HYPRPI_AGENT_ID: "hp-aardvark" } });
  put(650, { comm: "pi", ppid: 500, argv: ["pi"], cwd: WORK }); await sleep(700);
  ok("W4 (during the confirm the footer still asks about Bolt)", /^Close Bolt/.test(footer()), footer());
  key("y"); await until(() => /closed Bolt/.test(footer()), 4000);
  ok("W4 y closed Bolt, the row confirmed, not the one that moved under the highlight", calls.close.length === 2 && calls.close[1][0] === "hp-bolt" && has(650) && has(531) && listedIds.has("hp-aardvark"));

  // W4: a registered pid reused by another process before the confirm (TopCheck564): never signalled or closed
  drop(521); put(521, { comm: "vim", ppid: 1, argv: ["vim"], start: 77777 }); await sleep(700);
  await select(/^Stale\b/); key("x"); await sleep(40); key("y");
  await until(() => /not closed/.test(footer()), 4000);
  ok("W4 Stale's registered pid now belongs to vim: nothing signalled or closed, it says so", /not closed: .*not this agent's pi/.test(footer()) && calls.kill.length === 0 && calls.close.length === 2 && has(521), footer());

  // W4 (TopCheck564b): a headless agent nested under another agent: its close must NOT close the parent's window
  await select(/^Kid\b/); key("x"); await sleep(40); key("y");
  await until(() => /closed Kid|not closed/.test(footer()), 4000);
  const kidKill = calls.kill.find(([p]) => p === 561);
  ok("W4 closing nested Kid never closes Parent's window: SIGTERM to Kid's own pi only", !calls.close.some(([id]) => id === "hp-kid") && kidKill?.[1] === "SIGTERM" && has(560) && listedIds.has("hp-parent"), JSON.stringify({ close: calls.close, kill: calls.kill }));
  calls.kill.length = 0; listedIds.delete("hp-kid");
  // W3: an Other agents tree ends by its exact pids; the decoy pi lives
  await select(/^pi \(pid 600\)/); key("x"); await sleep(40);
  ok("W3 the confirm names the pi, its folder, and its 2 pids", /^Close Pi pi \(pid 600\) in .*pi-proj\? ! 2 processes get SIGTERM \(exact pids\)/.test(footer()), footer());
  key("y"); await until(() => /ended pi \(pid 600\)/.test(footer()), 4000);
  ok("W3 SIGTERM went to exactly 600 and 601", JSON.stringify(calls.kill.map(([p, s]) => `${p}:${s}`).sort()) === JSON.stringify(["600:SIGTERM", "601:SIGTERM"]) && !has(600) && !has(601), JSON.stringify(calls.kill));
  ok("W3 the decoy pi (610, 611) and the others untouched", has(610) && has(611) && has(620) && has(630) && has(650));

  // W4: a pid reused during the confirm (after x, before y): not signalled
  await select(/^claude \(pid 620\)/); key("x"); await sleep(40);
  drop(620); put(620, { comm: "claude", ppid: 500, argv: ["/usr/bin/claude"], start: 99999 }); // same pid, another process now
  const k0 = calls.kill.length; key("y"); await until(() => /nothing signalled/.test(footer()), 4000);
  ok("W4 a pid reused during the confirm isn't signalled", calls.kill.length === k0 && /nothing signalled: .*reused/.test(footer()), footer());

  // W5: Codex (wrapper + native) closed from the TUI; a stubborn one gets SIGKILL only after a second confirm
  stubborn.add(630); stubborn.add(631);
  await select(/^codex \(pid 630\)/); key("x"); await sleep(40); key("y");
  await until(() => /SIGKILL them \(exact pids\)\? \[y\/N\]/.test(footer()), 6000);
  ok("W5 Codex: SIGTERM to 630 and 631, then a second confirm for SIGKILL", calls.kill.filter(([p]) => p === 630 || p === 631).every(([, s]) => s === "SIGTERM") && /2 process\(es\) of Codex codex \(pid 630\)/.test(footer()), footer());
  key("y"); await sleep(60);
  ok("W5 y: SIGKILL to exactly those two", JSON.stringify(calls.kill.filter(([, s]) => s === "SIGKILL").map(([p]) => p).sort()) === "[630,631]" && !has(630) && !has(631) && has(610));

  // W3: Enter focuses (fakes only): an agent through the daemon; another CLI through its terminal's window
  await select(/^Aardvark\b/); key("return"); await until(() => calls.agentFocus.length, 2000);
  ok("W3 Enter on an agent asks the daemon to focus it", calls.agentFocus[0] === "hp-aardvark");
  await select(/^pi \(pid 610\)/); key("return"); await until(() => calls.focus.length, 2000);
  ok("W3 Enter on another CLI focuses its terminal's window", calls.focus[0] === "0xaaa");
  // a stale row: its pid reused between the last refresh and Enter → no focus
  drop(610); put(610, { comm: "pi", ppid: 500, argv: ["pi"], start: 88888 }); const f0 = calls.focus.length;
  key("return"); await sleep(200);
  ok("W4 Enter on a row whose pid was reused since the refresh: no focus, it says so", calls.focus.length === f0 && /can't focus: it has ended/.test(footer()), footer());
  key("q"); await run;
  ok("the terminal's raw mode is restored", inp.isRaw === false);
} catch (e) {
  key("q"); await run.catch(() => {});
  ok(e instanceof Abort ? "ABORTED before acting (select failed)" : "no exception", false, e.message);
}
process.kill = realKill;
fs.rmSync(P, { recursive: true, force: true }); fs.rmSync(WORK, { recursive: true, force: true });
console.log(fails ? `${fails} FAILED` : "all passed");
process.exit(fails ? 1 : 0);
