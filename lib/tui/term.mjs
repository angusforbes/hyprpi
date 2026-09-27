// Shared terminal layer for the hyprpi TUI panels (agents, room/stream, search):
// theme colours, world colours, display widths that match what kitty draws, wrapping.
// Extracted verbatim from mockups/room-tui.mjs (see docs/panels-plan.md).
import fs from "node:fs";

export const ESC = "\x1b[";
export const out = (s) => process.stdout.write(s);
// World colours: exactly the bar's (agf.hyprwrlds BarWidget.qml paletteKeys),
// read from the Omarchy theme's colors.toml, re-read when the theme changes.
export const COLORS = `${process.env.HOME}/.local/state/omarchy/current/theme/colors.toml`;
export const PALETTE = [["blue", "color4"], ["red", "color1"], ["cyan", "color6"], ["yellow", "color3"], ["magenta", "color5"], ["green", "color2"], ["orange", "color11"], ["brown", "color9"], ["foreground", "color7"]];
export const theme = {}; // mutated in place, so importers always see the current colours
const onTheme = [];
export const onThemeChange = (fn) => { onTheme.push(fn); };
function loadTheme() {
  for (const k of Object.keys(theme)) delete theme[k];
  try { for (const l of fs.readFileSync(COLORS, "utf8").split("\n")) { const m = l.match(/^\s*([A-Za-z0-9_-]+)\s*=\s*["']?#([0-9A-Fa-f]{6})/); if (m) theme[m[1]] = m[2]; } } catch { /* ANSI fallback */ }
}
loadTheme();
try { fs.watchFile(COLORS, { interval: 2000 }, () => { loadTheme(); for (const fn of onTheme) fn(); }).unref?.(); } catch { /* fine */ }
export const rgb = (hex) => { const n = parseInt(hex, 16); return `${n >> 16};${(n >> 8) & 255};${n & 255}`; };
export function worldHex(room) {
  const i = "ABCDEFGHI".indexOf(String(room)[0]);
  for (const k of PALETTE[Math.max(0, i) % PALETTE.length]) if (theme[k]) return theme[k];
  return null;
}
export const worldFg = (room) => { const h = worldHex(room); return h ? `38;2;${rgb(h)}` : "34"; };
export const worldBg = (room) => { const h = worldHex(room); return h ? `48;2;${rgb(h)}` : "44"; };
export const dim = (s) => `${ESC}2m${s}${ESC}22m`;
// Between normal text and dim: the theme's foreground mixed 65/35 with its background.
export function midFg(s) {
  const f = theme.foreground, b = theme.background;
  if (!f || !b) return s;
  const F = parseInt(f, 16), B = parseInt(b, 16), m = (sh) => Math.round(((F >> sh) & 255) * 0.65 + ((B >> sh) & 255) * 0.35);
  return `${ESC}38;2;${m(16)};${m(8)};${m(0)}m${s}${ESC}39m`;
}
export const bold = (s) => `${ESC}1m${s}${ESC}22m`;
export const fg = (c, s) => `${ESC}${c}m${s}${ESC}39m`;
// herdr-name markup "{#f7768e}S{#ff9e64}p…": each part in its own colour
// (text before the first tag in the fallback colour).
export function markupFg(markup, fallback) {
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
export const unnamed = (name) => !name || /^pi·[0-9a-z]{4}$/.test(String(name));
export const nameFg = (name, color, s) => unnamed(name) ? bold(s) : hexFg(color, bold(s));
export const hexFg = (hex, s) => { const m = /^#?([0-9a-f]{6})$/i.exec(hex || ""); if (!m) return s; const n = parseInt(m[1], 16); return `${ESC}38;2;${n >> 16};${(n >> 8) & 255};${n & 255}m${s}${ESC}39m`; };

// Display width (emoji / CJK = 2, combining / ZWJ / VS = 0), enough for names and chat.
export function cw(cp) {
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
export const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
export const graphemes = (s) => Array.from(segmenter.segment(String(s)), (x) => x.segment);
export function gw(g) {
  const cps = [...g].map((c) => c.codePointAt(0));
  if (cps.length > 1 && cps.some((cp) => cp === 0xfe0f || cp === 0x200d || (cp >= 0x1f1e6 && cp <= 0x1f1ff) || /\p{Extended_Pictographic}/u.test(String.fromCodePoint(cp)))) return 2;
  let w = 0; for (const cp of cps) w += cw(cp); return w;
}
export const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");
// Widths and wraps are memoised: every frame re-lays out the whole stream, and
// grapheme segmentation is the expensive part (a frame went from ~55 ms to a few).
export const memo = (max, f) => { const m = new Map(); return (k, ...a) => { let v = m.get(k); if (v === undefined) { if (m.size >= max) m.clear(); v = f(k, ...a); m.set(k, v); } return v; }; };
export const widthOf = memo(20000, (s) => { let w = 0; for (const g of graphemes(strip(s))) w += gw(g); return w; });
export const width = (s) => widthOf(String(s));
export function cut(s, n) { let w = 0, r = ""; for (const g of graphemes(s)) { const c = gw(g); if (w + c > n) return w + 1 <= n ? r + "…" : cut(r, n - 1) ; w += c; r += g; } return r; }
// Cut a styled line to n columns, keeping its escape codes intact.
export function clip(s, n) {
  let w = 0, r = "";
  for (const part of s.split(/(\x1b\[[0-9;?]*[A-Za-z])/)) {
    if (part.startsWith("\x1b")) { r += part; continue; }
    for (const g of graphemes(part)) { const c = gw(g); if (w + c > n) return r + `${ESC}0m`; w += c; r += g; }
  }
  return r;
}
export const pad = (s, n) => s + " ".repeat(Math.max(0, n - width(s)));
export const wrapMemo = memo(20000, (key, text, n) => wrapRaw(text, n));
export const wrap = (text, n) => wrapMemo(n + "\u0000" + text, String(text), n);
export function wrapRaw(text, n) {
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
export function hardWrap(text, n) {
  const lines = []; let line = "", lw = 0;
  for (const g of graphemes(text)) { const c = gw(g); if (lw + c > n) { lines.push(line); line = ""; lw = 0; } line += g; lw += c; }
  lines.push(line);
  return lines;
}
