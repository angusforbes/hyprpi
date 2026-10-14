// J597 (after J595: the room and search panels kept old lib/tui/laptop.mjs because their hand-written watch lists left it out):
// the files a panel's code-change restart watches, from its real import graph: the panel itself and every local .mjs/.js/.ts file
// it imports, recursively ("./x", "../lib/y", static or dynamic import). A new import is watched without anyone updating a list.
import fs from "node:fs";
import path from "node:path";

export function codeFilesOf(entry) {
  const seen = new Set();
  const walk = (file) => {
    if (seen.has(file)) return;
    seen.add(file);
    let src = ""; try { src = fs.readFileSync(file, "utf8"); } catch { return; }
    for (const m of src.matchAll(/(?:from|import)\s*\(?\s*["'](\.{1,2}\/[^"']+)["']/g)) {
      const f = path.resolve(path.dirname(file), m[1]);
      if (/\.(m?js|ts)$/.test(f) && fs.existsSync(f)) walk(f);
    }
  };
  walk(path.resolve(entry));
  return [...seen];
}
