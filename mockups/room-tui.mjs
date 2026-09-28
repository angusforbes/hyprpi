#!/usr/bin/env node
// Panel 2 of three (docs/panels-plan.md): the hyprpi ROOM / STREAM panel, SUPER+ALT+R.
// One world's room: messages plus agent activity (tools, topics, talk between agents,
// joins/moves/renames), and the box to write in it. The agents themselves live in
// panel 1 (SUPER+ALT+A) and search in panel 3 (SUPER+ALT+/).
//
//   ~/Work/hyprpi/mockups/room-tui [ROOM]   (kitty launcher with the mouse settings)
//
// Typing + Enter posts to the room as Angus. The header line shows who is marked (▸,
// set in panel 1): everyone = a room post, some = straight to them, none = written in
// the room and delivered to nobody; "@Name text" always goes to that agent.
// Ctrl+F cycles what the stream shows: room · all activity / stream · all activity /
// room + stream / room + stream · topics.
// Ctrl+B toggles the project board (lib/tui/board-view.mjs): Needs-you strip + one card per
// project; in board mode the box takes @project … and board commands (/help there lists them).
// Keys: wheel / Shift+↑↓ / PgUp PgDn / Home End scroll · Ctrl+↑↓ select a stream row ·
// Ctrl+Tab / Ctrl+Shift+Tab switch world (Tab completes @names, /commands) · Ctrl+/ opens the search panel on this room ·
// Esc drops a selection, else marks every agent again · Ctrl+Q quits (Ctrl+C copies).
// Commands: /room · /stream [WORDS] (live word filter) · /history N|all · /help ·
// "//text" is only for saying something that starts with a slash (it would otherwise be
// read as a command): "//stream is down" posts "/stream is down". Ordinary messages need nothing.
// "@Lippy @Sankey" alone + Enter sets who messages go to (shown as "C → @Lippy @Sankey ❯",
// the same selection as panel 1's marks); "@Name text" goes just to them once; Tab
// completes @names (lib/at-names.mjs, shared with the search panel's @Name scope).
// Drag selects and copies message text, Shift+click/drag whole messages, double-click a
// word, triple-click a whole message. No ROOM = the current world's room; several copies
// can run at once: each is just another subscriber of the daemon.

import { connect } from "../lib/client.mjs";
import { parseAt, onlyAt, resolveAt, completeAt } from "../lib/at-names.mjs";
// Panel 2 has no search: SUPER+ALT+/ opens the search panel (panel 3).
const COMMANDS = [
  ["/room", "room messages + agent-to-agent"],
  ["/stream", "/stream WORDS shows only rows with those words; /stream alone clears the filter"],
  ["/tinker", "/tinker [D:] TEXT: drop a friction fix off in the workshop world (one free agent there does it); D: sets the workshop to world D"],
  ["/history", "/history N | all: how far back the stream goes (N interactions; default 200)"],
  ["/help", "this list"],
];
const completions = (prefix) => view === "board" ? boardCompletions(prefix) : COMMANDS.map(([c]) => c).filter((c) => c.startsWith(prefix.toLowerCase()));
// Ctrl+B: the project board (lib/tui/board-view.mjs draws it and reads what is typed there).
import { createBoardView, boardCompletions } from "../lib/tui/board-view.mjs";
const bv = createBoardView({ render: () => render() });
const helpRows = () => {
  const w = Math.max(...COMMANDS.map(([c]) => c.length));
  return [
    ...COMMANDS.map(([c, d]) => `   ${bold(c.padEnd(w))}  ${d}`),
    "",
    `   ${bold("//text".padEnd(w))}  ${dim("only needed to SAY something starting with \"/\": //stream is down → posts \"/stream is down\"")}`,
    `   ${bold("@Name @Name".padEnd(w))}  ${dim("on its own + ⏎: who messages go to from now on (the \"C → @…\" before the box; same as the marks ▸) · @all · @nobody")}`,
    `   ${bold("@Name text".padEnd(w))}  ${dim("just to them, this once · Tab completes @names · copy @names into the search box to search their history")}`,
    `   ${dim("mouse: drag = text · Shift+drag = whole messages · double-click = word · triple-click = whole message · each copies")}`,
    `   ${dim("stream: ^↑↓ scroll a line · PgUp PgDn page · ^Home/End oldest/newest · ⌥↑↓ pick a row · ^F what the stream shows")}`,
    `   ${dim("message box: ↑↓←→ move · ⇧←→↑↓ select · ⇧⏎ new line · ^C copy · ^X cut · ^V paste · ⏎ send")}`,
    `   ${dim("agents: SUPER+ALT+A (panel 1, the marks ▸ live there) · search: SUPER+ALT+/ (panel 3)")}`,
    `   ${dim("^B: the project board (Needs you, cards; @project alone opens one; /help there lists the board commands)")}`,
  ];
};
import fs from "node:fs";
import { ESC, out, theme, onThemeChange, rgb, worldFg, worldBg, worldHex, dim, midFg, bold, fg, markupFg,
  unnamed, nameFg, hexFg, graphemes, gw, strip, memo, width, cut, clip, pad, wrap, hardWrap } from "../lib/tui/term.mjs";
onThemeChange(() => render());
// ---- the message box (bottom): multi-line (Shift+Enter), wraps by width, Shift+←→ selects.
let selA = null;      // selection anchor (grapheme index into input), or null
let pasting = false;  // inside a bracketed paste (\x1b[200~ … \x1b[201~)
function inputSel() { if (selA == null || selA === ic) return null; return selA < ic ? [selA, ic] : [ic, selA]; }
// Rows of the input (styled, selection highlighted) and the cursor's row / column.
function inputLayout(n) {
  const gs = graphemes(input), rs = inputSel(), rows = [];
  const on = theme.selection ? `${ESC}48;2;${rgb(theme.selection)}m` : `${ESC}7m`, off = theme.selection ? `${ESC}49m` : `${ESC}27m`;
  // @names in the agent's colour (bold), @all / @nobody bold, unknown names red, as in
  // the search panel's box.
  const tint = new Array(gs.length).fill(null);
  for (let i = 0; i < gs.length; i++) {
    if (gs[i] !== "@" || (i > 0 && !/\s/.test(gs[i - 1]))) continue;
    let j = i + 1; while (j < gs.length && !/[\s,@]/.test(gs[j])) j++;
    if (j === i + 1) continue;
    const r = resolveAt([gs.slice(i + 1, j).join("")], atPool()), a = r.found[0];
    const paint = a?.project ? (g) => fg(worldFg(room), bold(g)) : a ? (g) => nameFg(a.name, a.color, g) : r.special ? (g) => bold(g) : (g) => `${ESC}31m${g}${ESC}39m`;
    for (let k = i; k < j; k++) tint[k] = paint;
    i = j - 1;
  }
  let line = "", lw = 0, cRow = 0, cCol = 0;
  for (let i = 0; i <= gs.length; i++) {
    if (i < gs.length && gs[i] !== "\n" && lw + gw(gs[i]) > n) { rows.push(line); line = ""; lw = 0; } // soft wrap
    if (i === ic) { cRow = rows.length; cCol = lw; }
    if (i === gs.length) break;
    if (gs[i] === "\n") { rows.push(rs && i >= rs[0] && i < rs[1] ? line + on + " " + off : line); line = ""; lw = 0; continue; }
    const g = tint[i] ? tint[i](gs[i]) : gs[i];
    line += rs && i >= rs[0] && i < rs[1] ? on + g + off : g; lw += gw(gs[i]);
  }
  rows.push(line);
  return { rows, cRow, cCol };
}
// Insert text at the cursor, replacing the selection (paste keeps its line breaks).
function insertText(t) {
  let gs = graphemes(input); const rs = inputSel();
  if (rs) { gs = [...gs.slice(0, rs[0]), ...gs.slice(rs[1])]; ic = rs[0]; }
  selA = null;
  const ins = graphemes(String(t).replace(/\r\n?/g, "\n").replace(/[\x00-\x09\x0b-\x1f]/g, ""));
  ic = Math.max(0, Math.min(ic, gs.length));
  input = [...gs.slice(0, ic), ...ins, ...gs.slice(ic)].join(""); ic += ins.length; note = ""; focusArea = "input"; render();
}
function copyInputSel(cut) {
  const rs = inputSel(); if (!rs) return;
  const gs = graphemes(input);
  copy(gs.slice(rs[0], rs[1]).join(""));
  if (cut) { input = [...gs.slice(0, rs[0]), ...gs.slice(rs[1])].join(""); ic = rs[0]; }
  selA = null; render();
}
function pasteClipboard() {
  try {
    const p = spawn("wl-paste", ["--no-newline", "--type", "text/plain"], { stdio: ["ignore", "pipe", "ignore"] });
    let buf = ""; p.stdout.on("data", (b) => { buf += b; }); p.on("error", () => {}); p.on("close", () => { if (buf) insertText(buf); });
  } catch { /* no wl-paste */ }
}
const hhmm = (ts) => { const d = new Date(ts); return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`; };
const home = (p) => String(p || "").replace(/^\/home\/[^/]+/, "~");

let scroll = 0, lastConvoLen = 0, lastAvail = 10; // scroll = lines up from the newest
// Agent list: cursor (by id), marked ids (multi-select recipients), list scroll,
// and where the rows landed on screen (for mouse clicks).
// Marks: every agent is marked (▸) unless you turned it off; we keep the OFF set so
// agents that join later start marked. markedIds() = the marked agents here.
let convoY = 0, confirm = null;
// Marks (▸) are the daemon's per-room selection, set in panel 1 (the agent panel).
let marks = { all: true, agents: [] };
const listRowY = 0, listRows = 0; // no agent pane here (kept so the copy code reads the same)
const hereAgents = () => agents.filter((a) => a.room === room);
// Greyed agents under the live ones; Ctrl+O cycles how many:
//   0 live + those lost to a restart / reboot   [default]
//   1 + parked (Reprieve, SUPER+W; still running) and closed/killed while hyprpi ran
// Enter: a closed one is resumed (same id, name, twins), a parked one is moved back to
// this workspace. ^W twice on a closed one drops it from the list (its session stays).
let dormant = [];
let agents = [], rooms = [], room = (process.argv[2] || "").toUpperCase(), messages = {}, input = "", note = "", online = false;
// The room is a stream: messages plus agent activity (tools, topics, talk between agents,
// finishes) from the daemon. Ctrl+F cycles what it shows.
let activity = {}; // room -> events
// Ctrl+F modes. "done" and "blocked" are logged but never shown (the agent list shows ✓ / ×).
const DIRECT = new Set(["talk", "demand", "reply", "prompt"]);
const MODES = {
  room:   { label: "room · all activity", msgs: true, act: (e) => DIRECT.has(e.kind) },        // room messages + agent-to-agent
  stream: { label: "stream · all activity", msgs: false, act: () => true },                      // activity, no room messages
  all:    { label: "room + stream", msgs: true, act: () => true },                               // everything
  topics: { label: "room + stream · topics only", msgs: true, act: (e) => e.kind === "topic" || DIRECT.has(e.kind) },  // room messages + agent-to-agent + topic changes (no tool lines)
};
const FILTERS = ["room", "stream", "all", "topics"];
const FILTER_LABEL = Object.fromEntries(Object.entries(MODES).map(([k, v]) => [k, v.label]));
const HIDDEN = new Set(["done", "blocked"]);
let filter = "topics"; // default view
// What the pane shows: "stream" | "help".
let view = "stream", words = []; // words: /stream WORDS live filter (lower case)
let resultRowMap = {}; // screen row -> search result index (clicks)
let tabCycle = null; // Tab through several matching commands
let atCycle = null;  // Tab through several matching @names (completeAt's state)
const CTRL_TAB = new Set(["\x1b[9;5u", "\x1b[27;5;9~"]), CTRL_SHIFT_TAB = new Set(["\x1b[9;6u", "\x1b[27;6;9~", "\x1b[1;5Z"]); // Ctrl(+Shift)+Tab: world (the launcher maps them; kitty would switch its own tabs)

// Marked agents (▸ in the agent list) filter everything: who messages go to, whose history
// search and /ask read, and whose rows the stream shows. Esc clears.
const markedIds = () => new Set(marks.all ? hereAgents().map((a) => a.id) : marks.agents.filter((id) => hereAgents().some((a) => a.id === id)));
const allMarked = () => marks.all || markedIds().size === hereAgents().length;
// Search / ask scope: all marked = the whole room (closed agents too); none = only Angus's posts.
// /history: how far back the stream and /ask go, in interactions (a room message or one
// agent turn, however many tool calls); "all" = everything. Default 200.
let historyN = 200;
function onlyLabel() {
  if (allMarked()) return "";
  const ids = markedIds();
  if (!ids.size) return " · no agents ▸ (Esc: all)";
  const names = [...ids].map((id) => agents.find((a) => a.id === id)?.display).filter(Boolean);
  return ` · only ▸ ${names.slice(0, 3).join(", ")}${names.length > 3 ? ` +${names.length - 3}` : ""}`;
}
const italic = (s) => `${ESC}3m${s}${ESC}23m`;
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
let rowMeta = {}, convoMsgs = []; // convoMsgs: the stream items on screen ({ copy } = text for Shift-selection)
// The selected stream item (Ctrl+↑↓), by a key that survives rebuilds; null = none (follow the newest).
let streamSel = null, streamKeys = [];
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
    return convoMsgs.slice(m0, m1 + 1).map((x) => x.copy).join("\n");
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
// Double-click: the word under the pointer (surrounding punctuation left out).
// Triple-click: the whole stream item (message, direct message, topic) under the
// pointer, or the line elsewhere. Selected on screen and copied, like a drag.
let clicks = 0, lastPress = { x: 0, y: 0, t: 0 };
function multiClick(n, x, y) {
  const line = screen[y - 1] || "";
  const cells = []; // [col, grapheme] per grapheme
  { let col = 1; for (const g of graphemes(line)) { cells.push([col, g]); col += gw(g); } }
  if (n === 2) {
    let i = cells.findIndex(([c, g], k) => c <= x && (cells[k + 1]?.[0] ?? c + gw(g)) > x);
    if (i < 0 || /\s/.test(cells[i][1])) { sel = null; return render(); }
    let a = i, b = i;
    while (a > 0 && !/\s/.test(cells[a - 1][1])) a--;
    while (b < cells.length - 1 && !/\s/.test(cells[b + 1][1])) b++;
    const P = /^[\p{P}\p{S}]$/u;
    while (a < b && P.test(cells[a][1]) && !/[@#~/$]/.test(cells[a][1])) a++;
    while (b > a && P.test(cells[b][1])) b--;
    sel = { x0: cells[a][0], y0: y, x1: cells[b][0] + gw(cells[b][1]) - 1, y1: y, dragging: true, mode: "plain" };
  } else if (rowMeta[y]?.msg != null) sel = { x0: x, y0: y, x1: x, y1: y, dragging: true, mode: "msg" };
  else {
    const first = cells.find(([, g]) => !/\s/.test(g));
    if (!first) { sel = null; return render(); }
    sel = { x0: first[0], y0: y, x1: width(line.trimEnd()), y1: y, dragging: true, mode: "plain" };
  }
  copy(selectedText());
  render();
}
function copy(text) {
  if (!text) return;
  // OSC 52 (kitty puts it on the clipboard) and wl-copy as a fallback.
  process.stdout.write(`\x1b]52;c;${Buffer.from(text).toString("base64")}\x07`);
  try { const p = spawn("wl-copy", ["--type", "text/plain;charset=utf-8"], { stdio: ["pipe", "ignore", "ignore"] }); p.on("error", () => {}); p.stdin.end(text); } catch { /* OSC 52 only */ }
  note = `copied ${text.length} character${text.length === 1 ? "" : "s"}`;
}

let batching = false, dirty = false;
const PROF = process.env.HYPRPI_TUI_PROF; // file: one "ms view" line per frame
let restarting = false; // re-exec in progress: the child owns the terminal, draw nothing
function render() { if (restarting) return; if (batching) { dirty = true; return; } if (!PROF) return draw(); const t = performance.now(); draw(); fs.appendFileSync(PROF, `${(performance.now() - t).toFixed(1)} ${view}\n`); }
function draw() {
  dirty = false;
  const W = process.stdout.columns || 100, H = process.stdout.rows || 30;
  const c = worldFg(room);
  const live = hereAgents();
  const rule = (label = "") => fg(c, "─" + (label ? ` ${label} ` : "") + "─".repeat(Math.max(0, W - 1 - (label ? width(label) + 2 : 0))));
  const rows = [];

  // No agent pane here: panel 1 (SUPER+ALT+A) owns the agents. One header line instead —
  // the room, who is marked (▸, set in panel 1), and what else is in the world.
  const marked = markedIds(), everyone = allMarked();
  const nParked = agents.filter((a) => a.parked && (!a.parked_from || a.parked_from === room)).length;
  const nClosed = dormant.filter((a) => a.room === room).length;
  const markedNames = [...marked].map((id) => agents.find((a) => a.id === id)?.display).filter(Boolean);
  const who = everyone ? `${live.length} agent${live.length === 1 ? "" : "s"}`
    : marked.size ? `only ▸ ${cut(markedNames.join(", "), 40)}` : "no agents ▸ (Esc: all)";
  rows.push(rule(`room ${room} · ${who}${nParked ? ` · ${nParked} parked` : ""}${nClosed ? ` · ${nClosed} closed` : ""}`));

  const msgs = messages[room] || [];
  const authorLabel = (au = {}) => au.kind === "human" ? au.name || "Angus" : (au.icon ? au.icon + " " : "") + (au.name || "agent");
  const nameW = Math.min(20, Math.max(6, ...msgs.slice(-200).map((m) => width(authorLabel(m.author)))));
  const nameBg = theme.muted || theme.selection;

  // Conversation pane: fill what's left, newest at the bottom.
  convoY = rows.length + 2;
  const ruleAt = rows.length; rows.push(""); // filled in once scroll is clamped below
  // Input: a long message wraps onto further lines (all shown), continuation
  // lines indented under the text.
  // Recipients in the prompt, always shown (all marked = the room post goes to all of them):
  // icons where they exist, names only for agents without one.
  // Shown as @Names (plain text, so it can be copied into the search panel's box).
  const toAgents = [...marked].map((id) => agents.find((a) => a.id === id)).filter(Boolean);
  const toText = cut(toAgents.map((a) => "@" + a.display).join(" "), Math.max(10, Math.floor(W / 3)));
  const bvOpen = view === "board" && hereProjects().find((p) => p.id === bv.focused);
  const prompt = view === "board" ? fg(c, bold(`${room} board${bvOpen ? " @" + bvOpen.name : ""} ❯ `))
    : everyone || !live.length ? fg(c, bold(`${room} → everyone ❯ `))
    : toAgents.length ? fg(c, bold(`${room} → `)) + toText.replace(/@[^\s…]+/g, (at) => { const a = toAgents.find((x) => "@" + x.display === at); return a ? nameFg(a.name, a.color, bold(at)) : bold(at); }) + fg(c, bold(" ❯ "))
    : fg(c, bold(`${room} → nobody ❯ `));
  const promptW = width(prompt);
  ic = Math.max(0, Math.min(ic, graphemes(input).length));
  const IL = inputLayout(Math.max(10, W - promptW)), MAXI = Math.max(3, Math.min(10, Math.floor(H / 3)));
  const inTop = IL.rows.length > MAXI ? Math.max(0, Math.min(IL.cRow - MAXI + 1, IL.rows.length - MAXI)) : 0;
  const inputLines = IL.rows.slice(inTop, inTop + MAXI);
  const bottom = 2 + inputLines.length; // input rule + input line(s) + status bar
  const avail = Math.max(1, H - rows.length - bottom);
  if (view !== "board") bv.hide(); // the board's shimmer timer runs only while it is shown
  if (view === "board") {
    const b = bv.frame({ board: board.room === room ? board : null, room, W, avail, c, agents });
    rows[ruleAt] = rule(b.label); lastAvail = avail; rowMeta = {}; convoMsgs = b.items;
    b.rows.forEach((r, i) => { rowMeta[rows.length + 1 + i] = r; });
    rows.push(...b.rows.map((r) => r.line));
  } else if (view !== "stream") drawPane(rows, ruleAt, avail, W, c, rule);
  else {
  // Every message: the author on its own line, the text on the next (no name column).
  const narrow = true, textX = 4, textW = Math.max(10, W - textX + 1 - 1);
  // Each row: { line, msg (index into the room's messages), textX (1-based
  // column where message text starts), hard (last row of a paragraph) }.
  const convo = [];
  // Stream items in time order: messages (mi = index into msgs, for selection) and activity.
  const mode = MODES[filter];
  const acts = (activity[room] || []).filter((x) => !HIDDEN.has(x.kind) && mode.act(x));
  const items = mode.msgs ? msgs.map((m, mi) => ({ ts: m.ts, m, mi })) : [];
  for (const e of acts) items.push({ ts: e.ts, e });
  items.sort((x, y) => x.ts - y.ts);
  // Not everyone marked: only the marked agents' rows (their posts and activity, direct
  // messages to or from them) plus all of Angus's room posts. Nobody marked = just Angus.
  if (!everyone) {
    const names = new Set([...marked].map((id) => agents.find((a) => a.id === id)?.display).filter(Boolean));
    const keep = ({ m, e }) => m ? (m.author?.kind === "human" || marked.has(m.author?.id))
      : marked.has(e.agent?.id) || (e.kind === "prompt" ? false : Array.isArray(e.to) && e.to.some((n) => names.has(n)));
    for (let k = items.length - 1; k >= 0; k--) if (!keep(items[k])) items.splice(k, 1);
  }
  // /stream WORDS: only rows containing every word (text, author, recipients).
  if (words.length) {
    const hay = ({ m, e }) => (m ? `${m.text} ${authorLabel(m.author)}` : `${e.text} ${e.agent?.name || ""} ${(Array.isArray(e.to) ? e.to : []).join(" ")}`).toLowerCase();
    for (let k = items.length - 1; k >= 0; k--) { const h = hay(items[k]); if (!words.every((w) => h.includes(w))) items.splice(k, 1); }
  }
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
  // Every stream item (message or activity) is selectable: its rows carry msg = its
  // index in sItems, and sItems[i].copy is what a Shift-selection copies.
  const sItems = [];
  items.forEach(({ m, e }) => {
    const mi = sItems.push({ copy: "", key: m ? `m${m.seq}` : `e${e.ts}|${e.agent?.id || ""}|${e.kind}` }) - 1;
    if (e) {
      const au = e.agent || {};
      // In the stream: icon + full name (only the prompt line uses icons alone).
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
        if (parts.length <= 1) return convo.push({ line: "   " + text, msg: mi, textX, hard: true, act: true });
        convo.push({ line: "   " + clip(text, width(parts[0])), msg: mi, textX, act: true });
        parts.slice(1).forEach((l, k) => convo.push({ line: "   " + (loud ? l : dim(l)), msg: mi, textX, hard: k === parts.length - 2, act: true }));
      };
      if (direct) {
        const from = e.kind === "prompt" ? fg(c, bold("Angus")) : sender;
        const to = e.kind === "prompt" ? sender : tos;
        const self = e.kind === "prompt" ? "Angus" : (au.name || "");
        let body = afterColon(e.text);
        const lead = new RegExp(`^\\s*(?:\\S+\\s+)?${self.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*[:,—-]\\s*`, "u");
        if (self) body = body.replace(lead, "");
        if (convo.length) convo.push({ line: "", msg: null });
        convo.push({ line: `   ${from} ${direct} ${to}`, msg: mi, header: true, act: true });
        sItems[mi].copy = `${strip(from)} ${direct} ${strip(to)}: ${body}`;
        push(body, true);
        lastAct = "direct:" + au.id; // the next activity starts a new block
        return;
      }
      // Topics: mid tone, italic. Agent events (joined, left, renamed, moved, model): mid tone.
      // Errors and "needs you": normal text. Tool lines and Esc stops: dim.
      const MID = new Set(["joined", "left", "renamed", "moved", "model"]);
      const line = e.kind === "blocked" ? "needs you" : e.kind === "error" ? e.text
        : e.kind === "topic" ? midFg(`${ESC}3mtopic: ${e.text}${ESC}23m`) : MID.has(e.kind) ? midFg(e.text) : dim(e.text);
      if (lastAct !== au.id) {
        if (convo.length) convo.push({ line: "", msg: null });
        convo.push({ line: "   " + sender, msg: mi, header: true, act: true });
      }
      sItems[mi].copy = `${au.name || "agent"}: ${strip(line)}`;
      push(line, e.kind === "blocked" || e.kind === "error" || e.kind === "topic" || MID.has(e.kind));
      lastAct = au.id;
      return;
    }
    lastAct = null;
    const au = m.author || {};
    sItems[mi].copy = `${authorLabel(au)}: ${m.text}`;
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
  // Selected item (Ctrl+↑↓): a bar in the world colour on all its rows and the selection
  // background on its first row (like a selected search result); keep it in view.
  streamKeys = sItems.map((x) => x.key);
  const selIdx = streamSel == null ? -1 : streamKeys.indexOf(streamSel);
  if (streamSel != null && selIdx < 0) streamSel = null; // filtered away
  if (selIdx >= 0) {
    const r0 = convo.findIndex((r) => r.msg === selIdx), r1 = convo.findLastIndex((r) => r.msg === selIdx);
    const top = convo.length - avail - scroll;
    if (r0 >= 0 && r0 < top) scroll = convo.length - avail - r0;
    else if (r1 >= 0 && r1 >= top + avail) scroll = Math.max(0, convo.length - r1 - 1);
    const hl = theme.muted || theme.selection;
    let first = true;
    for (const r of convo) {
      if (r.msg !== selIdx || !r.line) continue;
      let rest = r.line.startsWith("   ") ? r.line.slice(3) : r.line;
      if (first && hl) rest = `${ESC}48;2;${rgb(hl)}m${rest}${ESC}49m`;
      r.line = " " + fg(c, "▌") + " " + rest;
      first = false;
    }
  }
  scroll = Math.max(0, Math.min(scroll, convo.length - avail));
  const streamLabel = FILTER_LABEL[filter];
  rows[ruleAt] = rule(`${streamLabel} (^F)` + (selIdx >= 0 ? ` · ${selIdx + 1}/${sItems.length} (^↑↓, Esc)` : "") + onlyLabel() + (words.length ? ` · filter: ${words.join(" ")}` : "") + (scroll > 0 ? ` · ↓ ${scroll} more line${scroll === 1 ? "" : "s"} below (^End)` : ""));
  const shown = convo.slice(Math.max(0, convo.length - avail - scroll), convo.length - scroll);
  if (!convo.length) shown.push({ line: dim(words.length ? `  (nothing matches "${words.join(" ")}" · /stream alone clears)` : MODES[filter].msgs ? "  (no messages yet)" : "  (no activity yet)"), msg: null });
  while (shown.length < avail) shown.unshift({ line: "", msg: null });
  rowMeta = {}; convoMsgs = sItems;
  shown.forEach((r, i) => { rowMeta[rows.length + 1 + i] = r; });
  rows.push(...shown.map((r) => r.line));
  }

  // Input line(s)
  rows.push(fg(c, "─".repeat(W)));
  const slash = /^\/[^\s/]*$/.test(input) && !note.startsWith("✗") ? completions(input) : null; // typing a command: show the matches (an error about it wins)
  // Board: "thinking…" shimmers while a project's agents work on a request (then the note).
  const bs = view === "board" ? bv.status(c) : "";
  const boardHint = bs ? "  " + bs + (note ? dim("  " + note) : "")
    : dim(note || (bvOpen ? `text → @${bvOpen.name}'s members · D1 b answers · N2 ? asks · /todo /note /done · Esc whole board` : "@project text · @project alone opens it · D1 b answers · N2 ? asks · /drop H3 · /help · ^B stream"));
  const hint = slash ? dim("  " + (slash.length ? slash.join(" · ") + (slash.length === 1 ? "  (Tab)" : "") : "unknown command · /help"))
    : input ? (bs ? "  " + bs : "") + (note ? dim("  " + note) : "") : view === "help" ? dim("Esc back")
    : view === "board" ? boardHint : dim(confirm ? confirm.label : note || (W < 72 ? "message the room" : (confirm ? confirm.label : "message the room · ^↑↓ scroll · ⌥↑↓ pick a row · ⇧⏎ new line · ⇧←→↑↓ select · ^F filter · / commands · ^Tab world")));
  inputLines.forEach((l, i) => rows.push((i === 0 ? prompt : " ".repeat(promptW)) + l + (i === 0 ? hint : "")));

  // tmux-style status bar
  const tabs = rooms.map((r) => r.id === room ? `${ESC}${worldBg(r.id)};30m ${r.id} ${ESC}49;39m` : ` ${fg(worldFg(r.id), r.id)} `).join("");
  const left = ` hyprpi ${online ? "" : "· daemon offline "}`;
  const right = `history ${historyN} · ${hhmm(Date.now())} `;
  const mid = W - width(left) - width(strip(tabs)) - width(right);
  rows.push(`${ESC}7m${left}${ESC}27m${tabs}${ESC}7m${" ".repeat(Math.max(0, mid))}${right}${ESC}27m`);

  out(`\x1b]2;hyprpi-room ${room}\x07`); // not "hyprpi room …": the daemon treats those titles as room windows
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
  // Cursor at ic inside the (possibly multi-line, wrapped) message.
  const crow = H - inputLines.length + (IL.cRow - inTop), ccol = Math.min(W, promptW + IL.cCol + 1);
  out(`${ESC}${crow};${ccol}H${ESC}?25h`);
}

// The pane when it isn't the stream: /help.
let askTop = 0;
function drawPane(rows, ruleAt, avail, W, c, rule) {
  const pane = ["", ...helpRows()];
  rows[ruleAt] = rule("commands (Esc back)");
  rowMeta = {}; resultRowMap = {}; lastAvail = avail;
  rows.push(...pane.slice(0, avail));
  for (let k = pane.length; k < avail; k++) rows.push("");
}

function setView(v) {
  if (v === view) return render();
  view = v; confirm = null; note = "";
  render();
}

async function loadRoom(r) {
  if (!api || !r) return;
  try {
    const res = await api.call("history.read", { room: r, interactions: historyN });
    messages[r] = res.messages || []; activity[r] = res.events || [];
  } catch { // older daemon
    try { const res = await api.call("room.read", { room: r, tail: true, limit: 200 }); messages[r] = res.messages || []; } catch { /* keep old */ }
    try { const res = await api.call("activity.read", { room: r, limit: 300 }); activity[r] = res.events || []; } catch { /* none */ }
  }
  render();
}

let lastFocusedId = "";
// Feedback before the daemon confirms: agents being closed / killed (id -> kind)
// and agents being opened ({ cwd, t, known: ids that existed then }).
const closing = new Map();
let pendingNew = [];
function applyList(r) {
  agents = r.agents || []; rooms = r.rooms || []; dormant = r.dormant || [];
  for (const id of closing.keys()) if (!agents.find((a) => a.id === id)) closing.delete(id);
  for (const a of agents) { // each newly listed agent replaces one placeholder
    const i = pendingNew.findIndex((p) => !p.known.has(a.id));
    if (i >= 0) {
      pendingNew.splice(i, 1); for (const p of pendingNew) p.known.add(a.id);
      // The agent we just opened: jump to its window (it may be on another workspace —
      // `hyprpi new` avoids a workspace in panel mode).
      api?.call("agent.focus", { agent: a.id }).then(() => { note = "\u2192 " + a.display; render(); }).catch(() => {});
    }
  }
  // Focusing an agent's window moves the list cursor to it (and scrolls it into view).
  const f = agents.find((a) => a.focused);
  lastFocusedId = f ? f.id : "";
  if (!room) room = r.active_room || rooms[0]?.id || "A";
  if (!rooms.find((x) => x.id === room)) rooms = [...rooms, { id: room }].sort((a, b) => a.id.localeCompare(b.id));
  render();
}

// This world's project board (lib/board.mjs via the daemon's board.get): projects are
// addressable as @name like agents ("@hyprpi-boards text" goes to its members).
let board = { room: "", projects: [], names: {}, live: {} };
async function loadBoard() {
  if (!api) return;
  const r = room;
  try { const b = await api.call("board.get", { room: r }); if (r === room) { board = b; await bv.refresh(api, r, b); render(); } } catch { /* older daemon */ }
}
const hereProjects = () => (board.room === room ? board.projects : []).filter((p) => p.status !== "archived");
// Agents and projects, for @completion (projects marked 📋 in the list shown).
const atPool = () => [...hereAgents(), ...hereProjects().map((p) => ({ id: p.id, name: p.name, display: p.name, project: true }))];

// The marks (▸) are the daemon's per-room selection: panel 1 sets them, this panel follows.
async function loadMarks() {
  if (!api) return;
  try { marks = await api.call("selection.get", { room }); } catch { marks = { all: true, agents: [] }; }
  render();
}

async function start() {
  if (restarting) return;
  try {
    api = await connect({
      onEvent: (ev, data) => {
        if (ev === "agents") applyList(data);
        else if (ev === "selection" && data?.room === room) { marks = data; render(); }
        else if (ev === "board" && data?.room === room) loadBoard();
        else if (ev === "message" && data?.room) { (messages[data.room] ||= []).push(data); if (data.room === room) render(); }
        else if (ev === "activity" && data?.room) { const t = (activity[data.room] ||= []); t.push(data); if (t.length > 50000) t.splice(0, t.length - 40000); if (data.room === room) render(); }
      },
      onClose: () => { online = false; api = null; render(); setTimeout(start, 1500); },
    });
    online = true;
    applyList(await api.call("ui.subscribe", { windows: false }));
    await loadRoom(room);
    await loadMarks();
    loadBoard();
  } catch { online = false; render(); setTimeout(start, 1500); }
}

function cycle(d) {
  if (!rooms.length) return;
  const i = rooms.findIndex((r) => r.id === room);
  room = rooms[(i + d + rooms.length) % rooms.length].id;
  note = ""; scroll = 0; lastConvoLen = 0; streamSel = null; confirm = null; bv.focus(null); render(); loadRoom(room); loadMarks(); loadBoard();
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
  pendingNew.push({ cwd, t: Date.now(), known: new Set(agents.map((a) => a.id)) });
  setTimeout(render, 30500); // drop the placeholder if the agent never shows up
  note = ""; render();
}

// Where the last interaction was: "results" (a search result selected) or "input".
let focusArea = "input";
function command(text) {
  const m = /^\/([^\s/]+)(?:\s+([\s\S]*))?$/.exec(text);
  if (!m || text.startsWith("//")) return false;
  const arg = (m[2] || "").trim();
  input = ""; ic = 0; note = "";
  switch (m[1].toLowerCase()) {
    case "new": newAgent(arg); return true;
    case "room": filter = "room"; words = []; scroll = 0; lastConvoLen = 0; setView("stream"); return true;
    case "stream": words = arg ? arg.toLowerCase().split(/\s+/) : []; scroll = 0; lastConvoLen = 0; setView("stream"); if (!arg) { note = "stream filter cleared"; render(); } return true;
    case "search": case "ai": case "ask": note = `\u2717 /${m[1]} lives in the search panel \u00b7 SUPER+ALT+/`; render(); return true;
    case "history": {
      if (!arg) { note = `history: ${historyN === "all" ? "everything" : "last " + historyN + " interactions"} · /history N or /history all`; render(); return true; }
      const n = /^all$/i.test(arg) ? "all" : Number.parseInt(arg, 10);
      if (n !== "all" && !(n > 0)) { note = "✗ /history takes a number or all"; render(); return true; }
      historyN = n; scroll = 0; lastConvoLen = 0;
      note = `history: ${n === "all" ? "everything" : "last " + n + " interactions"} (stream and /ask)`;
      setView("stream"); loadRoom(room); return true;
    }
    case "help": setView("help"); return true;
    case "tinker":
      if (!arg) { input = "/tinker "; ic = graphemes(input).length; note = "/tinker what to fix: it goes to a free agent in the workshop world"; render(); return true; }
      if (!api) { input = text; ic = graphemes(text).length; note = "✗ daemon offline"; render(); return true; }
      api.call("tinker", { text: arg, via: "room-tui" })
        .then((r) => { note = "🔧 " + (r.set ? `workshop is world ${r.set.workshop} now${r.set.previous ? " (was " + r.set.previous + ")" : ""} · ` : "") + (r.nothing ? "nothing to fix given" : r.queued ? `queued for the workshop (room ${r.room})${r.spawning ? ", opening an agent" : ""}` : `dropped off in the workshop (room ${r.room})`); render(); })
        .catch((e) => { input = text; ic = graphemes(text).length; note = "✗ " + e.message; render(); });
      render(); return true;
  }
  input = text; ic = graphemes(text).length; note = `\u2717 unknown command /${m[1]} \u00b7 /help lists them \u00b7 to say it instead, start with //`; render();
  return true;
}

// Board mode: what is typed goes to the board (a board command, @project …); anything
// the board doesn't know (/room, /history, …) falls through to the panel's own commands.
async function boardSend(raw) {
  input = ""; ic = 0; note = "";
  try {
    const r = await bv.input(raw, { api, room, board: board.room === room ? board : { projects: [] } });
    if (r) { note = r.note; return render(); }
  } catch (e) { input = raw; ic = graphemes(raw).length; note = "✗ " + e.message; return render(); }
  if (command(raw)) return;
  input = raw; ic = graphemes(raw).length; note = "✗ not a board command · /help"; render();
}
function toggleBoard() {
  if (view === "board") { view = "stream"; note = ""; return render(); }
  view = "board"; confirm = null; note = ""; loadBoard(); render();
}

async function send() {
  const raw = input.trim();
  if (view === "board" && raw) return boardSend(raw);
  if (command(raw)) return;
  if (view === "help") view = "stream";
  input = ""; ic = 0;
  const text = raw.startsWith("//") ? raw.slice(1) : raw;
  if (!text && !api) return render();
  if (!text) return render(); // Enter on an empty line: nothing to post (the agents live in panel 1)
  if (!api) return render();
  // "@Lippy @Sankey" on its own: that is who messages go to from now on ("to:", the same
  // selection as the agent panel's marks). @all / @everyone = everyone, @nobody = nobody.
  if (onlyAt(text)) {
    if (resolveAt(parseAt(text).names, hereProjects().map((p) => ({ id: p.id, name: p.name, display: p.name }))).found.length) { input = raw + " "; ic = graphemes(input).length; note = "a project takes a message: @project what you want to say"; return render(); }
    const r = resolveAt(parseAt(text).names, hereAgents());
    if (r.unknown.length) { input = raw; ic = graphemes(raw).length; note = `✗ no agent ${r.unknown.map((n) => "@" + n).join(" ")} in room ${room} (Tab completes names)`; return render(); }
    const p = r.special === "all" && !r.ids.length ? { room, all: true } : { room, agents: r.ids };
    try { marks = await api.call("selection.set", p); note = p.all ? "to: everyone" : r.ids.length ? "to: " + r.found.map((a) => "@" + a.display).join(" ") : "to: nobody (written in the room, sent to no agent)"; }
    catch (e) { note = "✗ " + e.message; }
    return render();
  }
  // Everyone marked: a room post (or @Name tokens: just them). Some marked: directly to them.
  // Nobody marked: written in the room, delivered to no agent.
  const m0 = markedIds(), all0 = allMarked();
  let targets = all0 ? [] : [...m0], body = text;
  // "@Name text": just to them this once, whoever "to:" is.
  const at = text.match(/^((?:@\S+[\s,]+)+)([\s\S]+)$/);
  if (at) {
    // "@project text": to that project's members (a room message tagged with the project).
    const pr = resolveAt(parseAt(at[1]).names, hereProjects().map((p) => ({ id: p.id, name: p.name, display: p.name })));
    if (pr.found.length) {
      if (pr.found.length > 1 || parseAt(at[1]).names.length > 1) { input = raw; ic = graphemes(raw).length; note = "✗ one @project at a time, without agent names"; return render(); }
      try { const r = await api.call("board.request", { room, project: pr.ids[0], text: at[2], where: "room", via: "room-tui" }); note = `→ @${r.name}: ${r.told.join(", ")}`; }
      catch (e) { input = raw; ic = graphemes(raw).length; note = "✗ " + e.message; }
      return render();
    }
    const r = resolveAt(parseAt(at[1]).names, hereAgents());
    if (r.unknown.length) { input = raw; ic = graphemes(raw).length; note = `✗ no agent ${r.unknown.map((n) => "@" + n).join(" ")} in room ${room} (Tab completes names)`; return render(); }
    if (r.ids.length) { targets = r.ids; body = at[2]; }
  }
  // Nobody marked and no @name / @project given: write it in the room, send it to no agent.
  // (Checked after @names, so "@Name text" / "@project text" still go out: review finding 4.)
  if (!all0 && !m0.size && !targets.length) {
    try { await api.call("room.post", { room, text, as_human: true, via: "room-tui", deliver: false }); note = "written to the room · sent to nobody"; }
    catch (e) { note = "✗ " + e.message; }
    return render();
  }
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
const KEY = /\x1b[bfsS\x7f]|\x1b\[<[\d;]+[Mm]|\x1b\[[\d;]*[A-Za-z~]|\x1bO[A-Za-z]|\x1b|[\s\S]/gu;
process.stdin.on("data", (chunk) => { batching = true; try { for (const [k] of String(chunk).matchAll(KEY)) onKey(k); } finally { batching = false; if (dirty) render(); } });
function onKey(d) {
  if (sel && !d.startsWith("\x1b[<")) { sel = null; dirty = true; }
  // Key model: TOP agent list = Shift (⇧↑↓ cursor, ⇧Space mark) · MIDDLE pane = Ctrl (^↑↓, PgUp/PgDn,
  // ^Home/End) · BOTTOM message box = plain keys (multi-line: ↑↓ lines, ⇧⏎ newline, ⇧←→ select).
  // Ctrl+/ opens the search panel (panel 3) — this panel does not search.
  // Bracketed paste (Super+V / Ctrl+Shift+V): inserted as text, line breaks kept.
  if (d === "\x1b[200~") { pasting = true; return; }
  if (d === "\x1b[201~") { pasting = false; return render(); }
  if (pasting) return insertText(d === "\r" ? "\n" : d);
  // Ctrl+C: copy the selected text, else clear the message; it never quits (too easy to hit
  // while copying). Ctrl+Q quits.
  if (d === "\x03") {
    if (inputSel()) return copyInputSel(false);
    if (input) { input = ""; ic = 0; selA = null; note = ""; return render(); }
    note = "Ctrl+Q quits"; return render();
  }
  if (d === "\x11") return quit(); // Ctrl+Q
  if (d === "\x1b[2;5~") return copyInputSel(false); // SUPER+C (Ctrl+Insert, passed on when kitty has no selection)
  if (d === "\x18") return copyInputSel(true); // Ctrl+X: cut
  if (d === "\x16") return pasteClipboard();   // Ctrl+V: paste
  // Shift+Space (the launcher maps it to CSI 32;2u) or Ctrl+Space: toggle the cursor
  // agent's mark in every view, even while typing (plain Space is text then).
  if (d === "\t" && /^\/[^\s/]*$/.test(input)) { // complete a command
    // One match: complete it (plus a space). Several: their common prefix; Tab
    // again steps through the matches (/s \u2192 /stream \u2192 /search \u2192 /stream \u2026).
    if (tabCycle && tabCycle.list[tabCycle.i] === input) { tabCycle.i = (tabCycle.i + 1) % tabCycle.list.length; input = tabCycle.list[tabCycle.i]; }
    else {
      const cs = completions(input); tabCycle = null;
      if (cs.length === 1) input = cs[0] + " ";
      else if (cs.length) { let p = cs[0]; while (!cs.every((x) => x.startsWith(p))) p = p.slice(0, -1); if (p.length > input.length) input = p; else { tabCycle = { list: cs, i: 0 }; input = cs[0]; } }
    }
    ic = graphemes(input).length;
    return render();
  }
  // Ctrl+Tab / Ctrl+Shift+Tab: next / previous world. Plain Tab never switches world (too
  // easy to hit): it completes an @name (again: the next match; Shift+Tab: back).
  if (d === "\x02") return toggleBoard(); // Ctrl+B: board ⇄ stream
  if (CTRL_TAB.has(d)) return cycle(1);
  if (CTRL_SHIFT_TAB.has(d)) return cycle(-1);
  if (d === "\t" || d === "\x1b[Z") {
    const gs = graphemes(input), before = gs.slice(0, ic).join(""), after = gs.slice(ic).join("");
    const h = view === "board" && bv.complete(before + after, before.length, board.room === room ? board : null, d === "\t" ? 1 : -1);
    if (h) { // an item handle after "@project "
      if (!h.options.length) { note = "no open item by that handle"; return render(); }
      input = h.text; ic = graphemes(h.text.slice(0, h.cursor)).length; selA = null;
      note = h.hint || ""; // the handles (with their @project when it isn't obvious), or the item's text
      return render();
    }
    const r = completeAt(before + after, before.length, atPool(), atCycle, d === "\t" ? 1 : -1);
    if (!r) { note = "Tab completes @names and /commands · Ctrl+Tab switches world"; return render(); }
    if (!r.options.length) { note = "no agent here by that name"; return render(); }
    input = r.text; ic = graphemes(r.text.slice(0, r.cursor)).length; selA = null;
    atCycle = r.state;
    const isProj = (o) => hereProjects().some((p) => p.name === o);
    note = r.options.length > 1 ? r.options.map((o) => (o === r.pick ? "▸" : "") + (isProj(o) ? "📋@" : "@") + o).join("  ") : "";
    return render();
  }
  if (d === "\r") { selA = null; return send(); }
  if (d === "\x1b[13;2u") return insertText("\n"); // Shift+Enter: new line in the message
  if (d === "\x1bs" || d === "\x1bS") return setView(view === "search" ? "stream" : "search"); // Alt+S (still works)
  if (d === "\x1f") { // Ctrl+/: the search panel, on this room
    const env = { ...process.env }; delete env.HYPRPI_AGENT_ID;
    spawn(new URL("./search-tui", import.meta.url).pathname, [room], { detached: true, stdio: "ignore", env }).unref();
    note = "search panel → room " + room; return render();
  }
  if (view === "board" && d === "\x1b" && !inputSel() && (bv.focused || bv.st.help)) { // Esc: the whole board again
    if (bv.st.help) bv.st.help = false; else bv.focus(null);
    note = ""; return render();
  }
  if (view !== "stream" && d === "\x1b") { // Esc: back to the stream
    view = "stream"; note = ""; return render();
  }
  // The stream (Ctrl): Ctrl+↑↓ scrolls a line, PgUp/PgDn a page, Ctrl+Home/End oldest / newest.
  // Plain and Shift arrows belong to the message box below; Alt+↑↓ selects a stream row.
  {
    const page = Math.max(1, lastAvail - 2);
    const sc = { "\x1b[1;5A": 1, "\x1b[1;5B": -1, "\x1b[5~": page, "\x1b[6~": -page, "\x1b[1;5H": Infinity, "\x1b[1;5F": -Infinity }[d];
    if (sc !== undefined) {
      if (view === "board") { bv.scroll(Math.abs(sc) === page ? Math.sign(sc) * bv.page() : sc); return render(); }
      if (view !== "stream") return;
      scroll = sc === Infinity ? 1e9 : sc === -Infinity ? 0 : Math.max(0, scroll + sc);
      focusArea = "stream"; return render();
    }
    // Alt+↑↓ / Alt+Home End: pick a stream row (the selection the mouse also makes).
    const mv = { "\x1b[1;3A": -1, "\x1b[1;3B": 1, "\x1b[1;3H": -Infinity, "\x1b[1;3F": Infinity }[d];
    if (mv !== undefined) {
      if (view !== "stream") return;
      const n = streamKeys.length; if (!n) return render();
      let i = streamSel == null ? n : streamKeys.indexOf(streamSel);
      if (i < 0) i = n;
      i = mv === -Infinity ? 0 : mv === Infinity ? n : i + mv;
      if (i >= n) { streamSel = null; scroll = 0; } else streamSel = streamKeys[Math.max(0, i)];
      focusArea = "stream"; return render();
    }
  }
  // Editing the message: ←/→ (Ctrl or Alt+B/F: by word), Home/End or Ctrl+E
  // while typing, Backspace / Delete at the cursor, Alt+Backspace word, Ctrl+U clear.
  {
    const gs = graphemes(input);
    ic = Math.max(0, Math.min(ic, gs.length));
    const edited = (next, c) => { input = next.join(""); ic = c; selA = null; note = ""; focusArea = "input"; return render(); };
    const wordLeft = () => { let i = ic; while (i > 0 && /\s/.test(gs[i - 1])) i--; while (i > 0 && !/\s/.test(gs[i - 1])) i--; return i; };
    const wordRight = () => { let i = ic; while (i < gs.length && /\s/.test(gs[i])) i++; while (i < gs.length && !/\s/.test(gs[i])) i++; return i; };
    const rs = inputSel();
    const delSel = () => edited([...gs.slice(0, rs[0]), ...gs.slice(rs[1])], rs[0]);
    // Logical lines (split at \n): start / end of the line the cursor is on.
    const lineStart = (i) => { while (i > 0 && gs[i - 1] !== "\n") i--; return i; };
    const lineEnd = (i) => { while (i < gs.length && gs[i] !== "\n") i++; return i; };
    const moveTo = (i, extend) => { if (extend) { if (selA == null) selA = ic; } else selA = null; ic = Math.max(0, Math.min(gs.length, i)); focusArea = "input"; return render(); };
    // Shift+←→ / Ctrl+Shift+←→ / Shift+Home End: select.
    if (d === "\x1b[1;2D") return moveTo(ic - 1, true);
    if (d === "\x1b[1;2C") return moveTo(ic + 1, true);
    if (d === "\x1b[1;6D") return moveTo(wordLeft(), true);
    if (d === "\x1b[1;6C") return moveTo(wordRight(), true);
    if (d === "\x1b[1;2H") return moveTo(lineStart(ic), true);
    if (d === "\x1b[1;2F") return moveTo(lineEnd(ic), true);
    // Shift+↑↓: extend the selection to the line above / below (for ^C ^X).
    if (d === "\x1b[1;2A" || d === "\x1b[1;2B") {
      const s0 = lineStart(ic), col = ic - s0;
      if (d === "\x1b[1;2A") { if (!s0) return moveTo(0, true); const p0 = lineStart(s0 - 1); return moveTo(Math.min(p0 + col, s0 - 1), true); }
      const e0 = lineEnd(ic); if (e0 >= gs.length) return moveTo(gs.length, true);
      const n1 = lineEnd(e0 + 1); return moveTo(Math.min(e0 + 1 + col, n1), true);
    }
    // ↑↓: the previous / next line of the message (same column), else its start / end.
    if (d === "\x1b[A" || d === "\x1b[B") {
      const s0 = lineStart(ic), col = ic - s0;
      if (d === "\x1b[A") { if (!s0) return moveTo(0); const p0 = lineStart(s0 - 1); return moveTo(Math.min(p0 + col, s0 - 1)); }
      const e0 = lineEnd(ic); if (e0 >= gs.length) return moveTo(gs.length);
      const n1 = lineEnd(e0 + 1); return moveTo(Math.min(e0 + 1 + col, n1));
    }
    if (d === "\x1b[D") return moveTo(rs ? rs[0] : ic - 1);
    if (d === "\x1b[C") return moveTo(rs ? rs[1] : ic + 1);
    if (d === "\x1b[1;5D" || d === "\x1bb") return moveTo(wordLeft());
    if (d === "\x1b[1;5C" || d === "\x1bf") return moveTo(wordRight());
    if (d === "\x1b[H" || d === "\x1b[1~") return moveTo(lineStart(ic));
    if (d === "\x05" || d === "\x1b[F" || d === "\x1b[4~") return moveTo(lineEnd(ic));
    if (d === "\x7f" || d === "\b") { if (rs) return delSel(); if (!ic) return; return edited([...gs.slice(0, ic - 1), ...gs.slice(ic)], ic - 1); }
    if (d === "\x1b[3~") { if (rs) return delSel(); if (ic >= gs.length) return; return edited([...gs.slice(0, ic), ...gs.slice(ic + 1)], ic); }
    if (d === "\x1b\x7f") { const i = wordLeft(); return edited([...gs.slice(0, i), ...gs.slice(ic)], i); }
    if (d === "\x15") return edited([], 0); // Ctrl+U
  }
  if (d === "\x0e") return newAgent(); // Ctrl+N
  if (d === "\x06") { if (view !== "stream") setView("stream"); filter = FILTERS[(FILTERS.indexOf(filter) + 1) % FILTERS.length]; scroll = 0; lastConvoLen = 0; note = `showing ${FILTER_LABEL[filter]}`; return render(); } // Ctrl+F
  // Scrolling: mouse wheel (SGR mouse reports), ↑/↓ line, PgUp/PgDn page, Home/End.
  if (d.startsWith("\x1b[<")) {
    for (const m of d.matchAll(/\x1b\[<(\d+);(\d+);(\d+)([Mm])/g)) {
      const b = Number(m[1]), x = Number(m[2]), y = Number(m[3]);
      const inList = false; // no agent pane in this panel
      // Left button: press starts a possible selection, motion drags it,
      // release copies it (or, without a drag, counts as a click).
      // (+4 = Shift held; kitty passes Shift through: terminal_select_modifiers.)
      if (b === 0 && m[4] === "M" && view === "board" && bv.click(rowMeta[y], x)) { sel = null; continue; } // a card's −/+ marker: fold / unfold
      if ((b === 0 || b === 4) && m[4] === "M") {
        focusArea = inList ? "list" : view === "search" && resultRowMap[y] !== undefined ? "results" : "input";
        const inConvo = !!rowMeta[y], now = Date.now();
        // Count quick presses on the same spot: 2 = word, 3 = whole message (or line).
        clicks = b === 0 && now - lastPress.t < 400 && y === lastPress.y && Math.abs(x - lastPress.x) <= 1 ? clicks + 1 : 1;
        lastPress = { x, y, t: now };
        sel = { x0: x, y0: y, x1: x, y1: y, dragging: false, clicks, mode: b === 4 && inConvo ? "msg" : inConvo ? "text" : "plain" };
        continue;
      }
      if ((b === 32 || b === 36) && sel) { sel.x1 = x; sel.y1 = y; sel.dragging = true; continue; }
      if ((b === 0 || b === 4) && m[4] === "m" && sel) {
        sel.x1 = x; sel.y1 = y;
        if ((sel.dragging || sel.mode === "msg") && selRange()) { copy(selectedText()); continue; } // highlight stays until the next key or click
        if (sel.clicks >= 2 && !inList && !(view === "search" && resultRowMap[y] !== undefined)) { multiClick(sel.clicks, x, y); continue; }
        sel = null;
        continue;
      }
      if (b === 64 || b === 65) { // wheel: agent list or conversation, whichever is under the pointer
        if (view === "board") bv.scroll(b === 64 ? 3 : -3); else scroll += b === 64 ? 3 : -3;
      }
    }
    return render();
  }
  if (d === "\x1b") { if (inputSel()) { selA = null; return render(); } if (streamSel != null) { streamSel = null; return render(); } confirm = null; note = ""; if (api) api.call("selection.set", { room, all: true }).then((m) => { marks = m; render(); }).catch(() => {}); return render(); } // Esc: text selection, else mark every agent again
  if (d.startsWith("\x1b")) return; // other keys: ignore in the mockup
  if (!d.replace(/[\x00-\x1f]/g, "")) return;
  insertText(d); // typing replaces the selection
}
function quit() { out(`${ESC}?2004l${ESC}?1002l${ESC}?1000l${ESC}?1006l${ESC}?1049l${ESC}?25h`); process.exit(0); }
process.on("SIGTERM", quit);

// Restart when the TUI's own code changes (a hyprpi update), so an open panel is never
// stale: same room, same window. Not while something is typed or a search is running.
const CODE = [new URL("./room-tui.mjs", import.meta.url).pathname,
  ...["client.mjs", "paths.mjs", "search-view.mjs", "at-names.mjs", "tui/board-view.mjs", "tui/shimmer.mjs"].map((f) => new URL("../lib/" + f, import.meta.url).pathname)];
const codeStamp = () => CODE.map((f) => { try { return fs.statSync(f).mtimeMs; } catch { return 0; } }).join(",");
const codeAtStart = codeStamp();
setInterval(() => {
  if (restarting || codeStamp() === codeAtStart || input.trim()) return;
  restarting = true;
  try { api?.close?.(); } catch { /* fine */ }
  out(`${ESC}?2004l${ESC}?1002l${ESC}?1000l${ESC}?1006l${ESC}?1049l${ESC}?25h`);
  spawn(process.execPath, [CODE[0], room], { stdio: "inherit", env: process.env })
    .on("exit", (code) => process.exit(code ?? 0));
  process.stdin.setRawMode?.(false); process.stdin.pause();
}, 3000);
process.stdout.on("resize", render);
setInterval(render, 30000); // clock
out(`${ESC}?1049h${ESC}?1000h${ESC}?1002h${ESC}?1006h${ESC}?2004h`); // alt screen + mouse (wheel, click, drag-select) + bracketed paste
render();
start();
