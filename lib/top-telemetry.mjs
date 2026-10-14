// J557: read-only agent metadata for the hyprpi "top" view: who the agents are (from the daemon and its
// persisted state only, never guessed from process names), their context use, compactions, session age,
// restarts / upkeep refreshes, helper budgets and a 0-100 coordination priority.
//
//   const t = createTelemetryReader({ request, statePath });   // request(method, params) = lib/client.mjs request
//   const { timestampMs, agents, worlds, warnings, priorityFormula } = await t.read();
//
// Read-only and light: it calls only the daemon's pure getters "list" (every read) and "orch.all" (cached),
// never board.get (it may start a summary model call), thoughts.status (starts a turn) or status.facts (git).
// Everything else is read from files the daemon already persists (STATE = statePath):
//   boards/<room>.json (owned projects, decide items), briefs.json (running jobs), requests.json (demands),
//   upkeep.json (refresh history), activity/<room>.jsonl (finished turns, restarts), thoughts/<room>/ (Thoughts
//   sessions and model marker), worlds/world-<x>/ (the laptop's mirrors of sandboxed / remote worlds),
//   and the Pi model catalog (~/.pi/agent/models-store.json, models.json: only contextWindow is kept).
// Slow sources are cached (slowMs, default 10 s); session files are cached by inode/size/mtime and read as
// bounded tails, incrementally as they grow. Nothing is written; prompts, report texts and secrets are never
// kept or returned. null always means unknown, never zero.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const HOUR = 3600e3, DAY = 24 * HOUR, WEEK = 7 * DAY;
const known = (n) => typeof n === "number" && Number.isFinite(n);
const num = (n) => (known(Number(n)) && n !== null && n !== "" ? Number(n) : null);
const readJson = (f) => JSON.parse(fs.readFileSync(f, "utf8"));
const statOf = (f) => { try { return fs.statSync(f); } catch { return null; } };
const tsOf = (v) => (known(v) ? v : typeof v === "string" ? Date.parse(v) : NaN);

// --------------------------------------------------------------------------------------- priority ---
export const PRIORITY_FORMULA = [
  "priority (0-100) = sum of the components whose source is available (a missing source adds 0 and is listed in priorityDetails.missing):",
  "active 35 = daemon status working (background: turn ended, helpers still running = 15; other statuses 0);",
  "recency 15 = last finished turn (activity kind done/turn) <= 5 min ago, 8 if <= 30 min, else 0;",
  "turns 10 = 2 x finished turns (activity kind done) in the last hour, at most 10;",
  "projects 10 = 5 x non-archived board projects it is the writer (owner) of, at most 10;",
  "jobs 10 = 5 x briefs in state running assigned to it (briefs.json), at most 10;",
  "angus 8 = waiting on Angus: daemon status blocked, or an open (not archived) decide item it filed;",
  "demands 6 = at least one unanswered, uncancelled demand addressed to it, at most 60 min old (requests.json; 60 min is the longest wait, so the waiter may already have timed out);",
  "helpers 6 = parent of live helpers (daemon children or in-process subagents).",
  "Not OS scheduling priority.",
].join(" ");
export const PRIORITY_MAX = { active: 35, recency: 15, turns: 10, projects: 10, jobs: 10, angus: 8, demands: 6, helpers: 6 };

// inputs: { status, lastTurnAt, turnsLastHour, ownedProjects, runningJobs, blocked, openDecides, pendingDemands,
// liveHelpers }; undefined/null = that source is missing. -> { priority, details }
export function scorePriority(i, now = Date.now()) {
  const c = {}, missing = [];
  const put = (k, avail, points, value) => { if (!avail) { missing.push(k); return; } c[k] = { points: Math.min(PRIORITY_MAX[k], points), max: PRIORITY_MAX[k], value }; };
  put("active", typeof i.status === "string" && i.status !== "", i.status === "working" ? 35 : i.status === "background" ? 15 : 0, i.status);
  const age = known(i.lastTurnAt) ? now - i.lastTurnAt : null;
  put("recency", i.lastTurnAt !== undefined, age == null ? 0 : age <= 5 * 60e3 ? 15 : age <= 30 * 60e3 ? 8 : 0, age == null ? null : Math.round(age / 1000));
  put("turns", known(i.turnsLastHour), 2 * (i.turnsLastHour || 0), i.turnsLastHour);
  put("projects", known(i.ownedProjects), 5 * (i.ownedProjects || 0), i.ownedProjects);
  put("jobs", known(i.runningJobs), 5 * (i.runningJobs || 0), i.runningJobs);
  const angusKnown = typeof i.blocked === "boolean" || known(i.openDecides);
  put("angus", angusKnown, i.blocked === true || (i.openDecides || 0) > 0 ? 8 : 0, { blocked: i.blocked ?? null, openDecides: i.openDecides ?? null });
  put("demands", known(i.pendingDemands), (i.pendingDemands || 0) > 0 ? 6 : 0, i.pendingDemands);
  put("helpers", known(i.liveHelpers), (i.liveHelpers || 0) > 0 ? 6 : 0, i.liveHelpers);
  const priority = Math.max(0, Math.min(100, Object.values(c).reduce((s, x) => s + x.points, 0)));
  return { priority, details: { components: c, missing } };
}

// ------------------------------------------------------------------------------- context (Pi usage) ---
// Pi's own accounting (pi 1.0.2 AgentSession.getContextUsage + ai/utils/estimate.ts): the context is the
// last valid assistant response's provider usage on the current branch (stopReason not aborted/error,
// calculateContextTokens > 0), where calculateContextTokens = usage.totalTokens || input + output + cacheRead
// + cacheWrite; after a compaction it is unknown (null) until a new response reports usage. Pi then adds a
// chars/4 estimate for messages after that response; we don't (no chars-to-tokens guesses): those messages are
// counted in trailingMessages instead, so the figure is "as of the last response".
export const calculateContextTokens = (u) => (u ? (num(u.totalTokens) || (num(u.input) || 0) + (num(u.output) || 0) + (num(u.cacheRead) || 0) + (num(u.cacheWrite) || 0)) : 0);
const validUsage = (m) => m && m.role === "assistant" && m.stopReason !== "aborted" && m.stopReason !== "error" && calculateContextTokens(m.usage) > 0;

// Only what we need from an entry (never content).
function slim(e) {
  const o = { type: e.type, id: e.id ?? null, parentId: e.parentId ?? null, ts: tsOf(e.timestamp) };
  if (e.type === "message" && e.message) {
    const m = e.message; o.role = m.role;
    if (m.role === "assistant") {
      o.valid = validUsage(m); o.provider = typeof m.provider === "string" ? m.provider : ""; o.model = typeof m.model === "string" ? m.model : "";
      if (o.valid) { const u = m.usage; o.usage = { input: num(u.input), output: num(u.output), cacheRead: num(u.cacheRead), cacheWrite: num(u.cacheWrite), totalTokens: num(u.totalTokens) }; o.ts = tsOf(m.timestamp) || o.ts; }
    }
  } else if (e.type === "model_change") { o.provider = String(e.provider || ""); o.model = String(e.modelId || ""); }
  return o;
}
// Complete lines of buf (bytes from file offset `start`); the first is dropped unless start is 0 or `aligned`
// (a known line start; else it may be cut), the last unless the buffer ends with "\n" (still being written).
// -> { entries, end (file offset after the last complete line), bad }
function parseChunk(buf, start, aligned = false) {
  let from = 0;
  if (start > 0 && !aligned) { const i = buf.indexOf(10); if (i < 0) return { entries: [], end: start, bad: 0 }; from = i + 1; }
  const last = buf.lastIndexOf(10);
  if (last < from) return { entries: [], end: start + from, bad: 0 };
  const entries = []; let bad = 0;
  for (const line of buf.subarray(from, last).toString("utf8").split("\n")) {
    if (!line.trim()) continue;
    let e; try { e = JSON.parse(line); } catch { bad++; continue; }
    if (e && typeof e === "object" && e.type !== "session") entries.push(slim(e));
  }
  return { entries, end: start + last + 1, bad };
}
function readRange(file, start, end) {
  const fd = fs.openSync(file, "r");
  try { const n = Math.max(0, end - start), buf = Buffer.alloc(n); let got = 0; while (got < n) { const r = fs.readSync(fd, buf, got, n - got, start + got); if (!r) break; got += r; } return buf.subarray(0, got); }
  finally { fs.closeSync(fd); }
}
// Walk the branch from the leaf (the last entry) back through parentId. -> { done, usage entry, compaction seen
// before usage, newer model_change, trailing messages, the id where the walk left the known entries }
function walk(entries, stopAt = null) {
  const byId = new Map(); for (const e of entries) if (e.id) byId.set(e.id, e);
  let e = entries.at(-1), trailing = 0, modelChange = null, guard = 0;
  const leafId = e?.id ?? null;
  while (e && guard++ < 1e6) {
    if (e.type === "compaction") return { done: true, leafId, compaction: e, trailing, modelChange };
    if (e.type === "message" && e.valid) return { done: true, leafId, usage: e, trailing, modelChange };
    if (e.type === "model_change" && !modelChange) modelChange = e;
    if (e.type === "message") trailing++;
    if (!e.parentId) return { done: true, leafId, none: true, trailing, modelChange }; // the root: no usage ever
    if (stopAt && e.parentId === stopAt) return { done: false, leafId, joined: true, trailing, modelChange };
    const next = byId.get(e.parentId);
    if (!next) return { done: false, leafId, trailing, modelChange, outside: e.parentId };
    e = next;
  }
  return { done: false, leafId, trailing, modelChange };
}

// Session-file context reader with a cache: unchanged file = no read; a file that grew = only the new bytes
// (unless the branch jumped elsewhere); else a tail of 256 KB, growing x8 up to maxTailBytes.
export function createContextReader({ maxTailBytes = 8 * 1024 * 1024, firstTailBytes = 256 * 1024 } = {}) {
  const cache = new Map(); // file -> { ino, size, mtimeMs, end, leafId, res }
  const stats = { fullReads: 0, incrementalReads: 0, cacheHits: 0, bytesRead: 0 };
  const result = (w, extra) => {
    if (w.usage) {
      const u = w.usage;
      return { status: "measured", tokens: calculateContextTokens(u.usage), usage: u.usage, provider: (w.modelChange || u).provider, model: (w.modelChange || u).model,
        responseProvider: u.provider, responseModel: u.model, measuredAt: known(u.ts) ? u.ts : null, trailingMessages: w.trailing, ...extra };
    }
    if (w.compaction) return { status: "awaiting", tokens: null, reason: "compacted; no response since (Pi reports null until the next response)", compactedAt: known(w.compaction.ts) ? w.compaction.ts : null, provider: w.modelChange?.provider || "", model: w.modelChange?.model || "", trailingMessages: w.trailing, ...extra };
    return { status: "unknown", tokens: null, reason: w.none ? "no assistant response with usage yet" : `no usage within the last ${Math.round(maxTailBytes / 1048576)} MB`, provider: w.modelChange?.provider || "", model: w.modelChange?.model || "", trailingMessages: w.trailing, ...extra };
  };
  function full(file, st) {
    let size = firstTailBytes, w = null, end = 0;
    for (;;) {
      const start = Math.max(0, st.size - size), buf = readRange(file, start, st.size); stats.bytesRead += buf.length;
      const p = parseChunk(buf, start); end = p.end; w = walk(p.entries);
      if (w.done || start === 0 || size >= maxTailBytes) break;
      size = Math.min(maxTailBytes, size * 8);
    }
    stats.fullReads++;
    if (!w.done && !w.none) w = { ...w, done: true };
    return { end, leafId: w.leafId, res: result(w, {}) };
  }
  function read(file) {
    if (!file) return { status: "missing", tokens: null, reason: "no session file known" };
    const st = statOf(file);
    if (!st) { cache.delete(file); return { status: "missing", tokens: null, reason: "session file not found" }; }
    const c = cache.get(file);
    if (c && c.ino === st.ino && c.size === st.size && c.mtimeMs === st.mtimeMs) { stats.cacheHits++; return c.res; }
    let next = null;
    try {
      if (c && c.ino === st.ino && st.size > c.size && c.end <= st.size && st.size - c.end <= maxTailBytes) { // a bigger append: the bounded tail below
        const buf = readRange(file, c.end, st.size); stats.bytesRead += buf.length; stats.incrementalReads++;
        const p = parseChunk(buf, c.end, true), end = p.end; // c.end is a line start: keep the first line
        if (!p.entries.length) next = { end, leafId: c.leafId, res: c.res };
        else {
          const w = walk(p.entries, c.leafId);
          if (w.done) next = { end, leafId: w.leafId, res: result(w, {}) };
          else if (w.joined && c.res) { // nothing newer on this branch: the old figure stands, with more trailing messages / a new model
            const old = c.res, mc = w.modelChange;
            next = { end, leafId: w.leafId, res: { ...old, trailingMessages: (old.trailingMessages || 0) + w.trailing, ...(mc ? { provider: mc.provider, model: mc.model } : {}) } };
          }
        }
      }
      if (!next) next = full(file, st);
    } catch (e) { cache.delete(file); return { status: "unreadable", tokens: null, reason: `session file unreadable (${e.code || "error"})` }; }
    cache.set(file, { ino: st.ino, size: st.size, mtimeMs: st.mtimeMs, ...next });
    return next.res;
  }
  return { read, stats, forget: (keep) => { for (const k of cache.keys()) if (!keep.has(k)) cache.delete(k); } };
}

// ------------------------------------------------------------------------------- model catalog ---
// contextWindow by exact provider + model id from Pi's catalog (~/.pi/agent/models-store.json, fetched
// provider lists) and models.json (custom providers; they win). Only ids and contextWindow are kept: api
// keys, headers and base URLs are never read out, and no key command is run.
export function createModelCatalog({ piDir }) {
  let memo = { sig: "", map: new Map() };
  const files = [path.join(piDir, "models-store.json"), path.join(piDir, "models.json")];
  function load() {
    const sts = files.map(statOf), sig = sts.map((s) => (s ? `${s.ino}:${s.size}:${s.mtimeMs}` : "-")).join("|");
    if (sig === memo.sig) return memo.map;
    const map = new Map();
    try { const j = readJson(files[0]); for (const [prov, v] of Object.entries(j || {})) for (const m of v?.models || []) if (m?.id && known(m.contextWindow)) map.set(`${prov}\u0000${m.id}`, m.contextWindow); } catch { /* none */ }
    try { const j = readJson(files[1]); for (const [prov, v] of Object.entries(j?.providers || {})) for (const m of v?.models || []) if (m?.id && known(m.contextWindow)) map.set(`${prov}\u0000${m.id}`, m.contextWindow); } catch { /* none */ }
    memo = { sig, map };
    return map;
  }
  return { window: (provider, model) => (provider && model ? load().get(`${provider}\u0000${model}`) ?? null : null) };
}

// ------------------------------------------------------------------------------------ activity ---
// Finished turns ("done", "turn") and restarts ("restarted") per agent id from STATE/activity/<room>.jsonl:
// a bounded tail at first (maxBytes), then only the appended bytes. Events older than 7 days are dropped.
function createActivity(dir, { maxBytes = 8 * 1024 * 1024 } = {}) {
  const files = new Map(); // room -> { ino, end, coverStart (ms, the earliest moment fully covered), events }
  const KINDS = /"kind":"(done|turn|restarted)"/;
  function take(buf, start, f) {
    const p = (() => {
      let from = 0;
      if (start > 0 && !f.aligned) { const i = buf.indexOf(10); if (i < 0) return { lines: [], end: start }; from = i + 1; }
      const last = buf.lastIndexOf(10);
      if (last < from) return { lines: [], end: start + from };
      return { lines: buf.subarray(from, last).toString("utf8").split("\n"), end: start + last + 1, firstFrom: from };
    })();
    for (const line of p.lines) {
      if (!line || !KINDS.test(line)) {
        if (line && f.firstTs == null) { const m = /"ts":(\d+)/.exec(line); if (m) f.firstTs = Number(m[1]); }
        continue;
      }
      let e; try { e = JSON.parse(line); } catch { continue; }
      if (f.firstTs == null && known(e.ts)) f.firstTs = e.ts;
      if (e?.agent?.id && known(e.ts)) f.events.push({ ts: e.ts, kind: e.kind, id: String(e.agent.id) });
    }
    return p.end;
  }
  function refresh(now) {
    let names = []; try { names = fs.readdirSync(dir).filter((n) => n.endsWith(".jsonl")); } catch { return { ok: false }; }
    for (const n of names) {
      const room = n.slice(0, -6), file = path.join(dir, n), st = statOf(file); if (!st) continue;
      let f = files.get(room);
      if (!f || f.ino !== st.ino || st.size < f.end || st.size - f.end > maxBytes) { // new, replaced, shrunk or a huge append: a bounded tail
        f = { ino: st.ino, end: 0, events: [], firstTs: null, aligned: false };
        const start = Math.max(0, st.size - maxBytes);
        f.end = take(readRange(file, start, st.size), start, f);
        f.coverStart = start === 0 ? 0 : (f.firstTs ?? now); // a whole file covers everything logged
        f.aligned = true; files.set(room, f);
      } else if (st.size > f.end) {
        f.end = take(readRange(file, f.end, st.size), f.end, f);
      }
      f.events = f.events.filter((e) => now - e.ts <= WEEK);
    }
    for (const room of files.keys()) if (!names.includes(room + ".jsonl")) files.delete(room);
    return { ok: true };
  }
  function summary(now) {
    const by = new Map(); let cover = 0;
    for (const f of files.values()) {
      cover = Math.max(cover, f.coverStart || 0);
      for (const e of f.events) {
        let s = by.get(e.id); if (!s) by.set(e.id, (s = { lastTurnAt: null, turnsLastHour: 0, restarts: [] }));
        if (e.kind === "done" || e.kind === "turn") s.lastTurnAt = Math.max(s.lastTurnAt ?? 0, e.ts);
        if (e.kind === "done" && now - e.ts <= HOUR) s.turnsLastHour++;
        if (e.kind === "restarted") s.restarts.push(e.ts);
      }
    }
    return { by, since: Math.max(now - WEEK, cover) };
  }
  return { refresh, summary };
}

// --------------------------------------------------------------------------------- /proc helpers ---
function cmdline(procRoot, pid) { try { return fs.readFileSync(path.join(procRoot, String(pid), "cmdline"), "utf8").split("\0"); } catch { return null; } }
const argAfter = (argv, flag) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] ?? null : null; };
function childPids(procRoot, pid) {
  const out = []; let tasks = [];
  try { tasks = fs.readdirSync(path.join(procRoot, String(pid), "task")); } catch { return null; }
  for (const t of tasks) { try { for (const c of fs.readFileSync(path.join(procRoot, String(pid), "task", t, "children"), "utf8").trim().split(/\s+/)) if (/^\d+$/.test(c)) out.push(Number(c)); } catch { /* gone */ } }
  return out;
}

// -------------------------------------------------------------------------------------- reader ---
export function createTelemetryReader({ request, statePath, home = os.homedir(), now = Date.now, slowMs = 10e3,
  piDir = path.join(home, ".pi", "agent"), procRoot = "/proc", daemonPid = null, mirrorStaleMs = 120e3 } = {}) {
  if (typeof request !== "function") throw new Error("createTelemetryReader needs request(method, params)");
  if (!statePath) throw new Error("createTelemetryReader needs statePath");
  const STATE = statePath;
  const ctx = createContextReader(), catalog = createModelCatalog({ piDir }), activity = createActivity(path.join(STATE, "activity"));
  const thoughtsCompacts = new Map(); // file -> { ino, end, count }
  let slow = null, slowAt = -Infinity, slowPending = null;

  const lockPid = () => {
    if (typeof daemonPid === "function") return daemonPid();
    if (daemonPid) return daemonPid;
    return import("./paths.mjs").then(({ socketPath }) => { try { return Number(fs.readFileSync(socketPath().replace(/\.sock$/, ".lock"), "utf8")) || 0; } catch { return 0; } }).catch(() => 0);
  };

  async function loadSlow(t) {
    const warnings = [], S = { warnings };
    try { S.orch = (await request("orch.all", {}))?.children || []; } catch (e) { S.orch = null; warnings.push(`helper budgets unavailable (orch.all: ${e.message})`); }
    // boards: owned projects + open decide items per author
    S.owned = new Map(); S.decides = new Map(); S.boardsOk = false;
    try {
      for (const n of fs.readdirSync(path.join(STATE, "boards"))) {
        if (!/^[A-Za-z0-9_-]+\.json$/.test(n)) continue;
        let b; try { b = readJson(path.join(STATE, "boards", n)); } catch { warnings.push(`board ${n} unreadable`); continue; }
        S.boardsOk = true;
        for (const p of b?.projects || []) {
          if (!p || p.status === "archived") continue;
          if (p.writer) S.owned.set(p.writer, (S.owned.get(p.writer) || 0) + 1);
          for (const it of p.items || []) if (it?.sec === "decide" && !it.archived && it.by?.id) S.decides.set(it.by.id, (S.decides.get(it.by.id) || 0) + 1);
        }
      }
    } catch { warnings.push("boards unreadable: project and decide components omitted"); }
    // running jobs
    S.jobs = null;
    try { const j = readJson(path.join(STATE, "briefs.json")); S.jobs = new Map(); for (const b of Object.values(j?.briefs || {})) if (b?.state === "running" && b.agent) { const l = S.jobs.get(b.agent) || []; l.push({ id: String(b.id || ""), updated: num(b.updated) || 0 }); S.jobs.set(b.agent, l); } for (const l of S.jobs.values()) l.sort((a, b) => b.updated - a.updated); }
    catch { warnings.push("briefs.json unreadable: job component omitted"); }
    // unanswered demands (mode, recipients, replies, ts, cancelled only; never the text)
    S.demands = null;
    try {
      const j = readJson(path.join(STATE, "requests.json")); S.demands = new Map();
      for (const [, r] of Array.isArray(j) ? j : []) {
        if (r?.mode !== "demand" || r.cancelled || !known(r.ts) || t - r.ts > HOUR) continue;
        const replied = new Set((r.replies || []).map((x) => (Array.isArray(x) ? x[0] : x)));
        for (const id of r.recipients || []) if (!replied.has(id)) S.demands.set(id, (S.demands.get(id) || 0) + 1);
      }
    } catch { warnings.push("requests.json unreadable: demand component omitted"); }
    // upkeep refreshes (the daemon keeps a 7-day history per agent)
    S.upkeep = null;
    try { S.upkeep = readJson(path.join(STATE, "upkeep.json")); } catch { warnings.push("upkeep.json unreadable: refreshes unknown"); }
    // activity
    try { if (!activity.refresh(t).ok) warnings.push("activity logs unreadable: turn and restart figures unknown"); else S.activity = activity.summary(t); } catch { warnings.push("activity logs unreadable"); }
    // Thoughts processes: the daemon's own children started with --session-id thoughts-<room> and
    // --session-dir STATE/thoughts/<room> (the daemon's explicit identity arguments; the daemon pid from its lock)
    S.thoughtsPids = new Map(); S.thoughtsPidOk = false;
    const dp = await lockPid();
    if (dp) {
      const kids = childPids(procRoot, dp);
      if (kids) {
        S.thoughtsPidOk = true;
        for (const k of kids) {
          const argv = cmdline(procRoot, k); if (!argv) continue;
          const sid = argAfter(argv, "--session-id"), sdir = argAfter(argv, "--session-dir"), m = /^thoughts-([A-Za-z0-9_-]+)$/.exec(sid || "");
          if (m && sdir && path.resolve(sdir) === path.resolve(STATE, "thoughts", m[1])) { const l = S.thoughtsPids.get(m[1]) || []; l.push(k); S.thoughtsPids.set(m[1], l); }
        }
      } else warnings.push("daemon process not readable: Thoughts PIDs unknown");
    } else warnings.push("daemon pid unknown: Thoughts PIDs unknown");
    return S;
  }
  async function getSlow(t) {
    if (slow && t - slowAt < slowMs) return slow;
    if (!slowPending) slowPending = loadSlow(t).then((s) => { slow = s; slowAt = t; return s; }).finally(() => { slowPending = null; });
    return slowPending;
  }

  function thoughtsSession(room) {
    const dir = path.join(STATE, "thoughts", room); let best = null;
    try { for (const f of fs.readdirSync(dir)) if (f.endsWith(".jsonl")) { const st = statOf(path.join(dir, f)); if (st && (!best || st.mtimeMs > best.st.mtimeMs)) best = { file: path.join(dir, f), st }; } } catch { /* none */ }
    return best;
  }
  // Compactions in a Thoughts session, counted like the daemon does (lines starting {"type":"compaction"), incrementally.
  // Read in 1 MB chunks (never the whole file at once); only each line's first bytes are kept. A half-written last
  // line is not counted yet: the next read starts at its beginning.
  function countCompactions(file, st) {
    let c = thoughtsCompacts.get(file);
    if (!c || c.ino !== st.ino || st.size < c.end) c = { ino: st.ino, end: 0, count: 0 };
    const P = Buffer.from('{"type":"compaction"'), CH = 1024 * 1024;
    let pos = c.end, head = Buffer.alloc(0), count = c.count, end = c.end;
    while (pos < st.size) {
      const buf = readRange(file, pos, Math.min(st.size, pos + CH)); if (!buf.length) break;
      for (let i = 0; ;) {
        const j = buf.indexOf(10, i), seg = buf.subarray(i, j < 0 ? buf.length : j);
        if (head.length < P.length) head = Buffer.concat([head, seg.subarray(0, P.length - head.length)]);
        if (j < 0) break;
        if (head.equals(P)) count++;
        head = Buffer.alloc(0); end = pos + j + 1; i = j + 1;
      }
      pos += buf.length;
    }
    Object.assign(c, { count, end });
    thoughtsCompacts.set(file, c);
    return c.count;
  }
  function sessionStartOf(file) { try { const l = readRange(file, 0, 4096).toString("utf8").split("\n")[0]; const h = JSON.parse(l); return h?.type === "session" ? tsOf(h.timestamp) : NaN; } catch { return NaN; } }

  function contextFields(c) {
    const win = c.status === "measured" || c.status === "awaiting" ? catalog.window(c.provider, c.model) : null;
    const tokens = c.status === "measured" ? c.tokens : null;
    return {
      contextTokens: tokens, contextWindow: win, contextPercent: known(tokens) && known(win) && win > 0 ? Math.round((tokens / win) * 1000) / 10 : null,
      context: { ...c, window: win, windowSource: win ? "pi catalog (models-store.json / models.json), exact provider+model" : c.provider ? `no catalog entry for ${c.provider}/${c.model}` : "model unknown" },
    };
  }

  async function read() {
    const t = now(), warnings = [];
    let L;
    try { L = await request("list", {}); } catch (e) { return { timestampMs: t, agents: [], worlds: [], warnings: [`daemon not answering: ${e.message}`], priorityFormula: PRIORITY_FORMULA, authoritative: false }; } // J564: actions fail closed
    const S = await getSlow(t); warnings.push(...S.warnings);
    const A = S.activity, actWindow = A ? { sinceMs: A.since, source: "STATE/activity/<room>.jsonl kind restarted (only while the agent was in a room)" } : null;
    const orchById = new Map((S.orch || []).map((c) => [c.id, c]));
    const liveOrchKids = (parent) => (S.orch || []).filter((c) => c.parent === parent && c.status !== "closed").map((c) => c.id);
    const agents = [], rooms = L.rooms || [], remoteRooms = new Set(rooms.filter((r) => r.remote).map((r) => r.id));
    const sandboxed = new Map((L.thoughts || []).filter((x) => x.sandboxed).map((x) => [x.room, x.sandboxed]));
    const claimed = new Map(); // local root pid -> row id (a pid is one row's root only)
    const keepFiles = new Set();

    const common = (id, inputs, extra) => {
      const { priority, details } = scorePriority(inputs, t);
      return { ...extra, priority, priorityDetails: details };
    };
    const coordination = (id) => ({
      ownedProjects: S.boardsOk ? S.owned.get(id) || 0 : undefined,
      openDecides: S.boardsOk ? S.decides.get(id) || 0 : undefined,
      runningJobs: S.jobs ? (S.jobs.get(id) || []).length : undefined,
      pendingDemands: S.demands ? S.demands.get(id) || 0 : undefined,
    });
    const refreshesOf = (id) => (S.upkeep ? (S.upkeep.agents?.[id]?.history || []).filter((x) => known(x) && t - x <= WEEK).length : null);

    // 1. the daemon's live agents (host agents and sandbox placeholders)
    for (const a of L.agents || []) {
      const placeholder = /^sbx-/.test(a.id || "") && a.model === "sandboxed" && !a.address;
      const inRemote = remoteRooms.has(a.room);
      let pids = [], pidNote = "";
      if (inRemote) pidNote = "listed in a remote world: its pid belongs to another machine, never a laptop root";
      else if (a.host_pid > 0) pids = [a.host_pid];
      else if (a.container && !placeholder) pidNote = "container agent without a host pid: its pid is inside the container, not a laptop pid";
      else if (a.pid > 0) pids = [a.pid];
      pids = pids.filter((p) => { if (claimed.has(p)) { warnings.push(`${a.name || a.id}: pid ${p} is already ${claimed.get(p)}'s root (shared process; counted once)`); return false; } claimed.set(p, a.name || a.id); return true; });
      if (pidNote) warnings.push(`${a.name || a.id}: ${pidNote}`);
      let c = { status: "missing", tokens: null, reason: placeholder ? "sandbox placeholder: its agents' sessions are inside the sandbox" : "no session file known" };
      if (inRemote) c = { status: "unknown", tokens: null, reason: "remote world: its session is on another machine (a same-named laptop path is never read)" };
      else if (a.session && !placeholder) { keepFiles.add(a.session); c = ctx.read(a.session); }
      const kids = (a.children || []).filter((k) => k && k.status !== "closed").map((k) => k.id);
      const inProc = Array.isArray(a.helpers) ? a.helpers.length : 0;
      const oc = orchById.get(a.id), act = A?.by.get(a.id);
      const jobs = S.jobs?.get(a.id) || [];
      agents.push(common(a.id, {
        status: a.status, lastTurnAt: A ? act?.lastTurnAt ?? null : undefined, turnsLastHour: A ? act?.turnsLastHour || 0 : undefined,
        blocked: typeof a.status === "string" ? a.status === "blocked" : undefined, liveHelpers: kids.length + inProc, ...coordination(a.id),
      }, {
        kind: placeholder ? "sandbox" : "agent", id: a.id, name: a.name || a.display || a.id, world: a.room || "", status: a.status || "", model: a.model || "", topic: a.topic || "",
        job: jobs[0]?.id || oc?.job || "", jobs: jobs.map((j) => j.id), remote: inRemote, pids, envIds: inRemote ? [] : [a.id],
        helpers: kids.length + inProc, registeredHelpers: kids, inProcessHelpers: inProc,
        ...contextFields(c),
        // compactions / session_start / refresh_due are the daemon's own (J117); refresh_due is false while the count is unknown, kept as null
        compactions: a.compactions ?? null, sessionAgeSeconds: a.session_start > 0 ? Math.max(0, Math.round((t - a.session_start) / 1000)) : null, refreshDue: typeof a.refresh_due === "boolean" && a.compactions != null ? a.refresh_due : null,
        restarts: A ? (act?.restarts || []).filter((x) => x >= A.since).length : null, refreshes: refreshesOf(a.id),
        windows: { restarts: actWindow, refreshes: S.upkeep ? { sinceMs: t - WEEK, source: "STATE/upkeep.json agents[id].history (the daemon keeps 7 days)" } : null },
        budgetUsed: oc ? num(oc.used?.tokens) : null, budgetLimit: oc ? num(oc.budget?.tokens) : null,
        budget: oc ? { tokensUsed: num(oc.used?.tokens), tokensLimit: num(oc.budget?.tokens), minutesLimit: num(oc.budget?.minutes), startedAt: num(oc.started_at), parentId: oc.parent || "", orchStatus: oc.status || "" } : null,
        source: { pid: a.pid ?? null, host_pid: a.host_pid ?? null, container: a.container || "", session: a.session || "", compactions: a.compactions ?? null, session_start: a.session_start ?? null, refresh_due: a.refresh_due ?? null, since: a.since ?? null, active: a.active ?? null, parked: !!a.parked, parent_id: a.parent_id || "" },
      }));
    }
    // compactions of a Thoughts session are the daemon's count method; it doesn't list them, so refreshDue stays null
    // 2. Thoughts (local ones only: a remote or sandboxed world's Thoughts runs elsewhere)
    for (const th of L.thoughts || []) {
      const room = th.room; if (!room) continue;
      if (th.remote || th.sandboxed || remoteRooms.has(room)) continue;
      const pids0 = S.thoughtsPids.get(room) || [];
      if (!th.running && !pids0.length) continue;
      if (!th.running && pids0.length) warnings.push(`Thoughts-${room}: the daemon says not running, but its process ${pids0.join(",")} is still there (stopping?)`);
      const pids = pids0.filter((p) => !claimed.has(p)); for (const p of pids) claimed.set(p, th.name);
      const ses = thoughtsSession(room);
      let c = { status: "missing", tokens: null, reason: "no Thoughts session file" }, compactions = null, start = NaN;
      if (ses) { keepFiles.add(ses.file); c = ctx.read(ses.file); try { compactions = countCompactions(ses.file, ses.st); } catch { compactions = null; } start = sessionStartOf(ses.file); }
      let marker = null; try { marker = readJson(path.join(STATE, "thoughts", `${room}.model.json`)); } catch { /* none */ }
      const id = `thoughts:${room}`, kids = liveOrchKids(id);
      agents.push(common(id, { status: undefined, lastTurnAt: undefined, turnsLastHour: undefined, blocked: undefined, liveHelpers: S.orch ? kids.length : undefined, ...coordination(id) }, {
        kind: "thoughts", id, name: th.name || `Thoughts-${room}`, world: room, status: th.running ? "running" : "stopped", model: String(marker?.model || c.model || ""), topic: "",
        job: "", jobs: (S.jobs?.get(id) || []).map((j) => j.id), remote: false, pids, envIds: [],
        helpers: kids.length, registeredHelpers: kids, inProcessHelpers: 0,
        ...contextFields(c), compactions, sessionAgeSeconds: known(start) ? Math.max(0, Math.round((t - start) / 1000)) : null, refreshDue: null,
        restarts: null, refreshes: null, windows: { restarts: null, refreshes: null }, budgetUsed: null, budgetLimit: null, budget: null,
        source: { session: ses?.file || "", pidSource: S.thoughtsPidOk ? "daemon child with --session-id thoughts-<room>" : "unavailable" },
      }));
    }
    // 3. sandboxed / remote worlds: their agents from the laptop's mirror (worlds/world-<x>/agents.json, written by
    // the world's helper); none gets a laptop root pid. A remote world (H, I) runs on another machine: remote: true.
    // A sandbox (G) is local (remote: false) but its agents' processes live inside it. One pseudo-row per world holds
    // the laptop-side transport or windows (the mirror helper and the world's laptop windows), envWorld = the letter.
    const worlds = [];
    const letters = new Set([...remoteRooms, ...sandboxed.keys()]);
    let wdirs = []; try { wdirs = fs.readdirSync(path.join(STATE, "worlds")).filter((d) => /^world-[a-z]$/.test(d)); } catch { /* none */ }
    for (const d of wdirs) letters.add(d.slice(6).toUpperCase());
    for (const W of [...letters].sort()) {
      const wdir = path.join(STATE, "worlds", `world-${W.toLowerCase()}`), isRemote = remoteRooms.has(W), sbx = sandboxed.get(W) || "";
      if (!isRemote && !sbx) continue; // an old mirror of a world that is neither remote nor sandboxed now
      let mir = null; try { mir = readJson(path.join(wdir, "agents.json")); } catch { /* none */ }
      const mirAt = num(mir?.at), stale = !known(mirAt) || t - mirAt > mirrorStaleMs;
      if (!mir) warnings.push(`world ${W}: no laptop mirror (worlds/world-${W.toLowerCase()}/agents.json): its agents are unknown here`);
      else if (stale) warnings.push(`world ${W}: mirror is stale (${known(mirAt) ? Math.round((t - mirAt) / 1000) + " s old" : "no time"}): agent states may be out of date`);
      const mirrorAgents = Array.isArray(mir?.agents) ? mir.agents : [];
      for (const m of mirrorAgents) {
        if (!m || typeof m.name !== "string") continue;
        const mid = typeof m.id === "string" && m.id ? m.id : "", rid = `${isRemote ? "remote" : "sandbox"}:${W}:${mid || m.name}`;
        agents.push(common(rid, { status: typeof m.status === "string" ? m.status : undefined, lastTurnAt: undefined, turnsLastHour: undefined, blocked: typeof m.status === "string" ? m.status === "blocked" : undefined, liveHelpers: undefined }, {
          kind: isRemote ? "remote-agent" : "sandbox-agent", id: rid, name: m.name, world: W, status: String(m.status || ""), model: String(m.model || ""), topic: "", job: "", jobs: [],
          // a remote world's agents run on another machine; a sandbox's run locally inside it (no laptop roots, but its own id
          // when the mirror has one; the placeholders' ids belong to the relay rows)
          remote: isRemote, pids: [], envIds: !isRemote && mid ? [mid] : [],
          helpers: null, registeredHelpers: [], inProcessHelpers: null, contextTokens: null, contextWindow: null, contextPercent: null,
          context: { status: "unknown", tokens: null, reason: isRemote ? "remote world: its sessions are on another machine" : "sandboxed world: its sessions are inside the sandbox" },
          compactions: null, sessionAgeSeconds: null, refreshDue: null, restarts: null, refreshes: null, windows: { restarts: null, refreshes: null }, budgetUsed: null, budgetLimit: null, budget: null,
          source: { mirror: `worlds/world-${W.toLowerCase()}/agents.json`, mirrorAt: mirAt, stale, remoteId: typeof m.id === "string" ? m.id : "" },
        }));
      }
      // laptop-side transport roots: the mirror helper (status.pid, checked to be world-status.mjs for this world) and the
      // world's laptop windows from windows.json (rewritten only when the set changes, so its age says nothing). Each
      // window pid must still carry its launcher's marker: a remote world's window runs omnistation/remote-client.mjs
      // <LETTER> <name> (world-status.mjs windowAgent), a sandbox's is kitty --class=hyprpi.<letter>-… (world-helper.mjs).
      // A dead pid, or one reused by another program, fails the check.
      const tp = [];
      try { const p = Number(fs.readFileSync(path.join(wdir, "status.pid"), "utf8")) || 0; const argv = p ? cmdline(procRoot, p) : null; if (argv && argv.some((x) => x.endsWith("/world-status.mjs")) && argv.includes(W)) tp.push(p); } catch { /* none */ }
      let wj = null; try { wj = readJson(path.join(wdir, "windows.json")); } catch { /* none */ }
      for (const win of Object.values(wj?.windows || {})) {
        if (!Number.isInteger(win?.pid) || win.pid <= 0) continue;
        const argv = cmdline(procRoot, win.pid); if (!argv) continue;
        const ok = isRemote ? (() => { const i = argv.findIndex((x) => x.endsWith("/remote-client.mjs")); return i >= 0 && argv[i + 1] === W && (!win.name || argv[i + 2] === win.name); })()
          : argv.includes(`--class=hyprpi.${W.toLowerCase()}-agent`) || argv.some((x) => x.startsWith(`--class=hyprpi.${W.toLowerCase()}-`));
        if (ok) tp.push(win.pid); else warnings.push(`world ${W}: window pid ${win.pid} no longer carries its launcher's marker (gone or reused); not counted`);
      }
      const tpids = [...new Set(tp)].filter((p) => !claimed.has(p)); for (const p of tpids) claimed.set(p, `world ${W} transport`);
      const id = `env:${W}`;
      agents.push(common(id, {}, {
        kind: "world-transport", id, name: `world ${W} (laptop side)`, world: W, status: isRemote ? "remote" : "sandboxed", model: "", topic: isRemote ? "laptop clients/transport of a remote world" : "laptop windows of a sandboxed world",
        job: "", jobs: [], remote: isRemote, pids: tpids, envIds: [], envWorld: W,
        helpers: null, registeredHelpers: [], inProcessHelpers: null, contextTokens: null, contextWindow: null, contextPercent: null, context: { status: "unknown", tokens: null, reason: "not an agent" },
        compactions: null, sessionAgeSeconds: null, refreshDue: null, restarts: null, refreshes: null, windows: { restarts: null, refreshes: null }, budgetUsed: null, budgetLimit: null, budget: null,
        source: { mirror: mir ? `worlds/world-${W.toLowerCase()}/agents.json` : "", mirrorAt: mirAt ?? null },
      }));
      worlds.push({ id: W, remote: isRemote, sandboxed: sbx || null, mirrorAt: mirAt ?? null, mirrorStale: !!mir && stale, agentCount: mirrorAgents.length, thoughts: typeof mir?.thoughts === "string" ? mir.thoughts : null });
    }
    for (const r of rooms) if (!worlds.some((w) => w.id === r.id)) worlds.push({ id: r.id, remote: !!r.remote, sandboxed: sandboxed.get(r.id) || null, mirrorAt: null, mirrorStale: false, agentCount: (L.agents || []).filter((a) => a.room === r.id).length, thoughts: (L.thoughts || []).find((x) => x.room === r.id)?.running ? "running" : "off" });
    worlds.sort((a, b) => String(a.id).localeCompare(String(b.id), undefined, { numeric: true }));
    ctx.forget(keepFiles);
    for (const a of agents) if (a.contextWindow == null && a.context?.status === "measured") warnings.push(`${a.name}: context window unknown (${a.context.windowSource})`);
    return { timestampMs: t, agents, worlds, warnings: [...new Set(warnings)], priorityFormula: PRIORITY_FORMULA, cache: { ...ctx.stats } };
  }

  return { read, close() { /* nothing held open: every file read closes its descriptor */ } };
}
