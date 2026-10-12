#!/usr/bin/env node
// J482 (Angus: "i have a brave brwoser i think running, and i can't find wehre it is, is there a pop up that shows all active
// windows/apps? … yes please!"): the SUPER+SHIFT+SPACE finder also lists ordinary app windows (app, title, workspace), after the
// hyprpi rows; "brave" finds every Brave window; ⏎ focuses it on its workspace; agents and panels are not listed twice.
// Isolated: a throwaway daemon (own socket/state/config) with a FAKE hyprctl first on PATH (HYPRPI_ALLOW_HYPR=1), so nothing
// real is touched. A fake agent (agent.hello) sits in a plain kitty window.
//   node test/finder-apps.mjs   (exit 0 = pass)
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0; const ok = (n, c, x = "") => { if (!c) fails++; console.log(`${c ? "ok  " : "FAIL"} ${n}${x ? ": " + x : ""}`); };
const S = fs.mkdtempSync(path.join(os.tmpdir(), "j482-")), cfg = path.join(S, "cfg"), xs = path.join(S, "xstate"), bin = path.join(S, "bin"), sock = path.join(S, "d.sock"), W = path.join(S, "windows.json"), LOG = path.join(S, "dispatch.log");
for (const d of [path.join(cfg, "hyprpi"), path.join(xs, "hyprpi"), bin]) fs.mkdirSync(d, { recursive: true });
fs.writeFileSync(path.join(cfg, "hyprpi", "config.json"), JSON.stringify({ roomToThoughts: false, pi: "/bin/cat", worldSize: 10, finderStyle: "menu" }));
fs.writeFileSync(path.join(cfg, "hyprpi", "hyprpi.jsonc"), JSON.stringify({ auth: { enabled: false }, upkeep: { refresh: { enabled: false }, autoReload: { enabled: false } } }));
const stand = spawn("sleep", ["300"], { stdio: "ignore" }); // the fake agent's process
const win = (address, cls, title, pid, ws, x = {}) => ({ address, class: cls, initialClass: cls, title, pid, workspace: { id: ws, name: String(ws) }, floating: false, mapped: true, hidden: false, pinned: false, fullscreen: 0, monitor: 0, at: [0, 0], size: [800, 600], ...x });
const clients = [
  win("0xb1", "brave-browser", "Kafka docs - Brave", 501, 67),                 // G7
  win("0xb2", "brave-browser", "GitHub - Brave", 501, 61),                     // G1
  win("0xb3", "brave-browser", "Hugging Face - Brave - Work", 501, 1),         // A1, profile Work
  win("0xo1", "md.obsidian.Obsidian", "Today - notes - Obsidian v1.9.12", 502, 23), // C3
  win("0xs1", "slack", "general - Slack", 503, -98, { workspace: { id: -98, name: "special:scratchpad" } }), // a special workspace
  win("0xag", "kitty", "π - Atlas", stand.pid, 5),                             // the agent Atlas in a plain kitty: an agent row, not an app
  win("0xp1", "kitty", "hyprpi-board C extra", 504, 24),                       // a projects panel (by title)
  win("0xp2", "hyprpi.mockup", "hyprpi-room C", 505, 25),                      // a stream panel
  win("0xdd", "hyprpi-doorman-doorman-g", "Doorman-G · ARCHIVE + DECISIONS", 506, 62), // a Doorman window: a panel row
  win("0xdl", "xdg-desktop-portal-gtk", "Open File", 501, 1, { floating: true }), // a dialog: never listed
];
fs.writeFileSync(W, JSON.stringify(clients));
fs.writeFileSync(path.join(bin, "hyprctl"), `#!/bin/sh
case "$*" in
  "-j clients") cat ${W} ;;
  "-j activeworkspace") echo '{"id":1,"name":"1","monitor":"T"}' ;;
  "-j activewindow") echo '{}' ;;
  "-j monitors") echo '[{"id":0,"name":"T","focused":true,"activeWorkspace":{"id":1,"name":"1"},"width":1920,"height":1080,"x":0,"y":0,"scale":1}]' ;;
  "-j "*) echo '[]' ;;
  *) echo "$*" >> ${LOG}; echo ok ;;
esac
`, { mode: 0o755 });
const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, HYPRPI_SOCKET: sock, HYPRPI_STATE: path.join(S, "state"), XDG_CONFIG_HOME: cfg, XDG_STATE_HOME: xs,
  HYPRLAND_INSTANCE_SIGNATURE: "j482-bogus", HYPRPI_NO_ENSURE: "1", HYPRPI_UPKEEP_MS: "3600000", HYPRPI_ALLOW_HYPR: "1" };
delete env.HYPRPI_AGENT_ID; delete env.HYPRPI_WORKSPACE; delete env.HYPRPI_SANDBOX_WORLD;
const d = spawn(process.execPath, [path.join(ROOT, "bin/hyprpi"), "daemon"], { env, stdio: "ignore" });
const finder = (...a) => execFileSync(process.execPath, [path.join(ROOT, "mockups/finder"), ...a], { env, encoding: "utf8", timeout: 20000 });
try {
  for (let i = 0; i < 50 && !fs.existsSync(sock); i++) await sleep(200);
  const { connect } = await import(path.join(ROOT, "lib/client.mjs"));
  const atlas = await connect({ path: sock, onEvent: () => {} });
  await atlas.call("agent.hello", { agent_id: "hp-atlas", pid: stand.pid, name: "Atlas", want_workspace: 5, cwd: S });
  for (let i = 0; i < 40; i++) { const l = await atlas.call("list"); if ((l.agents || []).some((a) => a.id === "hp-atlas" && a.address === "0xag")) break; await sleep(250); }
  const list = finder("--list");
  console.log(list.replace(/^/gm, "   | "));
  const opts = JSON.parse(finder("--list", "--options"));
  // W1: the rows
  const brave = opts.filter((o) => /brave/i.test(o.label));
  ok("W1 three Brave rows, app + workspace on the line (A1, G1, G7)", brave.length === 3 && ["A1", "G1", "G7"].every((w) => brave.some((o) => o.label.includes("· " + w))), brave.map((o) => o.label).join(" | "));
  ok("W1 the window title is each row's small line", ["Kafka docs", "GitHub", "Hugging Face"].every((t) => brave.some((o) => o.subtitle.includes(t))), brave.map((o) => o.subtitle).join(" | "));
  ok("W1 the profile shows (\"Brave Work\")", brave.some((o) => /Brave Work · A1/.test(o.label)));
  ok("W1 Obsidian with its vault on C3", opts.some((o) => /Obsidian notes · C3/.test(o.label) && /Today/.test(o.subtitle)));
  ok("W1 a special-workspace window is listed, marked hidden", opts.some((o) => /slack · hidden \(scratchpad\)/.test(o.label)), opts.filter((o) => /slack/i.test(o.label)).map((o) => o.label).join());
  ok("W1 app rows come after the agent, project and panel rows", (() => { const i = opts.findIndex((o) => /brave|obsidian|slack/i.test(o.label)); return i > 0 && opts.slice(i).every((o) => !/^>|Atlas/.test(o.name)); })());
  // W1: typing "brave" (the plugin's own ranking, FinderRank.js, over the plugin's options)
  const src = fs.readFileSync(path.join(ROOT, "shell-plugin/agf.hyprpi-finder/FinderRank.js"), "utf8").replace(/^\.pragma library\s*/, "");
  const ctx = {}; vm.createContext(ctx); vm.runInContext(src, ctx);
  const typed = (q) => Array.from(ctx.rank(opts, q, false)).map((i) => opts[i].label);
  console.log(`   typing "brave" → ${JSON.stringify(typed("brave"))}`);
  ok("W1 typing \"brave\" shows every Brave window and nothing else", typed("brave").length === 3 && typed("brave").every((l) => /Brave/.test(l)));
  ok("W1 a title finds its window (\"kafka\")", JSON.stringify(typed("kafka")) === JSON.stringify(brave.filter((o) => /Kafka/.test(o.subtitle)).map((o) => o.label)), JSON.stringify(typed("kafka")));
  const qml = fs.readFileSync(path.join(ROOT, "shell-plugin/agf.hyprpi-finder/Menu.qml"), "utf8");
  ok("W1 Menu.qml hands each option's search text to the ranking", /var search = String\(opt\.search \|\| ""\)/.test(qml) && /subtitle: subtitle, search: search \}\)/.test(qml));
  // W2: not twice
  const count = (re) => opts.filter((o) => re.test(o.label)).length;
  ok("W2 the agent Atlas is listed once (as an agent, not as its kitty)", count(/Atlas/) === 1 && !opts.some((o) => /Terminal/.test(o.label)), opts.filter((o) => /Atlas|Terminal/.test(o.label)).map((o) => o.label).join(" | "));
  ok("W2 panels once (>Projects C, >Stream C), not as app windows", count(/>Projects C/) === 1 && count(/>Stream C/) === 1 && !opts.some((o) => /hyprpi-/.test(o.label + o.subtitle)));
  ok("W2 the Doorman window once (its panel row)", count(/Doorman/) === 1);
  ok("W2 dialogs are not listed", !opts.some((o) => /Open File|portal/i.test(o.label + o.subtitle)));
  // W2: ⏎ on an app row focuses that window (its workspace comes with it)
  for (const [addr, re] of [["0xb1", /Brave · G7/], ["0xs1", /slack · hidden/]]) {
    const row = opts.find((o) => re.test(o.label)); fs.writeFileSync(LOG, "");
    finder("--act", row.value);
    const log = fs.readFileSync(LOG, "utf8").trim();
    ok(`W2 ⏎ on "${row.label}" dispatches one focus of ${addr}`, log.split("\n").length === 1 && /hl\.dsp\.focus\(\{ window = "address:/.test(log) && log.includes(addr), log);
  }
  atlas.close();
} finally { d.kill("SIGTERM"); stand.kill(); await sleep(400); fs.rmSync(S, { recursive: true, force: true }); }
console.log(fails ? `finder-apps: ${fails} FAILED` : "finder-apps: all pass");
process.exit(fails ? 1 : 0);
