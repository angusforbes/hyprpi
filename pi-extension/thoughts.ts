/**
 * Tools of a world's Thoughts agent (lib/thoughts.mjs runs it: Pi in RPC mode, no built-in
 * tools). Each tool is one call to the hyprpi daemon, which acts as "Thoughts-<room>".
 * Loaded only when HYPRPI_THOUGHTS_ROOM is set.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { request } from "../lib/client.mjs";

// A model as list_models shows it ("provider/id", or a bare id) -> the registry's model, or null.
function findModel(ctx: any, s: string) {
  const reg = ctx?.modelRegistry, all: any[] = reg?.getAvailable?.() || [], i = s.indexOf("/");
  return all.find((m) => `${m.provider}/${m.id}` === s) || (i > 0 ? reg?.find?.(s.slice(0, i), s.slice(i + 1)) : null) || all.find((m) => m.id === s) || null;
}

export default function thoughts(pi: ExtensionAPI) {
  const ROOM = process.env.HYPRPI_THOUGHTS_ROOM;
  if (!ROOM) return;
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
    description: "Ask one agent in hyprpi a question on Angus's behalf. Its reply comes back later as a message starting with \"[reply from\". Refused if the agent is working, unless urgent (only when Angus says so).",
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
    description: "Hand a task to an agent (agent) or to a project (project: its best free member), with the context it needs from this conversation. Only when Angus asks or agrees. With a project, the task also goes on its board card as a Next item. The agent reports back to you (a \"[reply from\" message).",
    promptSnippet: "Hand a task to an agent or a project",
    parameters: Type.Object({
      task: Type.String({ description: "what to do, with the context from the conversation" }),
      agent: Type.Optional(Type.String()),
      project: Type.Optional(Type.String({ description: "@name of a project on the board" })),
      urgent: Type.Optional(Type.Boolean({ description: "also if the agent is working (queued after its turn)" })),
      images: Type.Optional(Type.Array(Type.String(), { description: "image paths to show the agent (e.g. a screenshot Angus pasted)" })),
    }, { additionalProperties: false }),
    execute: async (_id: string, p: any) => {
      const r: any = await call("thoughts.work", p);
      return out(`Gave it to ${r.agent}${r.project ? ` (@${r.project}, card ${r.item || ""})` : ""}.`, { action: `gave @${r.agent}${r.project ? ` (@${r.project})` : ""}: ${String(p.task).replace(/\s+/g, " ").slice(0, 140)}` });
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
      const r: any = await call("thoughts.setModel", p);
      return out(`${r.agent}: ${r.before || "?"} → ${r.model}${r.thinking ? ` (thinking ${r.thinking})` : ""}.`, { action: `set @${r.agent}'s model to ${r.model}` });
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
      return out(`Answered ${r.agent}.`, { action: `answered @${r.agent}: ${String(p.text).replace(/\s+/g, " ").slice(0, 140)}` });
    },
  });

  pi.registerTool({
    name: "open_agent",
    label: "Open an agent",
    description: "Open a NEW hyprpi agent in this world for a task, when no suitable agent is free. At most one per request of Angus's; tell him you did. It reports back to you.",
    promptSnippet: "Open a new agent for a task",
    parameters: Type.Object({
      task: Type.String(),
      project: Type.Optional(Type.String({ description: "@name: the new agent joins it" })),
      cwd: Type.Optional(Type.String({ description: "working folder (default ~/Work)" })),
      images: Type.Optional(Type.Array(Type.String(), { description: "image paths to show the agent (e.g. a screenshot Angus pasted)" })),
      model: Type.Optional(Type.String({ description: "start it on this model: provider/id as list_models shows it (default: the usual one). Same standing permission as set_model" })),
      thinking: Type.Optional(Type.String({ description: "its thinking level: off, minimal, low, medium, high, xhigh, max" })),
    }, { additionalProperties: false }),
    execute: async (_id: string, p: any, _s: any, _u: any, ctx: any) => {
      let model = "";
      if (p.model) { const m = findModel(ctx, String(p.model).trim()); if (!m) throw new Error(`no model "${p.model}" here (list_models shows the ids)`); model = `${m.provider}/${m.id}`; }
      const r: any = await call("thoughts.open", { ...p, model });
      return out(`Opened ${r.agent} on workspace ${r.workspace}${model ? ` on ${model}` : ""}.`, { action: `opened a new agent, ${r.agent}${r.project ? ` (@${r.project})` : ""}${model ? ` on ${model}` : ""}: ${String(p.task).replace(/\s+/g, " ").slice(0, 120)}` });
    },
  });
}
