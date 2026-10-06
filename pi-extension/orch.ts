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

type Deps = { call: (m: string, p?: any, o?: any) => Promise<any>; inject: (m: any, steer?: boolean) => void; idle: () => boolean; ctx: () => any };

export function orchAgent(pi: ExtensionAPI, { call, inject, idle, ctx }: Deps) {
  const text = (t: string, details: any = {}) => ({ content: [{ type: "text" as const, text: t }], details });
  let me: any = null; // { budget, used, startedAt, status, parent } when this agent was spawned
  let tokens = 0, stopped = false, closing: any = null, lastSent = 0;
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
    tokens += (u.input || 0) + (u.output || 0) + (u.cacheWrite || 0);
    if (Date.now() - lastSent > 15000) { lastSent = Date.now(); call("orch.usage", { tokens }).catch(() => {}); }
    checkCap();
  });
  function checkCap() {
    const what = over();
    if (!what || stopped) return;
    stopped = true;
    call("orch.usage", { tokens }).catch(() => {});
    call("orch.budgetHit", { what }).catch(() => {});
    inject({ customType: "hyprpi-orch", display: true, content: `[hyprpi · budget reached: ${what}]\nStop now. Call report_to_parent with what you have so far, what's left and what you'd need to finish (not final unless it's done), then end your turn. Other tools are blocked until your parent extends your budget.`, details: { request_id: `orch-budget-${Date.now()}` } }, true);
  }
  // The time cap also while one long tool call runs (Knock's J130 finding 4): the steer lands at its end, and
  // the tools after it are blocked.
  setInterval(() => { if (me?.budget?.minutes) checkCap(); }, 30000).unref?.();
  pi.on("tool_call", async (e: any) => {
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

  const onEvent = (event: string, d: any) => {
    if (event === "orch.report") {
      inject({ customType: "hyprpi-orch", display: true, content: String(d?.text || ""), details: { request_id: `orch-report-${d?.child}-${Date.now()}` } });
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
      const r = await call("orch.spawn", p);
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
    execute: async (_id: string, p: any) => {
      const t = Math.max(1, Math.min(3600, Number(p.timeout_sec) || 600));
      const r = await call("orch.wait", p, { timeoutMs: (t + 30) * 1000 });
      const lines = r.reports.map((x: any) => `## ${x.name} (${x.id})${x.final ? " · final" : ""}\n${x.text}`);
      return text(`${r.timed_out ? "Timed out. " : ""}${r.reports.length} report(s)${r.still_working.length ? `; no report yet from: ${r.still_working.map((s: any) => `${s.name} (${s.status})`).join(", ")}` : ""}.\n\n${lines.join("\n\n")}`, r);
    },
  });
  pi.registerTool({
    name: "close_agent",
    label: "Close an agent",
    description: "Close a child you spawned (id or name) once you've taken its result, or yourself (no id) when you're a spawned agent that's finished. It closes at its next idle moment; its last report is kept.",
    parameters: Type.Object({ id: Type.Optional(Type.String()), reason: Type.Optional(Type.String()) }, { additionalProperties: false }),
    execute: async (_id: string, p: any) => { const r = await call("orch.close", p); return text(r.already ? `${r.name} was already closed.` : `Closing ${r.name}${r.closing ? " (at its next idle moment)" : " (it wasn't connected: closed now)"}.`, r); },
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
  pi.registerTool({
    name: "my_children",
    label: "My children",
    description: "List the agents you spawned that are still open: status, model, budget use, last report.",
    parameters: Type.Object({}, { additionalProperties: false }),
    execute: async () => { const r = await call("orch.children", {}); return text(r.children.length ? r.children.map((c: any) => `${c.name} (${c.id}) ${c.status} · ${c.model}/${c.thinking} · ${Math.round((c.used?.tokens || 0) / 1000)}k/${Math.round((c.budget?.tokens || 0) / 1000)}k tokens · ${c.reports} report(s)${c.last_report ? `: ${c.last_report.slice(0, 160)}` : ""}`).join("\n") : "No live children.", r); },
  });
  return onEvent;
}
