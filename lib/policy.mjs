// J125 v2 (Angus: "a kind of master hyprpi setting file with reasonable defaults? … yes"): ONE editable policy
// file, ~/.config/hyprpi/hyprpi.jsonc (JSON with // comments), for how hyprpi behaves: upkeep (pruning,
// compaction, refresh), the daemon's restart queue, Thoughts, and (later, J130) routing.
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
import { stateDir } from "./paths.mjs";

const CONFIG_DIR = () => path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "hyprpi");
export const policyFile = () => path.join(CONFIG_DIR(), "hyprpi.jsonc");
export const expandHome = (p) => String(p || "").replace(/^~(?=\/|$)/, os.homedir());
// J437: a path under the live hyprpi state folder ("~/.local/state/hyprpi/…", the default handoffDir and
// prune saveDir) follows the state folder this process uses (HYPRPI_STATE / XDG_STATE_HOME; lib/paths.mjs
// stateDir), so an isolated daemon and its agents never write into the live one. Any other path: as written.
const LIVE_STATE = "~/.local/state/hyprpi";
export function statePath(p, env = process.env) {
  const s = String(p || "");
  if (s === LIVE_STATE || s.startsWith(LIVE_STATE + "/")) return path.join(stateDir(env), s.slice(LIVE_STATE.length));
  return expandHome(s);
}

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
    reviveParked: false,
  },
  // J130 (Blink): model per job complexity + the escalation ladder; who may spawn (J647: no budgets).
  routing: {
    // J534 (Angus: "the default model for now should be Opus 5.5, but configurable in hyprpi configs. And if started by Thoughts or an
    // agent, then up to them depending on task"): the model of an agent Angus opens himself (SUPER+A, `hyprpi new` without --model)
    newAgentModel: "anthropic/claude-opus-5-5",
    default: "ordinary",
    ladder: ["anthropic/claude-haiku-4-5:low", "anthropic/claude-sonnet-5-5:medium", "anthropic/claude-opus-5-5:medium", "anthropic/claude-opus-5-5:high", "anthropic/claude-opus-5-5:xhigh"],
    kinds: { simple: 0, ordinary: 1, hard: 3, review: "openai-codex/gpt-6.1-sol:high" },
    ceiling: 4,
    escalate: { onBudget: false, onFailedCheck: true }, // (J647: onBudget never fires: there are no budgets)
  },
  budgets: { tokens: 0, minutes: 0 }, // J647 (Angus): no budgets; kept only so old config files still parse
  orchestration: { maxChildren: 4, maxDepth: 1, orphans: "finish", idleMinutes: 10, waitDefaultSec: 600, waitMaxSec: 3600, stallAlertMinutes: 10, stallAlertRepeatMinutes: 30, extras: { subagents: "~/.pi/agent/npm/node_modules/@tintinweb/pi-subagents" } },
  // J136 (Blink): a lapsed model login, noticed by the daemon from agents' and Thoughts' errors.
  // J261 (Angus: "make it something like User or their login name, and then can change in configure"): the name
  // the panels and the phone show for you. "" = your login name (capitalised), else "User".
  user: { name: "" },
  // J528: pushes to Angus's phone through ntfy (lib/ntfy.mjs): bonks and decisions only. brev-autostop reads topic and server too.
  phone: { ntfy: { enabled: false, server: "https://ntfy.sh", topic: "", kinds: ["bonk", "decision"], maxPerHour: 12, click: "" } },
  // J650: reminders for IMPORTANT Decide items (lib/decision-reminders.mjs).
  decisions: { remindEveryMin: 10, remindRounds: 12, toast: true, projects: {} },
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
    "selfRefresh": { "enabled": ${J(T.selfRefresh.enabled)}, "sessionMB": ${J(T.selfRefresh.sessionMB)}, "useCompactions": ${J(T.selfRefresh.useCompactions)}, "cooldownHours": ${J(T.selfRefresh.cooldownHours)} },
    // reviveParked (J241): may a world's Thoughts bring back one of its PARKED agents (window in Reprieve:
    // still running, out of the room) when it needs it? true: its revive_agent tool does, and ask_agent /
    // give_work / interrupt_agent on a parked agent revive it first; the window goes back to its last
    // workspace in that world, without taking your focus, with a ♻ room line. false: Thoughts sees parked
    // agents in its world view but its tools refuse them ("X is parked; reviving is off"), and only you
    // bring one back (room panel Ctrl+O, reprieve undo). (default false)
    "reviveParked": ${J(!!T.reviveParked)}
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
    // J534: the model of an agent Angus opens himself (SUPER+A, or \`hyprpi new\` without --model): "provider/id", one on the
    // scoped model list (J397), else it is skipped with a warning. "" = pi's own default. Agents that Thoughts or other agents
    // start (spawn_agent / open_agent) don't use it: they get the routing below or the model they were given.
    "newAgentModel": ${J(G.newAgentModel ?? "")},
    "default": ${J(G.default)},       // the kind used when none (or an unknown one) is given
    "ladder": [                  // step 0 … 4, cheapest first; "provider/id:thinking"
      ${(G.ladder || []).map(J).join(",\n      ")}
    ],
    // kind -> a ladder step (0 = the first) or a "provider/id:thinking" of its own. simple: mechanical
    // (renames, lookups, a known one-line fix); ordinary: normal implementation or research; hard: design,
    // hard diagnosis, security, adversarial review; review: a verifier from another family than the builder's.
    "kinds": ${J(G.kinds)},
    "ceiling": ${J(G.ceiling)},                // the highest step routing or automatic escalation may pick (default: the top)
    // onBudget: unused (J647: no budgets). onFailedCheck (J140): escalate
    // automatically when a job fails its check: its report (or a spawned child's final report on its job)
    // doesn't answer every done-when line, or a verifier marks it FAILED (Thoughts' verify_work failed: true,
    // which also reopens the job). Only agents spawned through orchestration (their model came from the
    // ladder) move; an explicitly chosen model never does. One step, once per job, never past ceiling, with
    // a ⤴ note to Thoughts; false = only escalate_agent escalates after a failed check.
    "escalate": ${J(G.escalate)}
  },

  // J647 (Angus 2026-10-15: "why are we giving time/token budgets to our task agents? you can stop them whenever you want …
  // it just creates noise and extra decisions for me"): spawned agents have NO time or token budget. This section is
  // ignored (any value, and any budget a spawner passes); a parent stops a helper with close_agent. (Was J130 / J381.)
  "budgets": { "tokens": 0, "minutes": 0 },

  // Spawning (J130, lib/orch.mjs): maxChildren = live children per parent agent; maxDepth 1 = an agent's
  // children may not spawn (J466, J201 amended 2026-10-11: one level of splitting; 2 lets a child spawn once more; Thoughts has neither limit). orphans, when a parent closes or
  // crashes (not a /reload or /restart): the children's reports go to the world's Thoughts from then on, and
  // "finish" = each child finishes its step, reports and closes; "adopt" = Thoughts becomes the parent and
  // they keep going; "close" = closed at once (their last reports are kept). (defaults 4, 1, "finish")
  // idleMinutes (J272): a spawned child idle this long without a final report is reported to its parent as stalled
  // (its wait_report returns, or a message); a child whose turn ends on an error is reported
  // at once. 0 = no idle check. (default 10)
  // J452: waitDefaultSec / waitMaxSec = a wait_report's time limit when none is given / at most (it then returns "no report from X after
  // N min" with X's state); stallAlertMinutes = an agent "working" with no output (no tokens, no tool output) this long gets ONE
  // "[hyprpi alert] ⚠ stalled" line to its world's Thoughts (0 = off), again at most every stallAlertRepeatMinutes.
  // J698: extras = pi extensions an agent can be STARTED with on top of ~/.pi/agent/settings.json, by name: spawn_agent /
  // open_agent subagents: true (or hyprpi new --extra NAME) gives that agent "subagents" (pi-subagents' in-process Agent
  // tools, off by default for every other agent since mem4). Kept per agent across restarts and refreshes
  // (~/.local/state/hyprpi/agent-extras.json). name -> an installed extension or package folder.
  "orchestration": { "maxChildren": ${J(O.maxChildren)}, "maxDepth": ${J(O.maxDepth)}, "orphans": ${J(O.orphans)}, "idleMinutes": ${J(O.idleMinutes)}, "waitDefaultSec": ${J(O.waitDefaultSec)}, "waitMaxSec": ${J(O.waitMaxSec)}, "stallAlertMinutes": ${J(O.stallAlertMinutes)}, "stallAlertRepeatMinutes": ${J(O.stallAlertRepeatMinutes)}, "extras": ${J(O.extras || {})} },

  // You (J261): the name the panels and the phone show for your messages and board changes. "" = your login
  // name, capitalised (or "User" when there is none). Old history is shown with it too.
  "user": { "name": ${J((v.user || {}).name ?? "")} },

  // Phone pushes (J528, lib/ntfy.mjs) through ntfy (the free ntfy.sh, or your own server): when an agent needs you
  // ("bonk") or a decision waits for you ("decision": a Decide item on a card, a held sandbox message waiting for 1/2/3).
  // Never job reports, room chatter, stalls or upkeep. Each push says the world, the agent, the project, the question
  // and its numbered options; one push per item (an item is remembered 7 days, so it never repeats), at most maxPerHour (0 = no cap). Subscribe to the topic in the
  // ntfy app. Anyone who knows the topic name can read it: for privacy choose a long, unguessable name. click: a link
  // opened when you tap the push (e.g. the phone app's address); "" = none. brev-autostop uses the same topic and server.
  "phone": { "ntfy": ${J({ ...DEFAULTS.phone.ntfy, ...((v.phone || {}).ntfy || {}) })} },
  // Decisions (J650): a Decide item is "normal" (one phone push, as above) or "important": then it's pushed again every
  // remindEveryMin minutes, one reminder listing all open important decisions, until it's answered or its reminders are
  // stopped or snoozed (by the asking agent or Thoughts, on your word), at most remindRounds times (12 x 10 min = 2 h),
  // the last saying "no more reminders". toast: also a desktop notification each round. projects: a project's default
  // level, e.g. { "mathbac": "important" }; the filing agent or you (/important D6, /normal D6) can set an item's own.
  "decisions": ${J({ ...DEFAULTS.decisions, ...(v.decisions || {}) })},

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

// J261: the human's display name in the panels and the phone: hyprpi.jsonc user.name, else the login name
// (capitalised), else "User". Stored history keeps its old internal label ("Angus") and is shown with this.
export function userName() {
  const n = String(loadPolicy().user?.name || "").trim();
  if (n) return n;
  let login = ""; try { login = os.userInfo().username || ""; } catch { login = process.env.USER || ""; }
  return login ? login[0].toUpperCase() + login.slice(1) : "User";
}
// The internal label stored for the human's messages and board changes (kept for old history).
export const HUMAN_KEY = "Angus";

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
    try { const bdir = statePath("~/.local/state/hyprpi/backups"); fs.mkdirSync(bdir, { recursive: true }); fs.renameSync(old, path.join(bdir, `upkeep.jsonc.${Date.now()}`)); } catch { /* leave it */ }
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
