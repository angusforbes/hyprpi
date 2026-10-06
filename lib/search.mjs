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
      role = t === "hyprpi-room" ? "room" : t.startsWith("hyprpi-talk") ? "talk" : t === "hyprpi-ignore" ? "angus" : null; // hyprpi-ignore: Angus's /ignore signposts (N52)
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
  return { source: s.key, name: s.name, icon: s.icon || "", color: s.color || "", live: !!s.live, kind: s.kind, id: `${s.key}:${e.eid}`, role: e.role, ts: e.ts, ...(s.link ? { link: s.link, archived: true } : {}) };
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
// What the model reads (budget = characters; see aiSearchChars / aiSearchActivityShare
// in lib/paths.mjs) is chosen from the WHOLE history, not just the newest entries:
//   1. Agents named in the query ("from Blink", "what did pi·vkrh do") come first:
//      their entries that share words with the query, then their newest entries.
//   2. Everyone else's entries that share words with the query, best first. Words are
//      weighted by rarity (IDF): "bindings.lua" counts far more than "now".
//   3. The newest entries, round-robin across sources, with whatever budget is left.
// A matching entry also brings the entry just before it (usually the question it
// answers). The activity stream is ranked the same way, within its own cap. Unused
// activity budget goes to the conversations.
const STOP = new Set(("the a an and or but of to in on at for with from by is are was were be been it this that what who when where why how did does do " +
  "we i you he she they them our my your about into than then there their which tell me all any show give list find please everything " +
  "conversation conversations talk talked said say says can could would should has have had just now today yesterday").split(" "));
const queryWords = (q) => [...new Set(String(q).toLowerCase().match(/[\p{L}\p{N}_.-]{3,}/gu) || [])].filter((w) => !STOP.has(w));
// "pi·vkrh" -> ["pi·vkrh", "pivkrh", "vkrh"]; "📊 Sankey[a]" -> ["sankey[a]", "sankey"].
function nameForms(name) {
  const n = String(name || "").toLowerCase().replace(/[^\p{L}\p{N}·._\[\]-]+/gu, " ").trim();
  if (!n) return [];
  const forms = new Set([n, n.replace(/·/g, ""), n.replace(/\[.*?\]/g, "").trim()]);
  const tail = n.match(/^pi·(\w{3,})$/); if (tail) forms.add(tail[1]);
  return [...forms].filter((f) => f.length >= 3);
}
const hasWord = (text, w) => new RegExp(`(^|[^\\p{L}\\p{N}_])${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|[^\\p{L}\\p{N}_])`, "u").test(text);

export async function aiSearch(query, sources, { model = "claude-haiku-4-5", budget = 110000, activityShare = 0.2, perEntry = 700, timeoutMs = 90000, pi = "pi" } = {}) {
  const share = Math.max(0, Math.min(1, Number.isFinite(Number(activityShare)) ? Number(activityShare) : 0.2));
  const convo = sources.filter((s) => s.kind !== "activity");
  const acts = sources.filter((s) => s.kind === "activity").flatMap((s) => s.entries.map((e) => ({ s, e })));
  const ql = String(query).toLowerCase();

  // Agents named in the query (by display name, or an agent id tail like "vkrh").
  const named = new Map(); // agent id/key -> display name
  const consider = (id, name) => { if (id && !named.has(id) && nameForms(name).some((f) => hasWord(ql, f))) named.set(id, name); };
  for (const src of convo) if (src.kind === "agent") consider(src.key, src.name);
  for (const { e } of acts) consider(e.agent?.id, e.agent?.name);
  const namedNames = [...new Set(named.values())];
  const nameTokens = new Set(namedNames.flatMap(nameForms).flatMap((f) => f.split(/\s+/)));
  const words = queryWords(query).filter((w) => !nameTokens.has(w));
  const isNamed = (s, e) => s.kind === "activity" ? named.has(e.agent?.id)
    : s.kind === "agent" ? named.has(s.key)
    : namedNames.some((n) => String(e.text).toLowerCase().startsWith(n.toLowerCase() + ":"));

  // Rarity weights over every entry (conversations + activity).
  const all = [...convo.flatMap((s) => s.entries.map((e, i) => ({ s, e, i }))), ...acts.map((x) => ({ ...x, i: -1 }))];
  for (const x of all) x.low = String(x.e.text).toLowerCase();
  const weight = {};
  for (const w of words) {
    const df = all.reduce((n, x) => n + (x.low.includes(w) ? 1 : 0), 0);
    weight[w] = Math.log(1 + all.length / (1 + df));
  }
  const score = (x) => words.reduce((t, w) => t + (x.low.includes(w) ? weight[w] : 0), 0);
  for (const x of all) x.score = score(x);

  const numbered = [], taken = new Set();
  let used = 0;
  const line = (s, e) => {
    const who = s.kind === "activity" ? (e.agent?.name || "?") : s.name;
    const body = e.text.replace(/\s+/g, " ").slice(0, perEntry);
    return `[0] ${who} · ${e.role} · ${new Date(e.ts).toISOString().slice(0, 16)}: ${body}`;
  };
  const take = (s, e, cap) => {
    const key = `${s.key}:${e.eid}`;
    if (taken.has(key)) return true;
    const l = line(s, e);
    if (used + l.length > cap) return false;
    taken.add(key); numbered.push({ s, e, line: l }); used += l.length + 1;
    return true;
  };
  const byScore = (xs) => xs.filter((x) => x.score > 0).sort((a, b) => b.score - a.score || b.e.ts - a.e.ts);
  const newest = (xs) => xs.slice().sort((a, b) => b.e.ts - a.e.ts);

  // Activity, up to its cap: named agents' matching lines, other matching lines, then
  // (named agents' newest, then everyone's newest).
  const actCap = Math.floor(budget * share);
  if (actCap > 0 && acts.length) {
    const ax = all.filter((x) => x.s.kind === "activity");
    const nm = ax.filter((x) => isNamed(x.s, x.e)), rest = ax.filter((x) => !isNamed(x.s, x.e));
    for (const x of [...byScore(nm), ...byScore(rest), ...newest(nm), ...newest(ax)]) if (used >= actCap - 40) break; else take(x.s, x.e, actCap);
  }
  const actChars = used;

  // Conversations: named agents' matches (+ the entry before each), their newest, other
  // matches (+ the entry before), then the newest of everything round-robin.
  const cx = all.filter((x) => x.s.kind !== "activity");
  const withPrev = (x) => { if (take(x.s, x.e, budget) && x.i > 0) take(x.s, x.s.entries[x.i - 1], budget); };
  const nm = cx.filter((x) => isNamed(x.s, x.e)), rest = cx.filter((x) => !isNamed(x.s, x.e));
  for (const x of byScore(nm)) { if (used >= budget - 40) break; withPrev(x); }
  for (const x of newest(nm).slice(0, 60)) { if (used >= budget - 40) break; take(x.s, x.e, budget); }
  for (const x of byScore(rest)) { if (used >= budget - 40) break; withPrev(x); }
  const queues = convo.map((s) => ({ s, i: s.entries.length - 1 }));
  let progress = true;
  while (progress && used < budget - 40) {
    progress = false;
    for (const q of queues) {
      if (q.i < 0) continue;
      const e = q.s.entries[q.i--];
      if (!take(q.s, e, budget)) { q.i = -1; continue; }
      progress = true;
    }
  }
  if (!numbered.length) return { results: [], scanned: 0, answer: "", activityChars: 0, named: namedNames };
  // Oldest first reads more naturally for the model.
  numbered.sort((x, y) => (x.e.ts || 0) - (y.e.ts || 0));
  numbered.forEach((n, k) => { n.line = n.line.replace(/^\[0\]/, `[${k + 1}]`); });
  const focus = namedNames.length
    ? `He is asking about ${namedNames.join(" and ")}. The name before "·" on each entry is whose conversation it is: only entries under ` +
      `${namedNames.map((x) => `"${x}"`).join(" or ")} are ${namedNames.length === 1 ? "that agent's" : "those agents'"}. Pick those first, and never ` +
      `credit another agent's entries to ${namedNames.join(" or ")}; mention other agents only if clearly relevant, by their own name.\n`
    : "";
  const now = new Date(), pad = (x) => String(x).padStart(2, "0");
  const today = `Now: ${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())} local ` +
    `(entry times are UTC; UTC offset ${-now.getTimezoneOffset() / 60}h). "Today" means entries from that local date.\n`;
  const prompt =
    "You are the search engine for a room of AI coding agents. Below are numbered entries from the room's history: " +
    "their conversations (angus = a message from Angus, the human; agent = the agent's own reply; room/talk = messages it received) " +
    "and, with role \"activity\", things agents DID (tool calls, topics, joins/moves), not things they said.\n\n" +
    today + `Angus typed: ${query}\n` + focus + "\n" +
    "1. If he asks a question, or asks you to tell / summarise / list something, answer from the entries in at most 6 short, plain sentences " +
    "(for a history: in time order; times in local time; no entry numbers). If the entries only touch on it in passing, say exactly that " +
    "(e.g. \"X only mentioned it in passing: …\") rather than giving no answer. If it is only a description of what he is looking for, the answer is \"\".\n" +
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
  return { results, scanned: numbered.length, answer, activityChars: actChars, named: namedNames };
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
    child.stdin.on("error", () => {}); // a pi that exits before reading stdin: EPIPE must not crash the daemon (Sankey)
    child.stdin.end(prompt);
  });
}
