// J444 (Angus: "4 yes", to calling sbx much less): every `sbx` CLI call makes sandboxd (sbx v0.47) open fresh Secret
// Service sessions to read its Docker token: measured 32 for `sbx ls`, 33 for `sbx ports --json`, 45 for a new `sbx
// exec`, 8 for a GET on sandboxd's own socket, 0 for its /daemon/health and 0 for a command sent through an `sbx exec`
// that is already open. That churn trips a gnome-keyring abort bug. Two cheaper ways to ask the same things:
//   sandboxRunning(name)  is the sandbox running? sandboxd's socket (8 sessions) instead of `sbx ls` (32); true / false,
//                         or null when the socket can't answer (no curl, sandboxd down, an unexpected reply): then the
//                         caller falls back to `sbx ls` as before (the route is sandboxd's own, undocumented).
//   new ExecProbe(name)   ONE long-lived `sbx exec -i <name> sh`, reused for read-only commands (the shares watcher's
//                         mountinfo check every 10 min): 45 sessions when it starts, then none. It never starts a
//                         stopped sandbox (it checks first) and answers undefined on any trouble, so callers fall back
//                         to their old fresh calls. What it reads comes from the guest, exactly as a fresh exec's would.
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync, spawn, spawnSync } from "node:child_process";

const SOCK = () => path.join(process.env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state"), "sandboxes", "sandboxes", "sandboxd", "sandboxd.sock");

export function sandboxRunning(name) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/.test(String(name || ""))) return null;
  try {
    const out = execFileSync("curl", ["-s", "-m", "5", "--unix-socket", SOCK(), "-w", "\n%{http_code}", `http://sandboxd/sandbox/${name}`], { encoding: "utf8", timeout: 8000 });
    const i = out.lastIndexOf("\n"), code = out.slice(i + 1).trim(), body = out.slice(0, i);
    if (code === "404") return false;
    if (code !== "200") return null;
    const j = JSON.parse(body);
    return j && j.name === name && typeof j.status === "string" ? j.status === "running" : null;
  } catch { return null; }
}
// The old way, for when the socket can't answer.
export function sandboxRunningCli(name) {
  const st = spawnSync("sbx", ["ls"], { encoding: "utf8", timeout: 20000 });
  return st.status === 0 ? new RegExp(`^${name.replace(/[.]/g, "\\.")}\\s+\\S+\\s+\\S+\\s+running`, "m").test(st.stdout || "") : null;
}
export const isRunning = (name) => { const r = sandboxRunning(name); return r === null ? sandboxRunningCli(name) : r; };

export class ExecProbe {
  constructor(name) { this.name = name; this.p = null; this.buf = ""; this.wait = null; }
  alive() { return !!this.p && this.p.exitCode === null && !this.p.killed; }
  close() { try { this.p?.kill(); } catch { /* */ } this.p = null; }
  start() {
    const p = spawn("sbx", ["exec", "-i", this.name, "sh"], { stdio: ["pipe", "pipe", "ignore"] });
    p.on("error", () => {}); p.stdin.on("error", () => {});
    p.stdout.setEncoding("utf8");
    p.stdout.on("data", (d) => { this.buf += d; if (this.buf.length > 4 << 20) this.close(); this.wait?.(); });
    p.on("exit", () => { if (this.p === p) this.p = null; this.wait?.(); });
    this.p = p; this.buf = "";
  }
  // Run one read-only shell command in the guest → its stdout; null = the sandbox isn't running; undefined = trouble.
  async run(cmd, timeoutMs = 20000) {
    if (!this.alive()) { const r = isRunning(this.name); if (r !== true) return r === false ? null : undefined; this.start(); }
    const mark = `__J444_${crypto.randomBytes(8).toString("hex")}__`;
    this.buf = "";
    try { this.p.stdin.write(`${cmd}; printf '\\n%s\\n' ${mark}\n`); } catch { this.close(); return undefined; }
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      const i = this.buf.indexOf(`\n${mark}\n`);
      if (i >= 0) { const out = this.buf.slice(0, i); this.buf = ""; return out; }
      if (!this.alive()) return undefined;
      await new Promise((r) => { this.wait = r; setTimeout(r, 500); }); this.wait = null;
    }
    this.close(); return undefined;
  }
}
