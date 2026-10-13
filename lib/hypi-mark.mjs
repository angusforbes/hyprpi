// J537 (Angus: "can we make that appear in eevry hyprpi agent window when it starts up, they way the pi logo appears
// for pi. ie not as an image but as ascii art logo"): the hypi mark (his pick, the mirrored y of J61: coral short h,
// blue y with a yellow hook, then pi's logo) drawn in the terminal the way pi draws its own logo (pi's pi-logo.js): one character per pixel
// column, two pixel rows per character with half blocks (▀ fg = top pixel, bg = bottom), so the pixels are square.
// The grid and colours come from assets/hypi-mark.json, which remote-control/icon-options/pixel/make-final.py writes
// (it builds π's app icons from the same grid), so there is one source. Colour: 24-bit, or the nearest of the 256-colour palette.
import fs from "node:fs";
import path from "node:path";

const HERE = path.dirname(new URL(import.meta.url).pathname);
export const MARK_FILE = path.join(HERE, "..", "assets", "hypi-mark.json");
const RESET = "\x1b[0m";

export function loadMark(file = MARK_FILE) {
  const m = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!Array.isArray(m.grid) || !m.grid.length || !m.colors) throw new Error("hypi-mark.json: no grid");
  return m;
}

// xterm 256: the 6x6x6 cube (16-231) or the grey ramp (232-255), whichever is closer
export function to256([r, g, b]) {
  const lv = [0, 95, 135, 175, 215, 255], q = (v) => lv.reduce((bi, x, i) => (Math.abs(x - v) < Math.abs(lv[bi] - v) ? i : bi), 0);
  const [ri, gi, bi] = [q(r), q(g), q(b)], cube = 16 + 36 * ri + 6 * gi + bi, cd = (lv[ri] - r) ** 2 + (lv[gi] - g) ** 2 + (lv[bi] - b) ** 2;
  const gl = Math.max(0, Math.min(23, Math.round(((r + g + b) / 3 - 8) / 10))), gv = 8 + 10 * gl, gd = (gv - r) ** 2 + (gv - g) ** 2 + (gv - b) ** 2;
  return gd < cd ? 232 + gl : cube;
}
const sgr = (rgb, mode, bg = false) => mode === "truecolor" ? `\x1b[${bg ? 48 : 38};2;${rgb[0]};${rgb[1]};${rgb[2]}m` : `\x1b[${bg ? 48 : 38};5;${to256(rgb)}m`;

// The mark as terminal lines (ceil(rows / 2) of them), each exactly `width` (= grid columns) cells wide.
// mode: "truecolor" | "256color" (pi's theme.getColorMode() gives one of these).
export function markLines(mode = "truecolor", m = loadMark()) {
  const rows = m.grid, w = Math.max(...rows.map((r) => r.length)), out = [];
  const px = (r, c) => { const ch = (rows[r] || "")[c] || "."; return ch === "." ? null : m.colors[ch] || null; };
  for (let r = 0; r < rows.length; r += 2) {
    let line = "";
    for (let c = 0; c < w; c++) {
      const t = px(r, c), b = px(r + 1, c);
      if (!t && !b) line += " ";
      else if (t && b && t.join() === b.join()) line += `${sgr(t, mode)}█${RESET}`;
      else if (t && !b) line += `${sgr(t, mode)}▀${RESET}`;
      else if (!t && b) line += `${sgr(b, mode)}▄${RESET}`;
      else line += `${sgr(t, mode)}${sgr(b, mode, true)}▀${RESET}`;
    }
    out.push(line);
  }
  return out;
}
