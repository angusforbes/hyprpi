// A little Markdown for chat text in the panels (the search panel's Thoughts thread): **bold**,
// __bold__, *italic*, `code`, # headings (bold), "- " / "* " bullets (•, hanging indent).
// Everything else stays as typed. mdLines(text, width, wrap) → styled lines, wrapped by the
// panel's own word wrap (wrap(plain, n) → lines of plain text), so widths match the rest.
const ESC = "\x1b[";

// One line of text → { plain, style[] } with the markers removed (style per UTF-16 unit).
function inline(src) {
  let plain = "";
  const style = [];
  let b = false, i = false, c = false;
  for (let k = 0; k < src.length;) {
    if (!c && (src.startsWith("**", k) || src.startsWith("__", k))) {
      const m = src.slice(k, k + 2), close = src.indexOf(m, k + 2);
      if (b || (close > k + 2)) { b = !b; k += 2; continue; }
    }
    if (src[k] === "`") {
      const close = src.indexOf("`", k + 1);
      if (c || close > k + 1) { c = !c; k += 1; continue; }
    }
    if (!c && src[k] === "*" && (i ? src[k - 1] !== " " : src[k + 1] && src[k + 1] !== " " && src.indexOf("*", k + 1) > k + 1)) { i = !i; k += 1; continue; }
    plain += src[k]; style.push((b ? 1 : 0) | (i ? 2 : 0) | (c ? 4 : 0)); k += 1;
  }
  return { plain, style };
}

function paint(plain, style, from, len) {
  let out = "", cur = 0;
  const open = (s) => (s & 1 ? `${ESC}1m` : "") + (s & 2 ? `${ESC}3m` : "") + (s & 4 ? `${ESC}36m` : "");
  const close = (s) => (s & 1 ? `${ESC}22m` : "") + (s & 2 ? `${ESC}23m` : "") + (s & 4 ? `${ESC}39m` : "");
  for (let k = from; k < from + len && k < plain.length; k++) {
    const s = style[k] || 0;
    if (s !== cur) { out += close(cur) + open(s); cur = s; }
    out += plain[k];
  }
  return out + close(cur);
}

export function mdLines(text, width, wrap) {
  const out = [];
  for (const raw of String(text || "").split(/\r?\n/)) {
    if (!raw.trim()) { out.push(""); continue; }
    let line = raw, lead = "", hang = "", heading = false;
    const h = /^\s*#{1,6}\s+/.exec(line);
    if (h) { line = line.slice(h[0].length); heading = true; }
    const bl = /^(\s*)[-*+]\s+/.exec(line);
    if (bl) { lead = bl[1] + "• "; hang = " ".repeat(bl[1].length + 2); line = line.slice(bl[0].length); }
    else { const nl = /^(\s*)(\d+[.)])\s+/.exec(line); if (nl) { lead = nl[1] + nl[2] + " "; hang = " ".repeat(lead.length); line = line.slice(nl[0].length); } }
    const { plain, style } = inline(line);
    if (heading) for (let k = 0; k < style.length; k++) style[k] |= 1;
    const lines = wrap(plain, Math.max(4, width - lead.length));
    let pos = 0;
    lines.forEach((l, n) => {
      const at = plain.indexOf(l, pos), s = at < 0 ? pos : at;
      pos = s + l.length;
      out.push((n === 0 ? lead : hang) + paint(plain, style, s, l.length));
    });
  }
  return out;
}
