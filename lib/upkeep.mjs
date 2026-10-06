// J125 upkeep strategy (Angus: "I want hyprpi to have a strategy (editable) for managing the automatic
// removal of older large image files or docs …, for automatically compacting and continuing agents with
// full context, and for restarting older or over-compacted agents after an overdue handoff. I don't want
// to be asked, I just want it to happen. It seems like a Thoughts should handle this.")
//
// One editable file, ~/.config/hyprpi/upkeep.jsonc (JSON with // comments). Created with the defaults
// below the first time it's read. Read again whenever it changes (by mtime): the daemon on each upkeep
// pass, agents' extensions on each model request, so an edit needs no restart or reload.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

export const UPKEEP_FILE = path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "hyprpi", "upkeep.jsonc");

export const DEFAULT_TEXT = `// hyprpi upkeep strategy (J125). Edit freely: changes apply on the next upkeep pass (within a minute)
// and on agents' next model request. No restart or reload needed. Each world's Thoughts is in charge:
// it gets a one-line note for every action and can pause an agent (its upkeep tool). Angus isn't asked.
{
  // 1. Pruning: older large images and big tool outputs leave the MODEL'S CONTEXT (the session file keeps
  //    them) and are replaced by a stub with a file:// link; anything not already a file is saved first.
  //    Never pruned: Angus's current message and the latest tool result.
  "prune": {
    "enabled": true,
    "keepImages": 3,            // the newest N images stay in context
    "imageMinKB": 40,           // smaller images (icons) always stay
    "keepTurns": 6,             // tool outputs from the last N turns (Angus's messages) always stay
    "maxToolChars": 12000,      // older tool outputs longer than this become a stub (first 600 chars kept)
    "saveDir": "~/.local/state/hyprpi/pruned"   // where images/outputs that weren't files are saved
  },

  // 2. Compact and continue: pi compacts between turns mid-run and carries on by itself. After any
  //    compaction hyprpi also reminds the agent of the job (J<n> brief) it is on, so it continues it.
  "compactContinue": {
    "enabled": true,
    "briefReminder": true
  },

  // 3. Overdue refresh: an agent flagged due (J117: refreshAfter in config.json) that has been idle for
  //    idleMinutes is asked to write a handoff, then reopened on a FRESH session that starts from it
  //    (same name, workspace, projects, briefs and pending replies). Working agents are left alone.
  "refresh": {
    "enabled": true,
    "idleMinutes": 5,
    "cooldownHours": 3,         // per agent, between refreshes (and after a failed attempt); never under 30 min
    "maxPerDay": 0,             // a cap on refreshes per agent per 24 h; 0 = no cap (the cooldown is enough)
    "handoffWaitMinutes": 15,   // give up (and cool down) if no handoff arrives in this time
    "handoffDir": "~/.local/state/hyprpi/handoffs",
    "roomLine": true            // one line in the agent's room when it is refreshed
  },

  // Thoughts agents themselves: refreshed (J116, the last turns kept visible: J124) when idle and their
  // session file passes sessionMB or their compactions reach config refreshAfter.compactions.
  "thoughts": {
    "enabled": true,
    "sessionMB": 12,
    "useCompactions": true,
    "cooldownHours": 24         // between a Thoughts' refreshes; never under 30 min
  },

  // Agents (names) upkeep never touches. Thoughts can also pause/resume agents with its upkeep tool.
  "paused": []
}
`;

const DEFAULTS = {
  prune: { enabled: true, keepImages: 3, imageMinKB: 40, keepTurns: 6, maxToolChars: 12000, saveDir: "~/.local/state/hyprpi/pruned" },
  compactContinue: { enabled: true, briefReminder: true },
  refresh: { enabled: true, idleMinutes: 5, cooldownHours: 3, maxPerDay: 0, handoffWaitMinutes: 15, handoffDir: "~/.local/state/hyprpi/handoffs", roomLine: true },
  thoughts: { enabled: true, sessionMB: 12, useCompactions: true, cooldownHours: 24 },
  paused: [],
};

// JSON with // and /* */ comments and trailing commas.
export function parseJsonc(text) {
  let out = "", i = 0, inStr = false;
  while (i < text.length) {
    const c = text[i], n = text[i + 1];
    if (inStr) { out += c; if (c === "\\") { out += n ?? ""; i += 2; continue; } if (c === '"') inStr = false; i++; continue; }
    if (c === '"') { inStr = true; out += c; i++; continue; }
    if (c === "/" && n === "/") { while (i < text.length && text[i] !== "\n") i++; continue; }
    if (c === "/" && n === "*") { i += 2; while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++; i += 2; continue; }
    out += c; i++;
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"));
}

export const expandHome = (p) => String(p || "").replace(/^~(?=\/|$)/, os.homedir());

let cache = { mtime: -1, value: null, error: "" };
// The strategy, merged over the defaults. A broken file keeps the last good value (and says why).
export function loadUpkeep(file = UPKEEP_FILE) {
  let st;
  try { st = fs.statSync(file); } catch {
    try { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, DEFAULT_TEXT); st = fs.statSync(file); } catch { return { ...structuredClone(DEFAULTS), error: "" }; }
  }
  if (cache.value && cache.mtime === st.mtimeMs) return cache.value;
  try {
    const raw = parseJsonc(fs.readFileSync(file, "utf8"));
    const v = structuredClone(DEFAULTS);
    for (const k of Object.keys(v)) if (raw && raw[k] !== undefined) v[k] = Array.isArray(v[k]) ? (Array.isArray(raw[k]) ? raw[k] : v[k]) : (typeof raw[k] === "object" && raw[k] ? { ...v[k], ...raw[k] } : v[k]);
    cache = { mtime: st.mtimeMs, value: { ...v, error: "" }, error: "" };
  } catch (e) {
    cache = { mtime: st.mtimeMs, value: { ...(cache.value || structuredClone(DEFAULTS)), error: `upkeep.jsonc: ${e.message}` }, error: e.message };
  }
  return cache.value;
}
