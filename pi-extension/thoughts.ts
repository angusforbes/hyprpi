/**
 * Tools of a world's Thoughts agent (lib/thoughts.mjs runs it: Pi in RPC mode, no built-in
 * tools). Each tool is one call to the hyprpi daemon, which acts as "Thoughts-<room>".
 * Loaded only when HYPRPI_THOUGHTS_ROOM is set.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { request } from "../lib/client.mjs";

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
    description: "Search this world's history (agents' conversations, the room, activity). mode keyword = exact words (fast); ai = a model reads recent history and answers with evidence (slower).",
    promptSnippet: "Search the world's history",
    parameters: Type.Object({
      query: Type.String(),
      mode: Type.Optional(Type.Union([Type.Literal("keyword"), Type.Literal("ai")])),
    }, { additionalProperties: false }),
    execute: async (_id: string, p: any) => {
      const r: any = await call("search", { query: p.query, mode: p.mode || "keyword", from_thoughts: true }, 180000);
      const hits = (r.results || []).slice(0, 12).map((h: any) => `- ${h.name} (${new Date(h.ts).toLocaleString()}): ${String((h.pre || "") + (h.match || "") + (h.post || "")).replace(/\s+/g, " ").slice(0, 300)}${h.why ? " ↳ " + h.why : ""}`);
      return out(`${r.answer ? "Answer: " + r.answer + "\n\n" : ""}${hits.length ? hits.join("\n") : "No matches."}`);
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
    }, { additionalProperties: false }),
    execute: async (_id: string, p: any) => {
      const r: any = await call("thoughts.work", p);
      return out(`Gave it to ${r.agent}${r.project ? ` (@${r.project}, card ${r.item || ""})` : ""}.`, { action: `gave @${r.agent}${r.project ? ` (@${r.project})` : ""}: ${String(p.task).replace(/\s+/g, " ").slice(0, 140)}` });
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
    }, { additionalProperties: false }),
    execute: async (_id: string, p: any) => {
      const r: any = await call("thoughts.open", p);
      return out(`Opened ${r.agent} on workspace ${r.workspace}.`, { action: `opened a new agent, ${r.agent}${r.project ? ` (@${r.project})` : ""}: ${String(p.task).replace(/\s+/g, " ").slice(0, 120)}` });
    },
  });
}
