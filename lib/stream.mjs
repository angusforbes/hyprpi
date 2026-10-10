// The Stream (Angus 2026-09-30, @hyprpi N40): one read-only timeline of a world, shared by the
// Stream panel (mockups/room-tui.mjs) and the daemon's /digest (thoughts.digest).
//
// Items, oldest first: agents' posts (room messages), per-turn "did" lines, topic changes,
// agent events (joined, moved, …), agent-to-agent talk and Angus's prompts, board changes and
// project moves, Thoughts' 💭 lines. Each item carries its project when known.
// Dedupe: an agent that posted during a turn doesn't also get that turn's did line (the post wins).
//
// Filter syntax ("/stream …", "/digest …"), all combinable:
//   @Name @project …   a union: lines by / to those agents, and lines about those projects
//   3h · 90m · 2d · today · yesterday · since 9am · since 14:30 · since yesterday
//   raw                also the raw tool lines (debugging)
//   other words        lines containing every word (narrows)

export const HIDDEN = new Set(["done", "blocked"]); // logged, shown only in the "all activity" view (the agents panel shows ✓ / ×)
// J147 (Angus: upkeep and automatic notices belong in the Stream, "filtered out from the main view, and only
// included in the 'all activity' view"): upkeep actions and the automatic notes a Thoughts thread no longer draws.
export const ALL_ONLY = new Set(["upkeep", "notice"]);
export const DIRECT = { talk: "to", demand: "asks", reply: "replies to", prompt: "to" };
// Board ops worth a line ("update" is where / next step bookkeeping).
const BOARD_SKIP = new Set(["update"]);

const lc = (s) => String(s ?? "").toLowerCase();
const startOfDay = (t) => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); };

// "9am" "9:30" "14:30" "9.30pm" -> ms today (yesterday if that is still ahead), or null.
function clockToday(s, now) {
  const m = /^(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm)?$/i.exec(s);
  if (!m) return null;
  let h = Number(m[1]); const min = Number(m[2] || 0), ap = lc(m[3]);
  if (h > 23 || min > 59 || (ap && (h < 1 || h > 12))) return null;
  if (ap === "pm" && h < 12) h += 12;
  if (ap === "am" && h === 12) h = 0;
  const d = new Date(now); d.setHours(h, min, 0, 0);
  let t = d.getTime(); if (t > now) t -= 86400e3;
  return t;
}
const DUR = /^(\d+(?:\.\d+)?)\s*(m|min|mins|h|hr|hrs|d|day|days)$/i;
function timeToken(tok, now) {
  const t = lc(tok);
  if (t === "today") return startOfDay(now);
  if (t === "yesterday") return startOfDay(now) - 86400e3;
  const d = DUR.exec(t);
  if (d) { const n = Number(d[1]), u = d[2][0]; return now - n * (u === "m" ? 60e3 : u === "h" ? 3600e3 : 86400e3); }
  return clockToday(t, now);
}

// "@Blink @hyprpi 3h commit" -> { names, since, sinceLabel, words, raw, text }
export function parseStreamFilter(arg, now = Date.now()) {
  const toks = String(arg || "").trim().split(/\s+/).filter(Boolean);
  const f = { names: [], since: 0, sinceLabel: "", words: [], raw: false, text: "" };
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (t.startsWith("@") && t.length > 1) { f.names.push(t.slice(1).replace(/[.:;!?,]+$/, "")); continue; }
    if (/^raw$/i.test(t)) { f.raw = true; continue; }
    if (/^since$/i.test(t) && toks[i + 1]) {
      const two = toks[i + 2] && /^(am|pm)$/i.test(toks[i + 2]) ? toks[i + 1] + toks[i + 2] : null;
      const s = timeToken(two || toks[i + 1], now);
      if (s != null) { f.since = s; f.sinceLabel = `since ${two || toks[i + 1]}`; i += two ? 2 : 1; continue; }
    }
    const s = timeToken(t, now);
    if (s != null && (DUR.test(t) || /^(today|yesterday)$/i.test(t))) { f.since = s; f.sinceLabel = t.toLowerCase(); continue; }
    f.words.push(lc(t));
  }
  f.text = [...f.names.map((n) => "@" + n), f.sinceLabel, f.raw ? "raw" : "", ...f.words].filter(Boolean).join(" ");
  return f;
}
export const emptyFilter = (f) => !f || (!f.names.length && !f.since && !f.words.length && !f.raw);

// Build the timeline.
//   msgs: room messages · events: activity events · changes: board log entries (any order)
//   projects: [{ id, name, members: [agentId], status }] (this world's board)
//   raw: keep tool lines
//   all: the "all activity" view: also upkeep, notices, done / blocked, and board where / next-step updates
// -> [{ key, ts, kind, who: { id, name, icon, color, human } | null, to: [names], project: id | null, text, m?, e?, c? }]
// user: the human's display name (J261: hyprpi.jsonc user.name / the login name); his stored label is "Angus".
export function buildStream({ msgs = [], events = [], changes = [], projects = [], raw = false, all = false, user = "you" }) {
  const live = projects.filter((p) => p.status !== "archived");
  const pById = new Map(projects.map((p) => [p.id, p]));
  const projectsOf = (id) => live.filter((p) => p.members?.includes(id));
  // A line's project: its own tag; else the one @project its text names; else the agent's only project.
  const projectFor = (tag, agentId, text) => {
    if (tag && pById.has(tag)) return tag;
    const t = lc(text), mine = agentId ? projectsOf(agentId) : [];
    const named = live.filter((p) => new RegExp(`@${p.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w-])`).test(t));
    if (named.length === 1) return named[0].id;
    if (named.length > 1) { const own = named.filter((p) => mine.includes(p)); return own.length === 1 ? own[0].id : null; }
    return mine.length === 1 ? mine[0].id : null;
  };
  const out = [];
  // Dedupe: per agent, the "done" times (a turn's did line comes a moment after its done).
  const dones = new Map(), posts = new Map(); // agent id -> [ts]
  for (const e of events) if (e.kind === "done" && e.agent?.id) (dones.get(e.agent.id) || dones.set(e.agent.id, []).get(e.agent.id)).push(e.ts);
  for (const m of msgs) if (m.author?.kind === "agent" && m.author.id) (posts.get(m.author.id) || posts.set(m.author.id, []).get(m.author.id)).push(m.ts);
  for (const l of [...dones.values(), ...posts.values()]) l.sort((a, b) => a - b);
  const postedInTurn = (id, ts) => {
    const ps = posts.get(id); if (!ps?.length) return false;
    const ds = (dones.get(id) || []).filter((t) => t <= ts);
    // The turn ran from the done before this turn's own done (its last element) up to the did line.
    const from = ds.length >= 2 ? ds[ds.length - 2] : ds.length === 1 ? ds[0] - 3600e3 : ts - 3600e3;
    return ps.some((t) => t > from && t <= ts);
  };

  for (const m of msgs) {
    const au = m.author || {}, human = au.kind === "human";
    const who = human ? { id: "", name: user, icon: "", color: "", human: true } : { id: au.id || "", name: au.name || "agent", icon: au.icon || "", color: au.color || "", markup: au.markup || "", human: false };
    out.push({ key: `m${m.seq}`, ts: m.ts, kind: human ? "angus" : String(au.id || "").startsWith("thoughts:") ? "thoughts" : "post", who, to: [],
      project: projectFor(m.project, who.id, m.text), text: String(m.text ?? ""), m });
  }
  for (const e of events) {
    if ((HIDDEN.has(e.kind) || ALL_ONLY.has(e.kind)) && !all) continue;
    if (e.kind === "tool" && !raw) continue;
    const au = e.agent || {};
    if (e.kind === "turn" && au.id && postedInTurn(au.id, e.ts)) continue; // the post says it
    out.push({ key: `e${e.ts}|${au.id || ""}|${e.kind}`, ts: e.ts, kind: e.kind, who: { id: au.id || "", name: au.name || "agent", icon: au.icon || "", color: au.color || "", markup: au.markup || "", human: false },
      to: Array.isArray(e.to) ? e.to.map(String) : [], project: projectFor(e.project, au.id, e.text), text: String(e.text ?? ""), e });
  }
  for (const c of changes) {
    if (BOARD_SKIP.has(c.op) && !all) continue;
    out.push({ key: `c${c.ts}|${c.project}|${c.op}|${c.h || ""}`, ts: c.ts, kind: "board", who: { id: "", name: c.by === "Angus" ? user : c.by || "?", icon: "", color: "", human: c.by === "Angus" },
      to: [], project: pById.has(c.project) ? c.project : null, text: `${c.op}${c.h ? " " + c.h : ""}: ${String(c.text ?? "").replace(/^(next|decide|heard|done): /, "")}`, c,
      pname: pById.get(c.project)?.name || "" });
  }
  out.sort((a, b) => a.ts - b.ts);
  return out;
}

// J420 (Angus: "1 for now"): the Stream's "highlights" view (fifth ^F view): only what matters to Angus.
// Build from the all-activity items (buildStream all: true), then keep the ones highlight() accepts.
// In:  "✗" / "⚠" alerts and errors (any kind: notices, error events, posts, Thoughts lines) · "🔧 done / plan /
//      decide / stuck" tinker results · Thoughts' "✓✓ J… verified" and "✗ J… failed" · decide items asked
//      (board add "decide: …") or answered (a D item marked done, or edited to "ANSWERED" / "Angus chose …") ·
//      briefs given ("→ Agent … · brief J…") · Thoughts' "Agent ↩ …" summaries of agents' replies · Angus's
//      own posts and prompts · any line that @-mentions or quotes Angus ("Angus: "…"", "Angus (his words)",
//      "Angus chose / decided / said …").
// Out: board bookkeeping (where / next step, edits, archive, drop, join, done items), 🧹 upkeep, routine
//      "↩ answered X" plumbing, ⏰ wake-ups, 🌱 🍂 📨 ⛽ orchestration notes, tool and did lines, topics,
//      joined / left / moved, ✓ / × status, stopped (Esc).
export const HIGHLIGHTS_HELP = "highlights: ✗ / ⚠ alerts and errors · 🔧 results · ✓✓ verified / ✗ failed jobs · decisions asked or answered · briefs · agents' replies (↩) · you, and lines that mention or quote you";
const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
export function highlight(it, user = "Angus") {
  const t = String(it?.text ?? "").trimStart(), k = it?.kind;
  if (k === "angus" || k === "prompt") return true;
  if (k === "error") return true;
  if (k === "board") {
    const c = it.c || {}, h = String(c.h || ""), body = String(c.text ?? "");
    if (c.op === "add" && /^decide:/.test(body)) return true;
    if (/^D\d/.test(h) && c.op === "done") return true;
    if (/^D\d/.test(h) && c.op === "edit" && /^\s*(?:ANSWERED|Decided by|\S+ (?:chose|decided)\b)/i.test(body)) return true;
    return false;
  }
  if (!new Set(["post", "thoughts", "talk", "demand", "reply", "notice"]).has(k)) return false; // tool / did / topic / joined / upkeep …
  if (/^[✗⚠]/u.test(t)) return true;
  if (/^(?:↩ answered |⏰|🧹|🌱|🍂|📨|⛽)/u.test(t)) return false; // plumbing and orchestration, even when it quotes Angus
  if (/^🔧\s*(?:done|plan|decide|stuck)\b/iu.test(t) || /^\(workshop [A-Z] #\d+\) 🔧\s*(?:done|plan|decide|stuck)\b/iu.test(t)) return true;
  if (k === "thoughts") {
    if (/^✓✓/u.test(t)) return true;
    if (/^→ [^\n]*?· brief J\d+/u.test(t)) return true;
    if (/^[^\s↩→][^\n]{0,60}? ↩ /u.test(t) && !/^↩ answered /u.test(t)) return true; // "Remote ↩ …", not "↩ answered Remote: …"
  }
  // The human's display name (hyprpi.jsonc user.name, else the login: "Agf") and "Angus", the name agents and
  // Thoughts write in their text (policy.mjs HUMAN_KEY), so both count.
  const u = `(?:${[...new Set([user, "Angus"].filter(Boolean))].map(esc).join("|")})`;
  if (new RegExp(`@${u}\\b`, "i").test(t)) return true;
  if (new RegExp(`\\b${u}\\b(?:\\s*\\([^)]{0,40}\\))?\\s*:\\s*["“]`, "u").test(t)) return true; // Angus: "…" · Angus (his words): "…"
  if (new RegExp(`\\b${u} \\(his words\\)|\\b${u} (?:chose|decided|said|wrote|asked|approved|picked)\\b`, "u").test(t)) return true;
  return false;
}

// The highlights view's items: highlight() over the all-activity items, minus a tinker / prompt event that
// repeats one of Angus's own room lines (the "🔧 → Agent: text" post and its "Angus → Agent" prompt event).
export function highlights(items, user = "Angus") {
  const kept = items.filter((it) => highlight(it, user));
  const said = kept.filter((it) => it.kind === "angus");
  const body = (s) => String(s).replace(/^[^:]*:\s*/, "").slice(0, 80);
  return kept.filter((it) => it.kind !== "prompt" || !said.some((a) => Math.abs(a.ts - it.ts) < 10000 && body(a.text) === body(it.text)));
}

// Resolve the filter's @names: agents (live and closed: pool entries and names seen in the items)
// and projects. -> { agentIds, agentNames, projects: [{ id, name, members }], unknown }
export function resolveFilterNames(names, { agents = [], projects = [], items = [] }) {
  const agentIds = new Set(), agentNames = new Set(), ps = [], unknown = [];
  const seen = new Map(); for (const it of items) if (it.who?.id && !it.who.human) seen.set(lc(it.who.name), it.who.id);
  for (const n of names) {
    const k = lc(n);
    const p = projects.find((x) => lc(x.name) === k || x.id === k);
    if (p) { ps.push(p); continue; }
    const a = agents.find((x) => lc(x.display) === k || lc(x.name) === k);
    if (a) { agentIds.add(a.id); agentNames.add(lc(a.display || a.name)); continue; }
    if (seen.has(k)) { agentIds.add(seen.get(k)); agentNames.add(k); continue; }
    unknown.push(n);
  }
  return { agentIds, agentNames, projects: ps, unknown };
}

// Apply a parsed filter (names already resolved with resolveFilterNames).
export function filterStream(items, f, r) {
  let list = items;
  if (f.since) list = list.filter((it) => it.ts >= f.since);
  if (f.names.length && r) {
    const pIds = new Set(r.projects.map((p) => p.id)), members = new Set(r.projects.flatMap((p) => p.members || []));
    list = list.filter((it) => {
      const t = lc(it.text);
      if (it.who?.id && r.agentIds.has(it.who.id)) return true;
      if (it.to.some((n) => r.agentNames.has(lc(n)))) return true;
      if ((it.kind === "angus" || it.kind === "prompt") && [...r.agentNames].some((n) => t.includes("@" + n))) return true;
      if (it.kind === "prompt" && it.who?.id && r.agentIds.has(it.who.id)) return true;
      if (it.project && pIds.has(it.project)) return true;
      if (r.projects.some((p) => t.includes("@" + lc(p.name)))) return true;
      if (!it.project && it.who?.id && members.has(it.who.id)) return true; // a member's untagged line
      return false;
    });
  }
  if (f.words.length) list = list.filter((it) => { const h = lc(`${it.text} ${it.who?.name || ""} ${it.to.join(" ")} ${it.pname || ""}`); return f.words.every((w) => h.includes(w)); });
  return list;
}

const hhmm = (ts) => { const d = new Date(ts); return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`; };
const one = (s, n) => { const x = String(s ?? "").replace(/\s+/g, " ").trim(); return n && x.length > n ? x.slice(0, n - 1) + "…" : x; };

// One plain line per item (the /digest evidence; also what a compact row says).
export function streamLine(it, { projectName = () => "", clip = 0, time = true, user = "you" } = {}) {
  const pj = it.kind === "board" ? (it.pname || projectName(it.project)) : projectName(it.project);
  const tag = pj ? ` [@${pj}]` : "";
  const who = it.kind === "board" ? `📋 ${it.who.name}` : `${it.who.icon ? it.who.icon + " " : ""}${it.who.name}`;
  let body;
  if (DIRECT[it.kind]) {
    const txt = String(it.text).replace(/^[^:]*:\s*/, "");
    body = it.kind === "prompt" ? `${user} to ${who}: ${txt}` : `${who} ${DIRECT[it.kind]} ${it.to.join(", ")}: ${txt}`;
  } else if (it.kind === "turn") body = `${who} did: ${it.text}`;
  else if (it.kind === "topic") body = `${who} topic: ${it.text}`;
  else body = `${who}: ${it.text}`;
  return `${time ? hhmm(it.ts) + " " : ""}${one(body, clip)}${tag}`;
}
