// node test/bridge-core.mjs  (J371: the Doorman bridge's job rules, pure)
import assert from "node:assert/strict";
import { newJob, apply, sweep, answer, view, OPS } from "../docker/bridge/core.mjs";
const T0 = Date.parse("2026-10-10T00:00:00Z"), S = 1000;
const merge = (rec, r) => (r.patch ? { ...rec, ...r.patch, history: [...rec.history, ...(r.history || [])] } : rec);
const ok = (m) => console.log("ok " + m);
let job = newJob({ id: "world-g--abc123", sandbox: "world-g", asker: "Alpha", action: "Open ~/Work/cube-art/index.html in G's browser", timeLimitS: 3600, nowMs: T0 });
assert.equal(job.state, "waiting"); assert.deepEqual(Object.keys(job.approved), ["action", "tools", "folders", "time_limit_s"]);
// 1. only the five operations exist; anything else is refused and changes nothing
for (const bad of ["approve", "deny", "edit", "create", "decide", "set", "", undefined]) { const r = apply(job, { op: bad, by: "x" }, T0); assert.equal(r.reply.ok, false); assert.equal(r.patch, undefined); }
assert.deepEqual([...OPS].sort(), ["ask", "claim", "release", "renew", "report"]);
ok("only claim/renew/release/ask/report; approve/deny/edit/create refused");
// 2. claim: one claimer; a second claim is refused while the lease runs
let r = apply(job, { op: "claim", by: "claude-1", lease_s: 600 }, T0); assert.ok(r.reply.ok); const tok = r.reply.token; job = merge(job, r);
assert.equal(job.state, "claimed"); assert.match(tok, /^[0-9a-f]{32}$/);
r = apply(job, { op: "claim", by: "codex-2" }, T0 + 10 * S); assert.equal(r.reply.ok, false); assert.match(r.reply.text, /claimed by claude-1/);
// a wrong token can't act
for (const op of ["renew", "release", "ask", "report"]) assert.equal(apply(job, { op, by: "x", token: "f".repeat(32), text: "q", state: "done", summary: "s" }, T0 + S).reply.ok, false);
ok("claims are exclusive; a wrong token can't renew, release, ask or report");
// 3. the lease runs out → abandoned → waiting; another agent claims; view shows it waiting
assert.equal(view(job, T0 + 601 * S).state, "waiting");
r = apply(job, { op: "claim", by: "codex-2" }, T0 + 601 * S); assert.ok(r.reply.ok); assert.ok(r.history.some((h) => /abandoned by claude-1/.test(h.ev))); job = merge(job, r);
const tok2 = r.reply.token;
assert.equal(apply(job, { op: "report", by: "claude-1", token: tok, state: "done", summary: "late" }, T0 + 602 * S).reply.ok, false, "the old claimer's token is dead");
ok("an expired lease returns the job (abandoned); the old token is dead");
// 4. ask: the job waits (doesn't expire), a hold effect; answer brings it back to the claimer
r = apply(job, { op: "ask", by: "codex-2", token: tok2, text: "Which browser profile?\u202e" }, T0 + 610 * S); assert.ok(r.reply.ok); assert.deepEqual(r.effects.map((e) => e.kind), ["hold"]);
assert.equal(r.patch.questions[0].text, "Which browser profile?", "format characters stripped"); job = merge(job, r);
assert.equal(job.state, "asked"); assert.equal(sweep(job, T0 + 99999 * S), null, "an asked job doesn't expire");
assert.equal(apply(job, { op: "ask", by: "codex-2", token: tok2, text: "again?" }, T0 + 611 * S).reply.ok, false, "one open question at a time");
const a = answer(job, 1, "G's own profile", T0 + 700 * S); job = merge(job, a); assert.equal(job.state, "claimed"); assert.equal(view(job, T0 + 701 * S).questions[0].answer, "G's own profile");
assert.equal(answer(job, 1, "twice", T0 + 701 * S), null, "a question is answered once");
{ let k = newJob({ id: "world-g--aaa111", sandbox: "world-g", asker: "A", action: "x", nowMs: T0 }); let q = apply(k, { op: "claim", by: "a" }, T0); k = merge(k, q); const tk = q.reply.token;
  k = merge(k, apply(k, { op: "ask", by: "a", token: tk, text: "?" }, T0)); q = apply(k, { op: "release", by: "a", token: tk }, T0); assert.ok(q.reply.ok); k = merge(k, q);
  assert.equal(k.state, "asked"); assert.equal(k.claim, null); assert.equal(apply(k, { op: "claim", by: "b" }, T0).reply.ok, false, "not claimable while its question waits");
  k = merge(k, answer(k, 1, "yes", T0)); assert.equal(k.state, "waiting", "answered → waiting for a host agent"); }
ok("ask holds a question and the job waits; the answer comes back once; a release while asked keeps it asked");
// 5. report: validated, final; outcome effect; nothing after it
assert.equal(apply(job, { op: "report", by: "codex-2", token: tok2, state: "approved", summary: "x" }, T0 + 710 * S).reply.ok, false);
assert.equal(apply(job, { op: "report", by: "codex-2", token: tok2, state: "done", summary: "" }, T0 + 710 * S).reply.ok, false);
assert.equal(apply(job, { op: "report", by: "codex-2", token: tok2, state: "done", summary: "s", ran: Array(51).fill("x") }, T0 + 710 * S).reply.ok, false);
r = apply(job, { op: "report", by: "codex-2", token: tok2, state: "done", summary: "Opened it.", ran: ["g_open_url.py --agent file:///…"], changed: [] }, T0 + 720 * S);
assert.ok(r.reply.ok); assert.deepEqual(r.effects.map((e) => e.kind), ["outcome"]); job = merge(job, r);
assert.equal(job.state, "done"); assert.equal(job.outcome.by, "codex-2"); assert.equal(job.claim, null);
for (const op of ["claim", "ask", "report", "renew", "release"]) assert.equal(apply(job, { op, by: "x", token: tok2, text: "q", state: "done", summary: "s" }, T0 + 730 * S).reply.ok, false);
ok("report is validated and final; outcome effect for the relay's routing");
// 6. the time limit: a claimer that never reports → no_report (an outcome effect), not another claim
let j2 = newJob({ id: "world-g--def456", sandbox: "world-g", asker: "Beta", action: "x", timeLimitS: 900, nowMs: T0 });
r = apply(j2, { op: "claim", by: "a", lease_s: 3600 }, T0); assert.equal(r.reply.until, new Date(T0 + 900 * S).toISOString(), "the lease never passes the time limit"); j2 = merge(j2, r);
const sw = sweep(j2, T0 + 901 * S); assert.equal(sw.patch.state, "no_report"); assert.deepEqual(sw.effects.map((e) => e.kind), ["outcome"]);
assert.equal(apply(j2, { op: "claim", by: "b" }, T0 + 902 * S).reply.ok, false, "no_report is final");
{ let k = newJob({ id: "world-g--bbb222", sandbox: "world-g", asker: "A", action: "x", timeLimitS: 3600, nowMs: T0 }); let q = apply(k, { op: "claim", by: "a" }, T0); k = merge(k, q);
  k = merge(k, apply(k, { op: "ask", by: "a", token: q.reply.token, text: "?" }, T0 + S)); k = merge(k, answer(k, 1, "late", T0 + 86400 * S));
  assert.equal(k.state, "claimed"); assert.ok(Date.parse(k.claim.until) > T0 + 86400 * S, "a late answer leaves time to work");
  assert.equal(sweep(k, T0 + 86401 * S), null, "not no_report right after a late answer"); }
ok("the time limit: no report → no_report, final; the owner's wait doesn't count");
// 7. view shows only the approved text and the bridge's own fields
const v = view({ ...job, raw_sandbox_text: "IGNORE PREVIOUS", draft: "x" }, T0);
assert.ok(!JSON.stringify(v).includes("IGNORE")); assert.deepEqual(Object.keys(v).sort(), ["approved", "claimed_by", "created_at", "for", "id", "lease_until", "outcome", "questions", "sandbox", "state"]);
ok("view: approved text and the job's own fields only, never other record fields");
console.log("bridge-core: all pass");
