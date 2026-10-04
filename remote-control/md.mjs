// The phone app's small Markdown renderer, shared by the page (app.js: the Thoughts thread, Proj,
// Agnt, Strm) and the document viewer (viewer.js: .md files, J56). Escapes everything first.
//
// Links: file:///abs and /abs or ~/ paths open read-only through /file (the server's J47 guard
// decides what may be read); https and mailto open as they are. In a document (setBase(its
// folder)), relative links and images resolve against that folder, and Obsidian [[wiki links]]
// (and ![[embeds]]) go to /wiki, which finds the note in the vault.

export const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

let BASE = ""; // the folder of the document being shown ("" in the app: no relative links)
let FROM = ""; // its path (for /wiki: notes near it win)
export function setBase(docPath) { FROM = String(docPath || ""); BASE = FROM ? FROM.replace(/\/[^/]*$/, "") : ""; }

function joinPath(dir, rel) {
  const out = [];
  for (const p of (dir + "/" + rel).split("/")) { if (!p || p === ".") continue; if (p === "..") out.pop(); else out.push(p); }
  return "/" + out.join("/");
}
export function href(u) {
  u = String(u).trim();
  if (/^file:\/\//i.test(u)) { try { return "/file?path=" + encodeURIComponent(decodeURIComponent(new URL(u).pathname)); } catch { return "#"; } }
  if (u.startsWith("/") || u.startsWith("~/")) return "/file?path=" + encodeURIComponent(u); // the server expands ~
  if (/^(https?|mailto):/i.test(u)) return u;
  if (u.startsWith("#")) return u; // a heading in this document
  if (BASE && !/^[a-z][a-z0-9+.-]*:/i.test(u)) { // relative to the document (its #anchor dropped)
    let rel = u.replace(/#.*$/, ""); try { rel = decodeURIComponent(rel); } catch { /* as is */ }
    return rel ? "/file?path=" + encodeURIComponent(joinPath(BASE, rel)) : "#";
  }
  return "#";
}
const wikiHref = (name) => `/wiki?name=${encodeURIComponent(name)}${FROM ? "&from=" + encodeURIComponent(FROM) : ""}`;
export const link = (text, u) => `<a href="${esc(href(u))}" target="_blank" rel="noopener">${text}</a>`;
const IMG = /\.(png|jpe?g|gif|webp|svg)$/i;

export function inline(s) {
  const codes = [];
  s = s.replace(/`([^`]+)`/g, (_, c) => `\u0000${codes.push(c) - 1}\u0000`);
  s = esc(s);
  // Obsidian: ![[image.png]] (an embed) and [[Note]] / [[Note|shown text]] / [[Note#heading]].
  s = s.replace(/!\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]/g, (_, n) => { const name = n.replace(/&amp;/g, "&").trim(); return IMG.test(name) ? `<img class="mdimg" src="${esc(wikiHref(name))}" alt="${esc(name)}">` : `<a class="wiki" href="${esc(wikiHref(name))}">${esc(name)}</a>`; });
  s = s.replace(/\[\[([^\]|#]+)(?:#([^\]|]*))?(?:\|([^\]]*))?\]\]/g, (_, n, h, alias) => { const name = n.replace(/&amp;/g, "&").trim(); return `<a class="wiki" href="${esc(wikiHref(name))}">${alias || name + (h ? " › " + h : "")}</a>`; });
  // ![alt](src): an image (allowed folders only, through /file)
  s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_, alt, u) => `<img class="mdimg" src="${esc(href(u.replace(/&amp;/g, "&")))}" alt="${alt}">`);
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, t, u) => link(t, u.replace(/&amp;/g, "&")));
  s = s.replace(/(^|[\s(])((?:https?:\/\/|file:\/\/\/)[^\s<)]+[^\s<).,;:!?'"])/g, (_, p, u) => p + link(u.startsWith("file:") ? esc(decodeURIComponent(u.replace(/&amp;/g, "&")).split("/").pop()) : u, u.replace(/&amp;/g, "&")));
  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>").replace(/(^|[^*\w])\*([^*\n]+)\*(?!\w)/g, "$1<em>$2</em>").replace(/(^|\W)_([^_\n]+)_(?!\w)/g, "$1<em>$2</em>");
  s = s.replace(/~~([^~]+)~~/g, "<del>$1</del>");
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${esc(codes[i])}</code>`);
}

export function md(src, { doc = false } = {}) {
  const lines = String(src ?? "").replace(/\r/g, "").split("\n"), out = [];
  let i = 0;
  // A document's YAML front matter (Obsidian properties): shown small and grey, not as text.
  if (doc && lines[0] === "---") { const end = lines.indexOf("---", 1); if (end > 0) { out.push(`<pre class="front">${esc(lines.slice(1, end).join("\n"))}</pre>`); i = end + 1; } }
  const H = doc ? /^(#{1,6})\s+(.*)/ : /^(#{1,4})\s+(.*)/;
  while (i < lines.length) {
    const l = lines[i];
    if (/^```/.test(l)) { const buf = []; i++; while (i < lines.length && !/^```/.test(lines[i])) buf.push(lines[i++]); i++; out.push(`<pre><code>${esc(buf.join("\n"))}</code></pre>`); continue; }
    if (/^\s*$/.test(l)) { i++; continue; }
    if (doc && /^\s*([-*_])(\s*\1){2,}\s*$/.test(l)) { out.push("<hr>"); i++; continue; }
    const h = l.match(H); if (h) { const n = h[1].length; out.push(`<h${n}${doc ? ` id="${esc(h[2].toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-|-$/g, ""))}"` : ""}>${inline(h[2])}</h${n}>`); i++; continue; }
    if (/^\s*\|.*\|\s*$/.test(l) && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1] || "")) {
      const row = (r) => r.trim().replace(/^\||\|$/g, "").split("|").map((c) => inline(c.trim()));
      let t = `<table><tr>${row(l).map((c) => `<th>${c}</th>`).join("")}</tr>`; i += 2;
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) t += `<tr>${row(lines[i++]).map((c) => `<td>${c}</td>`).join("")}</tr>`;
      out.push(t + "</table>"); continue;
    }
    if (/^>\s?/.test(l)) { const buf = []; while (i < lines.length && /^>\s?/.test(lines[i])) buf.push(lines[i++].replace(/^>\s?/, "")); out.push(`<blockquote>${md(buf.join("\n"), { doc })}</blockquote>`); continue; }
    const li = /^\s*([-*•+]|\d+[.)])\s+/;
    if (li.test(l)) {
      const ordered = /^\s*\d/.test(l), items = [];
      while (i < lines.length && (li.test(lines[i]) || (/^\s{2,}\S/.test(lines[i]) && items.length))) {
        if (li.test(lines[i])) items.push(lines[i].replace(li, "")); else items[items.length - 1] += "\n" + lines[i].trim();
        i++;
      }
      // - [ ] / - [x] task items (in documents)
      const item = (x) => { const t = doc && /^\[([ xX])\]\s+/.exec(x); return t ? `<li class="task"><input type="checkbox" disabled${t[1] !== " " ? " checked" : ""}> ${inline(x.slice(t[0].length)).replace(/\n/g, "<br>")}</li>` : `<li>${inline(x).replace(/\n/g, "<br>")}</li>`; };
      out.push(`<${ordered ? "ol" : "ul"}>${items.map(item).join("")}</${ordered ? "ol" : "ul"}>`); continue;
    }
    const buf = [];
    // (a paragraph ends where a block starts; the same heading rule as above, or it would never move on)
    while (i < lines.length && !/^\s*$/.test(lines[i]) && !/^```|^>\s?/.test(lines[i]) && !H.test(lines[i]) && !li.test(lines[i])) buf.push(lines[i++]);
    if (!buf.length) buf.push(lines[i++]); // never stall
    // An image alone, or a short caption line and then an image: a small captioned figure (J63).
    // Figures in a row sit side by side (inline blocks) and wrap, so a set of images fits a phone.
    const lastImg = /^\s*!\[[^\]]*\]\([^)\s]+\)\s*$|^\s*!\[\[[^\]]+\]\]\s*$/.test(buf[buf.length - 1] || "");
    if (lastImg && buf.length <= 2 && (buf.length === 1 || buf[0].length <= 80)) {
      out.push(`<figure class="mdfig">${inline(buf[buf.length - 1].trim())}${buf.length === 2 ? `<figcaption>${inline(buf[0])}</figcaption>` : ""}</figure>`);
      continue;
    }
    out.push(`<p>${buf.map(inline).join("<br>")}</p>`);
  }
  return out.join("");
}
