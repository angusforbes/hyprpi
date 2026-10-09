// A little Markdown for chat text in the panels (the search panel's Thoughts thread): **bold**,
// __bold__, *italic*, `code`, # headings (bold), "- " / "* " bullets (•, hanging indent), and
// LINKS (Angus: every link and file path must be clickable): [label](url) shows the label
// underlined; <https://…> / <file://…> autolinks show without their brackets (J358); bare https:// and file:// URLs, ~/… and /… paths (in `backticks` they may contain
// spaces) are underlined too. Everything else stays as typed.
//
// mdLines(text, width, wrap) → styled lines, wrapped by the panel's own word wrap (wrap(plain, n)
// → lines of plain text), so widths match the rest. mdRows(text, width, wrap, gw) → the same as
// { line, links: [{ x0, x1, target }] } (0-based columns within the line, x1 exclusive; gw(ch)
// = a character's width) so the panel can open what's clicked (openTarget).
import fs from "node:fs";
import { spawn } from "node:child_process";
import { isolatedReason } from "../paths.mjs";

const ESC = "\x1b[";
const HOME = process.env.HOME || "";

// A path or URL as something to open: file paths expanded (~, %20) and checked to exist.
export function linkTarget(s) {
  let t = String(s || "").trim();
  if (/^https?:\/\//i.test(t)) return t.replace(/[)\].,;:!?'"]+$/, "");
  if (/^file:\/\//i.test(t)) { try { t = decodeURIComponent(t.replace(/^file:\/\//i, "")); } catch { t = t.replace(/^file:\/\//i, ""); } }
  if (t.startsWith("~/")) t = HOME + t.slice(1);
  if (!t.startsWith("/")) return null;
  const tryIt = (x) => { try { fs.statSync(x); return x; } catch { return null; } };
  return tryIt(t) || tryIt(t.replace(/[)\].,;:!?'"]+$/, "")) || null;
}
// J358: a file:// URI inside <…> names exactly one path: it links only when that path exists (no punctuation fallback).
function exactFile(u) {
  let t; try { t = decodeURIComponent(u.replace(/^file:\/\//i, "")); } catch { return null; }
  if (!t.startsWith("/")) return null;
  try { fs.statSync(t); return t; } catch { return null; }
}
// Open with the default app; a Markdown file in the Obsidian vault opens in Obsidian.
export function openTarget(target) {
  if (!target || isolatedReason(process.env)) return false; // J333: an isolated hyprpi opens no windows
  let arg = target;
  const vault = HOME + "/Obsidian/";
  if (target.startsWith(vault) && /\.md$/i.test(target) && fs.existsSync(vault + ".obsidian")) arg = `obsidian://open?path=${encodeURIComponent(target)}`;
  try { const p = spawn("gio", ["open", arg], { detached: true, stdio: "ignore" }); p.on("error", () => {}); p.unref(); return true; } catch { return false; }
}

// One line of text → { plain, style[], link[] } with the markers removed (per UTF-16 unit).
// style bits: 1 bold, 2 italic, 4 code, 8 link. link[k] = index into targets, or -1.
function inline(src) {
  let plain = "";
  const style = [], link = [], targets = [];
  let b = false, i = false;
  const push = (text, s, li = -1) => { for (const ch of text) { plain += ch; for (let u = 0; u < ch.length; u++) { style.push(s); link.push(li); } } };
  const cur = () => (b ? 1 : 0) | (i ? 2 : 0);
  for (let k = 0; k < src.length;) {
    // [label](url)
    if (src[k] === "[") {
      const m = /^\[([^\]\n]+)\]\(((?:[^()\s]|\([^()\s]*\)|%20)+|<[^>]+>)\)/.exec(src.slice(k));
      if (m) {
        const tgt = linkTarget(m[2].replace(/^<|>$/g, "")) || (/^https?:/i.test(m[2]) ? m[2] : null);
        if (tgt) { targets.push(tgt); push(m[1].replace(/\*\*|`/g, ""), cur() | 8, targets.length - 1); k += m[0].length; continue; }
      }
    }
    if (src.startsWith("**", k) || src.startsWith("__", k)) {
      const mk = src.slice(k, k + 2), close = src.indexOf(mk, k + 2);
      if (b || close > k + 2) { b = !b; k += 2; continue; }
    }
    if (src[k] === "`") {
      const close = src.indexOf("`", k + 1);
      if (close > k + 1) {
        const inner = src.slice(k + 1, close), tgt = /^(~\/|\/|file:\/\/|https?:\/\/)/.test(inner) ? linkTarget(inner) : null;
        if (tgt) targets.push(tgt);
        push(inner, cur() | 4 | (tgt ? 8 : 0), tgt ? targets.length - 1 : -1);
        k = close + 1; continue;
      }
    }
    if (src[k] === "*" && (i ? src[k - 1] !== " " : src[k + 1] && src[k + 1] !== " " && src.indexOf("*", k + 1) > k + 1)) { i = !i; k += 1; continue; }
    // J358: a CommonMark autolink <https://…> / <file://…>: the inside is the link, the brackets are hidden
    // (an unresolvable target or anything else in <…>, e.g. <b>, stays as typed)
    if (src[k] === "<") {
      const m = /^<((?:https?|file):\/\/[^<>\s]+)>/i.exec(src.slice(k));
      const tgt = m && (/^https?:/i.test(m[1]) ? m[1] : exactFile(m[1])); // (the brackets delimit it: a trailing ) ! ? is part of the URL / path)
      if (tgt) { targets.push(tgt); push(m[1], cur() | 8, targets.length - 1); k += m[0].length; continue; }
    }
    // bare URL or path (no spaces) at a word start
    if ((k === 0 || /[\s(]/.test(src[k - 1])) && /^(https?:\/\/|file:\/\/|~\/|\/[A-Za-z])/.test(src.slice(k))) {
      const m = /^\S+/.exec(src.slice(k))[0].replace(/[)\].,;:!?'"*]+$/, "");
      const tgt = linkTarget(m);
      if (tgt) { targets.push(tgt); push(m, cur() | 8, targets.length - 1); k += m.length; continue; }
    }
    push(src[k], cur()); k += 1;
  }
  return { plain, style, link, targets };
}

function paint(plain, style, from, len) {
  let out = "", cur = 0;
  const open = (s) => (s & 1 ? `${ESC}1m` : "") + (s & 2 ? `${ESC}3m` : "") + (s & 8 ? `${ESC}4;34m` : s & 4 ? `${ESC}36m` : "");
  const close = (s) => (s & 1 ? `${ESC}22m` : "") + (s & 2 ? `${ESC}23m` : "") + (s & 8 ? `${ESC}24;39m` : s & 4 ? `${ESC}39m` : "");
  for (let k = from; k < from + len && k < plain.length; k++) {
    const s = style[k] || 0;
    if (s !== cur) { out += close(cur) + open(s); cur = s; }
    out += plain[k];
  }
  return out + close(cur);
}

export function mdRows(text, width, wrap, gw = () => 1) {
  const out = [];
  for (const raw of String(text || "").split(/\r?\n/)) {
    if (!raw.trim()) { out.push({ line: "", links: [] }); continue; }
    let line = raw, lead = "", hang = "", heading = false;
    const h = /^\s*#{1,6}\s+/.exec(line);
    if (h) { line = line.slice(h[0].length); heading = true; }
    const bl = /^(\s*)[-*+]\s+/.exec(line);
    if (bl) { lead = bl[1] + "• "; hang = " ".repeat(bl[1].length + 2); line = line.slice(bl[0].length); }
    else { const nl = /^(\s*)(\d+[.)])\s+/.exec(line); if (nl) { lead = nl[1] + nl[2] + " "; hang = " ".repeat(lead.length); line = line.slice(nl[0].length); } }
    const { plain, style, link, targets } = inline(line);
    if (heading) for (let k = 0; k < style.length; k++) style[k] |= 1;
    const lines = wrap(plain, Math.max(4, width - lead.length));
    let pos = 0;
    lines.forEach((l, n) => {
      const at = plain.indexOf(l, pos), s = at < 0 ? pos : at;
      pos = s + l.length;
      const pre = n === 0 ? lead : hang, links = [];
      let x = pre.length, curL = -1, x0 = 0;
      for (let k = s; k < s + l.length; k++) {
        const li = link[k];
        if (li !== curL) { if (curL >= 0) links.push({ x0, x1: x, target: targets[curL] }); curL = li; x0 = x; }
        const cp = plain.codePointAt(k); const ch = String.fromCodePoint(cp);
        x += gw(ch); if (ch.length > 1) k++;
      }
      if (curL >= 0) links.push({ x0, x1: x, target: targets[curL] });
      out.push({ line: pre + paint(plain, style, s, l.length), links });
    });
  }
  return out;
}
export const mdLines = (text, width, wrap) => mdRows(text, width, wrap).map((r) => r.line);
