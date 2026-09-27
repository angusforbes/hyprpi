#!/usr/bin/env node
// MOCKUP: terminal search panel (panel 3, SUPER+ALT+/; ui/SearchWindow.qml stays the
// real one). Two views over one room, both through the daemon:
//   search — every agent's conversation (closed ones too) plus the room log ("search")
//   ask    — a one-shot short answer about the room, with the lines it cites ("ask")
// Both follow the agent panel's marks (▸, the daemon's per-room selection): with only
// some agents marked they cover just those; Ctrl+A switches to the whole room and back.
//
//   ~/Work/hyprpi/mockups/search-tui [ROOM]   (kitty launcher)
//
// Nothing runs until Enter (Enter again on unchanged words jumps to the selected
// result). Keyword: exact words, case-insensitive, newest first. AI: describe what you
// mean; a small model picks matches and says why. Keys: Ctrl+/ search ⇄ ask · Ctrl+T
// keyword ⇄ AI · Ctrl+A marked ⇄ whole room · Tab / Shift+Tab room (or complete a
// /command) · ↑↓ PgUp PgDn wheel select / scroll · click select, double-click jump ·
// Esc clears the box (empty: ask → search) · Ctrl+C clears · Ctrl+Q quits.
// Box: ←→ Home End, Ctrl/Alt+←→ word, Backspace Delete, Ctrl+W / Alt+Backspace word,
// Ctrl+U clear. Commands: /search WORDS · /ai DESCRIPTION · /ask QUESTION · /help ·
// //text searches for "/text". Shift+drag selects text (kitty's own selection).
// Search/ask state lives in lib/search-view.mjs (shared with the old room TUI search).
import fs from "node:fs";
import { connect } from "../lib/client.mjs";
import { createSearch, askRows } from "../lib/search-view.mjs";

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
const ROLE = { angus: "Angus", agent: "agent", room: "room", talk: "talk" };

const t = { dim, bold, italic, clip, width, hexFg, rgb, get theme() { return theme; } };

// ---- state ------------------------------------------------------------------
let api = null, online = false, rooms = [], room = (process.argv[2] || "").toUpperCase();
let view = "search", showHelp = false, note = "";
const box = { search: "", ask: "" }, cur = { search: 0, ask: 0 }; // one box per view, cursor in graphemes
let top = 0, askTop = 0, resultRows = {}; // resultRows: screen row -> result index
let marks = { all: true, agents: [] }, useMarks = true;
const onlyIds = () => (useMarks && !marks.all ? marks.agents : []);
const S = createSearch({ api: () => api, room: () => room, onChange: () => render(), only: onlyIds, closed: true, roomLog: true, order: "auto" });

const COMMANDS = ["/search", "/ai", "/ask", "/help"];
const matchCommands = (name) => COMMANDS.filter((c) => c.startsWith(name.toLowerCase()));

function scopeLabel() {
  const ids = onlyIds();
  if (ids.length) return `only ${ids.length} marked agent${ids.length === 1 ? "" : "s"} (^A whole room)`;
  if (!marks.all && !useMarks) return "whole room, marks ignored (^A marked only)";
  return view === "ask" ? "the whole room" : "every agent's conversation + the room log";
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
  marks = { all: true, agents: [] }; top = 0; askTop = 0; note = "";
  S.reset(); loadMarks(); render();
}
function toggleMarks() {
  if (marks.all) { note = "every agent is marked (mark some in the agent panel, SUPER+ALT+A)"; return render(); }
  useMarks = !useMarks; top = 0;
  S.reset();
  note = onlyIds().length ? `only the ${onlyIds().length} marked` : "whole room";
  render();
}
function setView(v) { if (v === view) return; view = v; showHelp = false; note = ""; render(); }

function enter() {
  const raw = box[view].trim();
  if (raw.startsWith("/") && !raw.startsWith("//")) return command(raw);
  const text = raw.startsWith("//") ? raw.slice(1) : raw;
  if (view === "ask") { if (!text) return; askTop = 0; return S.askQuestion(text); }
  if (!text) return jump();
  const r = S.ranFor;
  if (r && r.q === text && r.mode === S.mode && r.room === room && r.only === onlyIds().join(",") && !S.busy) return jump();
  top = 0; S.run(text, S.mode);
}
function setBox(v, text) { box[v] = text; cur[v] = graphemes(text).length; }
function command(raw) {
  const m = raw.match(/^(\/\S*)\s*([\s\S]*)$/), name = m[1], arg = m[2].trim();
  const hits = COMMANDS.includes(name.toLowerCase()) ? [name.toLowerCase()] : matchCommands(name);
  if (hits.length !== 1) { note = hits.length ? "which one? " + hits.join(" ") : `unknown command ${name} (try /help)`; return render(); }
  const cmd = hits[0]; note = ""; showHelp = false;
  if (cmd === "/help") { setBox(view, ""); showHelp = true; return render(); }
  if (cmd === "/ask") { view = "ask"; setBox("ask", arg); if (arg) { askTop = 0; S.askQuestion(arg); } return render(); }
  const mode = cmd === "/ai" ? "ai" : "keyword";
  view = "search"; setBox("search", arg);
  if (arg) { top = 0; S.run(arg, mode); }
  else { if (S.mode !== mode) S.toggleMode(); render(); }
}
function complete() {
  const hits = matchCommands(box[view]);
  if (!hits.length) { note = "no such command (try /help)"; return render(); }
  if (hits.length === 1) { setBox(view, hits[0] + " "); note = ""; return render(); }
  let pre = hits[0];
  for (const h of hits) while (!h.startsWith(pre)) pre = pre.slice(0, -1);
  setBox(view, pre); note = hits.join("  "); render();
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
    k("Enter", "search · Enter again on the same words jumps to the selected result · in ask: ask"),
    k("Ctrl+/", "switch search ⇄ ask"),
    k("Ctrl+T", "keyword ⇄ AI (search)"),
    k("Ctrl+A", "only the marked agents (▸, set in the agent panel) ⇄ the whole room"),
    k("Tab / Shift+Tab", "next / previous room (while typing a /command: complete it)"),
    k("↑↓ PgUp PgDn wheel", "select a result · scroll the answer"),
    k("click / double-click", "select / jump to that agent's window"),
    k("Esc", "clear the box (empty box in ask: back to search) · closes this help"),
    k("Ctrl+C · Ctrl+Q", "clear the box · quit"),
    k("editing", "←→ Home End · Ctrl/Alt+←→ word · Ctrl+W / Alt+Backspace word · Ctrl+U clear"),
    "",
    k("/search WORDS", "keyword search (no words: keyword mode)"),
    k("/ai DESCRIPTION", "search by meaning (no words: AI mode)"),
    k("/ask QUESTION", "a one-shot short answer with the lines it cites"),
    k("/help", "this list"),
    k("//text", "search for (or ask) \"/text\""),
  ];
}

let restarting = false; // re-exec in progress: the child owns the terminal
function render() {
  if (restarting) return;
  const W = process.stdout.columns || 100, H = process.stdout.rows || 30, c = worldFg(room);
  const rows = [];
  const rule = (label) => fg(c, "─" + (label ? ` ${label} ` : "") + "─".repeat(Math.max(0, W - 1 - (label ? width(label) + 2 : 0))));
  const text = box[view];
  rows.push(rule(`${view} · room ${room} · ${scopeLabel()}`));
  const prompt = fg(c, bold(view === "ask" ? "? " : S.mode === "ai" ? "✦ " : "⌕ "));
  const hint = text ? "" : dim(view === "ask" ? "a question about this room, e.g. what did we decide about the bar colours" : S.mode === "ai" ? "what are you looking for? e.g. where did we decide on the colours" : "exact words (case-insensitive) · /help");
  rows.push(`${prompt}${text}${hint}`);
  const cursorRow = rows.length;
  const tag = (on, off) => `${ESC}${worldBg(room)};30m ${on} ${ESC}49;39m ${dim(off)}`;
  const status = note || (view === "ask" ? "" : S.status);
  const statusStyled = status.startsWith("✗") ? `${ESC}31m${status}${ESC}39m` : dim(status);
  rows.push(view === "ask"
    ? ` ${tag("ask", "search")}  ${note ? statusStyled : dim("one-shot, no memory · Ctrl+/ back to search")}`
    : ` ${S.mode === "ai" ? tag("✦ AI", "keyword") : tag("keyword", "✦ AI")}  ${S.busy ? fg(c, "… ") : ""}${statusStyled}`);
  const ruleAt = rows.length; rows.push("");
  const avail = Math.max(1, H - rows.length - 1);
  resultRows = {};

  if (showHelp) {
    rows[ruleAt] = rule("help · Esc closes");
    rows.push(...helpLines().slice(0, avail));
  } else if (view === "ask") {
    const pane = askRows(S, W, c, t, wrap);
    askTop = Math.max(0, Math.min(askTop, Math.max(0, pane.length - avail)));
    const below = Math.max(0, pane.length - askTop - avail);
    rows[ruleAt] = rule(["answer", askTop ? `↑ ${askTop} above` : "", below ? `↓ ${below} below` : ""].filter(Boolean).join(" · "));
    rows.push(...pane.slice(askTop, askTop + avail));
  } else {
    // Results: flatten to lines, keep the selected one in view.
    const flat = [], starts = [];
    S.results.forEach((r, i) => { starts.push(flat.length); for (const l of resultLines(r, i, W)) flat.push({ l, i }); });
    if (S.selected >= 0 && starts.length) {
      const s = starts[S.selected], e = (starts[S.selected + 1] ?? flat.length) - 1;
      if (s < top) top = s;
      if (e >= top + avail) top = Math.min(s, e - avail + 1);
    }
    top = Math.max(0, Math.min(top, Math.max(0, flat.length - avail)));
    const shown = flat.slice(top, top + avail);
    const firstShown = shown.length ? shown[0].i : 0, lastShown = shown.length ? shown[shown.length - 1].i : -1;
    const above = shown.length ? firstShown + (top > (starts[firstShown] ?? 0) ? 1 : 0) : 0;
    const below = shown.length ? S.results.length - 1 - lastShown : 0;
    rows[ruleAt] = rule(S.results.length ? ["results", above ? `↑ ${above} above` : "", below ? `↓ ${below} below` : ""].filter(Boolean).join(" · ") : "");
    shown.forEach((x, k) => { resultRows[rows.length + 1 + k] = x.i; });
    if (S.ranFor && !S.busy && !S.results.length && !S.status.startsWith("✗")) shown.push({ l: dim(S.mode === "ai" ? "  Nothing matched that idea." : "  No exact matches.") });
    rows.push(...shown.map((x) => x.l));
  }
  while (rows.length < H - 1) rows.push("");

  // status bar: rooms as tabs (like the room TUI)
  const tabs = rooms.map((r) => r === room ? `${ESC}${worldBg(r)};30m ${r} ${ESC}49;39m` : ` ${fg(worldFg(r), r)} `).join("");
  const left = ` hyprpi ${view} ${online ? "" : "· daemon offline "}`;
  const pos = view === "search" && S.results.length ? (S.selected + 1) + "/" + S.results.length + " · " : "";
  const right = `${pos}${view === "ask" ? "^/ search" : "^/ ask · ^T mode"} · ^A scope · /help · ^Q quit `;
  const mid = W - width(left) - width(strip(tabs)) - width(right);
  rows.push(`${ESC}7m${left}${ESC}27m${tabs}${ESC}7m${" ".repeat(Math.max(0, mid))}${right}${ESC}27m`);

  out(`\x1b]2;hyprpi-search ${room}\x07`); // `mockups/panels` finds this window by title
  out(`${ESC}?25l${ESC}H` + rows.slice(0, H).map((r) => clip(r, W) + `${ESC}0m${ESC}K`).join("\r\n") + `${ESC}J`);
  out(`${ESC}${cursorRow};${width(prompt) + width(graphemes(text).slice(0, cur[view]).join("")) + 1}H${ESC}?25h`);
}

function jump() {
  const r = S.current();
  if (!r || !api) return;
  if (r.kind !== "agent" || !r.live) { note = r.kind === "room" ? "that's the room log (open the room with Tab in the room TUI)" : `${r.name} is closed`; return render(); }
  note = "";
  api.call("agent.focus", { agent: r.source }).then(() => { note = "→ " + r.name; render(); }).catch((e) => { note = "✗ " + e.message; render(); });
}

async function start() {
  try {
    api = await connect({
      onEvent: (ev, data) => {
        if (ev === "agents") applyRooms(data);
        else if (ev === "selection" && data?.room === room) { marks = data; render(); }
      },
      onClose: () => { online = false; api = null; render(); setTimeout(start, 1500); },
    });
    online = true;
    applyRooms(await api.call("ui.subscribe", { windows: false }));
    loadMarks(); render();
  } catch { online = false; render(); setTimeout(start, 1500); }
}
function applyRooms(r) {
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
function move(d) {
  if (showHelp) return;
  if (view === "ask") { askTop = Math.max(0, askTop + d); return render(); }
  S.move(d);
}
function onKey(d) {
  if (d === "\x11") return quit(); // Ctrl+Q
  if (d === "\x1b" || d === "\x1b\x1b") { // Esc: close help, clear the box, empty ask → search
    if (showHelp) { showHelp = false; return render(); }
    if (box[view]) { setBox(view, ""); note = ""; return render(); }
    if (view === "ask") return setView("search");
    return;
  }
  if (d === "\x03") { setBox(view, ""); note = ""; return render(); } // Ctrl+C: clear
  if (d === "\x1f") return setView(view === "search" ? "ask" : "search"); // Ctrl+/
  if (d === "\x14") { if (view === "search") { note = ""; S.toggleMode(); } return; } // Ctrl+T
  if (d === "\x01" && !box[view]) return toggleMarks(); // Ctrl+A (empty box; else: Home)
  if (d === "\t") return /^\/\S*$/.test(box[view]) ? complete() : cycle(1);
  if (d === "\x1b[Z") return cycle(-1);
  if (d === "\x1b[A") return move(-1);
  if (d === "\x1b[B") return move(1);
  if (d === "\x1b[5~") return move(-5);
  if (d === "\x1b[6~") return move(5);
  if (d === "\r") { showHelp = false; return enter(); }
  // Editing the box: ←/→ (Ctrl/Alt: by word), Home/End or Ctrl+A/E,
  // Backspace / Delete at the cursor, Ctrl+W / Alt+Backspace delete word, Ctrl+U clear.
  const gs = graphemes(box[view]);
  const qc = Math.max(0, Math.min(cur[view], gs.length));
  const edited = (next, c) => { box[view] = next.join(""); cur[view] = c; note = ""; return render(); };
  const at = (c) => { cur[view] = c; return render(); };
  const wordLeft = () => { let i = qc; while (i > 0 && /\s/.test(gs[i - 1])) i--; while (i > 0 && !/\s/.test(gs[i - 1])) i--; return i; };
  const wordRight = () => { let i = qc; while (i < gs.length && /\s/.test(gs[i])) i++; while (i < gs.length && !/\s/.test(gs[i])) i++; return i; };
  if (d === "\x1b[D") return at(Math.max(0, qc - 1));
  if (d === "\x1b[C") return at(Math.min(gs.length, qc + 1));
  if (d === "\x1b[1;5D" || d === "\x1b[1;3D" || d === "\x1bb") return at(wordLeft());
  if (d === "\x1b[1;5C" || d === "\x1b[1;3C" || d === "\x1bf") return at(wordRight());
  if (d === "\x1b[H" || d === "\x1b[1~" || d === "\x01") return at(0);
  if (d === "\x1b[F" || d === "\x1b[4~" || d === "\x05") return at(gs.length);
  if (d === "\x15") return edited([], 0);
  if (d === "\x17" || d === "\x1b\x7f" || d === "\x1b\b") { const i = wordLeft(); return edited([...gs.slice(0, i), ...gs.slice(qc)], i); }
  if (d === "\x7f" || d === "\b") { if (!qc) return; return edited([...gs.slice(0, qc - 1), ...gs.slice(qc)], qc - 1); }
  if (d === "\x1b[3~") { if (qc >= gs.length) return; return edited([...gs.slice(0, qc), ...gs.slice(qc + 1)], qc); }
  if (d.startsWith("\x1b[<")) {
    const m = /\x1b\[<(\d+);(\d+);(\d+)([Mm])/.exec(d); if (!m) return;
    const b = Number(m[1]), y = Number(m[3]);
    if (b === 64) return move(-1);
    if (b === 65) return move(1);
    if (b === 0 && m[4] === "M" && view === "search" && !showHelp && resultRows[y] !== undefined) {
      const i = resultRows[y];
      if (i === S.selected && Date.now() - (onKey.lastClick || 0) < 400) jump();
      S.selected = i; onKey.lastClick = Date.now(); return render();
    }
    return;
  }
  if (d.startsWith("\x1b")) return; // any other Alt+key / unknown sequence: ignored, never quits
  const ins = graphemes(d.replace(/[\x00-\x1f]/g, ""));
  if (!ins.length) return;
  edited([...gs.slice(0, qc), ...ins, ...gs.slice(qc)], qc + ins.length);
}
function quit() { out(`${ESC}?1000l${ESC}?1006l${ESC}?1049l${ESC}?25h`); process.exit(0); }
process.on("SIGTERM", quit);
process.stdout.on("resize", render);

// Restart when this panel's own code changes (a hyprpi update), so it is never stale.
import { spawn as spawnChild } from "node:child_process";
const CODE = [new URL("./search-tui.mjs", import.meta.url).pathname,
  ...["client.mjs", "paths.mjs", "search-view.mjs"].map((f) => new URL("../lib/" + f, import.meta.url).pathname)];
const codeStamp = () => CODE.map((f) => { try { return fs.statSync(f).mtimeMs; } catch { return 0; } }).join(",");
const codeAtStart = codeStamp();
setInterval(() => {
  if (restarting || codeStamp() === codeAtStart || search?.busy) return;
  restarting = true;
  try { api?.close?.(); } catch { /* fine */ }
  out(`${ESC}?1000l${ESC}?1006l${ESC}?1049l${ESC}?25h`);
  spawnChild(process.execPath, [CODE[0], room], { stdio: "inherit", env: process.env }).on("exit", (code) => process.exit(code ?? 0));
  process.stdin.setRawMode?.(false); process.stdin.pause();
}, 3000);
out(`${ESC}?1049h${ESC}?1000h${ESC}?1006h`); // alt screen + mouse (wheel, click; Shift+drag = kitty selection)
render();
start();
