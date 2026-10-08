// J130 orchestration primitives (Angus: "lets build those other primitives now too, so that we have the
// foundation for any orchestration strategy"): spawn, close, report / wait-for-report, parent links with
// orphan handling, automatic notes to the world's Thoughts, budgets and model routing with one-step
// escalation. Strategies (fan-out, builder + verifier, …) are recipes on top (skills), not code here.
//
// State: STATE/orch.json, { children: { id: Child } }, kept across daemon restarts.
// Child = { id, name, parent ("hp-…" agent id or "thoughts:D"), parentName, room, job, prompt, model,
//   thinking, routed, why, budget {tokens, minutes}, used {tokens}, startedAt, status
//   ("starting"|"running"|"budget"|"closing"|"closed"|"orphaned"), reports [{text, final, at}],
//   escalations, closedAt, closedBy, depth, fork }
// The daemon passes in what it owns (agents, windows, Thoughts); nothing here talks to Hyprland.
import fs from "node:fs";
import path from "node:path";
import { loadPolicy } from "./policy.mjs";
import { routeModel, nextStep } from "./routing.mjs";

export function createOrch({ stateDir, log = () => {}, deps }) {
  // deps: liveAgent(id) -> {id,name,room,model,thinking,session,conn?} | null; agentName(id); send(id, event, data) -> bool;
  //   open({id, room, name, icon, cwd, model, thinking, fork, twinOf, welcome, project}) -> {name, workspace};
  //   note(room, text); thoughtsReport(room, {from, text, final}); setModel(id, model, thinking) -> Promise;
  //   roomOf(parent) -> room
  const FILE = path.join(stateDir, "orch.json");
  let st = { children: {} };
  try { st = { children: {}, ...JSON.parse(fs.readFileSync(FILE, "utf8")) }; } catch { /* fresh */ }
  const save = () => { try { fs.writeFileSync(FILE + ".tmp", JSON.stringify(st, null, 1)); fs.renameSync(FILE + ".tmp", FILE); } catch (e) { log("orch save", e.message); } };
  const waiters = new Set(); // { parent, ids:Set, any, resolve, timer, since }
  const live = (c) => c && !["closed"].includes(c.status);
  const childrenOf = (parent) => Object.values(st.children).filter((c) => c.parent === parent && live(c));
  const depthOf = (id) => { let d = 0, c = st.children[id]; while (c && d < 10) { d++; c = st.children[c.parent]; } return d; };
  const clip = (s, n = 160) => { s = String(s || "").replace(/\s+/g, " ").trim(); return s.length > n ? s.slice(0, n - 1) + "…" : s; };
  const nameOfParent = (parent) => parent.startsWith("thoughts:") ? `Thoughts-${parent.slice(9)}` : deps.agentName(parent);
  const view = (c) => c && ({ id: c.id, name: c.name, parent: c.parent, parent_name: c.parentName, status: c.status, model: c.model, thinking: c.thinking,
    routed: c.routed, why: c.why, budget: c.budget, used: c.used, started_at: c.startedAt, reports: c.reports.length, last_report: c.reports.at(-1)?.text || "",
    final: !!c.reports.at(-1)?.final, escalations: c.escalations || 0, fork: !!c.fork, job: c.job || "" });

  function spawn(p, parent) {
    const P = loadPolicy(), O = P.orchestration || {};
    const isThoughts = parent.startsWith("thoughts:");
    if (!isThoughts) {
      // J202 safety net: a child closed on purpose more than 2 min ago whose window is gone counts as closed.
      for (const k of childrenOf(parent)) if (k.status === "closing" && Date.now() - (k.closingAt || 0) > 120e3 && !deps.liveAgent(k.id)) gone(k.id);
      const n = childrenOf(parent).length;
      if (n >= (O.maxChildren ?? 4)) throw new Error(`you already have ${n} live children (limit ${O.maxChildren ?? 4} in hyprpi.jsonc orchestration.maxChildren); close one first`);
      const d = depthOf(parent) + 1;
      if (d > (O.maxDepth ?? 2)) throw new Error(`a child at depth ${d - 1} may not spawn (orchestration.maxDepth ${O.maxDepth ?? 2})`);
    }
    const prompt = String(p.prompt || "").trim();
    if (!prompt) throw new Error("give the child its prompt (what to do, done when, how to report)");
    const pa = isThoughts ? null : deps.liveAgent(parent);
    if (!isThoughts && !pa) throw new Error("the parent isn't a live agent");
    const room = isThoughts ? parent.slice(9) : deps.roomOf(parent);
    // Routing: explicit > complexity > default; a fork keeps the parent's model unless one is given.
    const r = p.fork && !p.model && !p.complexity ? { model: pa?.model || "", thinking: p.thinking || pa?.thinking || "", routed: false, why: "fork (parent's model)" }
      : routeModel({ model: p.model || "", thinking: p.thinking || "", complexity: p.complexity || "" }, P);
    const B = P.budgets || {};
    const budget = { tokens: Number(p.budget?.tokens) || B.tokens || 0, minutes: Number(p.budget?.minutes) || B.minutes || 0 };
    const id = "hp-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
    const parentName = nameOfParent(parent);
    const welcome = `[hyprpi · ${parentName} spawned you (spawn_agent) · you are its child]\n${prompt}\n\n` +
      `(How this works: when you have a result, or are stuck, call report_to_parent with it; final: true when the job is done, then stop. ` +
      `Your parent may close you after a final report. Budget: ${budget.tokens ? `${Math.round(budget.tokens / 1000)}k tokens` : "no token cap"}, ${budget.minutes ? `${budget.minutes} min` : "no time cap"}; ` +
      `at a cap you stop, report what you have and what's left, and wait. Model: ${r.model || "the default"}${r.thinking ? "/" + r.thinking : ""}${r.routed ? ` (routed: ${r.why})` : ""}. ` +
      `Never move Angus's focus.)`;
    const c = { id, name: "", parent, parentName, room, job: String(p.job || ""), prompt: clip(prompt, 400), model: r.model, thinking: r.thinking, routed: r.routed, why: r.why,
      budget, used: { tokens: 0 }, startedAt: Date.now(), status: "starting", reports: [], escalations: 0, fork: !!p.fork, depth: isThoughts ? 1 : depthOf(parent) + 1 };
    const o = deps.open({ id, room, name: p.name, icon: p.icon, cwd: p.cwd || (pa?.cwd) || "", model: r.model, thinking: r.thinking,
      fork: p.fork ? pa?.session || "" : "", twinOf: p.fork ? parent : "", welcome, project: p.project || "" });
    c.name = o.name; c.workspace = o.workspace;
    st.children[id] = c; save();
    deps.note(room, `🌱 ${parentName} spawned ${o.icon ? o.icon + " " : ""}${o.name}${p.fork ? " (a fork of itself)" : ""} on ${r.model || "the default model"}${r.thinking ? "/" + r.thinking : ""}${r.routed ? ` (${r.why})` : ""}: ${clip(prompt, 140)}`);
    log(`orch: ${parentName} spawned ${o.name} (${id}) ${r.model}/${r.thinking} ${r.why}`);
    return { id, name: o.name, workspace: o.workspace, model: r.model, thinking: r.thinking, routed: r.routed, why: r.why, budget };
  }

  // A child's report. Resolves a waiting parent; otherwise delivered to the parent as a message.
  function report(childId, { text, final = false } = {}) {
    const c = st.children[childId];
    if (!c) throw new Error("you weren't spawned with spawn_agent, so you have no parent to report to (use talk_reply / room_post)");
    const t = String(text || "").trim(); if (!t) throw new Error("empty report");
    const rep = { text: t.slice(0, 20000), final: !!final, at: Date.now() };
    c.reports.push(rep); if (c.reports.length > 20) c.reports.splice(0, c.reports.length - 20);
    if (c.status === "budget" && final) c.status = "running";
    save();
    let taken = false;
    for (const w of [...waiters]) if (w.parent === c.parent && w.ids.has(childId)) { taken = true; tryResolve(w); }
    if (!taken) deliver(c, rep);
    if (final) deps.note(c.room, `📨 ${c.name} reported (final) to ${c.parentName}: ${clip(t, 140)}`);
    // Orphan policy "finish": its final report ends it.
    if (final && c.status === "orphaned") setTimeout(() => { try { close(childId, c.parent); } catch (e) { log("orch orphan close", e.message); } }, 1500).unref?.();
    return { delivered: taken ? "to your waiting parent" : "to your parent as a message" };
  }
  function deliver(c, rep) {
    const head = `[report from ${c.name} (${c.id})${rep.final ? " · final" : ""} · your child, spawned for: ${clip(c.prompt, 80)}]`;
    if (c.parent.startsWith("thoughts:")) deps.thoughtsReport(c.parent.slice(9), { from: c.name, text: `${head}\n${rep.text}`, final: rep.final });
    else if (!deps.send(c.parent, "orch.report", { child: c.id, name: c.name, final: rep.final, text: `${head}\n${rep.text}\n\n(${rep.final ? `Done: close it with close_agent("${c.id}") when you've checked it, or send follow-ups with talk.` : "Not final yet."})` })) {
      // parent offline (mid-reload, crashed): kept and redelivered when it connects again (redeliver)
      rep.undelivered = true; save();
      log(`orch: report from ${c.name} kept (parent ${c.parentName} not connected)`);
    }
  }
  // Knock's J130 finding 6: reports that couldn't be delivered (the parent was reloading) arrive when it's back.
  function redeliver(parent) {
    let n = 0;
    for (const c of Object.values(st.children)) if (c.parent === parent) for (const r of c.reports) if (r.undelivered) {
      delete r.undelivered;
      if (deps.send(parent, "orch.report", { child: c.id, name: c.name, final: r.final, text: `[report from ${c.name} (${c.id})${r.final ? " · final" : ""} · delivered late: you weren't connected when it came]\n${r.text}` })) n++;
      else r.undelivered = true;
    }
    if (n) save();
    return n;
  }

  // wait_report: resolves when the children report (any or all), or at the timeout. No polling: a promise.
  // J272 fix 3 (J269: Harbor's waits missed GateBuilder's 14:15 and WorldReview's 15:04 reports, which came just
  // before the wait started): without an explicit `since`, each child's reports count from the last ones a wait
  // already returned (else its spawn), not from "now".
  function wait(parent, ids, { timeoutSec = 600, any = false, since = 0 } = {}) {
    const want = (ids && ids.length ? ids : childrenOf(parent).map((c) => c.id)).map(String);
    for (const id of want) { const c = st.children[id]; if (!c) throw new Error(`no child ${id}`); if (c.parent !== parent) throw new Error(`${c.name} isn't your child`); }
    if (!want.length) return Promise.resolve({ reports: [], timed_out: false, still_working: [], note: "you have no live children" });
    const t0 = since || 0; // 0 = per child (readAt / spawn)
    return new Promise((resolve) => {
      const w = { parent, ids: new Set(want), any, since: t0, resolve, timer: null };
      w.timer = setTimeout(() => { waiters.delete(w); const r = result(w, true); markRead(r); resolve(r); }, Math.max(1, Math.min(3600, Number(timeoutSec) || 600)) * 1000);
      w.timer.unref?.();
      waiters.add(w);
      // reports that came after `since` but before the wait started count (no lost wake-up)
      tryResolve(w);
    });
  }
  function result(w, timedOut) {
    const reports = [], still = [];
    for (const id of w.ids) {
      const c = st.children[id], from = w.since || c?.readAt || c?.startedAt || 0; const fresh = (c?.reports || []).filter((r) => r.at >= from);
      if (fresh.length) reports.push({ id, name: c.name, final: !!fresh.at(-1).final, text: fresh.map((r) => r.text).join("\n---\n") });
      else still.push({ id, name: c?.name || id, status: c?.status || "gone" });
    }
    return { reports, timed_out: timedOut, still_working: still };
  }
  function tryResolve(w) {
    const r = result(w, false);
    const gone = r.still_working.filter((s) => ["closed", "orphaned", "gone"].includes(s.status));
    const ready = w.any ? r.reports.length > 0 : r.still_working.length === gone.length && (r.reports.length > 0 || gone.length > 0);
    if (ready) { clearTimeout(w.timer); waiters.delete(w); markRead(r); w.resolve(r); }
  }

  function close(id, by, { reason = "" } = {}) {
    const c = st.children[id];
    if (!c) throw new Error(`no spawned agent ${id}`);
    if (by !== c.parent && by !== id && !String(by).startsWith("thoughts:")) throw new Error(`only ${c.parentName} (its parent), Thoughts or ${c.name} itself can close it`);
    if (c.status === "closed") return { already: true, name: c.name };
    c.status = "closing"; c.closingAt = Date.now(); c.closedBy = by === id ? "itself" : nameOfParent(by) || by; save();
    const sent = deps.send(id, "orch.close", { by: c.closedBy, reason });
    if (!sent) gone(id, { quiet: false }); // not connected: closed now
    return { name: c.name, closing: sent, last_report: c.reports.at(-1)?.text || "" };
  }

  // The daemon calls this when an agent's window is gone for good (not a reload / restart).
  function gone(id) {
    const c = st.children[id];
    if (c && c.status !== "closed") {
      const was = c.status; c.status = "closed"; c.closedAt = Date.now(); save();
      deps.note(c.room, `🍂 ${c.name} closed${was === "closing" ? ` by ${c.closedBy}` : " (its window went away)"}${c.reports.length ? `; last report: ${clip(c.reports.at(-1).text, 120)}` : "; it never reported"}`);
      for (const w of [...waiters]) if (w.ids.has(id)) tryResolve(w);
    }
    // Orphans: its own live children.
    const kids = childrenOf(id);
    if (!kids.length) return;
    const policy = (loadPolicy().orchestration || {}).orphans || "finish";
    const room = c?.room || kids[0].room, pname = c?.name || deps.agentName(id);
    deps.note(room, `👶 ${pname} went away with ${kids.length} live child${kids.length > 1 ? "ren" : ""} (${kids.map((k) => k.name).join(", ")}); policy "${policy}"`);
    for (const k of kids) {
      k.parent = "thoughts:" + k.room; k.parentName = `Thoughts-${k.room}`; // its reports now go to Thoughts (also for "close")
      if (policy === "close") { save(); close(k.id, k.parent, { reason: "its parent went away" }); continue; }
      if (policy === "finish") { k.status = "orphaned"; deps.send(k.id, "orch.orphaned", { parent: pname, thoughts: k.parentName }); }
      save();
    }
  }

  // Budgets: the child's extension reports its token use; it enforces the cap itself (stop, report, wait).
  function usage(id, { tokens = 0 } = {}) {
    const c = st.children[id]; if (!c) return { none: true };
    c.used.tokens = Math.max(c.used.tokens || 0, Number(tokens) || 0); save();
    return { budget: c.budget, used: c.used, started_at: c.startedAt, status: c.status };
  }
  async function budgetHit(id, { what = "" } = {}) {
    const c = st.children[id]; if (!c || c.status === "budget") return { status: c?.status };
    c.status = "budget"; save();
    deps.note(c.room, `⛽ ${c.name} hit its ${what || "budget"} (${Math.round((c.used.tokens || 0) / 1000)}k tokens, ${Math.round((Date.now() - c.startedAt) / 60000)} min); it stops, reports and waits for extend_budget`);
    if ((loadPolicy().routing?.escalate || {}).onBudget) await escalate(id, { reason: `hit its ${what || "budget"}`, by: "budget" }).catch(() => {});
    return { status: c.status };
  }
  function extend(id, by, { tokens = 0, minutes = 0 } = {}) {
    const c = st.children[id]; if (!c) throw new Error(`no spawned agent ${id}`);
    if (by !== c.parent && !String(by).startsWith("thoughts:")) throw new Error(`only ${c.parentName} or Thoughts can extend ${c.name}'s budget`);
    if (tokens) c.budget.tokens = (c.budget.tokens || 0) + Number(tokens);
    if (minutes) c.budget.minutes = (c.budget.minutes || 0) + Number(minutes);
    if (!tokens && !minutes) { const B = loadPolicy().budgets || {}; c.budget.tokens += B.tokens || 0; c.budget.minutes += B.minutes || 0; }
    const wasStopped = c.status === "budget"; if (wasStopped) c.status = "running";
    save();
    deps.send(id, "orch.budget", { budget: c.budget, used: c.used, startedAt: c.startedAt, resumed: wasStopped });
    deps.note(c.room, `⛽ ${nameOfParent(by)} extended ${c.name}'s budget to ${Math.round(c.budget.tokens / 1000)}k tokens / ${c.budget.minutes} min`);
    return { name: c.name, budget: c.budget };
  }
  // One step up the ladder (once per job unless explicit), with a note. Angus's explicit model choice isn't overridden.
  // job (J140): once per JOB rather than once per child, for failed-check escalations (a child handed a new
  // job may escalate again). The step is claimed before the model switch is awaited, so two checks failing
  // at once can't both escalate.
  async function escalate(id, { reason = "", by = "", explicit = false, caller = "", job = "" } = {}) {
    const c = st.children[id]; if (!c) throw new Error(`no spawned agent ${id}`);
    if (caller && caller !== c.parent && !String(caller).startsWith("thoughts:")) throw new Error(`only ${c.parentName} (its parent) or Thoughts can escalate ${c.name}`);
    c.escalatedJobs ||= [];
    if (!explicit && (c.escalating || (job ? c.escalatedJobs.includes(job) : c.escalations >= 1))) return { skipped: c.escalating ? "an escalation is already under way" : "already escalated once for this job" };
    // An explicitly chosen model (by Angus or the spawner) is never escalated automatically (budget hit, failed check);
    // only an explicit escalate_agent moves it (Knock's J130 finding 2).
    if (!explicit && c.why === "explicit") return { skipped: "its model was chosen explicitly (explicit: true to escalate anyway)" };
    const n = nextStep(c.model, c.thinking, loadPolicy(), { ignoreCeiling: explicit });
    if (!n) { deps.note(c.room, `⤴ ${c.name} can't escalate from ${c.model}/${c.thinking} (top of the ladder or not on it)${reason ? `: ${reason}` : ""}`); return { skipped: "top of the ladder (or its model isn't on it)" }; }
    c.escalating = true;
    try { await deps.setModel(id, n.model, n.thinking); } finally { c.escalating = false; }
    if (job) c.escalatedJobs.push(job);
    const before = `${c.model}/${c.thinking}`;
    c.model = n.model; c.thinking = n.thinking; c.escalations = (c.escalations || 0) + 1; save();
    deps.note(c.room, `⤴ ${c.name} escalated ${before} → ${n.model}/${n.thinking}${reason ? `: ${reason}` : ""}${by ? ` (${by})` : ""}`);
    return { name: c.name, before, model: n.model, thinking: n.thinking };
  }

  const onHello = (id) => { const c = st.children[id]; if (!c) return null; if (c.status === "starting") { c.status = "running"; save(); } return { budget: c.budget, used: c.used, startedAt: c.startedAt, status: c.status, parent: c.parentName }; };
  const children = (parent) => childrenOf(parent).map(view);
  const get = (id) => view(st.children[id]);
  const linkOf = (id) => { const c = st.children[id]; const kids = childrenOf(id); return { parent: c && live(c) ? c.parentName : "", parent_id: c && live(c) ? c.parent : "", children: kids.map((k) => ({ id: k.id, name: k.name, status: k.status })) }; };
  // J248: end a parent's running waits early (Angus wrote to Thoughts): they return what's in so far, with why.
  function wake(parent, why = "") {
    let n = 0;
    for (const w of [...waiters]) if (w.parent === parent) { clearTimeout(w.timer); waiters.delete(w); n++; const r = result(w, false); markRead(r); w.resolve({ ...r, woken: why || true }); }
    return n;
  }
  // J272: reports a wait returned are read: the next wait (without `since`) only counts newer ones.
  function markRead(r) {
    let changed = false;
    for (const x of r.reports || []) { const c = st.children[x.id]; const last = c?.reports?.at(-1)?.at; if (c && last && (c.readAt || 0) <= last) { c.readAt = last + 1; changed = true; } }
    if (changed) save();
  }
  return { redeliver, spawn, report, wait, wake, close, gone, usage, budgetHit, extend, escalate, onHello, children, get, linkOf, all: () => Object.values(st.children).map(view) };
}
