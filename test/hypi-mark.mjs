#!/usr/bin/env node
// J537: the hypi mark in the terminal. node test/hypi-mark.mjs (exit 0 = pass)
import fs from "node:fs"; import os from "node:os"; import path from "node:path"; import { execFileSync } from "node:child_process";
import { loadMark, markLines, to256, MARK_FILE } from "../lib/hypi-mark.mjs";
let fails = 0; const ok = (n, c, x = "") => { if (!c) fails++; console.log(`${c ? "ok  " : "FAIL"} ${n}${x ? ": " + x : ""}`); };
const m = loadMark(), plain = (l) => l.replace(/\x1b\[[0-9;]*m/g, "");
ok("the grid is f2, 6 rows x 10 columns", m.name === "f2" && m.grid.length === 6 && m.grid.every((r) => r.length === 10));
const t = markLines("truecolor"), e = markLines("256color");
ok("3 terminal lines, 10 cells each (two pixel rows per line)", t.length === 3 && t.every((l) => [...plain(l)].length === 10), JSON.stringify(t.map(plain)));
ok("the shapes", JSON.stringify(t.map(plain)) === JSON.stringify(["█▄▄ ▄ ▀▀█ ", "█ █▄█ █▀ █", "  ▄▄▀     "]));
ok("true colour uses the grid's colours", t.join("").includes("38;2;230;140;124") && t.join("").includes("48;2;82;144;181") && t.join("").includes("38;2;234;184;96"));
ok("256 colours: the same palette entries pi picks for its own logo (174, 67, 179)", JSON.stringify([m.colors.C, m.colors.B, m.colors.Y].map(to256)) === "[174,67,179]" && !e.join("").includes(";2;"));
// one source: make8.py writes the file (needs PIL; skipped without it)
let pil = true; try { execFileSync("python3", ["-c", "import PIL"]); } catch { pil = false; }
if (pil) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "j537-")), px = path.join(path.dirname(MARK_FILE), "..", "remote-control", "icon-options", "pixel");
  fs.cpSync(path.join(px), path.join(tmp, "remote-control", "icon-options", "pixel"), { recursive: true }); fs.mkdirSync(path.join(tmp, "assets"));
  execFileSync("python3", [path.join(tmp, "remote-control", "icon-options", "pixel", "make8.py")], { stdio: "ignore" });
  ok("make8.py writes exactly assets/hypi-mark.json (no hand copy)", fs.readFileSync(path.join(tmp, "assets", "hypi-mark.json"), "utf8") === fs.readFileSync(MARK_FILE, "utf8"));
} else console.log("skip make8.py check (no PIL)");
console.log(fails ? `${fails} FAILED` : "all passed"); process.exit(fails ? 1 : 0);
