#!/usr/bin/env node
// J543 (Angus: a remote world's panels must do the same as a local world's, acting on the LAPTOP): the four REAL panels in remote
// mode, end to end, without a network or a desktop. A "remote machine" is a fake home under ~/.cache (remote.sh refuses a /tmp path)
// with its own isolated hyprpi daemon (world H, no Hyprland); a fake ssh runs remote.sh there. The "laptop" is
// omnistation/panel-loop.sh → pty-relay.py → that ssh, in a pseudo-terminal, with stub hyprctl / gio / xdg-open / wl-paste /
// notify-send / world / mockups/panels on PATH that only record (no window anywhere is opened, focused or moved). Checked:
//   - every panel's Ctrl+click (and the agents panel's ⏎ / click) on an agent → a focus dispatch for that agent's LAPTOP window, or
//     `world H open NAME` for one with no window there (and then a focus for the window it opened)
//   - Ctrl+click / click on an http link → gio open on the laptop; a remote file link → copied to the laptop and opened from there
//   - a job link (Thoughts) and a project row (agents) → the laptop's board panel (mockups/panels H --only 4)
//   - Ctrl+N (agents) → world H new, and the jump to the new agent once it's listed
//   - Ctrl+V in Thoughts with an image on the laptop's clipboard → a remote path in the box, a real uploaded file (600), and ⏎
//     sends it to Thoughts as an image; with text on the clipboard → the text
//   - nothing is done on the "remote machine" (its stubs record nothing), and an unsolicited request (printed by an agent in the
//     Stream, with or without the right nonce) does nothing
//   node test/remote-panel-laptop.mjs   (exit 0 = pass)
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const { gw, graphemes } = await import(path.join(ROOT, "lib/tui/term.mjs"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0; const ok = (n, c, x = "") => { if (!c) fails++; console.log(`${c ? "ok  " : "FAIL"} ${n}${x && !c ? ": " + x : ""}`); };
const T = fs.mkdtempSync(path.join(os.homedir(), ".cache", "j543-")); // under $HOME: remote.sh refuses a path through a world-writable /tmp
const RH = path.join(T, "rh"), LH = path.join(T, "lh"), RB = path.join(T, "rbin"), LB = path.join(T, "lbin"), RW = path.join(RH, ".hyprpi-h");
for (const d of [RB, LB, LH, path.join(RW, "state", "boards"), path.join(RW, "state", "thoughts"), path.join(RW, "run"), path.join(RH, ".config", "hyprpi"), path.join(RH, "work")]) fs.mkdirSync(d, { recursive: true, mode: 0o700 });
const NODEDIR = path.dirname(process.execPath), now = Date.now();
const F = (n) => path.join(T, n);
const read = (n) => { try { return fs.readFileSync(F(n), "utf8"); } catch { return ""; } };
const lines = (n) => read(n).split("\n").filter(Boolean);
const exe = (f, s) => fs.writeFileSync(f, s, { mode: 0o755 });

// ---- the remote machine: remote.sh, config, a board with a job, a Thoughts thread, a file; stubs that record any desktop use
fs.copyFileSync(path.join(ROOT, "omnistation/remote.sh"), path.join(RW, "remote.sh"));
fs.writeFileSync(path.join(RH, ".config/hyprpi/config.json"), JSON.stringify({ roomToThoughts: false, pi: "/bin/cat", worldSize: 10 }));
fs.writeFileSync(path.join(RH, ".config/hyprpi/hyprpi.jsonc"), JSON.stringify({ auth: { enabled: false }, upkeep: { refresh: { enabled: false }, autoReload: { enabled: false } } }));
fs.writeFileSync(path.join(RW, "state/boards/H.json"), JSON.stringify({ room: "H", projects: [{ id: "p-om", name: "omniproj", title: "remote test", status: "active", members: ["h-omni-alpha"], writer: "h-omni-alpha", created: now, updated: now, by: "x", where: "see https://example.com/board-where now", next_step: null, seq: { D: 0, N: 1, H: 0 }, items: [{ h: "N1", sec: "next", text: "ask @omni-alpha about https://example.com/board-item please", by: { id: "", name: "x" }, ts: now, updated: now }] }] }));
fs.writeFileSync(path.join(RW, "state/briefs.json"), JSON.stringify({ next: 20, briefs: { J7: { id: "J7", version: 1, state: "running", created: now, updated: now, project: "p-om", projectName: "omniproj", item: "N1", agent: "h-omni-alpha", agent_name: "omni-alpha", from: "Thoughts-H", room: "H", fields: { goal: "g", angus: "x", done_when: ["W1 x"] }, history: [{ version: 1, state: "running", ts: now, fields: { goal: "g" } }] } } }));
fs.writeFileSync(path.join(RH, "work/notes.txt"), "remote notes\n");
for (const n of ["omni-alpha", "omni-beta", "omni-new"]) fs.mkdirSync(path.join(RW, "sessions", n), { recursive: true }); // (pi's --session-dir: an agent the machine has)
fs.writeFileSync(path.join(RW, "state/thoughts/H.thread.jsonl"), JSON.stringify({ ts: now, role: "thoughts", text: "Read https://example.com/thoughts-link and ~/work/notes.txt then ping @omni-alpha about J7 today." }) + "\n");
for (const t of ["hyprctl", "gio", "xdg-open", "wl-paste", "wl-copy", "notify-send", "kitty"]) exe(path.join(RB, t), `#!/bin/sh\ncase "$1 $2" in "-j "*) case "$2" in clients|workspaces|monitors) echo '[]';; *) echo '{}';; esac; exit 0;; esac\necho "${t} $*" >> ${F("remote-desktop.log")}\n`);

// ---- the laptop: stubs for hyprctl (its windows: clients.json), gio / xdg-open / notify-send, wl-paste, world, mockups/panels
const dummy = (name) => spawn("python3", ["-c", "import time; time.sleep(600)", "/x/omnistation/remote-client.mjs", "H", name], { stdio: "ignore" });
const procs = [dummy("omni-alpha"), dummy("omni-beta")];
const win = (address, pid, ws, title) => ({ address, pid, class: "hyprpi.h-agent", title, workspace: { id: ws, name: String(ws) }, at: [0, 0], size: [800, 600], mapped: true, hidden: false, floating: false, monitor: 0, fullscreen: 0 });
fs.writeFileSync(F("lclients.json"), JSON.stringify([win("0xa1", procs[0].pid, 73, "📡 H: π - omni-alpha - work")]));
exe(path.join(LB, "hyprctl"), `#!/bin/sh
case "$1 $2" in
  "-j clients") cat ${F("lclients.json")} ;;
  "-j activeworkspace") echo '{"id":72,"name":"72"}' ;;
  "-j "*) echo '[]' ;;
  *) echo "$*" >> ${F("laptop-hypr.log")}; echo ok ;;
esac
`);
for (const t of ["gio", "xdg-open", "notify-send"]) exe(path.join(LB, t), `#!/bin/sh\necho "${t} $*" >> ${F("laptop-open.log")}\n`);
exe(path.join(LB, "wl-paste"), `#!/bin/sh
case "$*" in
  --list-types) cat ${F("clip-types")} ;;
  "--type image/png") cat ${F("clip.png")} ;;
  *text/plain*) cat ${F("clip.txt")} ;;
esac
`);
exe(F("fake-ssh"), `#!/bin/bash
# a stand-in for ssh: the last argument is the remote command, run in the remote home with a clean environment
args=(); for a in "$@"; do [[ $a == -t ]] || args+=("$a"); done
echo "\${args[-1]}" >> ${F("ssh.log")}
cd ${RH} && exec env -i HOME=${RH} PATH=${RB}:${NODEDIR}:/usr/bin:/bin TERM=xterm-256color HYPRPI_DIR=${ROOT} bash -c "\${args[-1]}"
`);
exe(F("world"), `#!/usr/bin/env python3
import json, subprocess, sys
L, cmd = sys.argv[1], sys.argv[2]
open(${JSON.stringify(F("world.log"))}, "a").write(" ".join(sys.argv[1:]) + "\\n")
if cmd == "binding": print(json.dumps({"world": L, "ssh": [${JSON.stringify(F("fake-ssh"))}, "host"]})); sys.exit(0)
if cmd in ("open", "new"):
    name = sys.argv[3] if cmd == "open" else "omni-new"
    p = subprocess.Popen(["python3", "-c", "import time; time.sleep(600)", "/x/omnistation/remote-client.mjs", L, name], start_new_session=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, stdin=subprocess.DEVNULL)
    open(${JSON.stringify(F("pids"))}, "a").write(f"{p.pid}\\n")
    f = ${JSON.stringify(F("lclients.json"))}; cl = json.load(open(f))
    cl.append({"address": "0xn" + str(len(cl)), "pid": p.pid, "class": "hyprpi.h-agent", "title": "x", "workspace": {"id": 72, "name": "72"}, "at": [0, 0], "size": [1, 1]})
    json.dump(cl, open(f, "w")); print(f"opened agent {name} on workspace 72 (world {L})"); sys.exit(0)
sys.exit(2)
`);
exe(F("panels"), `#!/bin/sh\necho "panels $*" >> ${F("laptop-open.log")}\n`);
const LENV = { ...process.env, HOME: LH, PATH: `${LB}:${process.env.PATH}`, HYPRPI_TEST: "1", HYPRPI_ALLOW_HYPR: "1", HYPRPI_TEST_WORLD_CMD: F("world"), HYPRPI_TEST_PANELS_CMD: F("panels"), HYPRPI_RELAY_LOG: F("relay.log"), HYPRPI_REMOTE_WS: "71", TERM: "xterm-256color", XDG_RUNTIME_DIR: T };
for (const k of ["HYPRLAND_INSTANCE_SIGNATURE", "WAYLAND_DISPLAY", "DISPLAY", "HYPRPI_AGENT_ID", "HYPRPI_WORKSPACE", "XDG_CONFIG_HOME", "XDG_STATE_HOME", "HYPRPI_SOCKET", "HYPRPI_STATE", "KITTY_WINDOW_ID"]) delete LENV[k];

// ---- a minimal terminal: where words are on the panel's screen (the panels' own character widths)
class Screen {
  constructor(c, r) { this.c = c; this.r = r; this.x = 0; this.y = 0; this.rest = ""; this.g = Array.from({ length: r }, () => Array(c).fill(" ")); }
  feed(s) {
    s = this.rest + s; this.rest = "";
    const TOK = /\x1b\[([0-9;?<>=:]*)[ -/]*([@-~])|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[^[\]]|[^\x1b]+/y;
    let i = 0;
    while (i < s.length) {
      TOK.lastIndex = i; const m = TOK.exec(s);
      if (!m) { this.rest = s.slice(i); return; }
      i = TOK.lastIndex;
      if (m[2]) this.csi(m[1], m[2]); else if (m[0][0] !== "\x1b") this.text(m[0]);
    }
  }
  csi(p, f) {
    const n = p.split(";").map((x) => Number(x) || 0), row = this.g[this.y];
    if (f === "H" || f === "f") { this.y = Math.max(0, (n[0] || 1) - 1); this.x = Math.max(0, (n[1] || 1) - 1); }
    else if (f === "K" && row) { const [a, b] = n[0] === 1 ? [0, this.x + 1] : n[0] === 2 ? [0, this.c] : [this.x, this.c]; for (let k = a; k < b && k < this.c; k++) row[k] = " "; }
    else if (f === "J" && (n[0] === 2 || n[0] === 3)) this.g = Array.from({ length: this.r }, () => Array(this.c).fill(" "));
    else if (f === "J") { for (let y = this.y; y < this.r; y++) for (let k = y === this.y ? this.x : 0; k < this.c; k++) this.g[y][k] = " "; }
    else if (f === "G") this.x = (n[0] || 1) - 1; else if (f === "d") this.y = (n[0] || 1) - 1;
    else if (f === "C") this.x += n[0] || 1; else if (f === "D") this.x = Math.max(0, this.x - (n[0] || 1));
    else if (f === "A") this.y = Math.max(0, this.y - (n[0] || 1)); else if (f === "B") this.y += n[0] || 1;
    else if (f === "X" && row) for (let k = this.x; k < this.x + (n[0] || 1) && k < this.c; k++) row[k] = " ";
  }
  text(t) {
    for (const g of graphemes(t)) {
      if (g === "\r") { this.x = 0; continue; } if (g === "\n" || g === "\r\n") { this.y++; this.x = g === "\r\n" ? 0 : this.x; continue; }
      if (/^[\x00-\x1f]$/.test(g)) continue;
      const w = gw(g), row = this.g[this.y];
      if (row && this.x < this.c) { row[this.x] = g; if (w === 2 && this.x + 1 < this.c) row[this.x + 1] = ""; }
      this.x += w;
    }
  }
  rowText(y) { return (this.g[y] || []).join(""); }
  dump() { return this.g.map((r) => r.join("").trimEnd()).join("\n"); }
  // -> { x, y } (1-based) of the first cell of str, or null
  find(str, nth = 0) {
    for (let y = 0; y < this.r; y++) {
      let s = ""; const col = [];
      this.g[y].forEach((g, k) => { for (let u = 0; u < g.length; u++) { col.push(k); s += g[u]; } });
      let i = -1; for (let k = 0; k <= nth; k++) { i = s.indexOf(str, i + 1); if (i < 0) break; }
      if (i >= 0) return { x: col[i] + 1, y: y + 1 };
      if (s.includes(str)) nth -= s.split(str).length - 1;
    }
    return null;
  }
}

// ---- the remote daemon (world H) and its agents
const RENV = { HOME: RH, PATH: `${RB}:${NODEDIR}:/usr/bin:/bin`, HYPRPI_STATE: path.join(RW, "state"), HYPRPI_SOCKET: path.join(RW, "run/daemon.sock"), XDG_RUNTIME_DIR: path.join(RW, "run"), HYPRPI_NO_ADOPT: "1", HYPRPI_NO_ENSURE: "1", HYPRPI_UPKEEP_MS: "3600000", TERM: "xterm-256color" };
const d = spawn(process.execPath, [path.join(ROOT, "bin/hyprpi"), "daemon"], { env: RENV, stdio: ["ignore", fs.openSync(F("daemon.log"), "w"), fs.openSync(F("daemon.err"), "w")] });
let panel = null, scr = null;
const clientPids = () => read("pids").split("\n").filter(Boolean).map(Number);
const hyprLog = () => lines("laptop-hypr.log"), openLog = () => lines("laptop-open.log");
const focusOf = (addr) => hyprLog().filter((l) => l.includes("hl.dsp.focus") && l.includes(`address:${addr}`)).length;
const waitFor = async (f, ms = 8000) => { for (let t = 0; t < ms; t += 100) { if (f()) return true; await sleep(100); } return !!f(); };
async function openPanel(kind, cols = 120) {
  scr = new Screen(cols, 34);
  panel = spawn("script", ["-qfc", `stty cols ${cols} rows 34; exec ${path.join(ROOT, "omnistation/panel-loop.sh")} H ${kind} ${F("fake-ssh")} -t host`, "/dev/null"], { env: LENV, stdio: ["pipe", "pipe", "ignore"] });
  panel.stdout.on("data", (b) => scr.feed(b.toString()));
  await sleep(3500);
}
async function closePanel() {
  try { panel.stdin.write("\x11"); } catch { /* gone */ }
  await sleep(800); try { panel.kill(); } catch { /* gone */ } panel = null;
}
const key = async (k, ms = 1200) => { panel.stdin.write(k); await sleep(ms); };
const click = async (at, { ctrl = false, ms = 1500 } = {}) => { const b = ctrl ? 16 : 0; panel.stdin.write(`\x1b[<${b};${at.x};${at.y}M`); await sleep(40); panel.stdin.write(`\x1b[<${b};${at.x};${at.y}m`); await sleep(ms); };
const plain = () => scr.dump();

try {
  for (let i = 0; i < 60 && !fs.existsSync(RENV.HYPRPI_SOCKET); i++) await sleep(200);
  ok("the remote daemon runs", fs.existsSync(RENV.HYPRPI_SOCKET), read("daemon.err").slice(-400));
  process.env.HYPRPI_SOCKET = RENV.HYPRPI_SOCKET; // (this test's own client talks to it)
  const { connect } = await import(path.join(ROOT, "lib/client.mjs"));
  const hello = async (id, name, pid) => { const c = await connect({ path: RENV.HYPRPI_SOCKET, onEvent: () => {} }); await c.call("agent.hello", { agent_id: id, pid, name, want_workspace: 71, cwd: RH }); return c; };
  const alpha = await hello("h-omni-alpha", "omni-alpha", procs[0].pid);
  await hello("h-omni-beta", "omni-beta", procs[1].pid);
  await alpha.call("room.post", { text: "hello see https://example.com/room-link and ask @omni-beta today" });

  // ================= Stream (room) =================
  await openPanel("room", 250); // wide: an agent's long line isn't wrapped (wrapping breaks a printed escape apart)
  const nonce = /HYPRPI_LAPTOP_RELAY=([0-9a-f]+)/.exec(read("ssh.log"))?.[1] || "";
  ok("panel-loop runs the panel through the relay, with a nonce for this run", nonce.length >= 16 && /remote\.sh panel room/.test(read("ssh.log")), read("ssh.log"));
  ok("the Stream shows the message", !!scr.find("room-link"), plain());
  let at = scr.find("https://example.com/room-link");
  if (at) await click(at, { ctrl: true });
  ok("Stream: Ctrl+click on a link → gio open on the laptop", openLog().some((l) => l === "gio open https://example.com/room-link"), openLog().join(" | ") + " / " + read("relay.log"));
  at = scr.find("@omni-beta");
  if (at) await click({ x: at.x + 2, y: at.y }, { ctrl: true, ms: 3000 });
  ok("Stream: Ctrl+click on @omni-beta (no laptop window) → world H open omni-beta", lines("world.log").includes("H open omni-beta"), lines("world.log").join(" | ") + " / " + read("relay.log"));
  ok("… then a jump to the window it opened", await waitFor(() => hyprLog().some((l) => /hl\.dsp\.focus.*address:0xn1/.test(l))), hyprLog().join(" | "));
  at = scr.find("omni-alpha");
  if (at) await click({ x: at.x + 1, y: at.y }, { ctrl: true });
  ok("Stream: Ctrl+click on omni-alpha → a focus dispatch for its laptop window (0xa1)", focusOf("0xa1") >= 1, hyprLog().join(" | ") + " / " + read("relay.log"));
  // an agent prints a request into the Stream. The Stream draws an agent's text as it is, escapes included (see the report), so it
  // reaches the relay whole: with a wrong nonce right after a click it does nothing; with the right nonce (an agent that read it on
  // the machine) it does nothing without a click before it. (After a later click a re-drawn copy would pass the gate: the nonce, the
  // gate and the allow-list are the limits for an agent that deliberately reads the nonce; a machine can write into its own ptys.)
  const req = (o) => `\x1b]5379;hyprpi;${Buffer.from(JSON.stringify(o)).toString("base64")}\x07`;
  const before = openLog().length + hyprLog().length + lines("world.log").length;
  at = scr.find("hello see");
  if (at) await click(at, { ms: 100 });
  await alpha.call("room.post", { text: `and ${req({ act: "open", url: "https://evil.example/b", n: "0".repeat(32) })} there` });
  await sleep(4000); // past the gate
  await alpha.call("room.post", { text: `look ${req({ act: "open", url: "https://evil.example/a", n: nonce })} here` });
  await sleep(2500);
  ok("an unsolicited request printed by an agent does nothing (wrong nonce after a click; right nonce, no click)", openLog().length + hyprLog().length + lines("world.log").length === before && !openLog().some((l) => /evil/.test(l)), openLog().join(" | ") + " / " + read("relay.log"));
  // J543: lib/client.mjs now cuts terminal commands (OSC …) out of daemon strings in a remote panel, so they don't even reach the
  // relay (its nonce and gate checks are covered by test/pty-relay-unit.py)
  ok("… neither reached the relay (the panel cut the escape out of the agent's text)", !/evil/.test(read("relay.log")) && !/"act": "open", "url": "https:\/\/evil/.test(read("relay.log")), read("relay.log"));
  ok("… and never reached the screen", !/5379/.test(plain()), plain());
  await closePanel();

  // ================= Thoughts (search) =================
  await openPanel("search");
  ok("Thoughts shows the thread", !!scr.find("thoughts-link"), plain());
  at = scr.find("https://example.com/thoughts-link");
  if (at) await click(at, { ctrl: true });
  ok("Thoughts: Ctrl+click on a link → gio open on the laptop", openLog().includes("gio open https://example.com/thoughts-link"), openLog().join(" | ") + " / " + read("relay.log"));
  const n0 = openLog().filter((l) => l.includes("thoughts-link")).length;
  if (at) await click({ x: at.x + 5, y: at.y });
  ok("Thoughts: a plain click on a link → the same", openLog().filter((l) => l.includes("thoughts-link")).length === n0 + 1, openLog().join(" | "));
  at = scr.find("~/work/notes.txt");
  if (at) await click(at, { ms: 3000 });
  const copied = path.join(LH, "Downloads/hyprpi-h/notes.txt");
  ok("Thoughts: a click on a remote file → copied to the laptop (~/Downloads/hyprpi-h/) and opened there", fs.existsSync(copied) && fs.readFileSync(copied, "utf8") === "remote notes\n" && openLog().includes(`gio open ${copied}`), openLog().join(" | ") + " / " + read("relay.log"));
  at = scr.find("@omni-alpha");
  const f0 = focusOf("0xa1");
  if (at) await click({ x: at.x + 3, y: at.y }, { ctrl: true });
  ok("Thoughts: Ctrl+click on @omni-alpha → its laptop window", focusOf("0xa1") === f0 + 1, hyprLog().join(" | "));
  at = scr.find("J7 today");
  if (at) await click(at, { ms: 2000 });
  ok("Thoughts: a job link → the laptop's board panel (mockups/panels H --only 4)", openLog().includes("panels H --only 4"), openLog().join(" | ") + " / " + read("relay.log"));
  // paste: an image, then text
  fs.writeFileSync(F("clip-types"), "image/png\n");
  const png = Buffer.from("89504e470d0a1a0a0000000d4948445200000001000000010806000000", "hex");
  fs.writeFileSync(F("clip.png"), png);
  await key("\x16", 3000);
  const clipDir = path.join(RW, "clipboard"), up = fs.existsSync(clipDir) ? fs.readdirSync(clipDir).filter((f) => /^pi-clipboard-[\w-]+\.png$/.test(f)) : [];
  ok("Thoughts: Ctrl+V with an image on the laptop → uploaded to the remote machine (600, the same bytes)", up.length === 1 && fs.readFileSync(path.join(clipDir, up[0])).equals(png) && (fs.statSync(path.join(clipDir, up[0])).mode & 0o777) === 0o600, String(up) + " / " + read("relay.log"));
  ok("… and its remote path is in the box", up.length === 1 && !!scr.find(`~/.hyprpi-h/clipboard/${up[0]}`.slice(0, 60)), plain());
  await key("\r", 2500);
  const th = fs.readFileSync(path.join(RW, "state/thoughts/H.thread.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  ok("… and ⏎ sends it to Thoughts-H as an image", th.some((e) => e.role === "you" && (e.images || []).includes(path.join(clipDir, up[0] || "x"))), JSON.stringify(th.slice(-1)));
  fs.writeFileSync(F("clip-types"), "text/plain;charset=utf-8\ntext/plain\n"); fs.writeFileSync(F("clip.txt"), "pasted words\x1b[201~ok");
  await key("\x16", 2500);
  ok("Thoughts: Ctrl+V with text on the laptop → the text in the box (no escape gets through)", !!scr.find("pasted words") && !!scr.find("[201~ok"), plain());
  const remoteActs = lines("remote-desktop.log");
  await closePanel();

  // ================= Projects (board) =================
  await openPanel("board");
  ok("Projects shows the card", !!scr.find("omniproj"), plain());
  // open the card (⏎ on it) if the item isn't shown yet
  if (!scr.find("board-item")) { await key("\r", 1500); }
  at = scr.find("https://example.com/board-item") || scr.find("https://example.com/board-where");
  const which = at && scr.find("https://example.com/board-item") ? "board-item" : "board-where";
  if (at) await click(at, { ctrl: true });
  ok("Projects: Ctrl+click on a link → gio open on the laptop", openLog().includes(`gio open https://example.com/${which}`), openLog().join(" | ") + " / " + plain());
  at = scr.find("@omni-alpha");
  const f1 = focusOf("0xa1");
  if (at) await click({ x: at.x + 3, y: at.y }, { ctrl: true });
  ok("Projects: Ctrl+click on @omni-alpha → its laptop window", focusOf("0xa1") === f1 + 1, hyprLog().join(" | ") + " / " + plain());
  await closePanel();

  // ================= agents =================
  await openPanel("agents");
  ok("the agents panel lists omni-alpha", !!scr.find("omni-alpha"), plain());
  const f2 = focusOf("0xa1");
  at = scr.find("omni-alpha");
  if (at) await click(at, { ctrl: true });
  ok("agents: Ctrl+click on omni-alpha's row → its laptop window", focusOf("0xa1") === f2 + 1, hyprLog().join(" | ") + " / " + read("relay.log"));
  if (at) { await click(at, { ms: 300 }); await key("\r", 1500); }
  ok("agents: a click on its row, then ⏎ → the same", focusOf("0xa1") === f2 + 2, hyprLog().join(" | ") + " / " + read("relay.log"));
  at = scr.find("omniproj");
  if (at) await click(at, { ctrl: true });
  ok("agents: Ctrl+click on a project row → the laptop's board panel", openLog().filter((l) => l === "panels H --only 4").length === 2, openLog().join(" | "));
  const f3 = focusOf("0xa1");
  await key("/go @omni-alpha", 300); await key("\r", 1500);
  ok("agents: /go @omni-alpha ⏎ → its laptop window", focusOf("0xa1") === f3 + 1, hyprLog().join(" | ") + " / " + read("relay.log"));
  await key("/room", 300); await key("\r", 1500);
  ok("agents: /room ⏎ → the laptop's Stream panel", openLog().includes("panels H --only 2"), openLog().join(" | ") + " / " + read("relay.log"));
  await key("\x0e", 3000);
  ok("agents: Ctrl+N → world H new on the laptop", lines("world.log").includes("H new"), lines("world.log").join(" | ") + " / " + read("relay.log"));
  const pn = clientPids().at(-1);
  await hello("h-omni-new", "omni-new", pn); // the new agent starts on the machine
  ok("… and the jump to it once it's listed (allowed once, no click needed)", await waitFor(() => hyprLog().some((l) => /hl\.dsp\.focus.*address:0xn2/.test(l)), 6000), hyprLog().join(" | ") + " / " + read("relay.log"));
  await closePanel();

  ok("nothing was done on the remote machine's desktop (no hyprctl action, gio, xdg-open, wl-paste there)", !remoteActs.length && !lines("remote-desktop.log").length, read("remote-desktop.log"));
} finally {
  if (panel) await closePanel();
  d.kill("SIGTERM"); for (const p of procs) p.kill(); for (const p of clientPids()) { try { process.kill(p); } catch { /* gone */ } }
  await sleep(400);
  if ((fails && process.env.KEEP) || process.env.KEEP === "always") console.log("kept " + T); else fs.rmSync(T, { recursive: true, force: true });
}
console.log(fails ? `remote-panel-laptop: ${fails} FAILED` : "remote-panel-laptop: all pass");
process.exit(fails ? 1 : 0);
