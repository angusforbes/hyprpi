// The laptop side of pi-jot's relay (J559, Angus "15b": /jot-* in a remote agent's laptop window writes to the LAPTOP's notes).
// A hyprpi remote agent's pi runs pi-jot with PI_JOT_RELAY=1: instead of touching its own disk, each file access is an
// extension-UI `input` request titled "pi-jot relay" whose placeholder is JSON {v, op, path, data}, with `path` RELATIVE to the
// jot root. The laptop window (omnistation/remote-client.mjs) hands it here, never shows it, and sends back the JSON answer.
//
//   jotRelayAnswer(placeholder, { root }) -> JSON string {ok: true, value} | {ok: false, error}
//
// The root is the laptop's own pi-jot root (~/.pi/agent/jot.json "root", default ~/Obsidian; PI_JOT_CONFIG overrides the file).
// Everything stays inside it: a path with .., an absolute path, or one that leads out through a symlink is refused. Ops: exists,
// read, write, append (each write/append creates the folders it needs and returns the file's real laptop path), mkdir.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const JOT_RELAY_TITLE = "pi-jot relay";
const MAX = 4 << 20; // a jot is small; refuse anything absurd

export function laptopJotRoot(env = process.env) {
  const cfgPath = env.PI_JOT_CONFIG || path.join(os.homedir(), ".pi", "agent", "jot.json");
  let root = "~/Obsidian";
  try { const j = JSON.parse(fs.readFileSync(cfgPath, "utf8")); if (typeof j.root === "string" && j.root.trim()) root = j.root.trim(); } catch { /* defaults */ }
  if (root === ".") throw new Error("pi-jot's root is \".\" (the working folder): relayed jots need a fixed notes folder");
  return path.resolve(root === "~" ? os.homedir() : root.startsWith("~/") ? path.join(os.homedir(), root.slice(2)) : root);
}

// the nearest existing ancestor (by lstat: a dangling symlink counts as existing) must resolve inside the root's real path; a
// symlink that can't be resolved (dangling) is refused, so nothing is ever written through a link to a place outside the root
const lexists = (p) => { try { fs.lstatSync(p); return true; } catch { return false; } };
function inside(root, abs) {
  const realRoot = (() => { try { return fs.realpathSync(root); } catch { return path.resolve(root); } })();
  let p = abs;
  while (!lexists(p) && p !== path.dirname(p)) p = path.dirname(p);
  let real; try { real = fs.realpathSync(p); } catch { return false; } // dangling link (or unreadable): refuse
  return real === realRoot || (real + path.sep).startsWith(realRoot + path.sep);
}

export function jotRelayAnswer(raw, { root = laptopJotRoot() } = {}) {
  const fail = (error) => JSON.stringify({ ok: false, error });
  let r; try { r = JSON.parse(String(raw)); } catch { return fail("not a pi-jot relay request"); }
  if (!r || r.v !== 1 || typeof r.op !== "string" || typeof r.path !== "string") return fail("not a pi-jot relay request");
  const rel = r.path;
  if (!rel || path.isAbsolute(rel) || rel.split(/[\\/]/).includes("..") || /[\0]/.test(rel)) return fail(`refused path ${JSON.stringify(rel)}`);
  const abs = path.resolve(root, rel);
  if (!(abs + path.sep).startsWith(path.resolve(root) + path.sep) || !inside(root, abs)) return fail(`refused path ${JSON.stringify(rel)} (outside ${root})`);
  const data = r.data;
  if (data !== undefined && (typeof data !== "string" || data.length > MAX)) return fail("bad data");
  try {
    switch (r.op) {
      case "exists": return JSON.stringify({ ok: true, value: fs.existsSync(abs) });
      case "read": return JSON.stringify({ ok: true, value: fs.readFileSync(abs, "utf8") });
      case "mkdir": fs.mkdirSync(abs, { recursive: true }); if (!inside(root, abs)) throw new Error("outside the notes folder"); return JSON.stringify({ ok: true, value: abs });
      case "write": case "append": {
        if (data === undefined) return fail("no data");
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        if (!inside(root, abs)) throw new Error("outside the notes folder");
        if (fs.existsSync(abs) && !fs.statSync(abs).isFile()) throw new Error("not a file");
        if (r.op === "write") { const t = `${abs}.jot-${process.pid}-${Date.now()}`; fs.writeFileSync(t, data, "utf8"); fs.renameSync(t, abs); }
        else fs.appendFileSync(abs, data, "utf8");
        return JSON.stringify({ ok: true, value: abs });
      }
      default: return fail(`unknown op ${r.op}`);
    }
  } catch (e) { return fail(e.message); }
}
