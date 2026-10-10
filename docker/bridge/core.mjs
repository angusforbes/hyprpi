// The Doorman bridge's rules (J371): how a host agent (Claude Code, Codex, pi, a script) works a job the owner
// approved. Pure functions over one job record; the relay is the only writer of records, so it applies these one
// at a time (claims are atomic because one process applies them in order). Generic: no harness names.
//
// A job record (STATE/requests/<id>.json), type "host_job":
//   { id, type, sandbox, for, created_at, state, approved: { action, tools, folders, time_limit_s },
//     claim: { by, token, since, until } | null, claimed_at, questions: [{ n, text, at, held_id, answer, answered_at }],
//     outcome: { state, summary, ran, changed, at, by } | null, history: [{ at, ev, by }] }
// "approved" is the owner's approved (possibly edited) text and limits, never the sandbox's own words.
// States: waiting → claimed → (asked → claimed) → done | failed | partial; claimed past its lease → waiting again
// ("abandoned" in history), or no_report when the job's time limit is used up. Final: done, failed, partial, no_report.
//
// The bridge can claim, renew, release, show, ask and report. It can't create, approve, deny or edit a job: the
// operations below are the only ones, and the owner's decisions only arrive through the relay's decision files.
import crypto from "node:crypto";

export const FINAL = new Set(["done", "failed", "partial", "no_report"]);
export const OPS = new Set(["claim", "renew", "release", "ask", "report"]);
export const LIMITS = { leaseS: 1800, minLeaseS: 60, timeLimitS: 4 * 3600, askBytes: 1500, summaryBytes: 3000, items: 50, itemBytes: 500, by: 60, questions: 10 };
const ID_RE = /^[A-Za-z0-9._-]{1,80}--[0-9a-f]{6}$/;
export const validId = (id) => ID_RE.test(String(id || ""));
const iso = (ms) => new Date(ms).toISOString();
// plain, one-line-ish text: control and format characters out (they could hide things from the owner), capped
export function cleanText(s, max) {
  const t = String(s ?? "").replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]|\p{Cf}/gu, "").trim();
  return Buffer.byteLength(t) > max ? null : t;
}
const cleanList = (a) => {
  if (a == null) return [];
  if (!Array.isArray(a) || a.length > LIMITS.items) return null;
  const out = []; for (const x of a) { const c = cleanText(x, LIMITS.itemBytes); if (c == null) return null; if (c) out.push(c.replace(/\s+/g, " ")); }
  return out;
};

// A new job, made by the relay when the owner approves a free-form draft on a host in bridge mode.
export function newJob({ id, sandbox, asker, action, tools = [], folders = [], timeLimitS = LIMITS.timeLimitS, nowMs = Date.now() }) {
  return {
    id, type: "host_job", sandbox: String(sandbox), for: String(asker || ""), created_at: iso(nowMs), state: "waiting",
    approved: { action: String(action), tools: [...tools].map(String), folders: [...folders].map(String), time_limit_s: Math.max(LIMITS.minLeaseS, Number(timeLimitS) || LIMITS.timeLimitS) },
    claim: null, claimed_at: null, questions: [], outcome: null,
    history: [{ at: iso(nowMs), ev: "approved by the owner; waiting for a host agent", by: "owner" }],
  };
}

// What a host agent may see of a job: the approved text and limits, its questions and answers, the state. Nothing else.
export function view(rec, nowMs = Date.now()) {
  const v = sweepView(rec, nowMs);
  return {
    id: v.id, sandbox: v.sandbox, for: v.for, state: v.state, created_at: v.created_at,
    approved: v.approved, claimed_by: v.claim?.by || null, lease_until: v.claim?.until || null,
    questions: (v.questions || []).map((q) => ({ n: q.n, text: q.text, at: q.at, answer: q.answer ?? null, answered_at: q.answered_at ?? null })),
    outcome: v.outcome || null,
  };
}
const sweepView = (rec, nowMs) => { const s = sweep(rec, nowMs); return s ? { ...rec, ...s.patch } : rec; };

// A lease that ran out: the job goes back to waiting ("abandoned"), or ends as no_report once its time limit (counted
// from the first claim) is used up. A job waiting for the owner's answer (asked) doesn't expire. → { patch, history, effects } | null
export function sweep(rec, nowMs = Date.now()) {
  if (rec?.type !== "host_job" || rec.state !== "claimed" || !rec.claim) return null;
  if (Date.parse(rec.claim.until) > nowMs) return null;
  const limitEnd = Date.parse(rec.claimed_at || rec.claim.since) + rec.approved.time_limit_s * 1000;
  if (nowMs >= limitEnd) {
    const summary = `no report: ${rec.claim.by} claimed it and its time limit (${rec.approved.time_limit_s} s) ran out without a report`;
    return { patch: { state: "no_report", claim: null, outcome: { state: "no_report", summary, ran: [], changed: [], at: iso(nowMs), by: "relay" } },
      history: [{ at: iso(nowMs), ev: "no report before the time limit", by: "relay" }], effects: [{ kind: "outcome", state: "no_report", summary }] };
  }
  return { patch: { state: "waiting", claim: null }, history: [{ at: iso(nowMs), ev: `abandoned by ${rec.claim.by} (lease ran out); waiting again`, by: "relay" }], effects: [] };
}

// One bridge operation. op = { op, by, token?, lease_s?, state?, summary?, ran?, changed?, text? }.
// → { reply: { ok, text, ... }, patch?, history?, effects? }  (no patch = nothing changes)
export function apply(rec, op, nowMs = Date.now()) {
  const no = (text) => ({ reply: { ok: false, text } });
  if (!op || !OPS.has(op.op)) return no(`unknown operation ${JSON.stringify(op?.op)}: the bridge can only claim, renew, release, ask and report (it can't create, approve, deny or edit jobs)`);
  if (!rec || rec.type !== "host_job") return no("no such host job");
  const by = cleanText(op.by || "host agent", LIMITS.by)?.replace(/\s+/g, " ") || null;
  if (!by) return no("bad agent name");
  const s = sweep(rec, nowMs); const cur = s ? { ...rec, ...s.patch } : rec; // a lapsed lease first
  const pre = s ? { patch: s.patch, history: s.history, effects: s.effects } : { patch: {}, history: [], effects: [] };
  const done = (patch, ev, reply, effects = []) => ({ reply: { ok: true, ...reply }, patch: { ...pre.patch, ...patch }, history: [...pre.history, { at: iso(nowMs), ev, by }], effects: [...pre.effects, ...effects] });
  if (FINAL.has(cur.state)) return { ...no(`the job is already ${cur.state}`), ...(s ? { patch: pre.patch, history: pre.history, effects: pre.effects } : {}) };
  const leaseS = Math.min(Math.max(Number(op.lease_s) || LIMITS.leaseS, LIMITS.minLeaseS), cur.approved.time_limit_s);
  if (op.op === "claim") {
    if (cur.state !== "waiting") return no(`the job is ${cur.state} by ${cur.claim?.by || "another agent"} (lease until ${cur.claim?.until || "?"})`);
    const token = crypto.randomBytes(16).toString("hex"), first = cur.claimed_at || iso(nowMs);
    const end = Math.min(nowMs + leaseS * 1000, Date.parse(first) + cur.approved.time_limit_s * 1000);
    return done({ state: "claimed", claim: { by, token, since: iso(nowMs), until: iso(end) }, claimed_at: first }, `claimed by ${by}`, { text: `claimed until ${iso(end)}`, token, until: iso(end) });
  }
  if (!cur.claim || op.token !== cur.claim.token) return no("not your claim (wrong or expired token): claim the job first");
  if (op.op === "renew") {
    const end = Math.min(nowMs + leaseS * 1000, Date.parse(cur.claimed_at) + cur.approved.time_limit_s * 1000);
    if (end <= nowMs) return no("the job's time limit is used up: report what you have");
    return done({ claim: { ...cur.claim, until: iso(end) } }, "lease renewed", { text: `renewed until ${iso(end)}`, until: iso(end) });
  }
  // (a released job with an open question stays "asked", unclaimed, until the owner answers; then it's waiting again)
  if (op.op === "release") return cur.state === "asked" ? done({ claim: null }, `released by ${by} (its question still waits for the owner)`, { text: "released; it waits for the owner's answer, then for a host agent" })
    : done({ state: "waiting", claim: null }, `released by ${by}`, { text: "released; the job is waiting again" });
  if (op.op === "ask") {
    if (cur.state === "asked") return no("a question is already waiting for the owner's answer");
    if ((cur.questions || []).length >= LIMITS.questions) return no(`at most ${LIMITS.questions} questions per job`);
    const text = cleanText(op.text, LIMITS.askBytes); if (!text) return no(`the question is empty or longer than ${LIMITS.askBytes} bytes`);
    const n = (cur.questions || []).length + 1;
    return done({ state: "asked", questions: [...(cur.questions || []), { n, text, at: iso(nowMs), held_id: null, answer: null, answered_at: null }] },
      `asked the owner (question ${n})`, { text: `question ${n} is with the owner; the job waits (check with show)`, n }, [{ kind: "hold", n, text }]);
  }
  // report
  if (!["done", "failed", "partial"].includes(op.state)) return no("report state must be done, failed or partial");
  const summary = cleanText(op.summary, LIMITS.summaryBytes); if (!summary) return no(`a summary is required (up to ${LIMITS.summaryBytes} bytes)`);
  const ran = cleanList(op.ran), changed = cleanList(op.changed);
  if (!ran || !changed) return no(`ran/changed: lists of at most ${LIMITS.items} lines of ${LIMITS.itemBytes} bytes`);
  return done({ state: op.state, claim: null, outcome: { state: op.state, summary, ran, changed, at: iso(nowMs), by } }, `reported ${op.state}`,
    { text: `reported ${op.state}; the asker, its coordinator and the Doorman archive are told` }, [{ kind: "outcome", state: op.state, summary, ran, changed }]);
}

// The owner's answer to question n (from the relay's decision on the held question). → { patch, history } | null
export function answer(rec, n, text, nowMs = Date.now()) {
  if (rec?.type !== "host_job") return null;
  const qs = (rec.questions || []).map((q) => (q.n === n && q.answer == null ? { ...q, answer: String(text), answered_at: iso(nowMs) } : q));
  if (!qs.some((q, i) => q !== (rec.questions || [])[i])) return null;
  const back = rec.state === "asked" ? (rec.claim && Date.parse(rec.claim.until) > nowMs ? "claimed" : rec.claim ? "claimed" : "waiting") : rec.state;
  // the agent that asked keeps its claim; its lease restarts so it has time to pick the answer up
  const claim = rec.claim && back === "claimed" ? { ...rec.claim, until: iso(Math.min(nowMs + LIMITS.leaseS * 1000, Date.parse(rec.claimed_at) + rec.approved.time_limit_s * 1000 + LIMITS.leaseS * 1000)) } : rec.claim;
  return { patch: { state: back, questions: qs, claim }, history: [{ at: iso(nowMs), ev: `the owner answered question ${n}`, by: "owner" }] };
}
