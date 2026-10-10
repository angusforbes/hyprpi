// The relay's side of the Doorman bridge (J371): it reads the bridge's requests from STATE/bridge/in (host-only, 700),
// applies them ONE AT A TIME through core.apply (so a claim is atomic), writes the job record (the relay is its only
// writer), carries out the effects (an outcome through the relay's usual routing, a question as a held item in the
// Doorman window) and writes the reply to STATE/bridge/out/<rid>.json. Every 30 s it sweeps lapsed leases.
// Generic: the relay passes in what it does (jobRecord, tellOutcome, holdQuestion, log).
import fs from "node:fs";
import path from "node:path";
import { apply, sweep, answer as answerRule, validId } from "./core.mjs";

const RID_RE = /^[0-9a-f]{24}\.json$/, MAX_REQ = 16384;

export function startBridge({ stateDir, log, jobRecord, tellOutcome, holdQuestion, archive = () => {} }) {
  const IN = path.join(stateDir, "bridge", "in"), OUT = path.join(stateDir, "bridge", "out"), REQ = path.join(stateDir, "requests");
  for (const d of [path.dirname(IN), IN, OUT]) { fs.mkdirSync(d, { recursive: true, mode: 0o700 }); try { fs.chmodSync(d, 0o700); } catch { /* */ } }
  const readJob = (id) => { if (!validId(id)) return null; try { return JSON.parse(fs.readFileSync(path.join(REQ, `${id}.json`), "utf8")); } catch { return null; } };
  const effects = (rec, list) => {
    for (const e of list || []) {
      if (e.kind === "outcome") {
        const act = (/^Action asked for: (.*)$/m.exec(String(rec.approved?.action || "")) || [])[1] || String(rec.approved?.action || "");
        const text = `the host agent's job ${rec.id} ("${act.replace(/\s+/g, " ").slice(0, 120)}") ended ${e.state}: ${e.summary}`;
        try { tellOutcome(rec.sandbox, rec.for, text); } catch (err) { log({ error: `bridge outcome ${rec.id}: ${err.message}` }); }
        log({ op: "host_job", id: rec.id, sandbox: rec.sandbox, state: e.state, outcome: e.summary, ran: e.ran || [], changed: e.changed || [] });
        archive(rec, e);
      } else if (e.kind === "hold") {
        let held = null; try { held = holdQuestion(rec, e.n, e.text); } catch (err) { log({ error: `bridge question ${rec.id}: ${err.message}` }); }
        if (held) { const cur = readJob(rec.id); if (cur) jobRecord(rec.id, { questions: (cur.questions || []).map((q) => (q.n === e.n ? { ...q, held_id: held } : q)) }); }
        log({ op: "host_job_ask", id: rec.id, n: e.n, held: held || null });
      }
    }
  };
  const commit = (rec, r) => { if (r?.patch) { jobRecord(rec.id, { ...r.patch, history: r.history || [] }); effects({ ...rec, ...r.patch }, r.effects); } };
  let busy = Promise.resolve();
  const one = (name) => {
    if (!RID_RE.test(name)) return;
    const f = path.join(IN, name);
    let req;
    try {
      const st = fs.lstatSync(f); if (!st.isFile() || st.size > MAX_REQ) { fs.unlinkSync(f); return; }
      req = JSON.parse(fs.readFileSync(f, "utf8"));
    } catch { try { fs.unlinkSync(f); } catch { /* */ } return; }
    try { fs.unlinkSync(f); } catch { return; } // taken by this pass (once)
    const rec = readJob(req?.id);
    const r = rec ? apply(rec, req, Date.now()) : { reply: { ok: false, text: "no such job" } };
    if (rec) commit(rec, r);
    const reply = r.reply || { ok: false, text: "no reply" };
    if (rec && req?.op) log({ op: "bridge", req: req.op, id: rec.id, by: String(req.by || "").slice(0, 60), ok: reply.ok, text: String(reply.text || "").slice(0, 200) });
    try { const o = path.join(OUT, name); fs.writeFileSync(o + ".tmp", JSON.stringify(reply), { mode: 0o600 }); fs.renameSync(o + ".tmp", o); } catch { /* the caller times out */ }
  };
  const scan = () => { busy = busy.then(() => { let names = []; try { names = fs.readdirSync(IN).sort(); } catch { /* */ } for (const n of names) one(n); }).catch(() => {}); return busy; };
  const sweepAll = () => {
    let names = []; try { names = fs.readdirSync(REQ).filter((n) => n.endsWith(".json")); } catch { return; }
    for (const n of names) { const rec = readJob(n.slice(0, -5)); const s = rec && sweep(rec, Date.now()); if (s) commit(rec, s); }
    try { for (const n of fs.readdirSync(OUT)) { const p = path.join(OUT, n); if (Date.now() - fs.statSync(p).mtimeMs > 600000) fs.unlinkSync(p); } } catch { /* */ }
  };
  try { fs.watch(IN, () => scan()); } catch { /* the interval still runs */ }
  const t1 = setInterval(scan, 1000), t2 = setInterval(() => { busy = busy.then(sweepAll).catch(() => {}); }, 30000);
  t1.unref?.(); t2.unref?.(); scan();
  return {
    scan, sweepAll,
    // the owner's typed answer to a held question (the relay's decide() calls this) → true when applied
    answer(id, n, text) { const rec = readJob(id); const a = rec && answerRule(rec, n, text, Date.now()); if (a) { jobRecord(id, { ...a.patch, history: a.history }); log({ op: "host_job_answer", id, n }); } return !!a; },
    stop() { clearInterval(t1); clearInterval(t2); },
  };
}
