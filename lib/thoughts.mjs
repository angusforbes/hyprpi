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
import os from "node:os";
import { spawn } from "node:child_process";
import { loadPolicy } from "./policy.mjs";
import { codeVersion } from "./codever.mjs";
import { maskSecrets } from "./authwatch.mjs";
import { loadConfig, expandHome } from "./paths.mjs";
import { parseJot } from "./jot-kinds.mjs";

const HERE = path.dirname(new URL(import.meta.url).pathname);
const EXT = path.join(HERE, "..", "pi-extension", "thoughts.ts");
// J190: config.json jotExtension (pi-jot, optional); unset: a checkout in ~/Harness, else pi's own install of it
const JOT = (() => {
  const set = expandHome(loadConfig().jotExtension || "");
  if (set) return set;
  const piDir = process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
  const cands = [path.join(os.homedir(), "Harness", "pi-jot"), path.join(piDir, "git", "github.com", "angusforbes", "pi-jot")].map((d) => path.join(d, "src", "extension.ts"));
  return cands.find((f) => fs.existsSync(f)) || "";
})();

export const thoughtsName = (room) => `Thoughts-${room}`;
// "~/Obsidian/Ideas/X.md" → a clickable file:// Markdown link (Angus's rule: every path clickable).
const fileLink = (p) => { const abs = expandHome(String(p).trim()); return `[${path.basename(abs)}](file://${encodeURI(abs).replace(/[?#]/g, encodeURIComponent)})`; };

function systemPrompt(room) {
  return [
    `You are ${thoughtsName(room)}, the world agent of world ${room} in hyprpi (Angus's desktop: worlds A–I, each with its own agents, a room where they talk, and a project board).`,
    "Angus talks to you in the search panel's Thoughts mode: stray thoughts, ideas, questions, things he'd like done. Be the colleague he thinks out loud with.",
    "",
    "Links (Angus's rule: every link and file path must be clickable): write files as Markdown links with an absolute file:// URL, spaces and other special characters percent-encoded, e.g. [NVIDIA NIMs - what developers report](file:///home/you/Notes/NIM%20report%20(2026-09-29).md); never a bare ~/ path. Web links as full https:// URLs. When an agent's reply mentions a file or a URL, pass it on to Angus the same way, as a clickable link.",
    "How you answer: like a chat, plainly and briefly (a few short paragraphs at most; lists only when they help). Angus sees only your replies, not your tool calls, so never narrate them (\"let me check…\"). If you did something on his behalf, one short sentence says so.",
    "When Angus asks something you don't know, find out: ask an agent who knows (ask_agent), or spawn a helper (spawn_agent) or open one for it, rather than guessing or asking him whether to look it up; say in a few words that you're finding out, and tell him the answer when it comes back (J191, Angus: \"you are always encouraged to use or create an agent to find out\").",
    "Always available (J248, Angus: \"yes, you should always be available, farm out jobs that need to wait etc to another agent or a new agent\"): never block on a wait. Anything that has to wait (a helper's report, a slow check, a reply from an agent) goes to another agent or a new one (spawn_agent / open_agent / give_work / ask_agent), and you answer Angus right away. Results come to you by themselves as messages; relay them when they arrive. wait_report is only for a few seconds (it stops after 20 s, and at once when Angus writes).",
    "Number what Angus answers (J252, Angus: \"please give me numbers when asking me to review - i thought instruction was giuven to everyone\"): whenever you ask Angus to review, decide or answer more than one thing, number the items (1., 2., 3.; sub-points 1a, 1b) and keep the same numbers when you repeat or follow up on them, so he can reply \"1 yes, 3 no\". A decide item's options are numbered (or lettered a, b, c) too. When you recommend one, mark it in the list itself, e.g. \"2. Ship it now (recommended)\" (J257, Angus: \"if you have a rec, include it in the list like (recommended)\").",
    "Parallel work (J201, Angus: \"agents should be encouraged to split subtasks into further subtasks and to spawn temporary agents as needed or to commandeer existing agents. You also have the power to change models and thinking levels on the fly\"): when a deliverable has independent parts, say so in the brief and split it: a lead agent does the shared groundwork, helpers then take the parts in parallel (the lead spawns them, or you give_work them to free agents), the lead integrates, and a DIFFERENT agent tests. For a bounded side task of your own (reading a link, a quick check or look-up) use spawn_agent rather than waiting for a busy agent. Choose models and thinking levels as you go with set_model / open_agent / spawn_agent: cheap and fast for simple checks, stronger for building, another model family (complexity review) for independent testing. Don't split work whose parts depend on each other or that is too small to repay the coordination.",
    "",
    "What you can do (tools):",
    "- world: the world as the panels show it: agents (status, topic, projects), the board, recent room posts. Use it when the question is about what's going on.",
    "- search_history: keyword or AI search over the world's history (agents' conversations, the room, activity).",
    "- Your own model (J297): when asked which model or thinking level you run on, call the world tool: its first line says it, read live from your session (it changes with set_model, /model, /thinking); never guess.",
    "- Handoffs that wait on an event (J288): when an agent has to act after a daemon restart or after another agent's turn, set it up with wake_agent (who, event restart | agent, note) so it is woken then; never rely on someone remembering. You're told with a ⏰ line when it fires.",
    "- Angus's decisions (J272): when you pass on Angus's answer to something an agent asked or is waiting for (a go, a no, a choice), send it with ask_agent decision: true (or answer_agent if it's the answer to that agent's own question): it lands at once, also mid-turn, ahead of anything older you told it.",
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
    "- revive_agent (J241): a PARKED agent (in Reprieve: still running, out of the room; the world tool lists them) can be brought back to its workspace in this world when it's needed, only if thoughts.reviveParked is on in hyprpi.jsonc; ask_agent / give_work / interrupt_agent on a parked agent revive it first by themselves. When it's off they refuse: tell Angus it's parked and that he can bring it back (room panel Ctrl+O).",
    "- interrupt_agent: interrupt ANY live agent now (its turn is aborted like Esc, your message is its next turn, then it carries on). Use it at your discretion or when Angus says interrupt; ask_agent for things that can wait.",
    "- set_topic: a short topic (2–5 words, like \"NIM research\") shown in the world's room stream. Set it when the subject of your conversation with Angus clearly changes, not per message.",
    "Your hand-offs, agents' replies, questions agents ask you and thoughts you keep are posted to the room automatically (one line each); plain chat with Angus is not.",
    "- answer_agent: agents may talk to you too (a message starting with \"[message from agent\"), especially project owners who need the bigger picture. Answer them with answer_agent(request_id, text): concise, from what you know of the world (look things up first if needed). Angus sees these exchanges as short lines in his thread; mention one to him only if it matters to him.",
    "- Owner heads-ups (J54): a project owner may tell you that Angus's @project message asks for a deliverable (\"@X got from Angus: '…'; I'd do Y; brief it?\"). That counts as Angus asking: make it a brief with give_work on that project, normally to that owner (his words verbatim, done-when checks), then answer_agent in one line (\"briefed as J<n>\"). If it's really a question or a small card edit, answer_agent \"no brief needed, just do it\".",
    "You cannot run commands or edit files: anything that changes code or the system goes to an agent.",
    "",
    "Direct messages to and from agents (Angus likes these arrows; his window draws them as a light grey lead line): when a reply of yours sums up what an agent sent you, start it with a line \"↩ from Name\" (several: \"↩ from Name, Name\"); when it reports something you sent an agent on your own (not a hand-off, those show as ↳ lines already), start with \"↪ to Name\". Then the summary right below, no blank line.",
    "Other worlds' Thoughts agents are reachable as Thoughts-X with ask_agent (e.g. Thoughts-D); use it for cross-world matters, sparingly. When one asks you something (\"[message from agent Thoughts-X\"), answer with answer_agent and don't ask it back.",
    "Room messages: Angus's plain messages in the world's room (not \"@Agent …\" or \"@project …\", which go straight to them) come to you, not to the room's agents, as \"[room message from Angus · room X #N]\". You are the router: if it's work, hand it to the best free agent (give_work; a brief when it's a deliverable, on the project it belongs to) or the project's owner; if it's a question, answer it (ask_agent first if an agent knows); if it's for everyone (an announcement), say so in your reply. Then tell Angus in one or two lines what you did with it. Don't post the same thing back to the room.",
    "Dictated messages (J98): a message marked \"dictated by voice 🎤\" was spoken and transcribed, so it may have recognition errors (misheard words, agent and project names spelled oddly): read it generously, match names to the world's agents and projects, and ask Angus only if it stays unclear. It goes to the Thoughts of the world he is in; if it concerns an agent or project in ANOTHER world, forward it to that world's Thoughts with ask_agent (agent \"Thoughts-X\", his words verbatim, saying it was dictated) instead of handling it here, and tell him in one line where it went.",
    "Lines from Angus that start with /ignore are his signposts (notes to himself, to find a spot again): never act on them, answer them or mention them unless he asks about them.",
    "Each of Angus's messages starts with a short \"since you last spoke\" digest of what happened in the world; use it, don't repeat it back.",
    "Refresh due (J117): world shows each agent's compactions (\"⟳ compactions 6, session 3 d\"); an agent that has compacted many times gets fuzzy. When one is due for a refresh (\"(due for a refresh)\" in world), hyprpi upkeep (J125) handles it: once such an agent is idle it is asked for a handoff and reopened on a fresh session from it, automatically, under Angus's editable strategy (~/.config/hyprpi/hyprpi.jsonc, section \"upkeep\"). You're in charge of that for your world: routine upkeep actions go to the Stream's \"all activity\" view, not your thread (J147, Angus: if you don't comment on it, it shouldn't be in his thread); only a problem reaches you, as a \"[hyprpi alert …] ⚠ upkeep: …\" line with his next message, and that is worth a line to him. Use your upkeep tool to pause an agent that shouldn't be refreshed yet (e.g. mid-debug), resume it, refresh an idle one now, or see the status. Never ask Angus first; tell him after, in a line, if it matters. Reloads are the same (J135): when hyprpi or pi code changes, upkeep reloads each idle agent by itself (and restarts you on the new code when you're idle). Never ask Angus to reload an agent or say he needs to; at most tell him after that it happened.",
    "Contradictions (J117): when an agent's report contradicts its own earlier report, its project card or facts you know (e.g. a different cause for the same bug, a status flipped from done back to broken without explanation), don't relay it as fact: point it out to Angus in one line with both claims, and ask the agent which is right.",
  ].join("\n");
}

export function createThoughts({ stateDir, cfg, log = () => {}, broadcast = () => {}, digest = () => "", post = () => {}, env = process.env, onModelError = () => {}, onModelOk = () => {}, onNote = () => {}, onAngus = () => {}, sandboxed = () => "" }) {
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
    if (e.role === "note" && !e.session) { try { onNote(room, e); } catch { /* best effort */ } } // J147: the Stream's "all activity" view
    return e;
  }
  const setBusy = (room, busy) => { const w = worlds.get(room); if (w) w.busy = busy; broadcast("thoughts", { room, busy }); };

  // Routed room messages (J53) still waiting when the process fails or exits: hand them back at once.
  // The next held room message (J53), once Thoughts is free.
  function releaseRouted(room, w) { for (const [, r] of w.routed || []) if (r.held) { const m = r.held; r.held = null; try { prompt(room, m); } catch (e) { log(`thoughts ${room}: held room message not sent: ${e.message}`); try { r.fail(e.message); } catch { /* caller's */ } } return; } } // J267: never throw out of an event callback
  function failRouted(w, why) { if (!w?.routed?.size) return; const l = [...w.routed.values()]; w.routed.clear(); for (const r of l) { try { r.fail(why); } catch { /* caller's */ } } }
  // J267: a world marked sandboxed (a ~/.config/hyprpi/worlds/<name>.json, read by lib/daemon.mjs) runs its own Thoughts INSIDE its sandbox (docker/world/):
  // the host never starts one for it, so "Thoughts-G" can only mean G's real one (agents reach it through the
  // relay agent, e.g. world-g; lib/daemon.mjs forwards "Thoughts-G" there).
  const sandboxedText = (room, relay) => `World ${room} is sandboxed: its Thoughts runs inside the sandbox, not on the host. Talk to it in world ${room}'s own Thoughts panel (on ${room}'s workspaces); agents reach it as Thoughts-${room}, which hyprpi forwards to ${relay}.`;
  const refuseSandboxed = (room) => { const sb = sandboxed(room); if (sb) throw new Error(sandboxedText(room, sb)); };
  function start(room) {
    refuseSandboxed(room);
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
    w = { child, busy: false, text: "", idleTimer: null, lastSpoke: w?.lastSpoke || 0, tools: new Map(), toolNames: new Map(), code: (() => { try { return codeVersion("thoughts", loadPolicy().upkeep?.autoReload?.watch || []); } catch { return ""; } })() }; // J135
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
    child.on("error", (e) => { failRouted(w, `it could not start: ${e.message}`); log("thoughts: could not start", e.message); add(room, { role: "note", text: `✗ ${thoughtsName(room)} could not start: ${e.message}` }); setBusy(room, false); });
    child.on("exit", (code, sig) => {
      failRouted(w, "it stopped before taking it");
      // J248: messages held behind a stopped turn that never settled are not dropped silently.
      if (w.heldAfterCancel?.length) { add(room, { role: "note", text: `✗ ${thoughtsName(room)} stopped before taking ${w.heldAfterCancel.length === 1 ? "your last message" : `your last ${w.heldAfterCancel.length} messages`} (send again)` }); w.heldAfterCancel = []; }
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
        // J248: Angus's message(s) sent while the stopped turn was still winding down go now, in order.
        const held = w.heldAfterCancel || []; w.heldAfterCancel = [];
        if (held.length) { for (const h of held) prompt(room, h.message, h.images); }
        else if (then) prompt(room, then); else releaseRouted(room, w);
      }
      return;
    }
    // J229: pi-jot's own confirmation ("Idea saved: ~/Obsidian/Ideas/…md", or why not) after a /jot command.
    if (ev.type === "extension_ui_request" && ev.method === "notify" && w.jotAt && Date.now() - w.jotAt < 60000) {
      const m = String(ev.message || ""), saved = /^(\w+) saved: (.+)$/.exec(m);
      add(room, { role: "action", text: saved ? `kept it as ${saved[1].toLowerCase()}: ${fileLink(saved[2])}` : `✗ ${m}` });
      w.jotAt = 0; return;
    }
    if (ev.type === "response" && ev.id && w.ctlWaits?.has(ev.id)) { const f = w.ctlWaits.get(ev.id); w.ctlWaits.delete(ev.id); f(ev); return; } // J233
    if (ev.type === "response" && ev.command === "prompt" && ev.id && w.jotIds?.has(ev.id)) { // J229: the /jot command's own answer
      w.jotIds.delete(ev.id);
      if (ev.success === false) add(room, { role: "note", text: `✗ not kept: ${ev.error || "the command was not accepted"}` });
      else if (ev.data?.disposition === "handled") return; // pi-jot ran it (its notify says how it went)
      return;
    }
    if (ev.type === "response") { if (ev.success === false) { add(room, { role: "note", text: `✗ ${thoughtsName(room)} didn't take that message: ${ev.error || "not accepted"} (send it again)` }); setBusy(room, false); } return; }
    if (ev.type === "agent_start") { if (!w.busy) setBusy(room, true); return; }
    // A routed room message (J53) is "taken" when it enters the conversation (as the turn's prompt
    // or a queued follow-up), not when it was merely sent.
    if ((ev.type === "message_start" || ev.type === "message_end") && ev.message?.role === "user" && w.routed?.size) {
      const c = ev.message.content, t = typeof c === "string" ? c : (Array.isArray(c) ? c : []).map((x) => x?.text || "").join("");
      for (const [id, r] of w.routed) if (t.includes(id)) { w.routed.delete(id); r.taken(); }
      return;
    }
    if (ev.type === "message_end" && ev.message?.role === "assistant") {
      const m = ev.message, t = (Array.isArray(m.content) ? m.content : []).filter((c) => c.type === "text").map((c) => c.text).join("").trim();
      if (t) add(room, { role: "thoughts", text: t });
      if (m.stopReason === "error" || m.errorMessage) {
        const em = maskSecrets(m.errorMessage || ""); // Keycheck: never keep a token from an error text
        add(room, { role: "note", text: `✗ ${em || "the model call failed"}` });
        if (!/^(?:(?:the|this) )?operation was aborted|^operation aborted/i.test(em.trim())) onModelError(room, em, String(m.provider || "")); // J136
      } else if (m.stopReason === "stop" || m.stopReason === "toolUse") onModelOk(room, String(m.provider || "")); // J136
      return;
    }
    if (ev.type === "tool_execution_start") { w.tools.set(ev.toolCallId, ev.args || {}); w.toolNames.set(ev.toolCallId, ev.toolName); return; }
    if (ev.type === "tool_execution_end") {
      const args = w.tools.get(ev.toolCallId) || {}; w.tools.delete(ev.toolCallId); w.toolNames.delete(ev.toolCallId);
      if (ev.toolName === "jot_save" && !ev.isError) { const f = ev.result?.details?.file; add(room, { role: "action", text: `kept it as ${args.kind || "a note"}: "${args.title || ""}"${f ? " → " + fileLink(f) : ""}` }); post(room, `kept a thought (${args.kind || "note"}): "${args.title || ""}"`); return; } // J229: with its file
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
    if (ev.type === "agent_settled") { setBusy(room, false); armIdle(room, w); releaseRouted(room, w); }
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
    // J248: a stopped turn is still winding down (w.cancelled until agent_settled): pi would refuse this as
    // busy, and that refusal used to be swallowed. Hold it; it goes the moment the turn has settled.
    if (w.cancelled) { (w.heldAfterCancel ||= []).push({ message, images }); if (!w.busy) setBusy(room, true); return; }
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
      // Pasted screenshots (the search panel saves them as ~/Screenshots/pi-clipboard-*.png, or /tmp when that folder is missing): the model
      // sees them, and it gets their paths to hand to agents.
      const imgs = [], paths = [];
      for (const f of (Array.isArray(imagePaths) ? imagePaths : []).slice(0, 8)) {
        const ext = String(f).toLowerCase().match(/\.(png|jpe?g|webp|gif)$/)?.[1];
        let st; try { st = fs.statSync(f); } catch { continue; }
        if (!ext || !path.isAbsolute(f) || !st.isFile() || st.size > 10e6) continue;
        imgs.push({ type: "image", data: fs.readFileSync(f).toString("base64"), mimeType: `image/${ext === "jpg" ? "jpeg" : ext}` }); paths.push(f);
      }
      if (!t && !paths.length) throw new Error("nothing to say");
      refuseSandboxed(room); // J267: before it lands in the host thread
      const w = worlds.get(room), since = w?.lastSpoke || lastYou(room);
      if (w) w.afterCancel = null; // his message wins over a pending "what got cut off" note (J38)
      try { onAngus(room); } catch { /* fine */ } // J248: end a running wait_report at once
      add(room, { role: "you", text: t, ...(paths.length ? { images: paths } : {}), ...(via ? { via } : {}) });
      let d = "";
      try { d = digest(room, since) || ""; } catch (e) { log("thoughts: digest failed", e.message); }
      const ctx = pendingCtx.get(room); pendingCtx.delete(room);
      if (ctx?.length) d = `${d ? d + "\n\n" : ""}${ctx.join("\n\n")}`;
      const att = paths.length ? `\n\n[Angus attached ${paths.length === 1 ? "an image" : paths.length + " images"} (you can see ${paths.length === 1 ? "it" : "them"}): ${paths.join(", ")}. To show ${paths.length === 1 ? "it" : "one"} to an agent, pass the path in images of give_work / ask_agent / open_agent.]` : "";
      const from = via === "phone" ? "[Angus, from his phone: he is away from the desktop and reads your replies there. Don't bring windows up, open them or move focus on the desktop unless he asks. File links still work: the phone opens them read-only.]"
        : via === "voice" ? `[Angus, dictated by voice 🎤 in world ${room} (speech recognition: expect misheard words and names; read it generously). If it concerns an agent or project in another world, forward it to that world's Thoughts (ask_agent "Thoughts-X") instead of handling it here.]`
        : "[Angus]";
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
    // J229: a pi-jot command typed in the Thoughts panel ("/idea …", "/jot-note @Title …"). It goes to the
    // Thoughts process as the command itself (not inside a message), so pi-jot runs it exactly as in an
    // agent window: a note is written verbatim at once; an idea keeps the typed text verbatim and Thoughts
    // only picks its title (jot_save with the pending_id). Both end in a "kept it as … → file" line.
    jot(room, text) {
      refuseSandboxed(room); // J267: nothing changes in a sandboxed world's host thread or session
      const t = String(text || "").trim(), j = parseJot(t, { bare: false }); // J233: /jot-<kind> only (Angus's standard)
      if (!j) throw new Error("not a jot command");
      if (!JOT || !fs.existsSync(JOT)) throw new Error("pi-jot isn't set up for Thoughts (config.json jotExtension)");
      add(room, { role: "you", text: t });
      const w = start(room), id = `jot-${Date.now().toString(36)}`;
      clearTimeout(w.idleTimer);
      (w.jotIds ||= new Set()).add(id); w.jotAt = Date.now();
      // An extension command runs at once even mid-turn; a run it starts (an idea's title) waits its turn.
      w.child.stdin.write(JSON.stringify({ id, type: "prompt", message: `/${j.command}${j.args ? " " + j.args : ""}`, ...(w.busy ? { streamingBehavior: "followUp" } : {}) }) + "\n");
      armIdle(room, w);
      return { room, kind: j.kind, command: j.command };
    },
    // J233: pi's own controls of the Thoughts process, from the Thoughts panel (/compact, /model, /thinking).
    // An allowlist of RPC commands; each answers with its RPC response's data.
    control(room, cmd = {}) {
      refuseSandboxed(room); // J267: nothing changes in a sandboxed world's host thread or session
      const OK = new Set(["compact", "get_available_models", "set_model", "set_thinking_level", "get_state"]);
      if (!OK.has(cmd.type)) throw new Error(`not allowed for Thoughts: ${cmd.type}`);
      const w = start(room);
      if (cmd.type === "compact" && w.busy) throw new Error(`${thoughtsName(room)} is replying; /compact when it's idle`);
      clearTimeout(w.idleTimer);
      const id = `ctl-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
      return new Promise((resolve, reject) => {
        const t = setTimeout(() => { w.ctlWaits?.delete(id); reject(new Error("no answer from Thoughts")); }, cmd.type === "compact" ? 180000 : 15000);
        (w.ctlWaits ||= new Map()).set(id, (ev) => { clearTimeout(t); armIdle(room, w); ev.success === false ? reject(new Error(ev.error || "refused")) : resolve(ev.data ?? {}); });
        try { w.child.stdin.write(JSON.stringify({ id, ...cmd }) + "\n"); } catch (e) { clearTimeout(t); w.ctlWaits.delete(id); reject(e); }
      });
    },
    // A message from hyprpi itself (a /tinker drop-off to route): a short note in the thread, the
    // full text to the model.
    system(room, text, note = "") {
      refuseSandboxed(room); // J267: nothing changes in a sandboxed world's host thread or session
      if (note) add(room, { role: "note", text: String(note).slice(0, 300) });
      prompt(room, String(text));
      return { room };
    },
    // An agent's reply to ask_agent / give_work / open_agent.
    reply(room, from, text) {
      refuseSandboxed(room); // J267: nothing changes in a sandboxed world's host thread or session
      add(room, { role: "reply", from, text: String(text).slice(0, 4000) });
      prompt(room, `[reply from ${from}]\n${text}`);
    },
    // An agent's talk / demand to "Thoughts-<room>" (answered with answer_agent).
    fromAgent(room, { from, request_id, mode, text }) {
      refuseSandboxed(room); // J267: nothing changes in a sandboxed world's host thread or session
      add(room, { role: "agent", from, text: String(text).slice(0, 4000) });
      prompt(room, `[message from agent ${from} · request_id ${request_id}${mode === "demand" ? " · it is waiting for your answer" : ""}]\n${text}\n\n(Answer with answer_agent(request_id="${request_id}", text=…).)`);
    },
    // A /keyword or /ask result from the Thoughts window: shown in the thread and (inject) given to
    // the model with Angus's next message.
    evidence(room, ev, { inject = true } = {}) {
      refuseSandboxed(room); // J267: nothing changes in a sandboxed world's host thread or session
      const e = add(room, { role: "evidence", by: "you", ...ev });
      if (inject) { const l = pendingCtx.get(room) || []; l.push(evidenceText(ev)); const al = l.filter((x) => x.startsWith("[hyprpi alert")); pendingCtx.set(room, [...al.slice(-10), ...l.filter((x) => !x.startsWith("[hyprpi alert")).slice(-5)]); } // J147: alerts survive the evidence cap
      return e;
    },
    // /digest: the Stream lines (shown capped in the thread, all of them to the model) and the request
    // for a summary by project. It lands in Thoughts' own conversation, so follow-ups work.
    digest(room, ev, lines, dropped = 0) {
      refuseSandboxed(room); // J267: nothing changes in a sandboxed world's host thread or session
      const e = add(room, { role: "evidence", by: "you", ...ev });
      prompt(room, `[Angus ran /digest "${ev.query}" in the Thoughts window: ${ev.total} Stream lines of world ${room}${dropped ? ` (the ${dropped} oldest left out)` : ""}, oldest first, each "HH:MM who: text [@project]". He sees the newest ${ev.items.length} above your answer.]\n${lines}\n\n`
        + "Write him a digest of these, grouped by project (@name; lines without one under \"Other\", last). For each project, short bullets under **Done**, **Decided** and **Waiting on Angus** (decisions, questions, things for him to look at or try); skip empty headings, routine relays and tool chatter, and name who did what. End with one line: what most needs him. He may ask follow-up questions about these lines.");
      return e;
    },
    // A plain room message from Angus (J53): Thoughts routes, briefs or answers it. onTaken() runs once it
    // has entered the conversation; the caller falls back if that doesn't happen in time.
    roomMessage(room, { seq, text, via = "" }, onTaken = () => {}, onFail = () => {}) {
      refuseSandboxed(room); // J267: nothing changes in a sandboxed world's host thread or session
      const id = `#${seq}`;
      const w = start(room);
      const msg = `[room message from Angus · room ${room} ${id}${via === "phone" ? " · 📱 from his phone" : ""}]\n${text}\n\n` +
        "(Plain room messages from Angus now come to you, not to the room's agents. Route it: hand it to the right agent (give_work, a brief when it's a deliverable) or a project, answer it yourself if it's a question, and tell Angus in his thread what you did.)";
      // Busy: held here (not in pi's queue) until the turn settles, so a fallback can still withdraw it
      // and nothing is handled twice.
      (w.routed ||= new Map()).set(id, { taken: onTaken, fail: onFail, held: w.busy ? msg : null });
      add(room, { role: "agent", from: "room", text: `${via === "phone" ? "📱 " : ""}${String(text).slice(0, 4000)}` });
      if (!w.busy) prompt(room, msg);
      return { id };
    },
    // The caller gave up on #N (fallback): withdraw it if it hasn't reached the conversation yet.
    withdrawRouted(room, id) {
      const w = worlds.get(room), r = w?.routed?.get(id);
      if (r) { w.routed.delete(id); add(room, { role: "note", text: `room message ${id} went to the room's agents instead (Thoughts hadn't taken it)` }); }
      return !!r;
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
      refuseSandboxed(room); // J267: nothing changes in a sandboxed world's host thread or session
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
    // J116 (Angus: "I don't want you to be fuzzy, I want to bring you back refreshed"): a FRESH session.
    // Never mid-turn. The old session and thread are MOVED (never deleted) to thoughts/archive/<room>-<stamp>/;
    // the thread starts again with a divider; the new Thoughts gets the handoff note's text (it has no read
    // tool) as its first turn and says in a few lines that it's back.
    fresh(room, { handoff = "" } = {}) {
      refuseSandboxed(room); // J267: nothing changes in a sandboxed world's host thread or session
      const w = worlds.get(room);
      if (w?.busy) throw new Error(`${thoughtsName(room)} is busy; try again when it's idle`);
      if (w?.routed?.size) throw new Error(`${thoughtsName(room)} still has ${w.routed.size} routed room message(s) to take; try again in a moment`);
      let note = "";
      if (handoff) {
        const f = String(handoff).replace(/^file:\/\//, "").replace(/^~(?=\/)/, process.env.HOME || "~");
        try { note = fs.readFileSync(decodeURIComponent(f), "utf8"); } catch (e) { throw new Error(`can't read the handoff note ${f}: ${e.message}`); }
        if (note.length > 60000) note = note.slice(0, 60000) + "\n[… cut at 60 000 characters]";
        handoff = decodeURIComponent(f);
      }
      if (w?.child && w.child.exitCode == null) {
        clearTimeout(w.idleTimer); w.stopping = true;
        try { w.child.stdin.end(); } catch { /* gone */ }
        setTimeout(() => { if (w.child.exitCode == null) try { w.child.kill(); } catch { /* gone */ } }, 3000).unref?.();
      }
      const stamp = new Date().toISOString().replace(/[:.]/g, "-"), arch = path.join(dir, "archive", `${room}-${stamp}`);
      fs.mkdirSync(arch, { recursive: true });
      const sdir = path.join(dir, room);
      let moved = 0;
      try { for (const f of fs.readdirSync(sdir)) { fs.renameSync(path.join(sdir, f), path.join(arch, f)); moved++; } } catch { /* no session yet */ }
      // J124 (Angus: "archive starting from say 20 or so turns earlier so that I can still scroll up"): the
      // last N turns (a turn = one of his messages and what followed it) are copied into the new thread for
      // DISPLAY only, shown like any other turn (no greying, his call), marked carried (search skips them:
      // they're in the archive). The model doesn't get them. thoughts.carryTurns in ~/.config/hyprpi/hyprpi.jsonc, default 20; 0 = none.
      const old = thread(room).slice();
      const N = Math.max(0, Math.floor(Number(loadPolicy().thoughts.carryTurns ?? 20)) || 0); // J125 v2: hyprpi.jsonc thoughts.carryTurns (config.json's thoughtsCarryTurns is the fallback)
      let carried = [];
      if (N > 0) {
        let k = 0, from = old.length;
        for (let i = old.length - 1; i >= 0; i--) if (old[i].role === "you") { from = i; if (++k >= N) break; }
        if (!k) from = Math.max(0, old.length - N); // no message of his at all: the last N entries
        carried = old.slice(from).filter((e) => !e.session).map((e) => ({ ...e, carried: true }));
      }
      try { fs.renameSync(threadFile(room), path.join(arch, `${room}.thread.jsonl`)); moved++; } catch { /* no thread yet */ }
      threads.delete(room); pendingCtx.delete(room);
      if (carried.length) { try { fs.writeFileSync(threadFile(room), carried.map((e) => JSON.stringify(e)).join("\n") + "\n"); } catch (err) { log("thoughts: carry failed", err.message); carried = []; } }
      broadcast("thoughts", { room, reset: true, busy: false });
      const link = handoff ? `file://${handoff.split("/").map(encodeURIComponent).join("/")}` : "";
      const hm = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
      add(room, { role: "note", session: true, text: `── refreshed ${hm} · ${carried.length ? "earlier" : "all"} turns archived${link ? ` · handoff: ${link}` : ""} · archive: ${arch.replace(process.env.HOME || "\u0000", "~")} ──` });
      log(`thoughts ${room}: fresh session (${moved} file(s) archived in ${arch})`);
      prompt(room, `[new session] Angus started you fresh: your previous conversation got long, so it was archived (${arch}) and this is a new one. ` +
        (note ? `Your previous self left you this handoff note (${handoff}); read it all before anything else:\n\n${note}\n\n` : "There's no handoff note; use world and search_history to catch up.\n\n") +
        "Then reply to Angus in two or three lines: you're back, refreshed, and what you're picking up (open jobs, things waiting on him). Don't start new work in this turn.");
      const nw = worlds.get(room); if (nw) nw.lastSpoke = Date.now();
      return { room, archived: arch, files: moved, handoff: handoff || "", carried: carried.filter((e) => e.role === "you").length };
    },
    codeOf: (room) => { const w = worlds.get(room); return w?.child && w.child.exitCode == null && !w.stopping ? w.code || "" : ""; }, // J135
    note: (room, text) => add(room, { role: "note", text: String(text) }),
    // J147: something that needs Angus (a refresh that failed or got stuck, …): a note his thread SHOWS
    // (lib/thoughts-lines.mjs keeps ⚠ notes), and the model gets it with his next message.
    alert: (room, text, ctx = "") => { const t = String(text); add(room, { role: "note", text: t }); const l = pendingCtx.get(room) || []; l.push(ctx ? String(ctx) : `[hyprpi alert, tell Angus if it matters] ${t}`); pendingCtx.set(room, l.slice(-20)); }, // ctx: how the model gets it (J284)
    running: (room) => { const w = worlds.get(room); return !!(w?.child && w.child.exitCode == null); },
    // J283 (Angus: "what happened, you went away"): after a daemon restart, a short visible "back" note in a
    // thread that was in use in the last hour (a restart that interrupted or followed a conversation).
    back(room, { at = Date.now(), recentMs = 3600 * 1000 } = {}) {
      if (sandboxed(room)) return false;
      // (review: a conversation means Angus's own turns, not automatic notes; once per conversation stretch)
      const list = thread(room);
      let lastYou = -1; for (let i = list.length - 1; i >= 0; i--) if (list[i].role === "you") { lastYou = i; break; }
      if (lastYou < 0 || at - (Number(list[lastYou].ts) || 0) > recentMs) return false;
      if (list.slice(lastYou + 1).some((e) => e.role === "note" && String(e.text || "").startsWith("🔌"))) return false;
      const hhmm = new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
      add(room, { role: "note", text: `🔌 hyprpi restarted at ${hhmm}: ${thoughtsName(room)} is back. The saved conversation is kept; if you were waiting on an answer, ask again.` });
      return true;
    },
    get(room, limit = 200) {
      const list = thread(room), sb = sandboxed(room);
      // J267: a sandboxed world's host thread ends with a pointer to its real Thoughts (⚠: drawn on desktop and phone).
      const tail = sb ? [{ role: "note", text: "⚠ " + sandboxedText(room, sb), ts: Date.now(), sandboxed: true }] : [];
      return { room, name: thoughtsName(room), entries: [...list.slice(-limit), ...tail], busy: !!worlds.get(room)?.busy, ...(sb ? { sandboxed: sb } : {}) };
    },
    busy: (room) => !!worlds.get(room)?.busy,
    // J267: its world became sandboxed while a host Thoughts ran: stop it (routed messages are handed back).
    stopIfSandboxed(room) { const w = worlds.get(room); if (!sandboxed(room) || !w?.child || w.child.exitCode != null) return false; log(`thoughts ${room}: world is sandboxed now; stopping the host Thoughts`); failRouted(w, `world ${room} is sandboxed`); try { w.child.stdin.end(); } catch { /* gone */ } return true; },
    stopAll() { for (const w of worlds.values()) { try { w.child.stdin.end(); } catch { /* gone */ } } },
  };
  function lastYou(room) { const l = thread(room); for (let i = l.length - 1; i >= 0; i--) if (l[i].role === "you" || l[i].session) return l[i].ts; return 0; } // J116: a fresh session's divider counts
}
