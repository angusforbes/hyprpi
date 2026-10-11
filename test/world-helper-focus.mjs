#!/usr/bin/env node
// J467 W2: in a sandboxed world, the agents panel's jump goes inner daemon -> G's hyprctl stand-in (docker/world/bin/hyprctl,
// through the drop-box) -> the HOST-side helper (docker/world/world-helper.mjs), which focuses only the world's OWN windows.
// The real stand-in and the real helper, isolated: temp config/state, a stub host hyprctl that only records (no Hyprland), and two
// "kitty" stand-ins: one carrying G_WORLD=world-t (a window of this world; only the helper sets that on a real kitty), one not.
//   focus of the world's own agent window          -> dispatched
//   focus of another window, an unknown address    -> refused ("not a window of this world"), nothing dispatched
//   a forged request (extra Lua after the focus, or a raw exec through the drop-box) -> refused, nothing dispatched
//   node test/world-helper-focus.mjs   (exit 0 = pass)
import { spawn, execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0; const ok = (n, c, x = "") => { if (!c) fails++; console.log(`${c ? "ok  " : "FAIL"} ${n}${x ? ": " + x : ""}`); };
const T = fs.mkdtempSync(path.join(os.tmpdir(), "j467h-")), cfg = path.join(T, "cfg"), bin = path.join(T, "bin"), ws = path.join(T, "ws"), ginbox = path.join(T, "ginbox"), dlog = path.join(T, "dispatch.log"), clients = path.join(T, "clients.json");
for (const d of [path.join(cfg, "hyprpi", "worlds"), bin, ws, ginbox]) fs.mkdirSync(d, { recursive: true });
fs.writeFileSync(path.join(cfg, "hyprpi", "worlds", "world-t.json"), JSON.stringify({ sandbox: "world-t", workspace: ws, inbox: ginbox, workspaces: [61, 69] }));
fs.writeFileSync(path.join(bin, "hyprctl"), `#!/bin/sh
case "$1 $2" in
  "-j clients") cat ${clients} ;;
  "-j activeworkspace") echo '{"id":3,"name":"3","windows":1}' ;;
  "-j activewindow") echo '{}' ;;
  "-j monitors") echo '[{"id":0,"name":"T","focused":true,"activeWorkspace":{"id":3,"name":"3"},"width":1920,"height":1080,"x":0,"y":0,"scale":1}]' ;;
  "-j "*) echo '[]' ;;
  *) echo "$*" >> ${dlog}; echo ok ;;
esac
`, { mode: 0o755 });
const mine = spawn("sleep", ["300"], { stdio: "ignore", env: { ...process.env, G_WORLD: "world-t", G_TOKEN: "a".repeat(24) } }), other = spawn("sleep", ["300"], { stdio: "ignore" });
const win = (address, pid, cls, title, id) => ({ address, pid, class: cls, title, workspace: { id, name: String(id) }, at: [0, 0], size: [800, 600], mapped: true, hidden: false, floating: false, monitor: 0, fullscreen: 0, focusHistoryID: 1 });
fs.writeFileSync(clients, JSON.stringify([win("0xa1", mine.pid, "hyprpi.g-agent", "🐳 G: π - Alpha - world-t", 62), win("0xf0", other.pid, "kitty", "Angus's terminal", 3)]));
const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, XDG_CONFIG_HOME: cfg, XDG_STATE_HOME: path.join(T, "xs") };
const helper = spawn(process.execPath, [path.join(ROOT, "docker/world/world-helper.mjs"), "run", "world-t"], { env, stdio: "ignore" });
const inside = { ...process.env, HYPRPI_G_OUT: path.join(ws, ".hyprpi-g", "hypr-out"), HYPRPI_G_IN: ginbox };
const standIn = (lua) => new Promise((res) => execFile(process.execPath, [path.join(ROOT, "docker/world/bin/hyprctl"), "dispatch", lua], { env: inside, timeout: 15000 }, (e, out, err) => res({ code: e ? e.code : 0, out: String(out), err: String(err) })));
const dispatched = () => { try { return fs.readFileSync(dlog, "utf8").trim().split("\n").filter(Boolean); } catch { return []; } };
try {
  await sleep(1500);
  let r = await standIn('hl.dsp.focus({ window = "address:0xa1" })');
  ok("focus of the world's own agent window: dispatched by the host helper", r.code === 0 && dispatched().some((l) => /hl\.dsp\.focus\(\{ window = "address:0xa1" \}\)/.test(l)), JSON.stringify(r) + " " + dispatched().join(" | "));
  const n = dispatched().length;
  for (const [what, lua] of [["another app's window", 'hl.dsp.focus({ window = "address:0xf0" })'], ["an unknown address", 'hl.dsp.focus({ window = "address:0xdead" })'],
    ["extra Lua after the focus", 'hl.dsp.focus({ window = "address:0xa1" }) hl.dsp.exec_cmd("xterm")'], ["a forged address string", 'hl.dsp.focus({ window = "address:0xa1\\" }) --" })']]) {
    r = await standIn(lua);
    ok(`refused: ${what}`, r.code !== 0 && dispatched().length === n, `${r.code} ${r.err.trim()}`);
  }
  // straight through the drop-box (not via the stand-in): an exec or a close of another window
  const { gCall } = await import(path.join(ROOT, "docker/world/g-call.mjs"));
  Object.assign(process.env, inside);
  for (const [what, lua] of [["a raw exec request", 'hl.dsp.exec_cmd("xterm")'], ["closing another window", 'hl.dsp.window.close({ window = "address:0xf0" })']]) {
    const g = await gCall({ op: "dispatch", lua }).catch((e) => ({ ok: false, error: e.message }));
    ok(`refused: ${what} (direct drop-box request)`, g.ok === false && dispatched().length === n, JSON.stringify(g));
  }
  // J467 v2: Ctrl+click on an agent's name in a G window (the kitten g_agentclick.py runs `world-helper.mjs focus-word`)
  const fw = (...a) => new Promise((res) => execFile(process.execPath, [path.join(ROOT, "docker/world/world-helper.mjs"), "focus-word", "world-t", ...a], { env, timeout: 15000 }, (e, out) => res({ code: e ? e.code : 0, out: String(out) })));
  let m = dispatched().length;
  r = await fw("--line", "○ 🧪 @gtest · @Beta @Alpha · World G sandbox status", "--x", "21"); // the projects panel row, the pointer on "@Alpha"
  ok("Ctrl+click on @Alpha in a G panel line: Alpha's own window is focused", r.code === 0 && dispatched().length === m + 1 && /address:0xa1/.test(dispatched().at(-1)), JSON.stringify(r));
  m = dispatched().length;
  for (const [what, args] of [["a name that is no G agent (another app's window title)", ["--word", "Angus's"]], ["a name of no window at all", ["--word", "@Nobody"]], ["an empty spot", ["--line", "   ", "--x", "2"]]]) {
    r = await fw(...args); ok(`Ctrl+click on ${what}: nothing focused`, r.code !== 0 && dispatched().length === m, JSON.stringify(r)); }
  // a G window moved out of G's workspaces, and a window that only CLAIMS to be G's (title, class) without G_WORLD: never targets
  const fake = spawn("sleep", ["300"], { stdio: "ignore" });
  fs.writeFileSync(clients, JSON.stringify([win("0xa1", mine.pid, "hyprpi.g-agent", "🐳 G: π - Alpha - world-t", 3), win("0xb2", fake.pid, "hyprpi.g-agent", "🐳 G: π - Beta - world-t", 63)]));
  for (const w of ["@Alpha", "@Beta"]) { r = await fw("--word", w); ok(`Ctrl+click on ${w}: refused (${w === "@Alpha" ? "its window is outside G's workspaces" : "a look-alike window without G_WORLD"})`, r.code !== 0 && dispatched().length === m, JSON.stringify(r)); }
  fake.kill();
  // (ParityReview) a name AGENT_RE would have refused (an apostrophe), and a title whose folder isn't the world's name (pi's cwd)
  fs.writeFileSync(clients, JSON.stringify([win("0xa1", mine.pid, "hyprpi.g-agent", "🐳 G: π - O'Neil - Cube Project", 62)]));
  r = await fw("--line", "@O'Neil · World G", "--x", "3");
  ok("a name with an apostrophe, its agent working in another folder: found and focused (multi-word names match by one word, as on the host)", r.code === 0 && /address:0xa1/.test(dispatched().at(-1)), JSON.stringify(r));
} finally {
  helper.kill(); mine.kill(); other.kill(); await sleep(300); fs.rmSync(T, { recursive: true, force: true });
}
console.log(fails ? `world-helper-focus: ${fails} FAILED` : "world-helper-focus: all pass");
process.exit(fails ? 1 : 0);
