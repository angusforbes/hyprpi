#!/usr/bin/env node
// jot-relayd.mjs WORLD (J561, Angus: "all hits go to laptop obsidian"): the laptop's end of pi-jot's relay for a remote world's
// agents WITHOUT a laptop window (windowless agents, the world's Thoughts). It serves pi-jot relay requests (one JSON line in, one
// JSON line out; lib/jot-relay-host.mjs: confined to the laptop's own notes root) on a local unix socket, and keeps an ssh reverse
// forward of that socket to the machine at ~/.hyprpi-<x>/jot.sock, where pi-jot (PI_JOT_RELAY_SOCKET, set by remote.sh's
// pi-entry) connects first. Windows don't need it (they answer through the window), but use it too when it's up.
// Runs as the systemd user service hyprpi-jot-relay@<x> (`omnistation/world X jot` installs and starts it). While the laptop sleeps
// or the link is down, remote jots fail with "the laptop isn't reachable; nothing was saved" (and the agent can keep a copy in the
// shared folder or locally, as the machine's AGENTS.md says). Plain ssh bindings only (a Teleport `tsh` one isn't supported yet).
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { jotRelayAnswer, laptopJotRoot } from "../lib/jot-relay-host.mjs";

const WL = String(process.argv[2] || "").toLowerCase();
if (!/^[a-i]$/.test(WL)) { console.error("jot-relayd: usage: jot-relayd.mjs WORLD-LETTER"); process.exit(2); }
const CONF = process.env.HYPRPI_REMOTE_CONF || path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), `hyprpi/remote/${WL}.json`);
const log = (s) => console.log(`${new Date().toISOString().slice(0, 19)} ${s}`);
let ssh; try { ssh = (JSON.parse(fs.readFileSync(CONF, "utf8")).ssh || []).filter((a) => a !== "-t" && a !== "-tt"); } catch (e) { console.error(`jot-relayd: ${CONF}: ${e.message}`); process.exit(2); }
if (!ssh.length || path.basename(ssh[0]) !== "ssh") { log(`world ${WL.toUpperCase()}: "${ssh[0] || ""}" isn't plain ssh; the relay socket isn't supported for it yet (windows still relay)`); process.exit(0); }
const host = ssh.slice(1), sshOpts = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=20", "-o", "ControlMaster=no", "-o", "ControlPath=none", "-o", "ServerAliveInterval=30", "-o", "ServerAliveCountMax=3"];
const runDir = process.env.XDG_RUNTIME_DIR || os.tmpdir();
const LOCAL = path.join(runDir, `hyprpi-jot-relay-${WL}.sock`);

// 1. the local server (answers with the laptop's notes root, read fresh for each request so a jot.json change applies)
try { fs.unlinkSync(LOCAL); } catch { /* none */ }
const server = net.createServer((c) => {
  let buf = "";
  c.setTimeout(60000, () => c.destroy());
  c.on("data", (d) => {
    buf += d; if (buf.length > (8 << 20)) return c.destroy();
    const i = buf.indexOf("\n"); if (i < 0) return;
    let out; try { out = jotRelayAnswer(buf.slice(0, i), { root: laptopJotRoot() }); } catch (e) { out = JSON.stringify({ ok: false, error: e.message }); }
    c.end(out + "\n");
    try { const r = JSON.parse(buf.slice(0, i)); log(`${r.op} ${r.path} -> ${JSON.parse(out).ok ? "ok" : JSON.parse(out).error}`); } catch { /* */ }
  });
  c.on("error", () => {});
});
server.listen(LOCAL, () => { fs.chmodSync(LOCAL, 0o600); log(`serving ${LOCAL} (notes root ${laptopJotRoot()})`); });

// 2. the reverse forward, kept up (the stale remote socket is removed first: sshd won't bind over it)
let delay = 2000, stopping = false, child = null;
function forward() {
  if (stopping) return;
  const home = spawnSync(ssh[0], [...sshOpts, ...host, "echo $HOME"], { encoding: "utf8", timeout: 40000 });
  const rh = (home.stdout || "").trim().split("\n").pop();
  if (home.status !== 0 || !/^\/[\w./-]+$/.test(rh || "")) { log(`can't reach the machine (${(home.stderr || "").trim().split("\n").pop() || home.status}); retry in ${delay / 1000} s`); return setTimeout(forward, (delay = Math.min(delay * 2, 60000))); }
  const REMOTE = `${rh}/.hyprpi-${WL}/jot.sock`;
  spawnSync(ssh[0], [...sshOpts, ...host, `rm -f ${REMOTE}`], { timeout: 40000 });
  const t0 = Date.now();
  child = spawn(ssh[0], [...sshOpts, "-N", "-o", "ExitOnForwardFailure=yes", "-o", "StreamLocalBindUnlink=yes", "-R", `${REMOTE}:${LOCAL}`, ...host], { stdio: ["ignore", "ignore", "pipe"] });
  let err = ""; child.stderr.on("data", (d) => { err = (err + d).slice(-400); });
  log(`forwarding ${REMOTE} -> ${LOCAL}`);
  child.on("exit", (code) => {
    child = null; if (stopping) return;
    if (Date.now() - t0 > 60000) delay = 2000; // it ran a while: a fresh drop, retry soon
    log(`forward ended (${code}${err.trim() ? ": " + err.trim().split("\n").filter((l) => !/post-quantum|store now|may need|^\*\*/.test(l)).pop() : ""}); retry in ${delay / 1000} s`);
    setTimeout(forward, delay); delay = Math.min(delay * 2, 60000);
  });
}
forward();
for (const s of ["SIGTERM", "SIGINT"]) process.on(s, () => { stopping = true; try { child?.kill(); } catch { /* */ } try { fs.unlinkSync(LOCAL); } catch { /* */ } process.exit(0); });
