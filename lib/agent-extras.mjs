// J698 (Angus, mem4: drop pi-subagents from every agent, ~15 MB each; "if a project agent assigned a task to a task agent, and
// realized that the task might benefit from say, multiple sub-agents reading a big file in parallel … the project agent could
// decide to start the task agent with the pi-subagent extension"): extra pi extensions ONE agent starts with, on top of
// ~/.pi/agent/settings.json, chosen by NAME when it is opened (spawn_agent / open_agent `subagents: true`, `hyprpi new --extra NAME`).
//   names -> sources: hyprpi.jsonc orchestration.extras (default { subagents: pi-subagents' installed folder })
//   agent -> names:   STATE/agent-extras.json, kept for the agent's id, so every relaunch keeps them: /restart, an upkeep refresh,
//                     agent-reopen, restore-all, all go through `hyprpi new --id ID`, which reads this file (extrasArgs).
// A name that isn't configured, or whose folder is gone, is REFUSED when the agent is opened (the opener sees why); at a later
// relaunch a vanished folder is skipped with a line on stderr and in the returned `missing` (never silently).
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { stateDir } from "./paths.mjs";
import { loadPolicy } from "./policy.mjs";

export const EXTRAS_DEFAULT = { subagents: "~/.pi/agent/npm/node_modules/@tintinweb/pi-subagents" };
const home = (p) => String(p || "").replace(/^~(?=$|\/)/, process.env.HOME || os.homedir());
const file = (env = process.env) => path.join(stateDir(env), "agent-extras.json");
const NAME = /^[a-z][a-z0-9-]{0,30}$/;

export function extrasMap() {
  const o = (loadPolicy().orchestration || {}).extras;
  return { ...EXTRAS_DEFAULT, ...(o && typeof o === "object" && !Array.isArray(o) ? o : {}) };
}
function readAll(env) { try { const j = JSON.parse(fs.readFileSync(file(env), "utf8")); return j && typeof j === "object" ? j : {}; } catch { return {}; } }

// Validate names for a NEW agent: every one configured and present on disk, else throw (the opener is told).
export function checkExtras(names) {
  const list = [...new Set((Array.isArray(names) ? names : [names]).filter((x) => x !== undefined && x !== null && x !== "").map((x) => String(x).trim().toLowerCase()))];
  const map = extrasMap();
  for (const n of list) {
    if (!NAME.test(n) || !map[n]) throw new Error(`no extra extension "${n}" (configured: ${Object.keys(map).join(", ") || "none"}; hyprpi.jsonc orchestration.extras)`);
    if (!fs.existsSync(home(map[n]))) throw new Error(`the extra extension "${n}" isn't installed at ${map[n]} (hyprpi.jsonc orchestration.extras)`);
  }
  return list;
}

export function getExtras(id, env = process.env) { const v = readAll(env)[id]; return Array.isArray(v?.names) ? v.names : []; }

// Remember an agent's extras (replaces; [] forgets it). Written atomically.
export function setExtras(id, names, env = process.env) {
  if (!/^[A-Za-z0-9_.-]{3,64}$/.test(String(id || ""))) throw new Error("bad agent id");
  const all = readAll(env);
  if (names && names.length) all[id] = { names: [...names], at: Date.now() }; else delete all[id];
  const f = file(env); fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f + ".tmp", JSON.stringify(all, null, 1)); fs.renameSync(f + ".tmp", f);
  return getExtras(id, env);
}

// pi arguments for an agent's extras: ["-e", folder, …]; names whose source is gone or unconfigured go to `missing`.
export function extrasArgs(id, env = process.env) {
  const map = extrasMap(), args = [], missing = [];
  for (const n of getExtras(id, env)) {
    const src = map[n] ? home(map[n]) : "";
    if (src && fs.existsSync(src)) args.push("-e", src); else missing.push(n);
  }
  return { names: getExtras(id, env), args, missing };
}
