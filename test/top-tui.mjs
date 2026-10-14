#!/usr/bin/env node
// J564 proof (Angus: "a version of hyprpi top to also be a TUI so i can navigate it and kill highlighted agents" … "also does hyprpi
// top show other agents like pi, cc, or codex agents? … yes"): the real `hyprpi top` loop (runTop) in a fake TTY against an
// ISOLATED daemon (temp socket/state/config, HYPRPI_TEST, no Hyprland), with only throwaway processes this test starts:
//   - a throwaway hyprpi agent (a node child that says agent.hello with its own pid), two fake "pi" CLIs (a script named pi) and a
//     fake Claude Code (a script named claude), each with a sleeping child, plus a decoy "pi" that must survive;
//   - the highlight moves through the rows; Other agents shows the CLIs with folder, uptime, CPU, RSS (also in --once/--json);
//   - x then n cancels (the agent stays listed); x then y closes the throwaway agent (gone from the daemon's list);
//   - x then y on a fake pi ends exactly its tree (its pids, SIGTERM) while the decoy pi lives;
//   - unit checks: the confirm's warnings (briefs, projects, helpers, Thoughts, sandbox, remote) and the pid-reuse guard.
//   node test/top-tui.mjs   (exit 0 = pass)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { PassThrough } from "node:stream";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
let fails = 0; const ok = (n, c, x = "") => { if (!c) fails++; console.log(`${c ? "ok  " : "FAIL"} ${n}${x ? ": " + x : ""}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const T = fs.mkdtempSync(path.join(os.tmpdir(), "j564-")), sock = path.join(T, "d.sock"), cfg = path.join(T, "cfg");
fs.mkdirSync(path.join(cfg, "hyprpi"), { recursive: true });
fs.writeFileSync(path.join(cfg, "hyprpi", "config.json"), JSON.stringify({ roomToThoughts: false, pi: "/bin/cat", worldSize: 10 }));
fs.writeFileSync(path.join(cfg, "hyprpi", "hyprpi.jsonc"), JSON.stringify({ auth: { enabled: false }, upkeep: { refresh: { enabled: false }, autoReload: { enabled: false } } }));
Object.assign(process.env, { HYPRPI_SOCKET: sock, HYPRPI_STATE: T, XDG_CONFIG_HOME: cfg, HYPRPI_TEST: "1", HYPRPI_NO_ENSURE: "1", HYPRPI_UPKEEP_MS: "3600000", HYPRLAND_INSTANCE_SIGNATURE: "j564-bogus", XDG_STATE_HOME: path.join(T, "xdg") });
delete process.env.HYPRPI_AGENT_ID; delete process.env.HYPRPI_WORKSPACE;
const kids = [];
const d = spawn(process.execPath, [path.join(ROOT, "bin/hyprpi"), "daemon"], { stdio: ["ignore", fs.openSync(path.join(T, "d.log"), "w"), fs.openSync(path.join(T, "d.err"), "w")] }); kids.push(d);
const cleanup = () => { for (const k of kids) { try { process.kill(-k.pid, "SIGKILL"); } catch { /* not a group */ } try { k.kill("SIGKILL"); } catch { /* gone */ } } };
process.on("exit", cleanup);
// fake CLIs: a bash script whose file is named "pi" / "claude" (comm and argv[0] say so), each with a sleeping child
const mk = (name) => { const dir = fs.mkdtempSync(path.join(T, "bin-")), f = path.join(dir, name); fs.writeFileSync(f, "#!/bin/bash\nsleep 600 &\nwait\n"); fs.chmodSync(f, 0o755); return f; };
const startCli = (name, cwd) => { const c = spawn(mk(name), [], { cwd, stdio: "ignore", detached: true }); kids.push(c); return c; };
try {
  for (let i = 0; i < 50 && !fs.existsSync(sock); i++) await sleep(200);
  // the throwaway hyprpi agent: a child process that registers itself (its pid is its root) and stays until signalled
  const agentJs = `import(${JSON.stringify(path.join(ROOT, "lib/client.mjs"))}).then(async ({ connect }) => { const c = await connect({ path: ${JSON.stringify(sock)}, onEvent: () => {} }); await c.call("agent.hello", { agent_id: "hp-throwaway", pid: process.pid, name: "Throwaway", want_workspace: 2, cwd: ${JSON.stringify(T)} }); setInterval(() => {}, 1e6); })`;
  const ag = spawn(process.execPath, ["--input-type=module", "-e", agentJs], { stdio: "ignore", detached: true }); kids.push(ag);
  fs.mkdirSync(path.join(T, "work-pi"), { recursive: true }); fs.mkdirSync(path.join(T, "work-claude"), { recursive: true });
  const pi1 = startCli("pi", path.join(T, "work-pi")), decoy = startCli("pi", T), cc = startCli("claude", path.join(T, "work-claude"));
  const { request } = await import(path.join(ROOT, "lib/client.mjs"));
  const listed = async (id) => ((await request("list", {}).catch(() => ({ agents: [] }))).agents || []).some((a) => a.id === id);
  for (let i = 0; i < 30 && !(await listed("hp-throwaway")); i++) await sleep(200);
  ok("the throwaway agent is listed by the daemon", await listed("hp-throwaway"));

  // --once --json: Other agents with tool, folder, uptime, CPU, RSS
  const { runTop } = await import(path.join(ROOT, "lib/top.mjs"));
  { let out = ""; const o = new PassThrough(); o.on("data", (x) => { out += x; });
    await runTop(["--once", "--json"], { stdout: o, stdin: new PassThrough() });
    const snap = JSON.parse(out.trim().split("\n").at(-1)), mine = (pid) => snap.agents.find((a) => a.world === "Unattributed" && a.rootPid === pid);
    const p = mine(pi1.pid), c = mine(cc.pid);
    ok("W5 --json: the fake pi is an Other agent with tool, folder, uptime and its tree", p && p.tool === "Pi" && p.cwd === path.join(T, "work-pi") && p.processCount >= 2 && p.uptimeSeconds != null && "cpuPercent" in p && p.rssBytes > 0, JSON.stringify(p && { tool: p.tool, cwd: p.cwd, n: p.processCount }));
    ok("W5 --json: the fake claude is listed as Claude Code with its folder", c && c.tool === "Claude Code" && c.cwd === path.join(T, "work-claude"), JSON.stringify(c && { tool: c.tool, cwd: c.cwd }));
    let txt = ""; const o2 = new PassThrough(); o2.on("data", (x) => { txt += x; });
    await runTop(["--once"], { stdout: o2, stdin: new PassThrough() });
    ok("W5 --once: an 'Other agents' section shows Claude Code and pi rows with their folders", /\[Other agents \(not hyprpi/.test(txt) && txt.includes(`claude (pid ${cc.pid})`) && txt.includes(path.join(T, "work-claude").slice(0, 20)));
  }

  // the interactive TUI in a fake terminal
  const out = new PassThrough(), inp = new PassThrough(); let screen = "";
  Object.assign(out, { isTTY: true, columns: 200, rows: 60 }); Object.assign(inp, { isTTY: true, isRaw: false, setRawMode(v) { this.isRaw = v; return this; } });
  out.on("data", (x) => { screen = String(x).startsWith("\x1b[H") ? String(x) : screen + x; });
  const run = runTop(["--interval", "0.5"], { stdout: out, stdin: inp });
  const key = (name, extra = {}) => inp.emit("keypress", name.length === 1 ? name : "", { name, ...extra });
  const hl = () => (/\x1b\[7m([^\x1b]*)\x1b\[27m/.exec(screen) || [])[1] || "";
  const footer = () => screen.slice(screen.lastIndexOf("\n") + 1).replace(/\x1b\[[0-9;]*m/g, "");
  const until = async (f, ms = 15000) => { const t = Date.now(); while (Date.now() - t < ms) { const v = f(); if (v) return v; await sleep(100); } return f(); };
  await until(() => hl());
  ok("W1 a row is highlighted", !!hl().trim(), hl().slice(0, 40));
  const first = hl(); key("down"); await sleep(50);
  ok("W1 down moves the highlight to another row", hl() !== first && !!hl().trim());
  key("up"); await sleep(50); ok("W1 up moves it back", hl() === first);
  const seek = async (re, ms = 20000) => { key("home"); await sleep(50); const t = Date.now(); let last = ""; while (Date.now() - t < ms) { if (re.test(hl())) return true; const was = hl(); key("down"); await sleep(30); if (hl() === was) { if (last === was) { key("home"); await sleep(400); } last = was; } } return re.test(hl()); };
  ok("W1 the highlight reaches the throwaway agent (world A) and the Other agents rows", (await seek(/^Throwaway/)) && (await seek(new RegExp(`^claude \\(pid ${cc.pid}`))));
  ok("W1 the help line lists the keys", /Enter focus its window \| x or Del close it \(asks first\)/.test(screen.replace(/\x1b\[[0-9;]*m/g, "")));

  // W2: cancel leaves it, y closes it
  await seek(/^Throwaway/); key("x"); await sleep(80);
  ok("W2 x asks first, naming the agent", /^Close Throwaway \(world A\)\? .*\[y\/N\]/.test(footer()), footer());
  key("n"); await sleep(300);
  ok("W2 n cancels: still listed", /cancelled: nothing closed/.test(footer()) && await listed("hp-throwaway"));
  await seek(/^Throwaway/); key("x"); await sleep(80); key("y");
  const gone = await until(async () => false, 0) || await (async () => { for (let i = 0; i < 60; i++) { if (!(await listed("hp-throwaway"))) return true; await sleep(300); } return false; })();
  ok("W2 y closes it: gone from the daemon's list", gone, footer());
  await until(() => /closed Throwaway/.test(footer()), 25000);
  ok("W2 … and the footer says how (no window here: SIGTERM to its pi)", /closed Throwaway .*SIGTERM to its pi/.test(footer()), footer());

  // W3: an Other agents tree ends by its exact pids; the decoy with the same name lives
  const treeOf = (pid) => { try { return fs.readFileSync(`/proc/${pid}/task/${pid}/children`, "utf8").trim().split(/\s+/).filter(Boolean).map(Number); } catch { return []; } };
  const piKids = treeOf(pi1.pid), decoyKids = treeOf(decoy.pid);
  ok(`W3 (setup) fake pi ${pi1.pid} has its sleep child, so does the decoy`, piKids.length >= 1 && decoyKids.length >= 1);
  ok("W3 the highlight finds that pi's row", await seek(new RegExp(`^pi \\(pid ${pi1.pid}\\)`)));
  key("x"); await sleep(80);
  ok("W3 the confirm names it, its folder and that its pids get SIGTERM", new RegExp(`^Close Pi pi \\(pid ${pi1.pid}\\) in .*work-pi\\? ! \\d+ process(es)? get SIGTERM \\(exact pids\\)`).test(footer()), footer());
  key("y");
  const alive = (pid) => { try { process.kill(pid, 0); return fs.readFileSync(`/proc/${pid}/stat`, "latin1").split(") ")[1][0] !== "Z"; } catch { return false; } };
  const ended = await until(() => !alive(pi1.pid) && piKids.every((p) => !alive(p)), 8000);
  ok("W3 its tree ended (root and child)", ended);
  ok("W3 the decoy pi and its child, same name, untouched", alive(decoy.pid) && decoyKids.every(alive));
  ok("W3 the throwaway claude untouched", alive(cc.pid));
  // W5: the fake Claude Code can be closed from the TUI too
  ok("W5 the highlight finds Claude Code", await seek(new RegExp(`^claude \\(pid ${cc.pid}`)));
  key("x"); await sleep(80); key("y");
  ok("W5 closing it ends it", await until(() => !alive(cc.pid), 8000));
  ok("W5 the decoy still lives", alive(decoy.pid));
  key("q"); await run;
} catch (e) { ok("no exception", false, e.stack); }

// unit checks (no processes)
{
  const { closePlan, endTree, targetOf } = await import(path.join(ROOT, "lib/top-actions.mjs"));
  const base = { id: "hp-x", kind: "agent", name: "X", world: "B", status: "idle", registeredHelpers: [], priorityDetails: { components: { jobs: { value: 2 }, projects: { value: 1 } } } };
  const p = closePlan({ ...base, registeredHelpers: ["hp-k"], status: "working" });
  ok("W2 confirm warns for running briefs, owned projects, helpers, working", p.ok && p.warnings.join(" | ") === "2 running briefs | owns 1 project | 1 live helper | it's working right now", p.warnings.join(" | "));
  ok("W2 a Thoughts row isn't closable from top (says why)", !closePlan({ ...base, kind: "thoughts", name: "Thoughts-A" }).ok && /Thoughts agent/.test(closePlan({ ...base, kind: "thoughts", name: "Thoughts-A" }).why));
  ok("a sandbox or remote row isn't closed from top (says where to)", !closePlan({ ...base, kind: "sandbox" }).ok && /omnistation\/world H stop/.test(closePlan({ ...base, remote: true, world: "H" }).why));
  // PID reuse: a confirmed (pid, start) whose start no longer matches is never signalled
  const sent = [];
  const r = endTree({ pidStarts: { [process.pid]: 1, 999999999: 5, 1: 1 } }, "SIGTERM", { kill: (pid, sig) => sent.push([pid, sig]) });
  ok("W4 pid reuse / gone / pid 1 / itself: never signalled", sent.length === 0 && r.signalled.length === 0, JSON.stringify(r));
  const me = Number(fs.readFileSync(`/proc/${process.pid}/stat`, "latin1").slice(fs.readFileSync(`/proc/${process.pid}/stat`, "latin1").lastIndexOf(")") + 2).split(" ")[19]);
  const child = spawn("sleep", ["30"], { stdio: "ignore" }); await sleep(100);
  const st = Number(fs.readFileSync(`/proc/${child.pid}/stat`, "latin1").slice(fs.readFileSync(`/proc/${child.pid}/stat`, "latin1").lastIndexOf(")") + 2).split(" ")[19]);
  const sent2 = []; endTree({ pidStarts: { [child.pid]: st + 1 } }, "SIGTERM", { kill: (pid, sig) => sent2.push(pid) });
  ok("W4 a pid with a different start time (reused) is skipped", sent2.length === 0);
  const sent3 = []; endTree({ pidStarts: { [child.pid]: st } }, "SIGTERM", { kill: (pid, sig) => sent3.push(pid) });
  ok("… the same pid with its confirmed start time is signalled", sent3.length === 1 && sent3[0] === child.pid);
  child.kill(); void me; void targetOf;
}
cleanup();
console.log(fails ? `${fails} FAILED (state ${T})` : "all passed");
if (!fails) fs.rmSync(T, { recursive: true, force: true });
process.exit(fails ? 1 : 0);
