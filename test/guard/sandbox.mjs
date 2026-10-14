// J566: run a test where it CAN'T reach Angus's live processes, windows or daemon. The kernel enforces it, not the test's good
// manners: bubblewrap puts the test in its own pid namespace (/proc shows only the test's processes; kill(2) can't name anything
// else; pkill finds nothing else) with its own network namespace (loopback only, so no live localhost services and no abstract
// sockets), masks the live runtime folders (/run/user/UID: the live hyprpi daemon's socket, Hyprland's, the session bus, kitty's;
// the docker and sandbox sockets) with empty tmpfs, makes the live hyprpi state and config read-only, and kills every process the
// test left behind when it ends (the namespace dies with its pid 1). The preload (./preload.mjs) runs inside it as well, for clear
// refusals. The test still has the real filesystem (repo, /tmp) for its own temp dirs.
//
//   A test that can end processes starts with:
//     import { requireSandbox } from "./guard/sandbox.mjs"; await requireSandbox(import.meta.url);
//   Run directly (node test/x.mjs) it re-runs itself inside the sandbox and exits with its code; inside, it returns at once.
//   No bwrap (or user namespaces off): it refuses to run (exit 87), it never falls back to the live machine.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const PRELOAD = fileURLToPath(new URL("./preload.mjs", import.meta.url));
const HOME = os.homedir(), UID = process.getuid?.() ?? 1000;

// Are we inside the guard's sandbox right now? (pid 1 is bwrap and our pid namespace isn't the one the runner started in)
export function inSandbox(env = process.env) {
  try {
    return env.HYPRPI_TEST_SANDBOX === "1" && fs.readFileSync("/proc/1/comm", "utf8").trim() === "bwrap"
      && !!env.HYPRPI_TEST_OUTER_PIDNS && fs.readlinkSync("/proc/self/ns/pid") !== env.HYPRPI_TEST_OUTER_PIDNS;
  } catch { return false; }
}

// Can this machine build the sandbox? -> "" or why not
export function sandboxUnavailable() {
  const r = spawnSync("bwrap", ["--dev-bind", "/", "/", "--unshare-pid", "--unshare-net", "--proc", "/proc", "--die-with-parent", "true"], { encoding: "utf8", timeout: 10000 });
  if (r.error) return `bwrap not runnable: ${r.error.code || r.error.message} (install bubblewrap)`;
  if (r.status !== 0) return `bwrap failed (${r.status}): ${(r.stderr || "").trim().slice(0, 200)} (are unprivileged user namespaces enabled?)`;
  return "";
}

// bwrap argv (without the command). opts: { net: share the host network (default false), log: guard log file }
export function sandboxArgs({ net = false } = {}) {
  const a = ["--dev-bind", "/", "/", "--unshare-pid", "--proc", "/proc", "--die-with-parent", "--new-session"];
  if (!net) a.push("--unshare-net");
  const exists = (p) => { try { fs.lstatSync(p); return true; } catch { return false; } };
  const writable = (p) => { try { fs.accessSync(p, fs.constants.W_OK); return true; } catch { return false; } };
  const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };
  // live runtime folders and control sockets: hidden behind empty tmpfs / /dev/null
  for (const d of [`/run/user/${UID}`, `/tmp/hyprpi-${UID}`, path.join(HOME, ".sbx/run"), path.join(HOME, ".local/state/sandboxes")]) if (isDir(d)) a.push("--tmpfs", d);
  // every other listening pathname unix socket we could connect to (docker, the system bus, sandboxd, ssh control masters, X11,
  // another test's daemon…), from /proc/net/unix: hidden behind /dev/null. (Abstract sockets are cut off by the network namespace.)
  const masked = a.filter((x, i) => a[i - 1] === "--tmpfs");
  const lookups = /^\/run\/systemd\/(?:resolve|userdb|journal)\//; // name/user lookups and logging: read-only services, kept
  for (const s of liveSocketPaths()) if (!lookups.test(s) && !masked.some((d) => s === d || s.startsWith(d + "/")) && exists(s) && !isDir(s) && writable(s)) a.push("--ro-bind", "/dev/null", s); // (one we can't open needs no mask)
  // host-root files show as "nobody" in the user namespace; test/guard/shim/stat (in place of /usr/bin/stat, which it calls under
  // a hidden name in the masked runtime folder) shows them as root again, so "owned by you or root" checks behave as on the host
  const realStat = "/usr/bin/stat", shim = fileURLToPath(new URL("./shim/stat", import.meta.url));
  if (isDir(`/run/user/${UID}`) && exists(realStat) && exists(shim)) a.push("--ro-bind", realStat, `/run/user/${UID}/.testguard-stat`, "--ro-bind", shim, realStat);
  // live hyprpi state and config: readable (some code reads defaults) but not writable
  for (const d of [path.join(HOME, ".local/state/hyprpi"), path.join(HOME, ".config/hyprpi")]) if (isDir(d)) a.push("--ro-bind", d, d);
  return a;
}

// Pathname unix sockets that are bound right now (listening servers and the like), from /proc/net/unix
export function liveSocketPaths() {
  let t = ""; try { t = fs.readFileSync("/proc/net/unix", "utf8"); } catch { return []; }
  const out = new Set();
  for (const line of t.split("\n").slice(1)) { const f = line.trim().split(/\s+/); const p = f[7]; if (p && p.startsWith("/")) out.add(p); }
  return [...out];
}

// The environment a guarded test gets (on top of the caller's)
export function guardEnv(base = process.env, { log, net = false } = {}) {
  const e = { ...base, HYPRPI_TEST: base.HYPRPI_TEST || "1", HYPRPI_TEST_GUARD: "1", HYPRPI_TEST_SANDBOX: "1", HYPRPI_NO_ENSURE: "1" };
  try { e.HYPRPI_TEST_OUTER_PIDNS = fs.readlinkSync("/proc/self/ns/pid"); } catch { /* inSandbox then fails closed */ }
  delete e.HYPRPI_TEST_ROOT; // the test's own node process becomes the root
  delete e.HYPRPI_AGENT_ID; delete e.HYPRPI_WORKSPACE; // a test is never an agent
  // no inherited way back to the live session: a test sets its own socket / state / display if it needs one
  for (const k of ["HYPRPI_SOCKET", "HYPRPI_STATE", "HYPRPI_REMOTE_LINK", "HYPRPI_REMOTE_PANEL", "DBUS_SESSION_BUS_ADDRESS", "WAYLAND_DISPLAY", "DISPLAY", "KITTY_LISTEN_ON", "KITTY_PID", "KITTY_WINDOW_ID", "SSH_AUTH_SOCK", "GPG_AGENT_INFO", "PULSE_SERVER", "TMUX", "ZELLIJ"]) delete e[k];
  if (log) e.HYPRPI_TEST_GUARD_LOG = log;
  // the host's live sockets in its runtime folder (masked in the sandbox): reaching for one of these is the test going for the live
  // daemon / Hyprland / bus, which the preload refuses loudly; other paths there (a bogus test instance's) just don't exist
  try {
    const live = liveSocketPaths().filter((p) => p.startsWith(`/run/user/${UID}/`) || p.startsWith(`/tmp/hyprpi-${UID}/`));
    const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "testguard-live-")), "sockets.txt"); fs.writeFileSync(f, live.join("\n") + "\n");
    e.HYPRPI_TEST_LIVE_SOCKETS = f;
  } catch { /* then the preload refuses every missing path there */ }
  // --net shares the host's network, so the host's own loopback services (the phone server, the MCP gateway…) would be reachable:
  // the ports listening on the host now go to the preload, which refuses a connection to them on a local address
  if (net) {
    try {
      const ports = new Set();
      for (const f of ["/proc/net/tcp", "/proc/net/tcp6"]) { let t = ""; try { t = fs.readFileSync(f, "utf8"); } catch { continue; } for (const l of t.split("\n").slice(1)) { const c = l.trim().split(/\s+/); if (c[3] === "0A" && c[1]) ports.add(parseInt(c[1].split(":").pop(), 16)); } }
      const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "testguard-ports-")), "ports.txt"); fs.writeFileSync(f, [...ports].join("\n") + "\n");
      e.HYPRPI_TEST_HOST_PORTS = f;
    } catch { /* then no port list: the preload refuses every loopback connection */ e.HYPRPI_TEST_HOST_PORTS = "-"; }
  }
  if (!String(e.NODE_OPTIONS || "").includes(PRELOAD)) e.NODE_OPTIONS = `${e.NODE_OPTIONS ? e.NODE_OPTIONS + " " : ""}--import=${PRELOAD}`;
  return e;
}

// The full command for running argv in the sandbox: -> [cmd, args]
// (a small sh stays the test's parent, so the test isn't the namespace's init's direct child: code that walks its parents, e.g.
// docker/world/doorman-mcp.mjs's "ancestors above pid 1", sees a normal process tree)
export function sandboxCommand(argv, opts = {}) { return ["bwrap", [...sandboxArgs(opts), "--", "/bin/sh", "-c", '"$@"; exit $?', "testguard", ...argv]]; }

// Start argv in the sandbox (async); -> ChildProcess. opts: { net, log, env, stdio, cwd }
export function spawnSandboxed(argv, opts = {}) {
  const [cmd, args] = sandboxCommand(argv, opts);
  return spawn(cmd, args, { cwd: opts.cwd, stdio: opts.stdio || "inherit", env: guardEnv(opts.env || process.env, opts) });
}

// First lines of a test that can end processes. Inside the sandbox: returns. Outside: re-runs this test file in it and exits.
export async function requireSandbox(testUrl, { net = false } = {}) {
  if (inSandbox()) return;
  const file = testUrl.startsWith("file:") ? fileURLToPath(testUrl) : testUrl;
  const why = sandboxUnavailable();
  if (why) { process.stderr.write(`test guard: ${path.basename(file)} ends processes, so it only runs inside the guard's sandbox, and the sandbox can't start here: ${why}\n`); process.exit(87); }
  const log = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "testguard-")), "refusals.jsonl");
  const child = spawnSandboxed([process.execPath, `--import=${PRELOAD}`, file, ...process.argv.slice(2)], { net, log, stdio: "inherit" });
  const code = await new Promise((r) => child.on("exit", (c, sig) => r(c ?? (sig ? 128 : 1))));
  let refused = []; try { refused = fs.readFileSync(log, "utf8").trim().split("\n").filter(Boolean); } catch { /* none */ }
  if (refused.length) process.stderr.write(`test guard: ${refused.length} refusal(s) in ${path.basename(file)} (log ${log}); the test FAILS\n`);
  process.exit(refused.length && !code ? 86 : code);
}
