// Unit cases for lib/tui/markdown.mjs (J358: CommonMark autolinks). Run: node test/markdown.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { mdRows } from "../lib/tui/markdown.mjs";

const wrap = (s, n) => { const out = []; let line = ""; for (const w of s.split(" ")) { if (line && (line + " " + w).length > n) { out.push(line); line = w; } else line = line ? line + " " + w : w; } out.push(line); return out; };
const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "md-test-")), file = path.join(dir, "a b.md");
fs.writeFileSync(file, "x"); const plain = path.join(dir, "plain.md"); fs.writeFileSync(plain, "x");
const uri = "file://" + encodeURI(file);
let fail = 0;
const check = (name, ok, info) => { console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : " " + JSON.stringify(info)}`); if (!ok) fail++; };
const one = (t, w = 200) => mdRows(t, w, wrap)[0];

{ const r = one("see <https://example.com/x.pdf> now");
  check("https autolink: no brackets, linked", strip(r.line) === "see https://example.com/x.pdf now" && r.links.length === 1 && r.links[0].target === "https://example.com/x.pdf" && r.links[0].x0 === 4 && r.links[0].x1 === 29, r); }
{ const r = one(`File: <${uri}>`);
  check("file:// autolink with %20: decoded target, no brackets", strip(r.line) === `File: ${uri}` && r.links.length === 1 && r.links[0].target === file && r.links[0].x0 === 6, r); }
{ const dim = (l) => `\x1b[2m${l}\x1b[22m`; const r = one(`File: <${uri}>`); const line = "   " + dim(r.line);
  check("inside a dim line: still underlined + linked", /\x1b\[4;34m/.test(line) && r.links.length === 1, r); }
{ const r = one("bold is <b>x</b> and a<c>");
  check("<b> non-URL left as typed", strip(r.line) === "bold is <b>x</b> and a<c>" && r.links.length === 0, r); }
{ const r = one("mail <mailto:me@x.org> and <me@x.org>");
  check("mailto / email in <> left as typed", strip(r.line) === "mail <mailto:me@x.org> and <me@x.org>" && r.links.length === 0, r); }
{ const r = one("gone <file:///no/such/file.md>");
  check("missing file autolink left as typed", strip(r.line) === "gone <file:///no/such/file.md>" && r.links.length === 0, r); }
{ const r = one("a < b > c <https://x.org/a b>");
  check("stray < > and spaced url untouched", strip(r.line) === "a < b > c <https://x.org/a b>" && r.links.length === 0, r); }
for (const u of ["https://x.net/wiki/Thing_(topic)", "https://x.net/urgent!", "https://x.net/?q=why?"]) { const r = one(`<${u}>`);
  check(`autolink keeps trailing punctuation: ${u}`, strip(r.line) === u && r.links.length === 1 && r.links[0].target === u, r); }
{ const r = one(`<${uri}!>`);
  check("file autolink to a missing path (existing file + '!') left as typed", strip(r.line) === `<${uri}!>` && r.links.length === 0, r); }
// existing cases (7eb93ef)
{ const r = one("[label](https://example.com)");
  check("[label](url) still works", strip(r.line) === "label" && r.links[0].target === "https://example.com", r); }
{ const r = one(`[f](${uri})`);
  check("[label](file://…) still works", r.links[0]?.target === file, r); }
{ const r = one("go https://example.com/a, then");
  check("bare https still works", r.links[0]?.target === "https://example.com/a" && strip(r.line) === "go https://example.com/a, then", r); }
{ const r = one(`at ${plain} ok`); const r2 = one("`" + file + "`");
  check("bare path / backtick path still work", r.links.length === 1 && r2.links[0]?.target === file, { r, r2 }); }
{ const r = one("**bold** *it* `code`");
  check("bold/italic/code unchanged", strip(r.line) === "bold it code" && r.links.length === 0, r); }
{ const rows = mdRows(`a long line that wraps before <${uri}> here`, 30, wrap);
  check("wrapped autolink keeps its link", rows.some((x) => x.links.some((l) => l.target === file)), rows); }
fs.rmSync(dir, { recursive: true, force: true });
console.log(fail ? `${fail} failed` : "all passed");
process.exit(fail ? 1 : 0);
