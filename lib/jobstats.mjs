// J454 (Angus "1 y", Knock's J451 proposals 1–9): per-job records the job scoreboard (Knock's
// ~/.local/bin/job-scoreboard) reads to compare models, and split vs single-agent work, fairly.
// Recording only: nothing here changes how a job runs or is routed. Stored on the brief as b.stats
// (briefs.json), every list capped so the file stays small:
//   models    [{ at, event: briefed|started|set_model|escalated|model|thinking|revised|done|reopened, model, thinking, note? }]  (1)
//   tokens    fresh tokens (input + output + cache writes) of the job's agent while the job ran (shared equally
//             between its running jobs); helper_tokens: its spawned helpers' tokens                  (3)
//   active_ms the job's agent working (a turn running) while the job ran; elapsed_ms / waiting_ms at done (4)
//   msgs      { n, bytes } talk / demand / ask_agent messages to or from the job's agent while it ran (8)
//   verdicts  [{ at, by, verdict: pass|fail, cause?, note? }] from verify_work                        (9)
//   reopens   [{ at, version, cause?, by, reason? }] revise_work and failed checks                    (7)
// On the brief itself: b.coupling = { value: independent|sequential|mixed|single, by, at }            (6)
// Spawned helpers carry the job they help in orch.json (child.parentJob, filled from the caller's running job;
// child.job only when the spawner gives one, since that makes the child's final report a check), (2); Agent-tool subagents per turn are in codemode-trial's turns.jsonl (5).
export const COUPLING = ["independent", "sequential", "mixed", "single"];
export const CAUSES = ["spec", "misalignment", "verification", "other"];
const CAP = 20;

export function stats(b) {
  if (!b.stats) b.stats = { models: [], tokens: 0, active_ms: 0, msgs: { n: 0, bytes: 0 }, verdicts: [], reopens: [] };
  return b.stats;
}
const push = (list, x) => { list.push(x); if (list.length > CAP) list.splice(0, list.length - CAP); };

export function recordModel(b, event, model = "", thinking = "", note = "") {
  push(stats(b).models, { at: Date.now(), event, model: String(model || ""), thinking: String(thinking || ""), ...(note ? { note: String(note).slice(0, 160) } : {}) });
}
export function addTokens(b, n) { const s = stats(b); s.tokens = Math.round((s.tokens || 0) + Math.max(0, Number(n) || 0)); }
export function addActive(b, ms) { const s = stats(b); s.active_ms = (s.active_ms || 0) + Math.max(0, Math.round(ms)); }
export function addMsg(b, bytes) { const s = stats(b); s.msgs = s.msgs || { n: 0, bytes: 0 }; s.msgs.n++; s.msgs.bytes += Math.max(0, bytes | 0); }
export function recordVerdict(b, v) {
  push(stats(b).verdicts, { at: Date.now(), by: String(v.by || ""), verdict: v.verdict === "fail" ? "fail" : "pass", ...(v.cause ? { cause: v.cause } : {}), ...(v.note ? { note: String(v.note).slice(0, 300) } : {}) });
}
export function recordReopen(b, r) {
  push(stats(b).reopens, { at: Date.now(), version: b.version, by: String(r.by || ""), ...(r.cause ? { cause: r.cause } : {}), ...(r.reason ? { reason: String(r.reason).slice(0, 300) } : {}) });
}
// done: how long the job took and how much of it its agent was working (the rest: waiting on others, idle).
export function closeTimes(b, now = Date.now()) {
  const s = stats(b); s.elapsed_ms = Math.max(0, now - (b.created || now)); s.waiting_ms = Math.max(0, s.elapsed_ms - (s.active_ms || 0));
}
export function checkCoupling(v) {
  if (v == null || v === "") return "";
  const x = String(v).toLowerCase().trim();
  if (!COUPLING.includes(x)) throw new Error(`coupling: ${COUPLING.join(" | ")}`);
  return x;
}
export function checkCause(v) {
  if (v == null || v === "") return "";
  const x = String(v).toLowerCase().trim();
  if (!CAUSES.includes(x)) throw new Error(`cause: ${CAUSES.join(" | ")}`);
  return x;
}
