/**
 * Tools of a world's Thoughts agent (lib/thoughts.mjs runs it: Pi in RPC mode, no built-in
 * tools). Each tool is one call to the hyprpi daemon, which acts as "Thoughts-<room>".
 * Loaded only when HYPRPI_THOUGHTS_ROOM is set.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { request } from "../lib/client.mjs";
import path from "node:path";
import { loadUpkeep, expandHome } from "../lib/upkeep.mjs";
import { pruneMessages } from "../lib/prune.mjs";

const THINKING = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
const checkThinking = (t: any) => { if (t != null && t !== "" && !THINKING.includes(String(t))) throw new Error(`thinking "${t}" isn't a level: ${THINKING.join(", ")}`); };
// A model as list_models shows it ("provider/id", or a bare id) -> the registry's model, or null.
function findModel(ctx: any, s: string) {
  const reg = ctx?.modelRegistry, all: any[] = reg?.getAvailable?.() || [], i = s.indexOf("/");
  return all.find((m) => `${m.provider}/${m.id}` === s) || (i > 0 ? reg?.find?.(s.slice(0, i), s.slice(i + 1)) : null) || all.find((m) => m.id === s) || null;
}

export default function thoughts(pi: ExtensionAPI) {
  const ROOM = process.env.HYPRPI_THOUGHTS_ROOM;
  if (!ROOM) return;

  // J137 (Thoughts get J125's context pruning too, same upkeep.prune settings in ~/.config/hyprpi/hyprpi.jsonc):
  // older pasted screenshots and big tool outputs leave what each request sends (the session keeps them) as a
  // stub with a file:// link; anything that isn't a file is saved first. Angus's current message (and its
  // images) and the latest tool result are never pruned.
  const seen = new Set<string>();
  pi.on("context", async (e: any) => {
    let S: any; try { S = loadUpkeep(); } catch { return; }
    if (!S?.prune?.enabled) return;
    const r = pruneMessages(e?.messages || [], S, { dir: path.join(expandHome(S.prune.saveDir || "~/.local/state/hyprpi/pruned"), `thoughts-${ROOM}`), seen, hint: "you have no read tool: to look at it again, pass the path to an agent in images of ask_agent / give_work" });
    if (!r.stats.images && !r.stats.outputs) return;
    return { messages: r.messages };
  });
  const call = (method: string, params: any = {}, timeoutMs = 20000) => request(method, { room: ROOM, ...params }, { timeoutMs });
  const out = (text: string, details: any = {}) => ({ content: [{ type: "text", text }], details });

  pi.registerTool({
    name: "world",
    label: "World",
    description: `World ${ROOM} as the hyprpi panels show it: its agents (status, topic, projects), its project board, and recent room posts.`,
    promptSnippet: "See the world: agents, board, recent room posts",
    parameters: Type.Object({ room_posts: Type.Optional(Type.Number({ description: "how many recent room posts (default 15)" })) }, { additionalProperties: false }),
    execute: async (_id: string, p: any) => { const r: any = await call("thoughts.world", { posts: p.room_posts }); return out(r.text); },
  });

  pi.registerTool({
    name: "search_history",
    label: "Search history",
    description: "Search this world's history (agents' conversations, the room, activity). mode keyword = exact words (fast, the 10 newest matching turns); ask = a small model answers from the history and cites the turns (slower). Angus sees the results in his thread as evidence lines, numbered as you get them, so you can refer to them (\"the third one\").",
    promptSnippet: "Search the world's history",
    parameters: Type.Object({
      query: Type.String(),
      mode: Type.Optional(Type.Union([Type.Literal("keyword"), Type.Literal("ask"), Type.Literal("ai")])),
      n: Type.Optional(Type.Number({ description: "how many turns (default 10)" })),
    }, { additionalProperties: false }),
    execute: async (_id: string, p: any) => {
      const ev: any = await call("thoughts.find", { query: p.query, kind: p.mode === "ai" || p.mode === "ask" ? "ask" : "keyword", n: p.n }, 180000);
      const lines = (ev.items || []).map((it: any, i: number) => `${i + 1}. ${new Date(it.ts).toLocaleString()} · ${it.who}${it.role ? " (" + it.role + ")" : ""}: ${String(it.text ?? ((it.pre || "") + (it.match || "") + (it.post || ""))).replace(/\s+/g, " ").slice(0, 300)}`);
      const more = ev.total > (ev.items || []).length ? `\n(${ev.total - ev.items.length} older matches not shown; ask with a larger n for more)` : "";
      return out(`${ev.answer ? "Answer: " + ev.answer + "\n\n" : ""}${lines.length ? lines.join("\n") + more : "No matches."}`, { evidence: ev });
    },
  });

  pi.registerTool({
    name: "ask_agent",
    label: "Ask an agent",
    description: "Ask one agent in hyprpi a question on Angus's behalf (or another world's Thoughts agent: agent \"Thoughts-D\", for cross-world matters, sparingly). Its reply comes back later as a message starting with \"[reply from\". Refused if the agent is working, unless urgent (only when Angus says so).",
    promptSnippet: "Ask an agent a question",
    parameters: Type.Object({
      agent: Type.String({ description: "agent name, e.g. Sankey or pi·k3vg" }),
      question: Type.String(),
      urgent: Type.Optional(Type.Boolean()),
      images: Type.Optional(Type.Array(Type.String(), { description: "image paths to show the agent (e.g. a screenshot Angus pasted)" })),
    }, { additionalProperties: false }),
    execute: async (_id: string, p: any) => {
      const r: any = await call("thoughts.ask", p);
      return out(`Asked ${r.agent}. The reply will arrive as a new message.`, { action: `asked @${r.agent}: ${String(p.question).replace(/\s+/g, " ").slice(0, 140)}` });
    },
  });

  pi.registerTool({
    name: "give_work",
    label: "Give work",
    description: "Hand a deliverable to an agent (agent) or to a project (project: its best free member) as a BRIEF (job J<n>, version 1): Angus's words verbatim, a one-sentence goal, context, limits, what to ask first, and the done-when checks its report must answer. Only when Angus asks or agrees, and only when there's a deliverable (not for questions or exploring: use ask_agent). With a project it goes on the card as a Next item showing ⟦J<n> v1 · running⟧. The report comes back to you (a \"[reply from\" message) with a line saying whether the job is done.",
    promptSnippet: "Hand a deliverable to an agent or a project, as a brief",
    parameters: Type.Object({
      angus: Type.String({ description: "Angus's own words for this, VERBATIM (quoted to the agent next to your summary)" }),
      goal: Type.String({ description: "the deliverable, in one sentence" }),
      context: Type.Optional(Type.String({ description: "what the agent needs to know from this conversation (prose)" })),
      limits: Type.Optional(Type.String({ description: "what not to touch / scope limits" })),
      ask_first: Type.Optional(Type.String({ description: "what the agent must ask before doing (e.g. anything that takes Angus's focus)" })),
      done_when: Type.Array(Type.String(), { description: "checks that count as proof it's done, one per line (W1, W2, …); its report must answer each" }),
      task: Type.Optional(Type.String({ description: "(old form) the task as prose; becomes the context" })),
      agent: Type.Optional(Type.String()),
      project: Type.Optional(Type.String({ description: "@name of a project on the board" })),
      urgent: Type.Optional(Type.Boolean({ description: "also if the agent is working (queued after its turn)" })),
      images: Type.Optional(Type.Array(Type.String(), { description: "image paths to show the agent (e.g. a screenshot Angus pasted)" })),
    }, { additionalProperties: false }),
    execute: async (_id: string, p: any) => {
      const r: any = await call("thoughts.work", p);
      return out(`Gave ${r.job} v1 to ${r.agent}${r.project ? ` (@${r.project}, card ${r.item || ""})` : r.loose ? ` (no project: on the Loose jobs card, ${r.loose}; move_job it into a project once it leads to decisions)` : ""}.`, { action: `gave @${r.agent}${r.project ? ` (@${r.project})` : ""} ${r.job}: ${String(p.goal || p.task).replace(/\s+/g, " ").slice(0, 140)}` });
    },
  });

  pi.registerTool({
    name: "assign_tinker",
    label: "Route a drop-off",
    description: "Decide who does a /tinker drop-off (a message starting with \"[tinker drop-off\"): job = its id, agent = a free agent (idle or done) whose project or recent work fits, or \"new\" to open a fresh agent in the workshop. Never yourself. Don't do the job or report it to Angus: the agent reports with \"🔧 done\".",
    promptSnippet: "Decide who does a tinker drop-off",
    parameters: Type.Object({
      job: Type.String({ description: "the drop-off's job id" }),
      agent: Type.String({ description: "agent name (e.g. Tinker, pi·k3vg), or \"new\"" }),
    }, { additionalProperties: false }),
    execute: async (_id: string, p: any) => {
      const r: any = await call("thoughts.tinkerAssign", p);
      return out(`Gave drop-off ${p.job} to ${r.agent}${r.new ? " (a new agent)" : ""}.`, { action: `gave the drop-off to @${r.agent}${r.new ? " (new)" : ""}` });
    },
  });

  pi.registerTool({
    name: "assign_writer",
    label: "Pick a project's owner",
    description: "Make an agent the owner (writer) of a project: it keeps the card current and answers Angus's messages to the project. Every project needs a LIVE owner; hyprpi asks you when one has none (\"[board care]\"). Prefer a live member whose work fits; otherwise a live agent in the world whose work fits (check world). The new owner is asked to tidy the card.",
    promptSnippet: "Pick a project's owner (writer)",
    parameters: Type.Object({ project: Type.String({ description: "@name or id" }), agent: Type.String({ description: "a live agent's name" }) }, { additionalProperties: false }),
    execute: async (_id: string, p: any) => {
      const r: any = await call("thoughts.writer", p);
      return out(`@${r.project}: ${r.writer} is now its owner and has been asked to tidy the card.`, { action: `made @${r.writer} the owner of @${r.project}` });
    },
  });

  pi.registerTool({
    name: "tidy_projects",
    label: "Tidy projects",
    description: "Ask a project's owner (or, without project, every project's owner in this world) to tidy its card now: archive what's not current, drop what's irrelevant, turn heard items into work, update where / next step. Use it whenever cards look out of sync with what you know; Angus doesn't want to ask for it.",
    promptSnippet: "Ask owners to tidy their project cards",
    parameters: Type.Object({ project: Type.Optional(Type.String({ description: "@name or id; omit for all" })) }, { additionalProperties: false }),
    execute: async (_id: string, p: any) => {
      const r: any = await call("board.tidy", p);
      return out(`${r.told.length ? "Asked to tidy: " + r.told.join(", ") + "." : "Nobody to ask."}${r.noWriter.length ? ` No live owner: ${r.noWriter.join(" ")} (you'll get a [board care] message to pick one).` : ""}`, { action: r.told.length ? `asked owners to tidy ${r.told.map((x: string) => x.split(" ")[0]).join(" ")}` : undefined });
    },
  });

  // Models (Angus's standing permission: Thoughts may change an agent's model when it judges it right).
  pi.registerTool({
    name: "list_models",
    label: "List models",
    description: "The models agents can be switched to (those with an API key here), as provider/id with context size and whether they reason. filter: a regex on provider/id (e.g. \"sonnet|haiku\", \"^anthropic/\"); without one, a short summary per provider.",
    promptSnippet: "List models an agent can be switched to",
    parameters: Type.Object({ filter: Type.Optional(Type.String()) }, { additionalProperties: false }),
    execute: async (_id: string, p: any, _s: any, _u: any, ctx: any) => {
      const all: any[] = ctx?.modelRegistry?.getAvailable?.() || [];
      const key = (m: any) => `${m.provider}/${m.id}`;
      if (!p.filter) {
        const by = new Map<string, string[]>(); for (const m of all) (by.get(m.provider) || by.set(m.provider, []).get(m.provider)!).push(m.id);
        return out(`${all.length} models. By provider (count · a few ids); use filter for exact ids:\n` + [...by].map(([pv, ids]) => `- ${pv} (${ids.length}): ${ids.slice(0, 8).join(", ")}${ids.length > 8 ? ", …" : ""}`).join("\n"));
      }
      let re: RegExp; try { re = new RegExp(p.filter, "i"); } catch { return out("✗ filter is not a valid regex"); }
      const hits = all.filter((m) => re.test(key(m)));
      return out(hits.length ? hits.slice(0, 60).map((m) => `${key(m)}${m.contextWindow ? ` · ${Math.round(m.contextWindow / 1000)}k` : ""}${m.reasoning ? " · reasoning" : ""}`).join("\n") + (hits.length > 60 ? `\n(+${hits.length - 60} more; narrow the filter)` : "") : "No model matches.");
    },
  });
  pi.registerTool({
    name: "set_model",
    label: "Set an agent's model",
    description: "Switch an agent's model (and/or thinking level: off, minimal, low, medium, high, xhigh, max). Angus's standing permission: whenever you judge it appropriate (a cheaper/faster model for simple jobs, a stronger one for hard ones); tell him in one line when you do. model: provider/id as list_models shows it (or a bare id). A one-line note goes to the room.",
    promptSnippet: "Change an agent's model",
    parameters: Type.Object({
      agent: Type.String({ description: "agent name, e.g. Sankey or pi·k3vg" }),
      model: Type.Optional(Type.String({ description: "provider/id, e.g. anthropic/claude-sonnet-5" })),
      thinking: Type.Optional(Type.String({ description: "thinking level" })),
      reason: Type.Optional(Type.String({ description: "a few words: why (shown in the room line)" })),
    }, { additionalProperties: false }),
    execute: async (_id: string, p: any) => {
      checkThinking(p.thinking);
      const r: any = await call("thoughts.setModel", p);
      return out(`${r.agent}: ${r.before || "?"} → ${r.model}${r.thinking ? ` (thinking ${r.thinking})` : ""}.`, { action: `set @${r.agent}'s model to ${r.model}` });
    },
  });

  // J125 upkeep: you are in charge of your world's upkeep (~/.config/hyprpi/hyprpi.jsonc, section "upkeep").
  pi.registerTool({
    name: "upkeep",
    label: "Upkeep",
    description: "Your world's automatic upkeep (Angus's editable settings in ~/.config/hyprpi/hyprpi.jsonc, section upkeep: context pruning, compact-and-continue, overdue refreshes). action status = the strategy and each agent's compactions / due / paused state; pause AGENT = no upkeep refresh for it (e.g. it's mid-debug and needs its context) until resume AGENT; now AGENT = ask an idle agent for its handoff and refresh it now. Upkeep runs by itself; you get a 🧹 note in your thread for each action. Never ask Angus first; tell him after, in a line, if it matters.",
    promptSnippet: "Status / pause / resume / refresh-now for your world's upkeep",
    parameters: Type.Object({ action: Type.Union([Type.Literal("status"), Type.Literal("pause"), Type.Literal("resume"), Type.Literal("now")]), agent: Type.Optional(Type.String()) }, { additionalProperties: false }),
    execute: async (_id: string, p: any) => { const r: any = await call("thoughts.upkeep", p); return out(r.text, r); },
  });
  pi.registerTool({
    name: "write_handoff",
    label: "Write handoff",
    description: "Only when hyprpi upkeep asks you to (your own session is due for a refresh): your handoff note for your next self, in Markdown (open jobs and who has them, what's waiting on Angus, decisions and context you'd need). It's saved and you restart on a fresh session from it when your turn ends; the last turns of the thread stay visible to Angus.",
    parameters: Type.Object({ text: Type.String() }, { additionalProperties: false }),
    execute: async (_id: string, p: any) => { const r: any = await call("thoughts.handoff", p); return out(r.text, r); },
  });

  pi.registerTool({
    name: "cancel_work",
    label: "Cancel work",
    description: "Stop work you handed out (give_work / open_agent) because Angus withdrew or changed it. Use it AS SOON AS he does, before saying anything else. The agent's run on that work is stopped at once (like Esc), a still-queued task is dropped so it never starts, and the agent gets the stop (it replies with the state it left things in) or, with replace_with, the new instruction to carry on with. Its reply comes back to you like any. The card item is marked withdrawn and a ✋ line goes to the room. If the work was already done, you're told so (with the commit hash when its reply names one): offer Angus a revert, don't do one unasked.",
    promptSnippet: "Stop work you handed out when Angus changes his mind",
    parameters: Type.Object({
      agent: Type.String({ description: "the agent doing the work, e.g. Blink or pi·k3vg" }),
      reason: Type.String({ description: "why, in Angus's words (short)" }),
      replace_with: Type.Optional(Type.String({ description: "(not for briefs: use revise_work) the changed task, when Angus changed it rather than dropping it" })),
      final: Type.Optional(Type.Boolean({ description: "a brief's job is CANCELLED for good (default: STOPPED, which revise_work can resume as a new version)" })),
    }, { additionalProperties: false }),
    execute: async (_id: string, p: any) => {
      const r: any = await call("thoughts.cancel", p);
      if (r.state === "done" || r.state === "already cancelled")
        return out(`${r.agent}: that work is ${r.state}${r.hash ? ` (${r.hash})` : ""}: "${r.task}". Its reply: ${r.reply || "(none)"}`);
      return out(`${r.agent}: ${r.state} ("${r.task}")${r.dropped ? `, ${r.dropped} queued message${r.dropped === 1 ? "" : "s"} dropped` : ""}${r.items?.length ? `; marked withdrawn: ${r.items.join(", ")}` : ""}. ${r.delivered ? (r.replaced ? "It got the new instruction; its reply comes to you." : "It was told to stop; its reply (the state it left things in) comes to you.") : "Nothing more was sent (it never started)."}`, { action: `stopped @${r.agent}` });
    },
  });

  pi.registerTool({
    name: "revise_work",
    label: "Revise a brief",
    description: "Issue a NEW VERSION of a brief (job J<n>) when Angus changes a deliverable or says to continue a stopped one. Give only the fields that change (the rest is kept) plus the reason in his words. done_when REPLACES the whole list: resend every earlier check that still applies, plus the new ones; to drop one on purpose, name it in drop_checks (a revision that silently loses checks is refused). The old version's run is stopped and anything still queued for it (including an earlier stop) is dropped; the agent gets the new version with the changed lines marked + / −. Versions only go up, so an older one can never arrive after a newer one. To just stop, use cancel_work (a state change).",
    promptSnippet: "Give a brief a new version",
    parameters: Type.Object({
      job: Type.String({ description: "the job id, e.g. J7" }),
      reason: Type.String({ description: "why, in Angus's words" }),
      angus: Type.Optional(Type.String({ description: "Angus's new words, verbatim" })),
      goal: Type.Optional(Type.String()), context: Type.Optional(Type.String()), limits: Type.Optional(Type.String()), ask_first: Type.Optional(Type.String()),
      done_when: Type.Optional(Type.Array(Type.String(), { description: "the FULL new list of done-when checks: every earlier check that still applies, plus the new ones" })),
      drop_checks: Type.Optional(Type.Array(Type.String(), { description: "earlier checks you drop ON PURPOSE (\"W3\" or the check's text); say why in reason" })),
    }, { additionalProperties: false }),
    execute: async (_id: string, p: any) => {
      const r: any = await call("thoughts.revise", p, 30000);
      return out(`${r.job} is now v${r.version} for ${r.agent} (the previous run: ${r.previous}).`, { action: `${r.job} → v${r.version} (@${r.agent}): ${String(p.reason).replace(/\s+/g, " ").slice(0, 120)}` });
    },
  });

  pi.registerTool({
    name: "verify_work",
    label: "Verify a job",
    description: "Mark a DONE job (its report answered every done-when line) as VERIFIED, once Angus or a second agent has confirmed the proof (not the agent that did it); or, with failed: true, record that the check FAILED (the job reopens and a spawned agent escalates one model step, J140). Ask a second agent with ask_agent first when Angus wants it checked.",
    promptSnippet: "Mark a done job verified",
    parameters: Type.Object({ job: Type.String(), by: Type.String({ description: "Angus, or the confirming agent's name" }), note: Type.Optional(Type.String()), failed: Type.Optional(Type.Boolean({ description: "the check FAILED (J140): the job is reopened and, for a spawned agent on the routing ladder, it moves one model step up (once per job; routing.escalate.onFailedCheck)" })) }, { additionalProperties: false }),
    execute: async (_id: string, p: any) => {
      const r: any = await call("thoughts.verify", p);
      if (r.failed) return out(`${r.job} FAILED its check (${r.by}); reopened.${r.escalation?.escalating ? ` ${r.escalation.escalating} was put up for one model step (only if it hasn't moved for this job yet; a ⤴ note in this thread confirms a move).` : r.escalation?.skipped ? ` No escalation: ${r.escalation.skipped}.` : ""}`, { action: `${r.job} failed its check (${r.by})` });
      return out(`${r.job} verified by ${r.by}.`, { action: `${r.job} verified by ${r.by}` });
    },
  });

  pi.registerTool({
    name: "move_job",
    label: "Move a job",
    description: "Move a job (J<n>) to a project's card, keeping its id, versions and history. A brief given without a project sits on the world's Loose jobs card (a catch-all); Angus's rule: quick one-offs can stay there, but a job that leads to decisions (or more work) belongs in a project, so move it there yourself, without asking him. The old line is marked done \"moved to @x N12\", the new card gets the job's line, and its agent joins the project. (An agent that creates a project takes its running loose jobs along by itself.)",
    promptSnippet: "Move a job to a project's card",
    parameters: Type.Object({ job: Type.String({ description: "J<n>" }), project: Type.String({ description: "@name of the project to move it to" }) }, { additionalProperties: false }),
    execute: async (_id: string, p: any) => { const r: any = await call("thoughts.moveJob", p); return out(`${r.job} moved to @${r.project} ${r.item} (from ${r.from}).`, { action: `moved ${r.job} → @${r.project} ${r.item}` }); },
  });

  // J241: revive_agent: bring a parked agent (Reprieve) of this world back, when hyprpi.jsonc allows it.
  pi.registerTool({
    name: "revive_agent",
    label: "Revive a parked agent",
    description: "Bring one of this world's PARKED agents (its window in Reprieve: still running with its own session and context, but out of the room; the world tool lists them) back to its workspace in this world, without moving Angus's focus. Only when thoughts.reviveParked is true in ~/.config/hyprpi/hyprpi.jsonc; otherwise it refuses and Angus brings it back himself. ask_agent, give_work and interrupt_agent on a parked agent revive it first on their own (same rule). A ♻ room line says so. Revive only when the agent is actually needed.",
    promptSnippet: "Bring a parked agent back from Reprieve",
    parameters: Type.Object({
      agent: Type.String({ description: "the parked agent's name, e.g. Claw" }),
      reason: Type.Optional(Type.String({ description: "why it's needed (shown in the room line)" })),
    }, { additionalProperties: false }),
    execute: async (_id: string, p: any) => {
      const r: any = await call("thoughts.revive", p);
      return out(r.already ? `${r.agent} isn't parked (it's on ${r.workspace}).` : `${r.agent} is back from Reprieve, on ${r.workspace}.`, { action: `revived @${r.agent}` });
    },
  });

  // interrupt_agent (Angus, brief J12): a real interrupt for ANY live agent.
  pi.registerTool({
    name: "interrupt_agent",
    label: "Interrupt an agent",
    description: "Interrupt any live agent NOW: its current turn is aborted like Esc, your message arrives as its next turn, it answers (the reply comes back as \"[reply from …\"), and then it carries on with what it was doing (resume, default) or waits (resume: false). Use it at your discretion or when Angus says interrupt; for a question that can wait, use ask_agent. It doesn't cancel work, briefs or card items (that's cancel_work), and the agent's other queued messages stay queued. A room line says so.",
    promptSnippet: "Interrupt any live agent now",
    parameters: Type.Object({
      agent: Type.String({ description: "agent name, e.g. pi·wpzt or Sankey" }),
      message: Type.String(),
      resume: Type.Optional(Type.Boolean({ description: "carry on afterwards (default true)" })),
      from_angus: Type.Optional(Type.Boolean({ description: "Angus asked for this interrupt" })),
      images: Type.Optional(Type.Array(Type.String())),
    }, { additionalProperties: false }),
    execute: async (_id: string, p: any) => {
      const r: any = await call("thoughts.interruptAgent", p);
      return out(`${r.agent}: ${r.state}.`, { action: `interrupted @${r.agent}: ${String(p.message).replace(/\s+/g, " ").slice(0, 140)}` });
    },
  });

  pi.registerTool({
    name: "set_topic",
    label: "Set topic",
    description: "Set your topic in the world's room stream (2–5 words, e.g. \"NIM research\"). Only when the subject of the conversation with Angus clearly changes, not per message.",
    promptSnippet: "Set your topic in the room stream",
    parameters: Type.Object({ topic: Type.String() }, { additionalProperties: false }),
    execute: async (_id: string, p: any) => { const r: any = await call("thoughts.topic", { topic: p.topic }); return out(r.set ? `Topic set: ${p.topic}` : "Topic unchanged."); },
  });

  pi.registerTool({
    name: "answer_agent",
    label: "Answer an agent",
    description: "Answer an agent that talked to you (a message starting with \"[message from agent\"): request_id from that message, your answer as text.",
    promptSnippet: "Answer an agent that asked you something",
    parameters: Type.Object({ request_id: Type.String(), text: Type.String() }, { additionalProperties: false }),
    execute: async (_id: string, p: any) => {
      const r: any = await call("thoughts.answer", p);
      return out(`Answered ${r.agent}.`, { action: `answered @${r.agent}: ${((t) => t.length > 2000 ? t.slice(0, 1999) + "…" : t)(String(p.text).replace(/\s+/g, " "))}` }); // whole answer: the Thoughts window clips it to 2 rows with … and Shift-click copies all (N53, pi·wpzt's test)
    },
  });

  pi.registerTool({
    name: "open_agent",
    label: "Open an agent",
    description: "Open a NEW hyprpi agent in this world for a deliverable, when no suitable agent is free; it gets a BRIEF (job J<n> v1, same fields as give_work) as its first prompt. At most one per request of Angus's; tell him you did. It reports back to you. ALWAYS give it a name and an icon that reflect its purpose (Angus): a short, distinctive one-word name (e.g. Namesmith, Phoenix) and one fitting emoji (e.g. 🏷️, 🐦‍🔥); it starts with them in its window, the room, the panels and the board (without them it is an unnamed pi·xxxx). The name must be free: not a live agent's or a project's.",
    promptSnippet: "Open a new agent for a deliverable (a brief)",
    parameters: Type.Object({
      angus: Type.String({ description: "Angus's own words for this, VERBATIM (quoted to the agent next to your summary)" }),
      goal: Type.String({ description: "the deliverable, in one sentence" }),
      context: Type.Optional(Type.String({ description: "what the agent needs to know from this conversation (prose)" })),
      limits: Type.Optional(Type.String({ description: "what not to touch / scope limits" })),
      ask_first: Type.Optional(Type.String({ description: "what the agent must ask before doing (e.g. anything that takes Angus's focus)" })),
      done_when: Type.Array(Type.String(), { description: "checks that count as proof it's done, one per line (W1, W2, …); its report must answer each" }),
      task: Type.Optional(Type.String({ description: "(old form) the task as prose; becomes the context" })),
      project: Type.Optional(Type.String({ description: "@name: the new agent joins it" })),
      cwd: Type.Optional(Type.String({ description: "working folder (default ~/Work)" })),
      images: Type.Optional(Type.Array(Type.String(), { description: "image paths to show the agent (e.g. a screenshot Angus pasted)" })),
      complexity: Type.Optional(Type.String({ description: "simple | ordinary | hard | review: picks model + thinking from the routing rules (~/.config/hyprpi/hyprpi.jsonc) when no model is given (J130)" })),
      model: Type.Optional(Type.String({ description: "start it on this model: provider/id as list_models shows it (default: the usual one). Same standing permission as set_model" })),
      thinking: Type.Optional(Type.String({ description: "its thinking level: off, minimal, low, medium, high, xhigh, max" })),
      name: Type.Optional(Type.String({ description: "its name, reflecting its purpose: short, usually one word (e.g. Namesmith); must not be taken" })),
      icon: Type.Optional(Type.String({ description: "one emoji reflecting its purpose (e.g. 🏷️)" })),
    }, { additionalProperties: false }),
    execute: async (_id: string, p: any, _s: any, _u: any, ctx: any) => {
      let model = "";
      checkThinking(p.thinking); // pi·wpzt's N48 test: "banana" used to be dropped silently
      if (p.model) { const m = findModel(ctx, String(p.model).trim()); if (!m) throw new Error(`no model "${p.model}" here (list_models shows the ids)`); model = `${m.provider}/${m.id}`; }
      const r: any = await call("thoughts.open", { ...p, model });
      return out(`Opened ${r.icon ? r.icon + " " : ""}${r.agent} on workspace ${r.workspace}${model ? ` on ${model}` : ""} with ${r.job} v1.`, { action: `opened a new agent, ${r.icon ? r.icon + " " : ""}${r.agent}${r.project ? ` (@${r.project})` : ""}${model ? ` on ${model}` : ""} ${r.job}: ${String(p.goal || p.task).replace(/\s+/g, " ").slice(0, 120)}` });
    },
  });

  // J130 orchestration primitives, as Thoughts-<room> (the parent of what it spawns). open_agent stays the
  // way to hand out a tracked JOB (brief, card); spawn_agent is the light primitive for helpers you run yourself.
  const T = { thoughts: ROOM };
  pi.registerTool({
    name: "spawn_agent",
    label: "Spawn an agent",
    description: "Open a light helper agent (your child) silently in this world for a bounded side task you coordinate yourself (no brief or card; for a tracked job use open_agent). prompt = its whole instructions. complexity (simple | ordinary | hard | review) picks its model from the routing rules (~/.config/hyprpi/hyprpi.jsonc) unless model is given; Angus's explicit choice always wins. Its reports come to you as messages; wait_report blocks for them.",
    parameters: Type.Object({
      prompt: Type.String(), name: Type.Optional(Type.String()), icon: Type.Optional(Type.String()),
      complexity: Type.Optional(Type.String()), model: Type.Optional(Type.String()), thinking: Type.Optional(Type.String()),
      cwd: Type.Optional(Type.String()), project: Type.Optional(Type.String()),
      budget: Type.Optional(Type.Object({ tokens: Type.Optional(Type.Number()), minutes: Type.Optional(Type.Number()) })),
    }, { additionalProperties: false }),
    execute: async (_id: string, p: any) => { checkThinking(p.thinking); const r: any = await call("orch.spawn", { ...p, ...T }); return out(`Spawned ${r.name} (${r.id}) on ${r.workspace}, ${r.model}${r.thinking ? "/" + r.thinking : ""}${r.routed ? ` (routed: ${r.why})` : ""}.`, { action: `spawned ${r.name} on ${r.model}` }); },
  });
  pi.registerTool({
    name: "wait_report",
    label: "Wait for reports",
    description: "Block until the agents you spawned report (all, or any: true), or the timeout (default 300 s). No polling.",
    parameters: Type.Object({ ids: Type.Optional(Type.Array(Type.String())), timeout_sec: Type.Optional(Type.Number()), any: Type.Optional(Type.Boolean()) }, { additionalProperties: false }),
    execute: async (_id: string, p: any) => { const t = Math.max(1, Math.min(1800, Number(p.timeout_sec) || 300)); const r: any = await call("orch.wait", { ...p, timeout_sec: t, ...T }, (t + 30) * 1000); return out(`${r.timed_out ? "Timed out. " : ""}${r.reports.map((x: any) => `## ${x.name}${x.final ? " · final" : ""}\n${x.text}`).join("\n\n") || "No reports."}${r.still_working.length ? `\n(no report yet: ${r.still_working.map((s: any) => s.name).join(", ")})` : ""}`); },
  });
  pi.registerTool({
    name: "close_agent",
    label: "Close an agent",
    description: "Close an agent spawned with spawn_agent (yours, or an orphan you adopted) at its next idle moment; its last report is kept.",
    parameters: Type.Object({ id: Type.String(), reason: Type.Optional(Type.String()) }, { additionalProperties: false }),
    execute: async (_id: string, p: any) => { const r: any = await call("orch.close", { ...p, ...T }); return out(`Closing ${r.name}.`, { action: `closed ${r.name}` }); },
  });
  pi.registerTool({
    name: "extend_budget",
    label: "Extend a budget",
    description: "Give a spawned agent that hit its budget more tokens / minutes (none given: the default amounts again).",
    parameters: Type.Object({ id: Type.String(), tokens: Type.Optional(Type.Number()), minutes: Type.Optional(Type.Number()) }, { additionalProperties: false }),
    execute: async (_id: string, p: any) => { const r: any = await call("orch.extend", { ...p, ...T }); return out(`${r.name}: ${Math.round(r.budget.tokens / 1000)}k tokens / ${r.budget.minutes} min.`, { action: `extended ${r.name}'s budget` }); },
  });
  pi.registerTool({
    name: "escalate_agent",
    label: "Escalate a model",
    description: "Move a spawned agent one step up the model ladder (failed check, stuck). Once per job automatically; explicit: true only when Angus asked.",
    parameters: Type.Object({ id: Type.String(), reason: Type.String(), explicit: Type.Optional(Type.Boolean()) }, { additionalProperties: false }),
    execute: async (_id: string, p: any) => { const r: any = await call("orch.escalate", { ...p, ...T }); return out(r.skipped ? `Not escalated: ${r.skipped}.` : `${r.name}: ${r.before} → ${r.model}/${r.thinking}.`, { action: r.skipped ? "" : `escalated ${r.name} to ${r.model}` }); },
  });
}
