// The message box, shared by the panels (first the board panel; the room and search panels can
// move onto it later). Lifted from mockups/room-tui.mjs so they all edit the same way:
//   typing / paste (bracketed, line breaks kept) · ←→ · Ctrl/Alt+←→ by word · Home/End ·
//   ↑↓ between lines (at the first/last line: start/end) · Shift+arrows / Shift+Home/End select ·
//   Backspace / Delete / Alt+Backspace (word) / Ctrl+U (clear) · Shift+Enter new line ·
//   Ctrl+C copy (no selection: the whole text; never deletes) · Ctrl+X cut · Ctrl+V / Shift+Insert paste · Ctrl+Insert copy
// Sent text (markSent): shown in the world colour; the first typed / pasted character replaces
// it (so a leftover can't be resent by accident); ←→ / Backspace first switch to editing it.
// The panel keeps Enter, Tab, Esc and everything with a meaning beyond the box.
// History (opt-in, Angus N51: ↑↓ the same in every panel, as the Thoughts window did it first):
// ↑ first moves in the box (up a line; at the first line to the start), and only at the start
// steps back through earlier entries; ↓ steps forward again, and finally back to the draft (what
// you were typing). While browsing, ↑ steps straight back. The panel calls remember(text) when it
// submits. createHistory(panel) keeps a panel's entries in STATE/input-history/<panel>.json.
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ESC, theme, rgb, graphemes, gw } from "./term.mjs";
import { stateDir } from "../paths.mjs";

// opts: onChange() re-render · copy(text) put text on the clipboard (the panel's copy + note)
//       tint(graphemes, i) -> fn(g) styling a grapheme, or null (e.g. @names in their colours)
//       sentStyle(g) style of sent text (default: none) · multiline (default true)
//       history: { list() -> earlier entries, oldest first; add?(text) } (e.g. createHistory(panel))
//       historyNotes: { first, none } what box.note says at the oldest entry / with none at all
//       bind: { read() -> { text, cursor, anchor, sent?, touched? }, write(state) } for a panel that keeps
//             the box's state in its own variables (Angus N55: no panel keeps its own box glue): every
//             box operation loads them first and writes them back after, async paste included
export function createInputBox({ onChange = () => {}, copy = () => {}, tint = null, sentStyle = null, multiline = true,
  history = null, historyNotes = {}, bind = null } = {}) {
  const b = { text: "", cursor: 0, anchor: null, pasting: false, sent: null, touched: false, goal: null };
  const h = { i: -1, draft: "", note: "" }; // i: -1 = the draft; note: what the last ↑↓ wants said
  let lastWidth = Infinity; // the width layout() last drew at: ↑↓ move by its rows (Infinity: line breaks only)
  const gsOf = () => graphemes(b.text);
  const sel = () => (b.anchor == null || b.anchor === b.cursor ? null : b.anchor < b.cursor ? [b.anchor, b.cursor] : [b.cursor, b.anchor]);
  const isSent = () => b.sent != null && b.text === b.sent;
  // onChange runs once, after the operation (and after a bound panel's variables are written back).
  let depth = 0, pending = false;
  const changed = () => { if (depth) pending = true; else onChange(); return true; };
  const op = (fn) => (...a) => {
    depth++; let r;
    try { if (bind) load(bind.read()); r = fn(...a); if (bind) bind.write(state()); }
    finally { depth--; }
    if (!depth && pending) { pending = false; onChange(); }
    return r;
  };
  const look = (fn) => (...a) => { if (bind && !depth) load(bind.read()); return fn(...a); };

  function set(t, cursor = null) { b.text = String(t ?? ""); const n = graphemes(b.text).length; b.cursor = cursor == null ? n : Math.max(0, Math.min(n, cursor)); b.anchor = null; return changed(); }
  function clear() { b.sent = null; b.touched = false; h.i = -1; h.draft = ""; return set(""); }
  // The panel submitted text: keep it (when it has a history) and stop browsing.
  function remember(t) { const s = String(t ?? "").trim(); if (s) history?.add?.(s); h.i = -1; h.draft = ""; }
  function markSent() { b.sent = b.text; b.touched = false; return changed(); }
  function insert(t) {
    if (isSent() && !b.touched) { b.text = ""; b.cursor = 0; b.anchor = null; b.sent = null; }
    let gs = gsOf(); const rs = sel();
    if (rs) { gs = [...gs.slice(0, rs[0]), ...gs.slice(rs[1])]; b.cursor = rs[0]; }
    b.anchor = null;
    let s = String(t).replace(/\r\n?/g, "\n");
    if (!multiline) s = s.replace(/[\n\t]+/g, " ");
    const ins = graphemes(s.replace(/[\x00-\x09\x0b-\x1f]/g, ""));
    b.cursor = Math.max(0, Math.min(b.cursor, gs.length));
    b.text = [...gs.slice(0, b.cursor), ...ins, ...gs.slice(b.cursor)].join(""); b.cursor += ins.length;
    return changed();
  }
  function copySel(cut) {
    const rs = sel(); if (!rs) return false;
    const gs = gsOf();
    copy(gs.slice(rs[0], rs[1]).join(""));
    if (cut) { b.text = [...gs.slice(0, rs[0]), ...gs.slice(rs[1])].join(""); b.cursor = rs[0]; }
    b.anchor = null; return changed();
  }
  // The clipboard arrives later: that insert is its own operation (loads / writes back a bound panel).
  function paste() { clipboardPaste(op((t, o) => (o?.image ? insertPath(t) : insert(t)))); return true; }
  // A pasted image's path (Angus, N54: like pi's own windows): inserted at the cursor as its own word,
  // spaced off from the text on either side, so it sits right next to what it is about.
  function insertPath(p) {
    if (sel()) insert(""); // replace the selection first
    const gs = gsOf(), before = gs[b.cursor - 1], after = gs[b.cursor];
    // …and followed by a space at the end of the text too (J108 follow-up): Angus pastes first and types
    // straight on, and "….pnglook" would be neither a path nor an attached image.
    return insert((before && !/\s/.test(before) ? " " : "") + p + (!after || !/\s/.test(after) ? " " : ""));
  }

  // One key. true = the box used it (the panel re-renders via onChange); false = not the box's.
  function key(d) {
    h.note = "";
    if (!["\x1b[A", "\x1b[B", "\x1b[1;2A", "\x1b[1;2B"].includes(d)) b.goal = null; // the sticky column lasts through ↑↓ only
    if (d === "\x1b[200~") { b.pasting = true; return true; }
    if (d === "\x1b[201~") { b.pasting = false; return changed(); }
    if (b.pasting) return insert(d === "\r" ? "\n" : d);
    // Ctrl+C copies, never deletes (Angus): the selection, else the whole text. Empty: not the box's.
    if (d === "\x03") { if (copySel(false)) return true; if (!b.text) return false; copy(b.text); return true; } // Ctrl+C
    if (d === "\x1b[2;5~") { copySel(false); return true; } // Ctrl+Insert
    if (d === "\x18") { copySel(true); return true; }      // Ctrl+X
    if (d === "\x16" || d === "\x1b[2;2~") return paste(); // Ctrl+V / Shift+Insert
    if (d === "\x1b[13;2u") return multiline ? insert("\n") : true; // Shift+Enter
    const gs = gsOf();
    b.cursor = Math.max(0, Math.min(b.cursor, gs.length));
    const c = b.cursor, rs = sel();
    const edited = (next, at) => { b.text = next.join(""); b.cursor = at; b.anchor = null; return changed(); };
    const wordLeft = () => { let i = c; while (i > 0 && /\s/.test(gs[i - 1])) i--; while (i > 0 && !/\s/.test(gs[i - 1])) i--; return i; };
    const wordRight = () => { let i = c; while (i < gs.length && /\s/.test(gs[i])) i++; while (i < gs.length && !/\s/.test(gs[i])) i++; return i; };
    const lineStart = (i) => { while (i > 0 && gs[i - 1] !== "\n") i--; return i; };
    const lineEnd = (i) => { while (i < gs.length && gs[i] !== "\n") i++; return i; };
    const moveTo = (i, extend) => {
      if (isSent()) b.touched = true;
      if (extend) { if (b.anchor == null) b.anchor = c; } else b.anchor = null;
      b.cursor = Math.max(0, Math.min(gs.length, i)); return changed();
    };
    // ↑↓ / Shift+↑↓ (Angus, N55): one VISUAL row up or down (the box's own wrap at the width it was
    // last drawn at, and its line breaks) to the same column, clamped to that row; a sticky goal
    // column across consecutive moves. Only from the top row to the start, from the last to the end.
    const vert = (up, extend) => {
      const rows = rowsAt(gs, lastWidth);
      let r = rows.findIndex((row, k) => c >= row.start && (c < row.end || (c === row.end && (row.nl || k === rows.length - 1))));
      if (r < 0) r = rows.length - 1;
      if (b.goal == null) { let w = 0; for (let k = rows[r].start; k < c; k++) w += gw(gs[k]); b.goal = w; }
      const t = up ? r - 1 : r + 1;
      if (t < 0) return moveTo(0, extend);
      if (t >= rows.length) return moveTo(gs.length, extend);
      const row = rows[t], last = row.nl || t === rows.length - 1 ? row.end : Math.max(row.start, row.end - 1);
      let i = row.start, w = 0;
      while (i < last && w + gw(gs[i]) <= b.goal) { w += gw(gs[i]); i++; }
      return moveTo(i, extend);
    };
    if (history && (d === "\x1b[A" || d === "\x1b[B")) { // ↑↓ with a history (N51)
      const list = history.list() || [];
      const show = (t) => { b.sent = null; b.touched = false; return set(t); };
      if (d === "\x1b[A") {
        if (h.i < 0 && c > 0) return vert(true, false); // first the box: up a line, then to the start
        if (h.i + 1 >= list.length) { h.note = list.length ? historyNotes.first || "that's the first one here" : historyNotes.none || "nothing earlier here yet"; return true; }
        if (h.i < 0) h.draft = b.text;
        h.i++; return show(list[list.length - 1 - h.i]);
      }
      if (h.i < 0) return c < gs.length ? vert(false, false) : true; // first the box: down a line, then to the end
      h.i--; return show(h.i < 0 ? h.draft : list[list.length - 1 - h.i]);
    }
    switch (d) {
      case "\x1b[1;2D": return moveTo(c - 1, true);
      case "\x1b[1;2C": return moveTo(c + 1, true);
      case "\x1b[1;6D": return moveTo(wordLeft(), true);
      case "\x1b[1;6C": return moveTo(wordRight(), true);
      case "\x1b[1;2H": return moveTo(lineStart(c), true);
      case "\x1b[1;2F": return moveTo(lineEnd(c), true);
      case "\x1b[1;2A": return vert(true, true);
      case "\x1b[1;2B": return vert(false, true);
      case "\x1b[A": return vert(true, false);
      case "\x1b[B": return vert(false, false);
      case "\x1b[D": return moveTo(rs ? rs[0] : c - 1);
      case "\x1b[C": return moveTo(rs ? rs[1] : c + 1);
      case "\x1b[1;5D": case "\x1b[1;3D": case "\x1bb": return moveTo(wordLeft());
      case "\x1b[1;5C": case "\x1b[1;3C": case "\x1bf": return moveTo(wordRight());
      case "\x1b[H": case "\x1b[1~": return moveTo(lineStart(c));
      case "\x05": case "\x1b[F": case "\x1b[4~": return moveTo(lineEnd(c));
      case "\x15": return clear(); // Ctrl+U
    }
    if (d === "\x7f" || d === "\b") { if (isSent()) b.touched = true; if (rs) return edited([...gs.slice(0, rs[0]), ...gs.slice(rs[1])], rs[0]); if (!c) return true; return edited([...gs.slice(0, c - 1), ...gs.slice(c)], c - 1); }
    if (d === "\x1b[3~") { if (rs) return edited([...gs.slice(0, rs[0]), ...gs.slice(rs[1])], rs[0]); if (c >= gs.length) return true; return edited([...gs.slice(0, c), ...gs.slice(c + 1)], c); }
    if (d === "\x1b\x7f" || d === "\x17") { const i = wordLeft(); return edited([...gs.slice(0, i), ...gs.slice(c)], i); } // Alt+Backspace / Ctrl+W
    if (d.startsWith("\x1b")) return false; // any other escape sequence: the panel's
    if (!d.replace(/[\x00-\x1f]/g, "")) return false; // other control keys: the panel's
    return insert(d);
  }

  // Rows of the box at width n (soft-wrapped; selection highlighted; sent text / tint styled) and
  // where the cursor is.
  function layout(n) {
    lastWidth = n;
    const gs = gsOf(), rs = sel(), rows = [];
    const on = theme.selection ? `${ESC}48;2;${rgb(theme.selection)}m` : `${ESC}7m`, off = theme.selection ? `${ESC}49m` : `${ESC}27m`;
    const sent = isSent() && sentStyle;
    const paint = sent ? gs.map(() => sentStyle) : tint ? gs.map((_, i) => tint(gs, i)) : [];
    let line = "", lw = 0, cRow = 0, cCol = 0;
    for (let i = 0; i <= gs.length; i++) {
      if (i < gs.length && gs[i] !== "\n" && lw + gw(gs[i]) > n) { rows.push(line); line = ""; lw = 0; }
      if (i === b.cursor) { cRow = rows.length; cCol = lw; }
      if (i === gs.length) break;
      if (gs[i] === "\n") { rows.push(rs && i >= rs[0] && i < rs[1] ? line + on + " " + off : line); line = ""; lw = 0; continue; }
      const g = paint[i] ? paint[i](gs[i]) : gs[i];
      line += rs && i >= rs[0] && i < rs[1] ? on + g + off : g; lw += gw(gs[i]);
    }
    rows.push(line);
    return { rows, cRow, cCol };
  }

  // Double / triple click in the box (Angus via Thoughts-A, @hyprpi N79). row = a row as layout()
  // drew it (0 = the first, before any scrolling), col = the display column in that row. A double
  // click selects the word there: a run of non-spaces, leading punctuation (except @ # ~ / $) and
  // trailing punctuation dropped, as the panes' double click does; on a space it only puts the
  // cursor there. A triple click selects the whole LOGICAL line there (between line breaks, not one
  // wrapped row). It is the box's own selection: Ctrl+C / SUPER+C copy it, typing replaces it.
  function indexAt(row, col) {
    const gs = gsOf(), rows = rowsAt(gs, lastWidth);
    const r = rows[Math.max(0, Math.min(rows.length - 1, row))];
    let i = r.start, w = 0;
    while (i < r.end && w + gw(gs[i]) <= col) { w += gw(gs[i]); i++; }
    return i;
  }
  function selectRange(a, e) {
    h.note = ""; b.goal = null;
    if (isSent()) b.touched = true; // typing then replaces the selection, not the whole sent text
    if (a === e) { b.anchor = null; b.cursor = a; } else { b.anchor = a; b.cursor = e; }
    return changed();
  }
  function selectWordAt(row, col) {
    const gs = gsOf(); if (!gs.length) return false;
    const i = indexAt(row, col);
    if (i >= gs.length || /\s/.test(gs[i])) return selectRange(i, i);
    let a = i, e = i + 1;
    while (a > 0 && !/\s/.test(gs[a - 1])) a--;
    while (e < gs.length && !/\s/.test(gs[e])) e++;
    const P = /^[\p{P}\p{S}]$/u;
    while (a < e - 1 && P.test(gs[a]) && !/[@#~/$]/.test(gs[a])) a++;
    while (e - 1 > a && P.test(gs[e - 1])) e--;
    return selectRange(a, e);
  }
  function selectLineAt(row, col) {
    const gs = gsOf(); if (!gs.length) return false;
    let a = indexAt(row, col), e = a;
    while (a > 0 && gs[a - 1] !== "\n") a--;
    while (e < gs.length && gs[e] !== "\n") e++;
    return selectRange(a, e);
  }
  const selectAt = (row, col, clicks) => (clicks >= 3 ? selectLineAt(row, col) : clicks === 2 ? selectWordAt(row, col) : false);

  // For panels that keep their own variables (room, search): load them before a key, read them
  // back after. anchor = selection anchor; sent = the text last sent (or null); touched = the
  // cursor was moved into the sent text (typing then edits it instead of replacing it).
  function load({ text = "", cursor = null, anchor = null, sent = null, touched = false } = {}) {
    b.text = String(text); const n = graphemes(b.text).length;
    b.cursor = cursor == null ? n : Math.max(0, Math.min(n, cursor)); b.anchor = anchor; b.sent = sent; b.touched = !!touched;
  }
  const state = () => ({ text: b.text, cursor: b.cursor, anchor: b.anchor, sent: isSent() ? b.sent : null, touched: b.touched });

  return {
    load, state, // (kept for callers that drive the box by hand; bound panels never need them)
    get text() { return look(() => b.text)(); }, get cursor() { return look(() => b.cursor)(); }, get sent() { return look(isSent)(); },
    get selection() { return look(sel)(); }, dropSelection: op(() => { if (b.anchor == null) return false; b.anchor = null; return changed(); }),
    get note() { return h.note; }, get browsing() { return h.i >= 0; },
    set: op(set), clear: op(clear), insert: op(insert), insertPath: op(insertPath), markSent: op(markSent), key: op(key),
    layout: look(layout), copySel: op(copySel), paste: op(paste), remember: op(remember),
    selectWordAt: op(selectWordAt), selectLineAt: op(selectLineAt), selectAt: op(selectAt),
  };
}

// Where a click lands in a panel's box (N79): the panel drew the box's rows from layout row `inTop`
// on, at screen rows y0 … y0+n-1 (1-based), each after a prompt (or its indent) pw cells wide.
// x, y: the click (1-based). → { row, col } for box.selectAt / selectWordAt / selectLineAt, or null.
export function boxHit(area, x, y) {
  if (!area || !area.n || y < area.y0 || y >= area.y0 + area.n) return null;
  return { row: area.inTop + (y - area.y0), col: Math.max(0, x - 1 - area.pw) };
}

// The rows layout() draws at width n, as grapheme ranges [{ start, end, nl }] (end exclusive; nl: the
// row ends at a line break). A cursor at a wrap point belongs to the next row, as layout() puts it.
function rowsAt(gs, n) {
  const rows = []; let start = 0, lw = 0;
  for (let i = 0; i < gs.length; i++) {
    if (gs[i] === "\n") { rows.push({ start, end: i, nl: true }); start = i + 1; lw = 0; continue; }
    const w = gw(gs[i]);
    if (lw + w > n && i > start) { rows.push({ start, end: i, nl: false }); start = i; lw = 0; }
    lw += w;
  }
  rows.push({ start, end: gs.length, nl: false });
  return rows;
}

// Paste from the Wayland clipboard (Angus, N54). An image (a screenshot) is saved like pi's own,
// pi-clipboard-<id>.<ext>, in ~/Screenshots (the phone app serves it; Angus, J71), or /tmp when that
// folder is missing, and cb(path, { image: true }) puts its path where the cursor is
// (box.insertPath); otherwise cb(text). Panels that keep their own box variables call this with
// their own insert; the box's paste() uses it directly.
// The pasted path is written with the home shorthand, "~/Screenshots/…" (Angus, J108: "let's just start it with
// a ~"): a message that starts with the pasted path then never starts with "/", so it isn't taken for a
// /command. Readers expand it (search-tui imagePaths, markdown linkTarget, pi's read tool, the phone's /file).
export function tildePath(f) {
  const home = process.env.HOME || os.homedir();
  return home && (f === home || f.startsWith(home + "/")) ? "~" + f.slice(home.length) : f;
}
export function clipboardPaste(cb) {
  const text = () => {
    try {
      const p = spawn("wl-paste", ["--no-newline", "--type", "text/plain"], { stdio: ["ignore", "pipe", "ignore"] });
      let buf = ""; p.stdout.on("data", (x) => { buf += x; }); p.on("error", () => {}); p.on("close", () => { if (buf) cb(buf); });
    } catch { /* no wl-paste */ }
  };
  try {
    const lt = spawn("wl-paste", ["--list-types"], { stdio: ["ignore", "pipe", "ignore"] });
    let types = ""; lt.stdout.on("data", (x) => { types += x; }); lt.on("error", text);
    lt.on("close", () => {
      const img = types.split("\n").map((x) => x.trim()).find((x) => /^image\/(png|jpeg|webp|gif)$/.test(x));
      if (!img) return text();
      const shots = path.join(process.env.HOME || os.homedir(), "Screenshots");
      const dir = (() => { try { return fs.statSync(shots).isDirectory() ? shots : "/tmp"; } catch { return "/tmp"; } })();
      const f = path.join(dir, `pi-clipboard-${randomUUID()}.${img === "image/jpeg" ? "jpg" : img.split("/")[1]}`);
      let fd; try { fd = fs.openSync(f, "w", 0o600); } catch { return text(); } // only Angus can read it (the phone app runs as him)
      const p = spawn("wl-paste", ["--type", img], { stdio: ["ignore", fd, "ignore"] });
      const done = (code) => { try { fs.closeSync(fd); } catch { /* closed */ } let n = 0; try { n = fs.statSync(f).size; } catch { /* gone */ } if (!code && n) cb(tildePath(f), { image: true }); };
      p.on("error", () => done(1)); p.on("close", done);
    });
  } catch { text(); }
}

// A panel's input history in STATE/input-history/<panel>.json (Angus N51): one list per panel,
// shared by its windows in every world (re-read when another window wrote it), kept across the
// panels' restarts; at most `cap` entries, no consecutive repeats.
export function createHistory(panel, { cap = 300, env = process.env } = {}) {
  const file = path.join(stateDir(env), "input-history", `${String(panel).replace(/[^\w.-]/g, "_")}.json`);
  let list = [], mtime = -1;
  const load = () => {
    try {
      const m = fs.statSync(file).mtimeMs;
      if (m !== mtime) { mtime = m; const x = JSON.parse(fs.readFileSync(file, "utf8")); list = Array.isArray(x) ? x.filter((s) => typeof s === "string") : []; }
    } catch { /* none yet */ }
    return list;
  };
  return {
    file,
    list: load,
    add(t) {
      const l = load();
      if (l[l.length - 1] === t) return;
      l.push(t); if (l.length > cap) l.splice(0, l.length - cap);
      try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file + ".tmp", JSON.stringify(l)); fs.renameSync(file + ".tmp", file);
        mtime = fs.statSync(file).mtimeMs;
      } catch { /* best effort */ }
    },
  };
}

// A tint for @names: projects in the world colour (bold), agents in their colours, @all /
// @nobody bold, unknown names red. resolve(name) -> { project?, agent?, special? } or null.
export function atTint(resolve, { worldFg, bold, nameFg }) {
  return (gs, i) => {
    let a = i; while (a > 0 && !/[\s]/.test(gs[a - 1])) a--;
    if (gs[a] !== "@") return null;
    let j = a + 1; while (j < gs.length && !/[\s,@]/.test(gs[j])) j++;
    if (j === a + 1 || i >= j) return null;
    const r = resolve(gs.slice(a + 1, j).join(""));
    if (r?.project) return (g) => worldFg(bold(g));
    if (r?.agent) return (g) => nameFg(r.agent.name, r.agent.color, g);
    if (r?.special) return (g) => bold(g);
    return (g) => `${ESC}31m${g}${ESC}39m`;
  };
}
