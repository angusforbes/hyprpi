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
  // J130 (Blink): model per job complexity + the escalation ladder; budgets for spawned agents; who may spawn.
  routing: {
    default: "ordinary",
    ladder: ["anthropic/claude-haiku-4-5:low", "anthropic/claude-sonnet-5-5:medium", "anthropic/claude-opus-5-5:medium", "anthropic/claude-opus-5-5:high", "anthropic/claude-opus-5-5:xhigh"],
    kinds: { simple: 0, ordinary: 1, hard: 3, review: "openai-codex/gpt-6.1-sol:high" },
    ceiling: 4,
    escalate: { onBudget: true, onFailedCheck: true },
  },
  budgets: { tokens: 2000000, minutes: 240 },
  orchestration: { maxChildren: 4, maxDepth: 2, orphans: "finish" },
};

const J = (v) => JSON.stringify(v);
// The file as written out: every default (or carried-over value) with its comment.
export function policyText(v = DEFAULTS) {
  const u = v.upkeep, p = u.prune, c = u.compactContinue, r = u.refresh, R = v.restarts, T = v.thoughts;
  const G = { ...DEFAULTS.routing, ...(v.routing || {}) }, Bu = { ...DEFAULTS.budgets, ...(v.budgets || {}) }, O = { ...DEFAULTS.orchestration, ...(v.orchestration || {}) };
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
      "enabled": ${J(p.enabled)},              // false = never prune
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
      "briefReminder": ${J(c.briefReminder)}        // after a compaction, remind the agent of its running J<n> briefs
    },
    // 3. Overdue refresh: an agent due for a refresh (thoughts.refreshAfter below) and idle for idleMinutes
    //    is asked for a handoff, then reopened on a FRESH session that starts from it (same name, workspace,
    //    projects, jobs and pending replies). A working agent is never touched.
    "refresh": {
      "enabled": ${J(r.enabled)},              // false = never refresh agents automatically
      "idleMinutes": ${J(r.idleMinutes)},             // idle at least this long before it's asked for a handoff
      "cooldownHours": ${J(r.cooldownHours)},           // per agent between refreshes (and after a failed attempt); never under 30 min
      "maxPerDay": ${J(r.maxPerDay)},               // a cap per agent per 24 h; 0 = none (the cooldown is enough)
      "handoffWaitMinutes": ${J(r.handoffWaitMinutes)},     // give up (and cool down) if no handoff arrives in this time
      "handoffDir": ${J(r.handoffDir)},   // where the handoff notes are written (kept)
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

  // Model routing (J130) for agents spawned with spawn_agent / open_agent: an explicit model (Angus's, or the
  // caller's) always wins; else the job's kind picks a ladder step; else "default". Escalation moves a running
  // agent ONE step up the ladder (never above "ceiling" unless asked explicitly), once per job, on a budget hit
  // or a failed check, with a note to Thoughts.
  "routing": {
    "default": ${J(G.default)},
    "ladder": [
      ${(G.ladder || []).map(J).join(",\n      ")}
    ],
    // kind -> a ladder step (0 = the first) or a "provider/id:thinking" of its own. simple: mechanical
    // (renames, lookups, a known one-line fix); ordinary: normal implementation or research; hard: design,
    // hard diagnosis, security, adversarial review; review: a verifier from another family than the builder's.
    "kinds": ${J(G.kinds)},
    "ceiling": ${J(G.ceiling)},
    "escalate": ${J(G.escalate)}
  },

  // Budgets for spawned agents (J130), kept HIGH for now (Angus). At a cap the agent stops at the next turn
  // boundary, reports what it has and what's left to its parent, and waits for extend_budget.
  "budgets": {
    "tokens": ${J(Bu.tokens)},   // fresh tokens: input + output + cache writes of its own calls (cached re-reads don't count)
    "minutes": ${J(Bu.minutes)}       // wall time since it was spawned
  },

  // Spawning (J130): live children per parent agent (Thoughts: no limit); maxDepth 2 = a child may spawn,
  // its children may not. orphans, when a parent closes or crashes (not a /reload or /restart): "finish" =
  // each child finishes its step, reports to the world's Thoughts and closes; "adopt" = Thoughts becomes the
  // parent and they keep going; "close" = closed at once (their last reports are kept).
  "orchestration": { "maxChildren": ${J(O.maxChildren)}, "maxDepth": ${J(O.maxDepth)}, "orphans": ${J(O.orphans)} }
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
      const v1 = JSON.parse(V1_UPKEEP_DEFAULT), v1b = { ...v1, refresh: { ...v1.refresh, cooldownHours: 3, maxPerDay: 0 } }; // before / after Angus's 3 h change
      if (![v1, v1b].some((d) => JSON.stringify(u) === JSON.stringify(d)))
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
