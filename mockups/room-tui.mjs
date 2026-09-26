#!/usr/bin/env node
// MOCKUP: a terminal / tmux-style hyprpi room, for comparison with the
// Quickshell room window (ui/RoomWindow.qml), which stays the real one.
// Live data from the daemon. The room pane is a stream: messages plus agent activity
// (tools, topics, talk between agents); Ctrl+F cycles all / messages + topics / messages / activity.
// Typing + Enter posts to the room as Angus (same
// as the room window). Agent list: ↑↓ or click = cursor · Enter on an empty
// line = jump to it · Space / second click = mark (Enter then sends only to the
// marked agents; Esc unmarks, Ctrl+A all) · Ctrl+W close · Ctrl+K kill (press
// twice). Conversation: wheel, Shift+↑↓, PgUp/PgDn, Home/End. Keys: Tab / Shift+Tab switch room · Ctrl+N (or
// "/new [DIR]") opens a new agent · wheel / ↑↓ / PgUp PgDn / Home End scroll
// the conversation · drag selects + copies message text, Shift+click/drag whole messages · Ctrl+C quits.
//
//   ~/Work/hyprpi/mockups/room-tui [ROOM]   (kitty launcher with the mouse settings)
// Shift+click/drag reach the TUI there; Ctrl+Shift+drag is kitty's own selection.
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
// herdr-name markup "{#f7768e}S{#ff9e64}p…": each part in its own colour
// (text before the first tag in the fallback colour).
function markupFg(markup, fallback) {
  let out = "", color = fallback;
  for (const part of String(markup).split(/(\{#[0-9a-fA-F]{6}\})/)) {
    const t = part.match(/^\{(#[0-9a-fA-F]{6})\}$/);
    if (t) { color = t[1]; continue; }
    if (part) out += hexFg(color, part);
  }
  return out;
}
// Only a chosen name gets its own colour; unnamed agents (pi·xxxx, including twins
// that inherited a parent's colour) use the normal text colour (bold, like every
// name), so they read slightly darker than the topic and model.
const unnamed = (name) => !name || /^pi·[0-9a-z]{4}$/.test(String(name));
const nameFg = (name, color, s) => unnamed(name) ? bold(s) : hexFg(color, bold(s));
const hexFg = (hex, s) => { const m = /^#?([0-9a-f]{6})$/i.exec(hex || ""); if (!m) return s; const n = parseInt(m[1], 16); return `${ESC}38;2;${n >> 16};${(n >> 8) & 255};${n & 255}m${s}${ESC}39m`; };

// Display width (emoji / CJK = 2, combining / ZWJ / VS = 0), enough for names and chat.
function cw(cp) {
  if (cp === 0x200d || (cp >= 0xfe00 && cp <= 0xfe0f) || (cp >= 0x300 && cp <= 0x36f)) return 0;
  // Emoji that draw as emoji by default are 2 wide; text symbols like ❯ ✓ × ● are 1.
  if (/\p{Emoji_Presentation}/u.test(String.fromCodePoint(cp))) return 2;
  if ((cp >= 0x1100 && cp <= 0x115f) || (cp >= 0x2e80 && cp <= 0xa4cf) || (cp >= 0xac00 && cp <= 0xd7a3) || (cp >= 0xf900 && cp <= 0xfaff) || (cp >= 0xff00 && cp <= 0xff60)) return 2;
  return 1;
}
// Grapheme clusters (what the terminal puts in cells): an emoji with a variation
// selector (✔️), a ZWJ sequence or a flag is one 2-wide cell pair in kitty, even
// though its code points would add up differently. Every measurement goes
// through these so a row can never come out wider on screen than we think.
const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const graphemes = (s) => Array.from(segmenter.segment(String(s)), (x) => x.segment);
function gw(g) {
  const cps = [...g].map((c) => c.codePointAt(0));
  if (cps.length > 1 && cps.some((cp) => cp === 0xfe0f || cp === 0x200d || (cp >= 0x1f1e6 && cp <= 0x1f1ff) || /\p{Extended_Pictographic}/u.test(String.fromCodePoint(cp)))) return 2;
  let w = 0; for (const cp of cps) w += cw(cp); return w;
}
const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");
const width = (s) => { let w = 0; for (const g of graphemes(strip(s))) w += gw(g); return w; };
function cut(s, n) { let w = 0, r = ""; for (const g of graphemes(s)) { const c = gw(g); if (w + c > n) return w + 1 <= n ? r + "…" : cut(r, n - 1) ; w += c; r += g; } return r; }
// Cut a styled line to n columns, keeping its escape codes intact.
function clip(s, n) {
  let w = 0, r = "";
  for (const part of s.split(/(\x1b\[[0-9;?]*[A-Za-z])/)) {
    if (part.startsWith("\x1b")) { r += part; continue; }
    for (const g of graphemes(part)) { const c = gw(g); if (w + c > n) return r + `${ESC}0m`; w += c; r += g; }
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
      if (ww > n) { for (const g of graphemes(word)) { const c = gw(g); if (lw + c > n) { lines.push(line); line = ""; lw = 0; } line += g; lw += c; } continue; }
      line += word; lw += ww;
    }
    lines.push(line.trimEnd());
  }
  return lines;
}
// Hard wrap by display width (keeps spaces, so the typed input never loses its trailing blank).
function hardWrap(text, n) {
  const lines = []; let line = "", lw = 0;
  for (const g of graphemes(text)) { const c = gw(g); if (lw + c > n) { lines.push(line); line = ""; lw = 0; } line += g; lw += c; }
  lines.push(line);
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
// The room is a stream: messages plus agent activity (tools, topics, talk between agents,
// finishes) from the daemon. Ctrl+F cycles what it shows.
let activity = {}; // room -> events
// all = messages + every activity · topics = messages + topic changes · messages · activity.
const FILTERS = ["all", "topics", "messages", "activity"];
let filter = "all";
let ic = 0; // cursor position in the message being typed, in graphemes
let api = null;

function mark(a) {
  // Same marks as the room window: ● working · ✓ done (unseen) · × blocked · ○ idle
  if (a.status === "working") return "●";
  if (a.status === "blocked") return "×";
  if (a.status === "done" && !a.seen) return "✓";
  return "○";
}

// ---- click-drag text selection (the TUI owns the mouse, so it selects itself)
let lastClick = { id: "", t: 0, toggled: false };
let screen = [], sel = null; // sel: { x0, y0, x1, y1, dragging, mode } in 1-based cells
// mode "text": plain drag in the conversation = message text only.
// mode "msg":  Shift+click / Shift+drag = whole messages (time, name, text).
// mode "plain": anywhere else = cells as on screen.
let rowMeta = {}, convoMsgs = [];
// Screen row -> [fromCol, toCol] to highlight.
function selSpans(W) {
  const sr = selRange(), out = {};
  if (!sr) return out;
  if (sel.mode === "msg") {
    const [m0, m1] = selMsgs(sr);
    if (m0 == null) return out;
    for (const [y, r] of Object.entries(rowMeta)) if (r.msg != null && r.msg >= m0 && r.msg <= m1) out[y] = [1, W];
    return out;
  }
  for (let y = sr.y0; y <= sr.y1; y++) {
    let a = y === sr.y0 ? sr.x0 : 1, b = y === sr.y1 ? sr.x1 : W;
    if (y >= listRowY && y < listRowY + listRows) a = Math.max(a, 4); // never the ▸ / status mark columns
    if (sel.mode === "text") {
      const r = rowMeta[y];
      if (!r || r.msg == null || r.header) continue;
      a = Math.max(a, r.textX);
      b = Math.min(b, width(screen[y - 1].trimEnd())); // text only, not trailing blanks
    }
    if (a <= b) out[y] = [a, b];
  }
  return out;
}
// Messages covered by a Shift selection (by the rows it starts and ends on).
function selMsgs(sr) {
  const near = (y, d) => { for (let k = 0; k < 400; k++, y += d) { const r = rowMeta[y]; if (r && r.msg != null) return r.msg; if (!r && k) break; } return null; };
  let m0 = near(sr.y0, 1), m1 = near(sr.y1, -1);
  if (m0 == null || m1 == null) return [null, null];
  return m0 <= m1 ? [m0, m1] : [m1, m0];
}
function selRange() {
  if (!sel || (sel.mode !== "msg" && sel.x0 === sel.x1 && sel.y0 === sel.y1)) return null;
  const fwd = sel.y0 < sel.y1 || (sel.y0 === sel.y1 && sel.x0 <= sel.x1);
  return fwd ? { y0: sel.y0, x0: sel.x0, y1: sel.y1, x1: sel.x1 } : { y0: sel.y1, x0: sel.x1, y1: sel.y0, x1: sel.x0 };
}
// Paint cells a..b of a styled line with a background, keeping every other
// style (dim time, bold coloured name, …) as it was.
function overlay(line, a, b, on, off) {
  let col = 1, r = "", inside = false;
  for (const part of line.split(/(\x1b\[[0-9;?]*[A-Za-z])/)) {
    if (part.startsWith("\x1b")) { r += part; if (inside && /\x1b\[(?:0|49|27)?m$/.test(part)) r += on; continue; }
    for (const g of graphemes(part)) {
      if (!inside && col >= a && col <= b) { r += on; inside = true; }
      if (inside && col > b) { r += off; inside = false; }
      r += g; col += gw(g);
    }
  }
  if (inside && col <= b + 1) { r += " ".repeat(Math.max(0, b + 1 - col)); } // selection past the text: pad
  else if (!inside && col <= a) { r += " ".repeat(a - col) + on + " ".repeat(b - a + 1); inside = true; }
  if (inside) r += off;
  return r;
}
// Cells a..b (1-based, inclusive) of a plain line.
function sliceCols(t, a, b) {
  let col = 1, r = "";
  for (const g of graphemes(t)) { const w = gw(g); if (col >= a && col + w - 1 <= b) r += g; col += w; if (col > b) break; }
  return r;
}
function selectedText() {
  const sr = selRange(); if (!sr) return "";
  const W = process.stdout.columns || 100;
  if (sel.mode === "msg") { // whole messages, full text even if partly scrolled away
    const [m0, m1] = selMsgs(sr); if (m0 == null) return "";
    return convoMsgs.slice(m0, m1 + 1).map((m) => `${m.author?.kind === "human" ? m.author.name || "Angus" : m.author?.name || "agent"}: ${m.text}`).join("\n");
  }
  const spans = selSpans(W);
  if (sel.mode === "text") { // unwrap: rows of one paragraph join with a space
    let t = "", prev = null;
    for (const y of Object.keys(spans).map(Number).sort((a, b) => a - b)) {
      const r = rowMeta[y], piece = sliceCols(screen[y - 1], spans[y][0], spans[y][1]).trim();
      if (prev) t += prev.msg !== r.msg ? "\n" : prev.hard ? "\n" : " ";
      t += piece; prev = r;
    }
    return t;
  }
  const out = [];
  for (const y of Object.keys(spans).map(Number).sort((a, b) => a - b)) out.push(sliceCols(screen[y - 1], spans[y][0], spans[y][1]).trimEnd());
  return out.join("\n");
}
function copy(text) {
  if (!text) return;
  // OSC 52 (kitty puts it on the clipboard) and wl-copy as a fallback.
  process.stdout.write(`\x1b]52;c;${Buffer.from(text).toString("base64")}\x07`);
  try { const p = spawn("wl-copy", ["--type", "text/plain;charset=utf-8"], { stdio: ["pipe", "ignore", "ignore"] }); p.on("error", () => {}); p.stdin.end(text); } catch { /* OSC 52 only */ }
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
  // One name column for agents and messages, so message names line up with
  // the agent names above (column 4, after the mark).
  const msgs = messages[room] || [];
  const authorLabel = (au = {}) => au.kind === "human" ? au.name || "Angus" : (au.icon ? au.icon + " " : "") + (au.name || "agent");
  const nameW = Math.min(20, Math.max(6, ...here.map((a) => width((a.icon ? a.icon + " " : "") + a.display)), ...msgs.slice(-200).map((m) => width(authorLabel(m.author)))));
  const nameBg = theme.muted || theme.selection;
  const modelW = Math.max(4, ...here.map((a) => width((a.model || "").replace(/^claude-/, ""))));
  if (!here.length) rows.push(dim("  no agents here · SUPER+A opens one"));
  for (const a of here.slice(listTop, listTop + listRows)) {
    // mark · name · model · topic (like herdr's sidebar). No status word: the mark says it.
    const name = cut((a.icon ? a.icon + " " : "") + a.display, nameW);
    const iconPart = a.icon && name.startsWith(a.icon + " ") ? a.icon + " " : "";
    const bare = name.slice(iconPart.length);
    let styled = a.name_markup && !name.endsWith("…") && !unnamed(a.name) ? bold(markupFg(a.name_markup, a.color)) : nameFg(a.name, a.color, bare);
    // Cursor (follows the focused window): the name alone (not its icon) on light grey.
    // Focused but the cursor moved elsewhere: the name underlined. Marks never change colour.
    if (a.id === cursorId && nameBg) styled = `${ESC}48;2;${rgb(nameBg)}m${styled}${ESC}49m`;
    else if (a.id === cursorId || a.focused) styled = `${ESC}4m${styled}${ESC}24m`;
    styled = iconPart + styled;
    const sel = marked.has(a.id) ? fg(c, bold("▸")) : " ";
    const model = (a.model || "").replace(/^claude-/, "");
    // name · topic · model, separated by dots like herdr's sidebar (no columns).
    // Topic, model and the dot separators in the normal text colour (same as message text).
    const dot = " · ";
    const rest = (a.topic ? dot + `${ESC}3m${a.topic}${ESC}23m` : "") + (model ? dot + model : "");
    rows.push(`${sel}${fg(c, bold(mark(a)))} ${styled}${rest}`);
  }

  // Conversation pane: fill what's left, newest at the bottom.
  convoY = rows.length + 2;
  const ruleAt = rows.length; rows.push(""); // filled in once scroll is clamped below
  // Input: a long message wraps onto further lines (all shown), continuation
  // lines indented under the text.
  const to = [...marked].map((id) => agents.find((a) => a.id === id)?.display).filter(Boolean);
  const prompt = fg(c, bold(to.length ? `${room} → ${cut(to.join(", "), Math.max(10, Math.floor(W / 3)))} ❯ ` : `${room} ❯ `));
  const promptW = width(prompt), inputLines = hardWrap(input, Math.max(10, W - promptW));
  const bottom = 2 + inputLines.length; // input rule + input line(s) + status bar
  const avail = Math.max(1, H - rows.length - bottom);
  // Every message: the author on its own line, the text on the next (no name column).
  const narrow = true, textX = 4, textW = Math.max(10, W - textX + 1 - 1);
  // Each row: { line, msg (index into the room's messages), textX (1-based
  // column where message text starts), hard (last row of a paragraph) }.
  const convo = [];
  // Stream items in time order: messages (mi = index into msgs, for selection) and activity.
  const acts = filter === "messages" ? [] : filter === "topics" ? (activity[room] || []).filter((x) => x.kind === "topic") : (activity[room] || []);
  const items = filter === "activity" ? [] : msgs.map((m, mi) => ({ ts: m.ts, m, mi }));
  for (const e of acts) items.push({ ts: e.ts, e });
  items.sort((x, y) => x.ts - y.ts);
  // Activity rows: no indent, no glyphs; names (with their icons) in their own colours.
  // "done" (finished) is logged but not shown here.
  const agentByName = (n) => agents.find((x) => x.display === n || x.name === n);
  const styledName = (n) => {
    if (n === "Angus") return fg(c, bold("Angus"));
    const x = agentByName(n);
    return x ? (x.icon ? x.icon + " " : "") + nameFg(x.name, x.color, x.display || n) : bold(n);
  };
  const afterColon = (t) => { const i = String(t).indexOf(": "); return i >= 0 ? String(t).slice(i + 2) : String(t); };
  let lastAct = null;
  items.forEach(({ m, mi, e }) => {
    if (e) {
      if (e.kind === "done") return;
      const au = e.agent || {};
      const sender = (au.icon ? au.icon + " " : "") + nameFg(au.name, au.color, au.name || "agent");
      const tos = (Array.isArray(e.to) ? e.to : []).map(styledName).join(", ");
      // Direct messages (agent to agent(s), Angus to an agent): their own block, a header
      // "🗃️ Quartermaster to 📊 Sankey, …" with every name in its colour, then the message
      // (a leading repeat of the sender's own name dropped).
      // Other activity: a run from one agent shows its name once, then the rows (no indent).
      const direct = { talk: "to", demand: "asks", reply: "replies to", prompt: "to" }[e.kind];
      // Indented like messages: names and text at column 4.
      const push = (text, loud) => {
        const parts = wrap(strip(text), textW);
        if (parts.length <= 1) return convo.push({ line: "   " + text, msg: null, act: true });
        convo.push({ line: "   " + clip(text, width(parts[0])), msg: null, act: true });
        for (const l of parts.slice(1)) convo.push({ line: "   " + (loud ? l : dim(l)), msg: null, act: true });
      };
      if (direct) {
        const from = e.kind === "prompt" ? fg(c, bold("Angus")) : sender;
        const to = e.kind === "prompt" ? sender : tos;
        const self = e.kind === "prompt" ? "Angus" : (au.name || "");
        let body = afterColon(e.text);
        const lead = new RegExp(`^\\s*(?:\\S+\\s+)?${self.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*[:,—-]\\s*`, "u");
        if (self) body = body.replace(lead, "");
        if (convo.length) convo.push({ line: "", msg: null });
        convo.push({ line: `   ${from} ${direct} ${to}`, msg: null, act: true });
        push(body, true);
        lastAct = "direct:" + au.id; // the next activity starts a new block
        return;
      }
      // Topics: full text colour in italics (easy to read); tool lines stay dim.
      const line = e.kind === "blocked" ? "needs you" : e.kind === "topic" ? `${ESC}3mtopic: ${e.text}${ESC}23m` : dim(e.text);
      if (lastAct !== au.id) {
        if (convo.length) convo.push({ line: "", msg: null });
        convo.push({ line: "   " + sender, msg: null, act: true });
      }
      push(line, e.kind === "blocked" || e.kind === "topic");
      lastAct = au.id;
      return;
    }
    lastAct = null;
    const au = m.author || {};
    const who = au.kind === "human" ? fg(c, bold(cut(authorLabel(au), nameW)))
      : au.markup && width(authorLabel(au)) <= nameW ? (au.icon ? au.icon + " " : "") + bold(markupFg(au.markup, au.color))
      : nameFg(au.name, au.color, cut(authorLabel(au), nameW));
    const body = [];
    for (const para of String(m.text).split("\n")) { const ls = wrap(para, textW); ls.forEach((l, i) => body.push({ l, hard: i === ls.length - 1 })); }
    if (narrow) {
      if (convo.length) convo.push({ line: "", msg: null });
      convo.push({ line: `   ${who}`, msg: mi, header: true });
      for (const b of body) convo.push({ line: `   ${b.l}`, msg: mi, textX, hard: b.hard });
    } else body.forEach((b, i) => convo.push({ line: i === 0 ? `   ${pad(who, nameW)}  ${b.l}` : " ".repeat(textX - 1) + b.l, msg: mi, textX, hard: b.hard }));
  });
  // Scrolled up: stay on the same lines when new ones arrive below.
  if (scroll > 0 && convo.length > lastConvoLen) scroll += convo.length - lastConvoLen;
  lastConvoLen = convo.length; lastAvail = avail;
  scroll = Math.max(0, Math.min(scroll, convo.length - avail));
  const streamLabel = { all: "room + activity", topics: "room + topics", messages: "room · messages only", activity: "room · activity only" }[filter];
  rows[ruleAt] = rule(`${streamLabel} (^F)` + (scroll > 0 ? ` · ↓ ${scroll} more line${scroll === 1 ? "" : "s"} below (End)` : ""));
  const shown = convo.slice(Math.max(0, convo.length - avail - scroll), convo.length - scroll);
  if (!convo.length) shown.push({ line: dim(filter === "activity" ? "  (no activity yet)" : "  (no messages yet)"), msg: null });
  while (shown.length < avail) shown.unshift({ line: "", msg: null });
  rowMeta = {}; convoMsgs = msgs;
  shown.forEach((r, i) => { rowMeta[rows.length + 1 + i] = r; });
  rows.push(...shown.map((r) => r.line));

  // Input line(s)
  rows.push(fg(c, "─".repeat(W)));
  const hint = input ? "" : dim(confirm ? confirm.label : note || (W < 72 ? "message the room" : (confirm ? confirm.label : "message the room · ↑↓ agent · ⏎ jump · space mark · ^F filter · ^W close · ^K kill · ^N new · Tab room")));
  inputLines.forEach((l, i) => rows.push((i === 0 ? prompt : " ".repeat(promptW)) + l + (i === 0 ? hint : "")));

  // tmux-style status bar
  const tabs = rooms.map((r) => r.id === room ? `${ESC}${worldBg(r.id)};30m ${r.id} ${ESC}49;39m` : ` ${fg(worldFg(r.id), r.id)} `).join("");
  const left = ` hyprpi ${online ? "" : "· daemon offline "}`;
  const right = `${here.length} agent${here.length === 1 ? "" : "s"} · ${hhmm(Date.now())} `;
  const mid = W - width(left) - width(strip(tabs)) - width(right);
  rows.push(`${ESC}7m${left}${ESC}27m${tabs}${ESC}7m${" ".repeat(Math.max(0, mid))}${right}${ESC}27m`);

  out(`\x1b]2;hyprpi tui · room ${room}\x07`); // not "hyprpi room …": the daemon treats those titles as room windows
  const lines = rows.slice(0, H).map((r) => clip(r, W));
  screen = lines.map(strip);
  // Selection: repaint the selected cells with the theme's selection colour
  // (what kitty uses for its own selection).
  const spans = selSpans(W);
  const selOn = theme.selection ? `${ESC}48;2;${rgb(theme.selection)}m` : `${ESC}7m`, selOff = theme.selection ? `${ESC}49m` : `${ESC}27m`;
  const shown2 = lines.map((l, i) => {
    const sp = spans[i + 1];
    if (!sp) return l;
    return overlay(l, sp[0], sp[1], selOn, selOff);
  });
  // Each row at its absolute position: if a row still renders wider than we
  // measured, the next row simply paints over the spill instead of shifting the
  // whole frame up one line. (The last row is never wider than W, so no scroll.)
  out(`${ESC}?25l` + shown2.map((l, i) => `${ESC}${i + 1};1H` + l + `${ESC}0m${ESC}K`).join("") + (shown2.length < H ? `${ESC}${shown2.length + 1};1H${ESC}J` : ""));
  // cursor at the end of the input's last line
  // Cursor at ic inside the (possibly wrapped) message.
  ic = Math.max(0, Math.min(ic, graphemes(input).length));
  const before = hardWrap(graphemes(input).slice(0, ic).join(""), Math.max(10, W - promptW));
  const crow = H - inputLines.length + before.length - 1, ccol = Math.min(W, promptW + width(before[before.length - 1]) + 1);
  out(`${ESC}${crow};${ccol}H${ESC}?25h`);
}

async function loadRoom(r) {
  if (!api || !r) return;
  try { const res = await api.call("room.read", { room: r, tail: true, limit: 200 }); messages[r] = res.messages || []; } catch { /* keep old */ }
  try { const res = await api.call("activity.read", { room: r, limit: 300 }); activity[r] = res.events || []; } catch { /* older daemon */ }
  render();
}

let lastFocusedId = "";
function applyList(r) {
  agents = r.agents || []; rooms = r.rooms || [];
  // Focusing an agent's window moves the list cursor to it (and scrolls it into view).
  const f = agents.find((a) => a.focused);
  if (f && f.id !== lastFocusedId && f.room === (room || r.active_room)) cursorId = f.id;
  lastFocusedId = f ? f.id : "";
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
        else if (ev === "activity" && data?.room) { const t = (activity[data.room] ||= []); t.push(data); if (t.length > 600) t.splice(0, t.length - 500); if (data.room === room && filter !== "messages") render(); }
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
  const text = input.trim(); input = ""; ic = 0;
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
const KEY = /\x1b[bf\x7f]|\x1b\[<[\d;]+[Mm]|\x1b\[[\d;]*[A-Za-z~]|\x1bO[A-Za-z]|\x1b|[\s\S]/gu;
process.stdin.on("data", (chunk) => { batching = true; try { for (const [k] of String(chunk).matchAll(KEY)) onKey(k); } finally { batching = false; if (dirty) draw(); } });
function onKey(d) {
  if (sel && !d.startsWith("\x1b[<")) { sel = null; dirty = true; }
  if (d === "\x03") return quit();
  if (d === "\t") return cycle(1);
  if (d === "\x1b[Z") return cycle(-1);
  if (d === "\r") return send();
  // Editing the message: ←/→ (Ctrl or Alt+B/F: by word), Home/End or Ctrl+E
  // while typing, Backspace / Delete at the cursor, Alt+Backspace word, Ctrl+U clear.
  {
    const gs = graphemes(input);
    ic = Math.max(0, Math.min(ic, gs.length));
    const edited = (next, c) => { input = next.join(""); ic = c; note = ""; return render(); };
    const wordLeft = () => { let i = ic; while (i > 0 && /\s/.test(gs[i - 1])) i--; while (i > 0 && !/\s/.test(gs[i - 1])) i--; return i; };
    const wordRight = () => { let i = ic; while (i < gs.length && /\s/.test(gs[i])) i++; while (i < gs.length && !/\s/.test(gs[i])) i++; return i; };
    if (d === "\x1b[D") { ic = Math.max(0, ic - 1); return render(); }
    if (d === "\x1b[C") { ic = Math.min(gs.length, ic + 1); return render(); }
    if (d === "\x1b[1;5D" || d === "\x1bb") { ic = wordLeft(); return render(); }
    if (d === "\x1b[1;5C" || d === "\x1bf") { ic = wordRight(); return render(); }
    if (input && (d === "\x1b[H" || d === "\x1b[1~")) { ic = 0; return render(); }
    if (d === "\x05" || (input && (d === "\x1b[F" || d === "\x1b[4~"))) { ic = gs.length; return render(); }
    if (d === "\x7f" || d === "\b") { if (!ic) return; return edited([...gs.slice(0, ic - 1), ...gs.slice(ic)], ic - 1); }
    if (d === "\x1b[3~") { if (ic >= gs.length) return; return edited([...gs.slice(0, ic), ...gs.slice(ic + 1)], ic); }
    if (d === "\x1b\x7f") { const i = wordLeft(); return edited([...gs.slice(0, i), ...gs.slice(ic)], i); }
    if (d === "\x15") return edited([], 0); // Ctrl+U
  }
  if (d === "\x0e") return newAgent(); // Ctrl+N
  if (d === "\x06") { filter = FILTERS[(FILTERS.indexOf(filter) + 1) % FILTERS.length]; scroll = 0; lastConvoLen = 0; note = `showing ${{ all: "messages + activity", topics: "messages + topics", messages: "messages only", activity: "activity only" }[filter]}`; return render(); } // Ctrl+F
  // Scrolling: mouse wheel (SGR mouse reports), ↑/↓ line, PgUp/PgDn page, Home/End.
  if (d.startsWith("\x1b[<")) {
    for (const m of d.matchAll(/\x1b\[<(\d+);(\d+);(\d+)([Mm])/g)) {
      const b = Number(m[1]), x = Number(m[2]), y = Number(m[3]);
      const inList = y >= listRowY && y < listRowY + listRows;
      // Left button: press starts a possible selection, motion drags it,
      // release copies it (or, without a drag, counts as a click).
      // (+4 = Shift held; kitty passes Shift through: terminal_select_modifiers.)
      if ((b === 0 || b === 4) && m[4] === "M") {
        const inConvo = !!rowMeta[y];
        sel = { x0: x, y0: y, x1: x, y1: y, dragging: false, mode: b === 4 && inConvo ? "msg" : inConvo ? "text" : "plain" };
        continue;
      }
      if ((b === 32 || b === 36) && sel) { sel.x1 = x; sel.y1 = y; sel.dragging = true; continue; }
      if ((b === 0 || b === 4) && m[4] === "m" && sel) {
        sel.x1 = x; sel.y1 = y;
        if ((sel.dragging || sel.mode === "msg") && selRange()) { copy(selectedText()); continue; } // highlight stays until the next key or click
        sel = null;
        if (inList) {
          const a = hereAgents()[listTop + y - listRowY];
          if (!a) continue;
          const now = Date.now();
          if (lastClick.id === a.id && now - lastClick.t < 400) {
            // Double-click: copy the agent's name (and undo the mark the first click toggled).
            if (lastClick.toggled) marked.has(a.id) ? marked.delete(a.id) : marked.add(a.id);
            copy(a.display);
            const nx = 4 + (a.icon ? width(a.icon) + 1 : 0);
            sel = { x0: nx, y0: y, x1: nx + width(a.display) - 1, y1: y, dragging: true, mode: "plain" }; // show what was copied
            lastClick = { id: "", t: 0, toggled: false };
            continue;
          }
          // Click: cursor there; click the cursor row again: mark / unmark.
          const toggled = a.id === cursorId;
          if (toggled) marked.has(a.id) ? marked.delete(a.id) : marked.add(a.id);
          cursorId = a.id; confirm = null;
          lastClick = { id: a.id, t: now, toggled };
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
  { const gs = graphemes(input), ins = graphemes(d.replace(/[\x00-\x1f]/g, "")); if (!ins.length) return; ic = Math.max(0, Math.min(ic, gs.length)); input = [...gs.slice(0, ic), ...ins, ...gs.slice(ic)].join(""); ic += ins.length; note = ""; render(); }
}
function quit() { out(`${ESC}?1002l${ESC}?1000l${ESC}?1006l${ESC}?1049l${ESC}?25h`); process.exit(0); }
process.on("SIGTERM", quit);
process.stdout.on("resize", render);
setInterval(render, 30000); // clock
out(`${ESC}?1049h${ESC}?1000h${ESC}?1002h${ESC}?1006h`); // alt screen + mouse (wheel, click, drag-select)
render();
start();
