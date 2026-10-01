// Briefs: structured, versioned hand-offs from a world's Thoughts agent to an agent (Angus, 2026-10-01:
// "spec out what it would look like" → "implement that"). One record per job, stored as data, shown to
// the agent as readable text:
//   id (J<n>) · version · project / card item · agent · from · state
//   angus      his words, verbatim (always shown next to the summary)
//   goal       one sentence · context (prose) · limits · ask_first · done_when (checks that count as proof)
// States: running · stopped (a state change, not a message) · cancelled · done (the report answered
// every done-when line) · verified (a second agent or Angus confirmed the proof; set with verify_work).
// A new version supersedes the old one: the daemon stops the old run through cancel_work's mechanism
// and delivers the new version with the changed lines marked (+ / −); versions only go up.
// Reports: changed · proof (W1 → result, … one per done-when line) · undo · surprises · open.
// When NOT to use a brief: questions, exploring ideas, quick replies inside a job, urgent one-liners
// (stop / continue are state changes), taste requests until "done" can be stated.
import fs from "node:fs";

export const FIELDS = ["angus", "goal", "context", "limits", "ask_first", "done_when"];
export const STATES = ["running", "stopped", "cancelled", "done", "verified"];
const LABEL = { angus: "Angus (his words)", goal: "Goal", context: "Context", limits: "Limits", ask_first: "Ask first", done_when: "Done when" };

const clean = (v) => String(v ?? "").replace(/\r/g, "").trim();
const asList = (v) => (Array.isArray(v) ? v : String(v ?? "").split(/\n+/)).map((x) => clean(x).replace(/^[-*•\d.)\s]+/, "").trim()).filter(Boolean);

// The brief's fields from give_work / revise_work parameters (missing ones keep `base`).
export function fieldsFrom(p, base = {}) {
  const f = { ...base };
  for (const k of FIELDS) if (p[k] !== undefined) f[k] = k === "done_when" ? asList(p[k]) : clean(p[k]);
  if (!f.goal && p.task) f.goal = clean(p.task).split(/(?<=[.!?])\s|\n/)[0].slice(0, 300); // a plain task: its first sentence
  if (!f.context && p.task && clean(p.task) !== f.goal) f.context = clean(p.task);
  f.done_when = f.done_when || [];
  return f;
}

// Lines of a brief's body, one field per line (done-when: one line each, labelled W1, W2, …).
function bodyLines(f) {
  const out = [];
  for (const k of FIELDS) {
    if (k === "done_when") { if ((f.done_when || []).length) out.push(`${LABEL.done_when}:`); (f.done_when || []).forEach((w, i) => out.push(`  W${i + 1} ${w}`)); continue; }
    if (f[k]) out.push(`${LABEL[k]}: ${k === "angus" ? `"${f[k]}"` : f[k]}`);
  }
  return out;
}

// The text an agent gets. prev: the previous version's fields → changed lines marked + / −.
export function render(b, { prev = null, note = "" } = {}) {
  const f = b.fields, now = bodyLines(f);
  const head = `[hyprpi brief ${b.id} v${b.version}${b.project ? ` · @${b.project}${b.item ? " " + b.item : ""}` : ""} · from ${b.from} · state ${b.state}]`;
  let body;
  if (prev) {
    const before = bodyLines(prev), setB = new Set(before), setN = new Set(now);
    body = [`This REPLACES v${b.version - 1} of ${b.id}${note ? ` (${note})` : ""}. Changed lines are marked + (new) / − (gone); the rest is as before.`, ""];
    for (const l of before) if (!setN.has(l)) body.push(`− ${l}`);
    for (const l of now) body.push(`${setB.has(l) ? "  " : "+ "}${l}`);
  } else body = now.map((l) => l);
  const dw = (f.done_when || []).length;
  return [head, ...body,
    "",
    dw ? `Your report must answer every W line above ("W1 → result", …), or the job can't be marked done.` : "No done-when checks were given: say in your report how you checked it.",
    "When it's done (or if you're stuck or need a decision), reply with talk_reply in this shape:",
    "  changed: what you changed (files, commit)",
    `  proof: ${dw ? (f.done_when.map((_, i) => `W${i + 1} → result`).join(" · ")) : "how you checked it"}`,
    "  undo: how to undo it",
    "  surprises: anything that contradicts this brief (its own field, even if none)",
    "  open: what's left",
  ].join("\n");
}

// Does a report answer every done-when line? A line counts when written "Wn → result" (also ->, :, =,
// —, –, ✓, ✔; markdown stripped first, since models bold a lot), and the result isn't a NEGATIVE word
// on its own ("not done (yet)", "failed", "no", "todo", "open", "skipped", "n/a", ✗), so "no errors in
// the log" or "open /tmp/x shows TWO" still count. A ✓ / ✔ separator counts as done. Rule by pi·wpzt
// (its N63 retest, 25 cases: /tmp/n63/check_report_alt.mjs). → { ok, missing: ["W2", …] }
export function checkReport(b, text) {
  const t = String(text || "").replace(/[*_`]+/g, ""), missing = [];
  (b.fields.done_when || []).forEach((_, i) => {
    const m = new RegExp(`\\bW${i + 1}\\s*(→|->|:|=|—|–|✓|✔)\\s*([^\\n·;]*)`).exec(t);
    const res = m ? m[2].trim() : "";
    const ok = m && (/[✓✔]/.test(m[1]) || (res && !/^(not(\s+yet)?(\s+(done|met|checked|tested|run))?(\s+yet)?|fail(ed|s)?|no|todo|open|skipped|n\/a|✗|❌)\s*($|[.,:;!(—–-])/i.test(res)));
    if (!ok) missing.push(`W${i + 1}`);
  });
  return { ok: !missing.length, missing };
}

// The card item's text: the brief's id, version and state in front of its goal.
export const cardText = (b) => `⟦${b.id} v${b.version} · ${b.state}⟧ ${b.fields.goal || ""}${b.agent_name ? ` (${b.agent_name})` : ""}`.slice(0, 600);

// A small store: state/briefs.json { next, briefs: { J1: {…} } }.
export function createBriefs(file) {
  let db = { next: 1, briefs: {} };
  try { db = JSON.parse(fs.readFileSync(file, "utf8")) || db; } catch { /* new */ }
  const save = () => { fs.writeFileSync(file + ".tmp", JSON.stringify(db)); fs.renameSync(file + ".tmp", file); };
  return {
    create(rec) {
      const id = `J${db.next++}`, now = Date.now();
      const b = { id, version: 1, state: "running", created: now, updated: now, history: [], ...rec };
      b.history.push({ version: 1, state: "running", ts: now, fields: b.fields });
      db.briefs[id] = b; save(); return b;
    },
    get: (id) => db.briefs[String(id || "").toUpperCase().replace(/^([^J])/, "J$1")] || null,
    all: () => Object.values(db.briefs),
    // A new version: returns { b, prev } (prev = the old fields). Only goes up.
    revise(id, fields, by = "") {
      const b = this.get(id); if (!b) throw new Error(`no job ${id}`);
      if (b.state === "cancelled" || b.state === "verified") throw new Error(`${b.id} is ${b.state}; give new work instead`);
      const prev = b.fields; b.version += 1; b.fields = fields; b.state = "running"; b.updated = Date.now(); b.report = null;
      b.history.push({ version: b.version, state: "running", ts: b.updated, fields, by }); save(); return { b, prev };
    },
    setState(id, state, extra = {}) {
      const b = this.get(id); if (!b) throw new Error(`no job ${id}`);
      if (!STATES.includes(state)) throw new Error(`state: ${STATES.join(", ")}`);
      Object.assign(b, extra, { state, updated: Date.now() });
      b.history.push({ version: b.version, state, ts: b.updated, ...(extra.note ? { note: extra.note } : {}) }); save(); return b;
    },
    save,
  };
}
