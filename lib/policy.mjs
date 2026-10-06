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
    refresh: { enabled: true, idleMinutes: 5, cooldownHours: 3, maxPerDay: 0, reaskMinutes: 5, handoffWaitMinutes: 15, handoffDir: "~/.local/state/hyprpi/handoffs", roomLine: true },
    autoReload: { enabled: true, idleMinutes: 2, watch: [] },
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
  // J136 (Blink): a lapsed model login, noticed by the daemon from agents' and Thoughts' errors.
  auth: { enabled: true, minAgents: 2, windowSeconds: 120, thoughtsTrigger: true, checkSeconds: 15, carryOn: true, notify: true, warnHours: 24, providers: ["anthropic"], authFile: "", fix: { anthropic: "in any agent window type /login and choose Anthropic (Claude Pro/Max), then finish the sign-in in the browser" } },
};

const J = (v) => JSON.stringify(v);
// The file as written out: every default (or carried-over value) with its comment.
export function policyText(v = DEFAULTS) {
  const u = v.upkeep, p = u.prune, c = u.compactContinue, r = u.refresh, R = v.restarts, T = v.thoughts;
  const Au = { ...DEFAULTS.auth, ...(v.auth || {}) }, G = { ...DEFAULTS.routing, ...(v.routing || {}) }, Bu = { ...DEFAULTS.budgets, ...(v.budgets || {}) }, O = { ...DEFAULTS.orchestration, ...(v.orchestration || {}) };
  return `// hyprpi policy (J125 v2): how hyprpi behaves. Edit freely. The daemon and the agents re-read this file
// when its modification time changes (lib/policy.mjs), so an edit applies at the next use or upkeep pass
// (within about a minute): no restart or reload needed. A file that doesn't parse keeps the last good values
// (the daemon logs "hyprpi.jsonc: <error>"). A key you delete falls back to its default (for
// thoughts.carryTurns and thoughts.refreshAfter, first to config.json's old thoughtsCarryTurns /
// refreshAfter). Machine details (pi binary, models for search and Thoughts, worldSize, …) stay in
// config.json. Each world's Thoughts is in charge of upkeep and gets a 🧹 line for every action; Angus is
// never asked. A plain-English guide to every policy: POLICIES.md in this folder.
{
  "upkeep": {
    // 1. Pruning (pi-extension/upkeep.ts + lib/prune.mjs): before EVERY model request, older large images
    //    and long tool outputs are swapped, in what the model sees only, for a one-line stub with a file://
    //    link (the session file on disk keeps everything). Anything that isn't already a file is saved to
    //    saveDir/<agent id> (a Thoughts: saveDir/thoughts-<world>) first; if it can't be saved it stays.
    //    Only user messages and tool results are touched. Never pruned: Angus's latest message and the latest
    //    tool result. An agent window's pruning gets its Thoughts a 🧹 note at most every 10 min; a Thoughts
    //    prunes its own context silently.
    //    Who it covers: every agent window (pi-extension/upkeep.ts, loaded by the hyprpi extension) AND each
    //    world's Thoughts (J137: thoughts.ts loads the same hook). Before J137 Thoughts never pruned, so pasted
    //    screenshots rode along in every request (Thoughts-D: 2 screenshots, ~1 MB, 2026-10-06) until a
    //    compaction or a fresh session. If a new kind of agent process is added, it needs this hook too.
    "prune": {
      "enabled": ${J(p.enabled)},            // false = never prune (default true)
      "keepImages": ${J(p.keepImages)},            // the newest N images stay in context (default 3); small images (below) count towards N too
      "imageMinKB": ${J(p.imageMinKB)},           // images smaller than this (icons) always stay (default 40)
      "keepTurns": ${J(p.keepTurns)},             // tool outputs from the last N of Angus's turns always stay (default 6)
      "maxToolChars": ${J(p.maxToolChars)},      // older tool outputs longer than this become a stub keeping the first 600 chars (default 12000)
      "saveDir": ${J(p.saveDir)}   // where images/outputs that weren't files are saved, one folder per agent
    },
    // 2. Compact and continue: pi itself compacts between turns mid-run and carries on. After any
    //    compaction, the hyprpi extension adds a hidden reminder of the agent's running J<n> briefs (from the
    //    daemon), as a steer if it is working. Nothing happens for an agent with no running brief.
    "compactContinue": {
      "enabled": ${J(c.enabled)},            // false = no reminder (default true)
      "briefReminder": ${J(c.briefReminder)}       // the reminder itself; both must be true (default true)
    },
    // 3. Overdue refresh (daemon upkeep pass, every minute): an agent that is "due" (thoughts.refreshAfter
    //    below), idle for idleMinutes, connected, in a world, not parked and not paused is asked to write a handoff note,
    //    then reopened on a FRESH session that starts from it (same name, workspace, projects, jobs and
    //    pending replies). A working agent is never touched. If it writes the note but doesn't call
    //    upkeep_ready, the pass refreshes it from the note once it's idle (J137).
    "refresh": {
      "enabled": ${J(r.enabled)},              // false = no new automatic asks (one already asked still finishes); Thoughts' own refresh is thoughts.selfRefresh
      "idleMinutes": ${J(r.idleMinutes)},             // idle at least this long before it's asked; also used for Thoughts' selfRefresh (default 5)
      "cooldownHours": ${J(r.cooldownHours)},           // per agent between refreshes, and after a failed attempt; never under 30 min (default 3)
      "maxPerDay": ${J(r.maxPerDay)},               // a cap per agent per 24 h; 0 = none, the cooldown is enough (default 0)
      "reaskMinutes": ${J(r.reaskMinutes ?? 5)},            // no handoff yet after this long: ask once more (default 5)
      "handoffWaitMinutes": ${J(r.handoffWaitMinutes)},     // then give up (🧹 note to its Thoughts) and cool down; also Thoughts' handoff wait (default 15)
      "handoffDir": ${J(r.handoffDir)},   // where the handoff notes are written (kept)
      "roomLine": ${J(r.roomLine)}              // one 🔄 line in the agent's room when it is refreshed (default true)
    },
    // 4. Auto-reload (J135): when the agent-side code changes (hyprpi's pi-extension and the lib files it
    //    uses, the global pi extensions, skills, pi's settings.json, AGENTS.md), each agent is reloaded once
    //    per code version, when it has been idle for idleMinutes and isn't paused or parked (same session,
    //    name, workspace). A Thoughts is restarted on the new code (same session) when idle that long.
    //    Agents whose extension is too old to report its code version are skipped. watch = extra files or
    //    folders whose changes should count too. enabled false = no automatic reloads (defaults true, 2, []).
    "autoReload": { "enabled": ${J((u.autoReload || {}).enabled ?? true)}, "idleMinutes": ${J((u.autoReload || {}).idleMinutes ?? 2)}, "watch": ${J((u.autoReload || {}).watch || [])} },
    // Agents (names, any case) that upkeep never refreshes or auto-reloads on its own. Thoughts can also
    // pause/resume agents with its upkeep tool (kept in its own state, not here), and its explicit
    // "upkeep now" refreshes an agent even if paused. Pruning still applies to paused agents.
    "paused": ${J(u.paused)}
  },

  // The daemon's own restart queue (J126, \`hyprpi daemon restart\`): requests merge into one pending
  // restart; it happens once no agent is working (the requesters excluded), no Thoughts is busy and no agent
  // is being restarted or reopened (a /restart, or a refresh's reopen; entries older than 30 min or of a
  // vanished agent don't count), for quietSeconds in a row (checked every 10 s). An agent that has only been
  // asked for its handoff, or a pending Thoughts refresh, doesn't hold it up.
  "restarts": {
    "quietSeconds": ${J(R.quietSeconds)},     // everyone idle for this long before it restarts (default 20)
    "watchMinutes": ${J(R.watchMinutes)},     // anything waiting for idle longer than this gets ONE line to the world's Thoughts naming who it waits on (default 15)
    "ttlMinutes": ${J(R.ttlMinutes)}       // a request without its own ttl expires after this, with a note (default 120; capped at 24 h)
  },

  "thoughts": {
    // When a Thoughts is refreshed (hyprpi thoughts new, J116), its last N turns (one of Angus's messages
    // and what followed) are copied into the new thread for display only (J124): the model doesn't get them
    // and search skips them (they're in the archive). 0 = start empty (default 20).
    "carryTurns": ${J(T.carryTurns)},
    // When an AGENT counts as "due for a refresh" (J117): at least \`compactions\` compactions of its session,
    // or \`oldCompactions\` once the session is older than \`days\`. Counted from the session file, so a fresh
    // session starts at 0. Its Thoughts gets one quiet note per session; upkeep.refresh then refreshes it.
    // (defaults 6, 3, 3)
    "refreshAfter": { "compactions": ${J(T.refreshAfter.compactions)}, "oldCompactions": ${J(T.refreshAfter.oldCompactions)}, "days": ${J(T.refreshAfter.days)} },
    // Thoughts agents themselves: when its process is running (it stops after config.json's thoughtsIdleMin)
    // and idle (upkeep.refresh.idleMinutes since its last thread line) and its
    // session passes sessionMB, or (useCompactions) its compactions reach refreshAfter.compactions, it is
    // asked for a handoff and restarted on a fresh session (J116, with carryTurns). Not affected by
    // upkeep.refresh.enabled. cooldownHours between refreshes, never under 30 min.
    // (defaults true, 12, true, 24)
    "selfRefresh": { "enabled": ${J(T.selfRefresh.enabled)}, "sessionMB": ${J(T.selfRefresh.sessionMB)}, "useCompactions": ${J(T.selfRefresh.useCompactions)}, "cooldownHours": ${J(T.selfRefresh.cooldownHours)} }
  },

  // Model routing (J130) for agents spawned with spawn_agent / open_agent (lib/routing.mjs): an explicit
  // model (Angus's, or the caller's) always wins; else the job's kind (complexity) picks a ladder step,
  // never above "ceiling" (a kind that names its own model isn't capped); else "default". A fork keeps its
  // parent's model unless given a model or a kind. An explicit thinking level overrides the step's.
  // Escalation moves a running child ONE step up the ladder, once per job (more only with explicit: true,
  // which may also pass the ceiling), with a note to Thoughts. A child whose model was chosen explicitly is
  // not escalated automatically; one whose model isn't on the ladder (e.g. the review model) can't be
  // escalated at all.
  "routing": {
    "default": ${J(G.default)},       // the kind used when none (or an unknown one) is given
    "ladder": [                  // step 0 … 4, cheapest first; "provider/id:thinking"
      ${(G.ladder || []).map(J).join(",\n      ")}
    ],
    // kind -> a ladder step (0 = the first) or a "provider/id:thinking" of its own. simple: mechanical
    // (renames, lookups, a known one-line fix); ordinary: normal implementation or research; hard: design,
    // hard diagnosis, security, adversarial review; review: a verifier from another family than the builder's.
    "kinds": ${J(G.kinds)},
    "ceiling": ${J(G.ceiling)},                // the highest step routing or automatic escalation may pick (default: the top)
    // onBudget: escalate automatically when a child hits its budget. onFailedCheck is NOT read by the code
    // today: after a failed check the parent (or Thoughts) escalates with escalate_agent, and the
    // once-per-job rule applies either way.
    "escalate": ${J(G.escalate)}
  },

  // Budgets for spawned agents (J130), kept HIGH for now (Angus); a spawn may give its own (its 0 = these
  // defaults, not "no cap"). At a cap the child's extension stops it at the next turn boundary: it reports
  // what it has and what's left to its parent, other tools are blocked, and it waits for extend_budget
  // (no amounts = ADD another allotment of these defaults).
  "budgets": {
    "tokens": ${J(Bu.tokens)},   // fresh tokens: input + output + cache writes of its own model calls (cached re-reads don't count); 0 = no cap
    "minutes": ${J(Bu.minutes)}       // wall time since it was spawned; 0 = no cap
  },

  // Spawning (J130, lib/orch.mjs): maxChildren = live children per parent agent; maxDepth 2 = an agent's
  // child may spawn, its children may not (Thoughts has neither limit). orphans, when a parent closes or
  // crashes (not a /reload or /restart): the children's reports go to the world's Thoughts from then on, and
  // "finish" = each child finishes its step, reports and closes; "adopt" = Thoughts becomes the parent and
  // they keep going; "close" = closed at once (their last reports are kept). (defaults 4, 2, "finish")
  "orchestration": { "maxChildren": ${J(O.maxChildren)}, "maxDepth": ${J(O.maxDepth)}, "orphans": ${J(O.orphans)} },

  // A lapsed model login (J136, lib/authwatch.mjs; plain daemon code, no model call). When minAgents agents,
  // or any Thoughts (thoughtsTrigger), end a turn on a login error (401, an expired or revoked token,
  // invalid_grant, "please log in") within windowSeconds, Angus gets ONE critical notification (notify), the
  // red 󰌾 login mark on the bar (agf.hyprpi-login, from ~/.local/state/hyprpi/alert.json) and every world's
  // Thoughts one 🔑 line; network errors, timeouts and 429/5xx overloads never count. Every checkSeconds the
  // daemon reads pi's auth.json (only each login's type and expiry, never a token; authFile "" = pi's own):
  // a new live login, or a stopped agent's next good turn, clears the mark, and with carryOn each agent that
  // stopped on the error is told to carry on (held if it's busy). A login vanishing from the file alerts at
  // once. warnHours: warn ahead only for logins of these providers WITHOUT a refresh token (Claude's renews
  // itself, so its end can't be seen in advance). fix: what Angus is told to do, per provider.
  "auth": {
    "enabled": ${J(Au.enabled)},
    "minAgents": ${J(Au.minAgents)},          // distinct agents with a login error within windowSeconds
    "windowSeconds": ${J(Au.windowSeconds)},
    "thoughtsTrigger": ${J(Au.thoughtsTrigger)}, // one Thoughts with a login error is enough
    "checkSeconds": ${J(Au.checkSeconds)},      // how often auth.json is looked at (a daemon restart applies a change)
    "carryOn": ${J(Au.carryOn)},
    "notify": ${J(Au.notify)},
    "warnHours": ${J(Au.warnHours)},
    "providers": ${J(Au.providers)},
    "authFile": ${J(Au.authFile)},
    "fix": ${J(Au.fix)}
  }
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
