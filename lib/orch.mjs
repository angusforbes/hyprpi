// J130 orchestration primitives (Angus: "lets build those other primitives now too, so that we have the
// foundation for any orchestration strategy"): spawn, close, report / wait-for-report, parent links with
// orphan handling, automatic notes to the world's Thoughts, usage and model routing (J647: no budgets) with one-step
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
import { routeModel, nextStep, ladderStep } from "./routing.mjs";
import { deniedBy } from "./modelcheck.mjs";
import { garbled } from "./garble.mjs";

export function createOrch({ stateDir, log = () => {}, deps }) {
  // deps: liveAgent(id) -> {id,name,room,model,thinking,session,conn?} | null; agentName(id); send(id, event, data) -> bool;
  //   open({id, room, name, icon, cwd, model, thinking, fork, twinOf, welcome, project}) -> {name, workspace};
  //   note(room, text); thoughtsReport(room, {from, text, final}); setModel(id, model, thinking) -> Promise;
  //   roomOf(parent) -> room
  const FILE = path.join(stateDir, "orch.json");
  let st = { children: {} };
  try { st = { children: {}, ...JSON.parse(fs.readFileSync(FILE, "utf8")) }; } catch { /* fresh */ }
  // J728 (J728Check caveat): older records get their completion pinned once, so later auto reports can't evict it
  for (const c of Object.values(st.children || {})) if (c && c.lastRealFinal === undefined && Array.isArray(c.reports)) c.lastRealFinal = !!c.reports.filter((r) => !r.auto).at(-1)?.final;
  const save = () => { try { fs.writeFileSync(FILE + ".tmp", JSON.stringify(st, null, 1)); fs.renameSync(FILE + ".tmp", FILE); } catch (e) { log("orch save", e.message); } };
  const waiters = new Set(); // { parent, ids:Set, any, resolve, timer, since }
  const live = (c) => c && !["closed"].includes(c.status);
  // J391: it gave its final report (the last one) or is being closed.
  // J728Check 3/F7: an auto report never un-finishes a child: the last REAL report decides (kept in lastRealFinal, which the
  // 20-report buffer can't evict; older records without it fall back to the buffer)
  const realFinal = (c) => c.lastRealFinal ?? !!c.reports.filter((r) => !r.auto).at(-1)?.final;
  const finished = (c) => !!c && (["closing", "closed"].includes(c.status) || realFinal(c));
  const childrenOf = (parent) => Object.values(st.children).filter((c) => c.parent === parent && live(c));
  const depthOf = (id) => { let d = 0, c = st.children[id]; while (c && d < 10) { d++; c = st.children[c.parent]; } return d; };
  const clip = (s, n = 160) => { s = String(s || "").replace(/\s+/g, " ").trim(); return s.length > n ? s.slice(0, n - 1) + "…" : s; };
  const nameOfParent = (parent) => parent.startsWith("thoughts:") ? `Thoughts-${parent.slice(9)}` : deps.agentName(parent);
  const view = (c) => c && ({ id: c.id, name: c.name, parent: c.parent, parent_name: c.parentName, status: c.status, model: c.model, thinking: c.thinking,
    routed: c.routed, why: c.why, budget: c.budget, used: c.used, started_at: c.startedAt, reports: c.reports.length, last_report: c.reports.at(-1)?.text || "", state: stateOf(c), // J452: its live state, not only orch's
    final: realFinal(c), escalations: c.escalations || 0, fork: !!c.fork, job: c.job || "", parent_job: c.parentJob || "" });

  function spawn(p, parent) {
    const P = loadPolicy(), O = P.orchestration || {};
    const isThoughts = parent.startsWith("thoughts:");
    if (!isThoughts) {
      // J202 safety net: a child closed on purpose more than 2 min ago whose window is gone counts as closed.
      for (const k of childrenOf(parent)) if (k.status === "closing" && Date.now() - (k.closingAt || 0) > 120e3 && !deps.liveAgent(k.id)) gone(k.id);
      const n = childrenOf(parent).length;
      if (n >= (O.maxChildren ?? 4)) throw new Error(`you already have ${n} live children (limit ${O.maxChildren ?? 4} in hyprpi.jsonc orchestration.maxChildren); close one first`);
      const d = depthOf(parent) + 1;
      if (d > (O.maxDepth ?? 1)) throw new Error(`a child at depth ${d - 1} may not spawn: helpers don't spawn helpers (J201 amended, J466): do the part yourself or report it to your parent (orchestration.maxDepth ${O.maxDepth ?? 1} in hyprpi.jsonc; only Angus raises it)`);
    }
    const prompt = String(p.prompt || "").trim();
    if (!prompt) throw new Error("give the child its prompt (what to do, done when, how to report)");
    const pa = isThoughts ? null : deps.liveAgent(parent);
    if (!isThoughts && !pa) throw new Error("the parent isn't a live agent");
    const room = isThoughts ? parent.slice(9) : deps.roomOf(parent);
    // Routing: explicit > complexity > default; a fork keeps the parent's model unless one is given.
    const r = p.fork && !p.model && !p.complexity ? { model: pa?.model || "", thinking: p.thinking || pa?.thinking || "", routed: false, why: "fork (parent's model)" }
      : routeModel({ model: p.model || "", thinking: p.thinking || "", complexity: p.complexity || "" }, P);
    // J647 (Angus: "why are we giving time/token budgets to our task agents? you can stop them whenever you want … it just
    // creates noise and extra decisions for me"): no caps, ever. A spawner's budget and the policy's are ignored; a parent stops
    // a helper with close_agent. (Replaces J130's budgets and J381's floor.)
    const budget = { tokens: 0, minutes: 0 };
    const id = deps.newId ? deps.newId(p.name) : "hp-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 5); // J543: a remote machine's own ids
    const parentName = nameOfParent(parent);
    const extras = p.subagents === true || p.subagents === "true" ? ["subagents"] : []; // J698: in-process Agent helpers for this child only
    const welcome = `[hyprpi · ${parentName} spawned you (spawn_agent) · you are its child]\n${prompt}\n\n` +
      `(How this works: your parent does NOT see what you write in your own window. Every answer, result or question for it goes through report_to_parent (or talk_reply when it asks you with a request id); final: true when the job is done, then stop. If a turn ends without one, hyprpi forwards your last message as an automatic report, but don't rely on that. ` +
      `${p.parentProject ? `You are a task agent of @${p.parentProject} (your parent is its project agent): after any decision (yours, or one made with you), send your parent a one-line digest with report_to_parent (not final), and put any report or handoff in ${p.parentFolder || "~/Obsidian/Projects/" + p.parentProject}/. ` : ""}` +
      `Your parent may close you after a final report. Model: ${r.model || "the default"}${r.thinking ? "/" + r.thinking : ""}${r.routed ? ` (routed: ${r.why})` : ""}. ` +
      `Never move Angus's focus.)` +
      (extras.includes("subagents") ? `\n\n(Your parent started you WITH pi-subagents (J698): you have the in-process Agent tool (with get_subagent_result and steer_subagent) for parallel read-only helpers inside your own process, e.g. reading a big file or many sources in parallel. They die with you and report inline; use them for this task's parts, then integrate. spawn_agent stays one level only.)` : "");
    const c = { id, name: "", parent, parentName, room, job: String(p.job || ""), parentJob: String(p.parent_job || ""), prompt: clip(prompt, 400), model: r.model, thinking: r.thinking, routed: r.routed, why: r.why,
      budget, used: { tokens: 0 }, startedAt: Date.now(), status: "starting", reports: [], escalations: 0, fork: !!p.fork, depth: isThoughts ? 1 : depthOf(parent) + 1, ...(extras.length ? { extras } : {}) };
    const o = deps.open({ id, room, name: p.name, icon: p.icon, cwd: p.cwd || (pa?.cwd) || "", model: r.model, thinking: r.thinking,
      fork: p.fork ? pa?.session || "" : "", twinOf: p.fork ? parent : "", welcome, project: p.project || "", extras });
    c.name = o.name; c.workspace = o.workspace;
    st.children[id] = c; save();
    deps.note(room, `🌱 ${parentName} spawned ${o.icon ? o.icon + " " : ""}${o.name}${p.fork ? " (a fork of itself)" : ""}${extras.length ? ` with ${extras.join(", ")}` : ""} on ${r.model || "the default model"}${r.thinking ? "/" + r.thinking : ""}${r.routed ? ` (${r.why})` : ""}: ${clip(prompt, 140)}`);
    log(`orch: ${parentName} spawned ${o.name} (${id}) ${r.model}/${r.thinking} ${r.why}`);
    return { id, name: o.name, workspace: o.workspace, model: r.model, thinking: r.thinking, routed: r.routed, why: r.why, budget, extras };
  }

  // A child's report. Resolves a waiting parent; otherwise delivered to the parent as a message.
  function report(childId, { text, final = false, auto = "" } = {}) {
    const c = st.children[childId];
    if (!c) throw new Error("you weren't spawned with spawn_agent, so you have no parent to report to (use talk_reply / room_post)");
    const t = String(text || "").trim(); if (!t) throw new Error("empty report");
    const rep = { text: t.slice(0, 20000), final: !!final, at: Date.now(), seq: (c.seq = (c.seq || c.reports.length) + 1), ...(auto ? { auto: String(auto) } : {}) }; // seq: J272 read cursor (two reports can share a millisecond)
    c.reports.push(rep); if (c.reports.length > 20) c.reports.splice(0, c.reports.length - 20);
    if (!auto) c.lastRealFinal = !!final; // J728Check F7: completion kept apart from the 20-report buffer (auto reports can't evict it)
    if (c.status === "budget" && final) c.status = "running";
    save();
    let taken = false;
    for (const w of [...waiters]) if (w.parent === c.parent && w.ids.has(childId)) { taken = true; tryResolve(w); }
    if (!taken) deliver(c, rep);
    if (final) deps.note(c.room, `📨 ${c.name} reported (final) to ${c.parentName}: ${clip(t, 140)}`);
    // Orphan policy "finish": its final report ends it.
    if (final && c.status === "orphaned") setTimeout(() => { try { close(childId, c.parent); } catch (e) { log("orch orphan close", e.message); } }, 1500).unref?.();
    // J663 (no silent success): say what really happened; a parent that isn't connected doesn't have it yet
    return { delivered: taken ? "to your waiting parent" : rep.undelivered ? `for your parent, which isn't connected right now: kept, and given to it when it reconnects` : rep.dropped ? "only to your record: you are being closed, so a progress note isn't sent to your parent (a final report still is)" : `to your parent as a message (handed to its window)` };
  }
  function deliver(c, rep) {
    if (!rep.final && ["closing", "closed"].includes(c.status)) { rep.dropped = true; return; } // J391: a closed child's late progress note
    const head = `[report from ${c.name} (${c.id})${rep.final ? " · final" : ""}${rep.auto ? ` · auto: ${rep.auto}` : ""} · your child, spawned for: ${clip(c.prompt, 80)}]`;
    if (c.parent.startsWith("thoughts:")) deps.thoughtsReport(c.parent.slice(9), { from: c.name, text: `${head}\n${rep.text}`, final: rep.final });
    else if (!deps.send(c.parent, "orch.report", { child: c.id, name: c.name, final: rep.final, text: `${head}\n${rep.text}\n\n(${rep.final ? `Done: close it with close_agent("${c.id}") when you've checked it, or send follow-ups with talk.` : "Not final yet."})` })) {
      // parent offline (mid-reload, crashed): kept and redelivered when it connects again (redeliver)
      rep.undelivered = true; save();
      log(`orch: report from ${c.name} kept (parent ${c.parentName} not connected)`);
    }
  }
  // J728 (Angus "105a y"; Kestrel and Marlin wrote their moves in their own windows and ended the turn without report_to_parent,
  // so their parent got nothing): when a child's turn ends, the daemon passes what the turn did (lib/topics.mjs turnInput). If
  // it neither reported (a report since the turn began, or a report_to_parent call) nor answered a message (talk_reply /
  // room_reply), its final text goes to the parent as ONE automatic, non-final report. A turn with no text says that instead
  // (no silent nothing). Once per turn (the turn's start time is the key). Not for a closing / closed / orphaned child.
  // A report_to_parent call counts only through the report it really made (a failed call made none: J728Check 4); talk_reply /
  // room_reply answer a message, and their own tool says when they fail.
  const ANSWERED = new Set(["talk_reply", "room_reply"]);
  function turnEnded(childId, { final = "", toolNames = [], startedAt = 0, unreadable = false, endedAt = 0 } = {}) {
    const c = st.children[childId];
    if (!c || !["running", "starting", "budget"].includes(c.status)) return { sent: false, why: c ? `child is ${c.status}` : "not a child" };
    // t0: the turn's start (from its session; the daemon's own start time when the session couldn't be read). Without one
    // (an unstamped session) old reports can't be told from this turn's, so none suppresses it; the key is then the text.
    const t0 = Number(startedAt) || 0, key = t0 || `text:${String(final || "").slice(0, 200)}`;
    if (c.autoTurn === key) return { sent: false, why: "already sent for this turn" };
    if ((toolNames || []).some((n) => ANSWERED.has(n))) return { sent: false, why: "the turn reported or replied" };
    const t1 = Number(endedAt) || Infinity; // J728Check F6: only reports made DURING this turn (a newer turn's report isn't this one's)
    if (t0 && c.reports.some((r) => !r.auto && r.at >= t0 && r.at <= t1)) return { sent: false, why: "a report during the turn" };
    c.autoTurn = key;
    const text = unreadable ? "(its turn ended without a report, and hyprpi couldn't read its session to see what it said: ask it, or look at its window)"
      : String(final || "").trim() || "(its turn ended with no text and no report: ask it what it found, or look at its window)";
    const r = report(childId, { text, auto: "its turn ended without report_to_parent; this is its last message in its own window" });
    return { sent: true, ...r };
  }

  // Knock's J130 finding 6: reports that couldn't be delivered (the parent was reloading) arrive when it's back.
  function redeliver(parent) {
    let n = 0;
    for (const c of Object.values(st.children)) if (c.parent === parent) for (const r of c.reports) if (r.undelivered) {
      delete r.undelivered;
      if (!r.final && (finished(c) || c.reports.some((x) => x.final && x.at >= r.at))) continue; // J391: stale once the child finished
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
  // J452 (Angus: "a perennial problem"; Doorview sat 40 min on a report that was already in): (1) a report the parent hasn't read
  // yet (it came before the wait, or while the parent was mid-turn) makes the wait return AT ONCE, in "all" mode too, with
  // what's still out; `since` only adds older reports, it never hides an unread one. (2) Every wait has a limit
  // (orchestration.waitDefaultSec, at most waitMaxSec); at the limit it says, per child, "no report after N min" and the
  // child's state (working, idle N min, closed, not connected). (3) In "all" mode a child that is idle for a
  // minute or more with no report (its turn ended without one) no longer holds the wait.
  const limits = () => { const O = loadPolicy().orchestration || {}; const max = Math.max(1, Number(O.waitMaxSec) || 3600); return { def: Math.min(max, Math.max(1, Number(O.waitDefaultSec) || 600)), max }; };
  function stateOf(c) { // the child's state in plain words, from orch (closed) and the daemon's live view of its turn
    if (!c) return "gone"; if (["closed", "orphaned"].includes(c.status)) return c.status; if (c.status === "closing") return "closing"; 
    const a = deps.agentInfo?.(c.id); if (!a) return c.status === "starting" ? "starting" : "not connected";
    const min = Math.round((Date.now() - (a.since || Date.now())) / 60000);
    return a.status === "working" ? `working${min ? ` (${min} min)` : ""}` : `${a.status}${min ? ` ${min} min` : ""} (its turn ended without a report)`;
  }
  const idleLong = (c) => { if (!c || !["running", "starting"].includes(c.status)) return false; const a = deps.agentInfo?.(c.id); return !!a && ["idle", "done"].includes(a.status) && Date.now() - (a.since || Date.now()) >= 60000 && (a.since || 0) > (c.startedAt || 0); };
  function wait(parent, ids, { timeoutSec = 0, any = false, since = 0 } = {}) {
    const want = (ids && ids.length ? ids : childrenOf(parent).map((c) => c.id)).map(String);
    for (const id of want) { const c = st.children[id]; if (!c) throw new Error(`no child ${id}`); if (c.parent !== parent) throw new Error(`${c.name} isn't your child`); }
    if (!want.length) return Promise.resolve({ reports: [], timed_out: false, still_working: [], note: "you have no live children" });
    const L = limits(), sec = Math.min(L.max, Math.max(1, Number(timeoutSec) || L.def));
    return new Promise((resolve) => {
      const w = { parent, ids: new Set(want), any, since: Number(since) || 0, resolve, timer: null, t0: Date.now(), sec };
      w.timer = setTimeout(() => { waiters.delete(w); const r = result(w, true); markRead(r); resolve(r); }, sec * 1000);
      w.timer.unref?.();
      waiters.add(w);
      // J452 (1): anything unread already: back at once, whatever the mode
      const now = result(w, false);
      if (now.reports.length) { clearTimeout(w.timer); waiters.delete(w); markRead(now); resolve({ ...now, already: true }); return; }
      tryResolve(w);
      // (StallReview) a child that went idle less than a minute before this wait: look again when that minute is up
      if (waiters.has(w)) for (const id of want) { const c = st.children[id], a = c && deps.agentInfo?.(c.id);
        if (a && ["idle", "done"].includes(a.status) && !idleLong(c)) setTimeout(() => { if (waiters.has(w)) tryResolve(w); }, Math.max(500, 60000 - (Date.now() - (a.since || Date.now())) + 500)).unref?.(); }
    });
  }
  function result(w, timedOut) {
    const reports = [], still = [];
    for (const id of w.ids) {
      const c = st.children[id], from = c?.readAt || c?.startedAt || 0;
      const unread = (r) => (r.seq != null && c.readSeq != null ? r.seq > c.readSeq : r.at >= from);
      const fresh = (c?.reports || []).filter((r) => unread(r) || (w.since && r.at >= w.since));
      if (fresh.length) reports.push({ id, name: c.name, final: !!fresh.at(-1).final, text: fresh.map((r) => (r.auto ? `[auto: ${r.auto}]\n` : "") + r.text).join("\n---\n") }); // J728Check F5: the auto label stays
      else still.push({ id, name: c?.name || id, status: c?.status || "gone", state: stateOf(c) });
    }
    const r = { reports, timed_out: timedOut, still_working: still };
    const dur = (ms) => (ms < 90000 ? `${Math.round(ms / 1000)} s` : `${Math.round(ms / 60000)} min`);
    if (timedOut && still.length) r.note = still.map((s) => `no report from ${s.name} after ${dur(Date.now() - w.t0)}; it is ${s.state}`).join("; ");
    return r;
  }
  function tryResolve(w) {
    const r = result(w, false);
    const gone = r.still_working.filter((s) => ["closed", "orphaned", "gone"].includes(s.status) || idleLong(st.children[s.id]));
    const ready = w.any ? r.reports.length > 0 : r.still_working.length === gone.length && (r.reports.length > 0 || gone.length > 0);
    if (ready) { clearTimeout(w.timer); waiters.delete(w); markRead(r); w.resolve(r); }
  }
  // J452 (3): the daemon calls this when an agent goes idle, so an "all" wait held by it can end
  const settled = (id) => { for (const w of [...waiters]) if (w.ids.has(id)) setTimeout(() => { if (waiters.has(w)) tryResolve(w); }, 61000).unref?.(); };

  function close(id, by, { reason = "" } = {}) {
    const c = st.children[id];
    if (!c) throw new Error(`no spawned agent ${id}`);
    if (by !== c.parent && by !== id && !String(by).startsWith("thoughts:")) throw new Error(`only ${c.parentName} (its parent), Thoughts or ${c.name} itself can close it`);
    if (c.status === "closed") return { already: true, id: c.id, name: c.name };
    c.status = "closing"; c.closingAt = Date.now(); c.closedBy = by === id ? "itself" : nameOfParent(by) || by; save();
    const sent = deps.send(id, "orch.close", { by: c.closedBy, reason });
    if (!sent) gone(id, { quiet: false }); // not connected: closed now
    return { id: c.id, name: c.name, closing: sent, last_report: c.reports.at(-1)?.text || "" };
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

  // Usage: the child's extension reports its token use (shown in my_children and hyprpi top; J647: no caps).
  function usage(id, { tokens = 0 } = {}) {
    const c = st.children[id]; if (!c) return { none: true };
    c.used.tokens = Math.max(c.used.tokens || 0, Number(tokens) || 0); save();
    return { budget: c.budget, used: c.used, started_at: c.startedAt, status: c.status };
  }
  // J647: there are no budgets. An older agent extension still caches caps (from its spawn) and may stop itself at one: on every
  // (re)connect and at any cap it reports, the daemon sends it "no caps" (orch.budget 0/0, resumed), which its own handler
  // takes: its cap check sees no cap, and a self-stopped one unblocks and carries on. No note, no escalation, nothing to Angus.
  // (NoBudgetCheck) an orphan (still finishing its step) gets "no caps" too and keeps its orphaned status; a child that has
  // given its final report, or is closing / closed, is left alone (nothing to resume, no late notice)
  function lift(id) {
    const c = st.children[id]; if (!c || ["closed", "closing"].includes(c.status) || finished(c)) return false;
    const was = c.status === "budget"; c.budget = { tokens: 0, minutes: 0 }; if (was) c.status = "running"; save();
    deps.send(id, "orch.budget", { budget: c.budget, used: c.used, startedAt: c.startedAt, resumed: true });
    return true;
  }
  async function budgetHit(id) { const c = st.children[id]; lift(id); return { status: c?.status, ignored: true }; }

  // J272 fix 4 (J269: Claw waited on SlackRead after it had died on rate limits; only a report, a close or the
  // timeout woke a wait): a child that stalls (its turn ended on an error, or it has been idle
  // for orchestration.idleMinutes without a final report) tells its parent once per stall: a running
  // wait_report returns with why, else the parent gets it as a message.
  function stalled(id, why) {
    const c = st.children[id]; if (!c || !live(c)) return false;
    if (finished(c)) return false; // J391: a child that gave its final report or is closing has nothing more to tell
    if (c.stall && c.stall.why === why && Date.now() - c.stall.at < 10 * 60000) return false;
    c.stall = { why, at: Date.now() }; save();
    const msg = `${c.name} (${c.id}) stalled: ${why}`;
    let woke = 0;
    for (const w of [...waiters]) if (w.parent === c.parent && w.ids.has(id)) { clearTimeout(w.timer); waiters.delete(w); woke++; const r = result(w, false); markRead(r); w.resolve({ ...r, woken: msg }); }
    if (!woke) {
      const text = `[hyprpi · your child ${msg}]\nCheck it (my_children), then send it a talk, escalate_agent or close_agent.`;
      if (c.parent.startsWith("thoughts:")) deps.thoughtsReport(c.parent.slice(9), { from: c.name, text, final: false });
      else deps.send(c.parent, "orch.report", { child: c.id, name: c.name, final: false, text });
    }
    deps.note(c.room, `⚠ ${msg}${woke ? ` (${c.parentName}'s wait_report woken)` : ` (told ${c.parentName})`}`);
    log(`orch: ${msg}`);
    if (/^model output garbled/.test(why)) { const modelAtStall = c.model, thinkAtStall = c.thinking || "", escAtStall = c.escalations || 0; setTimeout(() => { garbledReaction(id, why, modelAtStall, thinkAtStall, escAtStall).catch((e) => log("orch garbled reaction:", e.message)); }, 0); } // J394
    return true;
  }
  // J394 (Angus: "ban it so we never choose it again"): a helper whose first reply the J392 guard flagged as garbled
  // (1) takes its exact model off the host list (J397: pi enabledModels; was modelDeny) and (2) moves its job one step on, once, and Thoughts hears it in a line.
  // A model on the routing ladder is NOT banned on a single flag (that could take a rung out of every route): it is banned on
  // the second flag, and Thoughts is told loudly the first time. The flag counts are kept in orch.json (garbleFlags).
  async function garbledReaction(id, why, modelAtStall, thinkAtStall = "", escAtStall = 0) {
    const c = st.children[id]; if (!c || c.garbleHandled) return; c.garbleHandled = true; save();
    const P = loadPolicy(), R = P.routing || {}, model = String(modelAtStall || "").trim(); // the model that produced the reply, not whatever it was switched to since
    const tell = (text) => { deps.note(c.room, text); try { deps.roomPost?.(c.room, text); } catch { /* none */ } try { deps.thoughtsReport(c.room, { from: c.name, text: `[hyprpi · garble guard] ${text}`, final: false }); } catch { /* no thread */ } };
    // The child's own word isn't evidence (any agent can call orch.stalled with that text): the daemon reads the first reply from
    // the child's session file and judges it itself; unverified -> a notice only, nothing banned or moved.
    let verdict = ""; try { const fr = await deps.firstReply?.(id); const sameModel = !!fr?.model && (fr.model === model || `${fr.provider}/${fr.model}` === model) /* the identity must match in full; a missing one is no evidence */; verdict = fr && sameModel ? garbled(fr, fr.prompt || c.prompt || "") : ""; } catch { /* unverified */ }
    if (!verdict) { deps.note(c.room, `⚠ ${c.name} says its first reply was garbled (${why.slice(0, 80)}), but the daemon couldn't confirm it from the session, so nothing was banned or moved: check it`); return; }
    why = `model output garbled: ${verdict}`;
    if (!model) { tell(`⚠ ${c.name}'s first reply was garbled, but its model is the default (unknown id), so nothing was banned and it wasn't moved: check it by hand`); return; }
    const flags = (st.garbleFlags ||= {}); flags[model] = (flags[model] || 0) + 1; save();
    const onLadder = ladderStep(model, "", R.ladder || []) >= 0 || Object.values(R.kinds || {}).some((v) => typeof v === "string" && ladderStep(model, "", [v]) >= 0);
    let banned = "", loud = "";
    if (onLadder && flags[model] < 2) loud = ` ⚠ ${model} is a ROUTING LADDER model, so it was NOT banned on one flag (a ban would take a rung out of every route); a second garbled first reply bans it. Tell me to ban it now if you want.`;
    else try { const r = deps.banModel(model, { helper: c.name, why: why.replace(/^model output garbled:\s*/, "") }); banned = r.removed ? `took ${model} off the scoped model list (${r.how}; backup ${r.backup})` : `${model} was already off the scoped model list`; }
    catch (e) { loud = ` ⚠ couldn't ban ${model}: ${e.message}`; }
    // the job moves on once: one ladder step up, skipping any step that is now denied; off the ladder (or no step) -> the routing default
    const pol = loadPolicy(), denied = (m) => deniedBy(m, pol.modelDeny) || (deps.allowed && !deps.allowed(m)); // off the host's list (J397) or on the old deny shim
    let target = null, cur = { model, thinking: c.thinking || "" };
    for (let k = 0; k < 8 && !target; k++) { const n = onLadder || k ? nextStep(cur.model, cur.thinking, pol, { ignoreCeiling: false }) : null; if (!n) break; if (!denied(n.model)) target = n; else cur = { model: n.model, thinking: n.thinking }; }
    if (!target) { try { const r = routeModel({}, pol) /* the routing default kind */; if (r.model && !denied(r.model) && r.model !== model) target = r; } catch { /* none */ } }
    let moved = "";
    for (let w = 0; c.escalating && w < 600; w++) await new Promise((r) => setTimeout(r, 100)); // wait for a running escalation (the lock is shared with escalate())
    if (String(c.model || "") !== model || (c.thinking || "") !== thinkAtStall || (c.escalations || 0) !== escAtStall) moved = ` ${c.name} was already moved to ${c.model}${c.thinking ? "/" + c.thinking : ""} meanwhile.`;
    else if (c.escalating) moved = ` ${c.name} is being moved by another escalation: check it.`;
    else if (target) {
      c.escalating = true;
      try {
        await deps.setModel(id, target.model, target.thinking);
        const before = `${c.model}/${c.thinking}`; c.model = target.model; c.thinking = target.thinking; c.escalations = (c.escalations || 0) + 1; c.stall = null; save();
        deps.send(id, "orch.report", { child: id, name: c.name, final: false, text: `[hyprpi · your model was switched to ${target.model}${target.thinking ? "/" + target.thinking : ""} because your first reply was garbled]\nIgnore that reply. Start the job from the beginning, from your first message, and carry on.` });
        moved = ` ${c.name} moved ${before} → ${target.model}/${target.thinking}.`;
      } catch (e) { moved = ` couldn't move ${c.name} (${String(e.message).slice(0, 120)}): switch it by hand.`; } finally { c.escalating = false; }
    } else moved = ` no other model to move ${c.name} to: switch it by hand.`;
    tell(`⛔ ${c.name}'s first reply on ${model} was garbled (${why.replace(/^model output garbled:\s*/, "").slice(0, 100)}).${banned ? " " + banned + "." : ""}${moved}${loud}`);
  }
  // Children idle without a final report (checked every minute).
  function checkIdle() {
    const min = Number(loadPolicy().orchestration?.idleMinutes ?? 10);
    if (!(min > 0) || !deps.agentInfo) return;
    for (const c of Object.values(st.children)) {
      if (!live(c) || c.status === "budget" || c.reports.at(-1)?.final) continue;
      const a = deps.agentInfo(c.id); if (!a || !["idle", "done"].includes(a.status)) continue;
      const since = Math.max(a.since || 0, c.reports.at(-1)?.at || 0, c.startedAt || 0);
      if (Date.now() - since >= min * 60000 && !(c.stall && c.stall.at >= since)) stalled(c.id, `idle for ${Math.round((Date.now() - since) / 60000)} min without a final report`);
    }
  }
  setInterval(() => { try { checkIdle(); } catch (e) { log("orch idle check:", e.message); } }, 60000).unref?.();
  function extend(id, by) { // J647: only lifts an older spawn's caps (an older agent extension may still call it)
    const c = st.children[id]; if (!c) throw new Error(`no spawned agent ${id}`);
    if (by !== c.parent && !String(by).startsWith("thoughts:")) throw new Error(`only ${c.parentName} or Thoughts can lift ${c.name}'s caps`);
    c.budget = { tokens: 0, minutes: 0 }; // J647: no caps; extending only lifts whatever an older spawn had
    c.stall = null;
    const wasStopped = c.status === "budget"; if (wasStopped) c.status = "running";
    save();
    deps.send(id, "orch.budget", { budget: c.budget, used: c.used, startedAt: c.startedAt, resumed: wasStopped });
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
    if (c.escalating) return { skipped: "an escalation is already under way" }; // J394: even an explicit one waits (a garble recovery or another escalation holds the switch)
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

  // J652 (Angus: "after a reboot restore the children know their parents, so reopening should too"): a child closed with
  // close_agent (or whose window went away) that is reopened on its id (agent-reopen, hyprpi new --id … -- --session …) gets its
  // parent link back when that parent is live (an agent connected now, or a world's Thoughts, which starts when talked to).
  // With no live parent it stays closed: no link, nothing to report to.
  const parentLive = (c) => !!c?.parent && (c.parent.startsWith("thoughts:") || !!deps.agentInfo?.(c.parent));
  function reopened(c) {
    if (!c || c.status !== "closed" || !parentLive(c)) return false;
    c.status = "running"; delete c.closedAt; delete c.closedBy; delete c.closingAt; c.stall = null; save();
    deps.note(c.room, `↩ ${c.name} reopened: linked to ${c.parentName} again`);
    return true;
  }
  const onHello = (id) => { const c = st.children[id]; if (!c) return null; if (deps.agentInfo?.(id)) reopened(c); /* (only a connected child) */ if (c.status === "starting" || c.status === "budget") { c.status = "running"; } c.budget = { tokens: 0, minutes: 0 }; save(); /* J647: no caps (older spawns' are lifted) */ return { budget: c.budget, used: c.used, startedAt: c.startedAt, status: c.status, parent: c.parentName }; };
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
    for (const x of r.reports || []) { const c = st.children[x.id], last = c?.reports?.at(-1); if (c && last) { c.readAt = Math.max(c.readAt || 0, last.at + 1); if (last.seq != null) c.readSeq = Math.max(c.readSeq || 0, last.seq); changed = true; } }
    if (changed) save();
  }
  return { settled, turnEnded, limits, redeliver, spawn, report, wait, wake, stalled, checkIdle, close, gone, usage, budgetHit, lift, reopen: (id) => reopened(st.children[id]), extend, escalate, onHello, children, get, linkOf, all: () => Object.values(st.children).map(view) };
}
