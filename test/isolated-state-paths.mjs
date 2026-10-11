#!/usr/bin/env node
// J437: an isolated hyprpi daemon (HYPRPI_STATE set, XDG_STATE_HOME NOT set) writes handoffs (and pruned
// outputs) under its own state folder, never into the live ~/.local/state/hyprpi.
//   node test/isolated-state-paths.mjs     (exit 0 = pass)
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { connect } from "../lib/client.mjs";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0;
const ok = (c, what) => { console.log(`${c ? "PASS" : "FAIL"} ${what}`); if (!c) fails++; };
const LIVE = path.join(os.homedir(), ".local/state/hyprpi");
const T = fs.mkdtempSync(path.join(os.tmpdir(), "j437-"));
for (const d of ["state", "run", "bin", "cfg/hyprpi"]) fs.mkdirSync(path.join(T, d), { recursive: true, mode: 0o700 });
fs.writeFileSync(path.join(T, "bin/hyprctl"), '#!/bin/sh\ncase "$*" in *-j*) case "$*" in *activeworkspace*|*activewindow*) echo "{}";; *) echo "[]";; esac;; *) echo ok;; esac\n', { mode: 0o755 });
const env = { ...process.env, HYPRPI_SOCKET: path.join(T, "sock"), HYPRPI_STATE: path.join(T, "state"), XDG_CONFIG_HOME: path.join(T, "cfg"),
  XDG_RUNTIME_DIR: path.join(T, "run"), HYPRLAND_INSTANCE_SIGNATURE: "bogus-" + path.basename(T), HYPRPI_NO_ADOPT: "1", PATH: `${path.join(T, "bin")}:${process.env.PATH}` };
for (const k of ["XDG_STATE_HOME", "HYPRPI_AGENT_ID", "HYPRPI_WORKSPACE", "PI_SESSION_FILE", "PI_SESSION_ID", "WAYLAND_DISPLAY"]) delete env[k];

// 1. The settings the daemon and its agents read (a child process with the isolated env).
const r = spawnSync(process.execPath, ["-e", `import(${JSON.stringify(path.join(ROOT, "lib/upkeep.mjs"))}).then((m) => { const S = m.loadUpkeep(); console.log(JSON.stringify({ h: S.refresh.handoffDir, p: S.prune.saveDir, o: m.statePath("~/Obsidian/x") })); })`], { env, encoding: "utf8" });
const S = JSON.parse(r.stdout || "{}");
ok(S.h === path.join(T, "state/handoffs"), `handoffDir follows HYPRPI_STATE (${S.h})`);
ok(S.p === path.join(T, "state/pruned"), `prune saveDir follows HYPRPI_STATE (${S.p})`);
ok(S.o === path.join(os.homedir(), "Obsidian/x"), "a path outside the state folder is kept as written");
const live = spawnSync(process.execPath, ["-e", `import(${JSON.stringify(path.join(ROOT, "lib/upkeep.mjs"))}).then((m) => console.log(m.loadUpkeep().refresh.handoffDir))`], { env: { ...process.env, HYPRPI_STATE: "", XDG_STATE_HOME: "" }, encoding: "utf8" }).stdout.trim();
ok(live === path.join(LIVE, "handoffs"), `without HYPRPI_STATE it is the live folder, as before (${live})`);

// 2. A real handoff through an isolated daemon.
const before = new Set(fs.existsSync(path.join(LIVE, "handoffs")) ? fs.readdirSync(path.join(LIVE, "handoffs")) : []);
const daemon = spawn(process.execPath, [path.join(ROOT, "bin/hyprpi"), "daemon"], { env, stdio: ["ignore", fs.openSync(path.join(T, "d.log"), "w"), "inherit"] });
try {
  for (let i = 0; i < 50 && !fs.existsSync(env.HYPRPI_SOCKET); i++) await sleep(100);
  await sleep(300);
  const api = await connect({ path: env.HYPRPI_SOCKET });
  const res = await api.call("thoughts.handoff", { room: "C", text: "J437 test handoff: open jobs none; waiting on Angus nothing; context: isolated state path test." });
  ok(res.file?.startsWith(path.join(T, "state", "handoffs") + "/") && fs.existsSync(res.file), `the handoff landed in the isolated state (${res.file})`);
  const after = fs.existsSync(path.join(LIVE, "handoffs")) ? fs.readdirSync(path.join(LIVE, "handoffs")) : [];
  ok(!after.some((f) => !before.has(f) && /^Thoughts-C-/.test(f)), "nothing new in the live handoffs folder");
  api.close?.();
} finally {
  daemon.kill(); await sleep(300);
  fs.rmSync(T, { recursive: true, force: true });
}
console.log(fails ? `${fails} FAILED` : "all passed");
process.exit(fails ? 1 : 0);
