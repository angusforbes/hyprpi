#!/usr/bin/env node
// MOCKUP: terminal version of the hyprpi search window (ui/SearchWindow.qml,
// which stays the real one). Searches every agent's conversation in a room,
// plus the room log, through the daemon's "search" method.
//
//   ~/Work/hyprpi/mockups/search-tui [ROOM]   (kitty launcher)
//
// Keyword mode (default): exact words, case-insensitive, live as you type.
// AI mode: describe what you mean, press Enter; a small model picks matches and
// says why. Ctrl+/ (or Ctrl+T) switches mode · Tab / Shift+Tab switch room ·
// ↑↓ / wheel / click select · PgUp/PgDn page · Enter on a result jumps to that
// agent's window (live agents) · ←→ Home End Ctrl+←→ move in the search box,
// Backspace/Delete, Ctrl+W word, Ctrl+U clear · Esc / Ctrl+C quit.
// Shift+drag selects text (kitty's own selection).
import fs from "node:fs";
import { connect } from "../lib/client.mjs";

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

// ---- state ------------------------------------------------------------------
let api = null, online = false, rooms = [], room = (process.argv[2] || "").toUpperCase();
let qc = 0; // cursor position in the query, in graphemes
let mode = "keyword", query = "", results = [], status = "", busy = false, gen = 0;
let selected = -1, top = 0, lastMeta = null, resultRows = []; // resultRows: screen row -> result index

function run() {
  const q = query.trim(), g = ++gen;
  if (!q) { results = []; selected = -1; busy = false; status = mode === "ai" ? "Describe what you're looking for, then Enter." : ""; return render(); }
  if (!api) { status = "✗ daemon offline"; return render(); }
  busy = true;
  status = mode === "ai" ? "Thinking… (reading the room's recent conversations)" : "Searching…";
  render();
  api.call("search", { room, query: q, mode }, { timeoutMs: 180000 }).then((r) => {
    if (g !== gen) return;
    busy = false; results = r.results || []; selected = results.length ? 0 : -1; top = 0;
    const ms = r.ms >= 1000 ? (r.ms / 1000).toFixed(1) + " s" : r.ms + " ms";
    status = `${results.length} result${results.length === 1 ? "" : "s"} · ${r.sources} sources${r.scanned ? " · " + r.scanned + " entries read" : ""} · ${ms}`;
    render();
  }).catch((e) => { if (g !== gen) return; busy = false; results = []; selected = -1; status = "✗ " + e.message; render(); });
}
let debounceT = null;
const debounce = () => { clearTimeout(debounceT); debounceT = setTimeout(run, 180); };

function setMode(m) {
  if (m === mode) return;
  mode = m; results = []; selected = -1; top = 0;
  status = m === "ai" ? "Describe what you're looking for, then Enter." : "";
  if (m === "keyword") run(); else render();
}
function cycle(d) {
  if (!rooms.length) return;
  const i = Math.max(0, rooms.indexOf(room));
  room = rooms[(i + d + rooms.length) % rooms.length];
  results = []; selected = -1; top = 0;
  if (mode === "keyword" || query.trim() === "") run(); else { status = "Enter to search room " + room; render(); }
}

// One result as screen lines.
function resultLines(r, i, W) {
  const c = worldFg(room), sel = i === selected;
  const head = `${r.icon ? r.icon + " " : ""}${hexFg(r.color, bold(r.name))}${r.live ? "" : dim(" (closed)")}` +
    dim(` · ${ROLE[r.role] || r.role} · ${when(r.ts)}${r.count > 1 ? " · ×" + r.count : ""}`);
  const bar = sel ? fg(c, "▌") : " ";
  const textW = Math.max(10, W - 4);
  // Snippet: pre + MATCH + post, wrapped, the match in the world colour, max 4 lines.
  const pre = String(r.pre || ""), match = String(r.match || ""), post = String(r.post || "");
  const full = (pre + match + post).replace(/\s+/g, " ");
  const a = pre.replace(/\s+/g, " ").length, b = a + match.replace(/\s+/g, " ").length;
  let pos = 0;
  const body = wrap(full, textW).slice(0, 4).map((l) => {
    // find this line in `full` from pos
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

function render() {
  const W = process.stdout.columns || 100, H = process.stdout.rows || 30, c = worldFg(room);
  const rows = [];
  const rule = (label) => fg(c, "─" + (label ? ` ${label} ` : "") + "─".repeat(Math.max(0, W - 1 - (label ? width(label) + 2 : 0))));
  const modeTag = mode === "ai" ? `${ESC}${worldBg(room)};30m ✦ AI ${ESC}49;39m ${dim("keyword")}` : `${ESC}${worldBg(room)};30m keyword ${ESC}49;39m ${dim("✦ AI")}`;
  rows.push(rule(`search · room ${room} · every agent's conversation + the room log`));
  const prompt = fg(c, bold(mode === "ai" ? "✦ " : "⌕ "));
  const hint = query ? "" : dim(mode === "ai" ? "what are you looking for? e.g. where did we decide on the colours" : "exact words (case-insensitive)");
  rows.push(`${prompt}${query}${hint}`);
  const cursorRow = rows.length;
  rows.push(` ${modeTag}  ${busy ? fg(c, "… ") : ""}${status.startsWith("✗") ? `${ESC}31m${status}${ESC}39m` : dim(status)}`);
  rows.push(rule(""));

  // Results: flatten to lines, keep the selected one in view.
  const avail = Math.max(1, H - rows.length - 1);
  const flat = [], starts = [];
  results.forEach((r, i) => { starts.push(flat.length); for (const l of resultLines(r, i, W)) flat.push({ l, i }); });
  if (selected >= 0) {
    const s = starts[selected], e = (starts[selected + 1] ?? flat.length) - 1;
    if (s < top) top = s;
    if (e >= top + avail) top = Math.min(s, e - avail + 1);
  }
  top = Math.max(0, Math.min(top, Math.max(0, flat.length - avail)));
  const shown = flat.slice(top, top + avail);
  resultRows = {};
  shown.forEach((x, k) => { resultRows[rows.length + 1 + k] = x.i; });
  if (!results.length && !busy && query.trim() && /result/.test(status)) shown.push({ l: dim(mode === "ai" ? "  Nothing matched that idea." : "  No exact matches.") });
  rows.push(...shown.map((x) => x.l));
  while (rows.length < H - 1) rows.push("");

  // status bar: rooms as tabs (like the room TUI)
  const tabs = rooms.map((r) => r === room ? `${ESC}${worldBg(r)};30m ${r} ${ESC}49;39m` : ` ${fg(worldFg(r), r)} `).join("");
  const left = ` hyprpi search ${online ? "" : "· daemon offline "}`;
  const right = `${results.length ? (selected + 1) + "/" + results.length + " · " : ""}^/ mode · ⏎ ${mode === "ai" ? "search / " : ""}jump · Esc quit `;
  const mid = W - width(left) - width(strip(tabs)) - width(right);
  rows.push(`${ESC}7m${left}${ESC}27m${tabs}${ESC}7m${" ".repeat(Math.max(0, mid))}${right}${ESC}27m`);

  out(`\x1b]2;hyprpi search · room ${room}\x07`);
  out(`${ESC}?25l${ESC}H` + rows.slice(0, H).map((r) => clip(r, W) + `${ESC}0m${ESC}K`).join("\r\n") + `${ESC}J`);
  out(`${ESC}${cursorRow};${width(prompt) + width(graphemes(query).slice(0, qc).join("")) + 1}H${ESC}?25h`);
}

function jump() {
  const r = results[selected];
  if (!r || !api) return;
  if (r.kind !== "agent" || !r.live) { status = r.kind === "room" ? "that's the room log (open the room with Tab in the room TUI)" : `${r.name} is closed`; return render(); }
  api.call("agent.focus", { agent: r.source }).then(() => { status = "→ " + r.name; render(); }).catch((e) => { status = "✗ " + e.message; render(); });
}

async function start() {
  try {
    api = await connect({
      onEvent: (ev, data) => { if (ev === "agents") applyRooms(data); },
      onClose: () => { online = false; api = null; render(); setTimeout(start, 1500); },
    });
    online = true;
    applyRooms(await api.call("ui.subscribe", { windows: false }));
    if (query.trim()) run(); else { status = ""; render(); }
  } catch { online = false; render(); setTimeout(start, 1500); }
}
function applyRooms(r) {
  rooms = (r.rooms || []).map((x) => x.id).sort();
  if (!room) room = r.active_room || rooms[0] || "A";
  if (!rooms.includes(room)) rooms = [...rooms, room].sort();
  render();
}

// ---- input --------------------------------------------------------------------
const KEY = /\x1b[bf]|\x1b\[<[\d;]+[Mm]|\x1b\[[\d;]*[A-Za-z~]|\x1bO[A-Za-z]|\x1b|[\s\S]/gu;
process.stdin.setRawMode?.(true);
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { for (const [k] of String(chunk).matchAll(KEY)) onKey(k); });
function move(d) { if (!results.length) return; selected = Math.max(0, Math.min(results.length - 1, selected + d)); render(); }
function onKey(d) {
  if (d === "\x03" || d === "\x1b") return quit();
  if (d === "\x1f" || d === "\x14") return setMode(mode === "ai" ? "keyword" : "ai"); // Ctrl+/ or Ctrl+T
  if (d === "\t") return cycle(1);
  if (d === "\x1b[Z") return cycle(-1);
  if (d === "\x1b[A") return move(-1);
  if (d === "\x1b[B") return move(1);
  if (d === "\x1b[5~") return move(-5);
  if (d === "\x1b[6~") return move(5);
  if (d === "\r") { if (mode === "ai" && query.trim() && (!results.length || lastMeta !== query)) { lastMeta = query; return run(); } return jump(); }
  // Editing the search box: ←/→ (Ctrl: by word), Home/End or Ctrl+A/E,
  // Backspace / Delete at the cursor, Ctrl+W delete word, Ctrl+U clear.
  const gs = graphemes(query);
  qc = Math.max(0, Math.min(qc, gs.length));
  const edited = (next, c) => { query = next.join(""); qc = c; lastMeta = null; return mode === "keyword" ? debounce() : render(); };
  const wordLeft = () => { let i = qc; while (i > 0 && /\s/.test(gs[i - 1])) i--; while (i > 0 && !/\s/.test(gs[i - 1])) i--; return i; };
  const wordRight = () => { let i = qc; while (i < gs.length && /\s/.test(gs[i])) i++; while (i < gs.length && !/\s/.test(gs[i])) i++; return i; };
  if (d === "\x1b[D") { qc = Math.max(0, qc - 1); return render(); }
  if (d === "\x1b[C") { qc = Math.min(gs.length, qc + 1); return render(); }
  if (d === "\x1b[1;5D" || d === "\x1bb") { qc = wordLeft(); return render(); }
  if (d === "\x1b[1;5C" || d === "\x1bf") { qc = wordRight(); return render(); }
  if (d === "\x1b[H" || d === "\x1b[1~" || d === "\x01") { qc = 0; return render(); }
  if (d === "\x1b[F" || d === "\x1b[4~" || d === "\x05") { qc = gs.length; return render(); }
  if (d === "\x15") return edited([], 0);
  if (d === "\x17") { const i = wordLeft(); return edited([...gs.slice(0, i), ...gs.slice(qc)], i); }
  if (d === "\x7f" || d === "\b") { if (!qc) return; return edited([...gs.slice(0, qc - 1), ...gs.slice(qc)], qc - 1); }
  if (d === "\x1b[3~") { if (qc >= gs.length) return; return edited([...gs.slice(0, qc), ...gs.slice(qc + 1)], qc); }
  if (d.startsWith("\x1b[<")) {
    const m = /\x1b\[<(\d+);(\d+);(\d+)([Mm])/.exec(d); if (!m) return;
    const b = Number(m[1]), y = Number(m[3]);
    if (b === 64) return move(-1);
    if (b === 65) return move(1);
    if (b === 0 && m[4] === "M" && resultRows[y] !== undefined) {
      const i = resultRows[y];
      if (i === selected && Date.now() - (onKey.lastClick || 0) < 400) jump();
      selected = i; onKey.lastClick = Date.now(); return render();
    }
    return;
  }
  if (d.startsWith("\x1b")) return;
  const ins = graphemes(d.replace(/[\x00-\x1f]/g, ""));
  if (!ins.length) return;
  edited([...gs.slice(0, qc), ...ins, ...gs.slice(qc)], qc + ins.length);
}
function quit() { out(`${ESC}?1000l${ESC}?1006l${ESC}?1049l${ESC}?25h`); process.exit(0); }
process.on("SIGTERM", quit);
process.stdout.on("resize", render);
out(`${ESC}?1049h${ESC}?1000h${ESC}?1006h`); // alt screen + mouse (wheel, click; Shift+drag = kitty selection)
render();
start();
