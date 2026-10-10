// The relay's side of the Doorman bridge (J371): it reads the bridge's requests from STATE/bridge/in (host-only, 700),
// applies them ONE AT A TIME through core.apply (so a claim is atomic), writes the job record (the relay is its only
// writer), carries out the effects (an outcome through the relay's usual routing, a question as a held item in the
// Doorman window) and writes the reply to STATE/bridge/out/<rid>.json. Every 30 s it sweeps lapsed leases.
// Generic: the relay passes in what it does (jobRecord, tellOutcome, holdQuestion, log).
import fs from "node:fs";
import path from "node:path";
import { apply, sweep, answer as answerRule, validId } from "./core.mjs";
import { REG_OPS, applyReg, lookup, prune, modeFor, sanitize, empty as emptyReg } from "./registry.mjs"; // J407: host-agent registration

const RID_RE = /^[0-9a-f]{24}\.json$/, MAX_REQ = 16384;

// J407: sandboxes() = the sandboxes whose Doorman uses the bridge; runnerOn() = the per-job runner is installed; onMode(sandbox, mode) is
// called when a sandbox's mode (who would do a free-form job) changes, so the relay can refresh its host card.
export function startBridge({ stateDir, log, jobRecord, tellOutcome, holdQuestion, archive = () => {}, sandboxes = () => [], runnerOn = () => false, onMode = () => {} }) {
  const IN = path.join(stateDir, "bridge", "in"), OUT = path.join(stateDir, "bridge", "out"), REQ = path.join(stateDir, "requests");
  const AGENTS = path.join(stateDir, "bridge", "agents.json"), MODE = path.join(stateDir, "bridge", "mode.json");
  // (RegReview) a missing, corrupt or malformed registry reads as nobody registered (agent-free: the fail-closed direction); bad entries are dropped
  const readReg = () => { try { return sanitize(JSON.parse(fs.readFileSync(AGENTS, "utf8"))); } catch { return emptyReg(); } };
  const writeAtomic = (f, v) => { fs.writeFileSync(f + ".tmp", JSON.stringify(v, null, 1), { mode: 0o600 }); fs.renameSync(f + ".tmp", f); };
  let lastMode = ""; try { lastMode = JSON.stringify(JSON.parse(fs.readFileSync(MODE, "utf8")).sandboxes || {}); } catch { /* none yet */ }
  const refreshMode = () => { // the mode per sandbox, written for the card (mode.json, readable by the card writer) and told on change
    const reg = readReg(), all = {}; for (const sb of sandboxes()) all[sb] = modeFor(reg, sb, { runnerOn: !!runnerOn() });
    const j = JSON.stringify(all); if (j === lastMode) return all;
    let prev = {}; try { prev = JSON.parse(lastMode || "{}"); } catch { /* */ }
    try { writeAtomic(MODE, { at: new Date().toISOString(), sandboxes: all }); lastMode = j; } catch (e) { log({ error: `bridge mode: ${e.message}` }); return all; } // (RegReview) retried next time if the write failed
    for (const [sb, m] of Object.entries(all)) if (JSON.stringify(prev[sb]) !== JSON.stringify(m)) { log({ op: "host_agents", sandbox: sb, mode: m.mode, agents: m.agents }); try { onMode(sb, m); } catch (e) { log({ error: `bridge onMode: ${e.message}` }); } }
    return all;
  };
  for (const d of [path.dirname(IN), IN, OUT]) { fs.mkdirSync(d, { recursive: true, mode: 0o700 }); try { fs.chmodSync(d, 0o700); } catch { /* */ } }
  const readJob = (id) => { if (!validId(id)) return null; try { return JSON.parse(fs.readFileSync(path.join(REQ, `${id}.json`), "utf8")); } catch { return null; } };
  const effects = (rec, list) => { // → an error text when a question couldn't be held (the ask is then undone)
    let failed = "";
    for (const e of list || []) {
      if (e.kind === "outcome") {
        const act = String(rec.approved?.action_line || rec.approved?.action || ""); // (J379) the structured action, never a line parsed from text
        const text = `the host agent's job ${rec.id} ("${act.replace(/\s+/g, " ").slice(0, 120)}") ended ${e.state}: ${e.summary}`;
        try { tellOutcome(rec.sandbox, rec.for, text); } catch (err) { log({ error: `bridge outcome ${rec.id}: ${err.message}` }); }
        log({ op: "host_job", id: rec.id, sandbox: rec.sandbox, state: e.state, outcome: e.summary, ran: e.ran || [], changed: e.changed || [] });
        archive(rec, e);
      } else if (e.kind === "hold") {
        let held = null, why = ""; try { held = holdQuestion(rec, e.n, e.text); } catch (err) { why = err.message; log({ error: `bridge question ${rec.id}: ${err.message}` }); }
        const cur = readJob(rec.id);
        if (held && cur) jobRecord(rec.id, { questions: (cur.questions || []).map((q) => (q.n === e.n ? { ...q, held_id: held } : q)) });
        else if (cur) { // (BridgeReview) no held item: undo the question, so the job isn't left waiting for an answer that can't come
          jobRecord(rec.id, { state: "claimed", questions: (cur.questions || []).filter((q) => q.n !== e.n), history: [{ at: new Date().toISOString(), ev: `question ${e.n} couldn't be held: ${why || "no held item"}`, by: "relay" }] });
          failed = `the question couldn't be put to the owner (${why || "no held item"}); nothing changed, try again later`;
        }
        log({ op: "host_job_ask", id: rec.id, n: e.n, held: held || null });
      }
    }
    return failed;
  };
  const commit = (rec, r) => { if (r?.patch) { jobRecord(rec.id, { ...r.patch, history: r.history || [] }); return effects({ ...rec, ...r.patch }, r.effects); } return ""; };
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
    if (REG_OPS.has(req?.op)) { // J407: register / heartbeat / unregister (no job involved)
      const r = applyReg(readReg(), req, Date.now());
      if (r.reg) { try { writeAtomic(AGENTS, r.reg); } catch (e) { r.reply = { ok: false, text: `the registry couldn't be written: ${e.message}` }; } }
      if (req.op !== "heartbeat" || !r.reply.ok) log({ op: "bridge", req: req.op, by: String(req.name || "").slice(0, 60), ok: r.reply.ok, text: String(r.reply.text || "").slice(0, 200) });
      if (r.reg) refreshMode();
      try { const o = path.join(OUT, name); fs.writeFileSync(o + ".tmp", JSON.stringify(r.reply), { mode: 0o600 }); fs.renameSync(o + ".tmp", o); } catch { /* */ }
      return;
    }
    // J407: a claim needs a live registration; the claim is made in the registered name, never a name the request picks
    if (req?.op === "claim") {
      const a = lookup(readReg(), req.agent_token, Date.now());
      if (!a) { try { const o = path.join(OUT, name); fs.writeFileSync(o + ".tmp", JSON.stringify({ ok: false, text: "not a registered host agent (unknown or expired agent token): register (and keep heartbeating) before claiming" }), { mode: 0o600 }); fs.renameSync(o + ".tmp", o); } catch { /* */ } log({ op: "bridge", req: "claim", id: String(req.id || "").slice(0, 80), ok: false, text: "unregistered or expired agent" }); return; }
      if (a.scope?.length) { const rec0 = readJob(req.id); if (rec0 && !a.scope.includes(rec0.sandbox)) { try { const o = path.join(OUT, name); fs.writeFileSync(o + ".tmp", JSON.stringify({ ok: false, text: `${a.name} is registered for ${a.scope.join(", ")} only` }), { mode: 0o600 }); fs.renameSync(o + ".tmp", o); } catch { /* */ } return; } }
      req.by = a.name;
    }
    const rec = readJob(req?.id);
    const r = rec ? apply(rec, req, Date.now()) : { reply: { ok: false, text: "no such job" } };
    const failed = rec ? commit(rec, r) : "";
    const reply = failed ? { ok: false, text: failed } : r.reply || { ok: false, text: "no reply" };
    if (rec && req?.op) log({ op: "bridge", req: req.op, id: rec.id, by: String(req.by || "").slice(0, 60), ok: reply.ok, text: String(reply.text || "").slice(0, 200) });
    try { const o = path.join(OUT, name); fs.writeFileSync(o + ".tmp", JSON.stringify(reply), { mode: 0o600 }); fs.renameSync(o + ".tmp", o); } catch { /* the caller times out */ }
  };
  const scan = () => { busy = busy.then(() => { let names = []; try { names = fs.readdirSync(IN).sort(); } catch { /* */ } for (const n of names) one(n); }).catch(() => {}); return busy; };
  const sweepAll = () => {
    let names = []; try { names = fs.readdirSync(REQ).filter((n) => n.endsWith(".json")); } catch { return; }
    for (const n of names) { const rec = readJob(n.slice(0, -5)); const s = rec && sweep(rec, Date.now()); if (s) commit(rec, s); }
    try { for (const n of fs.readdirSync(OUT)) { const p = path.join(OUT, n); if (Date.now() - fs.statSync(p).mtimeMs > 600000) fs.unlinkSync(p); } } catch { /* */ }
  };
  let watcher = null; try { watcher = fs.watch(IN, () => scan()); } catch { /* the interval still runs */ }
  // J407: expired registrations are dropped and the mode refreshed every 10 s (an agent that stops heartbeating is gone within TTL + 10 s)
  const expire = () => { const r = readReg(), p = prune(r, Date.now()); if (p.removed.length) { try { writeAtomic(AGENTS, p.reg); } catch { /* */ } log({ op: "host_agents_expired", names: p.removed }); } refreshMode(); };
  const t1 = setInterval(scan, 1000), t2 = setInterval(() => { busy = busy.then(sweepAll).catch(() => {}); }, 30000), t3 = setInterval(() => { busy = busy.then(expire).catch(() => {}); }, 10000);
  t1.unref?.(); t2.unref?.(); t3.unref?.(); scan(); expire();
  return {
    scan, sweepAll, expire,
    // J407: who would do a free-form job for this sandbox right now → { mode, agents }
    mode(sandbox) { return modeFor(readReg(), sandbox, { runnerOn: !!runnerOn() }); },
    // the owner's typed answer to a held question (the relay's decide() calls this) → true when applied
    answer(id, n, text, heldId) { const rec = readJob(id); const a = rec && answerRule(rec, n, text, Date.now(), heldId); if (a) { jobRecord(id, { ...a.patch, history: a.history }); log({ op: "host_job_answer", id, n }); } return !!a; },
    stop() { clearInterval(t1); clearInterval(t2); clearInterval(t3); try { watcher?.close(); } catch { /* */ } },
  };
}
