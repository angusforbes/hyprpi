/**
 * J130 orchestration primitives, the agent side (daemon: lib/orch.mjs). Tools: spawn_agent, report_to_parent,
 * wait_report, close_agent, extend_budget, escalate_agent, my_children. Events from the daemon:
 * orch.report (a child's report, as a message), orch.close (close this agent at its next idle moment),
 * orch.budget (a new budget / resumed), orch.orphaned (its parent went away).
 * Budgets (spawned agents only): token use (input + output + cache writes of its own model calls; cache READS
 * aren't counted, so a cap counts fresh tokens, not the context re-read on every call) and wall
 * time since it was spawned. At a cap: one steer to stop, report and wait; tools other than report_to_parent
 * are blocked until extend_budget.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { garbled } from "../lib/garble.mjs";

type Deps = { call: (m: string, p?: any, o?: any) => Promise<any>; inject: (m: any, steer?: boolean) => void; idle: () => boolean; ctx: () => any; flushHeld?: () => number; dropHeld?: (pred: (m: any) => boolean) => number };

export function orchAgent(pi: ExtensionAPI, { call, inject, idle, ctx, flushHeld, dropHeld }: Deps) {
  let waits = 0; // J272: wait_report calls running now (index.ts wakes them when a message arrives)
  const text = (t: string, details: any = {}) => ({ content: [{ type: "text" as const, text: t }], details });
  let me: any = null; // { budget, used, startedAt, status, parent } when this agent was spawned
  let tokens = 0, stopped = false, closing: any = null, lastSent = 0, calls = 0, toolCalls = 0, lastErr = "";
  const loadMe = async () => { try { me = await call("orch.me"); if (me?.used?.tokens) tokens = Math.max(tokens, me.used.tokens); if (me?.status === "budget") stopped = true; } catch { /* not spawned / offline */ } };
  pi.on("session_start", async () => { setTimeout(loadMe, 1500); setTimeout(() => { if (!me) loadMe(); }, 10000); });

  // --- budgets ---
  const over = () => {
    if (!me?.budget) return "";
    if (me.budget.tokens && tokens >= me.budget.tokens) return `token budget (${Math.round(me.budget.tokens / 1000)}k)`;
    if (me.budget.minutes && Date.now() - me.startedAt >= me.budget.minutes * 60000) return `time budget (${me.budget.minutes} min)`;
    return "";
  };
  pi.on("message_end", async (e: any) => {
    const m = e?.message;
    if (m?.role !== "assistant" || !me?.budget) return;
    const u = m.usage || {};
    // J272 fix 5: the first call's input and cache write are the start-up context (system prompt, tools, skills,
    // ~50k: ShellSources' 16k budget was gone before its first tool call); only its output counts.
    tokens += calls++ === 0 ? (u.output || 0) : (u.input || 0) + (u.output || 0) + (u.cacheWrite || 0);
    if (Date.now() - lastSent > 15000) { lastSent = Date.now(); call("orch.usage", { tokens }).catch(() => {}); }
    checkCap();
  });
  function checkCap() {
    const what = over();
    if (!what || stopped) return;
    stopped = true;
    call("orch.usage", { tokens }).catch(() => {});
    call("orch.budgetHit", { what, early: toolCalls === 0 }).catch(() => {});
    inject({ customType: "hyprpi-orch", display: true, content: `[hyprpi · budget reached: ${what}]\nStop now. Call report_to_parent with what you have so far, what's left and what you'd need to finish (not final unless it's done), then end your turn. Other tools are blocked until your parent extends your budget.`, details: { request_id: `orch-budget-${Date.now()}` } }, true);
  }
  // The time cap also while one long tool call runs (Knock's J130 finding 4): the steer lands at its end, and
  // the tools after it are blocked.
  setInterval(() => { if (me?.budget?.minutes) checkCap(); }, 30000).unref?.();
  pi.on("tool_call", async (e: any) => {
    toolCalls++;
    if (!stopped) return;
    const n = e?.toolName || e?.name || "";
    if (n === "report_to_parent" || n === "my_children" || n === "wait_report" || n === "close_agent") return;
    return { block: true, reason: "budget reached: call report_to_parent with your progress and what's left, then end your turn and wait for extend_budget" };
  });

  // --- closing at the next idle moment ---
  const tryClose = () => {
    if (!closing || !idle()) return;
    const c = ctx(); closing = null;
    try { c?.ui?.notify?.("🍂 closed by the parent (close_agent)", "info"); } catch { /* no ui */ }
    setTimeout(() => { try { c?.shutdown?.(); } catch { /* gone */ } }, 300);
    // pi completes a requested shutdown after its current command or run; an idle RPC-mode pi may never
    // get one, so a SIGTERM (pi's orderly exit) follows if it's still here.
    setTimeout(() => { try { process.kill(process.pid, "SIGTERM"); } catch { /* gone */ } }, 8000).unref?.();
  };
  pi.on("agent_end", async () => { setTimeout(tryClose, 200); });
  // J272 fix 4: a spawned agent whose turn ended on an error (rate limit, overload, …) tells its parent.
  pi.on("message_end", async (e: any) => { const m = e?.message; if (m?.role === "assistant") lastErr = m.stopReason === "error" ? String(m.errorMessage || "error") : ""; });
  // J392: the first reply of a spawned agent is checked for garbage (leaked template tokens, a script the task doesn't use,
  // empty with no usage: a model that passes a short probe but breaks under the full agent prompt); lib/garble.mjs.
  let firstSeen = false, firstPrompt = "", garble = "";
  const textOf = (c: any) => (Array.isArray(c) ? c.filter((x: any) => x?.type === "text").map((x: any) => String(x.text || "")).join("") : String(c ?? ""));
  pi.on("message_end", async (e: any) => {
    const m = e?.message; if (firstSeen || !m) return;
    if (m.role === "user" || m.role === "custom") { firstPrompt += "\n" + textOf(m.content); return; } // every task message before the first reply (a busy delivery arrives as a custom message)
    if (m.role !== "assistant") return;
    firstSeen = true;
    const why = garbled({ text: textOf(m.content), hasToolCall: Array.isArray(m.content) && m.content.some((x: any) => x?.type === "toolCall"), usage: m.usage, stopReason: m.stopReason }, firstPrompt);
    if (why) garble = why;
  });
  pi.on("agent_end", async () => { if (garble) { const why = `model output garbled: ${garble}`; garble = ""; if (!me) await loadMe(); if (me) call("orch.stalled", { why }).catch(() => {}); } });
  pi.on("agent_end", async () => { if (me && lastErr) { const why = `its turn ended on an error: ${lastErr.replace(/\s+/g, " ").slice(0, 200)}`; lastErr = ""; call("orch.stalled", { why }).catch(() => {}); } });

  // J391 (Ledger, J377: old budget / progress / stall notices kept arriving after it had taken its helpers' final
  // reports and closed them): once a child's final report is taken or the child is closed, its not-yet-delivered
  // non-final notices are dropped (a held final report stays).
  const dropStale = (ids: string[]) => { const set = new Set(ids.filter(Boolean)); if (!set.size) return 0; return dropHeld?.((m: any) => m?.customType === "hyprpi-orch" && set.has(m?.details?.orch_child) && !m?.details?.orch_final) || 0; };
  const onEvent = (event: string, d: any) => {
    if (event === "orch.report") {
      inject({ customType: "hyprpi-orch", display: true, content: String(d?.text || ""), details: { request_id: `orch-report-${d?.child}-${Date.now()}`, orch_child: d?.child || "", orch_final: !!d?.final } });
    } else if (event === "orch.close") {
      closing = d || {}; tryClose();
    } else if (event === "orch.budget") {
      me = { ...(me || {}), budget: d?.budget, startedAt: d?.startedAt ?? me?.startedAt };
      if (d?.resumed && stopped) {
        stopped = false;
        inject({ customType: "hyprpi-orch", display: true, content: `[hyprpi · your budget was extended to ${Math.round((d.budget?.tokens || 0) / 1000)}k tokens / ${d.budget?.minutes || 0} min]\nCarry on with the job from where you stopped.`, details: { request_id: `orch-extend-${Date.now()}` } });
      }
    } else if (event === "orch.orphaned") {
      inject({ customType: "hyprpi-orch", display: true, content: `[hyprpi · your parent ${d?.parent || ""} went away]\nFinish the step you're on (don't start new work), then call report_to_parent with final: true (it now goes to ${d?.thoughts || "your world's Thoughts"}) and stop; you'll be closed after that.`, details: { request_id: `orch-orphan-${Date.now()}` } });
    }
  };

  // --- tools ---
  pi.registerTool({
    name: "spawn_agent",
    label: "Spawn an agent",
    description: "Open a new hyprpi agent (your CHILD) in its own window for a bounded job, silently (Angus's focus never moves). Budget: tokens count fresh input + output + cache writes (cached context re-reads don't count) and minutes since spawn. Give it a complete prompt: goal, files it may touch, done-when, and to report_to_parent. Its model: an explicit model wins; else complexity picks one from the routing rules in ~/.config/hyprpi/hyprpi.jsonc (simple / ordinary / hard / review); else the default. fork: true starts it from YOUR conversation (a twin with your context). Returns its id; its reports come back to you as messages, or block on them with wait_report. Close it with close_agent when done. Your world's Thoughts is told automatically.",
    promptSnippet: "Open a child agent for a bounded job (silent; reports back to you)",
    // J201 (Angus: "agents should be encouraged to split subtasks into further subtasks and to spawn temporary agents
    // as needed or to commandeer existing agents … the power to change models and thinking levels on the fly").
    promptGuidelines: [
      "Parallel work (Angus): break your task into subtasks, and those into further subtasks, when the parts are independent; spawn temporary helper agents for them with spawn_agent (a complete brief each, done-when, report_to_parent), wait_report for their results, integrate, and close_agent each one when its result is in. Don't split work whose parts depend on each other, or work too small to repay the coordination.",
      "You may also commandeer an EXISTING agent for a subtask, but only a free one (idle or done, never one mid-turn): ask it with talk/demand so the request is tracked, and say what to report back.",
      "Pick the model and thinking level per helper: complexity simple (cheap, fast: look-ups, quick checks), ordinary or hard (building, diagnosis), review (another model family, for an independent test of work you or a helper built); an explicit model / thinking wins. Budgets, the orphan cleanup and the independent-tester rule still apply.",
    ],
    parameters: Type.Object({
      prompt: Type.String({ description: "the child's whole brief: goal, limits, done-when, how to report" }),
      name: Type.Optional(Type.String({ description: "a short purpose name (unique among live agents), e.g. Linkcheck" })),
      icon: Type.Optional(Type.String({ description: "one emoji" })),
      complexity: Type.Optional(Type.String({ description: "simple | ordinary | hard | review (or another kind from the routing rules); picks the model" })),
      model: Type.Optional(Type.String({ description: "explicit provider/id (wins over complexity)" })),
      thinking: Type.Optional(Type.String({ description: "off | minimal | low | medium | high | xhigh | max" })),
      fork: Type.Optional(Type.Boolean({ description: "start from your own conversation (a twin) instead of empty" })),
      cwd: Type.Optional(Type.String()),
      project: Type.Optional(Type.String({ description: "@project it joins" })),
      budget: Type.Optional(Type.Object({ tokens: Type.Optional(Type.Number()), minutes: Type.Optional(Type.Number()) })),
    }, { additionalProperties: false }),
    execute: async (_id: string, p: any) => {
      const r = await call("orch.spawn", p, p.model ? { timeoutMs: 120000 } : undefined); // J383: an explicit model is test-called first
      return text(`Spawned ${r.name} (${r.id}) on ${r.workspace}, ${r.model || "default model"}${r.thinking ? "/" + r.thinking : ""}${r.routed ? ` (routed: ${r.why})` : ""}; budget ${Math.round((r.budget?.tokens || 0) / 1000)}k tokens / ${r.budget?.minutes || 0} min. It reports back to you; wait_report blocks until it does.`, r);
    },
  });
  pi.registerTool({
    name: "report_to_parent",
    label: "Report to parent",
    description: "Only for an agent spawned with spawn_agent: send your result (or progress / what's blocking you) to the agent or Thoughts that spawned you. final: true when the job is done (then stop; your parent closes you).",
    parameters: Type.Object({ text: Type.String({ minLength: 1 }), final: Type.Optional(Type.Boolean()) }, { additionalProperties: false }),
    execute: async (_id: string, p: any) => { const r = await call("orch.report", p); return text(`Reported ${r.delivered}.${p.final ? " That was final: end your turn now." : ""}`, r); },
  });
  pi.registerTool({
    name: "wait_report",
    label: "Wait for reports",
    description: "Block until your children report (all of them, or any: true for the first), or the timeout. No polling needed: the daemon answers when a report arrives. ids: child ids or names (default: all your live children). Reports since `since` (ms epoch; default: now) count, so a report that arrived just before the call isn't missed if you pass the spawn time.",
    parameters: Type.Object({ ids: Type.Optional(Type.Array(Type.String())), timeout_sec: Type.Optional(Type.Number({ description: "default 600, max 3600" })), any: Type.Optional(Type.Boolean()), since: Type.Optional(Type.Number()) }, { additionalProperties: false }),
    // J272 fix 2 (J269: an interrupt or Esc couldn't stop a 30-min wait, so Thoughts' messages sat stuck until it
    // returned): Esc / interrupt_agent (the tool's abort signal) ends the wait at once (daemon orch.unwait), and so
    // does a message that arrives for this agent meanwhile (index.ts); those messages are then steered in right
    // after this result, so they're answered in this turn.
    execute: async (_id: string, p: any, signal?: AbortSignal) => {
      const t = Math.max(1, Math.min(3600, Number(p.timeout_sec) || 600));
      const onAbort = () => { call("orch.unwait", { why: "stopped (Esc or an interrupt)" }).catch(() => {}); };
      if (signal?.aborted) throw new Error("stopped before it started waiting");
      signal?.addEventListener?.("abort", onAbort, { once: true });
      waits++;
      let r: any;
      try {
        // The daemon ends the wait itself (orch.unwait), so its waiter is gone too: no report can be taken by a wait
        // nobody reads any more. (A daemon without orch.unwait: the wait runs on as before.)
        r = await call("orch.wait", p, { timeoutMs: (t + 30) * 1000 });
      } finally { waits--; signal?.removeEventListener?.("abort", onAbort); }
      dropStale(r.reports.filter((x: any) => x.final).map((x: any) => x.id)); // J391
      const lines = r.reports.map((x: any) => `## ${x.name} (${x.id})${x.final ? " · final" : ""}\n${x.text}`);
      const woke = r.woken ? (/message/.test(String(r.woken)) ? `Woken early: ${r.woken}; it follows this result, so answer it first, then call wait_report again if you still need to. ` : `Ended early: ${r.woken === true ? "woken" : r.woken}. `) : "";
      if (r.woken && /message/.test(String(r.woken))) setTimeout(() => flushHeld?.(), 0);
      return text(`${woke}${r.timed_out ? "Timed out. " : ""}${r.reports.length} report(s)${r.still_working.length ? `; no report yet from: ${r.still_working.map((s: any) => `${s.name} (${s.status})`).join(", ")}` : ""}.\n\n${lines.join("\n\n")}`, r);
    },
  });
  pi.registerTool({
    name: "close_agent",
    label: "Close an agent",
    description: "Close a child you spawned (id or name) once you've taken its result, or yourself (no id) when you're a spawned agent that's finished. It closes at its next idle moment; its last report is kept.",
    parameters: Type.Object({ id: Type.Optional(Type.String()), reason: Type.Optional(Type.String()) }, { additionalProperties: false }),
    execute: async (_id: string, p: any) => { const r = await call("orch.close", p); dropStale([r.id]); return text(r.already ? `${r.name} was already closed.` : `Closing ${r.name}${r.closing ? " (at its next idle moment)" : " (it wasn't connected: closed now)"}.`, r); },
  });
  pi.registerTool({
    name: "extend_budget",
    label: "Extend a child's budget",
    description: "Give a child that hit its budget more tokens and/or minutes (none given: the default amounts again); it carries on.",
    parameters: Type.Object({ id: Type.String(), tokens: Type.Optional(Type.Number()), minutes: Type.Optional(Type.Number()) }, { additionalProperties: false }),
    execute: async (_id: string, p: any) => { const r = await call("orch.extend", p); return text(`${r.name}: budget now ${Math.round(r.budget.tokens / 1000)}k tokens / ${r.budget.minutes} min.`, r); },
  });
  pi.registerTool({
    name: "escalate_agent",
    label: "Escalate a child's model",
    description: "Move a child one step up the model ladder (hyprpi.jsonc routing), e.g. after its work failed your check. Once per job automatically; explicit: true goes past that and past the ceiling (only when Angus asked).",
    parameters: Type.Object({ id: Type.String(), reason: Type.String(), explicit: Type.Optional(Type.Boolean()) }, { additionalProperties: false }),
    execute: async (_id: string, p: any) => { const r = await call("orch.escalate", p, { timeoutMs: 20000 }); return text(r.skipped ? `Not escalated: ${r.skipped}.` : `${r.name}: ${r.before} → ${r.model}/${r.thinking}.`, r); },
  });
  // J288: never wait idle for an event with nothing to wake you.
  pi.registerTool({
    name: "wake_me",
    label: "Wake me after an event",
    description: "Ask hyprpi to wake you (a new turn; held if you're busy) when an event happens, so you can end your turn instead of waiting idle with nothing to wake you: event \"restart\" = after the next hyprpi daemon restart (anyone's guarded restart, or a restart after a crash), event \"agent\" with agent = when that agent ends its turn (or goes away). note = what you'll do then (you get it back). Once each; kept across restarts, 24 h at most. Your world's Thoughts sees a ⏰ line when you're woken.",
    promptSnippet: "Be woken after a daemon restart or when an agent ends its turn",
    parameters: Type.Object({ event: Type.Union([Type.Literal("restart"), Type.Literal("agent")]), agent: Type.Optional(Type.String({ description: "for event agent: its name" })), note: Type.Optional(Type.String({ description: "what you'll do then, e.g. 'start test A'" })) }, { additionalProperties: false }),
    execute: async (_id: string, p: any) => { const r = await call("wake.when", p); return text(`OK: you'll be woken ${r.event === "restart" ? "after the next daemon restart" : `when ${r.agent} ends its turn`}. End your turn now; nothing else to do while you wait.`, r); },
  });
  pi.registerTool({
    name: "my_children",
    label: "My children",
    description: "List the agents you spawned that are still open: status, model, budget use, last report.",
    parameters: Type.Object({}, { additionalProperties: false }),
    execute: async () => { const r = await call("orch.children", {}); return text(r.children.length ? r.children.map((c: any) => `${c.name} (${c.id}) ${c.status} · ${c.model}/${c.thinking} · ${Math.round((c.used?.tokens || 0) / 1000)}k/${Math.round((c.budget?.tokens || 0) / 1000)}k tokens · ${c.reports} report(s)${c.last_report ? `: ${c.last_report.slice(0, 160)}` : ""}`).join("\n") : "No live children.", r); },
  });
  return Object.assign(onEvent, { waiting: () => waits > 0 });
}
