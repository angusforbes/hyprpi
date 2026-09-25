#!/usr/bin/env node
// MOCKUP: a terminal / tmux-style hyprpi room, for comparison with the
// Quickshell room window (ui/RoomWindow.qml), which stays the real one.
// Live data from the daemon. Typing + Enter posts to the room as Angus (same
// as the room window). Keys: Tab / Shift+Tab switch room · Ctrl+N (or
// "/new [DIR]") opens a new agent · wheel / ↑↓ / PgUp PgDn / Home End scroll
// the conversation · Shift+drag selects text · Ctrl+C quits.
//
//   kitty --class hyprpi.mockup node ~/Work/hyprpi/mockups/room-tui.mjs [ROOM]
// No ROOM = the current world's room. Several copies can run at once, on the
// same room or different ones: each is just another subscriber of the daemon.
import { connect } from "../lib/client.mjs";

const ESC = "\x1b[";
const out = (s) => process.stdout.write(s);
// World colours: exactly the bar's (agf.hyprwrlds BarWidget.qml paletteKeys),
// read from the Omarchy theme's colors.toml, re-read when the theme changes.
import fs from "node:fs";
const COLORS = `${process.env.HOME}/.local/state/omarchy/current/theme/colors.toml`;
const PALETTE = [["blue", "color4"], ["red", "color1"], ["cyan", "color6"], ["yellow", "color3"], ["magenta", "color5"], ["green", "color2"], ["orange", "color11"], ["brown", "color9"], ["foreground", "color7"]];
let theme = {};
function loadTheme() {
  theme = {};
  try { for (const l of fs.readFileSync(COLORS, "utf8").split("\n")) { const m = l.match(/^\s*([A-Za-z0-9_-]+)\s*=\s*["']?#([0-9A-Fa-f]{6})/); if (m) theme[m[1]] = m[2]; } } catch { /* ANSI fallback */ }
}
loadTheme();
try { fs.watchFile(COLORS, { interval: 2000 }, () => { loadTheme(); render(); }); } catch { /* fine */ }
const rgb = (hex) => { const n = parseInt(hex, 16); return `${n >> 16};${(n >> 8) & 255};${n & 255}`; };
function worldHex(room) {
  const i = "ABCDEFGHI".indexOf(String(room)[0]);
  for (const k of PALETTE[Math.max(0, i) % PALETTE.length]) if (theme[k]) return theme[k];
  return null;
}
const worldFg = (room) => { const h = worldHex(room); return h ? `38;2;${rgb(h)}` : "34"; };
const worldBg = (room) => { const h = worldHex(room); return h ? `48;2;${rgb(h)}` : "44"; };
const dim = (s) => `${ESC}2m${s}${ESC}22m`;
const bold = (s) => `${ESC}1m${s}${ESC}22m`;
const fg = (c, s) => `${ESC}${c}m${s}${ESC}39m`;
const hexFg = (hex, s) => { const m = /^#?([0-9a-f]{6})$/i.exec(hex || ""); if (!m) return s; const n = parseInt(m[1], 16); return `${ESC}38;2;${n >> 16};${(n >> 8) & 255};${n & 255}m${s}${ESC}39m`; };

// Display width (emoji / CJK = 2, combining / ZWJ / VS = 0), enough for names and chat.
function cw(cp) {
  if (cp === 0x200d || (cp >= 0xfe00 && cp <= 0xfe0f) || (cp >= 0x300 && cp <= 0x36f)) return 0;
  if ((cp >= 0x1f300 && cp <= 0x1faff) || (cp >= 0x2600 && cp <= 0x27bf && cp !== 0x2713 && cp !== 0x2715) || (cp >= 0x1100 && cp <= 0x115f) || (cp >= 0x2e80 && cp <= 0xa4cf) || (cp >= 0xac00 && cp <= 0xd7a3) || (cp >= 0xf900 && cp <= 0xfaff) || (cp >= 0xff00 && cp <= 0xff60)) return 2;
  return 1;
}
const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");
const width = (s) => { let w = 0; for (const ch of strip(s)) w += cw(ch.codePointAt(0)); return w; };
function cut(s, n) { let w = 0, r = ""; for (const ch of s) { const c = cw(ch.codePointAt(0)); if (w + c > n) return r + "…"; w += c; r += ch; } return r; }
// Cut a styled line to n columns, keeping its escape codes intact.
function clip(s, n) {
  let w = 0, r = "";
  for (const part of s.split(/(\x1b\[[0-9;?]*[A-Za-z])/)) {
    if (part.startsWith("\x1b")) { r += part; continue; }
    for (const ch of part) { const c = cw(ch.codePointAt(0)); if (w + c > n) return r + `${ESC}0m`; w += c; r += ch; }
  }
  return r;
}
const pad = (s, n) => s + " ".repeat(Math.max(0, n - width(s)));
function wrap(text, n) {
  const lines = [];
  for (const para of String(text).split("\n")) {
    let line = "", lw = 0;
    for (const word of para.split(/(\s+)/)) {
      const ww = width(word);
      if (lw + ww > n && line.trim()) { lines.push(line.trimEnd()); line = ""; lw = 0; if (/^\s+$/.test(word)) continue; }
      if (ww > n) { for (const ch of word) { const c = cw(ch.codePointAt(0)); if (lw + c > n) { lines.push(line); line = ""; lw = 0; } line += ch; lw += c; } continue; }
      line += word; lw += ww;
    }
    lines.push(line.trimEnd());
  }
  return lines;
}
const hhmm = (ts) => { const d = new Date(ts); return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`; };
const home = (p) => String(p || "").replace(/^\/home\/[^/]+/, "~");

let scroll = 0, lastConvoLen = 0, lastAvail = 10; // scroll = lines up from the newest
let agents = [], rooms = [], room = (process.argv[2] || "").toUpperCase(), messages = {}, input = "", note = "", online = false;
let api = null;

function mark(a) {
  // Same marks as the room window: ● working · ✓ done (unseen) · × blocked · ○ idle
  if (a.status === "working") return "●";
  if (a.status === "blocked") return "×";
  if (a.status === "done" && !a.seen) return "✓";
  return "○";
}

function render() {
  const W = process.stdout.columns || 100, H = process.stdout.rows || 30;
  const c = worldFg(room);
  const here = agents.filter((a) => a.room === room);
  const rule = (label = "") => fg(c, "─" + (label ? ` ${label} ` : "") + "─".repeat(Math.max(0, W - 1 - (label ? width(label) + 2 : 0))));
  const rows = [];

  // Agents pane
  rows.push(rule(`agents · room ${room}`));
  // "special:reprieve" -> "reprieve": only the part after the last ":".
  const wsl = (a) => String(a.workspace_label || "").replace(/^.*:/, "");
  const wsW = Math.min(12, Math.max(2, ...here.map((a) => width(wsl(a)))));
  const nameW = Math.min(24, Math.max(8, ...here.map((a) => width(((a.icon ? a.icon + " " : "") + a.display)))));
  if (!here.length) rows.push(dim("  no agents here · SUPER+A opens one"));
  for (const a of here) {
    const name = (a.icon ? a.icon + " " : "") + a.display;
    const st = a.status === "done" && a.seen ? "idle" : a.status;
    const extra = W < 72 ? "" : " " + dim(pad(cut(wsl(a), wsW), wsW + 1) + pad((a.model || "").replace(/^claude-/, ""), 12) + " " + home(a.cwd));
    const line = ` ${fg(c, bold(mark(a)))} ${pad(hexFg(a.color, bold(cut(name, nameW))), nameW)}  ${pad(st, 8)}${W < 72 ? dim(wsl(a)) : extra}`;
    rows.push(a.focused ? `${ESC}7m${pad(strip(line), W)}${ESC}27m` : line);
  }

  // Conversation pane: fill what's left, newest at the bottom.
  rows.push(rule(scroll > 0 ? `room · ↓ ${scroll} more line${scroll === 1 ? "" : "s"} below (End)` : "room"));
  const bottom = 3; // input rule + input + status bar
  const avail = Math.max(1, H - rows.length - bottom);
  // Wide: "hh:mm  who  text" columns (irssi/weechat). Narrow: who on its own line.
  const narrow = W < 72, whoW = narrow ? W - 8 : 14, textW = narrow ? W - 3 : Math.max(10, W - 7 - whoW - 2);
  const convo = [];
  for (const m of messages[room] || []) {
    const au = m.author || {};
    const who = au.kind === "human" ? fg(c, bold(cut(au.name || "Angus", whoW))) : hexFg(au.color, bold(cut((au.icon ? au.icon + " " : "") + (au.name || "agent"), whoW)));
    if (narrow) {
      if (convo.length) convo.push("");
      convo.push(` ${who} ${dim(hhmm(m.ts))}`);
      for (const l of wrap(m.text, textW)) convo.push(`   ${l}`);
    } else wrap(m.text, textW).forEach((l, i) => convo.push(i === 0 ? ` ${dim(hhmm(m.ts))} ${pad(who, whoW)}  ${l}` : ` ${" ".repeat(5)} ${" ".repeat(whoW)}  ${l}`));
  }
  // Scrolled up: stay on the same lines when new ones arrive below.
  if (scroll > 0 && convo.length > lastConvoLen) scroll += convo.length - lastConvoLen;
  lastConvoLen = convo.length; lastAvail = avail;
  scroll = Math.max(0, Math.min(scroll, convo.length - avail));
  const shown = convo.slice(Math.max(0, convo.length - avail - scroll), convo.length - scroll);
  if (!convo.length) shown.push(dim("  (no messages yet)"));
  while (shown.length < avail) shown.unshift("");
  rows.push(...shown);

  // Input line
  rows.push(fg(c, "─".repeat(W)));
  const prompt = fg(c, bold(`${room} ❯ `));
  const hint = input ? "" : dim(note || (W < 72 ? "message the room" : "message the room · Tab: next room · ^N or /new [dir]: new agent"));
  rows.push(prompt + input + hint);

  // tmux-style status bar
  const tabs = rooms.map((r) => r.id === room ? `${ESC}${worldBg(r.id)};30m ${r.id} ${ESC}49;39m` : ` ${fg(worldFg(r.id), r.id)} `).join("");
  const left = ` hyprpi ${online ? "" : "· daemon offline "}`;
  const right = `${here.length} agent${here.length === 1 ? "" : "s"} · ${hhmm(Date.now())} `;
  const mid = W - width(left) - width(strip(tabs)) - width(right);
  rows.push(`${ESC}7m${left}${ESC}27m${tabs}${ESC}7m${" ".repeat(Math.max(0, mid))}${right}${ESC}27m`);

  out(`\x1b]2;hyprpi tui · room ${room}\x07`); // not "hyprpi room …": the daemon treats those titles as room windows
  out(`${ESC}?25l${ESC}H` + rows.slice(0, H).map((r) => clip(r, W) + `${ESC}0m${ESC}K`).join("\r\n") + `${ESC}J`);
  // cursor at end of input
  out(`${ESC}${H - 1};${width(prompt) + width(input) + 1}H${ESC}?25h`);
}

async function loadRoom(r) {
  if (!api || !r) return;
  try { const res = await api.call("room.read", { room: r, tail: true, limit: 200 }); messages[r] = res.messages || []; } catch { /* keep old */ }
  render();
}

function applyList(r) {
  agents = r.agents || []; rooms = r.rooms || [];
  if (!room) room = r.active_room || rooms[0]?.id || "A";
  if (!rooms.find((x) => x.id === room)) rooms = [...rooms, { id: room }].sort((a, b) => a.id.localeCompare(b.id));
  render();
}

async function start() {
  try {
    api = await connect({
      onEvent: (ev, data) => {
        if (ev === "agents") applyList(data);
        else if (ev === "message" && data?.room) { (messages[data.room] ||= []).push(data); if (data.room === room) render(); }
      },
      onClose: () => { online = false; api = null; render(); setTimeout(start, 1500); },
    });
    online = true;
    applyList(await api.call("ui.subscribe", { windows: false }));
    await loadRoom(room);
  } catch { online = false; render(); setTimeout(start, 1500); }
}

function cycle(d) {
  if (!rooms.length) return;
  const i = rooms.findIndex((r) => r.id === room);
  room = rooms[(i + d + rooms.length) % rooms.length].id;
  note = ""; scroll = 0; lastConvoLen = 0; render(); loadRoom(room);
}

// New agent: Ctrl+N, or "/new [DIR]" in the input line. Opens on the current
// workspace (where this TUI is), in DIR or the config's default folder.
import { spawn } from "node:child_process";
import { loadConfig } from "../lib/paths.mjs";
function newAgent(dir) {
  const cwd = (dir || loadConfig().cwd).replace(/^~(?=$|\/)/, process.env.HOME);
  if (!fs.existsSync(cwd)) { note = "✗ no such folder: " + cwd; return render(); }
  const env = { ...process.env }; delete env.HYPRPI_AGENT_ID;
  spawn(new URL("../bin/hyprpi", import.meta.url).pathname, ["new", "--cwd", cwd], { detached: true, stdio: "ignore", env }).unref();
  note = "opening a new agent in " + home(cwd) + " …"; render();
}

async function send() {
  const text = input.trim(); input = "";
  const cmd = /^\/new(?:\s+(.+))?$/.exec(text);
  if (cmd) return newAgent(cmd[1]?.trim());
  if (!text || !api) return render();
  try {
    const r = await api.call("room.post", { room, text, as_human: true, via: "room-tui" });
    note = r.delivered?.length ? "→ " + r.delivered.join(", ") : "saved · no agents in this room yet";
  } catch (e) { note = "✗ " + e.message; }
  render();
}

process.stdin.setRawMode?.(true);
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => {
  if (d === "\x03") return quit();
  if (d === "\t") return cycle(1);
  if (d === "\x1b[Z") return cycle(-1);
  if (d === "\r") return send();
  if (d === "\x7f" || d === "\b") { input = [...input].slice(0, -1).join(""); return render(); }
  if (d === "\x15") { input = ""; return render(); } // Ctrl+U
  if (d === "\x0e") return newAgent(); // Ctrl+N
  // Scrolling: mouse wheel (SGR mouse reports), ↑/↓ line, PgUp/PgDn page, Home/End.
  if (d.startsWith("\x1b[<")) {
    for (const m of d.matchAll(/\x1b\[<(\d+);\d+;\d+[Mm]/g)) { const b = Number(m[1]); if (b === 64) scroll += 3; else if (b === 65) scroll -= 3; }
    return render();
  }
  const page = Math.max(1, lastAvail - 2);
  const keys = { "\x1b[A": 1, "\x1b[B": -1, "\x1b[5~": page, "\x1b[6~": -page, "\x1b[H": Infinity, "\x1b[1~": Infinity, "\x1b[F": -Infinity, "\x1b[4~": -Infinity };
  if (d in keys) { scroll = keys[d] === Infinity ? 1e9 : keys[d] === -Infinity ? 0 : scroll + keys[d]; if (scroll < 0) scroll = 0; return render(); }
  if (d.startsWith("\x1b")) return; // other keys: ignore in the mockup
  input += d.replace(/[\x00-\x1f]/g, ""); note = ""; render();
});
function quit() { out(`${ESC}?1000l${ESC}?1006l${ESC}?1049l${ESC}?25h`); process.exit(0); }
process.on("SIGTERM", quit);
process.stdout.on("resize", render);
setInterval(render, 30000); // clock
out(`${ESC}?1049h${ESC}?1000h${ESC}?1006h`); // alt screen + mouse wheel (Shift+drag still selects text)
render();
start();
