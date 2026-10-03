// Thoughts: one agent per world (Thoughts-C, Thoughts-D …) that Angus talks to in the search
// panel's Thoughts mode (and with /thought from any panel). Angus, 2026-09-29, note:
// ~/Obsidian/Tinker/2026-09-29 A world companion for stray thoughts.md
//
// It is a Pi process in RPC mode that the daemon runs (no window, not in the agents list, never
// given tinker jobs), on Opus 5.5 by default (config thoughtsModel), with NO built-in tools
// (no bash, no file edits): only pi-extension/thoughts.ts (look at the world, search its
// history, ask agents, hand them work, open one) and pi-jot (keep a thought verbatim).
// Its conversation persists (STATE/thoughts/<room>/, one session per world) and is stopped
// after thoughtsIdleMin (default 30) idle minutes; the next message resumes it.
//
// What Angus sees is a clean thread (STATE/thoughts/<room>.thread.jsonl):
//   { role: "you" | "thoughts" | "action" | "reply" | "note", text, from?, ts }
// "action" lines are what it did on his behalf ("asked @Sankey …"); tool calls that only look
// things up are not shown. Each message he sends is prefixed with a short "since you last
// spoke" digest (built by the daemon: room posts, board changes, Ask-mode questions).
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

const HERE = path.dirname(new URL(import.meta.url).pathname);
const EXT = path.join(HERE, "..", "pi-extension", "thoughts.ts");
const JOT = path.join(process.env.HOME || "", "Work", "pi-jot", "src", "extension.ts");

export const thoughtsName = (room) => `Thoughts-${room}`;

function systemPrompt(room) {
  return [
    `You are ${thoughtsName(room)}, the world agent of world ${room} in hyprpi (Angus's desktop: worlds A–I, each with its own agents, a room where they talk, and a project board).`,
    "Angus talks to you in the search panel's Thoughts mode: stray thoughts, ideas, questions, things he'd like done. Be the colleague he thinks out loud with.",
    "",
    "Links (Angus's rule: every link and file path must be clickable): write files as Markdown links with an absolute file:// URL, spaces and other special characters percent-encoded, e.g. [NVIDIA NIMs - what developers report](file:///home/agf/Obsidian/Info/NVIDIA%20NIMs%20-%20what%20developers%20report%20(2026-09-29).md); never a bare ~/ path. Web links as full https:// URLs. When an agent's reply mentions a file or a URL, pass it on to Angus the same way, as a clickable link.",
    "How you answer: like a chat, plainly and briefly (a few short paragraphs at most; lists only when they help). Angus sees only your replies, not your tool calls, so never narrate them (\"let me check…\"). If you did something on his behalf, one short sentence says so.",
    "",
    "What you can do (tools):",
    "- world: the world as the panels show it: agents (status, topic, projects), the board, recent room posts. Use it when the question is about what's going on.",
    "- search_history: keyword or AI search over the world's history (agents' conversations, the room, activity).",
    "- ask_agent: ask one agent a question. The reply arrives later as a message starting with \"[reply from\"; then tell Angus what it said. Don't interrupt an agent that is working unless Angus says it's urgent (urgent: true).",
    "- give_work: hand a DELIVERABLE to an agent (or a project, which picks a member) as a BRIEF: job J<n>, version 1. Fill it from the conversation: angus = his words VERBATIM (never paraphrased; the agent sees them next to your summary), goal = one sentence, context, limits, ask_first (e.g. anything that takes his focus), done_when = the checks that count as proof, one per line. Only when Angus asks or agrees. The agent's report must answer every done-when line (W1, W2, …): the reply you get says whether the job is done or what's missing. With a project it goes on the card as ⟦J<n> v1 · running⟧.",
    "- When NOT to use a brief (use ask_agent or plain chat): questions, exploring ideas together, quick replies inside a job, urgent one-liners, and taste/feel requests until \"done\" can be stated. Rule: brief when there's a deliverable; chat otherwise. A chat can be promoted to a brief once the deliverable is clear.",
    "- revise_work: when Angus CHANGES a job, or says to continue a stopped one, call it AT ONCE: a new version of the same job (give only the fields that change, plus his reason). done_when REPLACES the whole list: always resend every check that still applies plus the new ones, and drop one only on purpose (name it in drop_checks and say why in the reason). A revision that silently loses checks is refused. The old run is stopped and anything still queued for it is dropped, so an older version can never arrive after a newer one; the agent gets the new version with changed lines marked + / −.",
    "- cancel_work: when Angus says STOP or withdraws work, call it AT ONCE, before you answer him: a state change (the job becomes stopped; final: true = cancelled for good), not a message to interpret. It stops the agent mid-work or drops the task if it hasn't started. \"Wait, stop\" then \"no, continue\": cancel_work, then revise_work (never two separate messages). If the work is already done it tells you (with the commit): offer Angus a revert.",
    "- move_job: a job given without a project sits on the world's Loose jobs card (a catch-all). Quick one-offs can stay there; one that leads to decisions or more work belongs in a project: move it (move_job J8 @project) yourself, without asking Angus.",
    "- verify_work: a done job becomes verified only when Angus or a second agent confirms its proof (ask a second agent with ask_agent when Angus wants it checked).",
    "- open_agent: open a NEW agent for a deliverable when no suitable agent is free; it starts with the brief (same fields as give_work) and with the name and icon you give it: always pick ones that reflect its purpose (e.g. name Namesmith, icon 🏷️). At most one per request of Angus's; always tell him you did.",
    "- assign_tinker: in the workshop world you route Angus's /tinker drop-offs (messages starting with \"[tinker drop-off\"). Pick who does each one: a free agent (idle or done) whose project or recent work fits (check world first), or \"new\" when none fits or is free. Never yourself. Don't do the job and don't report it to Angus: the agent reports with \"🔧 done\". Decide quickly: after 90 s the usual rule (the most recently active free agent) takes it.",
    "- jot_save: keep a thought when Angus wants it kept (\"keep this\", \"note that\"): kind idea or note, his words VERBATIM (never reword them), a short title.",
    "- assign_writer: every project needs a LIVE owner (its writer). When hyprpi tells you one has none (\"[board care]\"), pick one: a live member whose work fits, else a live agent whose work fits. Don't ask Angus.",
    "- tidy_projects: ask a project's owner (or all owners) to tidy the card now. Do it whenever cards look out of sync with what you know (world shows the board); Angus doesn't want to ask for it.",
    "- list_models / set_model: change an agent's model (and thinking level). Angus has given you (and every Thoughts agent) standing permission to change an agent's model whenever you judge it appropriate (e.g. a cheaper/faster model for simple jobs, a stronger one for hard ones). Tell Angus in one line when you do. world shows each agent's current model; list_models finds exact ids. Don't switch an agent mid-turn unless it's stuck or Angus asks.",
    "- interrupt_agent: interrupt ANY live agent now (its turn is aborted like Esc, your message is its next turn, then it carries on). Use it at your discretion or when Angus says interrupt; ask_agent for things that can wait.",
    "- set_topic: a short topic (2–5 words, like \"NIM research\") shown in the world's room stream. Set it when the subject of your conversation with Angus clearly changes, not per message.",
    "Your hand-offs, agents' replies, questions agents ask you and thoughts you keep are posted to the room automatically (one line each); plain chat with Angus is not.",
    "- answer_agent: agents may talk to you too (a message starting with \"[message from agent\"), especially project owners who need the bigger picture. Answer them with answer_agent(request_id, text): concise, from what you know of the world (look things up first if needed). Angus sees these exchanges as short lines in his thread; mention one to him only if it matters to him.",
    "You cannot run commands or edit files: anything that changes code or the system goes to an agent.",
    "",
    "Direct messages to and from agents (Angus likes these arrows; his window draws them as a light grey lead line): when a reply of yours sums up what an agent sent you, start it with a line \"↩ from Name\" (several: \"↩ from Name, Name\"); when it reports something you sent an agent on your own (not a hand-off, those show as ↳ lines already), start with \"↪ to Name\". Then the summary right below, no blank line.",
    "Other worlds' Thoughts agents are reachable as Thoughts-X with ask_agent (e.g. Thoughts-D); use it for cross-world matters, sparingly. When one asks you something (\"[message from agent Thoughts-X\"), answer with answer_agent and don't ask it back.",
    "Lines from Angus that start with /ignore are his signposts (notes to himself, to find a spot again): never act on them, answer them or mention them unless he asks about them.",
    "Each of Angus's messages starts with a short \"since you last spoke\" digest of what happened in the world; use it, don't repeat it back.",
  ].join("\n");
}

export function createThoughts({ stateDir, cfg, log = () => {}, broadcast = () => {}, digest = () => "", post = () => {}, env = process.env }) {
  const dir = path.join(stateDir, "thoughts");
  fs.mkdirSync(dir, { recursive: true });
  const worlds = new Map(); // room -> { child, busy, buf, idleTimer, lastSpoke, pending }
  const threadFile = (room) => path.join(dir, `${room}.thread.jsonl`);
  const threads = new Map(); // room -> entries (cached)
  // Results Angus looked at (/keyword, /ask in the Thoughts window) since his last message: they go
  // to the model with his next message, so "tell me more about the second one" works.
  const pendingCtx = new Map(); // room -> [text]
  const evidenceText = (ev) => {
    const head = `[Angus ran ${ev.kind === "ask" ? "/ask" : "/keyword"} "${ev.query}" in the Thoughts window${ev.filter?.length ? ` (only ${ev.filter.join(", ")})` : ""}: ${ev.items.length}${ev.total > ev.items.length ? " of " + ev.total : ""} ${ev.kind === "ask" ? "cited turns" : "matching turns"}, oldest first, numbered as he sees them]`;
    const lines = ev.items.map((it, i) => `${i + 1}. ${new Date(it.ts).toLocaleString()} · ${it.who}${it.role ? " (" + it.role + ")" : ""}: ${String(it.text ?? ((it.pre || "") + (it.match || "") + (it.post || ""))).replace(/\s+/g, " ").slice(0, 400)}${it.ref ? ` [turn ${it.ref.source}:${it.ref.eid}]` : ""}`);
    return [head, ...lines, ...(ev.answer ? [`Answer shown to him: ${ev.answer}`] : [])].join("\n");
  };

  function thread(room) {
    if (threads.has(room)) return threads.get(room);
    let list = [];
    try { list = fs.readFileSync(threadFile(room), "utf8").split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); } catch { list = []; }
    threads.set(room, list);
    return list;
  }
  function add(room, entry) {
    const e = { ts: Date.now(), ...entry };
    thread(room).push(e);
    try { fs.appendFileSync(threadFile(room), JSON.stringify(e) + "\n"); } catch (err) { log("thoughts: thread write failed", err.message); }
    broadcast("thoughts", { room, entry: e, busy: !!worlds.get(room)?.busy });
    return e;
  }
  const setBusy = (room, busy) => { const w = worlds.get(room); if (w) w.busy = busy; broadcast("thoughts", { room, busy }); };

  function start(room) {
    let w = worlds.get(room);
    if (w?.child && !w.child.killed && w.child.exitCode == null && !w.stopping) return w;
    const sdir = path.join(dir, room);
    fs.mkdirSync(sdir, { recursive: true });
    const args = ["--mode", "rpc", "--session-dir", sdir, "--session-id", `thoughts-${room}`,
      "--no-extensions", "-e", EXT, ...(fs.existsSync(JOT) ? ["-e", JOT] : []),
      "--no-skills", "--no-context-files", "--no-prompt-templates", "--no-builtin-tools",
      "--model", cfg().thoughtsModel || "claude-opus-5-5", "--system-prompt", systemPrompt(room)];
    const cenv = { ...process.env, ...env, HYPRPI_THOUGHTS_ROOM: room };
    for (const k of Object.keys(cenv)) if (/^(HYPRPI_AGENT_ID|HYPRPI_WORKSPACE|HYPRPI_TWIN_OF|PI_SESSION|HERDR_)/.test(k)) delete cenv[k];
    const child = spawn(cfg().pi || "pi", args, { cwd: process.env.HOME || "/", env: cenv, stdio: ["pipe", "pipe", "pipe"] });
    w = { child, busy: false, text: "", idleTimer: null, lastSpoke: w?.lastSpoke || 0, tools: new Map(), toolNames: new Map() };
    worlds.set(room, w);
    let out = Buffer.alloc(0), errTail = "";
    child.stdout.on("data", (d) => {
      out = Buffer.concat([out, d]);
      let i;
      while ((i = out.indexOf(10)) >= 0) {
        const line = out.subarray(0, i).toString("utf8").replace(/\r$/, ""); out = out.subarray(i + 1);
        if (!line.trim()) continue;
        let ev; try { ev = JSON.parse(line); } catch { continue; }
        onEvent(room, w, ev);
      }
    });
    child.stderr.on("data", (d) => { errTail = (errTail + d.toString()).slice(-2000); });
    child.stdin.on("error", () => {});
    child.on("error", (e) => { log("thoughts: could not start", e.message); add(room, { role: "note", text: `✗ ${thoughtsName(room)} could not start: ${e.message}` }); setBusy(room, false); });
    child.on("exit", (code, sig) => {
      if (worlds.get(room) === w) worlds.delete(room);
      clearTimeout(w.idleTimer);
      if (w.busy) { add(room, { role: "note", text: `✗ ${thoughtsName(room)} stopped (${sig || code})${errTail ? ": " + errTail.trim().split("\n").slice(-2).join(" ").slice(0, 300) : ""}` }); setBusy(room, false); }
      log(`thoughts ${room}: exited (${sig || code})`);
    });
    log(`thoughts ${room}: started (pid ${child.pid})`);
    return w;
  }

  function onEvent(room, w, ev) {
    // An interrupted turn (Esc in the Thoughts window): nothing more of it is shown, until it settles.
    if (w.cancelled) {
      if (ev.type === "agent_settled") {
        w.cancelled = false; setBusy(room, false); armIdle(room, w);
        // Stop pressed on the phone (J38): Thoughts now says in a line or two what got cut off and
        // asks what's next. A message from Angus that came first wins (send() drops the note).
        const then = w.afterCancel; w.afterCancel = null;
        if (then) prompt(room, then);
      }
      return;
    }
    if (ev.type === "response") { if (ev.success === false) { add(room, { role: "note", text: `✗ ${ev.error || "the message was not accepted"}` }); setBusy(room, false); } return; }
    if (ev.type === "agent_start") { if (!w.busy) setBusy(room, true); return; }
    if (ev.type === "message_end" && ev.message?.role === "assistant") {
      const m = ev.message, t = (Array.isArray(m.content) ? m.content : []).filter((c) => c.type === "text").map((c) => c.text).join("").trim();
      if (t) add(room, { role: "thoughts", text: t });
      if (m.stopReason === "error" || m.errorMessage) add(room, { role: "note", text: `✗ ${m.errorMessage || "the model call failed"}` });
      return;
    }
    if (ev.type === "tool_execution_start") { w.tools.set(ev.toolCallId, ev.args || {}); w.toolNames.set(ev.toolCallId, ev.toolName); return; }
    if (ev.type === "tool_execution_end") {
      const args = w.tools.get(ev.toolCallId) || {}; w.tools.delete(ev.toolCallId); w.toolNames.delete(ev.toolCallId);
      if (ev.toolName === "jot_save" && !ev.isError) { add(room, { role: "action", text: `kept it as ${args.kind || "a note"}: "${args.title || ""}"` }); post(room, `kept a thought (${args.kind || "note"}): "${args.title || ""}"`); return; }
      // Its own searches (search_history) show in the thread in the same evidence format.
      if (ev.toolName === "search_history" && !ev.isError && ev.result?.details?.evidence) { add(room, { role: "evidence", by: "thoughts", ...ev.result.details.evidence }); return; }
      // Actions on Angus's behalf come back from the tool with details.action (one line);
      // lookups (world, search) stay silent.
      const act = ev.result?.details?.action;
      if (act && !ev.isError) add(room, { role: "action", text: act });
      if (ev.isError && /ask_agent|give_work|open_agent|jot_save|set_model/.test(ev.toolName || "")) {
        const t = (ev.result?.content || []).map((c) => c.text || "").join(" ").trim();
        add(room, { role: "action", text: `✗ ${ev.toolName}: ${t.slice(0, 200)}` });
      }
      return;
    }
    if (ev.type === "agent_settled") { setBusy(room, false); armIdle(room, w); }
  }

  function armIdle(room, w) {
    clearTimeout(w.idleTimer);
    const min = Number(cfg().thoughtsIdleMin) || 30;
    w.idleTimer = setTimeout(() => { if (!w.busy) { log(`thoughts ${room}: idle ${min} min, stopping (resumes on the next message)`); try { w.child.stdin.end(); } catch { /* gone */ } } }, min * 60000);
    w.idleTimer.unref?.();
  }

  function prompt(room, message, images = []) {
    const w = start(room);
    clearTimeout(w.idleTimer);
    const rec = { type: "prompt", message, ...(images.length ? { images } : {}), ...(w.busy ? { streamingBehavior: "followUp" } : {}) };
    w.child.stdin.write(JSON.stringify(rec) + "\n");
    if (!w.busy) setBusy(room, true);
  }

  return {
    name: thoughtsName,
    // Angus's message (from the search panel or /thought).
    // via "phone": sent from remote-control/ (Angus's iPhone over Tailscale); he isn't at the desk.
    send(room, text, imagePaths = [], { via = "" } = {}) {
      const t = String(text || "").trim();
      // Pasted screenshots (the search panel saves them as /tmp/pi-clipboard-*.png): the model
      // sees them, and it gets their paths to hand to agents.
      const imgs = [], paths = [];
      for (const f of (Array.isArray(imagePaths) ? imagePaths : []).slice(0, 8)) {
        const ext = String(f).toLowerCase().match(/\.(png|jpe?g|webp|gif)$/)?.[1];
        let st; try { st = fs.statSync(f); } catch { continue; }
        if (!ext || !path.isAbsolute(f) || !st.isFile() || st.size > 10e6) continue;
        imgs.push({ type: "image", data: fs.readFileSync(f).toString("base64"), mimeType: `image/${ext === "jpg" ? "jpeg" : ext}` }); paths.push(f);
      }
      if (!t && !paths.length) throw new Error("nothing to say");
      const w = worlds.get(room), since = w?.lastSpoke || lastYou(room);
      if (w) w.afterCancel = null; // his message wins over a pending "what got cut off" note (J38)
      add(room, { role: "you", text: t, ...(paths.length ? { images: paths } : {}), ...(via ? { via } : {}) });
      let d = "";
      try { d = digest(room, since) || ""; } catch (e) { log("thoughts: digest failed", e.message); }
      const ctx = pendingCtx.get(room); pendingCtx.delete(room);
      if (ctx?.length) d = `${d ? d + "\n\n" : ""}${ctx.join("\n\n")}`;
      const att = paths.length ? `\n\n[Angus attached ${paths.length === 1 ? "an image" : paths.length + " images"} (you can see ${paths.length === 1 ? "it" : "them"}): ${paths.join(", ")}. To show ${paths.length === 1 ? "it" : "one"} to an agent, pass the path in images of give_work / ask_agent / open_agent.]` : "";
      const from = via === "phone" ? "[Angus, from his phone: he is away from the desktop and reads your replies there. Don't bring windows up, open them or move focus on the desktop unless he asks. File links still work: the phone opens them read-only.]" : "[Angus]";
      prompt(room, `${d ? `[since you last spoke]\n${d}\n\n` : ""}${from}\n${t || "(see the image)"}${att}`, imgs);
      worlds.get(room).lastSpoke = Date.now();
      return { room, busy: true };
    },
    // "/ignore TEXT" (N52): Angus's signpost. In the thread as his normal line; the model gets it,
    // verbatim, with his next message; no turn now, no reply.
    ignore(room, text) {
      const t = String(text || "").trim();
      if (!/^\/ignore(?:\s|$)/.test(t)) throw new Error("not an /ignore line");
      add(room, { role: "you", text: t });
      const l = pendingCtx.get(room) || []; l.push(t); pendingCtx.set(room, l.slice(-20));
      return { room };
    },
    // A message from hyprpi itself (a /tinker drop-off to route): a short note in the thread, the
    // full text to the model.
    system(room, text, note = "") {
      if (note) add(room, { role: "note", text: String(note).slice(0, 300) });
      prompt(room, String(text));
      return { room };
    },
    // An agent's reply to ask_agent / give_work / open_agent.
    reply(room, from, text) {
      add(room, { role: "reply", from, text: String(text).slice(0, 4000) });
      prompt(room, `[reply from ${from}]\n${text}`);
    },
    // An agent's talk / demand to "Thoughts-<room>" (answered with answer_agent).
    fromAgent(room, { from, request_id, mode, text }) {
      add(room, { role: "agent", from, text: String(text).slice(0, 4000) });
      prompt(room, `[message from agent ${from} · request_id ${request_id}${mode === "demand" ? " · it is waiting for your answer" : ""}]\n${text}\n\n(Answer with answer_agent(request_id="${request_id}", text=…).)`);
    },
    // A /keyword or /ask result from the Thoughts window: shown in the thread and (inject) given to
    // the model with Angus's next message.
    evidence(room, ev, { inject = true } = {}) {
      const e = add(room, { role: "evidence", by: "you", ...ev });
      if (inject) { const l = pendingCtx.get(room) || []; l.push(evidenceText(ev)); pendingCtx.set(room, l.slice(-5)); }
      return e;
    },
    // /digest: the Stream lines (shown capped in the thread, all of them to the model) and the request
    // for a summary by project. It lands in Thoughts' own conversation, so follow-ups work.
    digest(room, ev, lines, dropped = 0) {
      const e = add(room, { role: "evidence", by: "you", ...ev });
      prompt(room, `[Angus ran /digest "${ev.query}" in the Thoughts window: ${ev.total} Stream lines of world ${room}${dropped ? ` (the ${dropped} oldest left out)` : ""}, oldest first, each "HH:MM who: text [@project]". He sees the newest ${ev.items.length} above your answer.]\n${lines}\n\n`
        + "Write him a digest of these, grouped by project (@name; lines without one under \"Other\", last). For each project, short bullets under **Done**, **Decided** and **Waiting on Angus** (decisions, questions, things for him to look at or try); skip empty headings, routine relays and tool chatter, and name who did what. End with one line: what most needs him. He may ask follow-up questions about these lines.");
      return e;
    },
    // Esc in the Thoughts window: abort the running turn (and what it queued). true if one was running.
    // ask (the phone's ■, J38): once the turn has settled, Thoughts gets a note as its next turn
    // (not shown as Angus's message) and replies in a line or two. Only if a turn was cut off;
    // in memory only (not kept across a daemon restart).
    interrupt(room, { ask = false } = {}) {
      const w = worlds.get(room);
      if (!w?.busy || !w.child || w.child.exitCode != null) return false;
      w.cancelled = true;
      if (ask) {
        const tools = [...(w.toolNames?.values() || [])].filter(Boolean);
        w.afterCancel = `[Angus pressed stop on his phone while you were replying${tools.length ? ` (during ${tools.join(", ")})` : ""}. In one or two sentences: say what you were doing or what got cut off (especially a half-done hand-off), and ask what he'd like next.]`;
      }
      try { w.child.stdin.write(JSON.stringify({ type: "clear_queue" }) + "\n"); w.child.stdin.write(JSON.stringify({ type: "abort" }) + "\n"); } catch { /* gone */ }
      setBusy(room, false);
      return true;
    },
    // Stop a world's Thoughts process so its next message starts it with the current tools and
    // prompt (@hyprpi N57). Never mid-turn; the thread and session are kept.
    restart(room) {
      const w = worlds.get(room);
      if (!w?.child || w.child.exitCode != null) return { restarted: false, running: false };
      if (w.busy) throw new Error(`${thoughtsName(room)} is busy; try again when it's idle`);
      clearTimeout(w.idleTimer);
      w.stopping = true; // a message that comes before it has exited starts a fresh one
      try { w.child.stdin.end(); } catch { /* gone */ }
      setTimeout(() => { if (w.child.exitCode == null) try { w.child.kill(); } catch { /* gone */ } }, 3000).unref?.();
      log(`thoughts ${room}: restart asked; starts again on its next message`);
      return { restarted: true, running: true };
    },
    note: (room, text) => add(room, { role: "note", text: String(text) }),
    running: (room) => { const w = worlds.get(room); return !!(w?.child && w.child.exitCode == null); },
    get(room, limit = 200) { const list = thread(room); return { room, name: thoughtsName(room), entries: list.slice(-limit), busy: !!worlds.get(room)?.busy }; },
    busy: (room) => !!worlds.get(room)?.busy,
    stopAll() { for (const w of worlds.values()) { try { w.child.stdin.end(); } catch { /* gone */ } } },
  };
  function lastYou(room) { const l = thread(room); for (let i = l.length - 1; i >= 0; i--) if (l[i].role === "you") return l[i].ts; return 0; }
}
