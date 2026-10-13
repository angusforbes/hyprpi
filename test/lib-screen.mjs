// A minimal terminal for panel tests (from test/remote-panel-laptop.mjs, J543): where words are on a panel's screen, with the
// panels' own character widths. new Screen(cols, rows); feed(output); find(str) -> {x, y} 1-based; dump()
import path from "node:path";
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const { gw, graphemes } = await import(path.join(ROOT, "lib/tui/term.mjs"));
export class Screen {
  constructor(c, r) { this.c = c; this.r = r; this.x = 0; this.y = 0; this.rest = ""; this.g = Array.from({ length: r }, () => Array(c).fill(" ")); }
  feed(s) {
    s = this.rest + s; this.rest = "";
    const TOK = /\x1b\[([0-9;?<>=:]*)[ -/]*([@-~])|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[^[\]]|[^\x1b]+/y;
    let i = 0;
    while (i < s.length) {
      TOK.lastIndex = i; const m = TOK.exec(s);
      if (!m) { this.rest = s.slice(i); return; }
      i = TOK.lastIndex;
      if (m[2]) this.csi(m[1], m[2]); else if (m[0][0] !== "\x1b") this.text(m[0]);
    }
  }
  csi(p, f) {
    const n = p.split(";").map((x) => Number(x) || 0), row = this.g[this.y];
    if (f === "H" || f === "f") { this.y = Math.max(0, (n[0] || 1) - 1); this.x = Math.max(0, (n[1] || 1) - 1); }
    else if (f === "K" && row) { const [a, b] = n[0] === 1 ? [0, this.x + 1] : n[0] === 2 ? [0, this.c] : [this.x, this.c]; for (let k = a; k < b && k < this.c; k++) row[k] = " "; }
    else if (f === "J" && (n[0] === 2 || n[0] === 3)) this.g = Array.from({ length: this.r }, () => Array(this.c).fill(" "));
    else if (f === "J") { for (let y = this.y; y < this.r; y++) for (let k = y === this.y ? this.x : 0; k < this.c; k++) this.g[y][k] = " "; }
    else if (f === "G") this.x = (n[0] || 1) - 1; else if (f === "d") this.y = (n[0] || 1) - 1;
    else if (f === "C") this.x += n[0] || 1; else if (f === "D") this.x = Math.max(0, this.x - (n[0] || 1));
    else if (f === "A") this.y = Math.max(0, this.y - (n[0] || 1)); else if (f === "B") this.y += n[0] || 1;
    else if (f === "X" && row) for (let k = this.x; k < this.x + (n[0] || 1) && k < this.c; k++) row[k] = " ";
  }
  text(t) {
    for (const g of graphemes(t)) {
      if (g === "\r") { this.x = 0; continue; } if (g === "\n" || g === "\r\n") { this.y++; this.x = g === "\r\n" ? 0 : this.x; continue; }
      if (/^[\x00-\x1f]$/.test(g)) continue;
      const w = gw(g), row = this.g[this.y];
      if (row && this.x < this.c) { row[this.x] = g; if (w === 2 && this.x + 1 < this.c) row[this.x + 1] = ""; }
      this.x += w;
    }
  }
  rowText(y) { return (this.g[y] || []).join(""); }
  dump() { return this.g.map((r) => r.join("").trimEnd()).join("\n"); }
  // -> { x, y } (1-based) of the first cell of str, or null
  find(str, nth = 0) {
    for (let y = 0; y < this.r; y++) {
      let s = ""; const col = [];
      this.g[y].forEach((g, k) => { for (let u = 0; u < g.length; u++) { col.push(k); s += g[u]; } });
      let i = -1; for (let k = 0; k <= nth; k++) { i = s.indexOf(str, i + 1); if (i < 0) break; }
      if (i >= 0) return { x: col[i] + 1, y: y + 1 };
      if (s.includes(str)) nth -= s.split(str).length - 1;
    }
    return null;
  }
}
