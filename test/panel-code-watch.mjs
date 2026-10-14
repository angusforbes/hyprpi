#!/usr/bin/env node
// J597: the panels' code-change restart watches their real import graph (lib/tui/code-watch.mjs codeFilesOf), so a lib file a
// panel uses can't be left out of its watch list again (J595: room and search kept an old lib/tui/laptop.mjs).
//   W1 each panel (room, search, board, agents) watches itself, every file of its old hand-kept list, and lib/tui/laptop.mjs
//   W2 every local file the panel imports (recursively) is watched, and only files that exist
//   W3 codeFilesOf follows static, dynamic and relative imports and ignores packages; a new import shows up with no list to update
//   node test/run.mjs test/panel-code-watch.mjs   (exit 0 = pass)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { codeFilesOf } from "../lib/tui/code-watch.mjs";
let fails = 0; const ok = (n, c, x = "") => { if (!c) fails++; console.log(`${c ? "ok  " : "FAIL"} ${n}${x ? ": " + x : ""}`); };
const ROOT = path.dirname(path.dirname(new URL(import.meta.url).pathname)), L = (f) => path.join(ROOT, "lib", f);
const OLD = { // the lists each panel kept by hand before J597
  room: ["client.mjs", "paths.mjs", "search-view.mjs", "at-names.mjs", "stream.mjs", "tui/shimmer.mjs", "tui/input-box.mjs", "tui/command-line.mjs", "tui/agent-click.mjs", "tui/new-pill.mjs", "held.mjs"],
  search: ["client.mjs", "paths.mjs", "search-view.mjs", "at-names.mjs", "tui/shimmer.mjs", "tui/input-box.mjs", "tui/command-line.mjs", "tui/agent-click.mjs", "tui/markdown.mjs", "thoughts-lines.mjs", "tui/new-pill.mjs", "held.mjs"],
  board: ["client.mjs", "paths.mjs", "at-names.mjs", "tui/board-view.mjs", "tui/input-box.mjs", "tui/shimmer.mjs", "tui/term.mjs", "tui/command-line.mjs", "tui/agent-click.mjs", "tui/decisions-view.mjs", "tui/world-decisions.mjs", "remote-world.mjs", "decisions.mjs", "tui/laptop.mjs", "tui/members.mjs", "tui/sent.mjs", "tui/world-tabs.mjs"],
  agents: ["client.mjs", "paths.mjs", "tui/term.mjs", "tui/input-box.mjs", "tui/command-line.mjs"],
};
// room's old list named two files it doesn't import at all (no import of them anywhere in its graph): stale entries
const STALE = { room: ["search-view.mjs", "tui/shimmer.mjs"] };
for (const p of Object.keys(OLD)) {
  for (const f of STALE[p] || []) ok(`${p}: ${f} (stale in the old list) really isn't imported`, !fs.readFileSync(path.join(ROOT, "mockups", `${p}-tui.mjs`), "utf8").includes(path.basename(f)));
  const F = path.join(ROOT, "mockups", `${p}-tui.mjs`), src = fs.readFileSync(F, "utf8");
  ok(`${p}: the panel builds its watch list with codeFilesOf (no hand-kept list)`, /const CODE = codeFilesOf\(new URL\(".\/[a-z]+-tui\.mjs", import\.meta\.url\)\.pathname\);/.test(src) && !/const CODE = \[/.test(src));
  const W = new Set(codeFilesOf(F));
  ok(`W1 ${p}: watches itself`, W.has(F));
  const missing = OLD[p].filter((f) => !W.has(L(f)) && !(STALE[p] || []).includes(f));
  ok(`W1 ${p}: watches every file of its old list`, !missing.length, missing.join(" "));
  ok(`W1 ${p}: watches lib/tui/laptop.mjs (input-box imports it)`, W.has(L("tui/laptop.mjs")));
  ok(`W2 ${p}: every watched file exists`, [...W].every((f) => fs.existsSync(f)));
}
// W3 a synthetic graph
const T = fs.mkdtempSync(path.join(os.tmpdir(), "j597-")), w = (f, s) => { fs.mkdirSync(path.dirname(path.join(T, f)), { recursive: true }); fs.writeFileSync(path.join(T, f), s); };
w("p/panel.mjs", `import fs from "node:fs";\nimport { a } from "../lib/a.mjs";\nimport x from "some-package";\nconst later = () => import("../lib/dyn.mjs");\n`);
w("lib/a.mjs", `export { b } from "./tui/b.mjs";\nexport const a = 1;\n`);
w("lib/tui/b.mjs", `import "../a.mjs";\nexport const b = 2;\n`); // a cycle
w("lib/dyn.mjs", "export default 3;\n"); w("lib/unused.mjs", "export default 4;\n");
const rel = () => codeFilesOf(path.join(T, "p/panel.mjs")).map((f) => path.relative(T, f)).sort();
ok("W3 static, re-export, dynamic and relative imports followed; packages, node: and unused files not; cycles fine", JSON.stringify(rel()) === JSON.stringify(["lib/a.mjs", "lib/dyn.mjs", "lib/tui/b.mjs", "p/panel.mjs"]), JSON.stringify(rel()));
w("lib/tui/b.mjs", `import "../a.mjs";\nimport "../unused.mjs";\nexport const b = 2;\n`);
ok("W3 a new import is watched at once, with no list to update", rel().includes("lib/unused.mjs"));
console.log(fails ? `panel-code-watch: ${fails} FAILED` : "panel-code-watch: all pass");
process.exit(fails ? 1 : 0);
