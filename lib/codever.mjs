// J135 (Angus: "if an agent needs a reload it's your job (or the hyprpi daemon's) to make it happen"): a
// fingerprint of the code an agent loads at start, so the daemon can tell which agents are running stale
// code and reload them when idle. The agent's extension computes it when it loads and sends it in its hello;
// the daemon computes the current one and compares.
//
// What counts: hyprpi's pi-extension/*.ts and the lib/ files they import (followed recursively), the global
// pi extensions (~/.pi/agent/extensions/*.ts, not backups), skills (~/.pi/agent/skills/**/*.md), pi's
// settings.json and the global AGENTS.md, plus any extra paths in hyprpi.jsonc upkeep.autoReload.watch.
// The fingerprint hashes each file's path, size and mtime (cheap: stats only, no reads except for imports).
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const AGENT_DIR = () => process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");

function listDir(dir, pred) { try { return fs.readdirSync(dir).filter(pred).map((f) => path.join(dir, f)); } catch { return []; } }
function walk(dir, pred, out = [], depth = 0) {
  if (depth > 4) return out;
  for (const e of (() => { try { return fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; } })()) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, pred, out, depth + 1); else if (pred(e.name)) out.push(p);
  }
  return out;
}
// The lib files an extension imports, recursively ("../lib/x.mjs", "./y.mjs").
function importsOf(file, seen) {
  if (seen.has(file)) return;
  seen.add(file);
  let src = ""; try { src = fs.readFileSync(file, "utf8"); } catch { return; }
  for (const m of src.matchAll(/(?:from|import)\s*\(?\s*["'](\.{1,2}\/[^"']+)["']/g)) {
    const f = path.resolve(path.dirname(file), m[1]);
    if (/\.(m?js|ts)$/.test(f) && fs.existsSync(f)) importsOf(f, seen);
  }
}

// The files of a kind of process: "agent" (a hyprpi agent window) or "thoughts" (a Thoughts process).
export function codeFiles(kind = "agent", extra = []) {
  const seen = new Set();
  const exts = kind === "thoughts" ? [path.join(ROOT, "pi-extension", "thoughts.ts")] : listDir(path.join(ROOT, "pi-extension"), (f) => f.endsWith(".ts") && f !== "thoughts.ts");
  for (const f of exts) importsOf(f, seen);
  const out = [...seen];
  if (kind === "agent") {
    const A = AGENT_DIR();
    out.push(...listDir(path.join(A, "extensions"), (f) => /\.ts$/.test(f)));
    out.push(...walk(path.join(A, "skills"), (f) => /\.md$/.test(f)));
    out.push(path.join(A, "settings.json"), path.join(A, "AGENTS.md"));
  }
  for (const p of extra || []) out.push(String(p).replace(/^~(?=\/)/, os.homedir()));
  return [...new Set(out)].sort();
}

export function codeVersion(kind = "agent", extra = []) {
  const h = crypto.createHash("sha1");
  for (const f of codeFiles(kind, extra)) {
    let st = null; try { st = fs.statSync(f); } catch { /* missing counts too */ }
    h.update(`${f}\0${st ? st.size : -1}\0${st ? Math.floor(st.mtimeMs) : 0}\n`);
  }
  return h.digest("hex").slice(0, 12);
}
