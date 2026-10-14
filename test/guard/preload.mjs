// J566: the test-run guard, loaded into every node process of a guarded test run (`node --import <this>`; test/run.mjs and
// test/guard/sandbox.mjs set it, and it re-adds itself to every child's NODE_OPTIONS). It is the second line of defence: the first
// is the sandbox (a bubblewrap pid namespace with the live runtime folders masked: real processes are invisible and unreachable).
// Here, in-process and with a clear message:
//   - process.kill / process._kill to a pid (or group) this run didn't start is refused (core.killRefusal);
//   - child_process (spawn, exec, execFile, fork and their Sync forms) refuses kill/pkill/killall/xargs kill, `hyprpi send … /quit`,
//     hyprpi commands aimed at the LIVE daemon, hyprctl/kitty window closes and systemctl stop/kill (core.commandRefusal), and
//     re-adds the guard to the child's env when a test passes its own env;
//   - outside the sandbox, a unix-socket connect into the live runtime folders (/run/user/UID: the live daemon, Hyprland, the
//     session bus) is refused.
// A refusal throws (code ETESTGUARD), is printed to stderr, appended to $HYPRPI_TEST_GUARD_LOG, and makes the process exit non-zero
// even if the test swallowed the error (try { process.kill(…) } catch {} must not hide it).
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import dns from "node:dns";
import cp from "node:child_process";
import wt from "node:worker_threads";
import { syncBuiltinESMExports } from "node:module";
import { fileURLToPath } from "node:url";
import { killRefusal, commandRefusal, procStat, parseRoot, underLive, liveDirs, groupMembers } from "./core.mjs";

const SELF = fileURLToPath(import.meta.url);
const env = process.env;
if (!globalThis.__hyprpiTestGuard) {
  const real = { kill: process.kill, _kill: process._kill };
  // the run's root: the first guarded process (it exports itself to its children)
  let root = parseRoot(env.HYPRPI_TEST_ROOT);
  if (!root) { const st = procStat(process.pid); root = { pid: process.pid, start: st?.start ?? 0 }; env.HYPRPI_TEST_ROOT = `${root.pid}:${root.start}`; }
  let sandboxed = false;
  try {
    sandboxed = env.HYPRPI_TEST_SANDBOX === "1" && fs.readFileSync("/proc/1/comm", "utf8").trim() === "bwrap"
      && !!env.HYPRPI_TEST_OUTER_PIDNS && fs.readlinkSync("/proc/self/ns/pid") !== env.HYPRPI_TEST_OUTER_PIDNS;
  } catch { sandboxed = false; }
  const spawned = new Map(); // pid -> start ticks, children this process started
  const dirs = liveDirs();
  const nsLastPid = () => { try { return Number(fs.readFileSync("/proc/sys/kernel/ns_last_pid", "utf8")); } catch { return null; } };
  const ctx = { procRoot: "/proc", root, sandboxed, spawned, nsLastPid, self: process.pid, liveDirs: dirs, allowTestSocketQuit: env.HYPRPI_TEST_ALLOW_QUIT_TEST_DAEMON === "1", netShared: env.HYPRPI_TEST_NET_SHARED === "1" };
  const refusals = [];
  Object.assign(env, { HYPRPI_TEST_GUARD: "1", HYPRPI_NO_ENSURE: "1" });
  const imp = `--import=${SELF}`;
  if (!String(env.NODE_OPTIONS || "").includes(SELF)) env.NODE_OPTIONS = `${env.NODE_OPTIONS ? env.NODE_OPTIONS + " " : ""}${imp}`;
  const CARRY = ["HYPRPI_TEST_NET_SHARED", "HYPRPI_TEST_HOST_ABSTRACT", "HYPRPI_TEST_HOST_PORTS", "HYPRPI_TEST_LIVE_SOCKETS", "HYPRPI_TEST_GUARD", "HYPRPI_TEST_ROOT", "HYPRPI_TEST_SANDBOX", "HYPRPI_TEST_OUTER_PIDNS", "HYPRPI_TEST_GUARD_LOG", "HYPRPI_NO_ENSURE"];

  const refuse = (why) => {
    refusals.push(why);
    try { process.stderr.write(`\n⛔ ${why}\n`); } catch { /* closed */ }
    if (env.HYPRPI_TEST_GUARD_LOG) { try { fs.appendFileSync(env.HYPRPI_TEST_GUARD_LOG, JSON.stringify({ t: Date.now(), pid: process.pid, why }) + "\n"); } catch { /* best effort */ } }
    const e = new Error(why); e.code = "ETESTGUARD"; throw e;
  };
  process.on("exit", (code) => { if (refusals.length && !code) process.exitCode = 86; });

  // ---- signals ----
  // a pid / group this process spawned that has since ended: ESRCH like the real call, without signalling (a reused pid is not ours)
  const goneOwn = (pid) => { const p = Math.abs(Number(pid)); return Number(pid) !== -1 && p > 0 && spawned.has(p) && (Number(pid) > 0 ? !procStat(p) : !groupMembers(p).length); };
  const esrch = (pid) => { const e = new Error(`kill ESRCH (${pid}: a process of this test run that has already ended)`); e.code = "ESRCH"; e.errno = -3; e.syscall = "kill"; throw e; };
  process.kill = function kill(pid, sig) { if (goneOwn(pid)) esrch(pid); const why = killRefusal(pid, sig, ctx); if (why === "ESRCH") esrch(pid); if (why) refuse(why); return real.kill.call(process, pid, sig); };
  if (typeof real._kill === "function") process._kill = function _kill(pid, sig) { if (goneOwn(pid)) return -3; const why = killRefusal(pid, sig, ctx); if (why === "ESRCH") return -3; if (why) refuse(why); return real._kill.call(process, pid, sig); };

  // ---- child processes ----
  const withGuardEnv = (opts) => {
    if (!opts || typeof opts !== "object" || !opts.env) return opts;
    const e = { ...opts.env };
    for (const k of CARRY) if (env[k] != null && e[k] == null) e[k] = env[k];
    if (!String(e.NODE_OPTIONS || "").includes(SELF)) e.NODE_OPTIONS = `${e.NODE_OPTIONS ? e.NODE_OPTIONS + " " : ""}${imp}`;
    return { ...opts, env: e };
  };
  const wrap = (name, shellForm) => {
    const orig = cp[name];
    if (typeof orig !== "function") return;
    cp[name] = function guarded(...a) {
      let optsIdx, cmd;
      if (shellForm) { cmd = { shell: String(a[0]) }; optsIdx = 1; }
      else {
        const hasArgs = Array.isArray(a[1]); optsIdx = hasArgs ? 2 : 1;
        const args = hasArgs ? a[1] : [], o = a[optsIdx];
        if (name === "fork") cmd = [process.execPath, String(a[0]), ...args];
        else cmd = o && typeof o === "object" && o.shell ? { shell: [a[0], ...args].join(" ") } : [String(a[0]), ...args.map(String)];
      }
      const o = a[optsIdx] && typeof a[optsIdx] === "object" ? a[optsIdx] : null;
      const why = commandRefusal(cmd, o?.env || env, ctx);
      if (why) refuse(why);
      if (o) a[optsIdx] = withGuardEnv(o);
      const r = orig.apply(this, a);
      if (r && typeof r === "object" && r.pid) { const st = procStat(r.pid); if (st) spawned.set(r.pid, st.start); }
      return r;
    };
  };
  for (const n of ["spawn", "spawnSync", "execFile", "execFileSync", "fork"]) wrap(n, false);
  for (const n of ["exec", "execSync"]) wrap(n, true);

  // ---- sockets into the live runtime folders. Outside the sandbox: refused. Inside, those folders are an empty tmpfs, so a socket
  // there that the test didn't create (it doesn't exist) is the test reaching for the LIVE daemon / Hyprland / bus: refused too, so
  // the run fails with this message instead of a vague "daemon not reachable". ----
  {
    let liveSet = null;
    const hostLive = (p) => { // was this a live socket on the host when the sandbox was built? (no list: assume yes)
      if (!liveSet) { try { liveSet = new Set(fs.readFileSync(env.HYPRPI_TEST_LIVE_SOCKETS, "utf8").split("\n").filter(Boolean)); } catch { liveSet = false; } }
      return liveSet === false || liveSet.has(p) || liveSet.has(String(p).replace(/\/+$/, ""));
    };
    let portSet = null;
    const hostPort = (n) => { if (!portSet) { try { portSet = new Set(fs.readFileSync(env.HYPRPI_TEST_HOST_PORTS, "utf8").split("\n").filter(Boolean).map(Number)); } catch { portSet = false; } } return portSet === false || portSet.has(n); };
    // the sockets bound inside this run's own network namespace (pathname ones, resolved), read when a connect needs it
    const boundHere = (p) => {
      let t = ""; try { t = fs.readFileSync("/proc/net/unix", "utf8"); } catch { return true; }
      const want = new Set([p]); try { want.add(fs.realpathSync(p)); } catch { /* missing: connect will say so */ }
      if (![...want].some((w) => fs.existsSync(w))) return true; // nothing there: the kernel answers ENOENT itself
      return t.split("\n").slice(1).some((l) => { const x = l.trim().split(/\s+/)[7]; if (!x || x.startsWith("@")) return false; if (!x.startsWith("/")) return x.split("/").pop() === String(p).split("/").pop(); if (want.has(x)) return true; try { return want.has(fs.realpathSync(x)); } catch { return false; } });
    };
    let absSet = null;
    const hostAbstract = (p) => { if (!absSet) { try { absSet = new Set(fs.readFileSync(env.HYPRPI_TEST_HOST_ABSTRACT, "utf8").split("\n").filter(Boolean)); } catch { absSet = false; } } return absSet === false || absSet.has("@" + String(p).slice(1)); };
    const localAddrs = () => { const out = new Set(); try { for (const l of Object.values(os.networkInterfaces())) for (const x of l || []) out.add(x.address); } catch { /* none */ } return out; };
    const isLocalAddr = (a) => { const x = String(a || "").replace(/^::ffff:/i, ""); return /^127\./.test(x) || x === "0.0.0.0" || x === "::" || x === "::1" || localAddrs().has(x); };
    const origConnect = net.Socket.prototype.connect;
    net.Socket.prototype.connect = function connect(...a) {
      const first = Array.isArray(a[0]) ? a[0][0] : a[0];
      const p = typeof first === "string" && !/^\d+$/.test(first) ? first : first && typeof first === "object" ? first.path : null;
      const port = typeof first === "number" || /^\d+$/.test(String(first ?? "")) ? Number(first) : first && typeof first === "object" ? Number(first.port) : NaN;
      if (!p && Number.isInteger(port) && env.HYPRPI_TEST_HOST_PORTS && hostPort(port)) {
        // a port that was listening on the HOST when the run started: refused when the address (after name resolution) is this
        // machine's: loopback in any spelling (127.1, localhost.), the any-address, or one of its interfaces' addresses
        const opts = first && typeof first === "object" ? first : null;
        const host = String((opts ? opts.host : typeof a[1] === "string" ? a[1] : "") || "localhost").replace(/^\[|\]$/g, "");
        const why = (addr) => `test guard: refused a connection to ${host}:${port}${addr && addr !== host ? ` (${addr})` : ""}: a service listening on the HOST (this run shares its network with --net / test-guard: net). Start the test's own server on a port of its own.`;
        if (net.isIP(host)) { if (isLocalAddr(host)) refuse(why(host)); }
        else if (opts) {
          const lk = typeof opts.lookup === "function" ? opts.lookup : dns.lookup;
          opts.lookup = (h, o, cb) => lk(h, o, (err, addr, fam) => {
            if (err) return cb(err, addr, fam);
            const list = Array.isArray(addr) ? addr.map((x) => x.address) : [addr];
            if (list.some(isLocalAddr)) { try { refuse(why(list.join(", "))); } catch (e) { return cb(e); } }
            return cb(err, addr, fam);
          });
        } else refuse(why("")); // (socket.connect(port, name) without options: the name can't be checked first)
      }
      if (p && sandboxed && !String(p).startsWith("\0") && env.HYPRPI_TEST_NET_SHARED !== "1" && !boundHere(p)) refuse(`test guard: refused a connection to ${p}: no process of this test run is listening there (in the sandbox's own network namespace /proc/net/unix lists only the run's sockets), so it belongs to something OUTSIDE the run (a socket made after the sandbox started, or a link to one). Give the test its own sockets in a temp dir.`);
      if (p && String(p).startsWith("\0") && env.HYPRPI_TEST_NET_SHARED === "1" && hostAbstract(p)) refuse(`test guard: refused a connection to the abstract socket @${String(p).slice(1)}: it belongs to the HOST (this run shares its network with --net / test-guard: net).`);
      if (p && underLive(p, dirs) && (!sandboxed || (!fs.existsSync(p) && hostLive(p)))) refuse(`test guard: refused a connection to ${p}: that is the live desktop's runtime folder (the live hyprpi daemon, Hyprland, the session bus)${sandboxed ? ", masked in the test's sandbox" : ""}. Give the test (and every process it starts) its own HYPRPI_SOCKET / XDG_RUNTIME_DIR in a temp dir.`);
      return origConnect.apply(this, a);
    };
  }
  // ---- worker threads: `--import` preloads don't run in workers, so every Worker gets this guard through --require ----
  {
    const WORKER_GUARD = fileURLToPath(new URL("./preload-worker.cjs", import.meta.url)), Orig = wt.Worker;
    if (typeof Orig === "function") {
      wt.Worker = class GuardedWorker extends Orig {
        constructor(file, opts = {}) {
          const base = Array.isArray(opts?.execArgv) ? opts.execArgv : process.execArgv.filter((a) => !a.startsWith("--import"));
          const o = { ...(opts || {}), execArgv: [...base.filter((a) => a !== `--require=${WORKER_GUARD}`), `--require=${WORKER_GUARD}`] };
          if (o.env && typeof o.env === "object") { const e = { ...o.env }; for (const k of CARRY) if (env[k] != null && e[k] == null) e[k] = env[k]; o.env = e; }
          super(file, o);
        }
      };
    }
  }
  syncBuiltinESMExports();
  globalThis.__hyprpiTestGuard = { ctx, refusals, sandboxed };
}
