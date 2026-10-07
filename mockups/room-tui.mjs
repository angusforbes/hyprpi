#!/usr/bin/env node
// Panel 2 (docs/panels-plan.md): the hyprpi STREAM panel, SUPER+ALT+R (the file keeps its old
// name, room-tui, and its window title "hyprpi-room C": the launchers and the daemon find it by that).
// One world's timeline, read-only (Angus 2026-09-30, @hyprpi N40; lib/stream.mjs): agents' posts,
// per-turn did lines (one line when the turn also posted: the post), topics, agent events,
// agent-to-agent talk, Angus's prompts, board changes and project moves, Thoughts' 💭 lines; each
// with its project when known. Ctrl+F cycles the views: full text → compact (one line each) →
// topics (topic changes only, drawn as before the Stream: the agent's name, its topics under it; no times) →
// all activity (J147: full text plus upkeep, Thoughts' automatic notices, ✓ / ×, board bookkeeping).
// Filters (combinable): /stream @Blink @Sankey @hyprpi (a union of agents and projects) · 3h ·
// today · since 9am · words (narrow) · raw (also tool lines); the header shows it, Esc or /stream clears.
//
//   ~/Work/hyprpi/mockups/room-tui [ROOM]   (kitty launcher with the mouse settings)
//
// The box still sends, as before (Angus): typing + Enter posts to the room as Angus (every agent in
// it gets it); "@Name text" goes just to them, "@project text" to a project's owner.
// The project board has its own panel (SUPER+ALT+P, mockups/board-tui.mjs); the old in-panel board view (Ctrl+B) is gone (J210).
// Keys: wheel / Shift+↑↓ / PgUp PgDn / Home End scroll · Ctrl+↑↓ select a stream row ·
// Ctrl+Tab / Ctrl+Shift+Tab switch world (Tab cycles @projects, Shift+Tab @agents, Tab completes /commands) · search: SUPER+ALT+/ (the Thoughts panel) ·
// Esc drops a selection · Ctrl+Q quits (Ctrl+C copies).
// Commands: /stream [FILTER] · /history N|all · /help ·
// "//text" is only for saying something that starts with a slash (it would otherwise be
// read as a command): "//stream is down" posts "/stream is down". Ordinary messages need nothing.
// "@Name text" goes just to them; "/stream @Name" shows only their rows; Tab
// completes @names (lib/at-names.mjs, shared with the search panel's @Name scope).
// Drag selects and copies message text, Shift+click/drag whole messages, double-click a
// word, triple-click a whole message. No ROOM = the current world's room; several copies
// can run at once: each is just another subscriber of the daemon.

import { connect } from "../lib/client.mjs";
import { parseAt, onlyAt, resolveAt, completeAt } from "../lib/at-names.mjs";
import { createInputBox, createHistory, atTint, boxHit } from "../lib/tui/input-box.mjs";
import { createCommands } from "../lib/tui/command-line.mjs";
import { buildStream, parseStreamFilter, resolveFilterNames, filterStream, streamLine, DIRECT } from "../lib/stream.mjs";
// Panel 2 has no search: SUPER+ALT+/ opens the search panel (panel 3).
// Commands: the room's own (below, in `command`) plus the ones every panel has (/help, /tinker,
// /quit), all through lib/tui/command-line.mjs.
const completions = (prefix) => cmds.complete(prefix);
import { sentLine, SENT_STICKY_MS } from "../lib/tui/sent.mjs"; // J165
import { wordAt, urlIn, agentIn, bareName } from "../lib/tui/agent-click.mjs";
import { worldTabAt, stepTo } from "../lib/tui/world-tabs.mjs";
let worldBar = null;
const helpRows = () => {
  const list = cmds.help(), w = Math.max(12, ...list.map(([c]) => c.length));
  return [
    ...list.map(([c, d]) => `   ${bold(c.padEnd(w))}  ${d}`),
    "",
    `   ${bold("//text".padEnd(w))}  ${dim("only needed to SAY something starting with \"/\": //stream is down → posts \"/stream is down\"")}`,
    `   ${bold("/stream FILTER".padEnd(w))}  ${dim("@Blink @Sankey @hyprpi (agents or projects, any of them) · 3h · today · since 9am · words (all of them) · raw (tool lines too); combinable")}`,
    `   ${bold("".padEnd(w))}  ${dim("e.g. /stream @hyprpi 3h commit · /stream alone or Esc clears · ^F cycles full → compact → topics → all activity")}`,
    `   ${bold("@Name text".padEnd(w))}  ${dim("just to them, this once · Tab cycles @projects, Shift+Tab @agents · copy @names into the search box to search their history")}`,
    `   ${dim("mouse: drag = text · Shift+drag = whole messages · double-click = word · triple-click = whole message · each copies")}`,
    `   ${dim("stream: ^↑↓ scroll a line · PgUp PgDn page · ^Home/End oldest/newest · ⌥↑↓ pick a row · ^F views: full → compact (one line each) → topics (topic changes only) → all activity (also upkeep, notices, ✓ / ×)")}`,
    `   ${dim("message box: ↑↓ lines, then the start / end, then your earlier messages · ←→ move · ⇧←→↑↓ select · ⇧⏎ new line · ^C copy · ^X cut · ^V paste · ⏎ send")}`,
    `   ${dim("agents: SUPER+ALT+A · projects: SUPER+ALT+P · thoughts: SUPER+ALT+/")}`,
    `   ${dim("the projects panel (the board) is its own panel: SUPER+ALT+P")}`,
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
// The editing itself is the shared message box (lib/tui/input-box.mjs, like the board panel):
// this panel keeps its own variables (input, ic, selA) and loads them
// into the box before each edit, then reads them back.
// The box keeps its state in this panel's variables (input, ic, selA) through
// bind: every box operation reads them first and writes them back after (Angus, N55: no glue here).
const box = createInputBox({
  onChange: () => render(), copy: (t) => copy(t), multiline: true,
  drafts: `stream-${(process.argv[2] || "any").toUpperCase()}`, // J194: unsent draft kept across close/crash, cleared drafts ring (Ctrl+Z / Alt+Z)
  bind: {
    read: () => ({ text: input, cursor: ic, anchor: selA }),
    write: (st) => { input = st.text; ic = st.cursor; selA = st.anchor; },
  },
  // ↑↓ as in every panel (Angus, N51): lines, then the start / end, then your earlier messages.
  history: createHistory("stream"), historyNotes: { first: "that's your first message here", none: "no earlier messages yet" },
  tint: atTint((name) => { const r = resolveAt([name], atPool()), a = r.found[0]; return a?.project ? { project: true } : a ? { agent: a } : r.special ? { special: true } : null; },
    { worldFg: (x) => fg(worldFg(room), x), bold, nameFg }),
});
// Rows of the input (styled, selection highlighted) and the cursor's row / column.
// Insert text at the cursor, replacing the selection (paste keeps its line breaks).
// J165: a "✓ Sent to …" line stays SENT_STICKY_MS even while Angus types on (Sentcheck).
function insertText(t) { box.insert(t); if (!keepSent()) note = ""; focusArea = "input"; render(); }
const keepSent = () => note.startsWith("✓") && Date.now() - noteAt < SENT_STICKY_MS; // every editing path keeps it (Sentcheck)
function sentNote(t) { note = t; noteSeen = t; noteAt = Date.now(); } // stamped per send, even when the text repeats
const sentW = () => Math.max(30, (process.stdout.columns || 80) - 18);
function copyInputSel(cut) { box.copySel(cut); render(); }
const hhmm = (ts) => { const d = new Date(ts); return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`; };
const home = (p) => String(p || "").replace(/^\/home\/[^/]+/, "~");

let scroll = 0, lastConvoLen = 0, lastAvail = 10; // scroll = lines up from the newest
let convoY = 0, confirm = null;
// (The ▸ marks are retired: messages go to the room, @Name or @project; /stream @Name filters.)
const listRowY = 0, listRows = 0; // no agent pane here (kept so the copy code reads the same)
const hereAgents = () => agents.filter((a) => a.room === room);
// Greyed agents under the live ones; Ctrl+O cycles how many:
//   0 live + those lost to a restart / reboot   [default]
//   1 + parked (Reprieve, SUPER+W; still running) and closed/killed while hyprpi ran
// Enter: a closed one is resumed (same id, name, twins), a parked one is moved back to
// this workspace. ^W twice on a closed one drops it from the list (its session stays).
let dormant = [];
let agents = [], rooms = [], room = (process.argv[2] || "").toUpperCase(), messages = {}, input = "", note = "", online = false;
// The Stream: room messages, agent activity and board changes (lib/stream.mjs builds the timeline).
let activity = {}, changes = {}; // room -> activity events · board changes
// Ctrl+F cycles the views: full text, compact (one line per item), topics (topic changes only), all activity
// (J147: full text plus what the others hide: upkeep, Thoughts' automatic notices, ✓ / ×, board bookkeeping).
const SVIEWS = ["full", "compact", "topics", "all"];
const SVIEW_LABEL = { full: "full", compact: "compact", topics: "topics", all: "all activity" };
let sview = "full";
let streamArg = "";    // the /stream filter as typed ("" = everything)
let sfCache = { k: null, f: null };
const streamFilter = (a, minute) => { const k = a + "|" + minute; if (sfCache.k !== k) sfCache = { k, f: parseStreamFilter(a) }; return sfCache.f; }; // (re-parsed each minute: "3h" slides)
// The timeline, rebuilt only when something arrived (typing must stay fast).
let streamCache = { key: "", items: [] };
function streamItems(raw, all = sview === "all") {
  const msgs = messages[room] || [], acts = activity[room] || [], ch = changes[room] || [], ps = board.room === room ? board.projects : [];
  const key = `${room}|${msgs.length}|${acts.length}|${ch.length}|${raw}|${all}|${ps.map((p) => p.id + p.status + p.members.join()).join()}`;
  if (streamCache.key !== key) streamCache = { key, items: buildStream({ msgs, events: acts, changes: ch, projects: ps, raw, all }) };
  return streamCache.items;
}
// What the pane shows: "stream" | "help".
let view = "stream";
let resultRowMap = {}; // screen row -> search result index (clicks)
let tabCycle = null; // Tab through several matching commands
let atCycle = null;  // Tab through several matching @names (completeAt's state)
const CTRL_TAB = new Set(["\x1b[9;5u", "\x1b[27;5;9~"]), CTRL_SHIFT_TAB = new Set(["\x1b[9;6u", "\x1b[27;6;9~", "\x1b[1;5Z"]); // Ctrl(+Shift)+Tab: world (the launcher maps them; kitty would switch its own tabs)

// /history: how far back the stream and /ask go, in interactions (a room message or one
// agent turn, however many tool calls); "all" = everything. Default 200.
let historyN = 200;
const italic = (s) => `${ESC}3m${s}${ESC}23m`;
let ic = 0; // cursor position in the message being typed, in graphemes
let api = null;

function mark(a) {
  // Same marks as the room window: ● working · ✓ done (unseen) · × blocked · ○ idle
  if (a.status === "working") return "●";
  if (a.status === "background") return "◐"; // J93
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
let boxArea = null; // where render() drew the box (N79: clicks in it, lib/tui/input-box.mjs boxHit)
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
  try { const p = spawn("wl-copy", ["--type", "text/plain;charset=utf-8"], { stdio: ["pipe", "ignore", "ignore"] }); p.on("error", () => {}); p.stdin.on("error", () => {}); p.stdin.end(text); } catch { /* OSC 52 only */ }
  note = `copied ${text.length} character${text.length === 1 ? "" : "s"}`;
}

let batching = false, dirty = false;
const PROF = process.env.HYPRPI_TUI_PROF; // file: one "ms view" line per frame
let restarting = false; // re-exec in progress: the child owns the terminal, draw nothing
function render() { if (restarting) return; if (batching) { dirty = true; return; } if (!PROF) return draw(); const t = performance.now(); draw(); fs.appendFileSync(PROF, `${(performance.now() - t).toFixed(1)} ${view}\n`); }
let noteSeen = "", noteAt = 0; // when the current note appeared (J165)
function draw() {
  if (note !== noteSeen) { noteSeen = note; noteAt = Date.now(); }
  dirty = false;
  const W = process.stdout.columns || 100, H = process.stdout.rows || 30;
  const c = worldFg(room);
  const live = hereAgents();
  const rule = (label = "") => fg(c, "─" + (label ? ` ${label} ` : "") + "─".repeat(Math.max(0, W - 1 - (label ? width(label) + 2 : 0))));
  const rows = [];

  // One header line (Angus): "— room C · <view> (^F)" plus the pane's own hints; the agents
  // live in the agents panel (SUPER+ALT+A).

  const msgs = messages[room] || [];
  const authorLabel = (au = {}) => au.kind === "human" ? au.name || "Angus" : (au.icon ? au.icon + " " : "") + (au.name || "agent");
  const nameW = Math.min(20, Math.max(6, ...msgs.slice(-200).map((m) => width(authorLabel(m.author)))));
  const nameBg = theme.muted || theme.selection;

  // Conversation pane: fill what's left, newest at the bottom.
  convoY = rows.length + 2;
  const ruleAt = rows.length; rows.push(""); // filled in once scroll is clamped below
  // Input: a long message wraps onto further lines (all shown), continuation
  // lines indented under the text.
  // The prompt: "C ❯" (a room post goes to everyone; @Name / @project in the text: just them).
  const prompt = fg(c, bold(`${room} ❯ `)); // J198 (Angus): every panel's prompt is just "D ❯"
  const promptW = width(prompt);
  ic = Math.max(0, Math.min(ic, graphemes(input).length));
  const IL = box.layout(Math.max(10, W - promptW)), MAXI = Math.max(3, Math.min(10, Math.floor(H / 3)));
  const inTop = IL.rows.length > MAXI ? Math.max(0, Math.min(IL.cRow - MAXI + 1, IL.rows.length - MAXI)) : 0;
  const inputLines = IL.rows.slice(inTop, inTop + MAXI);
  boxArea = { y0: H - inputLines.length, n: inputLines.length, inTop, pw: promptW };
  const bottom = 2 + inputLines.length; // input rule + input line(s) + status bar
  const avail = Math.max(1, H - rows.length - bottom);
  if (view !== "stream") drawPane(rows, ruleAt, avail, W, c, rule);
  else {
  // Full: the author (time · @project) on its own line, the text below. Compact: one line each.
  const textX = 4, textW = Math.max(10, W - textX + 1 - 1);
  // Each row: { line, msg (index into sItems), textX (1-based column where the text starts), hard (last row of a paragraph) }.
  const convo = [];
  const sf = streamFilter(streamArg, Math.floor(Date.now() / 60000));
  const projAll = board.room === room ? board.projects : [];
  const all = streamItems(sf.raw);
  const res = sf.names.length ? resolveFilterNames(sf.names, { agents: [...hereAgents(), ...dormant.filter((a) => a.room === room)], projects: projAll, items: all }) : null;
  const filtered = filterStream(all, sf, res); // the /stream filters apply in every view
  const items = sview === "topics" ? filtered.filter((it) => it.kind === "topic") : filtered;
  const compact = sview === "compact";
  const topicsView = sview === "topics"; // drawn like the pre-Stream topics view (Angus, N46): name, then its topics; no times
  const pname = (id) => projAll.find((p) => p.id === id)?.name || "";
  const tagOf = (it) => { const n = it.kind === "board" || topicsView ? "" : pname(it.project); return n ? dim(" · @" + n) : ""; };
  const tm = (ts) => topicsView ? "" : dim(" · " + hhmm(ts));
  const agentByName = (n) => agents.find((x) => x.display === n || x.name === n);
  const styledName = (n) => {
    if (n === "Angus") return fg(c, bold("Angus"));
    const x = agentByName(n);
    return x ? (x.icon ? x.icon + " " : "") + nameFg(x.name, x.color, x.display || n) : bold(n);
  };
  const afterColon = (t) => { const i = String(t).indexOf(": "); return i >= 0 ? String(t).slice(i + 2) : String(t); };
  const MID = new Set(["joined", "left", "renamed", "moved", "model", "resumed"]);
  const sender = (au) => (au.icon ? au.icon + " " : "") + nameFg(au.name, au.color, au.name || "agent");
  const postWho = (au) => au.kind === "human" ? fg(c, bold(cut(authorLabel(au), nameW)))
    : au.markup && width(authorLabel(au)) <= nameW ? (au.icon ? au.icon + " " : "") + bold(markupFg(au.markup, au.color))
    : nameFg(au.name, au.color, cut(authorLabel(au), nameW));
  // A direct message's text: after "…: ", without a leading repeat of the sender's own name.
  const directBody = (it) => {
    const self = it.kind === "prompt" ? "Angus" : (it.who.name || "");
    const lead = new RegExp(`^\\s*(?:\\S+\\s+)?${self.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*[:,—-]\\s*`, "u");
    return self ? afterColon(it.text).replace(lead, "") : afterColon(it.text);
  };
  const actStyle = (it) => it.kind === "blocked" ? "needs you" : it.kind === "error" || it.kind === "turn" ? it.text
    : it.kind === "topic" ? midFg(`${ESC}3mtopic: ${it.text}${ESC}23m`) : MID.has(it.kind) ? midFg(it.text) : dim(it.text);
  let lastAct = null;
  // Every stream item is selectable: its rows carry msg = its index in sItems; sItems[i].copy is
  // what a Shift-selection copies; m / e let Ctrl+click find the row's agent.
  const sItems = [];
  items.forEach((it) => {
    const mi = sItems.push({ copy: streamLine(it, { projectName: pname }), key: it.key, m: it.m, e: it.e }) - 1;
    if (compact) { // one line: time · who [· @project]  text
      const one = (t) => String(t).replace(/\s+/g, " ").trim();
      let head, body;
      if (it.kind === "board") { head = fg(c, "📋 @" + (it.pname || "?")); body = midFg(one(`${it.who.name} ${it.text}`)); }
      else if (DIRECT[it.kind]) {
        head = it.kind === "prompt" ? `${fg(c, bold("Angus"))} to ${sender(it.e.agent || {})}` : `${sender(it.e.agent || {})} ${DIRECT[it.kind]} ${it.to.map(styledName).join(", ")}`;
        body = one(directBody(it));
      } else if (it.m) { head = postWho(it.m.author || {}); body = one(it.text); }
      else { head = sender(it.e.agent || {}); body = actStyle({ ...it, text: one(it.text) }); }
      const pre = `   ${dim(hhmm(it.ts))} ${head}${tagOf(it)}  `;
      convo.push({ line: pre + body, msg: mi, textX: width(pre) + 1, hard: true, act: !it.m });
      return;
    }
    // Full text.
    const push = (text, loud) => {
      const parts = wrap(strip(text), textW);
      if (parts.length <= 1) return convo.push({ line: "   " + text, msg: mi, textX, hard: true, act: true });
      convo.push({ line: "   " + clip(text, width(parts[0])), msg: mi, textX, act: true });
      parts.slice(1).forEach((l, k) => convo.push({ line: "   " + (loud ? l : dim(l)), msg: mi, textX, hard: k === parts.length - 2, act: true }));
    };
    if (it.kind === "board") { // board changes: one block per project run, "Tinker done D4: …"
      const runKey = "board:" + it.project;
      if (lastAct !== runKey) { if (convo.length) convo.push({ line: "", msg: null }); convo.push({ line: `   ${fg(c, bold("📋 @" + (it.pname || "?")))}${tm(it.ts)}`, msg: mi, header: true, act: true }); }
      push(midFg(`${it.who.name} ${it.text}`), true);
      lastAct = runKey; return;
    }
    if (it.e) {
      const au = it.e.agent || {};
      // Direct messages (agent to agent(s), Angus to an agent): their own block, a header
      // "🗃️ Quartermaster to 📊 Sankey, …" with every name in its colour, then the message.
      if (DIRECT[it.kind]) {
        const from = it.kind === "prompt" ? fg(c, bold("Angus")) : sender(au);
        const to = it.kind === "prompt" ? sender(au) : it.to.map(styledName).join(", ");
        if (convo.length) convo.push({ line: "", msg: null });
        convo.push({ line: `   ${from} ${DIRECT[it.kind]} ${to}${tagOf(it)}${tm(it.ts)}`, msg: mi, header: true, act: true });
        push(directBody(it), true);
        lastAct = "direct:" + au.id; // the next activity starts a new block
        return;
      }
      // Other activity: a run from one agent (on one project) shows its name once, then the rows.
      const runKey = au.id + "|" + (topicsView ? "" : it.project || ""); // topics: one run per agent
      if (lastAct !== runKey) {
        if (convo.length) convo.push({ line: "", msg: null });
        convo.push({ line: "   " + sender(au) + tagOf(it) + tm(it.ts), msg: mi, header: true, act: true });
      }
      push(actStyle(it), it.kind === "blocked" || it.kind === "error" || it.kind === "topic" || it.kind === "turn" || MID.has(it.kind));
      lastAct = runKey;
      return;
    }
    lastAct = null;
    const au = it.m.author || {};
    if (convo.length) convo.push({ line: "", msg: null });
    convo.push({ line: `   ${postWho(au)}${tagOf(it)}${tm(it.ts)}`, msg: mi, header: true });
    for (const para of String(it.m.text).split("\n")) { const ls = wrap(para, textW); ls.forEach((l, i) => convo.push({ line: `   ${l}`, msg: mi, textX, hard: i === ls.length - 1 })); }
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
  // Liveness: agents mid-turn, one dim line each at the bottom (their "did" line comes when they finish).
  {
    const inFilter = (a) => !res || res.agentIds.has(a.id) || res.projects.some((p) => p.members?.includes(a.id));
    const busy = hereAgents().filter((a) => a.status === "working" && inFilter(a));
    if (busy.length) { convo.push({ line: "", msg: null }); convo.push({ line: "   " + dim(busy.map((a) => `● ${a.display} working…`).join("   ")), msg: null }); }
  }
  scroll = Math.max(0, Math.min(scroll, convo.length - avail));
  rows[ruleAt] = rule(`stream ${room} · ${SVIEW_LABEL[sview] || sview} (^F)` + (selIdx >= 0 ? ` · ${selIdx + 1}/${sItems.length} (^↑↓, Esc)` : "")
    + (sf.text ? ` · ${sf.text} (Esc clears)` : "") + (res?.unknown.length ? ` · ✗ no ${res.unknown.map((n) => "@" + n).join(" ")}` : "") + (scroll > 0 ? ` · ↓ ${scroll} more line${scroll === 1 ? "" : "s"} below (^End)` : ""));
  const shown = convo.slice(Math.max(0, convo.length - avail - scroll), convo.length - scroll);
  if (!convo.length) shown.push({ line: dim(sf.text ? `  (nothing matches "${sf.text}" · Esc or /stream alone clears)` : sview === "topics" ? "  (no topic changes yet)" : "  (nothing yet)"), msg: null });
  while (shown.length < avail) shown.unshift({ line: "", msg: null });
  rowMeta = {}; convoMsgs = sItems;
  shown.forEach((r, i) => { rowMeta[rows.length + 1 + i] = r; });
  rows.push(...shown.map((r) => r.line));
  }

  // Input line(s)
  rows.push(fg(c, "─".repeat(W)));
  const slash = /^\/[^\s/]*$/.test(input) && !note.startsWith("✗") && cmds.hint(input) !== null ? completions(input) : null; // typing a command: show the matches (an error about it wins; a hidden command like /ignore: none)
  const hint = slash ? dim("  " + (slash.length ? slash.join(" · ") + (slash.length === 1 ? "  (Tab)" : "") : "unknown command · /help"))
    : input ? (note ? (note.startsWith("✓") ? `  ${ESC}32m${bold(note)}${ESC}39m` : dim("  " + note)) : "") : view === "help" ? dim("Esc back")
    : !confirm && note.startsWith("✓") ? `${ESC}32m${bold(note)}${ESC}39m` : dim(confirm ? confirm.label : note || (W < 72 ? "message the room" : (confirm ? confirm.label : "message the room · /stream @Name 3h words · ^F full / compact / topics / all · ^↑↓ scroll · ⌥↑↓ pick a row · ⇧⏎ new line · / commands · ^Tab world")));
  inputLines.forEach((l, i) => rows.push((i === 0 ? prompt : " ".repeat(promptW)) + l + (i === 0 ? hint : "")));

  // tmux-style status bar
  // J198 (Angus): the footer shows only THIS world's letter (highlighted); Ctrl+Tab / Ctrl+Shift+Tab move between worlds.
  const tabs = rooms.filter((r) => r.id === room).map((r) => r.id === room ? `${ESC}${worldBg(r.id)};30m ${r.id} ${ESC}49;39m` : ` ${fg(worldFg(r.id), r.id)} `).join("");
  const left = ` hyprpi stream ${online ? "" : "· daemon offline "}`; // the same label form in every panel (Angus)
  const right = `history ${historyN} `; // no clock (Angus)
  const mid = W - width(left) - width(strip(tabs)) - width(right);
  worldBar = { y: rows.length + 1, x0: width(left) }; // only this world's letter is drawn (J198); a click on it does nothing (lib/tui/world-tabs.mjs)
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
  // One synchronized frame (DEC 2026: kitty shows it all at once) and the cursor is never hidden,
  // so the "thinking…" animation's redraws don't make the text cursor flicker (Angus).
  out(`${ESC}?2026h` + shown2.map((l, i) => `${ESC}${i + 1};1H` + l + `${ESC}0m${ESC}K`).join("") + (shown2.length < H ? `${ESC}${shown2.length + 1};1H${ESC}J` : ""));
  // Cursor at ic inside the (possibly multi-line, wrapped) message.
  const crow = H - inputLines.length + (IL.cRow - inTop), ccol = Math.min(W, promptW + IL.cCol + 1);
  out(`${ESC}${crow};${ccol}H${ESC}?25h${ESC}?2026l`);
}

// The pane when it isn't the stream: /help.
let askTop = 0;
function drawPane(rows, ruleAt, avail, W, c, rule) {
  const pane = ["", ...helpRows()];
  rows[ruleAt] = rule(`stream ${room} · commands (Esc back)`);
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
    // A time filter ("3h", "since 9am") loads from then; otherwise the last N interactions (/history).
    const since = parseStreamFilter(streamArg).since;
    const res = await api.call("history.read", { room: r, ...(since ? { since } : { interactions: historyN }) });
    messages[r] = res.messages || []; activity[r] = res.events || []; changes[r] = res.changes || [];
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
  try { const b = await api.call("board.get", { room: r }); if (r === room) { board = b; render(); } } catch { /* older daemon */ }
}
const hereProjects = () => (board.room === room ? board.projects : []).filter((p) => p.status !== "archived");
// Agents and projects, for @completion (projects marked 📋 in the list shown).
const atPool = () => [...hereAgents(), ...hereProjects().map((p) => ({ id: p.id, name: p.name, display: p.name, project: true }))];

async function start() {
  if (restarting) return;
  try {
    api = await connect({
      onEvent: (ev, data) => {
        if (ev === "agents") applyList(data);
        else if (ev === "board" && data?.room) { if (data.change) (changes[data.room] ||= []).push(data.change); if (data.room === room) loadBoard(); }
        else if (ev === "message" && data?.room) { (messages[data.room] ||= []).push(data); if (data.room === room) render(); }
        else if (ev === "activity" && data?.room) { const t = (activity[data.room] ||= []); t.push(data); if (t.length > 50000) t.splice(0, t.length - 40000); if (data.room === room) render(); }
      },
      onClose: () => { online = false; api = null; render(); setTimeout(start, 1500); },
    });
    online = true;
    applyList(await api.call("ui.subscribe", { windows: false }));
    await loadRoom(room);
    loadBoard();
  } catch { online = false; render(); setTimeout(start, 1500); }
}

function cycle(d) {
  if (!rooms.length) return;
  const i = rooms.findIndex((r) => r.id === room);
  room = rooms[(i + d + rooms.length) % rooms.length].id;
  note = ""; scroll = 0; lastConvoLen = 0; streamSel = null; confirm = null; render(); loadRoom(room); loadBoard();
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
// The room's commands; /help, /tinker and /quit come from lib/tui/command-line.mjs.
const cmds = createCommands({
  commands: [
    { name: "/stream", usage: "/stream [@names…] [3h|today|since 9am] [words] [raw]", help: "filter the Stream: agents and projects (any of them), a time window, words (all of them), raw = tool lines too; alone clears",
      run: (arg) => {
        const had = parseStreamFilter(streamArg).since;
        streamArg = arg || ""; scroll = 0; lastConvoLen = 0; streamSel = null;
        note = arg ? "" : "stream filter cleared";
        setView("stream");
        if (had || parseStreamFilter(streamArg).since) loadRoom(room); // a time window loads from then
      } },
    { name: "/history", usage: "/history N | all", help: "how far back the stream goes (N interactions; default 200)",
      run: (arg) => {
        if (!arg) { note = `history: ${historyN === "all" ? "everything" : "last " + historyN + " interactions"} · /history N or /history all`; render(); return; }
        const n = /^all$/i.test(arg) ? "all" : Number.parseInt(arg, 10);
        if (n !== "all" && !(n > 0)) { note = "✗ /history takes a number or all"; render(); return; }
        historyN = n; scroll = 0; lastConvoLen = 0;
        note = `history: ${n === "all" ? "everything" : "last " + n + " interactions"}`;
        setView("stream"); loadRoom(room);
      } },
  ],
  ctx: {
    panel: "room", world: () => room, worlds: () => rooms.map((r) => r.id), cycle: (d) => cycle(d), agents: () => agents,
    newAgent: (dir) => newAgent(dir),
    api: () => api, via: "room-tui", render: () => render(),
    note: (t) => { note = t; render(); },
    showHelp: () => setView("help"),
    quit: () => quit(),
    setBox: (t) => { input = t; ic = graphemes(t).length; },
  },
});
function command(text) {
  if (!text.startsWith("/") || text.startsWith("//")) return false;
  input = ""; ic = 0; note = "";
  return cmds.run(text);
}

async function send() {
  const raw = input.trim();
  if (raw && !onlyAt(raw.startsWith("//") ? raw.slice(1) : raw)) box.remember(raw); // ↑ brings it back (N51)
  if (command(raw)) return;
  if (view === "help") view = "stream";
  input = ""; ic = 0;
  const text = raw.startsWith("//") ? raw.slice(1) : raw;
  if (!text && !api) return render();
  if (!text) return render(); // Enter on an empty line: nothing to post (the agents live in panel 1)
  if (!api) return render();
  // @names alone: they need a message.
  if (onlyAt(text)) { input = raw + " "; ic = graphemes(input).length; note = "add your message after the @names (a room post goes to everyone)"; return render(); }
  // A room post (every agent in the room gets it), or "@Name text" / "@project text": just them.
  let targets = [], body = text;
  const at = text.match(/^((?:@\S+[\s,]+)+)([\s\S]+)$/);
  if (at) {
    // "@project text": to that project's members (a room message tagged with the project).
    const pr = resolveAt(parseAt(at[1]).names, hereProjects().map((p) => ({ id: p.id, name: p.name, display: p.name })));
    if (pr.found.length) {
      if (pr.found.length > 1 || parseAt(at[1]).names.length > 1) { input = raw; ic = graphemes(raw).length; note = "✗ one @project at a time, without agent names"; return render(); }
      try { const r = await api.call("board.request", { room, project: pr.ids[0], text: at[2], where: "room", via: "room-tui" }); if (r.recipients) sentNote(sentLine(r, { project: "@" + r.name, width: sentW() })); else note = `→ @${r.name}: ${r.told.join(", ")}`; } // J165
      catch (e) { input = raw; ic = graphemes(raw).length; note = "✗ " + e.message; }
      return render();
    }
    const r = resolveAt(parseAt(at[1]).names, hereAgents());
    if (r.unknown.length) { input = raw; ic = graphemes(raw).length; note = `✗ no agent ${r.unknown.map((n) => "@" + n).join(" ")} in room ${room} (Tab completes names)`; return render(); }
    if (r.ids.length) { targets = r.ids; body = at[2]; }
  }
  if (targets.length) {
    const sent = [], failed = [];
    await Promise.all(targets.map((who) => api.call("agent.prompt", { agent: who, text: body, via: "room-tui" })
      .then((r) => sent.push({ name: r.name || who, busy: !!r.busy })).catch((e) => failed.push(`${who} (${e.message})`))));
    sentNote((sent.length ? sentLine({ recipients: sent }, { width: sentW() }) : "") + (failed.length ? (sent.length ? "  ✗ " : "✗ ") + failed.join(", ") : "")); // J165
    return render();
  }
  try {
    const r = await api.call("room.post", { room, text, as_human: true, via: "room-tui" });
    if (r.recipients) sentNote(sentLine(r, { width: sentW() })); else note = r.delivered?.length ? "→ " + r.delivered.join(", ") : "saved · no agents in this room yet"; // J165
  } catch (e) { note = "✗ " + e.message; }
  render();
}

process.stdin.setRawMode?.(true);
process.stdin.setEncoding("utf8");
// Input arrives in chunks (held keys, pastes): split into single keys first.
const KEY = /\x1b[bfsSz\x7f1-9]|\x1b\[<[\d;]+[Mm]|\x1b\[[\d;]*[A-Za-z~]|\x1bO[A-Za-z]|\x1b|[\s\S]/gu;
process.stdin.on("data", (chunk) => { batching = true; try { for (const [k] of String(chunk).matchAll(KEY)) onKey(k); } finally { batching = false; if (dirty) render(); } });
function onKey(d) {
  // SUPER+C (Omarchy's universal copy = Ctrl+Insert; kitty passes it on when it has no selection of its
  // own): the pane's highlighted selection, if there is one, else the box's (below). @hyprpi N49
  if (d === "\x1b[2;5~" && sel && selRange()) { copy(selectedText()); note = "copied"; return render(); }
  if (sel && !d.startsWith("\x1b[<")) { sel = null; dirty = true; }
  if (d === "\x1a" || d === "\x1f" || d === "\x19" || d === "\x1b[122;6u" || d === "\x1bz") { box.key(d); note = box.note || ""; return render(); } // J194: Ctrl+Z undo · Ctrl+Y redo · Alt+Z cleared drafts
  // Key model: TOP agent list = Shift (⇧↑↓ cursor, ⇧Space mark) · MIDDLE pane = Ctrl (^↑↓, PgUp/PgDn,
  // ^Home/End) · BOTTOM message box = plain keys (multi-line: ↑↓ lines, ⇧⏎ newline, ⇧←→ select).
  // Search lives in the Thoughts panel (SUPER+ALT+/); Ctrl+/ (like Ctrl+-) is the box's undo (J194/J203).
  // Bracketed paste (Super+V / Ctrl+Shift+V): inserted as text, line breaks kept.
  if (d === "\x1b[200~") { pasting = true; return; }
  if (d === "\x1b[201~") { pasting = false; return render(); }
  if (pasting) return insertText(d === "\r" ? "\n" : d);
  // Ctrl+C: copy the selected text, else the whole message; it never deletes it (Angus) and never
  // quits (too easy to hit while copying). Ctrl+Q quits; Ctrl+U clears the box.
  if (d === "\x03") {
    if (inputSel()) return copyInputSel(false);
    if (input) { copy(input); note = "copied the message"; return render(); }
    note = "Ctrl+Q quits"; return render();
  }
  if (d === "\x11") return quit(); // Ctrl+Q
  if (d === "\x1b[2;5~") return copyInputSel(false); // SUPER+C (Ctrl+Insert, passed on when kitty has no selection)
  if (d === "\x18") return copyInputSel(true); // Ctrl+X: cut
  if (d === "\x16" || d === "\x1b[2;2~") { box.paste(); if (!keepSent()) note = ""; focusArea = "input"; return render(); } // Ctrl+V / Shift+Insert: text, or a screenshot's path at the cursor (the shared box)
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
  // (No Ctrl+B: the board has its own panel, SUPER+ALT+P; the in-panel board view is gone, J210.)
  if (d === "\x1b[13;5u") d = "\r"; // Ctrl+Enter sends, like Enter
  if (CTRL_TAB.has(d)) return cycle(1);
  if (CTRL_SHIFT_TAB.has(d)) return cycle(-1);
  if (d === "\t" || d === "\x1b[Z") {
    const gs = graphemes(input), before = gs.slice(0, ic).join(""), after = gs.slice(ic).join("");
    // Tab: @projects · Shift+Tab: @agents (Angus). Each key cycles its own list; at a blank
    // spot (empty box, after a space) it starts a new @name. Ctrl+Tab switches world.
    const kind = d === "\t" ? "project" : "agent";
    const pool = kind === "project" ? hereProjects().map((p) => ({ id: p.id, name: p.name, display: p.name })) : hereAgents();
    let text = before + after, at = before.length;
    if (!/(^|\s)@[^\s,@]*$/.test(before)) {
      if (before && !/\s$/.test(before)) { note = "Tab: @projects · Shift+Tab: @agents (at the start or after a space) · Ctrl+Tab switches world"; return render(); }
      text = before + "@" + after; at = before.length + 1; atCycle = null;
    }
    if (!pool.length) { note = kind === "project" ? "no projects on this board yet (Shift+Tab: @agents)" : "no agents in this room"; return render(); }
    const r = completeAt(text, at, pool, atCycle?.kind === kind ? atCycle : null, 1, { specials: kind === "agent" });
    if (!r || !r.options.length) { note = kind === "project" ? "no project by that name here (Shift+Tab: @agents)" : "no agent here by that name (Tab: @projects)"; return render(); }
    input = r.text; ic = graphemes(r.text.slice(0, r.cursor)).length; selA = null;
    atCycle = r.state ? { ...r.state, kind } : null;
    note = r.options.length > 1 ? r.options.map((o) => (o === r.pick ? "▸" : "") + (kind === "project" ? "📋@" : "@") + o).join("  ") : "";
    return render();
  }
  if (d === "\r") { selA = null; return send(); }
  if (d === "\x1b[13;2u") return insertText("\n"); // Shift+Enter: new line in the message
  if (view !== "stream" && d === "\x1b") { // Esc: back to the stream
    view = "stream"; note = ""; return render();
  }
  // The stream (Ctrl): Ctrl+↑↓ scrolls a line, PgUp/PgDn a page, Ctrl+Home/End oldest / newest.
  // Plain and Shift arrows belong to the message box below; Alt+↑↓ selects a stream row.
  {
    const page = Math.max(1, lastAvail - 2);
    const sc = { "\x1b[1;5A": 1, "\x1b[1;5B": -1, "\x1b[5~": page, "\x1b[6~": -page, "\x1b[1;5H": Infinity, "\x1b[1;5F": -Infinity }[d];
    if (sc !== undefined) {
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
  // Editing the message (the shared box): ←→, Ctrl/Alt+←→ by word, Home/End / Ctrl+E, ↑↓ lines,
  // Shift+arrows / Shift+Home End select, Backspace / Delete / Alt+Backspace / Ctrl+W, Ctrl+U clear.
  // (Typing, paste, Shift+Enter and Ctrl+C/X/V are handled above and below, through insertText.)
  if (d.startsWith("\x1b") || d === "\x7f" || d === "\b" || d === "\x15" || d === "\x05" || d === "\x17") {
    if (box.key(d)) { note = box.note || (keepSent() ? note : ""); focusArea = "input"; return render(); }
  }
  if (d === "\x0e") return newAgent(); // Ctrl+N
  if (d === "\x06") { if (view !== "stream") setView("stream"); sview = SVIEWS[(SVIEWS.indexOf(sview) + 1) % SVIEWS.length]; scroll = 0; lastConvoLen = 0; streamSel = null;
    note = { full: "full text (^F: compact)", compact: "compact: one line each (^F: topics)", topics: "topics: topic changes only (^F: all activity)", all: "all activity: also upkeep, Thoughts' notices, ✓ / ×, board bookkeeping (^F: full text)" }[sview]; return render(); } // Ctrl+F
  // Scrolling: mouse wheel (SGR mouse reports), ↑/↓ line, PgUp/PgDn page, Home/End.
  if (d.startsWith("\x1b[<")) {
    for (const m of d.matchAll(/\x1b\[<(\d+);(\d+);(\d+)([Mm])/g)) {
      const b = Number(m[1]), x = Number(m[2]), y = Number(m[3]);
      const tab = b === 0 && m[4] === "M" ? worldTabAt(worldBar, x, y, [room]) : null;
      if (tab) { const s = stepTo(rooms.map((r) => r.id), room, tab); if (s) cycle(s); continue; } // a world tab: like Ctrl+Tab
      const inList = false; // no agent pane in this panel
      // Left button: press starts a possible selection, motion drags it,
      // release copies it (or, without a drag, counts as a click).
      // (+4 = Shift held; kitty passes Shift through: terminal_select_modifiers.)
      // Ctrl+click (16): an agent's name under the pointer (@Name, or a name as shown) jumps to
      // its window, wherever it is; a link / file URI opens (kitty's own Ctrl+click is passed on
      // to the panel by the launcher, so the panel opens links itself).
      if (b === 16 && m[4] === "M") { ctrlClick(x, y); continue; }
      if (b === 16) continue;
      if ((b === 0 || b === 4) && m[4] === "M") {
        focusArea = inList ? "list" : view === "search" && resultRowMap[y] !== undefined ? "results" : "input";
        const inConvo = !!rowMeta[y], now = Date.now();
        // Count quick presses on the same spot: 2 = word, 3 = whole message (or line).
        clicks = b === 0 && now - lastPress.t < 400 && y === lastPress.y && Math.abs(x - lastPress.x) <= 1 ? clicks + 1 : 1;
        lastPress = { x, y, t: now };
        const bh = clicks >= 2 ? boxHit(boxArea, x, y) : null; // N79: a double / triple click in the box selects a word / the whole line
        if (bh) { box.selectAt(bh.row, bh.col, clicks); sel = null; focusArea = "input"; continue; }
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
        scroll += b === 64 ? 3 : -3;
      }
    }
    return render();
  }
  if (d === "\x1b") { // Esc: text selection, else the picked row, else the stream filter, else the note
    if (inputSel()) { selA = null; return render(); }
    if (streamSel != null) { streamSel = null; return render(); }
    if (streamArg) { const had = parseStreamFilter(streamArg).since; streamArg = ""; scroll = 0; lastConvoLen = 0; note = "stream filter cleared"; if (had) loadRoom(room); return render(); }
    confirm = null; note = ""; return render();
  }
  if (d.startsWith("\x1b")) return; // other keys: ignore in the mockup
  if (!d.replace(/[\x00-\x1f]/g, "")) return;
  insertText(d); // typing replaces the selection
}
// Ctrl+click: a link opens; an agent's name under the pointer (@Name, or as shown, "Sankey[e]"
// too) jumps to its window, wherever it is; elsewhere on a stream row, that row's agent (the
// message's author, or the agent an activity line is about). Matching: lib/tui/agent-click.mjs.
function ctrlClick(x, y) {
  const word = wordAt(screen[y - 1] || "", x, gw);
  const url = urlIn(word);
  if (url) { try { spawn("gio", ["open", url], { detached: true, stdio: "ignore" }).on("error", () => {}).unref(); note = "opening link"; } catch { /* none */ } return render(); }
  if (!api) return;
  let hit = word ? agentIn(word, agents) : null;
  if (!hit) {
    const it = convoMsgs[rowMeta[y]?.msg];
    const id = it?.m?.author?.kind === "agent" ? it.m.author.id : it?.e?.agent?.id;
    hit = id ? agents.find((ag) => ag.id === id) : null;
    if (!hit && id) { note = "that agent has closed"; return render(); }
  }
  if (!hit) { const n = bareName(word); if (n) { note = `no live agent @${n}`; render(); } return; }
  api.call("agent.focus", { agent: hit.id }).then(() => { note = `→ @${hit.display}`; render(); }).catch((e) => { note = "✗ " + e.message; render(); });
}
function quit() { out(`${ESC}?2004l${ESC}?1002l${ESC}?1000l${ESC}?1006l${ESC}?1049l${ESC}?25h`); process.exit(0); }
process.on("SIGTERM", quit);

// Restart when the TUI's own code changes (a hyprpi update), so an open panel is never
// stale: same room, same window. Not while something is typed or a search is running.
const CODE = [new URL("./room-tui.mjs", import.meta.url).pathname,
  ...["client.mjs", "paths.mjs", "search-view.mjs", "at-names.mjs", "stream.mjs", "tui/shimmer.mjs", "tui/input-box.mjs", "tui/command-line.mjs", "tui/agent-click.mjs"].map((f) => new URL("../lib/" + f, import.meta.url).pathname)];
const codeStamp = () => CODE.map((f) => { try { return fs.statSync(f).mtimeMs; } catch { return 0; } }).join(",");
const codeAtStart = codeStamp();
setInterval(() => {
  if (restarting || codeStamp() === codeAtStart) return; // what is typed comes along (keep.input)
  restarting = true;
  try { api?.close?.(); } catch { /* fine */ }
  out(`${ESC}?2004l${ESC}?1002l${ESC}?1000l${ESC}?1006l${ESC}?1049l${ESC}?25h`);
  // Keep what Angus was looking at: the stream view and filter, and what is typed.
  const keep = JSON.stringify({ view: "stream", streamArg, sview, input, ic });
  // The launcher (mockups/room-tui) loops on exit code 75: hand it the state in a file and
  // exit, so restarts don't pile up processes. Older windows (no loop): a child, as before.
  if (process.env.HYPRPI_ROOM_TUI_STATEFILE) {
    try { fs.writeFileSync(process.env.HYPRPI_ROOM_TUI_STATEFILE, keep); } catch { /* start fresh */ }
    process.exit(75);
  }
  spawn(process.execPath, [CODE[0], room], { stdio: "inherit", env: { ...process.env, HYPRPI_ROOM_TUI_STATE: keep } })
    .on("exit", (code) => process.exit(code ?? 0));
  process.stdin.setRawMode?.(false); process.stdin.pause();
}, 3000);
process.stdout.on("resize", render);
out(`${ESC}?1049h${ESC}?1000h${ESC}?1002h${ESC}?1006h${ESC}?2004h`); // alt screen + mouse (wheel, click, drag-select) + bracketed paste
// After a restart onto new code: back to the same view. An old saved state from the in-panel board view
// (gone, J210) opens the normal Stream; its view / card fields are ignored.
try {
  let raw = process.env.HYPRPI_ROOM_TUI_STATE || "";
  const sf = process.env.HYPRPI_ROOM_TUI_STATEFILE;
  if (!raw && sf) { try { raw = fs.readFileSync(sf, "utf8"); fs.writeFileSync(sf, ""); } catch { /* none */ } }
  const k = raw ? JSON.parse(raw) : null;
  delete process.env.HYPRPI_ROOM_TUI_STATE;
  if (k) {
    if (typeof k.streamArg === "string") streamArg = k.streamArg; else if (Array.isArray(k.words)) streamArg = k.words.join(" "); // (older: words)
    if (k.filter === "raw" && !/\braw\b/.test(streamArg)) streamArg = (streamArg + " raw").trim();
    sview = SVIEWS.includes(k.sview) ? k.sview : k.compact ? "compact" : "full"; // (older: compact)
    if (typeof k.input === "string") { input = k.input; ic = Math.min(Number(k.ic) || 0, graphemes(input).length); }
  }
} catch { /* start in the stream */ }
box.restore(); // J194: an unsent draft from before a close / crash
render();
start();
