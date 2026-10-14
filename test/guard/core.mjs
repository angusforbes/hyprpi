// J566 (Angus, 27a: "tests that close agents or send signals may only run with a fake process table and a fake kill function, and a
// hook blocks real kill or `hyprpi send … /quit` calls from test runs"): the guard's decisions, as pure functions over a /proc root,
// so they are tested against a synthetic /proc (test/test-guard.mjs) and used for real by the preload (test/guard/preload.mjs).
// Nothing in this file sends a signal or opens a socket.
//
// Ownership: a pid belongs to the test run when its parent chain (in procRoot) reaches the run's root process (pid + start time,
// so a reused pid never counts), or, inside the guard's sandbox, the namespace's pid 1 (bwrap: everything visible there was
// started by the test). Signals to anything else are refused.
import fs from "node:fs";
import path from "node:path";

// /proc/<pid>/stat -> { pid, ppid, pgrp, start } or null (gone / unreadable)
export function procStat(pid, procRoot = "/proc") {
  try {
    const t = fs.readFileSync(`${procRoot}/${pid}/stat`, "latin1"), rest = t.slice(t.lastIndexOf(")") + 2).split(" ");
    return { pid: Number(pid), ppid: Number(rest[1]), pgrp: Number(rest[2]), start: Number(rest[19]) };
  } catch { return null; }
}

// "PID:START" (the run's root, as the preload exports it in HYPRPI_TEST_ROOT) -> { pid, start } or null
export function parseRoot(s) {
  const m = /^(\d+):(\d+)$/.exec(String(s || ""));
  return m ? { pid: Number(m[1]), start: Number(m[2]) } : null;
}

// Does pid descend from (or equal) the run's root? ctx = { procRoot, root: {pid,start}, sandboxed, spawned: Map(pid -> start) }
export function owned(pid, ctx) {
  const { procRoot = "/proc", root, sandboxed = false, spawned } = ctx || {};
  pid = Number(pid);
  if (!Number.isInteger(pid) || pid <= 0) return false;
  const st = procStat(pid, procRoot);
  if (!st) return false; // gone or not visible: nothing to own (and nothing to signal)
  if (spawned?.has(pid) && spawned.get(pid) === st.start) return true; // a child this process spawned, same start time
  const seen = new Set();
  for (let cur = st; cur && !seen.has(cur.pid); cur = procStat(cur.ppid, procRoot)) {
    seen.add(cur.pid);
    if (root && cur.pid === root.pid && cur.start === root.start) return true;
    if (sandboxed && cur.pid === 1) return true; // the sandbox's own init: every process in the namespace is the test's
    if (cur.ppid <= 0) break;
  }
  return false;
}

// Members of process group pgid (in procRoot)
export function groupMembers(pgid, procRoot = "/proc") {
  let names = [];
  try { names = fs.readdirSync(procRoot).filter((n) => /^\d+$/.test(n)); } catch { return []; }
  return names.map((n) => procStat(n, procRoot)).filter((s) => s && s.pgrp === pgid).map((s) => s.pid);
}

const SIGNAME = (sig) => (sig === undefined ? "SIGTERM" : typeof sig === "number" ? `signal ${sig}` : String(sig));
const HOW = "A test may only signal processes it started itself (its children, or a process group it created). Use a synthetic /proc and a spied kill function for anything else (skill: isolated-app-tests).";

// May this test run send `sig` to `pid` (process.kill semantics: >0 one pid, 0 own group, -1 everything, <-1 a group)?
// -> "" (allowed), "ESRCH" (inside the sandbox: a pid of the run's that has ended; answer like the kernel), or the refusal message.
export function killRefusal(pid, sig, ctx) {
  const { procRoot = "/proc", self = process.pid } = ctx || {};
  const p = Number(pid);
  if (sig === 0 || sig === "0") return ""; // an existence probe sends nothing
  const what = `kill(${pid}, ${SIGNAME(sig)})`;
  if (!Number.isInteger(p)) return `test guard: refused ${what}: not a pid. ${HOW}`;
  if (p === -1) return `test guard: refused ${what}: -1 means every process you can signal. ${HOW}`;
  if (p === 0) {
    const me = procStat(self, procRoot);
    if (me && me.pgrp === me.pid) return ""; // this process leads its own group: the group is the test's
    if (me && groupMembers(me.pgrp, procRoot).every((m) => owned(m, ctx))) return "";
    return `test guard: refused ${what}: this process's group (${me?.pgrp ?? "?"}) has processes the test didn't start (e.g. the shell that ran it). ${HOW}`;
  }
  // Inside the sandbox a pid that isn't visible is either one of the test's own that has ended (its number is at most the namespace's
  // last allocated pid: the real call would just say ESRCH, so the caller gets ESRCH and no refusal) or a number from OUTSIDE the
  // run (above that: the test read a live pid from a file, a screen or its env): refused, loudly. The kernel couldn't reach either.
  if (ctx?.sandboxed && p !== -1) {
    const visible = p > 0 ? !!procStat(p, procRoot) : groupMembers(-p, procRoot).length > 0;
    if (!visible) {
      const last = typeof ctx.nsLastPid === "function" ? ctx.nsLastPid() : ctx.nsLastPid;
      if (last != null && Math.abs(p) <= last) return "ESRCH";
      return `test guard: refused ${what}: ${p > 0 ? "pid" : "process group"} ${Math.abs(p)} was never a process of this test run (it comes from outside the test's sandbox: a live pid read from a file, screen or env). ${HOW}`;
    }
  }
  if (p > 0) {
    if (p === self || owned(p, ctx)) return "";
    return `test guard: refused ${what}: pid ${p} was not started by this test run${procStat(p, procRoot) ? "" : " (or isn't visible to it)"}. ${HOW}`;
  }
  const members = groupMembers(-p, procRoot);
  if (members.length && members.every((m) => owned(m, ctx))) return "";
  const foreign = members.filter((m) => !owned(m, ctx));
  return `test guard: refused ${what}: process group ${-p} ${members.length ? `holds processes this test didn't start (${foreign.slice(0, 5).join(", ")})` : "is empty or not visible"}. ${HOW}`;
}

// ---- commands a test run starts (child_process) ----
const SHELLS = new Set(["sh", "bash", "dash", "zsh", "ksh", "fish", "busybox"]);
const PATTERN_KILLERS = new Set(["pkill", "killall", "skill", "slay", "pkexec"]);
const SEP = /^(?:;|&&|\|\||\||&|\(|\)|\{|\}|`|\$\(|\n|then|do|else|fi|done)$/;

// A rough shell tokenizer (quotes kept together, separators split out); good enough to find kill/pkill/hyprpi words.
export function shellWords(script) {
  const out = []; let cur = "", q = "";
  const push = () => { if (cur) out.push(cur); cur = ""; };
  for (let i = 0; i < script.length; i++) {
    const c = script[i];
    if (q) { if (c === q) q = ""; else cur += c; continue; }
    if (c === "'" || c === '"') { q = c; continue; }
    if (c === "\\" && i + 1 < script.length) { cur += script[++i]; continue; }
    if (/\s/.test(c)) { push(); if (c === "\n") out.push("\n"); continue; }
    if (c === "$" && script[i + 1] === "(") { push(); out.push("$("); i++; continue; }
    if (";|&()`{}".includes(c)) { push(); const two = script.slice(i, i + 2); if (two === "&&" || two === "||") { out.push(two); i++; } else out.push(c); continue; }
    cur += c;
  }
  push();
  return out;
}

// Split a word list into simple commands (at separators); a shell's -c script is expanded into its own commands.
function commandsOf(words) {
  const cmds = []; let cur = [];
  for (const w of words) { if (SEP.test(w)) { if (cur.length) cmds.push(cur); cur = []; } else cur.push(w); }
  if (cur.length) cmds.push(cur);
  const out = [];
  for (let c of cmds) {
    // strip leading env assignments and wrappers that run their arguments as a command
    for (;;) {
      if (!c.length) break;
      const b = path.basename(c[0]);
      if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(c[0])) { c = c.slice(1); continue; }
      if (["env", "exec", "command", "builtin", "nohup", "setsid", "sudo", "doas", "nice", "ionice", "stdbuf", "time", "timeout", "unbuffer", "chronic", "flock", "xargs", "parallel", "watch", "strace", "systemd-run", "runuser", "su", "eval"].includes(b)) {
        // drop the wrapper and its options (and a timeout's duration / flock's lock file / systemd-run's --unit etc.)
        let i = 1;
        while (i < c.length && (c[i].startsWith("-") || /^[A-Za-z_][A-Za-z0-9_]*=/.test(c[i]))) i++;
        if (b === "timeout" || b === "flock") i++;
        if (b === "xargs" || b === "parallel" || b === "eval" || b === "su" || b === "runuser") out.push({ via: b, words: c.slice(i) });
        c = c.slice(i); continue;
      }
      break;
    }
    if (!c.length) continue;
    const b = path.basename(c[0]);
    if (SHELLS.has(b)) {
      const ci = c.findIndex((w, i) => i > 0 && /^-[a-z]*c[a-z]*$/.test(w));
      if (ci > 0 && c[ci + 1] != null) { out.push(...commandsOf(shellWords(c[ci + 1]))); continue; }
      // `bash script.sh`: the script's own commands aren't visible here; the sandbox (pid namespace) is the guard for those
    }
    if ((b === "node" || b === "deno" || b === "bun") && c.some((w) => w === "-e" || w === "--eval" || w === "-p" || w === "--print")) {
      const ei = c.findIndex((w) => w === "-e" || w === "--eval" || w === "-p" || w === "--print");
      out.push({ via: b, words: c, code: c[ei + 1] || "" });
      continue;
    }
    if ((b === "python" || b === "python3" || b === "perl" || b === "ruby") && c.includes("-c") || (b === "perl" && c.includes("-e"))) {
      const ei = c.findIndex((w) => w === "-c" || w === "-e");
      out.push({ via: b, words: c, code: c[ei + 1] || "" });
      continue;
    }
    out.push({ words: c });
  }
  return out;
}

// The live runtime folders (the real hyprpi daemon's socket, Hyprland's, the session bus, kitty's): a test's sockets live elsewhere.
export const liveDirs = (uid = process.getuid?.() ?? 1000) => [`/run/user/${uid}`, `/tmp/hyprpi-${uid}`];
export const underLive = (p, dirs = liveDirs()) => { const r = path.resolve(String(p)); return dirs.some((d) => r === d || r.startsWith(d + "/")); };
// Is `socket` (HYPRPI_SOCKET in the child's env) a test's own daemon rather than the live one?
const isTestSocket = (sock, dirs) => !!sock && !underLive(sock, dirs);

// May a test run start this command? argv: [file, ...args] (shell: false) or { shell: "script" }; env: the child's env.
// -> "" (allowed) or the refusal message. ctx as for killRefusal, plus liveDirs (see liveDirs) and allowTestSocketQuit.
export function commandRefusal(argv, env, ctx = {}) {
  const words = Array.isArray(argv) ? argv.map(String) : shellWords(String(argv.shell || ""));
  for (const cmd of commandsOf(words)) {
    const w = cmd.words, b = path.basename(w[0] || "");
    const shown = w.join(" ").slice(0, 120);
    if (cmd.code != null) { // node -e / python -c / perl -e: look for signal calls in the code itself
      if (/\b(?:process\s*\.\s*_?kill|os\s*\.\s*kill(?:pg)?|killpg|Process\s*\.\s*kill|signal\.SIG|\bkill\s*\()/.test(cmd.code) && cmd.via !== "node") return `test guard: refused \`${shown}\`: inline ${cmd.via} code that sends signals. ${HOW}`;
      // node children get the preload through NODE_OPTIONS, so their process.kill is guarded where it runs
      continue;
    }
    if (cmd.via === "xargs" || cmd.via === "parallel") {
      const inner = path.basename(cmd.words[0] || "");
      if (inner === "kill" || PATTERN_KILLERS.has(inner)) return `test guard: refused \`${shown}\` via ${cmd.via}: its pids come from input the guard can't check. ${HOW}`;
    }
    if (PATTERN_KILLERS.has(b)) return `test guard: refused \`${shown}\`: ${b} matches processes by name or pattern, which reaches Angus's live processes. ${HOW}`;
    if (b === "kill") {
      let sig = "SIGTERM"; const pids = [];
      for (let i = 1; i < w.length; i++) {
        const a = w[i];
        if (a === "-s" || a === "-n" || a === "--signal") { sig = w[++i]; continue; }
        if (a === "-l" || a === "-L" || a === "--list") return "";
        if (a === "--") continue;
        if (/^-(?:[A-Z]+[A-Z0-9+-]*|\d{1,2})$/.test(a) && !pids.length) { sig = a.slice(1); continue; }
        pids.push(a);
      }
      if (sig === "0") continue;
      for (const a of pids) {
        if (!/^-?\d+$/.test(a) && ctx.sandboxed && a !== "-1") continue; // a variable: inside the sandbox the kernel keeps it to the test's own processes
        if (!/^-?\d+$/.test(a)) return `test guard: refused \`${shown}\`: '${a}' isn't a literal pid the guard can check (job specs, variables and command substitutions are refused). ${HOW}`;
        const why = killRefusal(Number(a), sig, ctx);
        if (why && why !== "ESRCH") return why + ` (from \`${shown}\`)`;
      }
      continue;
    }
    if (b === "hyprpi" || /(^|\/)bin\/hyprpi$/.test(w[0] || "") || (b === "node" && /(^|\/)bin\/hyprpi$/.test(w[1] || ""))) {
      const args = b === "node" ? w.slice(2) : w.slice(1);
      const sub = args.find((a) => !a.startsWith("-"));
      const live = !isTestSocket(env?.HYPRPI_SOCKET, ctx.liveDirs);
      if (sub === "send" && args.some((a) => /^\/(quit|exit|q)\b/.test(a))) {
        if (live || !(ctx.allowTestSocketQuit || env?.HYPRPI_TEST_ALLOW_QUIT_TEST_DAEMON === "1")) return `test guard: refused \`${shown}\`: \`hyprpi send … /quit\` ends an agent; tests close only fake agents, through a spied seam or their own daemon's API. ${HOW}`;
      }
      if (live && ["send", "restart", "stop", "daemon", "new", "close", "move", "focus", "park", "restore", "thoughts", "post", "dictate", "tinker"].includes(sub)) return `test guard: refused \`${shown}\`: it would reach the LIVE hyprpi daemon (no HYPRPI_SOCKET of the test's own). Start a temp daemon (HYPRPI_SOCKET/HYPRPI_STATE in a temp dir). ${HOW}`;
      continue;
    }
    if (b === "hyprctl") {
      const s = w.slice(1).join(" ");
      if (/\b(?:killactive|forcekillactive|closewindow|kill|exit|killwindow)\b|hl\.dsp\.(?:window\.)?(?:close|kill)/i.test(s)) return `test guard: refused \`${shown}\`: closes a real window. ${HOW}`;
      continue;
    }
    if (b === "kitty" || b === "kitten") {
      if (/\b(?:close-window|close-tab|signal-child|quit)\b/.test(w.join(" "))) return `test guard: refused \`${shown}\`: closes a real kitty window. ${HOW}`;
      continue;
    }
    if (b === "systemctl" || b === "loginctl" || b === "busctl") {
      if (/\b(?:kill|stop|restart|terminate-session|terminate-user|kill-session|kill-user|reboot|poweroff|suspend|hibernate)\b/.test(w.join(" "))) return `test guard: refused \`${shown}\`: stops real services or sessions. ${HOW}`;
      continue;
    }
    if (ctx.netShared && ["curl", "wget", "nc", "ncat", "netcat", "socat", "telnet", "http", "xh", "websocat", "grpcurl"].includes(b)) {
      // with --net the host's loopback services are reachable: a network client aimed at this machine is refused (node's own
      // connections are checked by the preload; a client from a shell script isn't seen here)
      if (w.slice(1).some((x) => /(^|[/@:\[,=])(localhost\.?|127\.\d+(\.\d+){0,2}|0\.0\.0\.0|\[?::1\]?|0x7f[0-9a-f]*|2130706433)([:/\],]|$)/i.test(x) || /^(unix|abstract|unix-connect|abstract-connect|UNIX-CONNECT|ABSTRACT-CONNECT):/i.test(x) || x === "-U" || x === "--unix-socket" || x === "--abstract-unix-socket")) return `test guard: refused \`${shown}\`: a network client aimed at THIS machine while the run shares the host network (--net / test-guard: net). Talk to the test's own servers from node, or drop --net. ${HOW}`;
      continue;
    }
    if (b === "reprieve") { if (/\b(?:park|close)\b/.test(w.join(" "))) return `test guard: refused \`${shown}\`: parks a real window. ${HOW}`; continue; }
  }
  return "";
}
