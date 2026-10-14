#!/usr/bin/env node
// J537: the hypi mark in the terminal. node test/hypi-mark.mjs (exit 0 = pass)
import fs from "node:fs"; import os from "node:os"; import path from "node:path"; import { execFileSync } from "node:child_process";
import { loadMark, markLines, to256, MARK_FILE, HEADER_STYLE, scaleGrid } from "../lib/hypi-mark.mjs";
let fails = 0; const ok = (n, c, x = "") => { if (!c) fails++; console.log(`${c ? "ok  " : "FAIL"} ${n}${x ? ": " + x : ""}`); };
const m = loadMark(), plain = (l) => l.replace(/\x1b\[[0-9;]*m/g, "");
ok("the grid is the mirrored y (Angus's pick, J61), 6 rows x 10 columns", m.name === "mirrored-y" && m.grid.length === 6 && m.grid.every((r) => r.length === 10));
const t = markLines("truecolor"), e = markLines("256color");
ok("3 terminal lines, 10 cells each (two pixel rows per line)", t.length === 3 && t.every((l) => [...plain(l)].length === 10), JSON.stringify(t.map(plain)));
ok("the shapes", JSON.stringify(t.map(plain)) === JSON.stringify(["█▄▄   ▀▀█ ", "█ █▄█ █▀ █", "  ▄▄▀     "]));
ok("true colour uses the grid's colours", t.join("").includes("38;2;230;140;124") && t.join("").includes("48;2;82;144;181") && t.join("").includes("38;2;234;184;96"));
ok("256 colours: the same palette entries pi picks for its own logo (174, 67, 179)", JSON.stringify([m.colors.C, m.colors.B, m.colors.Y].map(to256)) === "[174,67,179]" && !e.join("").includes(";2;"));
// J537c: agent windows draw it at double size with a half-pixel gap between the y and the p (grid column 5 stays one cell)
const big = markLines("truecolor", m, HEADER_STYLE).map(plain);
ok("J537c header style: double size, column 5 (the y-p gap) half width", HEADER_STYLE.scale === 2 && JSON.stringify(HEADER_STYLE.halfCols) === "[5]");
ok("J537c 6 lines, 19 cells each (9 pixels x 2 + the 1-cell gap)", big.length === 6 && big.every((l) => [...l].length === 19), JSON.stringify(big));
ok("J537c the shapes", JSON.stringify(big) === JSON.stringify(["██         ██████  ", "██████     ██  ██  ", "██  ██  ██ ████  ██", "██  ██████ ██    ██", "        ██         ", "    ████           "]), JSON.stringify(big));
ok("J537c the gap between the y and the p is exactly one cell on every line", big.every((l) => l[10] === " ") && big.some((l) => l[9] === "█" && l[11] === "█"));
ok("J537c scale 1 (the revert) gives back the small mark", JSON.stringify(scaleGrid(m.grid, { scale: 1 })) === JSON.stringify(m.grid));
// one source: make-final.py, which builds the app icons, writes the file (needs PIL; skipped without it)
let pil = true; try { execFileSync("python3", ["-c", "import PIL"]); } catch { pil = false; }
if (pil) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "j537-")), px = path.join(path.dirname(MARK_FILE), "..", "remote-control", "icon-options", "pixel");
  fs.cpSync(path.join(px), path.join(tmp, "remote-control", "icon-options", "pixel"), { recursive: true }); fs.mkdirSync(path.join(tmp, "assets"));
  execFileSync("python3", [path.join(tmp, "remote-control", "icon-options", "pixel", "make-final.py")], { stdio: "ignore" });
  ok("make-final.py (the icon builder) writes exactly assets/hypi-mark.json (no hand copy)", fs.readFileSync(path.join(tmp, "assets", "hypi-mark.json"), "utf8") === fs.readFileSync(MARK_FILE, "utf8"));
} else console.log("skip make8.py check (no PIL)");
console.log(fails ? `${fails} FAILED` : "all passed"); process.exit(fails ? 1 : 0);
