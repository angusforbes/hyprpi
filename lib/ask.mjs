// One-shot "/ask": answer a question about a room from its history, with citations.
// No memory, no tools: one small-model call (the search model, default claude-haiku-4-5)
// over numbered entries from the room's agents' conversations, the room log and the
// room's activity stream. For real questions, ask a Pi agent.
import { runPi } from "./search.mjs";

const STOP = new Set("the a an and or but of to in on at for with from by is are was were be been it this that what who when where why how did does do we i you he she they them our my your about into than then there their which".split(" "));
const words = (q) => [...new Set(String(q).toLowerCase().match(/[\p{L}\p{N}_.-]{3,}/gu) || [])].filter((w) => !STOP.has(w));

// Activity events -> a search "source" (same entry shape as sessionEntries()).
export function activitySource(events) {
  return {
    key: "activity", name: "activity", kind: "activity", live: true,
    entries: (events || []).filter((e) => e.kind !== "done").map((e, i) => ({
      eid: `a${i}`, role: e.kind, ts: e.ts, text: `${e.agent?.name || "?"}: ${e.kind === "topic" ? "topic: " : ""}${e.text}`,
    })),
  };
}

// Pick entries for the prompt: ones sharing words with the question first (newest first),
// then recent entries round-robin across sources, within a character budget.
export function pickEntries(question, sources, { budget = 60000, perEntry = 600 } = {}) {
  const ws = words(question);
  const picked = [], seen = new Set();
  let used = 0;
  const add = (s, e) => {
    const id = `${s.key}:${e.eid}`;
    if (seen.has(id)) return true;
    const body = String(e.text).replace(/\s+/g, " ").slice(0, perEntry);
    const d = new Date(e.ts), hm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
    const day = `${d.getMonth() + 1}/${d.getDate()}`;
    // Say whose conversation it is and which way it went, so the model can't flip sender and receiver.
    const who = s.kind === "activity" ? "activity"
      : s.kind === "room" ? `${s.name} log`
      : e.role === "angus" ? `Angus → ${s.name}`
      : e.role === "agent" ? `${s.name} (its own reply)`
      : e.role === "talk" ? `message received by ${s.name}`
      : e.role === "room" ? `room message received by ${s.name}` : `${s.name} · ${e.role}`;
    const line = `${day} ${hm} · ${who}: ${body}`;
    if (used + line.length > budget) return false;
    seen.add(id); picked.push({ s, e, line }); used += line.length + 8;
    return true;
  };
  if (ws.length) {
    const hits = [];
    for (const s of sources) for (const e of s.entries) {
      const t = String(e.text).toLowerCase();
      const n = ws.reduce((k, w) => k + (t.includes(w) ? 1 : 0), 0);
      // Angus's own words carry the decisions: rank them a little higher.
      if (n) hits.push({ s, e, n: n + (e.role === "angus" ? 1.5 : 0) });
    }
    hits.sort((a, b) => b.n - a.n || b.e.ts - a.e.ts);
    for (const h of hits.slice(0, 300)) if (!add(h.s, h.e) || used > budget * 0.7) break;
  }
  const queues = sources.map((s) => ({ s, i: s.entries.length - 1 }));
  let progress = true;
  while (progress && used < budget) {
    progress = false;
    for (const q of queues) if (q.i >= 0 && add(q.s, q.s.entries[q.i--])) progress = true;
  }
  picked.sort((a, b) => a.e.ts - b.e.ts); // oldest first reads like a timeline
  return picked;
}

export async function askRoom(question, sources, { model = "claude-haiku-4-5", pi = "pi", timeoutMs = 90000, budget } = {}) {
  const q = String(question || "").trim();
  if (!q) throw new Error("no question");
  const picked = pickEntries(q, sources, { budget });
  if (!picked.length) return { answer: "There is nothing in this room's history yet.", citations: [], model };
  const prompt =
    "You answer questions about a room of AI coding agents on Angus's machine, using ONLY the numbered " +
    "entries below (local times). Entry labels: \"Angus → X\" = Angus wrote to agent X; \"X (its own reply)\" = " +
    "agent X wrote it; \"message received by X\" = another agent's message delivered TO X (the sender is " +
    "named inside the text, e.g. \"from Y\" or \"reply from Y\"); \"Room C log\" = the shared room; " +
    "\"activity\" = what agents did (\"Name: what\"). Keep sender and receiver straight.\n\n" +
    `Question from Angus: ${q}\n\n` +
    "Answer in at most 3 short sentences. Read the question the way Angus means it (his words are " +
    "informal): answer from the closest relevant entries, naming who said or did what, and when if it " +
    "matters. Only if nothing relevant is there, say so plainly instead of guessing. Don't mention entry numbers.\n" +
    'Reply with JSON only, exactly this shape: {"answer": "…", "cite": [12, 40]} (cite: the ids you relied on, at most 6).\n\n' +
    picked.map((p, i) => `[${i + 1}] ${p.line}`).join("\n");
  const raw = await runPi(prompt, { model, timeoutMs, pi });
  const a = raw.indexOf("{"), b = raw.lastIndexOf("}");
  let out;
  try { out = JSON.parse(raw.slice(a, b + 1)); } catch { throw new Error("the answer was not valid JSON"); }
  const citations = [];
  for (const id of Array.isArray(out.cite) ? out.cite.slice(0, 6) : []) {
    const p = picked[Number(id) - 1];
    if (!p) continue;
    const flat = String(p.e.text).replace(/\s+/g, " ");
    citations.push({
      kind: p.s.kind === "room" ? "msg" : p.s.kind === "activity" ? "activity" : "agent",
      who: p.s.kind === "activity" ? flat.split(":")[0] : p.s.name,
      ts: p.e.ts,
      text: flat.length > 220 ? flat.slice(0, 219) + "…" : flat,
    });
  }
  // Entry numbers mean nothing to the reader: drop "(entry 81)", "(entries 3, 5)", "entry 12".
  const answer = String(out.answer || "").replace(/\s*\((?:entry|entries)\s[\d,\s–-]+\)/gi, "").replace(/\b(?:entry|entries)\s\d+(?:[,–-]\s?\d+)*\b/gi, "that").trim();
  return { answer: answer || "(no answer)", citations, model };
}
