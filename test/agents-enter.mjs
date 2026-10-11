#!/usr/bin/env node
// J467 W1 (Angus: "doesn't look like i can jump to agents by pressing enter or ctrl+enter"): the REAL agents panel
// (mockups/agents-tui.mjs) in a pseudo-terminal, against an isolated hyprpi daemon whose `hyprctl` is a stub that only records
// (no Hyprland, no window, no focus change). The same panel code runs in world G, where hyprctl is G's stand-in (see
// test/world-helper-focus.mjs for that half).
//   ⏎ on an agent row     -> one focus dispatch for that agent's window
//   Ctrl+⏎ (CSI 13;5u)    -> the same (as in the room and search panels)
//   ⏎ on a row with no window (a test agent) -> no dispatch, the note "✗ <name> has no window to jump to"
//   node test/agents-enter.mjs   (exit 0 = pass)
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0; const ok = (n, c, x = "") => { if (!c) fails++; console.log(`${c ? "ok  " : "FAIL"} ${n}${x ? ": " + x : ""}`); };
const T = fs.mkdtempSync(path.join(os.tmpdir(), "j467-")), cfg = path.join(T, "cfg"), sock = path.join(T, "d.sock"), bin = path.join(T, "bin"), dlog = path.join(T, "dispatch.log"), clients = path.join(T, "clients.json");
for (const d of [path.join(cfg, "hyprpi"), bin]) fs.mkdirSync(d, { recursive: true });
fs.writeFileSync(path.join(cfg, "hyprpi", "config.json"), JSON.stringify({ roomToThoughts: false, pi: "/bin/cat", worldSize: 10 }));
fs.writeFileSync(path.join(cfg, "hyprpi", "hyprpi.jsonc"), JSON.stringify({ auth: { enabled: false }, upkeep: { refresh: { enabled: false }, autoReload: { enabled: false } } }));
fs.writeFileSync(path.join(bin, "hyprctl"), `#!/bin/sh
case "$1 $2" in
  "-j clients") cat ${clients} ;;
  "-j activeworkspace") echo '{"id":1,"name":"1","windows":0}' ;;
  "-j activewindow") echo '{}' ;;
  "-j monitors") echo '[{"id":0,"name":"T","focused":true,"activeWorkspace":{"id":1,"name":"1"},"width":1920,"height":1080,"x":0,"y":0,"scale":1}]' ;;
  "-j "*) echo '[]' ;;
  *) echo "$(date +%s%3N) $*" >> ${dlog}; echo ok ;;
esac
`, { mode: 0o755 });
const kitty = spawn("sleep", ["300"], { stdio: "ignore" }), ghost = spawn("sleep", ["300"], { stdio: "ignore" }); // stand-ins for the agents' processes
fs.writeFileSync(clients, JSON.stringify([{ address: "0xa1", pid: kitty.pid, class: "kitty", title: "π - Atlas", workspace: { id: 5, name: "5" }, at: [0, 0], size: [800, 600], mapped: true, hidden: false, floating: false, monitor: 0, fullscreen: 0, focusHistoryID: 1 }]));
const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, HYPRPI_SOCKET: sock, HYPRPI_STATE: T, XDG_CONFIG_HOME: cfg, HYPRLAND_INSTANCE_SIGNATURE: "j467-bogus", HYPRPI_ALLOW_HYPR: "1", HYPRPI_NO_ENSURE: "1", HYPRPI_UPKEEP_MS: "3600000", TERM: "xterm-256color" };
delete env.HYPRPI_AGENT_ID; delete env.HYPRPI_WORKSPACE;
const d = spawn(process.execPath, [path.join(ROOT, "bin/hyprpi"), "daemon"], { env, stdio: "ignore" });
let panel = null, screen = "";
const focuses = () => { try { return fs.readFileSync(dlog, "utf8").split("\n").filter((l) => /hl\.dsp\.focus/.test(l)); } catch { return []; } };
try {
  for (let i = 0; i < 50 && !fs.existsSync(sock); i++) await sleep(200);
  const { connect } = await import(path.join(ROOT, "lib/client.mjs"));
  const atlas = await connect({ path: sock, onEvent: () => {} });
  await atlas.call("agent.hello", { agent_id: "hp-atlas", pid: kitty.pid, name: "Atlas", want_workspace: 5, cwd: T });
  panel = spawn("script", ["-qfc", `stty cols 110 rows 30; exec ${process.execPath} ${path.join(ROOT, "mockups/agents-tui.mjs")} A`, "/dev/null"], { env, stdio: ["pipe", "pipe", "ignore"] });
  panel.stdout.on("data", (b) => (screen += b.toString()));
  const key = async (k, ms = 900) => { panel.stdin.write(k); await sleep(ms); };
  await sleep(2500);
  ok("the panel lists Atlas", /Atlas/.test(screen), screen.slice(-300));
  for (let i = 0; i < 40; i++) { const l = await atlas.call("list"); if ((l.agents || []).some((a) => a.id === "hp-atlas" && a.address === "0xa1")) break; await sleep(250); } // the daemon knows Atlas's window
  await key("\x1b[1;5B"); // ^↓: the cursor onto the first agent
  const n0 = focuses().length; await key("\r", 1500);
  ok("⏎ on Atlas's row: one focus dispatch for its window", focuses().length === n0 + 1 && /address:0xa1/.test(focuses().at(-1) || ""), focuses().join(" | "));
  const n1 = focuses().length; await key("\x1b[13;5u", 1500);
  ok("Ctrl+⏎ on Atlas's row: the same focus dispatch", focuses().length === n1 + 1 && /address:0xa1/.test(focuses().at(-1) || ""), focuses().join(" | "));
  // a second agent with no window (like G's test agent): ⏎ jumps nowhere and says so
  const g = await connect({ path: sock, onEvent: () => {} });
  await g.call("agent.hello", { agent_id: "hp-ghost", pid: ghost.pid, name: "Ghost", want_workspace: 5, cwd: T });
  await sleep(2500);
  let sawNote = false; const n2 = focuses().length;
  for (let i = 0; i < 3 && !sawNote; i++) { screen = ""; await key("\x1b[1;5B"); await key("\r", 1500); if (/Ghost has no window to jump to/.test(screen)) sawNote = true; }
  ok("⏎ on a row with no window: the note \"✗ Ghost has no window to jump to\"", sawNote, screen.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").slice(-200));
  ok("… and no focus dispatch for anything but Atlas's own window", focuses().slice(n2).every((l) => /address:0xa1/.test(l)), focuses().slice(n2).join(" | "));
} finally {
  try { panel?.stdin.write("\x11"); } catch { /* */ } await sleep(300); try { panel?.kill(); } catch { /* */ }
  kitty.kill(); ghost.kill(); d.kill("SIGTERM"); await sleep(400); fs.rmSync(T, { recursive: true, force: true });
}
console.log(fails ? `agents-enter: ${fails} FAILED` : "agents-enter: all pass");
process.exit(fails ? 1 : 0);
