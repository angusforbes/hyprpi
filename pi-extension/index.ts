/**
 * hyprpi Pi extension — connects a Pi agent running in its own terminal window
 * to the hyprpi daemon (rooms per hyprwrld, talk/demand between agents).
 *
 * Loaded only by `hyprpi new` (via `pi -e`), which sets HYPRPI_AGENT_ID.
 * CLI-loaded extensions win tool-name conflicts, so room_read / room_post /
 * room_reply / talk / demand here replace the Herdr versions for this agent.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Box, Text } from "@earendil-works/pi-tui";
import { execFile } from "node:child_process";
import { connect } from "../lib/client.mjs";
import { ROOT } from "../lib/paths.mjs";

type Conn = Awaited<ReturnType<typeof connect>>;

export default function hyprpi(pi: ExtensionAPI) {
  const AGENT_ID = process.env.HYPRPI_AGENT_ID;
  if (!AGENT_ID) return;

  let conn: Conn | null = null;
  let ctxRef: any = null;
  let stopped = false;
  let connecting = false;
  let retry: ReturnType<typeof setTimeout> | null = null;
  const demands = new Map<string, { expect: number; replies: { name: string; text: string }[]; done: () => void }>();

  const idle = () => { try { return ctxRef?.isIdle?.() ?? true; } catch { return true; } };
  const inject = (message: any) => {
    try { pi.sendMessage(message, idle() ? { triggerTurn: true } : { triggerTurn: true, deliverAs: "followUp" }); }
    catch (e) { ctxRef?.ui?.notify?.(`hyprpi: could not deliver message (${(e as Error).message})`, "warning"); }
  };

  // Show this agent's hyprpi identity in its own window: a footer line
  // ("🧵 Loom · room C", the name in its colours) and the window title.
  const fgHex = (hex: string, t: string) => {
    const m = /^#?([0-9a-f]{6})$/i.exec(hex || "");
    if (!m) return t;
    const n = parseInt(m[1], 16);
    return `\x1b[38;2;${n >> 16};${(n >> 8) & 255};${n & 255}m${t}\x1b[39m`;
  };
  function showSelf(d: any) {
    const ctx = ctxRef;
    if (!ctx?.ui) return;
    let name = "";
    if (d.markup) {
      let color = d.color;
      for (const part of String(d.markup).split(/(\{#[0-9a-fA-F]{6}\})/)) {
        const t = part.match(/^\{(#[0-9a-fA-F]{6})\}$/);
        if (t) { color = t[1]; continue; }
        if (part) name += fgHex(color, part);
      }
    } else name = fgHex(d.color, d.display || d.name || "");
    const where = d.parked ? "in Reprieve · out of rooms" : d.room ? `room ${d.room}` : "no room";
    try { ctx.ui.setStatus?.("hyprpi", `${d.icon ? d.icon + " " : ""}\x1b[1m${name}\x1b[22m \x1b[2m· ${where}\x1b[22m`); } catch { /* no footer */ }
    // Window title: the bare name only (no icon, colour tags or emoji).
    const plain = String(d.name || d.display || "").replace(/\{#[0-9a-fA-F]{6}\}/g, "").replace(/[^\p{L}\p{N}\s\-_.']/gu, "").replace(/\s+/g, " ").trim();
    if (plain) try { ctx.ui.setTitle?.(`π - ${plain} - ${String(ctx.cwd || process.cwd()).split("/").pop()}`); } catch { /* no title */ }
  }

  function onEvent(event: string, d: any) {
    if (event === "room.question") {
      const hist = d.history?.messages?.length
        ? `Room history since you last heard from this room${d.history.truncated ? " (older messages omitted; use room_read)" : ""}:\n${d.history.messages.map((m: any) => `  #${m.seq} ${m.from}${m.reply_to ? ` (re #${m.reply_to})` : ""}: ${m.text}`).join("\n")}\n\n`
        : "";
      inject({
        customType: "hyprpi-room",
        display: true,
        content:
          `[hyprpi room ${d.room} · #${d.seq} · you are ${d.you} · members: ${(d.members || []).join(", ")}]\n${hist}` +
          `Angus, to everyone in room ${d.room}:\n${d.text}\n\n` +
          `(Answer in the room with room_reply using delivery_id "${d.delivery_id}" — once. The history is context, not new requests.)`,
        details: { delivery_id: d.delivery_id, room: d.room, seq: d.seq, text: d.text },
      });
    } else if (event === "self") {
      showSelf(d);
    } else if (event === "prompt") {
      // A prompt sent from a room panel is labelled so the agent can tell it apart from
      // typing in its own window. No auto-post: the agent decides whether to room_post.
      let text = String(d.text ?? "");
      if (d.via === "room-tui") text = `[hyprpi · Angus → you]\n${text}`;
      try { idle() ? pi.sendUserMessage(text) : pi.sendUserMessage(text, { deliverAs: "followUp" }); } catch { /* best effort */ }
    } else if (event === "talk") {
      const how = d.mode === "demand"
        ? `${d.from.name} is waiting for your answer. Reply once with talk_reply(request_id="${d.request_id}", text=...). A refusal is a valid answer.`
        : `Reply (optional) with talk_reply(request_id="${d.request_id}", text=...).`;
      inject({
        customType: "hyprpi-talk",
        display: true,
        content: `[hyprpi ${d.mode} from ${d.from.name} · id ${d.request_id}]\n${d.text}\n\n${how}`,
        details: d,
      });
    } else if (event === "talk.reply") {
      const w = demands.get(d.request_id);
      if (w) {
        w.replies.push({ name: d.from.name, text: d.text });
        if (w.replies.length >= w.expect) w.done();
        return;
      }
      inject({
        customType: "hyprpi-talk-reply",
        display: true,
        content: `[hyprpi reply from ${d.from.name} · re ${d.request_id}]\n${d.text}`,
        details: d,
      });
    }
  }

  async function hello() {
    const ctx = ctxRef;
    let session = "";
    try { session = ctx?.sessionManager?.getSessionFile?.() || ""; } catch { /* none */ }
    const ws = Number(process.env.HYPRPI_WORKSPACE);
    return conn!.call("agent.hello", {
      agent_id: AGENT_ID, pid: process.pid, session, cwd: ctx?.cwd || process.cwd(),
      model: ctx?.model?.id || "", thinking: safe(() => pi.getThinkingLevel()) || "",
      name: safe(() => pi.getSessionName()) || "",
      want_workspace: Number.isInteger(ws) && ws > 0 ? ws : undefined,
      twin_of: process.env.HYPRPI_TWIN_OF || undefined,
    });
  }

  async function ensure() {
    if (stopped || connecting || (conn && !conn.closed)) return;
    connecting = true;
    try {
      conn = await connect({ onEvent, onClose: () => { conn = null; schedule(); } });
      await hello();
      // Re-state where this agent is (a turn may have started or ended while the daemon was down).
      if (myStatus !== "idle") conn.call("agent.update", { status: myStatus, resync: true }).catch(() => {});
    } catch {
      conn?.close(); conn = null; schedule();
    } finally { connecting = false; }
  }
  // If the daemon is gone (crash, logout), start it again; it is idempotent.
  let lastEnsure = 0;
  function schedule() {
    if (stopped || retry) return;
    if (Date.now() - lastEnsure > 10000) {
      lastEnsure = Date.now();
      try { execFile(`${ROOT}/bin/hyprpi`, ["ensure"], { timeout: 10000 }, () => {}); } catch { /* retry later */ }
    }
    retry = setTimeout(() => { retry = null; void ensure(); }, 2000);
  }
  async function call(method: string, params: any = {}, opts?: any) {
    if (!conn || conn.closed) await ensure();
    if (!conn || conn.closed) throw new Error("hyprpi daemon is not reachable");
    return conn.call(method, params, opts);
  }
  let myStatus = "idle"; // last status this agent reported (re-sent after a reconnect)
  const update = (p: any) => { if (p?.status) myStatus = p.status; if (conn && !conn.closed) conn.call("agent.update", p).catch(() => {}); };

  // Typing in this window marks a finished turn (\u2713 in the room window) as
  // seen, like a click in it (Hyprland hook). One call per finish, not per key.
  let unseen = false, stopInput: (() => void) | null = null;
  const TERMINAL_REPORT = /^\x1b\[(?:I|O|\?[\d;]*[uc]|[\d;]+[tR])$/; // focus/size/capability replies, not typing
  function watchTyping(ctx: any) {
    if (stopInput || ctx?.mode !== "tui" || typeof ctx?.ui?.onTerminalInput !== "function") return;
    try {
      stopInput = ctx.ui.onTerminalInput((data: string) => {
        if (unseen && typeof data === "string" && data && !TERMINAL_REPORT.test(data)) {
          unseen = false;
          if (conn && !conn.closed) conn.call("agent.seen", {}).catch(() => {});
        }
        return undefined;
      });
    } catch { stopInput = null; }
  }

  pi.on("session_start", async (_e: any, ctx: any) => { ctxRef = ctx; stopped = false; watchTyping(ctx); await ensure(); });
  pi.on("session_shutdown", async () => {
    stopped = true;
    try { stopInput?.(); } catch { /* gone */ } stopInput = null;
    if (retry) clearTimeout(retry);
    for (const w of demands.values()) w.done();
    conn?.close(); conn = null;
  });
  pi.on("agent_start", async (_e: any, ctx: any) => { ctxRef = ctx; unseen = false; aborted = false; watchTyping(ctx); update({ status: "working" }); });
  // A turn you stopped with Esc ("Operation aborted") is not a finish: no ✓, no ding.
  let aborted = false;
  pi.on("agent_end", async (e: any) => {
    const msgs: any[] = Array.isArray(e?.messages) ? e.messages : [];
    aborted = msgs.some((m: any) => m?.stopReason === "aborted" || m?.message?.stopReason === "aborted" ||
      (m?.role === "toolResult" && m?.isError && /Operation aborted/.test(JSON.stringify(m?.content ?? ""))));
    // Stream: a turn stopped with Esc, or one that ended in an error.
    const err = [...msgs].reverse().find((m: any) => (m?.stopReason ?? m?.message?.stopReason) === "error");
    const report = aborted ? { kind: "aborted", text: "stopped (Esc)" }
      : err ? { kind: "error", text: `error: ${String(err?.errorMessage ?? err?.message?.errorMessage ?? "turn failed").replace(/\s+/g, " ").slice(0, 160)}` } : null;
    if (report && conn && !conn.closed) { flushActivity(); conn.call("agent.activity", { items: [report] }).catch(() => {}); }
  });
  pi.on("agent_settled", async (_e: any, ctx: any) => {
    flushActivity();
    ctxRef = ctx; watchTyping(ctx);
    if (aborted) { aborted = false; unseen = false; update({ status: "idle" }); return; }
    unseen = true; update({ status: "done" });
  });
  // ---- activity: one short line per tool call for the room's stream (never anyone's context).
  // Batched: sent 2 s after the last call (at most every 6 s while busy); consecutive calls with
  // the same verb merge ("reading a.ts, b.ts +3"). Room/talk tools are logged by the daemon itself.
  const SKIP = new Set(["room_read", "room_post", "room_reply", "talk", "demand", "talk_reply"]);
  const cwdOf = () => String(ctxRef?.cwd || process.cwd());
  const short = (p: any) => {
    let t = String(p ?? "").trim();
    const cwd = cwdOf(), home = process.env.HOME || "";
    if (t.startsWith(cwd + "/")) t = t.slice(cwd.length + 1);
    else if (home && t.startsWith(home + "/")) t = "~" + t.slice(home.length);
    return t.length > 60 ? "…" + t.slice(-59) : t;
  };
  const clip = (t: any, n = 70) => { const x = String(t ?? "").replace(/\s+/g, " ").trim(); return x.length > n ? x.slice(0, n - 1) + "…" : x; };
  function describe(tool: string, input: any): { verb: string; obj: string } | null {
    const i = input || {};
    const t = tool.toLowerCase();
    if (SKIP.has(t)) return null;
    if (t === "bash") {
      const cmd = String(i.command || "").split("\n")[0].replace(/^\s*cd\s+\S+\s*&&\s*/, "");
      return { verb: "$", obj: clip(cmd, 80) };
    }
    if (t === "read") return { verb: "reading", obj: short(i.path) };
    if (t === "edit") return { verb: "editing", obj: short(i.path) };
    if (t === "write") return { verb: "writing", obj: short(i.path) };
    if (t === "grep" || t === "find" || t === "ls") return { verb: "searching", obj: clip(i.pattern || i.path || "", 50) };
    if (t === "web_search") return { verb: "web search", obj: clip(i.query || (Array.isArray(i.queries) ? i.queries[0] : ""), 60) };
    if (t === "fetch_content") return { verb: "fetching", obj: clip(String(i.url || (Array.isArray(i.urls) ? i.urls[0] : "")).replace(/^https?:\/\//, ""), 60) };
    if (t === "agent" || t === "subagent") return { verb: "delegating", obj: clip(i.description || i.name || i.task || "", 60) };
    const first = Object.values(i).find((v) => typeof v === "string" && v.trim());
    return { verb: tool, obj: first ? clip(first, 50) : "" };
  }
  let actQueue: { verb: string; obj: string }[] = [];
  let actTimer: ReturnType<typeof setTimeout> | null = null, actFirst = 0;
  function flushActivity() {
    if (actTimer) { clearTimeout(actTimer); actTimer = null; }
    const q = actQueue; actQueue = []; actFirst = 0;
    if (!q.length || !conn || conn.closed) return;
    const lines: string[] = [];
    for (let k = 0; k < q.length;) {
      let j = k; const objs: string[] = [];
      while (j < q.length && q[j].verb === q[k].verb && q[k].verb !== "$") { if (q[j].obj && !objs.includes(q[j].obj)) objs.push(q[j].obj); j++; }
      if (j === k) { lines.push(`$ ${q[k].obj}`); k++; continue; }
      lines.push(`${q[k].verb} ${objs.slice(0, 2).join(", ")}${objs.length > 2 ? ` +${objs.length - 2}` : ""}`.trim());
      k = j;
    }
    conn.call("agent.activity", { items: lines.slice(-10).map((text) => ({ text })) }).catch(() => {});
  }
  pi.on("tool_call", async (e: any) => {
    try {
      const d = describe(String(e?.toolName || ""), e?.input);
      if (!d) return;
      actQueue.push(d);
      if (!actFirst) actFirst = Date.now();
      if (actTimer) clearTimeout(actTimer);
      actTimer = setTimeout(flushActivity, Date.now() - actFirst > 6000 ? 0 : 2000);
    } catch { /* never block a tool */ }
    return undefined;
  });

  pi.on("model_select", async (e: any) => update({ model: e?.model?.id || "" }));
  pi.on("thinking_level_select", async () => update({ thinking: safe(() => pi.getThinkingLevel()) || "" }));
  pi.on("session_info_changed", async (e: any) => {
    // name-sync publishes the full styled name via `hyprpi name`; this only
    // covers a plain rename when name-sync is absent.
    const n = e?.name?.trim();
    if (n && !/^\?/.test(n) && !/\s/.test(n) && !/^["']/.test(n)) update({ name: n });
  });

  const render = (label: string) => (message: any, { outputPad }: any, theme: any) => {
    const box = new Box(outputPad, 1, (t: string) => theme.bg("userMessageBg", t));
    box.addChild(new Text(theme.fg("userMessageText", String(message.content ?? "")), 0, 0));
    return box;
  };
  pi.registerMessageRenderer("hyprpi-room", render("room"));
  pi.registerMessageRenderer("hyprpi-talk", render("talk"));
  pi.registerMessageRenderer("hyprpi-talk-reply", render("reply"));

  const text = (t: string, details?: any) => ({ content: [{ type: "text" as const, text: t }], details });

  // ---- the project board (docs/board-plan.md): one per world, several projects (cards) ----
  const AGREEMENT = [
    "The hyprpi board (board_read / board_update / project) is how Angus keeps track of projects in your world without hunting for agents. Keep the cards of the projects you are on current: when you finish something notable, add it to done WITH how you verified it; keep 'where' to one line of where things stand; leave a next_step before you stop.",
    "Board working agreement: don't ask Angus what you can find out or decide reversibly: pick the default and note it on the card. Ask him only about irreversible things, taste, direction, money or sending things out, as a decide item with options, your recommendation and a default (adding it dings him at once). Ask project peers (talk) before asking Angus. Bonk only for urgent things. Narrate while you work.",
    "Heard: everything Angus says to you that bears on a project goes on that project's card as a heard item (his words, distilled, with a priority), even if he didn't ask for it; turn heard items into next/decide items as they become work, and drop them when dealt with. If it fits no project, post it in the Agent Message Board for later; if it could fit several, pick one. Project names are short (hyprpi, boards); use longer ones only when a project splits.",
  ];
  pi.registerTool({
    name: "board_read",
    label: "Read board",
    description: "Read your world's project board (all projects, or one): each card's members, writer, where things stand, decide / next / heard / done items with their handles (D1, N2, H3), and optionally its recent changes.",
    promptSnippet: "Read the project board of your world",
    promptGuidelines: AGREEMENT,
    parameters: Type.Object({ project: Type.Optional(Type.String({ description: "@name or id; omit for the whole board" })), changes: Type.Optional(Type.Boolean({ description: "also list recent changes" })) }, { additionalProperties: false }),
    execute: async (_id: string, p: any) => {
      const r = await call("board.text", { project: p.project });
      let t = r.text;
      if (p.changes) { const c = await call("board.changes", { project: p.project, limit: 20 }); t += "\n\nRecent changes:\n" + c.changes.map((x: any) => `  ${new Date(x.ts).toLocaleTimeString()} ${x.by} ${x.op}${x.h ? " " + x.h : ""}: ${x.text || ""}`).join("\n"); }
      return text(t, r);
    },
  });
  pi.registerTool({
    name: "board_update",
    label: "Update board",
    description: "Change one project card on the board. action: add (section decide|next|heard|done; decide takes options, recommend, default and dings Angus at once; heard takes priority; done takes verified), edit (handle + new text etc.), done (handle, verified = how you checked), drop (handle), where (text: one line of where things stand), next_step (text: the concrete step to resume with).",
    promptSnippet: "Update a project card on the board (items, where things stand, next step)",
    parameters: Type.Object({
      project: Type.String({ description: "@name or id" }),
      action: Type.Union([Type.Literal("add"), Type.Literal("edit"), Type.Literal("done"), Type.Literal("drop"), Type.Literal("where"), Type.Literal("next_step")]),
      section: Type.Optional(Type.Union([Type.Literal("decide"), Type.Literal("next"), Type.Literal("heard"), Type.Literal("done")])),
      handle: Type.Optional(Type.String({ description: "item handle, e.g. N2 (edit / done / drop)" })),
      text: Type.Optional(Type.String()),
      options: Type.Optional(Type.Array(Type.String(), { description: "decide: the choices (become a, b, c…)" })),
      recommend: Type.Optional(Type.String({ description: "decide: the option key you recommend" })),
      default: Type.Optional(Type.String({ description: "decide: the option you go with if Angus doesn't answer" })),
      priority: Type.Optional(Type.Number({ description: "heard: higher = more important" })),
      verified: Type.Optional(Type.String({ description: "done: how you checked it works" })),
    }, { additionalProperties: false }),
    execute: async (_id: string, p: any) => {
      if (p.action === "where" || p.action === "next_step") {
        const r = await call("board.project", { action: "update", project: p.project, [p.action]: p.text ?? "" });
        return text(`@${r.name}: ${p.action} updated.`, r);
      }
      const r = await call("board.item", { action: p.action, project: p.project, h: p.handle, section: p.section, text: p.text, options: p.options, recommend: p.recommend, default: p.default, prio: p.priority, verified: p.verified });
      return text(`@${r.project.name} ${r.item.h}: ${p.action} done.${r.item.sec === "decide" && p.action === "add" ? " Angus has been dinged." : ""}`, { h: r.item.h });
    },
  });
  pi.registerTool({
    name: "project",
    label: "Project",
    description: "Manage projects on your world's board. Creating or joining a project that was closed (archived) reopens it with its history. action: create (name = a SHORT @slug, one word like hyprpi or boards; longer names only when a project splits; title; you become a member and the writer), join, leave (note REQUIRED: a hand-off for the remaining members, what you did and what's left; it is sent to them), rename (name), status (new|active|paused|archived), writer (hand the writer role to a member: agent name), assign (members: '+@A -@B').",
    promptSnippet: "Create, join, leave or reshape a project on the board",
    parameters: Type.Object({
      action: Type.Union([Type.Literal("create"), Type.Literal("join"), Type.Literal("leave"), Type.Literal("rename"), Type.Literal("status"), Type.Literal("writer"), Type.Literal("assign")]),
      project: Type.Optional(Type.String({ description: "@name or id (all but create)" })),
      name: Type.Optional(Type.String()), title: Type.Optional(Type.String()),
      note: Type.Optional(Type.String()), status: Type.Optional(Type.String()),
      writer: Type.Optional(Type.String()), members: Type.Optional(Type.String()),
    }, { additionalProperties: false }),
    execute: async (_id: string, p: any) => {
      const a = p.action;
      let r: any;
      if (a === "create") r = await call("board.project", { action: "create", name: p.name, title: p.title });
      else if (a === "join" || a === "leave") r = await call("board.project", { action: a, project: p.project, note: p.note });
      else if (a === "assign") r = await call("board.project", { action: "assign", project: p.project, members: p.members });
      else if (a === "writer") { const ids = await call("board.get", {}); const w = Object.entries(ids.names || {}).find(([, n]) => String(n).toLowerCase() === String(p.writer || "").replace(/^@/, "").toLowerCase()); if (!w) throw new Error("the writer must be a member (by name)"); r = await call("board.project", { action: "update", project: p.project, writer: w[0] }); }
      else r = await call("board.project", { action: "update", project: p.project, ...(a === "rename" ? { name: p.name } : { status: p.status }) });
      return text(`@${r.name} (${r.id}): ${a} done.${r.reopened ? " It was a closed (archived) project: reopened with its history; read it (board_read) before adding to it." : ""}${r.told?.length ? " Told " + r.told.join(", ") + "." : ""}`, r);
    },
  });

  // /tinker TEXT: drop a friction fix off in the workshop world and carry on here.
  pi.registerCommand("tinker", {
    description: "Drop a friction fix off in the workshop world: one free agent there does it. /tinker D: text also makes world D the workshop (remembered)",
    handler: async (args: any, ctx: any) => {
      const t = String(args ?? "").trim();
      if (!t) { ctx.ui.notify("Usage: /tinker what to fix · /tinker D: what to fix (also makes world D the workshop)", "warning"); return; }
      try {
        const r = await call("tinker", { text: t, via: "agent" });
        ctx.ui.notify("🔧 " + (r.set ? `workshop is world ${r.set.workshop} now${r.set.previous ? " (was " + r.set.previous + ")" : ""} · ` : "") + (r.nothing ? "nothing to fix given" : r.queued ? `queued for the workshop (room ${r.room})${r.spawning ? ", opening an agent" : ""}` : `dropped off in the workshop (room ${r.room})`), "info");
      } catch (e: any) { ctx.ui.notify(`/tinker: ${e?.message || e}`, "error"); }
    },
  });

  pi.registerTool({
    name: "room_read",
    label: "Read room",
    description: "Read your hyprpi room's shared conversation (Angus's posts and agents' replies). Read-only; never prompts anyone. Use after_sequence to page forward; limit default 20, max 40.",
    parameters: Type.Object({ after_sequence: Type.Optional(Type.Integer({ minimum: 0 })), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 40 })) }, { additionalProperties: false }),
    execute: async (_id: string, p: any) => {
      const r = await call("room.read", { after_sequence: p.after_sequence ?? 0, limit: p.limit ?? 20 });
      const messages = r.messages.map((m: any) => ({ sequence: m.seq, speaker: m.author?.kind === "agent" ? "agent" : "human", name: m.author?.name, ...(m.reply_to ? { reply_to: m.reply_to } : {}), text: m.text }));
      const next = messages.at(-1)?.sequence ?? (p.after_sequence ?? 0);
      return text(JSON.stringify({ room: r.room, messages, next_after_sequence: next, more: next < r.next_sequence - 1 }), { room: r.room });
    },
  });

  pi.registerTool({
    name: "room_post",
    label: "Post to room",
    description: "Share a short attributed message in your hyprpi room (the room of the hyprwrld your window is in). Max 8192 bytes. Does not prompt other agents. Never retry an uncertain post; check room_read instead.",
    promptSnippet: "Share a bounded contribution in the current shared room",
    promptGuidelines: [
      "A user message starting with [hyprpi · Angus → you] was sent from the hyprpi room panel, and Angus reads the panel, not your window: put your answer in the room with room_post (unless it is clearly private), and do NOT repeat it in your window; end your turn with just a one-line pointer like \"Posted in room C (#123).\"",
      "Anything else Angus types in your own window (no [hyprpi · Angus → you] label) is answered IN YOUR WINDOW, in full: that is where he asked and where he reads. This includes text he typed after a delivered room message ([hyprpi room …] block): answer the room question in the room (room_reply), and answer his typed text in your window. Never answer something asked in your window only in the room; if the room should also see it, post it there as well.",
    ],
    parameters: Type.Object({ text: Type.String({ minLength: 1, maxLength: 8192 }) }, { additionalProperties: false }),
    execute: async (_id: string, p: any) => {
      const r = await call("room.post", { text: p.text });
      return text(`Post saved in room ${r.room} (#${r.sequence}). No agents were prompted.`, r);
    },
  });

  pi.registerTool({
    name: "room_reply",
    label: "Room reply",
    description: "Answer a question Angus asked your hyprpi room, once, using the delivery_id given with the question. Max 8192 bytes. Never retry an uncertain reply.",
    promptSnippet: "Answer the active shared room question once",
    parameters: Type.Object({ delivery_id: Type.String({ minLength: 1 }), text: Type.String({ minLength: 1, maxLength: 8192 }) }, { additionalProperties: false }),
    execute: async (_id: string, p: any) => {
      const r = await call("room.reply", { delivery_id: p.delivery_id, text: p.text });
      return text(`Reply saved in room ${r.room} (#${r.sequence}).`, r);
    },
  });

  const peerParams = Type.Object({
    recipients: Type.Array(Type.String({ minLength: 1 }), { minItems: 1, description: "Agent names (a multi-word name is one element); [\"all\"] only for an explicitly requested broadcast." }),
    message: Type.String({ minLength: 1, maxLength: 8192 }),
    timeout_seconds: Type.Optional(Type.Integer({ minimum: 1, maximum: 3600 })),
  }, { additionalProperties: false });

  pi.registerTool({
    name: "talk",
    label: "Talk to agents",
    description: "Send a message to other live hyprpi agents by name. Returns after dispatch; replies arrive later as follow-up messages. Do not start unsolicited conversation loops.",
    promptSnippet: "Message other hyprpi agents by name (replies arrive later)",
    parameters: peerParams,
    execute: async (_id: string, p: any) => {
      const r = await call("talk", { to: p.recipients, text: p.message, mode: "talk", timeout_seconds: p.timeout_seconds });
      return text(`Sent to ${r.delivered.join(", ") || "nobody"}${r.skipped.length ? `; skipped ${r.skipped.map((s: any) => `${s.name} (${s.reason})`).join(", ")}` : ""}. Request ${r.request_id}.`, r);
    },
  });

  pi.registerTool({
    name: "demand",
    label: "Demand answers",
    description: "Ask other live hyprpi agents by name and wait for their answers (default timeout 120 s). Use only when their answer blocks your next step; never create reciprocal waits.",
    promptSnippet: "Ask hyprpi agents and wait for their answers",
    parameters: peerParams,
    execute: async (_id: string, p: any, signal: AbortSignal) => {
      const r = await call("talk", { to: p.recipients, text: p.message, mode: "demand", timeout_seconds: p.timeout_seconds ?? 120 });
      if (!r.delivered.length) return text(`Nobody received it: ${r.skipped.map((s: any) => `${s.name} (${s.reason})`).join(", ")}`, r);
      const w = { expect: r.delivered.length, replies: [] as { name: string; text: string }[], done: () => {} };
      await new Promise<void>((resolve) => {
        const t = setTimeout(() => w.done(), 1000 * (p.timeout_seconds ?? 120));
        w.done = () => { clearTimeout(t); signal?.removeEventListener?.("abort", w.done); demands.delete(r.request_id); resolve(); };
        signal?.addEventListener?.("abort", w.done);
        demands.set(r.request_id, w);
      });
      const missing = r.delivered.filter((n: string) => !w.replies.some((x) => x.name === n));
      const body = w.replies.map((x) => `--- ${x.name} ---\n${x.text}`).join("\n\n").slice(0, 32768);
      return text(`${w.replies.length}/${r.delivered.length} answered${missing.length ? ` (no answer: ${missing.join(", ")})` : ""}.\n\n${body}`, { request_id: r.request_id, replies: w.replies, missing });
    },
  });

  pi.registerTool({
    name: "talk_reply",
    label: "Reply to agent",
    description: "Answer a talk/demand message from another hyprpi agent, once, using its request_id.",
    parameters: Type.Object({ request_id: Type.String({ minLength: 1 }), text: Type.String({ minLength: 1, maxLength: 32768 }) }, { additionalProperties: false }),
    execute: async (_id: string, p: any) => {
      const r = await call("talk.reply", { request_id: p.request_id, text: p.text });
      return text(r.delivered ? "Reply delivered." : "Reply saved, but the sender is not connected right now.", r);
    },
  });
}

function safe<T>(f: () => T): T | undefined { try { return f(); } catch { return undefined; } }
