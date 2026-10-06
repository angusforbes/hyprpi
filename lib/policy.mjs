// J125 v2 (Angus: "a kind of master hyprpi setting file with reasonable defaults? … yes"): ONE editable policy
// file, ~/.config/hyprpi/hyprpi.jsonc (JSON with // comments), for how hyprpi behaves: upkeep (pruning,
// compaction, refresh), the daemon's restart queue, Thoughts, and (later, J130) routing and budgets.
// Machine details (pi binary, paths, search models) stay in config.json.
//
// Defaults live here AND are written out in full in the file (with a comment each) the first time it's
// read; values from the old places are carried over then (config.json: thoughtsCarryTurns, refreshAfter;
// an edited upkeep.jsonc), and the old upkeep.jsonc is moved to ~/.local/state/hyprpi/backups/. A key
// missing from the file falls back to config.json's old key, then to the default. Read again whenever the
// file changes (by mtime), so an edit needs no restart or reload.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const CONFIG_DIR = () => path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "hyprpi");
export const policyFile = () => path.join(CONFIG_DIR(), "hyprpi.jsonc");
export const expandHome = (p) => String(p || "").replace(/^~(?=\/|$)/, os.homedir());

export const DEFAULTS = {
  upkeep: {
    prune: { enabled: true, keepImages: 3, imageMinKB: 40, keepTurns: 6, maxToolChars: 12000, saveDir: "~/.local/state/hyprpi/pruned" },
    compactContinue: { enabled: true, briefReminder: true },
    refresh: { enabled: true, idleMinutes: 5, cooldownHours: 3, maxPerDay: 0, handoffWaitMinutes: 15, handoffDir: "~/.local/state/hyprpi/handoffs", roomLine: true },
    paused: [],
  },
  restarts: { quietSeconds: 20, watchMinutes: 15, ttlMinutes: 120 },
  thoughts: {
    carryTurns: 20,
    refreshAfter: { compactions: 6, oldCompactions: 3, days: 3 },
    selfRefresh: { enabled: true, sessionMB: 12, useCompactions: true, cooldownHours: 24 },
  },
  routing: {},
  budgets: {},
};

const J = (v) => JSON.stringify(v);
// The file as written out: every default (or carried-over value) with its comment.
export function policyText(v = DEFAULTS) {
  const u = v.upkeep, p = u.prune, c = u.compactContinue, r = u.refresh, R = v.restarts, T = v.thoughts;
  return `// hyprpi policy (J125 v2): how hyprpi behaves. Edit freely; changes apply within a minute (the daemon and
// agents re-read this file when it changes). No restart or reload needed. Machine details (pi binary, paths,
// search models) stay in config.json. Each world's Thoughts is in charge of upkeep and is told about every
// action; Angus is never asked.
{
  "upkeep": {
    // 1. Pruning: older large images and big tool outputs leave the MODEL'S CONTEXT (the session file keeps
    //    them) as a stub with a file:// link; anything not already a file is saved first. Never pruned:
    //    Angus's current message and the latest tool result.
    "prune": {
      "enabled": ${J(p.enabled)},
      "keepImages": ${J(p.keepImages)},            // the newest N images stay in context
      "imageMinKB": ${J(p.imageMinKB)},           // smaller images (icons) always stay
      "keepTurns": ${J(p.keepTurns)},             // tool outputs from the last N turns always stay
      "maxToolChars": ${J(p.maxToolChars)},      // older tool outputs longer than this become a stub (first 600 chars kept)
      "saveDir": ${J(p.saveDir)}   // where images/outputs that weren't files are saved
    },
    // 2. Compact and continue: pi compacts between turns mid-run and carries on by itself; after any
    //    compaction hyprpi also reminds the agent of the job (J<n> brief) it is on.
    "compactContinue": {
      "enabled": ${J(c.enabled)},
      "briefReminder": ${J(c.briefReminder)}
    },
    // 3. Overdue refresh: an agent due for a refresh (thoughts.refreshAfter below) and idle for idleMinutes
    //    is asked for a handoff, then reopened on a FRESH session that starts from it (same name, workspace,
    //    projects, jobs and pending replies). A working agent is never touched.
    "refresh": {
      "enabled": ${J(r.enabled)},
      "idleMinutes": ${J(r.idleMinutes)},
      "cooldownHours": ${J(r.cooldownHours)},           // per agent between refreshes (and after a failed attempt); never under 30 min
      "maxPerDay": ${J(r.maxPerDay)},               // a cap per agent per 24 h; 0 = none (the cooldown is enough)
      "handoffWaitMinutes": ${J(r.handoffWaitMinutes)},     // give up (and cool down) if no handoff arrives in this time
      "handoffDir": ${J(r.handoffDir)},
      "roomLine": ${J(r.roomLine)}              // one line in the agent's room when it is refreshed
    },
    // Agents (names) upkeep never touches. Thoughts can also pause/resume agents with its upkeep tool.
    "paused": ${J(u.paused)}
  },

  // The daemon's own restart queue (J126, \`hyprpi daemon restart\`): it restarts once nobody is working.
  "restarts": {
    "quietSeconds": ${J(R.quietSeconds)},     // everyone idle for this long before it restarts
    "watchMinutes": ${J(R.watchMinutes)},     // a wait longer than this gets one line to the world's Thoughts
    "ttlMinutes": ${J(R.ttlMinutes)}      // a pending restart request expires after this (default per request)
  },

  "thoughts": {
    // When a Thoughts is refreshed (hyprpi thoughts new, J116), its last N turns stay visible in the new
    // thread (J124); 0 = start empty.
    "carryTurns": ${J(T.carryTurns)},
    // When an agent counts as "due for a refresh" (J117): this many compactions of its session, or
    // oldCompactions once the session is older than days. Its Thoughts is told; upkeep refreshes it.
    "refreshAfter": { "compactions": ${J(T.refreshAfter.compactions)}, "oldCompactions": ${J(T.refreshAfter.oldCompactions)}, "days": ${J(T.refreshAfter.days)} },
    // Thoughts agents themselves: refreshed (J116, with carryTurns) when idle and their session passes
    // sessionMB or their compactions reach refreshAfter.compactions.
    "selfRefresh": { "enabled": ${J(T.selfRefresh.enabled)}, "sessionMB": ${J(T.selfRefresh.sessionMB)}, "useCompactions": ${J(T.selfRefresh.useCompactions)}, "cooldownHours": ${J(T.selfRefresh.cooldownHours)} }
  },

  // Coming with the orchestration project (J130): per-job model routing ("which model for which kind of
  // job") and generous token/time budgets. Empty until then.
  "routing": {},
  "budgets": {}
}
`;
}

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

const isObj = (x) => x && typeof x === "object" && !Array.isArray(x);
// over ← under, deeply (arrays and scalars replace).
function merge(base, over) {
  if (!isObj(base) || !isObj(over)) return over === undefined ? base : over;
  const out = { ...base };
  for (const [k, v] of Object.entries(over)) out[k] = isObj(v) && isObj(base[k]) ? merge(base[k], v) : v;
  return out;
}
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return null; } };
// The old config.json keys, as a policy fragment (the fallback layer).
function legacy() {
  const c = readJson(path.join(CONFIG_DIR(), "config.json")) || {}, out = {};
  if (c.thoughtsCarryTurns !== undefined) (out.thoughts ||= {}).carryTurns = c.thoughtsCarryTurns;
  if (isObj(c.refreshAfter)) (out.thoughts ||= {}).refreshAfter = c.refreshAfter;
  return out;
}

// First read: write the file with every default, carrying over the old values; retire upkeep.jsonc.
function create(file) {
  let v = merge(DEFAULTS, legacy());
  const old = path.join(CONFIG_DIR(), "upkeep.jsonc");
  if (fs.existsSync(old)) {
    try {
      const u = parseJsonc(fs.readFileSync(old, "utf8"));
      // Only an EDITED upkeep.jsonc carries values (an untouched one has the first J125 defaults, e.g. a
      // 24 h cooldown that Angus has since changed to 3 h).
      if (JSON.stringify(u) !== JSON.stringify(JSON.parse(V1_UPKEEP_DEFAULT)))
        v = merge(v, { upkeep: { prune: u.prune, compactContinue: u.compactContinue, refresh: u.refresh, paused: u.paused }, thoughts: { selfRefresh: u.thoughts } });
    } catch { /* unreadable: defaults */ }
    try { const bdir = expandHome("~/.local/state/hyprpi/backups"); fs.mkdirSync(bdir, { recursive: true }); fs.renameSync(old, path.join(bdir, `upkeep.jsonc.${Date.now()}`)); } catch { /* leave it */ }
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file + ".tmp", policyText(v)); fs.renameSync(file + ".tmp", file);
}

let cache = { file: "", mtime: -1, value: null };
// The policy: defaults ← config.json's old keys ← hyprpi.jsonc. A broken file keeps the last good values
// and says why in .error.
export function loadPolicy() {
  const file = policyFile();
  let st; try { st = fs.statSync(file); } catch { try { create(file); st = fs.statSync(file); } catch (e) { return { ...merge(DEFAULTS, legacy()), error: `hyprpi.jsonc: ${e.message}` }; } }
  if (cache.value && cache.file === file && cache.mtime === st.mtimeMs) return cache.value;
  try {
    const v = merge(merge(DEFAULTS, legacy()), parseJsonc(fs.readFileSync(file, "utf8")));
    cache = { file, mtime: st.mtimeMs, value: { ...v, error: "" } };
  } catch (e) {
    cache = { file, mtime: st.mtimeMs, value: { ...(cache.value || merge(DEFAULTS, legacy())), error: `hyprpi.jsonc: ${e.message}` } };
  }
  return cache.value;
}

// The first J125 upkeep.jsonc defaults (to tell an untouched old file from an edited one).
const V1_UPKEEP_DEFAULT = `{"prune":{"enabled":true,"keepImages":3,"imageMinKB":40,"keepTurns":6,"maxToolChars":12000,"saveDir":"~/.local/state/hyprpi/pruned"},"compactContinue":{"enabled":true,"briefReminder":true},"refresh":{"enabled":true,"idleMinutes":5,"cooldownHours":24,"maxPerDay":1,"handoffWaitMinutes":15,"handoffDir":"~/.local/state/hyprpi/handoffs","roomLine":true},"thoughts":{"enabled":true,"sessionMB":12,"useCompactions":true,"cooldownHours":24},"paused":[]}`;
