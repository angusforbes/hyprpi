// Decisions (@hyprpi N68): everything waiting on Angus, as one list. Pure functions, shared by the
// projects panel's Decisions view (lib/tui/decisions-view.mjs), the daemon (agents' "🔧 decide:" posts
// and `ding` become Decide items) and, later, a decisions pop-up.
//
//   openDecisions(board, { live, agents, later }) → [{ p, it, waiting: { id, name, status } }]
//   parseDecision(text) → { question, options: [{ key, text }], recommend }
//   sameDecision(a, b) → true when two question texts are the same decision (for de-duplication)
//   isCatchAll(project) → a world's catch-all card for decisions with no project of their own
//
// Project names are unique across worlds, so each world's catch-all has its own name: workshop,
// inbox, inbox-<anything>, misc or general.
export const isCatchAll = (p) => p && p.status !== "archived" && /^(workshop|inbox(-[a-z0-9_-]+)?|misc|general)$/.test(p.name || "");

// Every open Decide item on this world's cards (archived projects and items left out), oldest
// first; items put off with "later" (keys "pid:h") go to the end, in the order they were put off.
export function openDecisions(board, { live = {}, agents = [], later = [] } = {}) {
  const out = [];
  for (const p of board?.projects || []) {
    if (p.status === "archived") continue;
    for (const it of p.items || []) {
      if (it.sec !== "decide" || it.archived) continue;
      const id = it.by?.id || "", a = agents.find((x) => x.id === id);
      out.push({ p, it, key: `${p.id}:${it.h}`,
        waiting: { id, name: board.names?.[id] || a?.display || it.by?.name || "?", status: live[id] || a?.status || "closed" } });
    }
  }
  // Unfiled (no card in this world to hold them; lib/board.mjs addUnfiled).
  const UNFILED = { id: "unfiled", name: "unfiled", icon: "📥", unfiled: true };
  for (const it of board?.unfiled || []) {
    const id = it.by?.id || "", a = agents.find((x) => x.id === id);
    out.push({ p: UNFILED, it, key: `unfiled:${it.h}`,
      waiting: { id, name: board.names?.[id] || a?.display || it.by?.name || "?", status: live[id] || a?.status || "closed" } });
  }
  out.sort((x, y) => (x.it.ts || 0) - (y.it.ts || 0));
  const rank = (k) => { const i = later.indexOf(k); return i < 0 ? -1 : i; };
  return out.sort((x, y) => rank(x.key) - rank(y.key));
}

// "Should X? a) this · b) that (recommended)" or one option per line ("a) …", "1. …", "- b: …"),
// with "recommend b" / "(recommended)" anywhere. Letters a…h or digits 1…8 (→ a…h).
const MARK = /(?:^|[\s(—–·;,:?])\(?(?:([a-h])\)|([1-8])[.)])(?=\s)/g;
const LINE = /^\s*(?:[-*•]\s*)?\(?([a-h]|[1-8])[).:]\s+(.+)$/;
const REC = /\b(?:I\s+)?recommend(?:ed|ation)?\b\s*(?:is\s*|:\s*|=\s*|option\s*)*\(?([a-h]|[1-8])\)?(?![\w])/i;
const REC_TAIL = /[\s.;,—–-]*\(?\s*(?:my\s+|I\s+)?recommend(?:ed|ation)?\b[\s\S]*$/i;
const toKey = (k) => /\d/.test(k) ? String.fromCharCode(96 + Number(k)) : k.toLowerCase();
export function parseDecision(raw) {
  let text = String(raw || "").replace(/^\s*🔧\s*/u, "").replace(/^\s*decide\s*:\s*/i, "").trim();
  let options = [];
  // One option per line.
  const lines = text.split("\n"), qLines = [];
  for (const l of lines) {
    const m = LINE.exec(l);
    if (m && toKey(m[1]) === String.fromCharCode(97 + options.length)) options.push({ key: toKey(m[1]), text: m[2].trim() });
    else if (!options.length) qLines.push(l);
    else if (l.trim()) options[options.length - 1].text += " " + l.trim();
  }
  let question = qLines.join("\n").trim();
  // Inline: "… a) this, b) that". The markers must run a, b, c… in order.
  if (options.length < 2) {
    options = [];
    const flat = text.replace(/\s*\n\s*/g, " ");
    const hits = [];
    for (const m of flat.matchAll(MARK)) { const k = m[1] || m[2]; if (toKey(k) === String.fromCharCode(97 + hits.length)) hits.push({ key: toKey(k), at: m.index + m[0].indexOf(k) - (m[0].includes("(") ? 1 : 0), end: m.index + m[0].length }); }
    if (hits.length >= 2) {
      question = flat.slice(0, hits[0].at).trim();
      options = hits.map((h, i) => ({ key: h.key, text: flat.slice(h.end, hits[i + 1]?.at ?? flat.length).trim() }));
    } else question = text;
  }
  // The recommendation: "(recommended)" on an option, else "recommend b" anywhere.
  let recommend = "";
  for (const o of options) if (/\(?\s*recommended\s*\)?/i.test(o.text) && !REC.test(o.text)) { recommend ||= o.key; }
  const rm = REC.exec(text);
  if (!recommend && rm && options.some((o) => o.key === toKey(rm[1]))) recommend = toKey(rm[1]);
  for (const o of options) o.text = o.text.replace(/\s*\(\s*recommended\s*\)/i, "").replace(REC_TAIL, "").replace(/[\s·;,]+(?:or\s*)?$/i, "").trim();
  if (rm && options.length) question = question.replace(REC_TAIL, "").trim();
  // Caps (Blink): the question 2000 characters, at most 8 options of 400 each.
  options = options.filter((o) => o.text).slice(0, 8).map((o) => ({ key: o.key, text: o.text.length > 400 ? o.text.slice(0, 399) + "…" : o.text }));
  if (recommend && !options.some((o) => o.key === recommend)) recommend = "";
  const q = question.replace(/[\s:—–-]+$/, "") || text;
  return { question: q.length > 2000 ? q.slice(0, 1999) + "…" : q, options, recommend };
}

const normQ = (s) => String(s || "").toLowerCase().replace(/^\s*🔧\s*/u, "").replace(/^\s*decide\s*:\s*/, "").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
export function sameDecision(a, b) {
  const x = normQ(a), y = normQ(b);
  if (!x || !y) return false;
  if (x === y) return true;
  const short = x.length < y.length ? x : y, long = short === x ? y : x;
  return short.length >= 24 && long.startsWith(short.slice(0, Math.max(24, Math.floor(short.length * 0.8))));
}
