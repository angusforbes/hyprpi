#!/usr/bin/env node
// The Thoughts window (panel 3, SUPER+ALT+/; Angus 2026-09-29 via Thoughts-C): ONE chat window
// with this world's Thoughts agent (lib/thoughts.mjs), like an agent window: the thread on top,
// newest at the bottom, the box at the bottom. No modes.
//   plain text            talk to Thoughts-<room> (it remembers; it can ask agents, hand off work)
//   /keyword WORDS        exact-word search over the world's history, instant, no model
//   /ask QUESTION         a small model answers from the history and cites the turns (lib/ask.mjs)
//   /more [N]             the last /keyword again with N (default +20) more of the older matches
// Evidence (from /keyword, /ask, or the Thoughts agent's own searches): at most the 10 newest
// matching turns, oldest first, numbered; "+N older" when more matched. Each line keeps a
// reference to its turn (agent, session, entry id) for a future jump. Results go to the Thoughts
// agent with your next message, so "tell me more about the second one" works.
// Whose history: @Names in the words ("/keyword @Sankey kafka"), else the agent marks (▸, the
// agents panel) when not everyone is marked; the evidence header says so.
// Keys: ⏎ send · Tab completes @names and /commands · Ctrl+Tab world · Ctrl+↑↓ PgUp PgDn wheel
// scroll · Ctrl+V pastes text or a screenshot · Ctrl+click an agent's name (or an evidence line)
// jumps to its window · links and file paths open on click · Esc clears · Ctrl+Q quits.
// Select & copy as in the room panel (drag, Shift+click whole items, double / triple click).
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { connect } from "../lib/client.mjs";
import { createSearch } from "../lib/search-view.mjs";
import { parseAt, resolveAt, completeAt } from "../lib/at-names.mjs";
import { createInputBox, atTint } from "../lib/tui/input-box.mjs";
import { createCommands } from "../lib/tui/command-line.mjs";
import { wordAt, urlIn, agentIn, bareName } from "../lib/tui/agent-click.mjs";
import { worldTabAt, stepTo } from "../lib/tui/world-tabs.mjs";
import { mdRows, openTarget } from "../lib/tui/markdown.mjs";
let worldBar = null;

const ESC = "\x1b[";
const out = (s) => process.stdout.write(s);

// ---- theme: world colours exactly like the bar / room TUI -------------------
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
const worldHex = (room) => { const i = "ABCDEFGHI".indexOf(String(room)[0]); for (const k of PALETTE[Math.max(0, i) % PALETTE.length]) if (theme[k]) return theme[k]; return null; };
const worldFg = (room) => { const h = worldHex(room); return h ? `38;2;${rgb(h)}` : "34"; };
const worldBg = (room) => { const h = worldHex(room); return h ? `48;2;${rgb(h)}` : "44"; };
const fg = (c, s) => `${ESC}${c}m${s}${ESC}39m`;
const hexFg = (hex, s) => { const m = /^#?([0-9a-f]{6})$/i.exec(hex || ""); return m ? `${ESC}38;2;${rgb(m[1])}m${s}${ESC}39m` : s; };
const dim = (s) => `${ESC}2m${s}${ESC}22m`;
const bold = (s) => `${ESC}1m${s}${ESC}22m`;
const italic = (s) => `${ESC}3m${s}${ESC}23m`;

// ---- widths (grapheme clusters, emoji presentation = 2) ---------------------
const seg = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const graphemes = (s) => Array.from(seg.segment(String(s)), (x) => x.segment);
function gw(g) {
  const cps = [...g].map((c) => c.codePointAt(0));
  if (cps.some((cp) => cp === 0xfe0f || cp === 0x200d) || /\p{Emoji_Presentation}/u.test(g) || (cps[0] >= 0x1f1e6 && cps[0] <= 0x1f1ff)) return 2;
  const cp = cps[0];
  if ((cp >= 0x1100 && cp <= 0x115f) || (cp >= 0x2e80 && cp <= 0xa4cf) || (cp >= 0xac00 && cp <= 0xd7a3) || (cp >= 0xf900 && cp <= 0xfaff) || (cp >= 0xff00 && cp <= 0xff60)) return 2;
  return cp < 32 ? 0 : 1;
}
const strip = (s) => String(s).replace(/\x1b\[[0-9;]*m/g, "");
const width = (s) => { let w = 0; for (const g of graphemes(strip(s))) w += gw(g); return w; };
function clip(s, n) { // cut a styled line to n columns, keeping escapes
  let w = 0, r = "";
  for (const part of String(s).split(/(\x1b\[[0-9;?]*[A-Za-z])/)) {
    if (part.startsWith("\x1b")) { r += part; continue; }
    for (const g of graphemes(part)) { const c = gw(g); if (w + c > n) return r + `${ESC}0m`; w += c; r += g; }
  }
  return r;
}
// Word-wrap plain text to n columns; returns [{ text, from }] with character offsets.
function wrap(text, n) {
  const lines = [];
  let line = "", lw = 0;
  for (const word of String(text).split(/(\s+)/)) {
    if (!word) continue;
    const ww = width(word);
    if (lw + ww > n && line.trim()) { lines.push(line.trimEnd()); line = ""; lw = 0; if (/^\s+$/.test(word)) continue; }
    if (ww > n) { for (const g of graphemes(word)) { const c = gw(g); if (lw + c > n) { lines.push(line); line = ""; lw = 0; } line += g; lw += c; } continue; }
    line += word; lw += ww;
  }
  if (line.trim()) lines.push(line.trimEnd());
  return lines;
}
function when(ts) {
  const d = new Date(ts), now = new Date(), p = (x) => String(x).padStart(2, "0");
  const hm = `${p(d.getHours())}:${p(d.getMinutes())}`;
  return d.toDateString() === now.toDateString() ? hm : `${d.toLocaleString("en", { month: "short" })} ${d.getDate()} ${hm}`;
}
const ROLE = { angus: "Angus", agent: "agent", room: "room", talk: "talk", activity: "did" };

const t = { dim, bold, italic, clip, width, hexFg, rgb, get theme() { return theme; } };

// ---- state ------------------------------------------------------------------
let api = null, online = false, rooms = [], room = (process.argv[2] || "").toUpperCase();
let showHelp = false, note = "";
let query = "", qc = 0; // the search box and its cursor (in graphemes)
let top = 0, resultRows = {}; // resultRows: screen row -> result index
let marks = { all: true, agents: [] }; // still fetched (unused for scope since @names)
let known = []; // agents of every room, live and closed: [{ id, name, display, icon, color, room, live }]
const hereKnown = () => known.filter((a) => a.room === room);
// The box's @names -> agent ids (this room). Unknown names are reported, not ignored.
function scopeOf(text = query) {
  const { names, rest } = parseAt(text);
  const r = resolveAt(names, hereKnown());
  return { ...r, names, rest };
}
const onlyIds = () => scopeOf().ids;
const S = createSearch({ api: () => api, room: () => room, onChange: () => render(), only: onlyIds, closed: true, roomLog: true, order: "auto" }); // (unused since the Thoughts window; kept for S.startedAt)
// /keyword and /ask: whose history (the words' @names, else the marks) and the one running.
const EV = { busy: "", last: null, startedAt: 0 };
function evFilter(text) {
  const sc = scopeOf(text);
  if (sc.unknown.length) throw new Error(`no agent ${sc.unknown.map((n) => "@" + n).join(" ")} in room ${room} (Tab completes names)`);
  const ids = sc.ids.length ? sc.ids : (!marks.all && marks.agents?.length ? marks.agents : []);
  return { words: sc.rest, ids, how: sc.ids.length ? "@names" : ids.length ? "marks" : "" };
}
function evidence(kind, text, n = 10) {
  let f; try { f = evFilter(text); } catch (e) { note = "✗ " + e.message; return render(); }
  if (!f.words) { note = kind === "ask" ? "/ask QUESTION" : "/keyword WORDS"; return render(); }
  if (!api) { note = "✗ daemon offline"; return render(); }
  EV.busy = kind; EV.startedAt = Date.now(); EV.last = { kind, text, n }; note = ""; TH.scroll = 0; render();
  api.call("thoughts.evidence", { room, kind, query: f.words, n, agents: f.ids }, { timeoutMs: 180000 })
    .then(() => { EV.busy = ""; render(); })
    .catch((e) => { EV.busy = ""; note = "✗ " + e.message; render(); });
}

// Thoughts mode (Angus, 2026-09-29; lib/thoughts.mjs): the third mode after keyword and AI. You
// talk to the world's own agent, Thoughts-<room> (Opus 5.5, remembers the conversation, can ask
// agents and hand them work). The pane is a clean chat thread from the daemon: your messages, its
// replies, one dim line per thing it did for you, agents' replies. Ctrl+/ cycles the three modes.
let thoughtsOn = true; // always (no modes any more)
let linkRows = {}; // screen row -> [{ x0, x1, target }] (1-based rows, 0-based columns): clickable links in the thread
const linkAt = (x, y) => (linkRows[y] || []).find((q) => x - 1 >= q.x0 && x - 1 < q.x1)?.target || null;
const TH = { room: "", entries: [], busy: false, scroll: 0 }; // scroll: rows up from the bottom
const modeName = () => thoughtsOn ? "thoughts" : S.mode;
const wrapP = (t, n) => String(t || "").split(/\r?\n/).flatMap((q) => q.trim() ? wrap(q, n) : [""]); // paragraphs kept
function loadThoughts() {
  if (!api) return;
  const r = room;
  api.call("thoughts.get", { room: r }).then((t) => { if (r !== room) return; TH.room = r; TH.entries = t.entries || []; TH.busy = !!t.busy; render(); }).catch((e) => { note = "✗ " + e.message; render(); });
}
function setThoughts(on) { thoughtsOn = on; TH.scroll = 0; note = ""; if (on) loadThoughts(); render(); }
// Pasted screenshots for the next thought (Ctrl+V with an image on the clipboard, Thoughts mode):
// saved like pi's own, /tmp/pi-clipboard-<id>.png, shown as 📎 chips under the box (click: open).
let attach = [];
function pasteImage(type) {
  const f = `/tmp/pi-clipboard-${randomUUID()}.${type.split("/")[1] === "jpeg" ? "jpg" : type.split("/")[1] || "png"}`;
  try {
    const out = fs.openSync(f, "w");
    const p = spawnChild("wl-paste", ["--type", type], { stdio: ["ignore", out, "ignore"] });
    p.on("error", () => { note = "✗ wl-paste failed"; render(); });
    p.on("close", (code) => { fs.closeSync(out); let n = 0; try { n = fs.statSync(f).size; } catch { /* gone */ }
      if (code || !n) { note = "✗ couldn't read the image from the clipboard"; return render(); }
      attach.push(f); note = `📎 image attached (${Math.round(n / 1024)} KB) · ⏎ sends it with your text · Esc drops it`; render(); });
  } catch (e) { note = "✗ " + e.message; render(); }
}
// Input history: your earlier messages ("you" entries), newest last; hist.i = -1 means the draft.
const hist = { i: -1, draft: "" };
function historyKey(dir) {
  const mine = TH.entries.filter((e) => e.role === "you" && e.text).map((e) => e.text);
  const n = graphemes(query).length;
  if (dir < 0) {
    if (qc > 0 && hist.i < 0) { qc = 0; return render(); } // first: to the start of what you're typing
    if (hist.i + 1 >= mine.length) { note = mine.length ? "that's your first message here" : "no earlier messages yet"; return render(); }
    if (hist.i < 0) hist.draft = query;
    hist.i++; setBox(mine[mine.length - 1 - hist.i]); note = ""; return render();
  }
  if (qc < n && hist.i < 0) { qc = n; return render(); } // first: to the end
  if (hist.i < 0) return render();
  hist.i--; setBox(hist.i < 0 ? hist.draft : mine[mine.length - 1 - hist.i]); note = ""; return render();
}
function sendThought(text, images = []) {
  hist.i = -1; hist.draft = "";
  const t = String(text || "").trim();
  if ((!t && !images.length) || !api) return;
  api.call("thoughts.send", { room, text: t, images }).then(() => { TH.busy = true; render(); }).catch((e) => { note = "✗ " + e.message; render(); });
  TH.scroll = 0; TH.busy = true; render();
}

// Commands: the search panel's own (/search, /ai, /ask) plus the ones every panel has (/help,
// /tinker, /quit), all through lib/tui/command-line.mjs.
const cmds = createCommands({
  commands: [
    { name: "/keyword", usage: "/keyword WORDS", help: "exact-word search of this world's history (instant, no model): the 10 newest matching turns", run: (a) => evidence("keyword", a) },
    { name: "/search", usage: "/search WORDS", help: "the same as /keyword", run: (a) => evidence("keyword", a) },
    { name: "/ask", usage: "/ask QUESTION", help: "a small model answers from the history and cites the turns (answer last)", run: (a) => evidence("ask", a) },
    { name: "/ai", usage: "/ai QUESTION", help: "the same as /ask", run: (a) => evidence("ask", a) },
    { name: "/more", usage: "/more [N]", help: "the last /keyword again with N (default 20) more of the older matches", run: (a) => {
      if (!EV.last) { note = "nothing to show more of yet (/keyword WORDS first)"; return render(); }
      const add = Math.max(1, Number(a) || 20); evidence(EV.last.kind, EV.last.text, EV.last.n + add);
    } },
    { name: "/thought", usage: "/thought TEXT", help: "the same as typing TEXT: tell Thoughts", run: (a) => sendThought(a) },
  ],
  ctx: {
    panel: "search", world: () => room, worlds: () => rooms, cycle: (d) => cycle(d), agents: () => known.filter((a) => a.live),
    api: () => api, via: "search-tui", render: () => render(),
    note: (t) => { note = t; render(); },
    showHelp: () => { setBox(""); showHelp = true; render(); },
    quit: () => quit(),
    setBox: (t) => setBox(t),
  },
});

function scopeLabel() {
  const sc = scopeOf(S.busy || !S.ranFor ? query : S.ranFor.box ?? query);
  if (sc.found.length) return "only " + sc.found.map((a) => "@" + a.display).join(" ");
  return S.mode === "ai" ? "everyone · conversations + room log + activity" : "everyone · every agent's conversation + the room log";
}

function loadMarks() {
  if (!api) return;
  const r = room;
  api.call("selection.get", { room: r }).then((m) => { if (r === room) { marks = m; render(); } }).catch(() => {});
}
function cycle(d) {
  if (!rooms.length) return;
  const i = Math.max(0, rooms.indexOf(room));
  room = rooms[(i + d + rooms.length) % rooms.length];
  marks = { all: true, agents: [] }; top = 0; note = "";
  S.reset(); loadMarks(); if (thoughtsOn) { TH.entries = []; TH.scroll = 0; loadThoughts(); } render();
}
// Tab on an @word: complete it from this room's agents (again: the next match).
let atCycle = null; // completeAt's state: Tab again steps through the same matches
const CTRL_TAB = new Set(["\x1b[9;5u", "\x1b[27;5;9~"]), CTRL_SHIFT_TAB = new Set(["\x1b[9;6u", "\x1b[27;6;9~", "\x1b[1;5Z"]); // Ctrl(+Shift)+Tab: world (the launcher maps them; kitty would switch its own tabs)
function completeName(dir = 1) {
  const gs = graphemes(query), before = gs.slice(0, qc).join(""), after = gs.slice(qc).join("");
  const r = completeAt(before + after, before.length, hereKnown(), atCycle, dir);
  if (!r) return false;
  if (!r.options.length) { note = "no agent here by that name"; render(); return true; }
  query = r.text; qc = graphemes(r.text.slice(0, r.cursor)).length;
  atCycle = r.state;
  note = r.options.length > 1 ? r.options.map((o) => (o === r.pick ? "▸@" + o : "@" + o)).join("  ") : "";
  render(); return true;
}
function toggleMode() { note = "one window now: type to Thoughts · /keyword WORDS · /ask QUESTION"; render(); }

function enter() {
  const raw = query.trim();
  if (raw.startsWith("/") && !raw.startsWith("//")) return command(raw);
  const text = raw.startsWith("//") ? raw.slice(1) : raw;
  if (!text && !attach.length) { note = "type to Thoughts (or /keyword WORDS, /ask QUESTION), then ⏎"; return render(); }
  const imgs = attach; attach = []; setBox(""); return sendThought(text, imgs);
}
function setBox(text) { query = text; qc = graphemes(text).length; }
// A search sent from another panel (/search WORDS, /ai Q: mockups/panel-here → the daemon's
// ui.searchRun, or --mode / --query when that opened this panel): switch mode and run it.
function runFrom(mode, query) {
  showHelp = false; note = "";
  if (!query) return render();
  if (mode === "ai" || mode === "ask") return evidence("ask", query);
  if (mode === "keyword") return evidence("keyword", query);
  sendThought(query); // mode thoughts (/thought)
}
const startArgs = (() => { const a = process.argv.slice(3), o = {}; for (let i = 0; i < a.length; i += 2) if (a[i] === "--mode" || a[i] === "--query") o[a[i].slice(2)] = a[i + 1] ?? ""; return o; })();
let startRan = !(startArgs.mode || startArgs.query);
function command(raw) { note = ""; showHelp = false; setBox(""); cmds.run(raw); render(); }
function complete() { // Tab on "/partial": the shared completion (lib/tui/command-line.mjs)
  cmds.tab({ get text() { return query; }, set: (t) => setBox(t) });
  render();
}

// One result as screen lines.
function resultLines(r, i, W) {
  const c = worldFg(room), sel = i === S.selected;
  // Selected result: its name on light grey (like the room TUI's agent cursor), no side bar.
  const nameBg = theme.muted || theme.selection;
  const nm = hexFg(r.color, bold(r.name));
  const head = `${r.icon ? r.icon + " " : ""}${sel ? (nameBg ? `${ESC}48;2;${rgb(nameBg)}m${nm}${ESC}49m` : `${ESC}4m${nm}${ESC}24m`) : nm}${r.live ? "" : dim(" (closed)")}` +
    dim(` · ${ROLE[r.role] || r.role} · ${when(r.ts)}${r.count > 1 ? " · ×" + r.count : ""}`);
  const bar = " ";
  const textW = Math.max(10, W - 4);
  // Snippet: pre + MATCH + post, wrapped, the match in the world colour, max 4 lines.
  const pre = String(r.pre || ""), match = String(r.match || ""), post = String(r.post || "");
  const full = (pre + match + post).replace(/\s+/g, " ");
  const a = pre.replace(/\s+/g, " ").length, b = a + match.replace(/\s+/g, " ").length;
  let pos = 0;
  const body = wrap(full, textW).slice(0, 4).map((l) => {
    const at = full.indexOf(l, pos); const s = at < 0 ? pos : at; pos = s + l.length;
    let styled = "";
    [...l].forEach((ch, k) => {
      const off = s + k, inM = off >= a && off < b, prevIn = off - 1 >= a && off - 1 < b && k > 0;
      if (inM && !prevIn) styled += `${ESC}1;${c}m`;
      if (!inM && prevIn) styled += `${ESC}22;39m`;
      styled += ch;
    });
    return styled + `${ESC}22;39m`;
  });
  const lines = [`${bar} ${head}`, ...body.map((l) => `${bar}   ${l}`)];
  if (r.why) for (const w of wrap("↳ " + r.why, textW).slice(0, 2)) lines.push(`${bar}   ${dim(italic(w))}`);
  lines.push("");
  return lines;
}

function helpLines() {
  const k = (keys, what) => `   ${bold(keys.padEnd(22))} ${what}`;
  return [
    k("text + ⏎", `talk to Thoughts-${room} (it remembers; it can ask agents and hand them work)`),
    k("/keyword WORDS", "exact-word search of the history: the 10 newest matching turns, oldest first (+N older · /more)"),
    k("/ask QUESTION", "an answer from the history, with the turns it cites; the answer prints last"),
    k("@Name in the words", "only those agents' history (else the agent marks ▸, when not everyone is marked)"),
    k("follow-ups", "results go to Thoughts with your next message: \"tell me more about the second one\""),
    k("Tab · Ctrl+Tab", "complete an @name or a /command · next world"),
    k("^↑↓ PgUp PgDn wheel", "scroll the thread (plain ↑↓ are the box's)"),
    k("Ctrl+V", "paste text, or a screenshot to send with your message"),
    k("click · ^click", "open a link / file path · ^click an agent's name or an evidence line: that agent's window"),
    k("mouse", "drag = text · Shift+drag or Shift+click = whole items · double-click = word · triple-click = whole item · each copies"),
    k("Esc · Ctrl+U · Ctrl+Q", "clear the box · clear the box · quit"),
    "",
    ...cmds.help().map(([c, d]) => k(c, d)),
  ];
}

let restarting = false; // re-exec in progress: the child owns the terminal

// "Thinking" shimmer while a search runs (lib/tui/shimmer.mjs, shared with the board view).
// The timer runs only while busy.
import { shimmer as shimmerAt, createAnim } from "../lib/tui/shimmer.mjs";
const anim = createAnim(() => render());
const shimmer = (text, c) => shimmerAt(text, c, S.startedAt);
// ---- select & copy, like the room panel (mockups/room-tui.mjs) ---------------------
// Search box: Shift+←→ / Ctrl+Shift+←→ / Shift+Home End select; typing replaces the
// selection; Ctrl+C copies it (no selection: the whole box); Ctrl+X cuts; Ctrl+V /
// Shift+Insert / bracketed paste paste; SUPER+C (Ctrl+Insert) copies.
// Pane: drag selects text (answer / snippet text only) and copies on release;
// Shift+click / Shift+drag = whole items (the answer, or a result with name, time and
// text); double-click = a word; triple-click = the whole item. The highlight stays
// until the next key or click. Click selects a result; Enter jumps to it.
let selA = null;        // box selection anchor (grapheme index), or null
let pasting = false;    // inside a bracketed paste
function boxSel() { if (selA == null || selA === qc) return null; return selA < qc ? [selA, qc] : [qc, selA]; }
// The editing itself is the shared message box (lib/tui/input-box.mjs), one line here: the panel
// keeps query / qc / selA and loads them into the box before each edit, then reads them back.
const box = createInputBox({
  onChange: () => {}, copy: (t) => copy(t), multiline: false,
  tint: atTint((name) => { const r = resolveAt([name], hereKnown()), a = r.found[0]; return a ? { agent: a } : r.special ? { special: true } : null; },
    { worldFg: (x) => x, bold, nameFg: (_n, color, g) => hexFg(color || "", bold(g)) }),
});
const boxIn = () => box.load({ text: query, cursor: qc, anchor: selA });
const boxOut = () => { const st = box.state(); query = st.text; qc = st.cursor; selA = st.anchor; };
function insertText(t) { boxIn(); box.insert(t); boxOut(); note = ""; render(); }
function copyBoxSel(cut) { boxIn(); const ok = box.copySel(cut); boxOut(); render(); return ok; }
function pasteClipboard() {
  // An image on the clipboard (a screenshot): attached in Thoughts mode (Angus), else a note.
  try {
    const lt = spawnChild("wl-paste", ["--list-types"], { stdio: ["ignore", "pipe", "ignore"] });
    let types = ""; lt.stdout.on("data", (b) => { types += b; }); lt.on("error", () => pasteText());
    lt.on("close", () => {
      const img = types.split("\n").map((x) => x.trim()).find((x) => /^image\/(png|jpeg|webp|gif)$/.test(x));
      const hasText = /^text\/plain/m.test(types);
      if (img && thoughtsOn) return pasteImage(img);
      if (img && !hasText) { note = "images can be pasted in 💭 Thoughts mode (Ctrl+/)"; return render(); }
      pasteText();
    });
  } catch { pasteText(); }
}
function pasteText() {
  try {
    const p = spawnChild("wl-paste", ["--no-newline", "--type", "text/plain"], { stdio: ["ignore", "pipe", "ignore"] });
    let buf = ""; p.stdout.on("data", (b) => { buf += b; }); p.on("error", () => {}); p.on("close", () => { if (buf) insertText(buf); });
  } catch { /* no wl-paste */ }
}
function copy(text) {
  if (!text) return;
  // OSC 52 (kitty puts it on the clipboard) and wl-copy as a fallback.
  out(`\x1b]52;c;${Buffer.from(text).toString("base64")}\x07`);
  try { const p = spawnChild("wl-copy", ["--type", "text/plain;charset=utf-8"], { stdio: ["pipe", "ignore", "ignore"] }); p.on("error", () => {}); p.stdin.on("error", () => {}); p.stdin.end(text); } catch { /* OSC 52 only */ }
  note = `copied ${text.length} character${text.length === 1 ? "" : "s"}`;
}
// Pane selection. screen = the plain text of every row; rowMeta[y] = { item, textX, header }
// for pane rows that belong to an item; items[k].copy = what a whole-item copy gives.
let screen = [], rowMeta = {}, items = [], sel = null; // sel: { x0, y0, x1, y1, dragging, clicks, mode } (1-based cells)
let clicks = 0, lastPress = { x: 0, y: 0, t: 0 };
function selRange() {
  if (!sel || (sel.mode !== "item" && sel.x0 === sel.x1 && sel.y0 === sel.y1)) return null;
  const fwd = sel.y0 < sel.y1 || (sel.y0 === sel.y1 && sel.x0 <= sel.x1);
  return fwd ? { y0: sel.y0, x0: sel.x0, y1: sel.y1, x1: sel.x1 } : { y0: sel.y1, x0: sel.x1, y1: sel.y0, x1: sel.x0 };
}
function selItems(sr) {
  const near = (y, d) => { for (let k = 0; k < 400; k++, y += d) { const r = rowMeta[y]; if (r) return r.item; if (y < 1 || y > screen.length) break; } return null; };
  const a = near(sr.y0, 1), b = near(sr.y1, -1);
  if (a == null || b == null) return [null, null];
  return a <= b ? [a, b] : [b, a];
}
function selSpans(W) {
  const sr = selRange(), outSp = {};
  if (!sr) return outSp;
  if (sel.mode === "item") {
    const [a, b] = selItems(sr); if (a == null) return outSp;
    for (const [y, r] of Object.entries(rowMeta)) if (r.item >= a && r.item <= b) outSp[y] = [1, W];
    return outSp;
  }
  for (let y = sr.y0; y <= sr.y1; y++) {
    let a = y === sr.y0 ? sr.x0 : 1, b = y === sr.y1 ? sr.x1 : W;
    if (sel.mode === "text") {
      const r = rowMeta[y];
      if (!r || r.header) continue;
      a = Math.max(a, r.textX);
      b = Math.min(b, width((screen[y - 1] || "").trimEnd()));
    }
    if (a <= b) outSp[y] = [a, b];
  }
  return outSp;
}
function overlay(line, a, b, on, off) { // paint cells a..b with a background, keeping other styles
  let col = 1, r = "", inside = false;
  for (const part of line.split(/(\x1b\[[0-9;?]*[A-Za-z])/)) {
    if (part.startsWith("\x1b")) { r += part; if (inside && /\x1b\[(?:0|49|27)?m$/.test(part)) r += on; continue; }
    for (const g of graphemes(part)) {
      if (!inside && col >= a && col <= b) { r += on; inside = true; }
      if (inside && col > b) { r += off; inside = false; }
      r += g; col += gw(g);
    }
  }
  if (inside && col <= b + 1) r += " ".repeat(Math.max(0, b + 1 - col));
  else if (!inside && col <= a) { r += " ".repeat(a - col) + on + " ".repeat(b - a + 1); inside = true; }
  if (inside) r += off;
  return r;
}
function sliceCols(tx, a, b) {
  let col = 1, r = "";
  for (const g of graphemes(tx)) { const w = gw(g); if (col >= a && col + w - 1 <= b) r += g; col += w; if (col > b) break; }
  return r;
}
function selectedText() {
  const sr = selRange(); if (!sr) return "";
  const W = process.stdout.columns || 100;
  if (sel.mode === "item") { const [a, b] = selItems(sr); return a == null ? "" : items.slice(a, b + 1).map((x) => x.copy).join("\n\n"); }
  const spans = selSpans(W), ys = Object.keys(spans).map(Number).sort((p, q) => p - q);
  if (sel.mode === "text") { // unwrap: rows of one item join with a space
    let tx = "", prev = null;
    for (const y of ys) {
      const r = rowMeta[y], piece = sliceCols(screen[y - 1], spans[y][0], spans[y][1]).trim();
      if (prev) tx += prev.item !== r.item ? "\n" : " ";
      tx += piece; prev = r;
    }
    return tx;
  }
  return ys.map((y) => sliceCols(screen[y - 1], spans[y][0], spans[y][1]).trimEnd()).join("\n");
}
function multiClick(n, x, y) { // 2 = the word under the pointer, 3 = the whole item (or the line)
  const line = screen[y - 1] || "", cells = [];
  { let col = 1; for (const g of graphemes(line)) { cells.push([col, g]); col += gw(g); } }
  if (n === 2) {
    const i = cells.findIndex(([cc, g], k) => cc <= x && (cells[k + 1]?.[0] ?? cc + gw(g)) > x);
    if (i < 0 || /\s/.test(cells[i][1])) { sel = null; return render(); }
    let a = i, b = i;
    while (a > 0 && !/\s/.test(cells[a - 1][1])) a--;
    while (b < cells.length - 1 && !/\s/.test(cells[b + 1][1])) b++;
    const P = /^[\p{P}\p{S}]$/u;
    while (a < b && P.test(cells[a][1]) && !/[@#~/$]/.test(cells[a][1])) a++;
    while (b > a && P.test(cells[b][1])) b--;
    sel = { x0: cells[a][0], y0: y, x1: cells[b][0] + gw(cells[b][1]) - 1, y1: y, dragging: true, mode: "plain" };
  } else if (rowMeta[y]) sel = { x0: x, y0: y, x1: x, y1: y, dragging: true, mode: "item" };
  else {
    const first = cells.find(([, g]) => !/\s/.test(g));
    if (!first) { sel = null; return render(); }
    sel = { x0: first[0], y0: y, x1: width(line.trimEnd()), y1: y, dragging: true, mode: "plain" };
  }
  copy(selectedText());
  render();
}

function syncAnim() {
  anim.sync(!!EV.busy || TH.busy);
}

function render() {
  if (restarting) return;
  syncAnim();
  const W = process.stdout.columns || 100, H = process.stdout.rows || 30, c = worldFg(room);
  const rows = [];
  const rule = (label) => fg(c, "─" + (label ? ` ${label} ` : "") + "─".repeat(Math.max(0, W - 1 - (label ? width(label) + 2 : 0))));
  const marked = !marks.all && marks.agents?.length ? marks.agents.map((id) => "@" + (known.find((a) => a.id === id)?.display || id)).join(" ") : "";
  rows.push(rule(`thoughts · room ${room} · Thoughts-${room}${marked ? ` · /keyword /ask: only ${marked} (marks)` : ""}`));
  const prompt = fg(c, bold("💭 "));
  const slash = note.startsWith("✗") ? null : cmds.hint(query); // typing a /command: its matches (shared)
  const hint = slash ? dim("  " + slash) : query ? "" : dim(`talk to Thoughts-${room} · /keyword WORDS · /ask QUESTION · /help`);
  const selOn = theme.selection ? `${ESC}48;2;${rgb(theme.selection)}m` : `${ESC}7m`, selOff = theme.selection ? `${ESC}49m` : `${ESC}27m`;
  boxIn();
  // The bottom block, like an agent window (Angus: the box at the bottom): the status line
  // ("thinking…"), a rule, the box (wrapped, up to a third of the height, scrolled to the cursor),
  // the 📎 chips of pasted images. Built first: its height decides the thread's.
  const pw = width(prompt), L = box.layout(Math.max(10, W - pw)), MAXI = Math.max(2, Math.min(8, Math.floor(H / 3)));
  const inTop = L.rows.length > MAXI ? Math.max(0, Math.min(L.cRow - MAXI + 1, L.rows.length - MAXI)) : 0;
  const inRows = L.rows.slice(inTop, inTop + MAXI);
  const status = note || S.status;
  const statusStyled = status.startsWith("✗") ? `${ESC}31m${status}${ESC}39m` : dim(status);
  const bottom = [];
  // One animation only (Angus): "thinking…" / "searching…" in the thread; this line stays still.
  bottom.push(" " + (note ? statusStyled : dim(`Thoughts-${room} · remembers this conversation · can ask agents and hand them work`)));
  bottom.push(fg(c, "─".repeat(W)));
  const boxAt = bottom.length;
  inRows.forEach((l, i) => bottom.push((i === 0 ? prompt : " ".repeat(pw)) + l + (i === 0 && inRows.length === 1 ? hint : "")));
  let chipMd = null, chipAt = -1;
  if (attach.length) { // 📎 chips: the pasted images going with the next message
    chipMd = mdRows(attach.map((f, i) => `📎 image ${i + 1}: ${f}`).join("   "), Math.max(10, W - pw), wrap, gw)[0];
    chipAt = bottom.length; bottom.push(" ".repeat(pw) + dim(chipMd.line));
  }
  const ruleAt = rows.length; rows.push("");
  const avail = Math.max(1, H - rows.length - bottom.length - 1); // the thread; 1 = the status bar
  resultRows = {}; rowMeta = {}; items = []; linkRows = {};

  if (!showHelp && thoughtsOn) {
    // The thread, newest at the bottom; ^↑↓ / PgUp PgDn / the wheel scroll it.
    const tw = Math.max(10, W - 5), flat = [];
    const who = (e) => e.role === "you" ? fg(c, bold("you")) : e.role === "thoughts" ? bold(`💭 Thoughts-${room}`) : "";
    // Every entry through mdRows: Markdown, and links / file paths clickable (Angus: all links and
    // paths must be clickable). x.links: [{ x0, x1, target }] in the row's own columns.
    const md = (text, n, pre, style = (l) => l) => mdRows(text, n, wrap, gw).map((r) => ({ l: pre + style(r.line), links: r.links.map((q) => ({ ...q, x0: q.x0 + pre.length, x1: q.x1 + pre.length })) }));
    for (const e of TH.entries) {
      const k = items.push({ copy: e.text }) - 1, red = (l) => `${ESC}31m${l}${ESC}39m`;
      const add = (rs, textX) => { for (const r of rs) flat.push({ ...r, meta: { item: k, textX } }); };
      if (e.role === "you" || e.role === "thoughts") {
        flat.push({ l: "" });
        flat.push({ l: `  ${who(e)}${dim("  " + when(e.ts))}`, meta: { item: k, textX: 3, header: true } });
        add(md(e.text, tw, "   "), 4); // **bold**, *italic*, `code`, bullets, links
        if (e.images?.length) add(md(e.images.map((f) => `📎 ${f}`).join("\n"), tw, "   ", dim), 4); // pasted screenshots (click opens)
      } else if (e.role === "action") add(md((e.text.startsWith("✗") ? "" : "↳ ") + e.text, tw, "   ", e.text.startsWith("✗") ? red : dim), 4);
      else if (e.role === "agent") { flat.push({ l: `   ${dim(italic(`↪ ${e.from} asked Thoughts-${room}:`))}`, meta: { item: k, textX: 4 } }); add(md(e.text, tw - 2, "     ", dim).slice(0, 8), 6); }
      else if (e.role === "evidence") {
        items[k].copy = `${e.kind === "ask" ? "/ask" : "/keyword"} ${e.query}${e.answer ? "\n" + e.answer : ""}`;
        // /keyword · /ask (by you) or the Thoughts agent's own search: numbered, oldest first; the
        // answer (ask) last. Each line keeps its turn's reference (items[k].ref, for Ctrl+click).
        flat.push({ l: "" });
        const tag = e.kind === "ask" ? "✦ ask" : "⌕ keyword";
        const count = e.items?.length ? `${e.items.length}${e.total > e.items.length ? " of " + e.total : ""} ${e.kind === "ask" ? "cited" : "matching"} turn${e.items.length === 1 ? "" : "s"}` : "no matches";
        flat.push({ l: `  ${fg(c, bold(tag))} ${italic(`"${e.query}"`)}${dim(` · ${count}${e.filter?.length ? " · only " + e.filter.map((n) => "@" + n).join(" ") : ""}${e.by === "thoughts" ? ` · by Thoughts-${room}` : ""} · ${when(e.ts)}`)}`, meta: { item: k, textX: 3, header: true } });
        if (e.older > 0) flat.push({ l: `     ${dim(`+${e.older} older · /more`)}` });
        (e.items || []).forEach((it, n) => {
          const ki = items.push({ copy: `${it.who} · ${when(it.ts)}\n${String(it.text ?? (it.pre || "") + (it.match || "") + (it.post || "")).replace(/\s+/g, " ").trim()}`, ref: it.ref, who: it.who }) - 1;
          const also = it.also?.length ? dim(` · also ${it.also.slice(0, 4).join(", ")}${it.also.length > 4 ? ` +${it.also.length - 4}` : ""}`) : "";
          // Name · time (Angus): the name in its agent's colour (looked up when the result has none,
          // e.g. /ask), the time grey; no number, no role.
          const col = it.color || known.find((a) => a.display === it.who || a.name === it.who)?.color || "";
          const head = `   ${hexFg(col, bold(it.who))}${dim(" · " + when(it.ts))}${also}`;
          flat.push({ l: head, meta: { item: ki, textX: 4, header: true } });
          const body = it.text != null ? String(it.text).replace(/\s+/g, " ") : null;
          const lines = body != null ? wrap(body, tw - 4).slice(0, 3).map((x) => `        ${x}`) : resultLines({ ...it, name: it.who }, -1, W).slice(1, 4).filter((x) => strip(x).trim()).map((x) => "     " + x.slice(1));
          for (const l of lines) flat.push({ l, meta: { item: ki, textX: 9 } });
        });
        if (e.answer) { flat.push({ l: "" }); add(md("↳ " + e.answer, tw, "   "), 4); } // the answer prints last, below the evidence
      }
      else if (e.role === "reply") { flat.push({ l: `   ${dim(italic(`↩ ${e.from} replied:`))}`, meta: { item: k, textX: 4 } }); add(md(e.text, tw - 2, "     ", dim).slice(0, 12), 6); }
      else add(md(e.text, tw, "   ", e.text.startsWith("✗") ? red : dim), 4);
    }
    if (!TH.entries.length) flat.push({ l: "" }, { l: dim(`   Thoughts-${room} is this world's own agent: think out loud, ask about what's going on,`) }, { l: dim("   have it keep a thought (\"keep this\"), ask an agent, or hand something off. It remembers.") }, { l: dim("   /keyword WORDS searches the history · /ask QUESTION answers from it, with the turns it used.") });
    if (TH.busy) flat.push({ l: "" }, { l: "   " + shimmer("thinking…", c) });
    if (EV.busy) flat.push({ l: "" }, { l: "   " + shimmerAt(EV.busy === "ask" ? "asking the history…" : "searching…", c, EV.startedAt) });
    const maxScroll = Math.max(0, flat.length - avail);
    TH.scroll = Math.max(0, Math.min(TH.scroll, maxScroll));
    const start = Math.max(0, flat.length - avail - TH.scroll), shown = flat.slice(start, start + avail);
    rows[ruleAt] = rule(TH.scroll ? `thread · ↓ ${TH.scroll} more below (^↓ / End)` : start ? "thread · ^↑ PgUp scroll back" : "thread");
    while (shown.length < avail) shown.unshift({ l: "" }); // a short thread sits just above the box, like a chat
    shown.forEach((x, k) => { if (x.meta) rowMeta[rows.length + 1 + k] = x.meta; if (x.links?.length) linkRows[rows.length + 1 + k] = x.links; });
    rows.push(...shown.map((x) => x.l));
  } else if (showHelp) {
    rows[ruleAt] = rule("help · Esc closes");
    rows.push(...helpLines().slice(0, avail));
  } else if (S.busy) {
    // Nothing from the previous search stays on screen while this one runs.
    rows[ruleAt] = rule(S.mode === "ai" ? "answer" : "results");
  } else {
    // The pane: in AI mode the answer (not selectable, i = -1), then the results
    // (the evidence). Flattened to lines; the selected result is kept in view.
    const flat = [], starts = [];
    if (S.answer) {
      items.push({ copy: S.answer });
      for (const l of wrap(S.answer, Math.max(10, W - 4))) flat.push({ l: `   ${l}`, i: -1, meta: { item: 0, textX: 4 } });
      flat.push({ l: "", i: -1 });
      if (S.results.length) flat.push({ l: fg(c, dim(`   evidence · ${S.results.length} entr${S.results.length === 1 ? "y" : "ies"}`)), i: -1 }, { l: "", i: -1 });
    }
    S.results.forEach((r, i) => {
      starts.push(flat.length);
      const k = items.push({ copy: `${r.name} · ${ROLE[r.role] || r.role} · ${when(r.ts)}\n${String((r.pre || "") + (r.match || "") + (r.post || "")).replace(/\s+/g, " ").trim()}${r.why ? "\n↳ " + r.why : ""}` }) - 1;
      resultLines(r, i, W).forEach((l, n) => flat.push({ l, i, meta: l === "" ? null : { item: k, textX: 5, header: n === 0 } }));
    });
    if (S.selected >= 0 && starts.length) {
      // Selecting the first result scrolls back to the top so the answer shows again.
      const s = S.selected === 0 ? 0 : starts[S.selected], e = (starts[S.selected + 1] ?? flat.length) - 1;
      if (s < top) top = s;
      if (e >= top + avail) top = Math.min(starts[S.selected], e - avail + 1);
    }
    top = Math.max(0, Math.min(top, Math.max(0, flat.length - avail)));
    const shown = flat.slice(top, top + avail);
    // Results wholly or partly out of view, like the room TUI's "↓ N more".
    let above = 0, below = 0;
    starts.forEach((st, i) => { const en = (starts[i + 1] ?? flat.length) - 1; if (st < top) above++; if (en >= top + avail && st >= top + avail) below++; });
    const label = S.answer ? "answer" : S.results.length ? "results" : "";
    rows[ruleAt] = rule(label ? [label, above ? `↑ ${above} above` : "", below ? `↓ ${below} below` : ""].filter(Boolean).join(" · ") : "");
    shown.forEach((x, k) => { if (x.i >= 0) resultRows[rows.length + 1 + k] = x.i; if (x.meta) rowMeta[rows.length + 1 + k] = x.meta; });
    if (S.ranFor && !S.busy && !S.results.length && !S.answer && !S.status.startsWith("✗")) shown.push({ l: dim(S.mode === "ai" ? "  Nothing matched that idea." : "  No exact matches.") });
    rows.push(...shown.map((x) => x.l));
  }
  while (rows.length < ruleAt + 1 + avail) rows.push(""); // the thread's area, then the bottom block
  rows.length = Math.min(rows.length, ruleAt + 1 + avail);
  const bottomY = rows.length + 1;
  rows.push(...bottom);
  const cursorRow = bottomY + boxAt + (L.cRow - inTop), cursorCol = Math.min(W, pw + L.cCol + 1);
  if (chipMd) linkRows[bottomY + chipAt] = chipMd.links.map((q) => ({ ...q, x0: q.x0 + pw, x1: q.x1 + pw }));
  while (rows.length < H - 1) rows.push("");

  // status bar: rooms as tabs (like the room TUI)
  const tabs = rooms.map((r) => r === room ? `${ESC}${worldBg(r)};30m ${r} ${ESC}49;39m` : ` ${fg(worldFg(r), r)} `).join("");
  const left = ` hyprpi thoughts ${online ? "" : "· daemon offline "}`;
  const right = `/keyword · /ask · /more · /help · ^Q quit `;
  const mid = W - width(left) - width(strip(tabs)) - width(right);
  worldBar = { y: rows.length + 1, x0: width(left) }; // a click on a world tab switches this panel (lib/tui/world-tabs.mjs)
  rows.push(`${ESC}7m${left}${ESC}27m${tabs}${ESC}7m${" ".repeat(Math.max(0, mid))}${right}${ESC}27m`);

  out(`\x1b]2;hyprpi-search ${room}\x07`); // panel identity: mockups/panels finds it by this exact title
  const clipped = rows.slice(0, H).map((r) => clip(r, W));
  screen = clipped.map(strip);
  const spans = selSpans(W);
  out(`${ESC}?2026h${ESC}H` + clipped.map((r, i) => (spans[i + 1] ? overlay(r, spans[i + 1][0], spans[i + 1][1], selOn, selOff) : r) + `${ESC}0m${ESC}K`).join("\r\n") + `${ESC}J`);
  out(`${ESC}${cursorRow};${cursorCol}H${ESC}?25h${ESC}?2026l`); // one synchronized frame, cursor never hidden (no flicker while "thinking…" animates)
}

// Ctrl+click: a link opens; an agent's name under the pointer (@Name, or as shown, "Sankey[e]"
// too) jumps to its window; elsewhere on a result, that result's agent (if still open).
// Matching: lib/tui/agent-click.mjs.
function ctrlClick(x, y) {
  const lt = linkAt(x, y);
  if (lt) { if (openTarget(lt)) { note = `opened ${lt.replace(process.env.HOME || "\0", "~")}`; render(); } return; }
  const word = wordAt(screen[y - 1] || "", x, gw);
  const url = urlIn(word);
  if (url) { try { spawnChild("gio", ["open", url], { detached: true, stdio: "ignore" }).on("error", () => {}).unref(); } catch { /* none */ } return; }
  if (!api) return;
  let hit = word ? agentIn(word, known.filter((ag) => ag.live)) : null;
  const ref = rowMeta[y] != null ? items[rowMeta[y].item]?.ref : null; // an evidence line: its turn's agent
  if (!hit && ref?.kind === "agent") {
    hit = known.find((ag) => ag.live && ag.id === ref.source) || null;
    if (!hit) { note = `${items[rowMeta[y].item].who} is closed`; return render(); }
  }
  if (!hit) { const n = bareName(word); if (n) { note = `no live agent @${n}`; render(); } return; }
  api.call("agent.focus", { agent: hit.id }).then(() => { note = `→ @${hit.display}`; render(); }).catch((e) => { note = "✗ " + e.message; render(); });
}
function jump() {
  const r = S.current();
  if (!r || !api) return;
  if (r.kind !== "agent" || !r.live) { note = r.kind === "room" ? "that's the room log (open the room with Ctrl+Tab in the room panel)" : `${r.name} is closed`; return render(); }
  note = "";
  api.call("agent.focus", { agent: r.source }).then(() => { note = "→ " + r.name; render(); }).catch((e) => { note = "✗ " + e.message; render(); });
}

async function start() {
  try {
    api = await connect({
      onEvent: (ev, data) => {
        if (ev === "agents") applyRooms(data);
        else if (ev === "selection" && data?.room === room) { marks = data; render(); }
        else if (ev === "search-run" && data?.room === room) runFrom(data.mode, data.query); // /search, /ai from another panel
        else if (ev === "thoughts" && data?.room === room) { if (data.entry) { TH.entries.push(data.entry); TH.scroll = 0; } if (data.busy !== undefined) TH.busy = !!data.busy; if (thoughtsOn) render(); }
      },
      onClose: () => { online = false; api = null; render(); setTimeout(start, 1500); },
    });
    online = true;
    if (thoughtsOn) loadThoughts();
    applyRooms(await api.call("ui.subscribe", { windows: false }));
    if (!startRan) { startRan = true; runFrom(startArgs.mode, startArgs.query); } // opened by /search or /ai elsewhere
    loadMarks(); render();
  } catch { online = false; render(); setTimeout(start, 1500); }
}
function applyRooms(r) {
  known = [...(r.agents || []).map((a) => ({ ...a, live: true })), ...(r.dormant || []).map((a) => ({ ...a, live: false }))];
  rooms = (r.rooms || []).map((x) => x.id).sort();
  if (!room) room = r.active_room || rooms[0] || "A";
  if (!rooms.includes(room)) rooms = [...rooms, room].sort();
  render();
}

// ---- input --------------------------------------------------------------------
// Alt+<key> arrives as ESC followed by the key; read it as ONE key so it can never
// look like a lone Esc (a lone Esc is only an ESC at the end of a read).
const KEY = /\x1b\[<[\d;]+[Mm]|\x1b\[[\d;?]*[A-Za-z~]|\x1bO[A-Za-z]|\x1b[\s\S]|[\s\S]/gu;
process.stdin.setRawMode?.(true);
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { for (const [k] of String(chunk).matchAll(KEY)) onKey(k); });
function move(d) { if (showHelp) return; TH.scroll = Math.max(0, TH.scroll - d * (Math.abs(d) >= 5 ? 1 : 3)); render(); }
function onKey(d) {
  if (sel && !d.startsWith("\x1b[<")) sel = null; // a pane selection lasts until the next key
  // Bracketed paste (SUPER+V / Ctrl+Shift+V): inserted as text (line breaks become spaces).
  if (d === "\x1b[200~") { pasting = true; return; }
  if (d === "\x1b[201~") { pasting = false; return render(); }
  if (pasting) return insertText(d);
  if (d === "\x11") return quit(); // Ctrl+Q
  if (d === "\x1b" || d === "\x1b\x1b") { // Esc: drop a box selection, close help, stop a search, else clear the box
    if (boxSel()) { selA = null; return render(); }
    if (showHelp) { showHelp = false; return render(); }
    if (query || attach.length) { setBox(""); attach = []; note = ""; return render(); }
    return;
  }
  // Ctrl+C: copy the box's selection, else the whole box; it never deletes it (Angus) and never
  // quits (Ctrl+Q does). Esc or Ctrl+U clears the box.
  if (d === "\x03") { if (copyBoxSel(false)) return; if (query) { copy(query); note = "copied the search"; } return render(); }
  if (d === "\x1b[2;5~") { copyBoxSel(false); return; } // SUPER+C (Ctrl+Insert, passed on when kitty has no selection)
  if (d === "\x18") { copyBoxSel(true); return; } // Ctrl+X: cut
  if (d === "\x16" || d === "\x1b[2;2~") return pasteClipboard(); // Ctrl+V / Shift+Insert: paste
  if (d === "\x1f" || d === "\x14") return toggleMode(); // Ctrl+/ or Ctrl+T: keyword ⇄ AI
  // Ctrl+Tab / Ctrl+Shift+Tab: next / previous world. Plain Tab never switches world:
  // it completes a /command or an @name (again: next match; Shift+Tab: back).
  if (CTRL_TAB.has(d)) return cycle(1);
  if (CTRL_SHIFT_TAB.has(d)) return cycle(-1);
  if (d === "\t" || d === "\x1b[Z") {
    if (d === "\t" && /^\/\S*$/.test(query)) return complete();
    if (completeName(d === "\t" ? 1 : -1)) return;
    note = "Tab completes @names and /commands · Ctrl+Tab switches world"; return render();
  }
  // Same scheme as the board: plain keys type (⏎ searches); ↑↓ / ^↑↓ move the highlight;
  // ^⏎ acts on it (jumps to that agent's window); ^click on a name jumps too.
  // Plain keys are the box's (↑ start, ↓ end of the one-line box); Ctrl is the pane's.
  if (d === "\x1b[1;5A") return move(-1);
  if (d === "\x1b[1;5B") return move(1);
  // ↑↓ like a Pi window (Angus): within the box first (↑ to its start, ↓ to its end); then ↑ steps
  // back through your earlier messages in this thread, ↓ forward again, to what you were typing.
  if (d === "\x1b[A" || d === "\x1b[B") { selA = null; return historyKey(d === "\x1b[A" ? -1 : 1); }
  if (d === "\x1b[13;5u") { showHelp = false; selA = null; return enter(); } // Ctrl+Enter: the same as ⏎ here
  if (d === "\x1b[5~") return move(-5);
  if (d === "\x1b[6~") return move(5);
  if (d === "\r") { showHelp = false; selA = null; return enter(); }
  // Editing the box (the shared box): ←→, Ctrl/Alt+←→ by word, Home/End, Shift-select,
  // Backspace / Delete / Alt+Backspace / Ctrl+W, Ctrl+U clear. Ctrl+A = Home here.
  if (d === "\x01") { qc = 0; selA = null; return render(); }
  if (d.startsWith("\x1b") || d === "\x7f" || d === "\b" || d === "\x15" || d === "\x05" || d === "\x17") {
    boxIn();
    if (box.key(d)) { boxOut(); note = ""; return render(); }
  }
  if (d.startsWith("\x1b[<")) {
    const m = /\x1b\[<(\d+);(\d+);(\d+)([Mm])/.exec(d); if (!m) return;
    const b = Number(m[1]), x = Number(m[2]), y = Number(m[3]);
    const tab = b === 0 && m[4] === "M" ? worldTabAt(worldBar, x, y, rooms) : null;
    if (tab) { const s = stepTo(rooms, room, tab); if (s) cycle(s); return; } // a world tab: like Ctrl+Tab
    if (b === 64) return move(-1);
    if (b === 65) return move(1);
    // Left button (+4 = Shift): press starts a possible selection, motion drags it,
    // release copies it; without a drag it is a click (select a result) or a
    // double / triple click (word / whole item).
    if (b === 16 && m[4] === "M") return ctrlClick(x, y); // Ctrl+click: an agent's name → its window
    if (b === 16) return;
    if ((b === 0 || b === 4) && m[4] === "M") {
      const now = Date.now();
      clicks = b === 0 && now - lastPress.t < 400 && y === lastPress.y && Math.abs(x - lastPress.x) <= 1 ? clicks + 1 : 1;
      lastPress = { x, y, t: now };
      sel = { x0: x, y0: y, x1: x, y1: y, dragging: false, clicks, mode: b === 4 && rowMeta[y] ? "item" : rowMeta[y] ? "text" : "plain" };
      return render();
    }
    if ((b === 32 || b === 36) && sel) { sel.x1 = x; sel.y1 = y; sel.dragging = true; return render(); }
    if ((b === 0 || b === 4) && m[4] === "m" && sel) {
      sel.x1 = x; sel.y1 = y;
      if ((sel.dragging || sel.mode === "item") && selRange()) { copy(selectedText()); return render(); } // highlight stays until the next key or click
      if (sel.clicks >= 2) return multiClick(Math.min(3, sel.clicks), x, y);
      sel = null;
      const lt = linkAt(x, y); // a plain click on a link / file path in the thread opens it
      if (lt) { if (openTarget(lt)) note = `opened ${lt.replace(process.env.HOME || "\0", "~")}`; return render(); }
      return render();
    }
    return;
  }
  if (d.startsWith("\x1b")) return; // any other Alt+key / unknown sequence: ignored, never quits
  if (!d.replace(/[\x00-\x1f]/g, "")) return;
  return insertText(d);
}
const MODES_OFF = `${ESC}?2004l${ESC}?1002l${ESC}?1000l${ESC}?1006l${ESC}?1049l${ESC}?25h`;
function quit() { out(MODES_OFF); process.exit(0); }
process.on("SIGTERM", quit);
process.stdout.on("resize", render);

// Restart when this panel's own code changes (a hyprpi update), so it is never stale.
import { spawn as spawnChild } from "node:child_process";
const CODE = [new URL("./search-tui.mjs", import.meta.url).pathname,
  ...["client.mjs", "paths.mjs", "search-view.mjs", "at-names.mjs", "tui/shimmer.mjs", "tui/input-box.mjs", "tui/command-line.mjs", "tui/agent-click.mjs", "tui/markdown.mjs"].map((f) => new URL("../lib/" + f, import.meta.url).pathname)];
const codeStamp = () => CODE.map((f) => { try { return fs.statSync(f).mtimeMs; } catch { return 0; } }).join(",");
const codeAtStart = codeStamp();
setInterval(() => {
  if (restarting || codeStamp() === codeAtStart || EV.busy) return; // (a Thoughts reply keeps coming in the daemon: fine to restart)
  restarting = true;
  try { api?.close?.(); } catch { /* fine */ }
  out(MODES_OFF);
  // The launcher (mockups/search-tui) loops on exit 75: the state goes in its file and this
  // process ends, so restarts don't pile up processes (N19). Older windows: a child, as before.
  const sf = process.env.HYPRPI_SEARCH_TUI_STATEFILE;
  if (sf) { try { fs.writeFileSync(sf, JSON.stringify({ query, qc })); } catch { /* start fresh */ } process.exit(75); }
  spawnChild(process.execPath, [CODE[0], room], { stdio: "inherit", env: process.env }).on("exit", (code) => process.exit(code ?? 0));
  process.stdin.setRawMode?.(false); process.stdin.pause();
}, 3000);
out(`${ESC}?1049h${ESC}?1000h${ESC}?1002h${ESC}?1006h${ESC}?2004h`); // alt screen + mouse (wheel, click, drag-select) + bracketed paste
{ // after a restart onto new code: the same words in the box, the same mode
  const sf = process.env.HYPRPI_SEARCH_TUI_STATEFILE;
  try { const k = sf && JSON.parse(fs.readFileSync(sf, "utf8") || "null"); if (sf) fs.writeFileSync(sf, "");
    if (k) { query = String(k.query || ""); qc = Math.min(Number(k.qc) || 0, graphemes(query).length); } } catch { /* fresh */ }
}
render();
start();
