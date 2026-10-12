#!/usr/bin/env node
// J477 (Angus: "in wrld G, summoning a window isn't dismissing the other windows. it should be the same logic as other worlds"):
// summoning into a world-G workspace clears it like a host workspace: G's own agent windows go home (inside G's range), its panels to the
// nearest G workspace with room, a Doorman window nearby; a pinned one stays; the summoned one comes in.
// Isolated: a throwaway daemon (own socket, state, config) with HYPRPI_ALLOW_HYPR=1 and a FAKE hyprctl first on PATH (a JSON window list
// it reads and moves), so no real window is touched; world G's helper record in a temp XDG_STATE_HOME.
//   node test/sandbox-summon.mjs   (exit 0 = pass)
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0; const ok = (n, c, x = "") => { if (!c) fails++; console.log(`${c ? "ok  " : "FAIL"} ${n}${x ? ": " + x : ""}`); };
const S = fs.mkdtempSync(path.join(os.tmpdir(), "j477-")), cfg = path.join(S, "cfg"), xs = path.join(S, "xstate"), bin = path.join(S, "bin"), sock = path.join(S, "d.sock"), W = path.join(S, "windows.json");
for (const d of [path.join(cfg, "hyprpi"), path.join(xs, "hyprpi", "worlds", "world-g"), bin]) fs.mkdirSync(d, { recursive: true });
fs.writeFileSync(path.join(cfg, "hyprpi", "config.json"), JSON.stringify({ roomToThoughts: false, pi: "/bin/cat", worldSize: 10 }));
fs.writeFileSync(path.join(cfg, "hyprpi", "hyprpi.jsonc"), JSON.stringify({ auth: { enabled: false }, upkeep: { refresh: { enabled: false }, autoReload: { enabled: false } } }));
// the fake Hyprland: clients with class/title/pid/workspace; dispatch window.move / focus / fullscreen_state
const win = (address, cls, title, pid, ws) => ({ address, class: cls, initialClass: cls, title, pid, workspace: { id: ws, name: String(ws) }, floating: false, mapped: true, hidden: false, fullscreen: 0, monitor: 0, at: [0, 0], size: [800, 600] });
const clients = [
  win("0xa1", "hyprpi.g-agent", "🐳 G: π - Alpha - world-g", 101, 61),
  win("0xb2", "hyprpi.g-agent", "🐳 G: π - Beta - world-g", 102, 61),
  win("0xc3", "hyprpi.g-mockup", "G: hyprpi-board G", 103, 61),
  win("0xd4", "hyprpi-doorman-doorman-g", "Doorman-G · ARCHIVE + DECISIONS", 105, 61),
  win("0xe5", "hyprpi.g-agents", "G: hyprpi-router G", 104, 63),
  win("0xf6", "hyprpi.g-agent", "🐳 G: π - Gamma - world-g", 106, 61),
];
// a dialog of Beta's (same pid, floating) comes along wherever Beta goes
clients.push({ ...win("0xb2d", "xdg-desktop-portal-gtk", "Open File", 102, 61), floating: true });
fs.writeFileSync(W, JSON.stringify({ clients, active: 61, focused: "" }));
fs.writeFileSync(path.join(xs, "hyprpi", "worlds", "world-g", "windows.json"), JSON.stringify({ lo: 61, hi: 69, windows: {
  "0xa1": { kind: "agent", home: 62, pid: 101 }, "0xb2": { kind: "agent", home: 64, pid: 102 }, "0xc3": { kind: "panel", pid: 103 },
  "0xe5": { kind: "panel", pid: 104 }, "0xf6": { kind: "agent", home: 65, pid: 106 } } }));
fs.writeFileSync(path.join(bin, "hyprctl"), `#!/usr/bin/env node
const fs = require("fs"), F = ${JSON.stringify(W)}, a = process.argv.slice(2), st = JSON.parse(fs.readFileSync(F, "utf8"));
const save = () => fs.writeFileSync(F, JSON.stringify(st));
if (a[0] === "-j") { const w = a[1];
  if (w === "clients") return console.log(JSON.stringify(st.clients));
  if (w === "activeworkspace") return console.log(JSON.stringify({ id: st.active, name: String(st.active), monitor: "eDP-1" }));
  if (w === "activewindow") return console.log(JSON.stringify(st.clients.find((c) => c.address === st.focused) || {}));
  if (w === "workspaces") return console.log(JSON.stringify([...new Set(st.clients.map((c) => c.workspace.id))].map((id) => ({ id, name: String(id), windows: st.clients.filter((c) => c.workspace.id === id).length }))));
  if (w === "monitors") return console.log(JSON.stringify([{ id: 0, name: "eDP-1", focused: true, activeWorkspace: { id: st.active } }]));
  return console.log("[]"); }
if (a[0] === "dispatch") { const l = a.slice(1).join(" "), addr = (/address:(0x[0-9a-f]+)/.exec(l) || [])[1];
  const mv = /window\\.move\\(\\{[^}]*workspace = "(\\d+)"/.exec(l);
  if (mv && addr) { const c = st.clients.find((x) => x.address === addr); if (c) c.workspace = { id: +mv[1], name: mv[1] }; (st.moves ||= []).push([addr, +mv[1]]); }
  if (/dsp\\.focus/.test(l) && addr) st.focused = addr;
  save(); return console.log("ok"); }
console.log("ok");
`, { mode: 0o755 });
const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, HYPRPI_SOCKET: sock, HYPRPI_STATE: path.join(S, "state"), XDG_CONFIG_HOME: cfg, XDG_STATE_HOME: xs,
  HYPRLAND_INSTANCE_SIGNATURE: "j477-bogus", HYPRPI_NO_ENSURE: "1", HYPRPI_UPKEEP_MS: "3600000", HYPRPI_ALLOW_HYPR: "1" };
delete env.HYPRPI_AGENT_ID; delete env.HYPRPI_WORKSPACE; delete env.HYPRPI_SANDBOX_WORLD;
const d = spawn(process.execPath, [path.join(ROOT, "bin/hyprpi"), "daemon"], { env, stdio: "ignore" });
const where = () => Object.fromEntries(JSON.parse(fs.readFileSync(W, "utf8")).clients.map((c) => [c.address, c.workspace.id]));
try {
  for (let i = 0; i < 50 && !fs.existsSync(sock); i++) await sleep(200);
  const { connect } = await import(path.join(ROOT, "lib/client.mjs"));
  const c = await connect({ path: sock });
  // Gamma is pinned (SUPER+ALT+S): it stays, like a pinned host window
  const pin = await c.call("guest.pin", { address: "0xf6", pinned: true });
  ok("a world-G window can be pinned like a host panel", pin?.pinned === true, JSON.stringify(pin));
  // SUPER+S on 61: summon G's router panel (on 63) with the auto-clear
  const r = await c.call("guest.summon", { panels: ["0xe5"], workspace: 61, auto: true });
  await sleep(300);
  const w = where();
  ok("the summoned G panel comes in", w["0xe5"] === 61, JSON.stringify(w));
  ok("G's agent windows go to their homes inside G (Alpha 62, Beta 64)", w["0xa1"] === 62 && w["0xb2"] === 64, JSON.stringify(w));
  ok("…with their dialogs (Beta's file chooser goes along)", w["0xb2d"] === 64, JSON.stringify(w));
  ok("G's other panel leaves for a G workspace nearby", w["0xc3"] >= 62 && w["0xc3"] <= 69, JSON.stringify(w));
  ok("the Doorman-G window leaves 61 too", w["0xd4"] !== 61, JSON.stringify(w));
  ok("the pinned G window stays", w["0xf6"] === 61, JSON.stringify(w));
  ok("the summon reports what it dismissed", ["Alpha", "Beta"].every((n) => (r.dismissed || []).includes(n)), JSON.stringify(r));
  // SUPER+D on the pinned one: refused; unpinned: home (the dismiss path shares the placement)
  const dz = await c.call("guest.dismiss", { address: "0xf6" });
  ok("dismissing a pinned G window is refused", dz?.pinned === true, JSON.stringify(dz));
  await c.call("guest.pin", { address: "0xf6", pinned: false });
  const dz2 = await c.call("guest.dismiss", { address: "0xf6" }); await sleep(300);
  ok("unpinned, it is dismissed to its home (65)", where()["0xf6"] === 65 && dz2?.home === 65, JSON.stringify(dz2));
  // (J477Check) a pin belongs to the window, not its address: a new G window that reuses a pinned one's address isn't pinned
  await c.call("guest.pin", { address: "0xf6", pinned: true });
  { const st = JSON.parse(fs.readFileSync(W, "utf8")); const g = st.clients.find((x) => x.address === "0xf6"); g.pid = 206; g.title = "🐳 G: π - Replacement - world-g"; g.workspace = { id: 61, name: "61" }; fs.writeFileSync(W, JSON.stringify(st));
    const hw = path.join(xs, "hyprpi", "worlds", "world-g", "windows.json"), h = JSON.parse(fs.readFileSync(hw, "utf8")); h.windows["0xf6"] = { kind: "agent", home: 66, pid: 206 }; fs.writeFileSync(hw, JSON.stringify(h)); }
  const dz3 = await c.call("guest.dismiss", { address: "0xf6" }); await sleep(300);
  ok("a window reusing a pinned window's address isn't pinned (it is dismissed home)", !dz3?.pinned && where()["0xf6"] === 66, JSON.stringify(dz3));
  c.close();
} finally { d.kill("SIGTERM"); await sleep(400); fs.rmSync(S, { recursive: true, force: true }); }
console.log(fails ? `sandbox-summon: ${fails} FAILED` : "sandbox-summon: all pass");
process.exit(fails ? 1 : 0);
