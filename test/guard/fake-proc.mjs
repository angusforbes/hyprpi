// J566: the seams a test that "closes" or "kills" uses instead of the real thing (skill isolated-app-tests, hard rule 1):
//   makeFakeProc(dir, procs)  a synthetic /proc root (stat, status, comm, cmdline, environ, cwd/exe links) to pass as procRoot
//   spyKill()                 a kill(pid, sig) stand-in that records calls and never signals; .calls, .throwFor(pid, code)
//   spy(name)                 the same for focus / close-window seams
import fs from "node:fs";
import path from "node:path";

// procs: [{ pid, ppid = 1, pgrp = pid, sid = pgrp, start = 1000 + pid, comm = "sleep", cmdline = [comm], cwd = "/", exe = "/usr/bin/" + comm,
//           env = {}, state = "S", utime = 0, stime = 0, rssPages = 100, threads = 1, uid = 1000 }]
export function makeFakeProc(dir, procs) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "uptime"), "100000.00 100000.00\n");
  fs.writeFileSync(path.join(dir, "stat"), "cpu  1 0 1 1000 0 0 0 0 0 0\nbtime 1700000000\n");
  fs.writeFileSync(path.join(dir, "meminfo"), "MemTotal:       16000000 kB\n");
  for (const p of procs) {
    const d = path.join(dir, String(p.pid)), comm = p.comm || "sleep", pgrp = p.pgrp ?? p.pid;
    fs.mkdirSync(d, { recursive: true });
    // fields after "(comm)": state ppid pgrp session tty tpgid flags minflt cminflt majflt cmajflt utime stime cutime cstime priority nice threads itreal starttime vsize rss
    const after = [p.state || "S", p.ppid ?? 1, pgrp, p.sid ?? pgrp, 0, -1, 0, 0, 0, 0, 0, p.utime || 0, p.stime || 0, 0, 0, 20, 0, p.threads || 1, 0, p.start ?? 1000 + p.pid, 1000000, p.rssPages ?? 100];
    fs.writeFileSync(path.join(d, "stat"), `${p.pid} (${comm}) ${after.join(" ")}\n`);
    fs.writeFileSync(path.join(d, "comm"), comm + "\n");
    fs.writeFileSync(path.join(d, "cmdline"), (p.cmdline || [comm]).join("\0") + "\0");
    fs.writeFileSync(path.join(d, "environ"), Object.entries(p.env || {}).map(([k, v]) => `${k}=${v}`).join("\0"));
    fs.writeFileSync(path.join(d, "status"), `Name:\t${comm}\nState:\t${p.state || "S"}\nPid:\t${p.pid}\nPPid:\t${p.ppid ?? 1}\nUid:\t${p.uid ?? 1000}\t${p.uid ?? 1000}\t${p.uid ?? 1000}\t${p.uid ?? 1000}\nVmRSS:\t${(p.rssPages ?? 100) * 4} kB\nThreads:\t${p.threads || 1}\n`);
    for (const [l, t] of [["cwd", p.cwd || "/"], ["exe", p.exe || `/usr/bin/${comm}`]]) { try { fs.unlinkSync(path.join(d, l)); } catch { /* new */ } fs.symlinkSync(t, path.join(d, l)); }
  }
  return dir;
}

// A kill stand-in: records (pid, signal), never signals. throwFor(pid, "ESRCH") makes a later call for pid throw like the real one.
export function spyKill() {
  const calls = [], throws = new Map();
  const kill = (pid, sig = "SIGTERM") => { calls.push({ pid, sig }); if (throws.has(pid)) { const e = new Error(`kill ${throws.get(pid)}`); e.code = throws.get(pid); throw e; } return true; };
  kill.calls = calls; kill.throwFor = (pid, code = "ESRCH") => { throws.set(pid, code); return kill; };
  return kill;
}

// A generic seam spy (focusWindow, closeWindow, request…): records its arguments, returns `result`.
export function spy(name, result = { ok: true }) {
  const calls = [];
  const fn = async (...a) => { calls.push(a); return typeof result === "function" ? result(...a) : result; };
  fn.calls = calls; fn.seam = name;
  return fn;
}
