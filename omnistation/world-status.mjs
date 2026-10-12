#!/usr/bin/env node
// world-status.mjs: a remote world's agents, shown on the laptop like every other world's (J471 v2, Angus: "i don't see any H
// agents in summon or S+S+S popups"). One small process per remote world on the laptop (`omnistation/world X open` starts it;
// it ends 10 min after the world's last window closed). Every few seconds it writes the two host-only files a sandboxed world's
// helper writes (docker/world/world-helper.mjs), which the summon / finder pop-ups, the agents panel and the daemon already read:
//   ~/.local/state/hyprpi/worlds/world-<x>/windows.json   the world's windows on THIS desktop: kitty windows of class
//        hyprpi.<x>-agent whose process runs omnistation/remote-client.mjs for <x> NAME (read from /proc, pid-checked)
//   ~/.local/state/hyprpi/worlds/world-<x>/agents.json    the agents as the remote world's own daemon lists them (through
//        remote-control/rworld.mjs, the phone server's bridge: one source for "the world's agents"), passed through the same
//        strict schema as a sandbox's report (docker/world/g-status.mjs validateStatus), with OUR window for each
// Both carry "badge": "🛰" and "where": "remote" so the lists say "remote" where a sandbox says 🐳. Read-only: nothing here sends
// to an agent (a send goes one way, through the window's own link or the phone's bridge).
//
//   node world-status.mjs LETTER          run (one per world: a lock file keeps a second one out)
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WL = String(process.argv[2] || "").toUpperCase(), wl = WL.toLowerCase();
if (!/^[A-I]$/.test(WL)) { console.error("usage: world-status.mjs LETTER"); process.exit(2); }
const { loadConfig } = await import(path.join(HERE, "../lib/paths.mjs"));
const { validateStatus } = await import(path.join(HERE, "../docker/world/g-status.mjs"));
const rworld = await import(path.join(HERE, "../remote-control/rworld.mjs"));
const SIZE = Number(loadConfig().worldSize) || 10, idx = WL.charCodeAt(0) - 64, LO = (idx - 1) * SIZE + 1, HI = idx * SIZE;
const DIR = path.join(process.env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state"), "hyprpi", "worlds", `world-${wl}`);
fs.mkdirSync(DIR, { recursive: true, mode: 0o700 });

// one per world (review): the lock file is created atomically ("wx"); a lock whose pid isn't a world-status.mjs for this world
// any more (gone, or the pid reused by something else) is stale and taken over once
const LOCK = path.join(DIR, "status.pid");
const isHelper = (pid) => { try { const a = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0"); return a.some((x) => x.endsWith("/world-status.mjs")) && a.includes(WL); } catch { return false; } };
for (let tries = 0; ; tries++) {
  // (review) the lock appears already holding our pid: written to a private file first, then hard-linked into place (atomic, EEXIST if taken)
  const mineTmp = `${LOCK}.${process.pid}`; fs.writeFileSync(mineTmp, String(process.pid), { mode: 0o600 });
  try { fs.linkSync(mineTmp, LOCK); fs.unlinkSync(mineTmp); break; }
  catch (e) {
    try { fs.unlinkSync(mineTmp); } catch {}
    if (e.code !== "EEXIST" || tries > 0) process.exit(0);
    const old = Number(fs.readFileSync(LOCK, "utf8")); if (old && old !== process.pid && isHelper(old)) process.exit(0);
    try { fs.unlinkSync(LOCK); } catch { /* another one took it: the next try decides */ }
  }
}
const bye = () => { try { if (Number(fs.readFileSync(LOCK, "utf8")) === process.pid) fs.unlinkSync(LOCK); } catch {} rworld.closeBridges?.(); process.exit(0); };
for (const s of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(s, bye);

const write = (name, obj) => { const f = path.join(DIR, name); fs.writeFileSync(`${f}.${process.pid}.tmp`, JSON.stringify(obj), { mode: 0o600 }); fs.renameSync(`${f}.${process.pid}.tmp`, f); };
const clients = () => new Promise((res) => execFile("hyprctl", ["clients", "-j"], { timeout: 5000, maxBuffer: 8e6 }, (e, out) => { try { res(e ? null : JSON.parse(out)); } catch { res(null); } }));
// the agent a window shows: its kitty's command line (local, so trusted) ends in remote-client.mjs <LETTER> <NAME>
function windowAgent(pid) {
  let argv; try { argv = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0"); } catch { return null; }
  const i = argv.findIndex((a) => a.endsWith("/remote-client.mjs"));
  return i >= 0 && argv[i + 1] === WL && /^[a-z][a-z0-9-]{0,30}$/.test(argv[i + 2] || "") ? argv[i + 2] : null;
}

let lastWin = "", lastSeenWindow = Date.now(), listAt = 0, lastList = null;
async function tick() {
  const cl = await clients(); if (!cl) return;
  const mine = cl.filter((c) => c.class === `hyprpi.${wl}-agent` && Number.isInteger(c.pid)).map((c) => ({ c, name: windowAgent(c.pid) })).filter((x) => x.name);
  if (mine.length) lastSeenWindow = Date.now();
  const windows = Object.fromEntries(mine.map(({ c, name }) => [c.address, { kind: "agent", home: c.workspace?.id || LO, pid: c.pid, name }]));
  const v = JSON.stringify(windows);
  if (v !== lastWin) { write("windows.json", { world: `world-${wl}`, lo: LO, hi: HI, badge: "🛰", where: "remote", windows }); lastWin = v; }
  // the agents, from the remote daemon (at most every 6 s; while the world is offline the old report ages into "not reporting")
  const w = rworld.remoteOf(WL);
  if (!w || Date.now() - listAt < 6000 || rworld.offline(w.name)) return;
  listAt = Date.now();
  try {
    const l = await rworld.call(w, "list", {});
    const raw = { agents: (l.agents || []).filter((a) => a && !a.parked).map((a) => ({ id: String(a.id || ""), name: String(a.name || ""), status: String(a.status || "idle"), model: a.model, ...(a.icon ? { icon: a.icon } : {}) })), thoughts: "off" };
    const ok = validateStatus(raw);
    // (review) a window, its socket and tmux session go by the LAUNCH name, which only the immutable id carries ("h-omni-alpha"
    // -> "omni-alpha"); the display name can be changed by the agent itself, so it is shown but never used to match or open
    const launchOf = (id) => { const n = String(id).startsWith(`${wl}-`) ? String(id).slice(2) : ""; return /^[a-z][a-z0-9-]{0,30}$/.test(n) ? n : ""; };
    const agents = ok.agents.map((a) => { const launch = launchOf(a.id), m = launch && mine.find((x) => x.name === launch); return { ...a, ...(launch ? { launch } : {}), ws: m ? m.c.workspace.id : 0, ...(m ? { address: m.c.address } : {}) }; });
    lastList = { world: `world-${wl}`, room: WL, at: Date.now(), agents, thoughts: ok.thoughts, dropped: ok.dropped, badge: "🛰", where: "remote" };
    write("agents.json", lastList);
  } catch { /* offline or slow: the report ages */ }
}
for (;;) {
  // (review) whoever no longer holds the lock (two took over the same stale one at once) leaves; the holder stays
  let holder = 0; try { holder = Number(fs.readFileSync(LOCK, "utf8")); } catch { /* gone */ }
  if (holder !== process.pid) { rworld.closeBridges?.(); process.exit(0); }
  try { await tick(); } catch { /* next round */ }
  if (Date.now() - lastSeenWindow > 10 * 60e3) bye(); // no window of this world for 10 min
  await new Promise((r) => setTimeout(r, 3000));
}
