/**
 * hyprpi Pi extension — connects a Pi agent running in its own terminal window
 * to the hyprpi daemon (rooms per hyprwrld, talk/demand between agents).
 *
 * Loaded only by `hyprpi new` (via `pi -e`), which sets HYPRPI_AGENT_ID.
 * CLI-loaded extensions win tool-name conflicts, so room_read / room_post /
 * room_reply / talk / demand here replace the Herdr versions for this agent.
 */
import { UserMessageComponent, getMarkdownTheme, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Box, Text } from "@earendil-works/pi-tui";
import { execFile } from "node:child_process";
import { connect } from "../lib/client.mjs";
import { ROOT } from "../lib/paths.mjs";
import * as hypr from "../lib/hypr.mjs";
import { laterModes } from "./later.ts";
import { upkeepAgent } from "./upkeep.ts";

type Conn = Awaited<ReturnType<typeof connect>>;

export default function hyprpi(pi: ExtensionAPI) {
  ignoreNotes(pi); // /ignore works in any window that loads this extension
  const AGENT_ID = process.env.HYPRPI_AGENT_ID;
  if (!AGENT_ID) return;
  laterModes(pi); // /notnow and /discuss (J46): hyprpi agent windows only (they file on the board)

  let conn: Conn | null = null;
  let ctxRef: any = null;
  let stopped = false;
  let connecting = false;
  let retry: ReturnType<typeof setTimeout> | null = null;
  const demands = new Map<string, { expect: number; replies: { name: string; text: string }[]; done: () => void }>();

  const idle = () => { try { return ctxRef?.isIdle?.() ?? true; } catch { return true; } };
  upkeepAgent(pi, { call: (m: string, p: any = {}) => call(m, p), agentId: AGENT_ID, idle }); // J125 upkeep: pruning, compact reminder, upkeep_ready
  // steer: an agent mid-turn sees it at its next tool boundary instead of after the whole turn (peer
  // coordination; a "followUp" talk once arrived only after the work it asked about was done, @hyprpi N44).
  // Not steered (Thoughts' tasks, room questions): held HERE while the agent works and started as
  // the next turn when it settles, one per turn. Pi's own "followUp" queue lost one (Thoughts-C's
  // 00:58 question to pi·wpzt: delivered to the window, never in the session; @hyprpi N44 follow-up).
  const held: any[] = [];
  // J64 (Angus: "nothing lost"): one turn start at a time. Two requests to an idle agent in the same
  // second used to both start a turn; pi rejected the second ASYNCHRONOUSLY and it vanished (J61).
  // `starting` holds the rest until the turn has begun; a send that fails (now or later) is held again.
  let starting: ReturnType<typeof setTimeout> | null = null;
  const send = (message: any, opts: any) => {
    const again = () => { if (keyOf(message) && !landed.has(keyOf(message))) { held.unshift(message); setTimeout(releaseHeld, 1000); } };
    try {
      if (opts?.triggerTurn && !opts.deliverAs) { if (starting) clearTimeout(starting); starting = setTimeout(() => { starting = null; releaseHeld(); }, 5000); }
      const r: any = pi.sendMessage(message, opts);
      if (r && typeof r.then === "function") r.catch((e: any) => { ctxRef?.ui?.notify?.(`hyprpi: a message was refused (${e?.message || e}); trying again`, "warning"); again(); });
    }
    catch (e) { ctxRef?.ui?.notify?.(`hyprpi: could not deliver message (${(e as Error).message}); trying again`, "warning"); again(); }
  };
  // Steered ones are tracked until they show up in the session (message_end): Esc clears pi's queues
  // and drops queued custom messages without a trace (pi·wpzt's diagnosis), so whatever didn't land
  // is held again when the run ends.
  const steered = new Map<string, any>(); // key (request_id / delivery_id) -> message
  const keyOf = (m: any) => String(m?.details?.request_id || m?.details?.delivery_id || "");
  const inject = (message: any, steer = false) => {
    const k = keyOf(message);
    // A re-send from the daemon (J64 receipts) of something already here: just confirm it again.
    if (k && (landed.has(k) || held.some((m) => keyOf(m) === k) || steered.has(k) || keyOf(afterAbort) === k)) { if (landed.has(k)) ack(k); return; }
    if (idle() && !held.length && !starting) return send(message, { triggerTurn: true });
    if (steer && !idle()) { const k = keyOf(message); if (k) steered.set(k, message); return send(message, { triggerTurn: true, deliverAs: "steer" }); }
    held.push(message);
    if (idle()) setTimeout(releaseHeld, 0);
  };
  // Thoughts' work that landed in this session (ever) and in the current run (@hyprpi N57 cancel_work).
  const landed = new Set<string>(), inRun = new Set<string>();
  // Delivery receipt (J64): the daemon keeps the request until this says it is in the session.
  const ack = (k: string) => { conn?.call("agent.delivered", { id: k }).catch(() => { /* re-sent and acked later */ }); };
  pi.on("message_end", async (e: any) => { const m = e?.message; if (m?.role === "custom") { const k = keyOf(m); steered.delete(k); if (k) { landed.add(k); inRun.add(k); ack(k); if (landed.size > 200) landed.delete(landed.values().next().value as string); } } });
  pi.on("agent_start", async () => { if (starting) { clearTimeout(starting); starting = null; } });
  // Sent when a run that cancel_work aborted has settled (the stop / the replacement starts a turn).
  let afterAbort: any = null, afterAbortTimer: ReturnType<typeof setTimeout> | null = null;
  let interrupting = false; // an interrupt_agent abort: held requests stay held (released after the interrupt's turn), not kept
  function releaseHeld() { if (held.length && idle() && !starting) send(held.shift(), { triggerTurn: true }); }
  // After Esc (Angus stopped the agent): keep the held messages in the context without starting a
  // turn, so the stop stays a stop; they are answered with his next message.
  function keepHeld() {
    if (!held.length) return;
    const n = held.length;
    while (held.length) send(held.shift(), { triggerTurn: false });
    ctxRef?.ui?.notify?.(`hyprpi: ${n} request${n === 1 ? "" : "s"} kept after Esc; ${n === 1 ? "it is" : "they are"} answered with your next message`, "info");
  }
  const reclaimSteered = () => { if (steered.size) { held.unshift(...steered.values()); steered.clear(); } };

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
    } else if (event === "restart") {
      restartReq = { compact: d?.compact !== false, by: String(d?.by || "") };
      ctxRef?.ui?.notify?.(`🔄 restart asked${restartReq.by && restartReq.by !== "itself" ? ` by ${restartReq.by}` : ""}${idle() ? "" : "; it waits until this turn ends"}${restartReq.compact ? " (compacting first)" : ""}`, "info");
      armRestart();
    } else if (event === "note") {
      if (d?.text) ctxRef?.ui?.notify?.(String(d.text), "info");
    } else if (event === "self") {
      showSelf(d);
    } else if (event === "prompt") {
      // A prompt sent from a room panel is labelled so the agent can tell it apart from
      // typing in its own window. No auto-post: the agent decides whether to room_post.
      let text = String(d.text ?? "");
      if (d.via === "room-tui") text = `[hyprpi · Angus → you]\n${text}`;
      try { idle() ? pi.sendUserMessage(text) : pi.sendUserMessage(text, { deliverAs: "followUp" }); } catch { /* best effort */ }
    } else if (event === "set_model") {
      // Thoughts switches this agent's model (Angus's standing permission, @hyprpi N47).
      (async () => {
        const reply = (r: any) => conn?.call("agent.modelResult", { token: d.token, ...r }).catch(() => {});
        try {
          const reg = ctxRef?.modelRegistry;
          let m: any = null;
          if (d.model) {
            const s = String(d.model), i = s.indexOf("/");
            m = (i > 0 ? reg?.find(s.slice(0, i), s.slice(i + 1)) : null) || reg?.getAvailable?.().find((x: any) => x.id === s || `${x.provider}/${x.id}` === s);
            if (!m) return reply({ ok: false, error: `no model "${s}" here (list_models shows the ids)` });
            if (!(await pi.setModel(m))) return reply({ ok: false, error: `can't switch to ${m.provider}/${m.id} (no API key for it?)` });
          }
          if (d.thinking) pi.setThinkingLevel(d.thinking);
          reply({ ok: true, model: m ? `${m.provider}/${m.id}` : ctxRef?.model?.id || "", thinking: (() => { try { return pi.getThinkingLevel(); } catch { return ""; } })() });
        } catch (e) { reply({ ok: false, error: (e as Error).message }); }
      })();
    } else if (event === "cancel") {
      // Thoughts withdraws work it handed out (Angus changed his mind, @hyprpi N57): drop what is still
      // held here (it never starts), abort the run it started (like Esc), then deliver the stop or the
      // replacement as a turn of its own once the run has settled.
      const reply = (r: any) => conn?.call("agent.cancelResult", { token: d.token, ...r }).catch(() => {});
      try {
        const ids = new Set<string>((d.ids || []).map(String));
        let dropped = 0;
        for (let i = held.length - 1; i >= 0; i--) if (ids.has(keyOf(held[i]))) { held.splice(i, 1); dropped++; }
        for (const k of [...steered.keys()]) if (ids.has(k)) { steered.delete(k); dropped++; }
        const started = [...ids].some((k) => landed.has(k));
        // interrupt_agent (J12): no work ids; whatever runs is aborted, nothing held is dropped.
        const running = !idle() && (!!d.interrupt || [...ids].some((k) => inRun.has(k)));
        const t = d.talk;
        const message = t ? {
          customType: "hyprpi-talk", display: true,
          content: `[hyprpi ${t.mode} from ${t.from.name} · id ${t.request_id}]\n${t.text}\n\n${t.from.name} is waiting for your answer. Reply once with talk_reply(request_id="${t.request_id}", text=...).`,
          details: t,
        } : null;
        // Nothing started and nothing replaces it: a plain stop has nothing to say.
        const deliver = !!message && (started || !!d.replace || !!d.interrupt);
        if (running) {
          if (deliver) {
            afterAbort = message;
            if (afterAbortTimer) clearTimeout(afterAbortTimer);
            afterAbortTimer = setTimeout(() => { afterAbortTimer = null; if (afterAbort) { const m = afterAbort; afterAbort = null; inject(m); } }, 20000); // the run never settled: queue it normally
          }
          ctxRef?.abort?.();
          if (d.interrupt) interrupting = true;
          ctxRef?.ui?.notify?.(d.interrupt ? `hyprpi: ${t?.from?.name || "Thoughts"} interrupted this turn` : `hyprpi: ${t?.from?.name || "Thoughts"} stopped this work (Angus changed his mind)`, "warning");
        } else if (deliver) inject(message);
        reply({ ok: true, started, aborted: running, dropped, delivered: deliver });
      } catch (e) { reply({ ok: false, error: (e as Error).message }); }
    } else if (event === "talk") {
      const how = d.mode === "demand"
        ? `${d.from.name} is waiting for your answer. Reply once with talk_reply(request_id="${d.request_id}", text=...). A refusal is a valid answer.`
        : `Reply (optional) with talk_reply(request_id="${d.request_id}", text=...).`;
      inject({
        customType: "hyprpi-talk",
        display: true,
        content: `[hyprpi ${d.mode} from ${d.from.name} · id ${d.request_id}]\n${d.text}\n\n${how}`,
        details: d,
      }, !String(d.from?.id || "").startsWith("thoughts:") || !!d.urgent); // agents' talk (and urgent asks) steer; Thoughts' tasks wait for the turn to end
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
      }, true);
    }
  }

  async function hello() {
    const ctx = ctxRef;
    let session = "";
    try { session = ctx?.sessionManager?.getSessionFile?.() || ""; } catch { /* none */ }
    const ws = Number(process.env.HYPRPI_WORKSPACE);
    return conn!.call("agent.hello", {
      agent_id: AGENT_ID, pid: process.pid, session, cwd: ctx?.cwd || process.cwd(), acks: true, // J64 delivery receipts
      model: ctx?.model?.id || "", thinking: safe(() => pi.getThinkingLevel()) || "",
      name: safe(() => pi.getSessionName()) || process.env.HYPRPI_NAME || "",
      icon: process.env.HYPRPI_ICON || undefined, // open_agent's icon (J15); used only by a new agent
      want_workspace: Number.isInteger(ws) && ws > 0 ? ws : undefined,
      container: process.env.HYPRPI_CONTAINER || undefined,
      twin_of: process.env.HYPRPI_TWIN_OF || undefined,
    });
  }

  async function ensure() {
    if (stopped || connecting || (conn && !conn.closed)) return;
    connecting = true;
    try {
      conn = await connect({ onEvent, onClose: () => { conn = null; schedule(); } });
      const me: any = await hello();
      // Footer from the hello reply: after a /reload the daemon doesn't re-send "self" (its pushSelf
      // skips an unchanged identity), so the reloaded extension's footer stayed empty.
      if (me) showSelf({ name: me.name || "", display: me.name || `pi\u00b7${String(AGENT_ID).slice(-4)}`, icon: me.icon || "", color: me.color || "", room: me.room || "" });
      // Re-state where this agent is (a turn may have started or ended while the daemon was down).
      if (myStatus !== "idle") conn.call("agent.update", { status: myStatus, resync: true }).catch(() => {});
      if (helpers.size) conn.call("agent.update", { helpers: helperList() }).catch(() => {}); // J93
    } catch {
      conn?.close(); conn = null; schedule();
    } finally { connecting = false; }
  }
  // If the daemon is gone (crash, logout), start it again; it is idempotent.
  let lastEnsure = 0;
  function schedule() {
    if (stopped || retry) return;
    // HYPRPI_NO_ENSURE=1 (agents in a container): never start a daemon from here; it would
    // take the shared socket without access to Hyprland. Just keep retrying the host daemon.
    if (process.env.HYPRPI_NO_ENSURE !== "1" && Date.now() - lastEnsure > 10000) {
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
  // J93 ◐ background: this agent's running subagents (@tintinweb/pi-subagents' lifecycle events: top-level
  // Agent runs, foreground or background, RPC and scheduled spawns; a SubagentWorkflow's children emit none).
  // Lost on a reload or crash, which falls back to the plain state.
  const helpers = new Map<string, { id: string; type: string; description: string; startedAt: number }>();
  const helperList = () => [...helpers.values()];
  const helperStarted = (d: any) => {
    if (!d?.id) return;
    helpers.set(String(d.id), { id: String(d.id), type: String(d.type || ""), description: String(d.description || ""), startedAt: Date.now() });
    if (myStatus === "done" || myStatus === "idle") update({ status: "background", helpers: helperList() });
    else update({ helpers: helperList() });
  };
  const helperEnded = (d: any) => {
    if (!d?.id || !helpers.delete(String(d.id))) return;
    if (!helpers.size && myStatus === "background") { unseen = true; update({ status: "done", helpers: [] }); }
    else update({ helpers: helperList() });
  };
  try {
    pi.events.on("subagents:started", helperStarted);
    pi.events.on("subagents:completed", helperEnded);
    pi.events.on("subagents:failed", helperEnded);
  } catch { /* no event bus: no ◐ */ }

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
    // Esc while the model's next request is in flight (right after an Esc'd tool): pi 0.87 records
    // stopReason "error" + "The operation was aborted." (J36; interrupted.ts turns it into an abort,
    // but without that extension it arrives as an error): that is Angus's stop too, not a failure.
    const abortErr = (m: any) => (m?.stopReason ?? m?.message?.stopReason) === "error"
      && /^(?:(?:the|this) )?operation was aborted\.?$/i.test(String(m?.errorMessage ?? m?.message?.errorMessage ?? "").trim());
    aborted = msgs.some((m: any) => m?.stopReason === "aborted" || m?.message?.stopReason === "aborted" || abortErr(m) ||
      (m?.role === "toolResult" && ((m?.isError && /\b(?:Operation|Command) aborted\b/i.test(JSON.stringify(m?.content ?? "")))
        // ~/.pi/agent/extensions/interrupted.ts rewrites an Esc'd tool result to a plain "interrupted" (no error)
        || (Array.isArray(m?.content) ? m.content.map((c: any) => c?.text || "").join("") : String(m?.content ?? "")).trim() === "interrupted")));
    // Stream: a turn stopped with Esc, or one that ended in an error.
    const err = [...msgs].reverse().find((m: any) => (m?.stopReason ?? m?.message?.stopReason) === "error");
    const report = aborted ? { kind: "aborted", text: "stopped (Esc)" }
      : err ? { kind: "error", text: `error: ${String(err?.errorMessage ?? err?.message?.errorMessage ?? "turn failed").replace(/\s+/g, " ").slice(0, 160)}` } : null;
    if (report && conn && !conn.closed) { flushActivity(); conn.call("agent.activity", { items: [report] }).catch(() => {}); }
  });
  pi.on("agent_settled", async (_e: any, ctx: any) => {
    flushActivity();
    ctxRef = ctx; watchTyping(ctx);
    reclaimSteered(); // steered but never landed (an Esc cleared pi's queue)
    inRun.clear();
    if (aborted) {
      aborted = false; unseen = false; update({ status: "idle" });
      const wasInterrupt = interrupting; interrupting = false;
      setTimeout(() => {
        if (!wasInterrupt) keepHeld(); // Angus's Esc: kept for his next message; an interrupt: they wait their turn as usual
        if (afterAbort) { const m = afterAbort; afterAbort = null; if (afterAbortTimer) { clearTimeout(afterAbortTimer); afterAbortTimer = null; } send(m, { triggerTurn: true }); }
      }, 50);
      return;
    }
    // J93: subagents still running → ◐ background; the ✓ (and its chime) comes when the last one ends.
    if (helpers.size) { unseen = false; update({ status: "background", helpers: helperList() }); }
    else { unseen = true; update({ status: "done" }); }
    if (afterAbort) { held.unshift(afterAbort); afterAbort = null; if (afterAbortTimer) { clearTimeout(afterAbortTimer); afterAbortTimer = null; } } // the abort came too late to stop the run
    setTimeout(releaseHeld, 50); // a held message starts the next turn
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
    "Keep your cards tidy (Angus: they drift out of sync quickly, and he doesn't want to be the one asking): as a project's owner (writer), whenever you finish something or notice drift, archive what's worth keeping but not current (board_update action archive, e.g. handle \"N3 H2\"; restorable), drop what's irrelevant, turn heard items into next / decide items (a question for Angus is a decide item, never a next), and keep where and next_step current. hyprpi also nudges owners to tidy stale cards; no need to ask Angus.",
    "One voice per project (Angus): when Angus writes to a project (@project), its OWNER (the card's writer) coordinates and answers, in the room and on the card. Other members don't post and don't start on it; they send what they know to the owner via talk and wait to be asked. If you own a project, you are that voice.",
    "Briefs for @project work (Angus, J54): when Angus's @project message to a project you OWN asks for a deliverable (something to build, fix or change, not just an answer), don't start building: first send your world's Thoughts agent (Thoughts-<world letter>) one line with talk, e.g. \"Thoughts-<letter>: @project got from Angus: '<his words verbatim>'; I'd <your plan in a few words>; brief it?\", and wait for its brief (usually given back to you) before doing anything substantial. Questions, card tidying and small card edits you just do yourself.",
    "Thoughts agents (Angus): each world may have a Thoughts agent (Thoughts-A, Thoughts-B, …) that keeps track of the workspace as a whole. Any agent, and project owners above all, may talk to them whenever it helps, e.g. when your peers can't give you a good answer or you need the bigger picture: talk / demand to Thoughts-<world letter> (e.g. Thoughts-C). It exists for every world and starts when talked to, even if `hyprpi list` shows it isn't running.",
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
      action: Type.Union([Type.Literal("add"), Type.Literal("edit"), Type.Literal("done"), Type.Literal("drop"), Type.Literal("archive"), Type.Literal("unarchive"), Type.Literal("where"), Type.Literal("next_step")]),
      section: Type.Optional(Type.Union([Type.Literal("decide"), Type.Literal("next"), Type.Literal("heard"), Type.Literal("done")])),
      handle: Type.Optional(Type.String({ description: "item handle, e.g. N2 (edit / done / drop); archive / unarchive take several: \"N3 H2\"" })),
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
    description: "Manage projects on your world's board. Creating or joining a project that was closed (archived) reopens it with its history. action: create (name = a SHORT @slug, one word like hyprpi or boards; longer names only when a project splits; title; you become a member and the writer), join, leave (note REQUIRED: a hand-off for the remaining members, what you did and what's left; it is sent to them), rename (name), title (title: the one-line description under the name), status (new|active|paused|archived), writer (hand the writer role to a member: agent name), assign (members: '+@A -@B'), icon (icon: one emoji for the project's card, e.g. 🎨; '-' clears it). When you create a project you may give it an icon; if you don't, hyprpi picks a fitting one from its name and title.",
    promptSnippet: "Create, join, leave or reshape a project on the board",
    parameters: Type.Object({
      action: Type.Union([Type.Literal("create"), Type.Literal("join"), Type.Literal("leave"), Type.Literal("rename"), Type.Literal("title"), Type.Literal("status"), Type.Literal("writer"), Type.Literal("assign"), Type.Literal("icon")]),
      project: Type.Optional(Type.String({ description: "@name or id (all but create)" })),
      name: Type.Optional(Type.String()), title: Type.Optional(Type.String()),
      note: Type.Optional(Type.String()), status: Type.Optional(Type.String()),
      writer: Type.Optional(Type.String()), members: Type.Optional(Type.String()),
      icon: Type.Optional(Type.String({ description: "create / icon: one emoji for the project (e.g. 🎨); '-' clears it" })),
    }, { additionalProperties: false }),
    execute: async (_id: string, p: any) => {
      const a = p.action;
      let r: any;
      if (a === "create") r = await call("board.project", { action: "create", name: p.name, title: p.title, ...(p.icon ? { icon: p.icon } : {}) });
      else if (a === "icon") r = await call("board.project", { action: "update", project: p.project, icon: p.icon ?? "" });
      else if (a === "join" || a === "leave") r = await call("board.project", { action: a, project: p.project, note: p.note });
      else if (a === "assign") r = await call("board.project", { action: "assign", project: p.project, members: p.members });
      else if (a === "writer") { const ids = await call("board.get", {}); const w = Object.entries(ids.names || {}).find(([, n]) => String(n).toLowerCase() === String(p.writer || "").replace(/^@/, "").toLowerCase()); if (!w) throw new Error("the writer must be a member (by name)"); r = await call("board.project", { action: "update", project: p.project, writer: w[0] }); }
      else if (a === "title") { if (!String(p.title || "").trim()) throw new Error("title: give the new title"); r = await call("board.project", { action: "update", project: p.project, title: String(p.title).trim() }); }
      else r = await call("board.project", { action: "update", project: p.project, ...(a === "rename" ? { name: p.name } : { status: p.status }) });
      return text(`@${r.name} (${r.id}): ${a} done.${r.reopened ? " It was a closed (archived) project: reopened with its history; read it (board_read) before adding to it." : ""}${r.told?.length ? " Told " + r.told.join(", ") + "." : ""}`, r);
    },
  });

  // /tinker TEXT: drop a friction fix off in the workshop world and carry on here.
  // /restart (J87, Angus): replace this agent's pi with a fresh one on the same session (frees memory,
  // picks up the current pi). Compacts first by default (J87 v2); /restart --no-compact keeps the full
  // context. Never mid-turn: it waits until the agent is idle with nothing held. The daemon reopens it.
  let restartReq: { compact: boolean; by: string } | null = null, restartBusy = false, restartTimer: ReturnType<typeof setInterval> | null = null;
  function armRestart() {
    if (!restartTimer) restartTimer = setInterval(() => { void tryRestart(); }, 1500);
    void tryRestart();
  }
  async function tryRestart() {
    if (!restartReq || restartBusy || !idle() || held.length) return;
    restartBusy = true;
    const ctx = ctxRef, req = restartReq;
    let compacted = "no compaction (--no-compact)";
    try {
      if (req.compact) {
        const tokens = safe(() => ctx?.getContextUsage?.()?.tokens) ?? null;
        if (tokens !== null && tokens < 20000) compacted = `no compaction needed (${Math.round(tokens / 1000)}k tokens)`;
        else compacted = await new Promise<string>((res) => {
          try {
            ctx?.ui?.notify?.("🔄 restart: compacting first…", "info");
            ctx.compact({ onComplete: () => res("compacted"), onError: (e: any) => res(`compaction failed: ${e?.message || e}; restarted anyway`) });
          } catch (e: any) { res(`compaction failed: ${e?.message || e}; restarted anyway`); }
        });
      }
      await call("agent.restartReady", { compacted });
      if (restartTimer) { clearInterval(restartTimer); restartTimer = null; }
      ctx?.ui?.notify?.(`🔄 restarting (${compacted})…`, "info");
      stopped = true; // don't reconnect from this process
      ctx.shutdown();
    } catch (e: any) {
      ctx?.ui?.notify?.(`/restart: ${e?.message || e}`, "error");
      restartReq = null; restartBusy = false;
      if (restartTimer) { clearInterval(restartTimer); restartTimer = null; }
    }
  }
  pi.registerCommand("restart", {
    description: "Restart this agent's pi on the same session (frees memory, picks up the current pi). Compacts first; --no-compact keeps the full context. /restart NAME restarts another agent",
    getArgumentCompletions: (prefix: string) => ("--no-compact".startsWith(prefix.trim()) && prefix.trim().startsWith("-") ? [{ value: "--no-compact", label: "--no-compact — keep the full context" }] : null),
    handler: async (args: any, ctx: any) => {
      ctxRef = ctx;
      const words = String(args ?? "").trim().split(/\s+/).filter(Boolean);
      const compact = !words.includes("--no-compact"), who = words.filter((w) => !w.startsWith("-"))[0];
      try {
        const r = await call("agent.restart", { ...(who ? { agent: who } : {}), compact, by: "Angus" });
        if (who) ctx.ui.notify(`🔄 ${r.agent}: ${r.already ? "already restarting" : r.queued ? "restarts when its turn ends" : "restarting"}${compact ? " (compacting first)" : ""}`, "info");
      } catch (e: any) { ctx.ui.notify(`/restart: ${e?.message || e}`, "error"); }
    },
  });

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

  // ---- Windows by name (Angus 2026-10-02): /hp-pin /hp-unpin /hp-summon /hp-dismiss /hp-focus, and the hyprpi_window
  // tool doing the same for agents. Targets: agent names / ids, @projects (their live members) and
  // panels (TUIs): agents|router, stream|room, search, projects|board, thoughts; this world by default,
  // "board:C" / "C:board" / "board-C" for another. Same daemon ops as SUPER+S / SUPER+D / SUPER+ALT+S,
  // always by address (no address = Angus's focused window) and with an explicit pin (no toggle).
  const PANEL_KIND: Record<string, string> = { agents: "router", router: "router", stream: "room", room: "room", search: "search", board: "board", projects: "board", thoughts: "thoughts" };
  const PANEL_LABEL: Record<string, string> = { router: "agents", room: "stream", search: "search", board: "projects", thoughts: "thoughts" };
  const WORDS = Object.keys(PANEL_KIND).join("|");
  const PANEL_RE = new RegExp(`^(?:(${WORDS})(?:[:\\-]?([a-z]|w\\d+))?|([a-z]|w\\d+):(${WORDS}))$`, "i");
  type Target = { kind: "agent" | "panel" | "project"; label: string; address?: string; id?: string; name?: string; members?: any[]; ws?: number };
  async function resolveTargets(names: string[]): Promise<{ targets: Target[]; errors: string[]; world: string }> {
    const l = await call("list");
    const all: any[] = l.agents || [];
    const world = all.find((a) => a.id === AGENT_ID)?.room || "";
    const cl: any[] = await hypr.clients().catch(() => []);
    let projects: any[] | null = null;
    const getProjects = async () => {
      if (projects) return projects;
      projects = [];
      for (const p of [{ room: world }, {}]) { try { projects.push(...((await call("board.get", p)).projects || [])); } catch { /* no board */ } }
      return projects;
    };
    const targets: Target[] = [], errors: string[] = [];
    for (const raw of names) {
      const n = raw.trim().replace(/[,;]+$/, "");
      if (!n) continue;
      const bare = n.replace(/^@/, ""), low = bare.toLowerCase();
      const agent = n.startsWith("@") && n.length > 1 && !all.some((a) => (a.name || "").toLowerCase() === low) ? null
        : all.find((a) => a.id === bare || (a.name || "").toLowerCase() === low || (a.display || "").toLowerCase() === low);
      if (agent) { targets.push({ kind: "agent", label: agent.display || agent.name || agent.id, id: agent.id, address: agent.address || undefined, ws: agent.workspace }); continue; }
      const pm = n.startsWith("@") ? null : bare.match(PANEL_RE);
      if (pm) {
        const kind = PANEL_KIND[(pm[1] || pm[4]).toLowerCase()], w = (pm[2] || pm[3] || world).toUpperCase();
        const wins = cl.filter((c) => c.title === `hyprpi-${kind} ${w}`).sort((a, b) => Number(b.workspace?.id > 0) - Number(a.workspace?.id > 0));
        if (!wins.length) { errors.push(`${PANEL_LABEL[kind]} ${w}: that panel isn't open`); continue; }
        for (const c of wins) targets.push({ kind: "panel", label: `${PANEL_LABEL[kind]} ${w}`, address: c.address, ws: c.workspace?.id });
        continue;
      }
      const p = (await getProjects()).find((x) => String(x.name).toLowerCase() === low || x.id === bare);
      if (p) {
        const ids = new Set([...(p.members || []), p.writer].filter(Boolean));
        const members = all.filter((a) => ids.has(a.id) && a.address && !a.parked && a.room === world);
        targets.push({ kind: "project", label: "@" + p.name, name: p.name, members });
        continue;
      }
      errors.push(`${n}: no agent, project or panel by that name`);
    }
    return { targets, errors, world };
  }
  // Agents (a project = its live members in this world) and panels as [label, address] pairs.
  const windowsOf = (ts: Target[]) => {
    const seen = new Set<string>(), out: [string, string][] = [], none: string[] = [];
    for (const t of ts) {
      const ws = t.kind === "project" ? (t.members || []).map((a) => [a.display || a.name || a.id, a.address] as [string, string]) : t.address ? [[t.label, t.address] as [string, string]] : [];
      if (!ws.length) none.push(t.kind === "project" ? `${t.label} (no live member in this world)` : `${t.label} (no window)`);
      for (const w of ws) if (!seen.has(w[1])) { seen.add(w[1]); out.push(w); }
    }
    return { wins: out, none };
  };
  async function windowAction(action: string, names: string[], opts: { toMyWorkspace?: boolean; clear?: boolean } = {}): Promise<{ ok: boolean; text: string; details?: any }> {
    if (!names.length) return { ok: false, text: `${action}: name one or more agents, @projects or panels (agents, stream, search, projects, thoughts; board:C for another world)` };
    const { targets, errors } = await resolveTargets(names);
    const lines: string[] = [...errors];
    if (!targets.length) return { ok: false, text: lines.join("\n") };
    if (action === "focus") {
      const t = targets.find((x) => x.kind !== "project");
      if (!t) return { ok: false, text: [...lines, "focus: give an agent or a panel, not a project"].join("\n") };
      if (t.kind === "agent") await call("agent.focus", { agent: t.id });
      else await hypr.focusWindow(t.address);
      if (targets.length > 1) lines.push("focus takes one window; used the first");
      return { ok: true, text: [`focused ${t.label}`, ...lines].join("\n") };
    }
    if (action === "summon") {
      const p: any = {
        agents: targets.filter((t) => t.kind === "agent").map((t) => t.id),
        projects: targets.filter((t) => t.kind === "project").map((t) => t.name),
        // one window per panel name (a duplicate stays where it is)
        panels: [...new Map(targets.filter((t) => t.kind === "panel").map((t) => [t.label, t.address])).values()],
      };
      if (opts.toMyWorkspace) { const me = (await call("list")).agents?.find((a: any) => a.id === AGENT_ID); if (me?.workspace > 0) p.workspace = me.workspace; }
      // Clear like SUPER+S (Angus 2026-10-02: "summoning via SUPER+S and hp-summon both dismiss everything
      // that is not explicitly pinned … the goal of these commands is to give me a way to tell you how to
      // organize my desktop"): guest.summon's auto-clear keeps only pinned windows and what's summoned,
      // not the focused one. clear: false summons without clearing.
      if (opts.clear !== false) p.auto = true;
      const r = await call("guest.summon", p, { timeoutMs: 20000 });
      const cleared: string[] = r.dismissed || [];
      if (cleared.length) lines.push(`cleared ${cleared.join(", ")}`);
      if (r.summoned?.length) lines.unshift(`summoned ${r.summoned.join(", ")}`);
      if (r.here?.length) lines.push(`already there: ${r.here.join(", ")}`);
      return { ok: true, text: lines.join("\n") || "nothing to summon", details: r };
    }
    const { wins, none } = windowsOf(targets);
    lines.push(...none.map((x) => x + ": skipped"));
    const done: string[] = [], pinned: string[] = [];
    for (const [label, address] of wins) {
      try {
        if (action === "pin" || action === "unpin") { await call("guest.pin", { address, pinned: action === "pin" }); done.push(label); continue; }
        const r = await call("guest.dismiss", { address });
        if (r.pinned) pinned.push(label);
        else if (r.panel) done.push(`${label} (closed)`);
        else if (r.dismissed?.length) done.push(label);
        else lines.push(`${label}: nowhere to send it`);
      } catch (e: any) { lines.push(`${label}: ${e?.message || e}`); }
    }
    const verb = action === "pin" ? "pinned" : action === "unpin" ? "unpinned" : "dismissed";
    if (done.length) lines.unshift(`${verb} ${done.join(", ")}`);
    if (pinned.length) lines.push(`pinned, so not dismissed: ${pinned.join(", ")} (/hp-unpin first)`);
    return { ok: done.length > 0, text: lines.join("\n") || `nothing to ${action}` };
  }
  const splitNames = (s: string) => String(s ?? "").split(/[\s,]+/).filter(Boolean);
  const WIN_HELP: Record<string, string> = {
    pin: "Pin agents, @projects or panels (TUIs) so dismiss / summon's clear leave them (light blue border)",
    unpin: "Unpin agents, @projects or panels (TUIs)",
    summon: "Bring agents, @projects (live members) or panels (TUIs) of this world to the workspace you're on; first clears it of everything not explicitly pinned (like SUPER+S)",
    dismiss: "Send agents / @project members home (or to the nearest workspace with room); a panel (TUI) is closed. Pinned ones stay",
    focus: "Jump to an agent's or a panel's (TUI's) window",
  };
  for (const action of Object.keys(WIN_HELP)) {
    pi.registerCommand("hp-" + action, {
      description: `hyprpi: ${WIN_HELP[action]}. /hp-${action} ${action === "focus" ? "NAME" : "NAME…"}  (panels: agents, stream, search, projects, thoughts; board:C = another world)`,
      handler: async (args: any, ctx: any) => {
        try {
          const r = await windowAction(action, splitNames(args));
          ctx.ui.notify(r.text, r.ok ? "info" : "warning");
        } catch (e: any) { ctx.ui.notify(`/hp-${action}: ${e?.message || e}`, "error"); }
      },
    });
  }
  pi.registerTool({
    name: "hyprpi_window",
    label: "hyprpi window",
    description: "Pin, unpin, summon, dismiss or focus hyprpi windows by name, like Angus's /hp-pin /hp-unpin /hp-summon /hp-dismiss /hp-focus and SUPER+ALT+S / SUPER+S / SUPER+D. targets: agent names or ids, @projects (their live members in this world) or panels (TUIs): agents, stream, search, projects, thoughts (this world; \"board:C\" for world C). summon brings them to the workspace Angus is on (to_my_workspace: to yours instead), first clearing it of every window that is not explicitly pinned, like SUPER+S (clear: false skips that); it works within one world. dismiss sends agents home or to the nearest workspace with room, and CLOSES a panel; pinned windows are refused. focus moves Angus's focus (and him) to that window: only when he asked for it.",
    promptSnippet: "Pin / unpin / summon / dismiss / focus hyprpi agent and panel windows by name",
    parameters: Type.Object({
      action: Type.Union([Type.Literal("pin"), Type.Literal("unpin"), Type.Literal("summon"), Type.Literal("dismiss"), Type.Literal("focus")]),
      targets: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
      to_my_workspace: Type.Optional(Type.Boolean({ description: "summon: to this agent's workspace instead of Angus's current one" })),
      clear: Type.Optional(Type.Boolean({ description: "summon: clear the workspace first (default true; only pinned windows stay)" })),
    }, { additionalProperties: false }),
    execute: async (_id: string, p: any) => {
      const r = await windowAction(p.action, p.targets.flatMap(splitNames), { toMyWorkspace: !!p.to_my_workspace, clear: p.clear });
      if (!r.ok) throw new Error(r.text);
      return text(r.text, r.details);
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

// "/ignore TEXT" (Angus, @hyprpi N52): a secret signpost. It is shown as his own message, verbatim
// with the "/ignore" prefix, and goes into the context exactly like that (the prefix tells the
// model to ignore it), but it starts no turn and gets no answer. Mid-turn it is held until the turn
// ends (never steered in). Not a registered command, so it isn't in pi's command list. Saved in the
// session as a custom message "hyprpi-ignore" (hyprpi's search finds it; topics and did lines skip it).
const IGNORE = /^\/ignore(?:\s|$)/;
function ignoreNotes(pi: ExtensionAPI) {
  const held: string[] = [];
  let idle = () => true;
  const add = (text: string) => pi.sendMessage({ customType: "hyprpi-ignore", content: text, display: true }, { triggerTurn: false });
  const flush = () => { while (held.length) add(held.shift()!); };
  pi.registerMessageRenderer("hyprpi-ignore", (m: any) => new UserMessageComponent(typeof m.content === "string" ? m.content : (m.content || []).map((c: any) => c.text || "").join(""), getMarkdownTheme()));
  pi.on("input", (e: any, ctx: any) => {
    const text = String(e?.text ?? "").trim();
    if (!IGNORE.test(text)) return { action: "continue" };
    idle = () => { try { return ctx?.isIdle?.() ?? true; } catch { return true; } };
    if (idle() && !e.streamingBehavior) add(text); else held.push(text);
    return { action: "handled" };
  });
  pi.on("agent_settled", async () => flush());
}
