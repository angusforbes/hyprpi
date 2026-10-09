#!/usr/bin/env node
// J333 proof: an isolated hyprpi daemon (its own socket + state dir) changes nothing on the real
// desktop, even with the real session env (HYPRLAND_INSTANCE_SIGNATURE, WAYLAND_DISPLAY) present.
//
// How: a spy `hyprctl` first on PATH logs every call; queries (clients, monitors, …) go on to the real
// hyprctl, anything else (dispatch, keyword, …) is logged and DROPPED, so even a failing guard can't
// move a window. Spy terminals / notify-send / menus / paplay log and exit. The run then exercises the
// paths that hit Angus's desktop on 2026-10-09:
//   1. an agent hello whose pid hangs under a REAL window (this test's own terminal) asking for ws 61
//      (Pkgsort's window landed on ws 61 that way),
//   2. a panel restore (panel autostart: exec_cmd + float/resize/move),
//   3. `hyprpi new --workspace 62` (opens a terminal window).
// Pass: zero non-query hyprctl calls, no terminal spawned, and the daemon logged "hypr actions disabled".
// Control (--control, HYPRPI_ALLOW_HYPR=1): the same run DOES reach the spy with dispatches, which shows
// the scenario exercises the real paths (the spy still drops them).
//   node test/isolated-hypr.mjs            the guarded run (exit 0 = pass)
//   node test/isolated-hypr.mjs --both     guarded + control
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { connect } from "../lib/client.mjs";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const QUERIES = "clients|activewindow|activeworkspace|workspaces|monitors|cursorpos|layers|devices|version|binds|getoption|submap|instances|splash|globalshortcuts|rollinglog|configerrors|systeminfo|decorations|animations|layouts|workspacerules|getprop";

async function run(control) {
  if (!process.env.HYPRLAND_INSTANCE_SIGNATURE) throw new Error("run this inside the Hyprland session (the point is the real env)");
  const T = fs.mkdtempSync(path.join(os.tmpdir(), `j333-${control ? "control" : "guard"}-`));
  const bin = path.join(T, "bin"), state = path.join(T, "state"), sock = path.join(T, "d.sock"), spyLog = path.join(T, "spy.log");
  fs.mkdirSync(bin); fs.mkdirSync(state);
  const real = spawnSync("sh", ["-c", "command -v hyprctl"], { encoding: "utf8" }).stdout.trim();
  fs.writeFileSync(path.join(bin, "hyprctl"), `#!/bin/sh
verb=""; for a in "$@"; do case "$a" in -*) ;; *) verb="$a"; break ;; esac; done
case "$verb" in ${QUERIES}) echo "query $*" >> ${spyLog}; exec ${real} "$@" ;; esac
echo "WRITE $*" >> ${spyLog}
exit 0
`, { mode: 0o755 });
  for (const t of ["kitty", "foot", "alacritty", "ghostty", "notify-send", "omarchy-notification-send", "omarchy-menu-select", "paplay"])
    fs.writeFileSync(path.join(bin, t), `#!/bin/sh\necho "SPAWN ${t} $*" >> ${spyLog}\nexit 0\n`, { mode: 0o755 });
  // A panel that was "open" before (world Q: no such panel exists, so restore wants to open it on ws 61).
  fs.writeFileSync(path.join(state, "panels.json"), JSON.stringify({ version: 1, savedAt: Date.now(), panels: [{ kind: "stream", world: "Q", workspace: 61, floating: true, at: [10, 10], size: [400, 300] }], closed: [] }));
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, HYPRPI_SOCKET: sock, HYPRPI_STATE: state };
  delete env.HYPRPI_AGENT_ID; delete env.HYPRPI_ALLOW_HYPR; delete env.HYPRPI_TEST;
  if (control) env.HYPRPI_ALLOW_HYPR = "1";
  const dlog = fs.openSync(path.join(T, "daemon.log"), "w");
  const d = spawn(process.execPath, [path.join(ROOT, "bin/hyprpi"), "daemon"], { env, stdio: ["ignore", dlog, dlog] });
  try {
    for (let i = 0; i < 100 && !fs.existsSync(sock); i++) await sleep(100);
    if (!fs.existsSync(sock)) throw new Error("isolated daemon didn't start: " + fs.readFileSync(path.join(T, "daemon.log"), "utf8").slice(-400));
    // 1. Pkgsort's case: an agent whose process sits under a real window, wanting ws 61.
    const c = await connect({ path: sock });
    await c.call("agent.hello", { agent_id: "hp-j333probe", pid: process.pid, cwd: T, want_workspace: 61, name: "J333probe" }).catch((e) => console.log("hello:", e.message));
    // 2. Panel autostart / restore.
    await c.call("restore.run", { scope: "all", by: "j333" }, { timeoutMs: 30000 }).catch((e) => console.log("restore:", e.message));
    // 3. A new agent window.
    const n = spawnSync(process.execPath, [path.join(ROOT, "bin/hyprpi"), "new", "--workspace", "62", "--no-focus", "--cwd", T], { env, encoding: "utf8", timeout: 20000, stdio: ["ignore", "pipe", "pipe"] });
    await sleep(4000); // window refreshes, placement retries
    c.close();
    const spy = fs.existsSync(spyLog) ? fs.readFileSync(spyLog, "utf8").split("\n").filter(Boolean) : [];
    const writes = spy.filter((l) => l.startsWith("WRITE")), spawns = spy.filter((l) => l.startsWith("SPAWN"));
    const dl = fs.readFileSync(path.join(T, "daemon.log"), "utf8");
    return { T, queries: spy.length - writes.length - spawns.length, writes, spawns, disabledLogged: /hypr actions disabled/.test(dl), newOut: (n.stderr || n.stdout || "").trim().split("\n").pop() };
  } finally { d.kill("SIGTERM"); await sleep(500); try { d.kill("SIGKILL"); } catch { /* gone */ } }
}

const show = (name, r) => console.log(`${name}: ${r.queries} queries, ${r.writes.length} hyprctl writes, ${r.spawns.length} spawns, "hypr actions disabled" logged: ${r.disabledLogged}\n  hyprpi new: ${r.newOut}\n${[...r.writes, ...r.spawns].slice(0, 12).map((l) => "  " + l.slice(0, 160)).join("\n")}\n  dir: ${r.T}`);
const g = await run(false);
show("guarded (isolated)", g);
let ok = g.writes.length === 0 && g.spawns.filter((l) => /SPAWN (kitty|foot|alacritty|ghostty) /.test(l)).length === 0 && g.disabledLogged;
if (process.argv.includes("--both") || process.argv.includes("--control")) {
  const k = await run(true);
  show("control (HYPRPI_ALLOW_HYPR=1)", k);
  if (!k.writes.length) { console.log("control reached no Hyprland writes: the scenario doesn't exercise the paths"); ok = false; }
}
console.log(ok ? "PASS" : "FAIL");
process.exit(ok ? 0 : 1);
