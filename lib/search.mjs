// Search across the conversations of a room's agents (their Pi session files)
// plus the room's own log. Two modes:
//   keyword — case-insensitive exact phrase match, newest first
//   ai      — a small model reads recent entries (numbered) and returns the
//             ids of the ones that match the *meaning* of the query, with a
//             short reason. Ids, not quotes, so results map back exactly.
import fs from "node:fs";
import { spawn } from "node:child_process";

const cache = new Map(); // session path -> { mtimeMs, size, entries }
const MAX_ENTRY_CHARS = 4000;

function textOf(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter((b) => b && b.type === "text" && typeof b.text === "string").map((b) => b.text).join("\n");
}

// Entries of one Pi session: what Angus said, what the agent said, and the
// room/talk messages it received. Tool calls, tool results and thinking are
// left out (noise for "what did we talk about").
export function sessionEntries(file) {
  let st;
  try { st = fs.statSync(file); } catch { return []; }
  const hit = cache.get(file);
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.entries;
  const entries = [];
  let raw = "";
  try { raw = fs.readFileSync(file, "utf8"); } catch { return []; }
  for (const line of raw.split("\n")) {
    if (!line) continue;
    let e; try { e = JSON.parse(line); } catch { continue; }
    let role = null, text = "";
    if (e.type === "message" && e.message) {
      const r = e.message.role;
      if (r === "user") { role = "angus"; text = textOf(e.message.content); }
      else if (r === "assistant") { role = "agent"; text = textOf(e.message.content); }
    } else if (e.type === "custom_message" && e.display !== false) {
      const t = String(e.customType || "");
      role = t === "hyprpi-room" ? "room" : t.startsWith("hyprpi-talk") ? "talk" : null;
      text = typeof e.content === "string" ? e.content : textOf(e.content);
    }
    if (!role || !text.trim()) continue;
    entries.push({ eid: e.id, role, ts: Date.parse(e.timestamp) || 0, text: text.slice(0, MAX_ENTRY_CHARS) });
  }
  cache.set(file, { mtimeMs: st.mtimeMs, size: st.size, entries });
  return entries;
}

// sources: [{ key, name, icon, color, live, entries: [...] }]
export function keywordSearch(query, sources, { limit = 300, perSource = 60 } = {}) {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const out = [];
  for (const s of sources) {
    let n = 0;
    for (let i = s.entries.length - 1; i >= 0 && n < perSource; i--) {
      const e = s.entries[i];
      const lower = e.text.toLowerCase();
      const at = lower.indexOf(q);
      if (at < 0) continue;
      let count = 0; for (let j = at; j >= 0; j = lower.indexOf(q, j + q.length)) count++;
      out.push({ ...hitBase(s, e), ...snippet(e.text, at, q.length), count });
      n++;
    }
  }
  out.sort((a, b) => b.ts - a.ts);
  return out.slice(0, limit);
}

function hitBase(s, e) {
  return { source: s.key, name: s.name, icon: s.icon || "", color: s.color || "", live: !!s.live, kind: s.kind, id: `${s.key}:${e.eid}`, role: e.role, ts: e.ts };
}

function snippet(text, at, len, radius = 90) {
  const flat = text.replace(/\s+/g, " ");
  // Map the match offset onto the whitespace-collapsed text.
  const before = text.slice(0, at).replace(/\s+/g, " ");
  const a = before.length;
  const start = Math.max(0, a - radius);
  const end = Math.min(flat.length, a + len + radius);
  return {
    pre: (start > 0 ? "…" : "") + flat.slice(start, a),
    match: flat.slice(a, a + len),
    post: flat.slice(a + len, end) + (end < flat.length ? "…" : ""),
  };
}

// AI search: one small-model call over a slice of the room's history. Returns a short
// answer (when the query is a question the entries can answer; else "") plus the
// entries that match or support it, each jumpable like a keyword hit.
//
// sources: conversation sources ({ key, kind: "agent"|"room", name, entries }) and at
// most one activity source ({ kind: "activity", entries: [{ ..., agent: { id, name,
// icon, color, live } }] }). budget = characters the model reads; activityShare caps
// the activity source's part of it (see aiSearchChars / aiSearchActivityShare in
// lib/paths.mjs for why). Unused activity budget goes to the conversations.
const STOP = new Set("the a an and or but of to in on at for with from by is are was were be been it this that what who when where why how did does do we i you he she they them our my your about into than then there their which".split(" "));
const queryWords = (q) => [...new Set(String(q).toLowerCase().match(/[\p{L}\p{N}_.-]{3,}/gu) || [])].filter((w) => !STOP.has(w));

export async function aiSearch(query, sources, { model = "claude-haiku-4-5", budget = 110000, activityShare = 0.2, perEntry = 700, timeoutMs = 90000, pi = "pi" } = {}) {
  const share = Math.max(0, Math.min(1, Number.isFinite(Number(activityShare)) ? Number(activityShare) : 0.2));
  const convo = sources.filter((s) => s.kind !== "activity");
  const acts = sources.filter((s) => s.kind === "activity").flatMap((s) => s.entries.map((e) => ({ s, e })));
  const numbered = [];
  const line = (s, e) => {
    const who = s.kind === "activity" ? (e.agent?.name || "?") : s.name;
    const body = e.text.replace(/\s+/g, " ").slice(0, perEntry);
    return `[${numbered.length + 1}] ${who} · ${e.role} · ${new Date(e.ts).toISOString().slice(0, 16)}: ${body}`;
  };
  // 1. Activity, up to its cap: lines sharing words with the query first (newest
  //    first), then the newest of the rest.
  let used = 0;
  const actCap = Math.floor(budget * share);
  if (actCap > 0 && acts.length) {
    const ws = queryWords(query);
    const hits = (x) => ws.some((w) => x.e.text.toLowerCase().includes(w));
    const ordered = [...acts.filter(hits).reverse(), ...acts.filter((x) => !hits(x)).reverse()];
    for (const { s, e } of ordered) {
      const l = line(s, e);
      if (used + l.length > actCap) continue;
      numbered.push({ s, e, line: l });
      used += l.length + 1;
    }
  }
  const actChars = used;
  // 2. Conversations with the rest: newest first, round-robin across sources so one
  //    chatty agent cannot use up the whole budget.
  const queues = convo.map((s) => ({ s, i: s.entries.length - 1 }));
  let progress = true;
  while (progress && used < budget) {
    progress = false;
    for (const q of queues) {
      if (q.i < 0) continue;
      const e = q.s.entries[q.i--];
      const l = line(q.s, e);
      if (used + l.length > budget) { q.i = -1; continue; }
      numbered.push({ s: q.s, e, line: l });
      used += l.length + 1;
      progress = true;
    }
  }
  if (!numbered.length) return { results: [], scanned: 0, answer: "", activityChars: 0 };
  // Oldest first reads more naturally for the model.
  numbered.sort((x, y) => (x.e.ts || 0) - (y.e.ts || 0));
  numbered.forEach((n, k) => { n.line = n.line.replace(/^\[\d+\]/, `[${k + 1}]`); });
  const prompt =
    "You are the search engine for a room of AI coding agents. Below are numbered entries from the room's history: " +
    "their conversations (angus = a message from Angus, the human; agent = the agent's own reply; room/talk = messages it received) " +
    "and, with role \"activity\", things agents DID (tool calls, topics, joins/moves), not things they said.\n\n" +
    `Angus typed: ${query}\n\n` +
    "1. If that is a question the entries can answer, answer it in at most 4 short, plain sentences (no entry numbers). " +
    "If it is only a description of what he is looking for, or the entries cannot answer it, the answer is \"\".\n" +
    "2. Pick the entries that best match his words or support the answer, most relevant first, at most 20. " +
    "Concepts, paraphrases and related topics count, not just the same words. Skip anything irrelevant; an empty list is fine.\n" +
    'Reply with JSON only, exactly this shape: {"answer": "…", "hits": [{"id": 12, "why": "at most 12 words"}]}\n\n' +
    numbered.map((n) => n.line).join("\n");
  const raw = await runPi(prompt, { model, timeoutMs, pi });
  let out = null;
  const a = raw.indexOf("{"), b = raw.lastIndexOf("}");
  if (a >= 0 && b > a) { try { out = JSON.parse(raw.slice(a, b + 1)); } catch { out = null; } }
  if (!out || Array.isArray(out)) { // older shape: a bare list
    const la = raw.indexOf("["), lb = raw.lastIndexOf("]");
    if (la < 0 || lb <= la) throw new Error("AI reply had no JSON");
    try { out = { answer: "", hits: JSON.parse(raw.slice(la, lb + 1)) }; } catch { throw new Error("AI reply was not valid JSON"); }
  }
  const results = [];
  const seen = new Set();
  for (const p of Array.isArray(out.hits) ? out.hits : []) {
    const n = numbered[Number(p?.id) - 1];
    if (!n || seen.has(p.id)) continue;
    seen.add(p.id);
    const flat = n.e.text.replace(/\s+/g, " ");
    const base = n.s.kind === "activity"
      ? { source: n.e.agent?.id || "", name: n.e.agent?.name || "?", icon: n.e.agent?.icon || "", color: n.e.agent?.color || "", live: !!n.e.agent?.live, kind: "agent", id: `activity:${n.e.eid}`, role: "activity", ts: n.e.ts }
      : hitBase(n.s, n.e);
    results.push({ ...base, pre: "", match: "", post: flat.slice(0, 220) + (flat.length > 220 ? "…" : ""), why: String(p.why || "").slice(0, 160) });
  }
  const answer = String(out.answer || "").replace(/\s*\((?:entry|entries)\s[\d,\s–-]+\)/gi, "").trim().slice(0, 1200);
  return { results, scanned: numbered.length, answer, activityChars: actChars };
}

export function runPi(prompt, { model, timeoutMs, pi }) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    for (const k of Object.keys(env)) if (/^(HERDR_|HYPRPI_AGENT_ID|PI_SESSION)/.test(k)) delete env[k];
    const child = spawn(pi, ["-p", "--no-session", "--no-tools", "--no-extensions", "--no-skills", "--no-context-files",
      "--no-prompt-templates", "--thinking", "off", "--system-prompt", "You output only JSON. No prose, no code fences.", "--model", model],
      { env, stdio: ["pipe", "pipe", "pipe"] });
    let out = "", err = "";
    const t = setTimeout(() => { child.kill("SIGKILL"); reject(new Error(`the model timed out after ${timeoutMs / 1000}s`)); }, timeoutMs);
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { err += d; });
    child.on("error", (e) => { clearTimeout(t); reject(e); });
    child.on("close", (code) => {
      clearTimeout(t);
      if (code === 0) resolve(out);
      else reject(new Error(`the model call failed (${code}): ${err.trim().split("\n").slice(-2).join(" ").slice(0, 300)}`));
    });
    child.stdin.end(prompt);
  });
}
