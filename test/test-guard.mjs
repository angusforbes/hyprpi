#!/usr/bin/env node
// J566 proof (Angus, 27a: "tests that close agents or send signals may only run with a fake process table and a fake kill function,
// and a hook blocks real kill or `hyprpi send … /quit` calls from test runs"): the test guard (test/guard/) refuses what it must and
// lets through what it should. It signals nothing but its own throwaway processes (a `sleep` it starts in its own process group).
//   A  the guard's rules on a SYNTHETIC /proc (core.killRefusal / commandRefusal): foreign pids, reused pids, mixed groups, kill -1,
//      shell -c, xargs kill, pkill, env/nohup/timeout wrappers, hyprpi send … /quit, live-daemon commands, hyprctl closes
//   B  for real, inside the sandbox: a dummy process this test started OUTSIDE the sandbox (so not part of the sandboxed run) can't
//      be signalled by process.kill, process._kill, kill, sh -c, xargs kill, pkill or a bash script the parser can't see; the dummy
//      survives; `hyprpi send X /quit` is refused (by the preload, and by bin/hyprpi itself when run from a script); the run's own
//      process group can still be ended; a test that swallows the refusal still fails
//   C  (direct runs only) outside a test run nothing is blocked: top-actions' endTree calls its kill seam, and `hyprpi send X /quit`
//      to a fake agent on a temp daemon is delivered (the path Claw uses to close an agent for Angus)
//   node test/test-guard.mjs      (exit 0 = pass; also runs under node test/run.mjs)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { killRefusal, commandRefusal } from "./guard/core.mjs";
import { makeFakeProc, spyKill } from "./guard/fake-proc.mjs";
import { spawnSandboxed, PRELOAD, inSandbox } from "./guard/sandbox.mjs";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const HYPRPI = path.join(ROOT, "bin/hyprpi");
let fails = 0; const ok = (n, c, x = "") => { if (!c) fails++; console.log(`${c ? "ok  " : "FAIL"} ${n}${x ? ": " + x : ""}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; } };

// ---------------- B, the inner half: runs inside the sandbox, reports one JSON line per check ----------------
if (process.argv[2] === "--inner") {
  const D = Number(process.env.J566_DUMMY), out = [];
  const rec = (name, f) => { try { out.push({ name, ...f() }); } catch (e) { out.push({ name, threw: e.code || "error", msg: String(e.message).slice(0, 300) }); } };
  rec("sandboxed", () => ({ value: inSandbox(), guard: !!globalThis.__hyprpiTestGuard?.sandboxed }));
  rec("dummy-visible", () => ({ value: fs.existsSync(`/proc/${D}`) }));
  rec("process.kill", () => ({ ret: process.kill(D, "SIGTERM") }));
  rec("process._kill", () => ({ ret: process._kill(D, 15) }));
  rec("kill(-1)", () => ({ ret: process.kill(-1, "SIGTERM") }));
  const run = (name, file, args, opts = {}) => rec(name, () => { const r = spawnSync(file, args, { encoding: "utf8", timeout: 20000, ...opts }); return { status: r.status, signal: r.signal, error: r.error?.code, stdout: (r.stdout || "").trim().slice(0, 300), stderr: (r.stderr || "").trim().slice(0, 300) }; });
  run("kill PID", "kill", [String(D)]);
  run("sh -c kill", "sh", ["-c", `kill -9 ${D}`]);
  run("xargs kill", "sh", ["-c", `echo ${D} | xargs kill`]);
  run("pkill", "pkill", ["-f", "sleep"]);
  rec("execSync kill", () => ({ ret: String((require_exec())(`kill ${D}`)) }));
  // a script file: the parser can't see inside; the pid namespace is what stops it
  const sh = path.join(process.env.J566_T, "k.sh"); fs.writeFileSync(sh, `kill ${D}; echo "kill rc=$?"\n`);
  run("bash script kill", "bash", [sh]);
  // hyprpi send … /quit: from node (preload) and from a script (bin/hyprpi's own check)
  run("hyprpi send /quit (node spawn)", process.execPath, [process.env.J566_HYPRPI, "send", "Claw", "/quit"]);
  const sh2 = path.join(process.env.J566_T, "q.sh"); fs.writeFileSync(sh2, `"${process.execPath}" "${process.env.J566_HYPRPI}" send Claw /quit; echo "rc=$?"\n`);
  run("hyprpi send /quit (bash script)", "bash", [sh2]);
  const sh3 = path.join(process.env.J566_T, "s.sh"); fs.writeFileSync(sh3, `"${process.execPath}" "${process.env.J566_HYPRPI}" send Claw hello; echo "rc=$?"\n`);
  run("hyprpi send (live daemon, bash script)", "bash", [sh3]);
  // the run's own process group: a detached child (its own group) with a grandchild, ended by group
  rec("own group", () => {
    const g = spawn("sh", ["-c", "sleep 300 & sleep 300; wait"], { detached: true, stdio: "ignore" });
    const t = Date.now(); while (Date.now() - t < 300) { /* let it start */ }
    const members = fs.readdirSync("/proc").filter((n) => /^\d+$/.test(n)).filter((n) => { try { const s = fs.readFileSync(`/proc/${n}/stat`, "latin1"); return Number(s.slice(s.lastIndexOf(")") + 2).split(" ")[2]) === g.pid; } catch { return false; } });
    process.kill(-g.pid, "SIGTERM");
    const t2 = Date.now(); let left = members; while (Date.now() - t2 < 2000 && left.length) left = members.filter((m) => { try { const s = fs.readFileSync(`/proc/${m}/stat`, "latin1"); return !/^\S+ \(.*\) Z/.test(s); } catch { return false; } });
    return { members: members.length, left: left.length };
  });
  // sockets: a server the outer half listens on (a stand-in for a live service) and the live runtime folder
  const net = await import("node:net");
  const tryConnect = (p) => new Promise((r) => { const c = net.createConnection(p); c.on("connect", () => { c.destroy(); r("connected"); }); c.on("error", (e) => r(e.code)); setTimeout(() => r("timeout"), 2000); });
  out.push({ name: "live socket stand-in", value: await tryConnect(process.env.J566_LIVESOCK) });
  out.push({ name: "runtime dir", value: (() => { try { return fs.readdirSync(`/run/user/${process.getuid()}`); } catch (e) { return e.code; } })() });
  out.push({ name: "env", value: ["HYPRPI_SOCKET", "DBUS_SESSION_BUS_ADDRESS", "WAYLAND_DISPLAY", "HYPRPI_AGENT_ID"].filter((k) => process.env[k] && !(k === "HYPRPI_SOCKET" && process.env[k].startsWith(process.env.J566_T))) });
  console.log("J566-INNER " + JSON.stringify(out));
  process.exit(0); // the guard turns this into a failure exit when anything was refused (checked by the outer half)
}
function require_exec() { return globalThis.__j566exec; }

// ---------------- A: the rules, on a synthetic /proc ----------------
const T = fs.mkdtempSync(path.join(os.tmpdir(), "j566-"));
{
  const P = makeFakeProc(path.join(T, "proc"), [
    { pid: 100, ppid: 1, pgrp: 100, start: 5, comm: "node" },            // the run's root
    { pid: 101, ppid: 100, pgrp: 101, comm: "sh" },                      // its detached child (own group)
    { pid: 102, ppid: 101, pgrp: 101, comm: "sleep" },                   // grandchild in that group
    { pid: 200, ppid: 1, pgrp: 200, comm: "pi" },                        // someone else's agent (Angus's)
    { pid: 103, ppid: 100, pgrp: 300, comm: "sleep" }, { pid: 201, ppid: 1, pgrp: 300, comm: "pi" }, // a group mixing ours and his
    { pid: 50, ppid: 1, pgrp: 50, comm: "bash" }, { pid: 104, ppid: 50, pgrp: 50, comm: "node" }, // a test run from an agent's shell: its group holds the shell
  ]);
  const ctx = { procRoot: P, root: { pid: 100, start: 5 }, self: 100, spawned: new Map(), liveDirs: ["/run/user/1000", "/tmp/hyprpi-1000"] };
  ok("A1 a child of the run may be signalled", killRefusal(101, "SIGTERM", ctx) === "");
  ok("A1 a grandchild may be signalled", killRefusal(102, "SIGTERM", ctx) === "");
  ok("A1 the run's own group (-101) may be signalled", killRefusal(-101, "SIGTERM", ctx) === "");
  const r200 = killRefusal(200, "SIGTERM", ctx);
  ok("A2 a pid the run didn't start is refused, with a clear reason", /refused kill\(200, SIGTERM\): pid 200 was not started by this test run/.test(r200), r200.slice(0, 80));
  ok("A2 a reused root pid (other start time) owns nothing", killRefusal(101, "SIGTERM", { ...ctx, root: { pid: 100, start: 6 } }) !== "");
  ok("A2 a group mixing the run's and someone else's processes is refused", /group 300 holds processes this test didn't start \(201\)/.test(killRefusal(-300, "SIGTERM", ctx)));
  ok("A2 kill(-1) is always refused", /-1 means every process/.test(killRefusal(-1, "SIGKILL", ctx)));
  ok("A2 kill(0) from a process whose group holds the agent's shell is refused", /group \(50\)/.test(killRefusal(0, "SIGTERM", { ...ctx, self: 104, root: { pid: 104, start: 1104 } })));
  ok("A2 a pid that isn't visible is refused", /isn't visible/.test(killRefusal(999, "SIGTERM", ctx)));
  ok("A3 signal 0 (an existence probe) is allowed", killRefusal(200, 0, ctx) === "");
  const env = {}, tenv = { HYPRPI_SOCKET: path.join(T, "d.sock") };
  const C = (argv, e = env) => commandRefusal(argv, e, ctx);
  const refused = [
    [["kill", "200"], "kill PID"], [["kill", "-9", "200"], "kill -9 PID"], [["kill", "-s", "KILL", "--", "-300"], "kill -s KILL -- -GROUP"],
    [{ shell: "sleep 1; kill 200" }, "shell string"], [["sh", "-c", "kill -TERM 200"], "sh -c"], [["bash", "-lc", "if true; then kill $PID; fi"], "bash -lc with a variable"],
    [["sh", "-c", "pgrep pi | xargs kill"], "xargs kill"], [["xargs", "-r", "kill", "-9"], "xargs kill (argv)"], [["pkill", "-f", "pi"], "pkill"], [["killall", "node"], "killall"],
    [["env", "A=1", "nohup", "timeout", "5", "kill", "200"], "env/nohup/timeout wrapper"], [["setsid", "-f", "sh", "-c", "kill 200"], "setsid sh -c"],
    [["hyprpi", "send", "Claw", "/quit"], "hyprpi send /quit"], [["node", "/x/bin/hyprpi", "send", "Claw", "/quit"], "node bin/hyprpi send /quit"],
    [{ shell: 'hyprpi send "pi·c2tc" "/quit"' }, "quoted /quit in a shell string"], [["hyprpi", "send", "Claw", "hello"], "hyprpi send to the LIVE daemon"],
    [["hyprpi", "stop"], "hyprpi stop (live)"], [["hyprctl", "dispatch", "closewindow", "address:0x1"], "hyprctl closewindow"], [["hyprctl", "dispatch", "hl.dsp.window.close({})"], "hyprctl lua close"],
    [["kitty", "@", "close-window", "--match", "id:1"], "kitty close-window"], [["systemctl", "--user", "stop", "hyprpi"], "systemctl stop"],
    [["python3", "-c", "import os; os.kill(200, 9)"], "python -c os.kill"], [["kill", "%1"], "a job spec"],
  ];
  for (const [argv, name] of refused) { const w = C(argv); ok(`A4 refused: ${name}`, /^test guard: refused/.test(w), w ? "" : JSON.stringify(argv)); }
  const allowed = [
    [["kill", "101"], "kill a child"], [["kill", "--", "-101"], "kill own group"], [["sh", "-c", "kill -0 200"], "kill -0 probe"], [["ls", "-la"], "ls"],
    [["node", "-e", "process.kill(200)"], "node -e (guarded inside by its own preload)"], [["hyprpi", "send", "Fake", "hello"], "hyprpi send to the test's own daemon"],
    [["pgrep", "-x", "/tmp/x"], "pgrep (read-only)"], [["hyprctl", "-j", "clients"], "hyprctl query"],
  ];
  for (const [argv, name] of allowed) ok(`A5 allowed: ${name}`, C(argv, tenv) === "", C(argv, tenv));
  ok("A5 /quit to the test's OWN daemon only with HYPRPI_TEST_ALLOW_QUIT_TEST_DAEMON=1", C(["hyprpi", "send", "Fake", "/quit"], tenv) !== "" && C(["hyprpi", "send", "Fake", "/quit"], { ...tenv, HYPRPI_TEST_ALLOW_QUIT_TEST_DAEMON: "1" }) === "");
}

// ---------------- B: for real, in the sandbox, against a dummy outside it ----------------
const dummy = spawn("sleep", ["600"], { detached: true, stdio: "ignore" }); // our own throwaway, its own group
const cleanup = () => { try { process.kill(-dummy.pid, "SIGKILL"); } catch { /* gone */ } };
process.on("exit", cleanup);
try {
  await sleep(200);
  ok("B0 the dummy (outside the sandboxed run) is running", alive(dummy.pid), `pid ${dummy.pid}`);
  const log = path.join(T, "refusals.jsonl");
  // execSync is reached through a tiny shim so the inner half can call it without a static import cycle
  const innerBoot = path.join(T, "inner-boot.mjs");
  fs.writeFileSync(innerBoot, `import cp from "node:child_process"; globalThis.__j566exec = (c) => cp.execSync(c, { encoding: "utf8", stdio: "pipe" });\n`);
  const net = await import("node:net"), liveSock = path.join(T, "live.sock"), server = net.createServer((c) => c.end()).listen(liveSock);
  await new Promise((r) => server.on("listening", r));
  const child = spawnSandboxed([process.execPath, `--import=${PRELOAD}`, `--import=${innerBoot}`, new URL(import.meta.url).pathname, "--inner"], { log, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, J566_DUMMY: String(dummy.pid), J566_T: T, J566_HYPRPI: HYPRPI, J566_LIVESOCK: liveSock, HYPRPI_SOCKET: "/run/user/1000/hyprpi/inherited.sock", DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus" } });
  let so = "", se = ""; child.stdout.on("data", (d) => { so += d; }); child.stderr.on("data", (d) => { se += d; });
  const code = await new Promise((r) => child.on("exit", (c) => r(c)));
  const line = so.split("\n").find((l) => l.startsWith("J566-INNER "));
  const res = line ? Object.fromEntries(JSON.parse(line.slice(11)).map((x) => [x.name, x])) : {};
  if (!line) console.log("INNER STDOUT:", so.slice(-1500), "\nINNER STDERR (tail):", se.split("\n").filter((l) => !l.startsWith("⛔") && l.trim()).slice(-25).join("\n"));
  ok("B1 the inner run is inside the sandbox (pid namespace, bwrap as pid 1)", res.sandboxed?.value === true && res.sandboxed?.guard === true);
  ok("B1 the dummy isn't even visible in the sandbox's /proc", res["dummy-visible"]?.value === false);
  ok("B2 process.kill(dummy) is refused with a clear error", res["process.kill"]?.threw === "ETESTGUARD" && /not started by this test run|never a process of this test run/.test(res["process.kill"].msg), res["process.kill"]?.msg?.slice(0, 90));
  ok("B2 process._kill(dummy) (another route to the same syscall) is refused", res["process._kill"]?.threw === "ETESTGUARD");
  ok("B2 process.kill(-1) is refused", res["kill(-1)"]?.threw === "ETESTGUARD");
  for (const n of ["kill PID", "sh -c kill", "xargs kill", "pkill", "execSync kill"]) ok(`B3 ${n} is refused before it runs`, res[n]?.threw === "ETESTGUARD", JSON.stringify(res[n]).slice(0, 120));
  // (run directly the dummy's pid doesn't exist in the sandbox: "No such process". Run under test/run.mjs the sandbox is nested and the
  // dummy's small pid can be reused INSIDE the inner sandbox, so the kill lands on the sandbox's own process: still never the dummy.)
  const bk = res["bash script kill"] || {};
  ok("B4 a bash script the guard can't read still can't reach the dummy (the kernel resolves its pid inside the sandbox only)", (/kill rc=1/.test(bk.stdout || "") && /No such process/.test(bk.stderr || "")) || (!!globalThis.__hyprpiTestGuard && bk.signal === "SIGTERM"), JSON.stringify(bk).slice(0, 160));
  ok("B5 `hyprpi send Claw /quit` spawned from node is refused by the preload", res["hyprpi send /quit (node spawn)"]?.threw === "ETESTGUARD" && /hyprpi send … \/quit/.test(res["hyprpi send /quit (node spawn)"].msg));
  ok("B5 `hyprpi send Claw /quit` from a bash script is refused by bin/hyprpi itself (exit 86)", /rc=86/.test(res["hyprpi send /quit (bash script)"]?.stdout || "") && /test guard: refused `hyprpi send Claw \/quit`/.test(res["hyprpi send /quit (bash script)"]?.stderr || ""), JSON.stringify(res["hyprpi send /quit (bash script)"]).slice(0, 200));
  ok("B5 any hyprpi command aimed at the LIVE daemon from a test run is refused (exit 86)", /rc=86/.test(res["hyprpi send (live daemon, bash script)"]?.stdout || "") && /would reach the LIVE daemon/.test(res["hyprpi send (live daemon, bash script)"]?.stderr || ""));
  ok("B6 the run can still end its own process group (child + grandchild gone)", res["own group"]?.members >= 2 && res["own group"]?.left === 0, JSON.stringify(res["own group"]));
  let refusals = []; try { refusals = fs.readFileSync(log, "utf8").trim().split("\n").filter(Boolean); } catch { /* none */ }
  ok("B7 every refusal is logged for the runner, and the run that swallowed them still exits non-zero (86)", refusals.length >= 8 && code === 86, `${refusals.length} logged, exit ${code}`);
  await sleep(200);
  // the bluntest thing a test can do, with no node and no preload in the way: bash `kill -9 -1` (every process it may signal)
  const blunt = spawnSandboxed(["bash", "-c", `sleep 30 & S=$!; kill -9 -1; sleep 0.3; kill -0 $S 2>/dev/null && echo own-sleep-alive || echo own-sleep-killed`], { log: path.join(T, "blunt.jsonl"), stdio: ["ignore", "pipe", "pipe"] });
  let bo = ""; blunt.stdout.on("data", (x) => { bo += x; });
  await new Promise((r) => blunt.on("exit", r));
  await sleep(200);
  ok("B4 a bare bash `kill -9 -1` in the sandbox only reaches the sandbox (its own sleep died; the dummy didn't)", /own-sleep-killed/.test(bo) && alive(dummy.pid), bo.trim());
  ok("B10 a listening unix socket outside the test (a live-service stand-in) can't be reached from the sandbox", res["live socket stand-in"]?.value !== "connected", res["live socket stand-in"]?.value);
  ok("B10 the live runtime folder (/run/user/UID: daemon, Hyprland, session bus) is empty in the sandbox", Array.isArray(res["runtime dir"]?.value) && res["runtime dir"].value.length === 0, JSON.stringify(res["runtime dir"]?.value));
  ok("B10 inherited session pointers (HYPRPI_SOCKET, DBUS_SESSION_BUS_ADDRESS, WAYLAND_DISPLAY, HYPRPI_AGENT_ID) are dropped", Array.isArray(res.env?.value) && !res.env.value.length, JSON.stringify(res.env?.value));
  server.close();
  ok("B8 the dummy survived all of it", alive(dummy.pid));

  // ---------------- C: outside a test run nothing is blocked (direct runs only) ----------------
  if (globalThis.__hyprpiTestGuard) console.log("skip C (W3): this run is itself under the test guard; run `node test/test-guard.mjs` directly for the non-test checks");
  else {
    const { endTree } = await import(path.join(ROOT, "lib/top-actions.mjs"));
    const P = makeFakeProc(path.join(T, "proc-c"), [{ pid: 4242, ppid: 1, start: 77, comm: "pi" }, { pid: 4243, ppid: 4242, start: 78, comm: "node" }]);
    const kill = spyKill();
    endTree({ pids: [4242, 4243], pidStarts: { 4242: 77, 4243: 78 } }, "SIGTERM", { procRoot: P, kill });
    ok("C1 normal code (no test run) reaches its kill seam: endTree signals the confirmed pids (spy, nothing real)", kill.calls.length >= 1 && kill.calls.every((c) => [4242, 4243].includes(c.pid)), JSON.stringify(kill.calls));
    ok("C1 the guard's own rules say nothing outside a test run: commandRefusal is only consulted by the preload, which isn't loaded here", !globalThis.__hyprpiTestGuard && !String(process.env.NODE_OPTIONS || "").includes(PRELOAD));
    // a temp daemon + a fake agent; Claw's way of closing an agent for Angus: `hyprpi send AGENT /quit`
    const sock = path.join(T, "d.sock"), cfg = path.join(T, "cfg"); fs.mkdirSync(path.join(cfg, "hyprpi"), { recursive: true });
    fs.writeFileSync(path.join(cfg, "hyprpi", "config.json"), JSON.stringify({ roomToThoughts: false, pi: "/bin/cat", worldSize: 10 }));
    fs.writeFileSync(path.join(cfg, "hyprpi", "hyprpi.jsonc"), JSON.stringify({ auth: { enabled: false }, upkeep: { refresh: { enabled: false }, autoReload: { enabled: false } } }));
    const denv = { ...process.env, HYPRPI_SOCKET: sock, HYPRPI_STATE: T, XDG_CONFIG_HOME: cfg, XDG_STATE_HOME: path.join(T, "xdg"), XDG_RUNTIME_DIR: path.join(T, "run"), HYPRPI_TEST: "1", HYPRPI_UPKEEP_MS: "3600000", HYPRLAND_INSTANCE_SIGNATURE: "j566-bogus" };
    for (const k of ["HYPRPI_AGENT_ID", "HYPRPI_WORKSPACE", "WAYLAND_DISPLAY"]) delete denv[k];
    fs.mkdirSync(denv.XDG_RUNTIME_DIR, { recursive: true });
    const d = spawn(process.execPath, [HYPRPI, "daemon"], { env: denv, detached: true, stdio: ["ignore", fs.openSync(path.join(T, "d.log"), "w"), fs.openSync(path.join(T, "d.err"), "w")] });
    const prompts = path.join(T, "prompts.txt");
    const agentJs = `import(${JSON.stringify(path.join(ROOT, "lib/client.mjs"))}).then(async ({ connect }) => { const c = await connect({ path: ${JSON.stringify(sock)}, onEvent: (ev, data) => { if (ev === "prompt") require("fs").appendFileSync(${JSON.stringify(prompts)}, data.text + "\\n"); } }); await c.call("agent.hello", { agent_id: "hp-j566fake", pid: process.pid, name: "Fakey", cwd: ${JSON.stringify(T)} }); setInterval(() => {}, 1e6); })`;
    let ag = null;
    try {
      for (let i = 0; i < 50 && !fs.existsSync(sock); i++) await sleep(200);
      ag = spawn(process.execPath, ["--input-type=commonjs", "-e", agentJs], { env: denv, detached: true, stdio: "ignore" });
      let r = null;
      for (let i = 0; i < 30; i++) { r = spawnSync(process.execPath, [HYPRPI, "send", "Fakey", "/quit"], { env: denv, encoding: "utf8" }); if (r.status === 0) break; await sleep(200); }
      for (let i = 0; i < 20 && !fs.existsSync(prompts); i++) await sleep(100);
      ok("C2 outside a test run, `hyprpi send Fakey /quit` is delivered (the fake agent got /quit; nothing real was signalled)", r?.status === 0 && /Fakey/.test(r.stdout) && fs.existsSync(prompts) && fs.readFileSync(prompts, "utf8").includes("/quit"), (r?.stdout || r?.stderr || "").trim().slice(0, 100));
      const g = spawnSync(process.execPath, [HYPRPI, "send", "Fakey", "/quit"], { env: { ...denv, HYPRPI_TEST_GUARD: "1" }, encoding: "utf8" });
      ok("C3 the same command inside a guarded test run is refused even against the test's own daemon (exit 86)", g.status === 86 && /test guard: refused/.test(g.stderr), g.stderr.trim().slice(0, 100));
    } finally {
      for (const k of [ag, d]) { if (k?.pid) { try { process.kill(-k.pid, "SIGKILL"); } catch { /* gone */ } } }
    }
  }
} finally { cleanup(); }
await sleep(100);
ok("B9 the dummy is gone after cleanup (only our own group was signalled)", !alive(dummy.pid));
try { fs.rmSync(T, { recursive: true, force: true }); } catch { /* best effort */ }
console.log(fails ? `\n${fails} FAILED` : "\nall passed");
process.exit(fails ? 1 : 0);
