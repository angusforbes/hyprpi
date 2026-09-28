// The message box, shared by the panels (first the board panel; the room and search panels can
// move onto it later). Lifted from mockups/room-tui.mjs so they all edit the same way:
//   typing / paste (bracketed, line breaks kept) · ←→ · Ctrl/Alt+←→ by word · Home/End ·
//   ↑↓ between lines (at the first/last line: start/end) · Shift+arrows / Shift+Home/End select ·
//   Backspace / Delete / Alt+Backspace (word) / Ctrl+U (clear) · Shift+Enter new line ·
//   Ctrl+C copy (no selection: clear) · Ctrl+X cut · Ctrl+V / Shift+Insert paste · Ctrl+Insert copy
// Sent text (markSent): shown in the world colour; the first typed / pasted character replaces
// it (so a leftover can't be resent by accident); ←→ / Backspace first switch to editing it.
// The panel keeps Enter, Tab, Esc and everything with a meaning beyond the box.
import { spawn } from "node:child_process";
import { ESC, theme, rgb, graphemes, gw } from "./term.mjs";

// opts: onChange() re-render · copy(text) put text on the clipboard (the panel's copy + note)
//       tint(graphemes, i) -> fn(g) styling a grapheme, or null (e.g. @names in their colours)
//       sentStyle(g) style of sent text (default: none) · multiline (default true)
export function createInputBox({ onChange = () => {}, copy = () => {}, tint = null, sentStyle = null, multiline = true } = {}) {
  const b = { text: "", cursor: 0, anchor: null, pasting: false, sent: null, touched: false };
  const gsOf = () => graphemes(b.text);
  const sel = () => (b.anchor == null || b.anchor === b.cursor ? null : b.anchor < b.cursor ? [b.anchor, b.cursor] : [b.cursor, b.anchor]);
  const isSent = () => b.sent != null && b.text === b.sent;
  const changed = () => { onChange(); return true; };

  function set(t, cursor = null) { b.text = String(t ?? ""); const n = graphemes(b.text).length; b.cursor = cursor == null ? n : Math.max(0, Math.min(n, cursor)); b.anchor = null; return changed(); }
  function clear() { b.sent = null; b.touched = false; return set(""); }
  function markSent() { b.sent = b.text; b.touched = false; onChange(); }
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
  function paste() {
    try {
      const p = spawn("wl-paste", ["--no-newline", "--type", "text/plain"], { stdio: ["ignore", "pipe", "ignore"] });
      let buf = ""; p.stdout.on("data", (x) => { buf += x; }); p.on("error", () => {}); p.on("close", () => { if (buf) insert(buf); });
    } catch { /* no wl-paste */ }
    return true;
  }

  // One key. true = the box used it (the panel re-renders via onChange); false = not the box's.
  function key(d) {
    if (d === "\x1b[200~") { b.pasting = true; return true; }
    if (d === "\x1b[201~") { b.pasting = false; return changed(); }
    if (b.pasting) return insert(d === "\r" ? "\n" : d);
    if (d === "\x03") { if (copySel(false)) return true; if (!b.text) return false; return clear(); } // Ctrl+C
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
    const vert = (up, extend) => {
      const s0 = lineStart(c), col = c - s0;
      if (up) { if (!s0) return moveTo(0, extend); const p0 = lineStart(s0 - 1); return moveTo(Math.min(p0 + col, s0 - 1), extend); }
      const e0 = lineEnd(c); if (e0 >= gs.length) return moveTo(gs.length, extend);
      const n1 = lineEnd(e0 + 1); return moveTo(Math.min(e0 + 1 + col, n1), extend);
    };
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

  // For panels that keep their own variables (room, search): load them before a key, read them
  // back after. anchor = selection anchor; sent = the text last sent (or null); touched = the
  // cursor was moved into the sent text (typing then edits it instead of replacing it).
  function load({ text = "", cursor = null, anchor = null, sent = null, touched = false } = {}) {
    b.text = String(text); const n = graphemes(b.text).length;
    b.cursor = cursor == null ? n : Math.max(0, Math.min(n, cursor)); b.anchor = anchor; b.sent = sent; b.touched = !!touched;
  }
  const state = () => ({ text: b.text, cursor: b.cursor, anchor: b.anchor, sent: isSent() ? b.sent : null, touched: b.touched });

  return {
    load, state,
    get text() { return b.text; }, get cursor() { return b.cursor; }, get sent() { return isSent(); },
    get selection() { return sel(); }, dropSelection() { if (b.anchor == null) return false; b.anchor = null; return changed(); },
    set, clear, insert, markSent, key, layout, copySel, paste,
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
