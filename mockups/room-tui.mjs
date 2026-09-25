#!/usr/bin/env node
// MOCKUP: a terminal / tmux-style hyprpi room, for comparison with the
// Quickshell room window (ui/RoomWindow.qml), which stays the real one.
// Live data from the daemon. Typing + Enter posts to the room as Angus (same
// as the room window). Agent list: ↑↓ or click = cursor · Enter on an empty
// line = jump to it · Space / second click = mark (Enter then sends only to the
// marked agents; Esc unmarks, Ctrl+A all) · Ctrl+W close · Ctrl+K kill (press
// twice). Conversation: wheel, Shift+↑↓, PgUp/PgDn, Home/End. Keys: Tab / Shift+Tab switch room · Ctrl+N (or
// "/new [DIR]") opens a new agent · wheel / ↑↓ / PgUp PgDn / Home End scroll
// the conversation · click-drag selects + copies text · Ctrl+C quits.
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
  // Emoji that draw as emoji by default are 2 wide; text symbols like ❯ ✓ × ● are 1.
  if (/\p{Emoji_Presentation}/u.test(String.fromCodePoint(cp))) return 2;
  if ((cp >= 0x1100 && cp <= 0x115f) || (cp >= 0x2e80 && cp <= 0xa4cf) || (cp >= 0xac00 && cp <= 0xd7a3) || (cp >= 0xf900 && cp <= 0xfaff) || (cp >= 0xff00 && cp <= 0xff60)) return 2;
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
// Agent list: cursor (by id), marked ids (multi-select recipients), list scroll,
// and where the rows landed on screen (for mouse clicks).
let cursorId = "", marked = new Set(), listTop = 0, listRowY = 0, listRows = 0, convoY = 0, confirm = null;
const hereAgents = () => agents.filter((a) => a.room === room);
let agents = [], rooms = [], room = (process.argv[2] || "").toUpperCase(), messages = {}, input = "", note = "", online = false;
let api = null;

function mark(a) {
  // Same marks as the room window: ● working · ✓ done (unseen) · × blocked · ○ idle
  if (a.status === "working") return "●";
  if (a.status === "blocked") return "×";
  if (a.status === "done" && !a.seen) return "✓";
  return "○";
}

// ---- click-drag text selection (the TUI owns the mouse, so it selects itself)
let screen = [], sel = null; // sel: { x0, y0, x1, y1, dragging } in 1-based cells
function selRange() {
  if (!sel || (sel.x0 === sel.x1 && sel.y0 === sel.y1)) return null;
  const fwd = sel.y0 < sel.y1 || (sel.y0 === sel.y1 && sel.x0 <= sel.x1);
  return fwd ? { y0: sel.y0, x0: sel.x0, y1: sel.y1, x1: sel.x1 } : { y0: sel.y1, x0: sel.x1, y1: sel.y0, x1: sel.x0 };
}
// Cells a..b (1-based, inclusive) of a plain line.
function sliceCols(t, a, b) {
  let col = 1, r = "";
  for (const ch of t) { const w = cw(ch.codePointAt(0)); if (col >= a && col + w - 1 <= b) r += ch; col += w; if (col > b) break; }
  return r;
}
function selectedText() {
  const sr = selRange(); if (!sr) return "";
  const W = process.stdout.columns || 100, out = [];
  for (let y = sr.y0; y <= sr.y1; y++) out.push(sliceCols(screen[y - 1] || "", y === sr.y0 ? sr.x0 : 1, y === sr.y1 ? sr.x1 : W).trimEnd());
  return out.join("\n");
}
function copy(text) {
  if (!text) return;
  // OSC 52 (kitty puts it on the clipboard) and wl-copy as a fallback.
  process.stdout.write(`\x1b]52;c;${Buffer.from(text).toString("base64")}\x07`);
  try { const p = spawn("wl-copy", [], { stdio: ["pipe", "ignore", "ignore"] }); p.on("error", () => {}); p.stdin.end(text); } catch { /* OSC 52 only */ }
  note = `copied ${text.length} character${text.length === 1 ? "" : "s"}`;
}

let batching = false, dirty = false;
function render() { if (batching) { dirty = true; return; } draw(); }
function draw() {
  dirty = false;
  const W = process.stdout.columns || 100, H = process.stdout.rows || 30;
  const c = worldFg(room);
  const here = agents.filter((a) => a.room === room);
  const rule = (label = "") => fg(c, "─" + (label ? ` ${label} ` : "") + "─".repeat(Math.max(0, W - 1 - (label ? width(label) + 2 : 0))));
  const rows = [];

  // Agents pane: scrolls when there are more agents than ~40% of the height.
  if (!here.find((a) => a.id === cursorId)) cursorId = here[0]?.id || "";
  for (const id of marked) if (!here.find((a) => a.id === id)) marked.delete(id);
  const cur = Math.max(0, here.findIndex((a) => a.id === cursorId));
  const maxList = Math.max(3, Math.floor((H - 6) * 0.4));
  listRows = Math.min(here.length, maxList);
  if (cur < listTop) listTop = cur;
  if (cur >= listTop + listRows) listTop = cur - listRows + 1;
  listTop = Math.max(0, Math.min(listTop, here.length - listRows));
  const more = here.length - listRows;
  rows.push(rule(`agents · room ${room}` + (more > 0 ? ` · ${listTop ? "↑" + listTop + " " : ""}${here.length - listTop - listRows ? "↓" + (here.length - listTop - listRows) : ""}` : "") + (marked.size ? ` · ${marked.size} marked` : "")));
  listRowY = rows.length + 1; // 1-based screen row of the first agent row
  // "special:reprieve" -> "reprieve": only the part after the last ":".
  const wsl = (a) => String(a.workspace_label || "").replace(/^.*:/, "");
  const wsW = Math.min(12, Math.max(2, ...here.map((a) => width(wsl(a)))));
  const nameW = Math.min(24, Math.max(8, ...here.map((a) => width(((a.icon ? a.icon + " " : "") + a.display)))));
  if (!here.length) rows.push(dim("  no agents here · SUPER+A opens one"));
  for (const a of here.slice(listTop, listTop + listRows)) {
    const name = (a.icon ? a.icon + " " : "") + a.display;
    const st = a.status === "done" && a.seen ? "idle" : a.status;
    const extra = W < 72 ? "" : " " + dim(pad(cut(wsl(a), wsW), wsW + 1) + pad((a.model || "").replace(/^claude-/, ""), 12) + " " + home(a.cwd));
    const sel = marked.has(a.id) ? fg(c, bold("▸")) : " ";
    const line = `${sel}${fg(c, bold(mark(a)))} ${pad(hexFg(a.color, bold(cut(name, nameW))), nameW)}  ${pad(st, 8)}${W < 72 ? dim(wsl(a)) : extra}`;
    // Cursor row: inverted. The focused window's agent: underlined name column.
    rows.push(a.id === cursorId ? `${ESC}7m${pad(strip(line), W)}${ESC}27m` : a.focused ? `${ESC}4m${line}${ESC}24m` : line);
  }

  // Conversation pane: fill what's left, newest at the bottom.
  convoY = rows.length + 2;
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
  const to = [...marked].map((id) => agents.find((a) => a.id === id)?.display).filter(Boolean);
  const prompt = fg(c, bold(to.length ? `${room} → ${cut(to.join(", "), Math.max(10, Math.floor(W / 3)))} ❯ ` : `${room} ❯ `));
  const hint = input ? "" : dim(confirm ? confirm.label : note || (W < 72 ? "message the room" : (confirm ? confirm.label : "message the room · ↑↓ agent · ⏎ jump · space mark · ^W close · ^K kill · ^N new · Tab room")));
  rows.push(prompt + input + hint);

  // tmux-style status bar
  const tabs = rooms.map((r) => r.id === room ? `${ESC}${worldBg(r.id)};30m ${r.id} ${ESC}49;39m` : ` ${fg(worldFg(r.id), r.id)} `).join("");
  const left = ` hyprpi ${online ? "" : "· daemon offline "}`;
  const right = `${here.length} agent${here.length === 1 ? "" : "s"} · ${hhmm(Date.now())} `;
  const mid = W - width(left) - width(strip(tabs)) - width(right);
  rows.push(`${ESC}7m${left}${ESC}27m${tabs}${ESC}7m${" ".repeat(Math.max(0, mid))}${right}${ESC}27m`);

  out(`\x1b]2;hyprpi tui · room ${room}\x07`); // not "hyprpi room …": the daemon treats those titles as room windows
  const lines = rows.slice(0, H).map((r) => clip(r, W));
  screen = lines.map(strip);
  // Drag selection: redraw the selected cells of each line inverted.
  const sr = selRange();
  const shown2 = lines.map((l, i) => {
    if (!sr || i + 1 < sr.y0 || i + 1 > sr.y1) return l;
    const a = i + 1 === sr.y0 ? sr.x0 : 1, b = i + 1 === sr.y1 ? sr.x1 : W;
    const t = screen[i];
    return sliceCols(t, 1, a - 1) + `${ESC}7m` + sliceCols(t, a, b) + `${ESC}27m` + sliceCols(t, b + 1, W);
  });
  out(`${ESC}?25l${ESC}H` + shown2.map((l) => l + `${ESC}0m${ESC}K`).join("\r\n") + `${ESC}J`);
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
  note = ""; scroll = 0; lastConvoLen = 0; marked.clear(); cursorId = ""; listTop = 0; confirm = null; render(); loadRoom(room);
}

// New agent: Ctrl+N, or "/new [DIR]" in the input line. Opens on the current
// workspace (where this TUI is), in DIR or the config's default folder.
import { spawn } from "node:child_process";
import { loadConfig } from "../lib/paths.mjs";
let lastNew = 0;
function newAgent(dir) {
  if (Date.now() - lastNew < 2000) return; // held / repeated Ctrl+N: one agent
  lastNew = Date.now();
  const cwd = (dir || loadConfig().cwd).replace(/^~(?=$|\/)/, process.env.HOME);
  if (!fs.existsSync(cwd)) { note = "✗ no such folder: " + cwd; return render(); }
  const env = { ...process.env }; delete env.HYPRPI_AGENT_ID;
  spawn(new URL("../bin/hyprpi", import.meta.url).pathname, ["new", "--cwd", cwd], { detached: true, stdio: "ignore", env }).unref();
  note = "opening a new agent in " + home(cwd) + " …"; render();
}

// Close (window close: Pi exits normally) or kill (SIGTERM, then SIGKILL) the
// agent under the cursor; both ask for a second press within 3 s.
import * as hypr from "../lib/hypr.mjs";
function act(kind) {
  const a = agents.find((x) => x.id === cursorId);
  if (!a) return;
  if (!confirm || confirm.kind !== kind || confirm.id !== a.id || Date.now() > confirm.until) {
    confirm = { kind, id: a.id, until: Date.now() + 3000, label: `${kind === "close" ? "close" : "KILL"} ${a.display}? press ^${kind === "close" ? "W" : "K"} again` };
    setTimeout(() => { if (confirm && Date.now() > confirm.until) { confirm = null; render(); } }, 3100);
    return render();
  }
  confirm = null;
  if (kind === "close") {
    if (!a.address) { note = "✗ no window for " + a.display; return render(); }
    hypr.closeWindow(a.address).then(() => { note = "closed " + a.display; render(); }).catch((e) => { note = "✗ " + e.message; render(); });
  } else {
    try { process.kill(a.pid, "SIGTERM"); note = "killed " + a.display; } catch (e) { note = "✗ " + e.message; }
    setTimeout(() => { try { process.kill(a.pid, 0); process.kill(a.pid, "SIGKILL"); } catch { /* gone */ } }, 2000);
  }
  render();
}
function moveCursor(d) {
  const here = hereAgents();
  if (!here.length) return;
  const i = Math.max(0, here.findIndex((a) => a.id === cursorId));
  cursorId = here[Math.max(0, Math.min(here.length - 1, i + d))].id;
  confirm = null; render();
}

async function send() {
  const text = input.trim(); input = "";
  const cmd = /^\/new(?:\s+(.+))?$/.exec(text);
  if (cmd) return newAgent(cmd[1]?.trim());
  if (!text && !api) return render();
  if (!text) { // Enter on an empty line: jump to the agent under the cursor
    if (cursorId && api) api.call("agent.focus", { agent: cursorId }).catch((e) => { note = "✗ " + e.message; render(); });
    return render();
  }
  if (!api) return render();
  // Marked agents (space), or leading @Name tokens, get it directly (not the room).
  let targets = [...marked], body = text;
  const at = text.match(/^((?:@\S+[\s,]+)+)([\s\S]+)$/);
  if (!targets.length && at) { targets = at[1].split(/[\s,]+/).filter((x) => x.length > 1).map((x) => x.slice(1)); body = at[2]; }
  if (targets.length) {
    const sent = [], failed = [];
    await Promise.all(targets.map((who) => api.call("agent.prompt", { agent: who, text: body, via: "room-tui" })
      .then((r) => sent.push(r.name || who)).catch((e) => failed.push(`${who} (${e.message})`))));
    note = (sent.length ? "→ sent to " + sent.join(", ") : "") + (failed.length ? "  ✗ " + failed.join(", ") : "");
    return render();
  }
  try {
    const r = await api.call("room.post", { room, text, as_human: true, via: "room-tui" });
    note = r.delivered?.length ? "→ " + r.delivered.join(", ") : "saved · no agents in this room yet";
  } catch (e) { note = "✗ " + e.message; }
  render();
}

process.stdin.setRawMode?.(true);
process.stdin.setEncoding("utf8");
// Input arrives in chunks (held keys, pastes): split into single keys first.
const KEY = /\x1b\[<[\d;]+[Mm]|\x1b\[[\d;]*[A-Za-z~]|\x1bO[A-Za-z]|\x1b|[\s\S]/gu;
process.stdin.on("data", (chunk) => { batching = true; try { for (const [k] of String(chunk).matchAll(KEY)) onKey(k); } finally { batching = false; if (dirty) draw(); } });
function onKey(d) {
  if (sel && !d.startsWith("\x1b[<")) { sel = null; dirty = true; }
  if (d === "\x03") return quit();
  if (d === "\t") return cycle(1);
  if (d === "\x1b[Z") return cycle(-1);
  if (d === "\r") return send();
  if (d === "\x7f" || d === "\b") { input = [...input].slice(0, -1).join(""); return render(); }
  if (d === "\x15") { input = ""; return render(); } // Ctrl+U
  if (d === "\x0e") return newAgent(); // Ctrl+N
  // Scrolling: mouse wheel (SGR mouse reports), ↑/↓ line, PgUp/PgDn page, Home/End.
  if (d.startsWith("\x1b[<")) {
    for (const m of d.matchAll(/\x1b\[<(\d+);(\d+);(\d+)([Mm])/g)) {
      const b = Number(m[1]), x = Number(m[2]), y = Number(m[3]);
      const inList = y >= listRowY && y < listRowY + listRows;
      // Left button: press starts a possible selection, motion drags it,
      // release copies it (or, without a drag, counts as a click).
      if (b === 0 && m[4] === "M") { sel = { x0: x, y0: y, x1: x, y1: y, dragging: false }; continue; }
      if (b === 32 && sel) { sel.x1 = x; sel.y1 = y; sel.dragging = true; continue; }
      if (b === 0 && m[4] === "m" && sel) {
        sel.x1 = x; sel.y1 = y;
        if (sel.dragging && selRange()) { copy(selectedText()); continue; } // highlight stays until the next key or click
        sel = null;
        if (inList) { // plain click: cursor there; click again: mark / unmark
          const a = hereAgents()[listTop + y - listRowY];
          if (a) { if (a.id === cursorId) marked.has(a.id) ? marked.delete(a.id) : marked.add(a.id); cursorId = a.id; confirm = null; }
        }
        continue;
      }
      if (b === 64 || b === 65) { // wheel: agent list or conversation, whichever is under the pointer
        if (inList) { listTop = Math.max(0, listTop + (b === 64 ? -1 : 1)); const here = hereAgents(); const i = here.findIndex((a) => a.id === cursorId); if (i < listTop) cursorId = here[listTop]?.id || cursorId; else if (i >= listTop + listRows) cursorId = here[listTop + listRows - 1]?.id || cursorId; }
        else scroll += b === 64 ? 3 : -3;
      }
    }
    return render();
  }
  if (d === "\x1b[A") return moveCursor(-1);
  if (d === "\x1b[B") return moveCursor(1);
  if (d === "\x1b") { marked.clear(); confirm = null; note = ""; return render(); } // Esc: unmark all
  if (d === " " && !input) { if (cursorId) marked.has(cursorId) ? marked.delete(cursorId) : marked.add(cursorId); moveCursor(1); return; }
  if (d === "\x17") return act("close"); // Ctrl+W
  if (d === "\x0b") return act("kill");  // Ctrl+K
  if (d === "\x01") { const here = hereAgents(); if (marked.size === here.length) marked.clear(); else here.forEach((a) => marked.add(a.id)); return render(); } // Ctrl+A
  const page = Math.max(1, lastAvail - 2);
  const keys = { "\x1b[1;2A": 1, "\x1b[1;2B": -1, "\x1b[5~": page, "\x1b[6~": -page, "\x1b[H": Infinity, "\x1b[1~": Infinity, "\x1b[F": -Infinity, "\x1b[4~": -Infinity };
  if (d in keys) { scroll = keys[d] === Infinity ? 1e9 : keys[d] === -Infinity ? 0 : scroll + keys[d]; if (scroll < 0) scroll = 0; return render(); }
  if (d.startsWith("\x1b")) return; // other keys: ignore in the mockup
  input += d.replace(/[\x00-\x1f]/g, ""); note = ""; render();
}
function quit() { out(`${ESC}?1002l${ESC}?1000l${ESC}?1006l${ESC}?1049l${ESC}?25h`); process.exit(0); }
process.on("SIGTERM", quit);
process.stdout.on("resize", render);
setInterval(render, 30000); // clock
out(`${ESC}?1049h${ESC}?1000h${ESC}?1002h${ESC}?1006h`); // alt screen + mouse (wheel, click, drag-select)
render();
start();
