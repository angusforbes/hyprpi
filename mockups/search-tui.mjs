#!/usr/bin/env node
// The Thoughts window (panel 3, SUPER+ALT+/; Angus 2026-09-29 via Thoughts-C): ONE chat window
// with this world's Thoughts agent (lib/thoughts.mjs), like an agent window: the thread on top,
// newest at the bottom, the box at the bottom. No modes.
//   plain text            talk to Thoughts-<room> (it remembers; it can ask agents, hand off work)
//   /keyword WORDS        exact-word search over the world's history, instant, no model
//   /ask QUESTION         a small model answers from the history and cites the turns (lib/ask.mjs)
//   /more [N]             the last /keyword again with N (default +20) more of the older matches
// Evidence (from /keyword, /ask, or the Thoughts agent's own searches): at most the 10 newest
// matching turns, oldest first, numbered; "+N older" when more matched. Each line keeps a
// reference to its turn (agent, session, entry id) for a future jump. Results go to the Thoughts
// agent with your next message, so "tell me more about the second one" works.
// Whose history: @Names in the words ("/keyword @Sankey kafka"), else everyone's; the evidence
// header says so. (The ▸ marks are retired, Angus 2026-09-30.)
// Keys: ⏎ send · Tab completes @names and /commands · Ctrl+Tab world · Ctrl+↑↓ PgUp PgDn wheel
// scroll · Ctrl+V / SUPER+V paste text, or a screenshot's path at the cursor · Ctrl+click an agent's name (or an evidence line)
// jumps to its window · links and file paths open on click · Esc clears · Ctrl+Q quits.
// Select & copy as in the room panel (drag, Shift+click whole items, double / triple click).
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { connect } from "../lib/client.mjs";
import { createSearch } from "../lib/search-view.mjs";
import { parseAt, resolveAt, completeAt } from "../lib/at-names.mjs";
import { createInputBox, createHistory, atTint, boxHit } from "../lib/tui/input-box.mjs";
import { createCommands, parseCommand } from "../lib/tui/command-line.mjs";
import { jotKinds, jotWhat } from "../lib/jot-kinds.mjs";
import { wordAt, urlIn, agentIn, bareName } from "../lib/tui/agent-click.mjs";
import { worldTabAt, stepTo } from "../lib/tui/world-tabs.mjs";
import { withPill, pillHit } from "../lib/tui/new-pill.mjs"; // J247: "↓ N new" while scrolled up
import { mdRows, openTarget } from "../lib/tui/markdown.mjs";
import { userName } from "../lib/policy.mjs"; // J261
import { threadKind, answerLine, actionPrefix, splitLead } from "../lib/thoughts-lines.mjs"; // shared with the phone
import { claimReview, heldById, parseChoice, actOnHeld, reviewPrompt, requestTurn, logHeld, logTurn, heldTurns, relayOutcome } from "../lib/held.mjs"; // J274: held-message review app (J38)
let worldBar = null;

const ESC = "\x1b[";
const out = (s) => process.stdout.write(s);

// ---- theme: world colours exactly like the bar / room TUI -------------------
const COLORS = `${process.env.HOME}/.local/state/omarchy/current/theme/colors.toml`;
const PALETTE = [["blue", "color4"], ["red", "color1"], ["cyan", "color6"], ["yellow", "color3"], ["magenta", "color5"], ["green", "color2"], ["orange", "color11"], ["brown", "color9"], ["foreground", "color7"]];
let theme = {};
function loadTheme() {
  theme = {};
  try { for (const l of fs.readFileSync(COLORS, "utf8").split("\n")) { const m = l.match(/^\s*([A-Za-z0-9_-]+)\s*=\s*["']?#([0-9A-Fa-f]{6})/); if (m) theme[m[1]] = m[2]; } } catch { /* ANSI fallback */ }
}
loadTheme();
try { fs.watchFile(COLORS, { interval: 2000 }, () => { loadTheme(); render(); }); } catch { /* fine */ }
const rgb = (hex) => { const n = parseInt(hex, 16); return `${n >> 16};${(n >> 8) & 255};${n & 255}`; };
const worldHex = (room) => { const i = "ABCDEFGHI".indexOf(String(room)[0]); for (const k of PALETTE[Math.max(0, i) % PALETTE.length]) if (theme[k]) return theme[k]; return null; };
const worldFg = (room) => { const h = worldHex(room); return h ? `38;2;${rgb(h)}` : "34"; };
const worldBg = (room) => { const h = worldHex(room); return h ? `48;2;${rgb(h)}` : "44"; };
const fg = (c, s) => `${ESC}${c}m${s}${ESC}39m`;
const hexFg = (hex, s) => { const m = /^#?([0-9a-f]{6})$/i.exec(hex || ""); return m ? `${ESC}38;2;${rgb(m[1])}m${s}${ESC}39m` : s; };
const dim = (s) => `${ESC}2m${s}${ESC}22m`;
const bold = (s) => `${ESC}1m${s}${ESC}22m`;
const italic = (s) => `${ESC}3m${s}${ESC}23m`;

// ---- widths (grapheme clusters, emoji presentation = 2) ---------------------
const seg = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const graphemes = (s) => Array.from(seg.segment(String(s)), (x) => x.segment);
function gw(g) {
  const cps = [...g].map((c) => c.codePointAt(0));
  if (cps.some((cp) => cp === 0xfe0f || cp === 0x200d) || /\p{Emoji_Presentation}/u.test(g) || (cps[0] >= 0x1f1e6 && cps[0] <= 0x1f1ff)) return 2;
  const cp = cps[0];
  if ((cp >= 0x1100 && cp <= 0x115f) || (cp >= 0x2e80 && cp <= 0xa4cf) || (cp >= 0xac00 && cp <= 0xd7a3) || (cp >= 0xf900 && cp <= 0xfaff) || (cp >= 0xff00 && cp <= 0xff60)) return 2;
  return cp < 32 ? 0 : 1;
}
const strip = (s) => String(s).replace(/\x1b\[[0-9;]*m/g, "");
const width = (s) => { let w = 0; for (const g of graphemes(strip(s))) w += gw(g); return w; };
function clip(s, n) { // cut a styled line to n columns, keeping escapes
  let w = 0, r = "";
  for (const part of String(s).split(/(\x1b\[[0-9;?]*[A-Za-z])/)) {
    if (part.startsWith("\x1b")) { r += part; continue; }
    for (const g of graphemes(part)) { const c = gw(g); if (w + c > n) return r + `${ESC}0m`; w += c; r += g; }
  }
  return r;
}
// Word-wrap plain text to n columns; returns [{ text, from }] with character offsets.
function wrap(text, n) {
  const lines = [];
  let line = "", lw = 0;
  for (const word of String(text).split(/(\s+)/)) {
    if (!word) continue;
    const ww = width(word);
    if (lw + ww > n && line.trim()) { lines.push(line.trimEnd()); line = ""; lw = 0; if (/^\s+$/.test(word)) continue; }
    if (ww > n) { for (const g of graphemes(word)) { const c = gw(g); if (lw + c > n) { lines.push(line); line = ""; lw = 0; } line += g; lw += c; } continue; }
    line += word; lw += ww;
  }
  if (line.trim()) lines.push(line.trimEnd());
  return lines;
}
function when(ts) {
  const d = new Date(ts), now = new Date(), p = (x) => String(x).padStart(2, "0");
  const hm = `${p(d.getHours())}:${p(d.getMinutes())}`;
  return d.toDateString() === now.toDateString() ? hm : `${d.toLocaleString("en", { month: "short" })} ${d.getDate()} ${hm}`;
}
const ROLE = { get angus() { return userName(); }, agent: "agent", room: "room", talk: "talk", activity: "did" };

const t = { dim, bold, italic, clip, width, hexFg, rgb, get theme() { return theme; } };

// ---- state ------------------------------------------------------------------
let api = null, online = false, rooms = [], room = (process.argv[2] || "").toUpperCase();
let showHelp = false, note = "";
let query = "", qc = 0; // the search box and its cursor (in graphemes)
let top = 0, resultRows = {}; // resultRows: screen row -> result index
let known = []; // agents of every room, live and closed: [{ id, name, display, icon, color, room, live }]
const hereKnown = () => known.filter((a) => a.room === room);
// The box's @names -> agent ids (this room). Unknown names are reported, not ignored.
function scopeOf(text = query) {
  const { names, rest } = parseAt(text);
  const r = resolveAt(names, hereKnown());
  return { ...r, names, rest };
}
const onlyIds = () => scopeOf().ids;
const S = createSearch({ api: () => api, room: () => room, onChange: () => render(), only: onlyIds, closed: true, roomLog: true, order: "auto" }); // (unused since the Thoughts window; kept for S.startedAt)
// /keyword and /ask: whose history (the words' @names, else everyone's) and the one running.
const EV = { busy: "", last: null, startedAt: 0, gen: 0 };
// Esc (Angus): interrupt what's running (a /keyword /ask /more, or a Thoughts turn), never the box.
function interrupt() {
  if (!EV.busy && !TH.busy) return false;
  EV.gen++; EV.busy = ""; TH.busy = false;
  if (api) api.call("thoughts.interrupt", { room }).catch((e) => { note = "✗ " + e.message; render(); });
  render(); return true;
}
function evFilter(text) {
  const sc = scopeOf(text);
  if (sc.unknown.length) throw new Error(`no agent ${sc.unknown.map((n) => "@" + n).join(" ")} in room ${room} (Tab completes names)`);
  return { words: sc.rest, ids: sc.ids, how: sc.ids.length ? "@names" : "" };
}
// /digest [@names…] [time] [words]: the matching Stream lines go to Thoughts, which writes a summary
// by project (the daemon's thoughts.digest; the Stream panel's filter syntax, lib/stream.mjs).
function digest(text) {
  if (!api) { note = "✗ daemon offline"; return render(); }
  note = ""; follow(); render();
  api.call("thoughts.digest", { room, filter: String(text || "").trim() }, { timeoutMs: 60000 })
    .then((r) => { note = r.total ? "" : `no Stream lines for "${r.label}"`; render(); })
    .catch((e) => { note = "✗ " + e.message; render(); });
}
function evidence(kind, text, n = 10) {
  let f; try { f = evFilter(text); } catch (e) { note = "✗ " + e.message; return render(); }
  if (!f.words) { note = kind === "ask" ? "/ask QUESTION" : "/keyword WORDS"; return render(); }
  if (!api) { note = "✗ daemon offline"; return render(); }
  const gen = ++EV.gen; // Esc bumps it: a cancelled request's late reply is ignored here too
  EV.busy = kind; EV.startedAt = Date.now(); EV.last = { kind, text, n }; note = ""; follow(); render();
  api.call("thoughts.evidence", { room, kind, query: f.words, n, agents: f.ids }, { timeoutMs: 180000 })
    .then(() => { if (gen === EV.gen) { EV.busy = ""; render(); } })
    .catch((e) => { if (gen === EV.gen) { EV.busy = ""; note = "✗ " + e.message; render(); } });
}

// Thoughts mode (Angus, 2026-09-29; lib/thoughts.mjs): the third mode after keyword and AI. You
// talk to the world's own agent, Thoughts-<room> (Opus 5.5, remembers the conversation, can ask
// agents and hand them work). The pane is a clean chat thread from the daemon: your messages, its
// replies, one dim line per thing it did for you, agents' replies. Ctrl+/ cycles the three modes.
let thoughtsOn = true; // always (no modes any more)
let linkRows = {}; // screen row -> [{ x0, x1, target }] (1-based rows, 0-based columns): clickable links in the thread
const linkAt = (x, y) => (linkRows[y] || []).find((q) => x - 1 >= q.x0 && x - 1 < q.x1)?.target || null;
const TH = { room: "", entries: [], busy: false, scroll: 0, pinned: false, unseen: 0, rows: null, key: "", max: 0, anchor: null, restore: null, pill: null }; // scroll: rows up from the bottom
// J121 (Angus: "i want to be able to 'pin' your stream so you don't auto-move on update until i scroll back
// down again"): scrolling up PINS the view: new entries, the thinking… lines and re-renders keep the same
// lines on screen (since J247: the first line on screen is anchored) and a "↓ N new" pill shows.
// Back at the bottom (End / ^End, PgDn, ^↓, the wheel) or sending/searching yourself follows again.
// J247 (Angus: "just like in the phone app … leave me where i am but provide an indicator that there's new
// messages/info below"): pinned, the FIRST line on screen stays the first line (TH.anchor: its entry and
// the row within it), whatever is added below or re-drawn; new entries that show (not hidden / quiet
// ones) count on the "↓ N new" pill at the bottom right of the thread (lib/tui/new-pill.mjs; a click on
// it, End or ^End follows again; so does sending). A restart onto new code comes back to the same place.
function follow() { TH.scroll = 0; TH.pinned = false; TH.unseen = 0; TH.anchor = null; if (!note.startsWith("✗")) note = ""; }
const shows = (e) => { const k = threadKind(e); return k !== "hidden" && k !== "quiet"; };
const entryKey = (e) => `${e?.ts || 0}|${e?.role || ""}|${String(e?.text || "").length}`;
// Thread build cache (Angus via Thoughts-C 2026-09-30: typing re-wrapped the whole thread on
// every keystroke, ~170 ms on the long world-C thread). The per-entry wrapped lines and their
// items are rebuilt only on a width change, new/changed entries (bumpThread), a world switch,
// a theme change or a date change; every other render just re-slices the visible window.
let threadCache = { key: "", flat: null, items: null };
const bumpThread = () => { threadCache.flat = null; };
const modeName = () => thoughtsOn ? "thoughts" : S.mode;
const wrapP = (t, n) => String(t || "").split(/\r?\n/).flatMap((q) => q.trim() ? wrap(q, n) : [""]); // paragraphs kept
function loadThoughts() {
  if (!api) return;
  const r = room;
  api.call("thoughts.get", { room: r }).then((t) => { if (r !== room) return; TH.room = r; TH.entries = t.entries || []; turns = heldTurns(r); TH.busy = !!t.busy; seedThoughtsHistory(r); bumpThread(); render(); }).catch((e) => { note = "✗ " + e.message; render(); });
}
function setThoughts(on) { thoughtsOn = on; follow(); note = ""; if (on) loadThoughts(); render(); }
// Pasted screenshots (Angus, N54: like pi's own windows): Ctrl+V / SUPER+V with an image on the
// clipboard saves it as ~/Screenshots/pi-clipboard-<id>.png (/tmp if that folder is missing; J71) and puts its PATH in the box at the cursor, next
// to what it's about. On ⏎ every image path in the text that exists goes to Thoughts as an image,
// in order (it sees them and can pass the paths on); the path stays in the message, clickable.
function imagePaths(text) {
  const out = [];
  for (const m of String(text).matchAll(/(?:^|[\s("'`<\[])((?:~|\/)[^\s"'`<>()\[\]]*\.(?:png|jpe?g|webp|gif))(?=$|[\s)"'`>\].,;:!?])/gi)) {
    const f = m[1].replace(/^~(?=\/)/, process.env.HOME || "~");
    if (!out.includes(f) && fs.existsSync(f)) out.push(f);
  }
  return out;
}
// Input history (↑↓): the shared box's (lib/tui/input-box.mjs, N51), fed by your earlier messages
// in this thread ("you" entries); sending stops browsing.
function sendThought(text, images = []) {
  box.remember(""); // the thread keeps the message itself
  const t = String(text || "").trim();
  if ((!t && !images.length) || !api) return;
  api.call("thoughts.send", { room, text: t, images }).then(() => { TH.busy = true; render(); }).catch((e) => { note = "✗ " + e.message; render(); });
  follow(); TH.busy = true; render();
}

// Commands: the search panel's own (/search, /ai, /ask) plus the ones every panel has (/help,
// /tinker, /quit), all through lib/tui/command-line.mjs.
// J229 + J233 (Angus: "we're going to use /jot-idea, i want appropriate actual hyprpi and pi commands to be
// available here"): commands for this world's Thoughts, not the panel. Each says at once what it does.
//  · pi-jot's /jot-<kind> (from ~/.pi/agent/jot.json): pi-jot itself runs it in Thoughts, as in an agent
//    window, and the panel says what that kind does (kept exactly as typed, or a title picked, a poem written,
//    the list updated…; Angus: "Not all the jots are only what's typed, some ask you to interpret it").
//  · /compact /model /thinking: pi's own controls of the Thoughts process (thoughts.control).
//  · /restart (= /reload-runtime) and /handoff (= /fresh): hyprpi's restart / fresh session for Thoughts.
//  · /step: "A /step B" sends A, then B when Thoughts has answered (the panel queues it).
//  · pi commands that need an agent window (/name, /messageboard, /skill:…, /settings …) say so.
const T = () => `Thoughts-${room}`;
function jotCommands() {
  return jotKinds().map((k) => ({
    name: "/" + k.command, usage: `/${k.command} ${k.mode === "list" ? "[add ITEM | done ITEM | FOCUS]" : k.compose ? "[DIRECTION]" : "[@Title] TEXT"}`,
    help: k.mode === "list" ? `${k.description} (agent windows only: it edits files)` : `${k.description} (pi-jot, in ${T()})`,
    run: (arg, text) => {
      // A list kind (/jot-todo) has the agent read and edit the todo notes: Thoughts has no file tools.
      if (k.mode === "list") { setBox(text); note = `✗ /${k.command}: needs file tools, so it works in an agent window, not ${T()}`; return render(); }
      if (!api) { setBox(text); note = "✗ daemon offline: not kept"; return render(); }
      const what = jotWhat(k, arg, T());
      note = `📝 /${k.command}: ${what}…`; render();
      api.call("thoughts.jot", { room, text: `/${k.command}${arg ? " " + arg : ""}` })
        .then(() => { note = `📝 /${k.command}: ${what} · the thread shows the file when it's saved`; render(); })
        .catch((e) => { setBox(text); note = `✗ /${k.command} not kept: ${/unknown method/.test(e.message) ? "the daemon hasn't picked this up yet (restart pending); your text is kept" : e.message}`; render(); });
    },
  }));
}
const ctl = (label, cmd, done, { text } = {}) => {
  if (!api) { if (text) setBox(text); note = "✗ daemon offline"; return render(); }
  note = `${label}…`; render();
  api.call("thoughts.control", { room, cmd })
    .then((d) => { note = done(d || {}); render(); })
    .catch((e) => { if (text) setBox(text); note = `✗ ${label}: ${/unknown method/.test(e.message) ? "the daemon hasn't picked this up yet (restart pending)" : e.message}`; render(); });
};
const kTok = (n) => n >= 1000 ? Math.round(n / 1000) + "k" : String(n);
function thoughtsCommands() {
  const AGENT_ONLY = {
    "/name": `${T()}'s name is fixed (it's this world's Thoughts)`,
    "/messageboard": "Thoughts has no file tools: use an agent window", "/messageboard-poem": "Thoughts has no file tools: use an agent window",
    "/settings": "only in an agent window", "/tree": "only in an agent window", "/login": "only in an agent window (/login there; the bar shows a lapsed login)",
    "/resume": "only in an agent window", "/fork": "only in an agent window", "/clone": "only in an agent window", "/export": "only in an agent window",
    "/copy": "only in an agent window", "/session": "only in an agent window", "/hotkeys": "only in an agent window", "/changelog": "only in an agent window",
    "/scoped-models": "only in an agent window", "/share": "only in an agent window",
    "/twin-split": "only in an agent window", "/twin-fork": "only in an agent window", "/twin-tree": "only in an agent window", "/twin-merge": "only in an agent window",
    "/whatsapp": "only in an agent window", "/mail": "only in an agent window", "/voice-switch": "only in an agent window", "/sched": "only in an agent window",
    "/nim-limit": "only in an agent window", "/hp-pin": "only in an agent window", "/hp-summon": "only in an agent window", "/hp-dismiss": "only in an agent window", "/hp-focus": "only in an agent window",
  };
  return [
    ...jotCommands(),
    { name: "/compact", usage: "/compact [FOCUS]", help: `compact ${T()}'s conversation now (FOCUS: what the summary should keep)`,
      run: (a, text) => ctl(`compacting ${T()}`, { type: "compact", ...(a ? { customInstructions: a } : {}) }, (d) => `✓ ${T()} compacted${d.tokensBefore ? ` (${kTok(d.tokensBefore)} → ~${kTok(d.estimatedTokensAfter || 0)} tokens)` : ""}`, { text }) },
    { name: "/model", usage: "/model [provider/id]", help: `${T()}'s model until it restarts (config.json thoughtsModel is the lasting one); alone: the models`,
      run: (a, text) => {
        if (!a) return ctl("models", { type: "get_available_models" }, (d) => { const ms = (d.models || []).map((m) => `${m.provider}/${m.id}`); return ms.length ? `${ms.length} models: ${ms.slice(0, 12).join(" · ")}${ms.length > 12 ? " …" : ""} · /model provider/id` : "no models listed"; });
        const m = /^([^/\s]+)\/(\S+)$/.exec(a); if (!m) { setBox(text); note = "/model provider/id (e.g. anthropic/claude-opus-5-5)"; return render(); }
        ctl(`model ${a}`, { type: "set_model", provider: m[1], modelId: m[2] }, () => `✓ ${T()} now on ${a} (until it restarts; config.json thoughtsModel is the lasting one)`, { text });
      } },
    { name: "/thinking", usage: "/thinking off|minimal|low|medium|high|xhigh|max", help: `${T()}'s thinking level until it restarts`,
      run: (a, text) => { if (!/^(off|minimal|low|medium|high|xhigh|max)$/.test(a)) { setBox(text || "/thinking "); note = "/thinking off|minimal|low|medium|high|xhigh|max"; return render(); }
        ctl(`thinking ${a}`, { type: "set_thinking_level", level: a }, () => `✓ ${T()} thinking: ${a} (until it restarts)`, { text }); } },
    ...["/restart", "/reload-runtime"].map((name) => ({ name, usage: name, help: name === "/restart" ? `restart ${T()} on the current code (same session); not while it's replying` : "the same as /restart", hidden: name !== "/restart",
      run: () => { if (!api) { note = "✗ daemon offline"; return render(); } note = `restarting ${T()}…`; render();
        api.call("thoughts.restart", { room }).then((r) => { note = r.restarted ? `✓ ${T()} restarted: it starts on the new code with your next message` : `${T()} isn't running: it starts on the current code with your next message`; render(); })
          .catch((e) => { note = "✗ " + e.message; render(); }); } })),
    ...["/handoff", "/fresh"].map((name) => ({ name, usage: `${name} [NOTE]`, help: name === "/handoff" ? `${T()} writes a handoff, then starts a fresh session from it (the old one is archived; the last turns stay visible); NOTE goes into the handoff` : "the same as /handoff", hidden: name !== "/handoff",
      run: (a) => { if (!api) { note = "✗ daemon offline"; return render(); } note = `${T()}: asking for its handoff…`; render();
        api.call("thoughts.askHandoff", { room, note: a }).then(() => { note = `🔄 ${T()} writes its handoff, then starts fresh (a line in the thread says when)`; render(); })
          .catch((e) => { note = `✗ /handoff: ${/unknown method/.test(e.message) ? "the daemon hasn't picked this up yet (restart pending)" : e.message}`; render(); }); } })),
    { name: "/step", usage: "A /step B /step C", help: `send A; then B once ${T()} has answered, and so on`, run: (a) => steps(a) },
    { name: "/steps", usage: "/steps [cancel]", help: "what /step still has queued; cancel drops it", run: (a) => { if (/^cancel$/i.test(a)) { const n = STEP.length; STEP.length = 0; note = n ? `/step: dropped ${n}` : "/step: nothing queued"; } else note = STEP.length ? `/step: ${STEP.length} waiting: ${STEP.map((x) => x.slice(0, 30)).join(" · ")}` : "/step: nothing queued"; render(); } },
    ...Object.entries(AGENT_ONLY).map(([name, why]) => ({ name, hidden: true, run: (a, text) => { setBox(text); note = `✗ ${name}: ${why}`; render(); } })),
  ];
}
// /step (J233): pieces go one at a time; the next when Thoughts settles (the thoughts event, below).
const STEP = [];
const STEP_RE = /(?:^|\s)\/step(?=\s|$)/i;
function steps(text) {
  const parts = String(text || "").split(/(?:^|\s)\/step(?=\s|$)/i).map((x) => x.trim()).filter(Boolean);
  if (!parts.length) { note = "/step: A /step B /step C"; return render(); }
  STEP.push(...parts.slice(1));
  runStep(parts[0]);
  if (STEP.length) { note = `/step: ${STEP.length} more after this one`; render(); }
}
function runStep(piece) {
  if (piece.startsWith("/") && !piece.startsWith("//")) { command(piece); setTimeout(nextStep, 1500); return; } // a command may not start a turn
  sendThought(piece.startsWith("//") ? piece.slice(1) : piece, imagePaths(piece));
}
function nextStep() { if (STEP.length && !TH.busy) { const n = STEP.shift(); runStep(n); if (STEP.length) { note = `/step: ${STEP.length} more`; render(); } } }
const cmds = createCommands({
  commands: [
    { name: "/keyword", usage: "/keyword WORDS", help: "exact-word search of this world's history (instant, no model): the 10 newest matching turns", run: (a) => evidence("keyword", a) },
    { name: "/search", usage: "/search WORDS", help: "the same as /keyword", run: (a) => evidence("keyword", a) },
    { name: "/ask", usage: "/ask QUESTION", help: "a small model answers from the history and cites the turns (answer last)", run: (a) => evidence("ask", a) },
    { name: "/ai", usage: "/ai QUESTION", help: "the same as /ask", run: (a) => evidence("ask", a) },
    { name: "/digest", usage: "/digest [@names…] [3h|today|since 9am] [words]", help: "a summary by project (done · decided · waiting on you) of the Stream lines; alone: since you last looked here", run: (a) => digest(a) },
    { name: "/more", usage: "/more [N]", help: "the last /keyword again with N (default 20) more of the older matches", run: (a) => {
      if (!EV.last) { note = "nothing to show more of yet (/keyword WORDS first)"; return render(); }
      const add = Math.max(1, Number(a) || 20); evidence(EV.last.kind, EV.last.text, EV.last.n + add);
    } },
    { name: "/thought", usage: "/thought TEXT", help: "the same as typing TEXT: tell Thoughts", run: (a) => sendThought(a) },
    ...thoughtsCommands(),
  ],
  ctx: {
    panel: "search", world: () => room, worlds: () => rooms, cycle: (d) => cycle(d), agents: () => known.filter((a) => a.live),
    api: () => api, via: "search-tui", render: () => render(),
    note: (t) => { note = t; render(); },
    showHelp: () => { setBox(""); showHelp = true; render(); },
    quit: () => quit(),
    setBox: (t) => setBox(t),
  },
});

function scopeLabel() {
  const sc = scopeOf(S.busy || !S.ranFor ? query : S.ranFor.box ?? query);
  if (sc.found.length) return "only " + sc.found.map((a) => "@" + a.display).join(" ");
  return S.mode === "ai" ? "everyone · conversations + room log + activity" : "everyone · every agent's conversation + the room log";
}

function cycle(d) {
  if (!rooms.length) return;
  const i = Math.max(0, rooms.indexOf(room));
  room = rooms[(i + d + rooms.length) % rooms.length];
  top = 0; note = "";
  S.reset(); turns = heldTurns(room); if (thoughtsOn) { TH.entries = []; follow(); bumpThread(); loadThoughts(); } render();
}
// Tab on an @word: complete it from this room's agents (again: the next match).
let atCycle = null; // completeAt's state: Tab again steps through the same matches
const CTRL_TAB = new Set(["\x1b[9;5u", "\x1b[27;5;9~"]), CTRL_SHIFT_TAB = new Set(["\x1b[9;6u", "\x1b[27;6;9~", "\x1b[1;5Z"]); // Ctrl(+Shift)+Tab: world (the launcher maps them; kitty would switch its own tabs)
function completeName(dir = 1) {
  const gs = graphemes(query), before = gs.slice(0, qc).join(""), after = gs.slice(qc).join("");
  const r = completeAt(before + after, before.length, hereKnown(), atCycle, dir);
  if (!r) return false;
  if (!r.options.length) { note = "no agent here by that name"; render(); return true; }
  query = r.text; qc = graphemes(r.text.slice(0, r.cursor)).length;
  atCycle = r.state;
  note = r.options.length > 1 ? r.options.map((o) => (o === r.pick ? "▸@" + o : "@" + o)).join("  ") : "";
  render(); return true;
}

// J274 (Angus: Review "go to the appropriate Thoughts where we can interact and get context"): a held sandbox
// message the relay handed to this world's panel. Thoughts writes the context; ONLY what Angus types here
// decides it: a bare 1 / 2 / 3 at once, free-form wording ("3, but for 2 hours") after one confirming y.
// The panel parses his words itself (lib/held.mjs parseChoice) and runs the relay's guarded CLI; nothing
// Thoughts writes, and nothing from the sandbox, is ever taken as an answer.
// One review per world (review J274 #2): switching worlds keeps each, but drops any half-confirmed choice.
const reviews = {}; // room -> { id, room, h, confirm, shownAt, draft }
let review = null;  // the current world's (kept in step by pollReview / render)
function pollReview() {
  if (restarting) return;
  const before = Object.keys(reviews).join(",") + "|" + note;
  for (const [r, rv] of Object.entries(reviews)) if (!heldById(rv.id)) { delete reviews[r]; if (r === room) { note = `held message ${rv.id} was decided (or expired)`; if (rv.draft && !query) setBox(rv.draft); } }
  review = reviews[room] || null;
  if (!review && room) {
    const id = claimReview(room), h = id && heldById(id);
    if (h) {
      // Whatever was already in the box can't answer it (review #1): it is set aside and comes back afterwards.
      review = reviews[room] = { id, room, h, confirm: null, shownAt: Date.now(), draft: query };
      setBox("");
      // J285 v2 (Angus: "the 'Request from Alpha (G1)' part should be highlighted … like your Approved"): the request
      // as its own highlighted turn, from the relay's data; Thoughts only adds a one-line flag.
      const rq = requestTurn(h);
      logTurn({ room, id, ok: true, kind: "request", turn: `${rq.head}\n${rq.body}\n(1) Approve (2) Deny (3) Allow similar for 1 hour` });
      turns = heldTurns(room); bumpThread(); follow();
      sendThought(reviewPrompt(h));
    }
  }
  if (Object.keys(reviews).join(",") + "|" + note !== before) { bumpThread(); render(); } // (numbered lists are drawn differently while a review is open)
}
setInterval(pollReview, 2000);
// Other panels of this world learn of a decision turn within 5 s even without a Thoughts event (recheck #3)
setInterval(() => { if (restarting) return; const nt = heldTurns(room); if (nt.map((x) => x.ts).join() !== turns.map((x) => x.ts).join()) { turns = nt; bumpThread(); render(); } }, 5000);
let reviewRoom = room;
let lastRaw = "", turns = [];
function reviewKey(raw) {
  lastRaw = raw;
  if (reviewRoom !== room) { for (const rv of Object.values(reviews)) rv.confirm = null; reviewRoom = room; } // world switched: no half-confirmed choice survives
  review = reviews[room] || null;
  if (!review) return false;
  if (!heldById(review.id)) { delete reviews[room]; review = null; return false; }
  if (Date.now() - review.shownAt < 1500) return false; // typed before the review appeared: not an answer
  const decide = (ch) => {
    const r = actOnHeld(review.id, ch), h = review.h, id = review.id, at = room;
    logHeld({ room, id, raw: lastRaw, choice: ch, ok: r.ok, cli: r.text, stage: "cli" });
    // J280 (Angus: "it should be a real turn that i can read … maybe even highlighted"): the decision as its own
    // highlighted turn in the thread, kept in panel-turns.jsonl (survives a reload). Review #1: the CLI only queues
    // it, so the turn waits for the relay's own result (its log) before saying ✓.
    const what = ch.verdict === "deny" ? "Denied" : ch.verdict === "approve" ? "Approved" : ch.dur === "once" ? "Approved (just this one, no rule)" : `Approved, and similar messages allowed for ${ch.dur === "1h" ? "1 hour" : ch.dur}${/capped/.test(ch.label) ? " (capped at 24 hours)" : ""}`;
    const msg = `${h.sandbox} → ${h.to.join(", ")}: "${h.text.replace(/\s+/g, " ").trim()}"`; // J285 (Angus: "don't cut anything out. show the full message!")
    const finish = (ok, head, body) => {
      logTurn({ room: at, id, ok, turn: `${head}\n${msg}\n${body}` });
      logHeld({ room: at, id, stage: "result", ok, result: body });
      if (room !== at) return; // switched worlds meanwhile: it shows when he comes back (recheck #3)
      turns = heldTurns(room); bumpThread(); follow();
      note = ok ? `✓ ${head}` : `✗ ${head}`; render();
    };
    setBox("");
    if (!r.ok) { finish(false, `Not decided: ${r.text || "the relay refused"}`, "The message is still waiting: try again, or use the toast."); return true; }
    const { draft } = review; delete reviews[room]; review = null; if (draft) setBox(draft); bumpThread();
    note = `🐳 ${ch.label}: waiting for the relay…`; render();
    let tries = 0;
    const poll = setInterval(() => {
      const o = relayOutcome(id);
      if (o || ++tries > 25) {
        clearInterval(poll);
        if (!o) finish(false, `${what}: no answer from the relay yet`, "It may still be waiting: check docker/sbx-relay.mjs status and pending.");
        else {
          const head = !o.ok ? `${what}, but it failed` : ch.verdict === "deny" ? "Denied" : o.ruled ? what : ch.verdict === "allow" && ch.dur !== "once" ? "Approved (no rule: rules cover plain talks only)" : "Approved";
          finish(o.ok, head, `Relay: ${o.text}${o.ok && o.ruled ? "\nSame sandbox → same recipient, talk only, up to 30 an hour. See or end it: /rules in the room panel." : ""}`);
          // Thoughts of the world it was decided in (recheck #3), and only while connected
          if (o.ok && api) api.call("thoughts.send", { room: at, text: `[Angus decided held ${id}: ${head}. Relay: ${o.text}]` }).catch(() => {});
        }
      }
    }, 400);
    return true;
  };
  if (review.confirm) {
    const ch = review.confirm; review.confirm = null;
    if (/^y(es)?$/i.test(raw)) return decide(ch);
    note = "cancelled"; logHeld({ room, id: review.id, raw, stage: "confirm-cancelled" });
    if (!raw || /^n(o)?$/i.test(raw)) { setBox(""); render(); return true; }
  }
  if (!raw) return false;
  const ch = parseChoice(raw);
  logHeld({ room, id: review.id, raw, choice: ch || null, stage: "typed" });
  // J280: a line that isn't a choice goes to Thoughts as a question; say so where he is looking.
  // (review #2: sending clears the status line, so send first, then say so)
  const asQuestion = (hint) => {
    if (!api) { note = "✗ daemon offline: not sent to Thoughts · to decide, type just 1, 2 or 3"; render(); return true; } // (recheck #2)
    setBox(""); sendThought(raw, imagePaths(raw)); if (!note.startsWith("✗")) { note = hint; render(); } return true;
  };
  if (!ch) return asQuestion("🐳 that went to Thoughts as a question · to decide, type just 1, 2 or 3 (or \"3, but for 2 hours\")");
  if (ch.verdict === "unclear") return asQuestion("🐳 no usable duration (e.g. \"3 for 2 hours\", \"3 today\"): that went to Thoughts as a question");
  if (ch.confirm) { review.confirm = ch; setBox(""); note = `🐳 ${ch.label}: ${review.h.sandbox} → ${review.h.to.join(", ")}, talk. Type y + ⏎ to confirm, anything else cancels`; render(); return true; }
  return decide(ch);
}

function enter() {
  const raw = query.trim();
  if (reviewKey(raw)) return; // (an empty ⏎ cancels a half-confirmed choice)
  if (raw) box.remember(raw); // ↑ brings it back, /commands included (N51)
  // "/ignore TEXT" (Angus, N52): a secret signpost. A normal line from Angus in the thread, given to
  // Thoughts with his next message, no reply. Not in /help or Tab.
  if (/^\/ignore(?:\s|$)/.test(raw)) {
    setBox(""); note = "";
    if (!api) { note = "✗ daemon offline"; return render(); }
    api.call("thoughts.ignore", { room, text: raw }).catch((e) => { note = "✗ " + e.message; render(); });
    follow(); return render(); // J247: sending takes you to the bottom
  }
  if (!raw.startsWith("//") && STEP_RE.test(raw)) { setBox(""); return steps(raw); } // J233: "A /step B" (also "/jot-note x /step y")
  if (raw.startsWith("/") && !raw.startsWith("//")) {
    // Not a /command at all (a first word with another "/" in it, e.g. a /home/… path, J108): say so and
    // keep the text in the box, instead of clearing it and sending nothing.
    if (!parseCommand(raw)) { note = "✗ not a /command (a path?) · to send it as it is, start with //"; return render(); }
    return command(raw);
  }
  const text = raw.startsWith("//") ? raw.slice(1) : raw;
  if (!text) { note = "type to Thoughts (or /keyword WORDS, /ask QUESTION), then ⏎"; return render(); }
  setBox(""); return sendThought(text, imagePaths(text));
}
function setBox(text) { query = text; qc = graphemes(text).length; }
// A search sent from another panel (/search WORDS, /ai Q: mockups/panel-here → the daemon's
// ui.searchRun, or --mode / --query when that opened this panel): switch mode and run it.
function runFrom(mode, query) {
  showHelp = false; note = "";
  if (mode === "digest") return digest(query); // (alone: since you last looked)
  if (!query) return render();
  if (mode === "ai" || mode === "ask") return evidence("ask", query);
  if (mode === "keyword") return evidence("keyword", query);
  sendThought(query); // mode thoughts (/thought)
}
const startArgs = (() => { const a = process.argv.slice(3), o = {}; for (let i = 0; i < a.length; i += 2) if (a[i] === "--mode" || a[i] === "--query") o[a[i].slice(2)] = a[i + 1] ?? ""; return o; })();
let startRan = !(startArgs.mode || startArgs.query);
function command(raw) {
  if (/^\/\s*skill:/i.test(raw)) { note = "✗ /skill:…: skills load only in an agent window (Thoughts runs without them)"; return render(); } // J233
  note = ""; showHelp = false; setBox(""); cmds.run(raw); render();
}
function complete() { // Tab on "/partial": the shared completion (lib/tui/command-line.mjs)
  cmds.tab({ get text() { return query; }, set: (t) => setBox(t) });
  render();
}

// One result as screen lines.
function resultLines(r, i, W) {
  const c = worldFg(room), sel = i === S.selected;
  // Selected result: its name on light grey (like the room TUI's agent cursor), no side bar.
  const nameBg = theme.muted || theme.selection;
  const nm = hexFg(r.color, bold(r.name));
  const head = `${r.icon ? r.icon + " " : ""}${sel ? (nameBg ? `${ESC}48;2;${rgb(nameBg)}m${nm}${ESC}49m` : `${ESC}4m${nm}${ESC}24m`) : nm}${r.live ? "" : dim(" (closed)")}` +
    dim(` · ${ROLE[r.role] || r.role} · ${when(r.ts)}${r.count > 1 ? " · ×" + r.count : ""}`);
  const bar = " ";
  const textW = Math.max(10, W - 4);
  // Snippet: pre + MATCH + post, wrapped, the match in the world colour, max 4 lines.
  const pre = String(r.pre || ""), match = String(r.match || ""), post = String(r.post || "");
  const full = (pre + match + post).replace(/\s+/g, " ");
  const a = pre.replace(/\s+/g, " ").length, b = a + match.replace(/\s+/g, " ").length;
  let pos = 0;
  const body = wrap(full, textW).slice(0, 4).map((l) => {
    const at = full.indexOf(l, pos); const s = at < 0 ? pos : at; pos = s + l.length;
    let styled = "";
    [...l].forEach((ch, k) => {
      const off = s + k, inM = off >= a && off < b, prevIn = off - 1 >= a && off - 1 < b && k > 0;
      if (inM && !prevIn) styled += `${ESC}1;${c}m`;
      if (!inM && prevIn) styled += `${ESC}22;39m`;
      styled += ch;
    });
    return styled + `${ESC}22;39m`;
  });
  const lines = [`${bar} ${head}`, ...body.map((l) => `${bar}   ${l}`)];
  if (r.why) for (const w of wrap("↳ " + r.why, textW).slice(0, 2)) lines.push(`${bar}   ${dim(italic(w))}`);
  lines.push("");
  return lines;
}

function helpLines() {
  const k = (keys, what) => `   ${bold(keys.padEnd(22))} ${what}`;
  return [
    k("text + ⏎", `talk to Thoughts-${room} (it remembers; it can ask agents and hand them work)`),
    k("/keyword WORDS", "exact-word search of the history: the 10 newest matching turns, oldest first (+N older · /more)"),
    k("/ask QUESTION", "an answer from the history, with the turns it cites; the answer prints last"),
    k("/digest [filter]", "a summary by project (done · decided · waiting on you) of the Stream; the Stream's filters (@Name @project 3h today since 9am words); alone: since you last looked here"),
    k("@Name in the words", "only those agents' history (\"/keyword @Sankey poetry\"); else everyone's"),
    k("follow-ups", "results go to Thoughts with your next message: \"tell me more about the second one\""),
    k("Tab · Ctrl+Tab", "complete an @name or a /command · next world"),
    k("^↑↓ PgUp PgDn wheel", "scroll back through the thread (plain ↑↓ are the box's: your earlier messages)"),
    k("^End · ^Home", "back to the newest · the oldest (the header counts the lines ↑ above and ↓ below)"),
    k("Ctrl+V · SUPER+V", "paste text, or a screenshot: its path goes in at the cursor, and it is sent with the message"),
    k("click · ^click", "open a link / file path · ^click an agent's name or an evidence line: that agent's window"),
    k("mouse", "drag = text · Shift+drag or Shift+click = whole items · double-click = word · triple-click = whole item · each copies"),
    k("Esc · Ctrl+U · Ctrl+Q", "stop what's running (else close this help) · clear the box · quit"), // J203: Esc never touches the box
    "",
    ...cmds.help().map(([c, d]) => k(c, d)),
  ];
}

let restarting = false; // re-exec in progress: the child owns the terminal

// "Thinking" shimmer while a search runs (lib/tui/shimmer.mjs, shared with the board view).
// The timer runs only while busy.
import { shimmer as shimmerAt, createAnim } from "../lib/tui/shimmer.mjs";
const anim = createAnim(() => render());
const shimmer = (text, c) => shimmerAt(text, c, S.startedAt);
// ---- select & copy, like the room panel (mockups/room-tui.mjs) ---------------------
// Search box: Shift+←→ / Ctrl+Shift+←→ / Shift+Home End select; typing replaces the
// selection; Ctrl+C copies it (no selection: the whole box); Ctrl+X cuts; Ctrl+V /
// Shift+Insert / bracketed paste paste; SUPER+C (Ctrl+Insert) copies.
// Pane: drag selects text (answer / snippet text only) and copies on release;
// Shift+click / Shift+drag = whole items (the answer, or a result with name, time and
// text); double-click = a word; triple-click = the whole item. The highlight stays
// until the next key or click. Click selects a result; Enter jumps to it.
let selA = null;        // box selection anchor (grapheme index), or null
let pasting = false;    // inside a bracketed paste
function boxSel() { if (selA == null || selA === qc) return null; return selA < qc ? [selA, qc] : [qc, selA]; }
// The editing itself is the shared message box (lib/tui/input-box.mjs), one line here: the panel
// keeps query / qc / selA and loads them into the box before each edit, then reads them back.
const thoughtsHistory = createHistory("thoughts");
// Seed once per world (Blink's test of 32720d3: a lazy "seed when empty" never ran if something was
// typed first, and lost the earlier messages): the first time a world's thread loads here, its
// earlier messages ("you" entries, oldest first) go IN FRONT of whatever the list already holds
// (entries already in it are not repeated), and the world is marked in thoughts.seeded.json.
function seedThoughtsHistory(r) {
  const markFile = thoughtsHistory.file.replace(/\.json$/, ".seeded.json");
  let marks = []; try { marks = JSON.parse(fs.readFileSync(markFile, "utf8")); } catch { /* none yet */ }
  if (!Array.isArray(marks)) marks = [];
  if (marks.includes(r)) return;
  const cur = thoughtsHistory.list(), have = new Set(cur), merged = [];
  for (const t of [...TH.entries.filter((e) => e.role === "you" && e.text && !have.has(e.text)).map((e) => e.text), ...cur])
    if (merged[merged.length - 1] !== t) merged.push(t);
  try {
    fs.mkdirSync(thoughtsHistory.file.replace(/\/[^/]*$/, ""), { recursive: true });
    fs.writeFileSync(thoughtsHistory.file + ".tmp", JSON.stringify(merged.slice(-300))); fs.renameSync(thoughtsHistory.file + ".tmp", thoughtsHistory.file);
    fs.writeFileSync(markFile + ".tmp", JSON.stringify([...marks, r])); fs.renameSync(markFile + ".tmp", markFile);
  } catch { /* best effort: tried again next time */ }
}
// The box keeps its state in this panel's variables (query, qc, selA) through bind: every box
// operation reads them first and writes them back after (Angus, N55: no glue here).
const box = createInputBox({
  onChange: () => render(), copy: (t) => copy(t), multiline: false,
  drafts: `thoughts-${(process.argv[2] || "any").toUpperCase()}`, // J194: unsent draft kept across close/crash, cleared drafts ring (Ctrl+Z / Alt+Z)
  bind: { read: () => ({ text: query, cursor: qc, anchor: selA }), write: (st) => { query = st.text; qc = st.cursor; selA = st.anchor; } },
  // Everything typed here, /commands too (Angus: recall /ask, /keyword …), like every panel's box:
  // STATE/input-history/thoughts.json, one list for every world's Thoughts window; each world's
  // earlier thread messages are put in front of it once, when its thread loads (seedThoughtsHistory).
  history: thoughtsHistory,
  historyNotes: { first: "that's your first message here", none: "no earlier messages yet" },
  tint: atTint((name) => { const r = resolveAt([name], hereKnown()), a = r.found[0]; return a ? { agent: a } : r.special ? { special: true } : null; },
    { worldFg: (x) => x, bold, nameFg: (_n, color, g) => hexFg(color || "", bold(g)) }),
});
function insertText(t) { box.insert(t); note = ""; render(); }
function copyBoxSel(cut) { const ok = box.copySel(cut); render(); return ok; }
function copy(text) {
  if (!text) return;
  // OSC 52 (kitty puts it on the clipboard) and wl-copy as a fallback.
  out(`\x1b]52;c;${Buffer.from(text).toString("base64")}\x07`);
  try { const p = spawnChild("wl-copy", ["--type", "text/plain;charset=utf-8"], { stdio: ["pipe", "ignore", "ignore"] }); p.on("error", () => {}); p.stdin.on("error", () => {}); p.stdin.end(text); } catch { /* OSC 52 only */ }
  note = `copied ${text.length} character${text.length === 1 ? "" : "s"}`;
}
// Pane selection. screen = the plain text of every row; rowMeta[y] = { item, textX, header }
// for pane rows that belong to an item; items[k].copy = what a whole-item copy gives.
let screen = [], rowMeta = {}, items = [], sel = null; // sel: { x0, y0, x1, y1, dragging, clicks, mode } (1-based cells)
let clicks = 0, lastPress = { x: 0, y: 0, t: 0 };
let boxArea = null; // where render() drew the box (N79: clicks in it, lib/tui/input-box.mjs boxHit)
function selRange() {
  if (!sel || (sel.mode !== "item" && sel.x0 === sel.x1 && sel.y0 === sel.y1)) return null;
  const fwd = sel.y0 < sel.y1 || (sel.y0 === sel.y1 && sel.x0 <= sel.x1);
  return fwd ? { y0: sel.y0, x0: sel.x0, y1: sel.y1, x1: sel.x1 } : { y0: sel.y1, x0: sel.x1, y1: sel.y0, x1: sel.x0 };
}
function selItems(sr) {
  const near = (y, d) => { for (let k = 0; k < 400; k++, y += d) { const r = rowMeta[y]; if (r) return r.item; if (y < 1 || y > screen.length) break; } return null; };
  const a = near(sr.y0, 1), b = near(sr.y1, -1);
  if (a == null || b == null) return [null, null];
  return a <= b ? [a, b] : [b, a];
}
function selSpans(W) {
  const sr = selRange(), outSp = {};
  if (!sr) return outSp;
  if (sel.mode === "item") {
    const [a, b] = selItems(sr); if (a == null) return outSp;
    for (const [y, r] of Object.entries(rowMeta)) if (r.item >= a && r.item <= b) outSp[y] = [1, W];
    return outSp;
  }
  for (let y = sr.y0; y <= sr.y1; y++) {
    let a = y === sr.y0 ? sr.x0 : 1, b = y === sr.y1 ? sr.x1 : W;
    if (sel.mode === "text") {
      const r = rowMeta[y];
      if (!r || r.header) continue;
      a = Math.max(a, r.textX);
      b = Math.min(b, width((screen[y - 1] || "").trimEnd()));
    }
    if (a <= b) outSp[y] = [a, b];
  }
  return outSp;
}
function overlay(line, a, b, on, off) { // paint cells a..b with a background, keeping other styles
  let col = 1, r = "", inside = false;
  for (const part of line.split(/(\x1b\[[0-9;?]*[A-Za-z])/)) {
    if (part.startsWith("\x1b")) { r += part; if (inside && /\x1b\[(?:0|49|27)?m$/.test(part)) r += on; continue; }
    for (const g of graphemes(part)) {
      if (!inside && col >= a && col <= b) { r += on; inside = true; }
      if (inside && col > b) { r += off; inside = false; }
      r += g; col += gw(g);
    }
  }
  if (inside && col <= b + 1) r += " ".repeat(Math.max(0, b + 1 - col));
  else if (!inside && col <= a) { r += " ".repeat(a - col) + on + " ".repeat(b - a + 1); inside = true; }
  if (inside) r += off;
  return r;
}
function sliceCols(tx, a, b) {
  let col = 1, r = "";
  for (const g of graphemes(tx)) { const w = gw(g); if (col >= a && col + w - 1 <= b) r += g; col += w; if (col > b) break; }
  return r;
}
function selectedText() {
  const sr = selRange(); if (!sr) return "";
  const W = process.stdout.columns || 100;
  if (sel.mode === "item") { const [a, b] = selItems(sr); return a == null ? "" : items.slice(a, b + 1).map((x) => x.copy).join("\n\n"); }
  const spans = selSpans(W), ys = Object.keys(spans).map(Number).sort((p, q) => p - q);
  if (sel.mode === "text") { // unwrap: rows of one item join with a space
    let tx = "", prev = null;
    for (const y of ys) {
      const r = rowMeta[y], piece = sliceCols(screen[y - 1], spans[y][0], spans[y][1]).trim();
      if (prev) tx += prev.item !== r.item ? "\n" : " ";
      tx += piece; prev = r;
    }
    return tx;
  }
  return ys.map((y) => sliceCols(screen[y - 1], spans[y][0], spans[y][1]).trimEnd()).join("\n");
}
function multiClick(n, x, y) { // 2 = the word under the pointer, 3 = the whole item (or the line)
  const line = screen[y - 1] || "", cells = [];
  { let col = 1; for (const g of graphemes(line)) { cells.push([col, g]); col += gw(g); } }
  if (n === 2) {
    const i = cells.findIndex(([cc, g], k) => cc <= x && (cells[k + 1]?.[0] ?? cc + gw(g)) > x);
    if (i < 0 || /\s/.test(cells[i][1])) { sel = null; return render(); }
    let a = i, b = i;
    while (a > 0 && !/\s/.test(cells[a - 1][1])) a--;
    while (b < cells.length - 1 && !/\s/.test(cells[b + 1][1])) b++;
    const P = /^[\p{P}\p{S}]$/u;
    while (a < b && P.test(cells[a][1]) && !/[@#~/$]/.test(cells[a][1])) a++;
    while (b > a && P.test(cells[b][1])) b--;
    sel = { x0: cells[a][0], y0: y, x1: cells[b][0] + gw(cells[b][1]) - 1, y1: y, dragging: true, mode: "plain" };
  } else if (rowMeta[y]) sel = { x0: x, y0: y, x1: x, y1: y, dragging: true, mode: "item" };
  else {
    const first = cells.find(([, g]) => !/\s/.test(g));
    if (!first) { sel = null; return render(); }
    sel = { x0: first[0], y0: y, x1: width(line.trimEnd()), y1: y, dragging: true, mode: "plain" };
  }
  copy(selectedText());
  render();
}

function syncAnim() {
  anim.sync(!!EV.busy || TH.busy);
}

function render() {
  if (restarting) return;
  syncAnim();
  const W = process.stdout.columns || 100, H = process.stdout.rows || 30, c = worldFg(room);
  const rows = [];
  const rule = (label) => fg(c, "─" + (label ? ` ${label} ` : "") + "─".repeat(Math.max(0, W - 1 - (label ? width(label) + 2 : 0))));
  const headLabel = `thoughts ${room}`; // "— thoughts C" (Angus)
  rows.push(rule(headLabel));
  review = reviews[room] || null;
  if (review) { // J274: the held message under review, and how to answer
    const h = review.h;
    rows.push(fg(c, bold(clip(`🐳 held: ${h.sandbox} → ${h.to.join(", ")} (${h.mode})`, W))));
    rows.push(clip("   " + h.text.replace(/\s+/g, " "), W));
    rows.push(dim(clip(review.confirm ? `   ${review.confirm.label}? y + ⏎ confirms · anything else cancels` : "   (1) Approve (2) Deny (3) Allow similar for 1 hour · or e.g. \"3 for 2 hours\" · anything else goes to Thoughts", W)));
  }
  const prompt = fg(c, bold(`${room} ❯ `)); // J198 (Angus): every panel's prompt is just "D ❯" (was a 💭)
  const slash = note.startsWith("✗") ? null : cmds.hint(query); // typing a /command: its matches (shared)
  const hint = slash ? dim("  " + slash) : query ? "" : dim(`talk to Thoughts-${room} · /keyword WORDS · /ask QUESTION · /help`);
  const selOn = theme.selection ? `${ESC}48;2;${rgb(theme.selection)}m` : `${ESC}7m`, selOff = theme.selection ? `${ESC}49m` : `${ESC}27m`;
  // The bottom block, like an agent window (Angus: the box at the bottom): the status line
  // ("thinking…"), a rule, the box (wrapped, up to a third of the height, scrolled to the cursor),
  // (pasted images are paths in the text now, N54). Built first: its height decides the thread's.
  const pw = width(prompt), L = box.layout(Math.max(10, W - pw)), MAXI = Math.max(2, Math.min(8, Math.floor(H / 3)));
  const inTop = L.rows.length > MAXI ? Math.max(0, Math.min(L.cRow - MAXI + 1, L.rows.length - MAXI)) : 0;
  const inRows = L.rows.slice(inTop, inTop + MAXI);
  const status = note || S.status;
  const statusStyled = status.startsWith("✗") ? `${ESC}31m${status}${ESC}39m` : status.startsWith("🐳") || status.startsWith("🔌") || status.startsWith("✓") ? fg(c, bold(status)) : dim(status); // J280: review hints and results readable
  const bottom = [];
  // One animation only (Angus): "thinking…" / "searching…" in the thread; this line stays still.
  // (J247: "↓ N new" is the pill at the bottom right of the thread now, not this line.)
  bottom.push(" " + (note ? statusStyled : dim(`Thoughts-${room} · remembers this conversation · can ask agents and hand them work`)));
  bottom.push(fg(c, "─".repeat(W)));
  const boxAt = bottom.length;
  inRows.forEach((l, i) => bottom.push((i === 0 ? prompt : " ".repeat(pw)) + l + (i === 0 && inRows.length === 1 ? hint : "")));
  // No second rule (Angus: no "thread" line): the conversation starts right under the header, and
  // the header itself says so when you've scrolled back or opened /help.
  const ruleAt = 0;
  const headN = rows.length; // 1, or 4 with a held review strip (review J274 #6)
  const avail = Math.max(1, H - rows.length - bottom.length - 1); // the thread; 1 = the status bar
  resultRows = {}; rowMeta = {}; items = []; linkRows = {};

  if (!showHelp && thoughtsOn) {
    // The thread, newest at the bottom; ^↑↓ / PgUp PgDn / the wheel scroll it.
    // Built through threadCache (top of file): the per-entry wrapped lines are reused between
    // renders and re-wrapped only on a width change or new/changed entries — typing used to
    // re-wrap the whole thread on every keystroke (~170 ms on the long world-C thread).
    const tw = Math.max(10, W - 5);
    function buildThread() {
      const flat = [], items = [];
    const who = (e) => e.role === "you" ? fg(c, bold("you")) + (e.via === "voice" ? " 🎤" : e.via === "phone" ? " 📱" : "") : e.role === "thoughts" ? bold(`💭 Thoughts-${room}`) : "";
    // Every entry through mdRows: Markdown, and links / file paths clickable (Angus: all links and
    // paths must be clickable). x.links: [{ x0, x1, target }] in the row's own columns.
    const md = (text, n, pre, style = (l) => l) => mdRows(text, n, wrap, gw).map((r) => ({ l: pre + style(r.line), links: r.links.map((q) => ({ ...q, x0: q.x0 + pre.length, x1: q.x1 + pre.length })) }));
    // N53 (Angus via Thoughts-C): incoming agent replies / messages are not drawn (Thoughts' summary
    // already covers them; they stay in its context and in /keyword /ask). Thoughts' own answers to
    // agents show as ONE short grey line with what it said: "↩ to Blink: …", one or two rows.
    // Which entries show and how: lib/thoughts-lines.mjs (the same rule as the phone app).
    let tagFrom = 0, tagKey = null;
    const tag = () => { for (let i = tagFrom; i < flat.length; i++) flat[i].ek = tagKey; }; // J247: each row knows its entry
    // J280: the held-message decision turns (lib/held.mjs heldTurns) merged in by time
    let lastTs = 0; const dated = TH.entries.map((e) => ({ e, ts: (lastTs = Number(e.ts) || lastTs) })); // undated: keep their place (#7)
    const extra = [...turns, ...sysTurns]; // J280 decision turns, J283 reconnect turns
    const merged = extra.length ? [...dated, ...extra.map((e) => ({ e, ts: e.ts }))].sort((a, b) => a.ts - b.ts).map((x) => x.e) : TH.entries;
    for (const [ei, e] of merged.entries()) {
      tag(); tagFrom = flat.length; tagKey = entryKey(e);
      const kind = threadKind(e);
      if (kind === "hidden" || kind === "quiet") continue;
      if (e.role === "note" && /^🐳 (Approved|Denied|Sent under|Reply from)/u.test(String(e.text || ""))) continue; // J289/J290: drawn as a highlighted turn from panel-turns.jsonl instead // J147: quiet = hyprpi's automatic notes (in the Stream's all-activity view)
      if (kind === "answer") {
        const { to, raw, said, cutOld } = answerLine(e);
        const k2 = items.push({ copy: `to ${to}: ${raw}` }) - 1;
        // (Answers stored before the N53 fix were cut at 140 characters at the source: cutOld marks those.)
        const rows = wrap(`↩ to ${to}: ${said}${cutOld ? "…" : ""}`, tw - 2);
        rows.slice(0, 2).forEach((r, n) => flat.push({ l: "   " + dim(n === 1 && rows.length > 2 ? r.replace(/.?$/, "…") : r), meta: { item: k2, textX: 4 } }));
        continue;
      }
      const k = items.push({ copy: e.text }) - 1, red = (l) => `${ESC}31m${l}${ESC}39m`;
      const add = (rs, textX) => { for (const r of rs) flat.push({ ...r, meta: { item: k, textX } }); };
      if (e.role === "held") { // J280: a decision on a held sandbox message, highlighted at full brightness
        let [head, ...rest] = String(e.text).split("\n");
        // J293 (Angus): a decision taken outside the panel (toast, terminal, room panel, a dismiss, a rule) and a reply:
        // just the icon and the word, white on the world colour, no route or time. The Review flow's turns are unchanged.
        const route = /^(.*?) \((?:toast|terminal|room panel|dismissed), [^)]*\)$/.exec(head);
        const plain = e.kind === "reply" || !!route || /^Sent under your rule/.test(head);
        if (plain) head = e.kind === "reply" ? head.replace(/ to \S+ \([^)]*\)$/, "") : route ? (/^Denied/.test(route[1]) ? "Denied" : "Approved") : head.replace(/^Sent under your rule/, "Sent under rule");
        const bar = `${ESC}${worldBg(room)}m${ESC}97m`, off = `${ESC}49m${ESC}39m`; // J293 v2 (Angus: "ALL notifications white with the world colour highlighting"; a failure keeps its ✗)
        flat.push({ l: "" });
        flat.push({ l: `  ${bar}${bold(` ${plain || e.kind === "request" ? "" : e.ok ? "✓ " : "✗ "}${e.icon || "🐳"} ${head} `)}${off}${plain ? "" : dim("  " + when(e.ts))}`, meta: { item: k, textX: 3, header: true } });
        for (const [li, line] of rest.entries()) add(wrap(line, tw - 4).map((w) => ({ l: `   ${fg(c, "│")} ${e.kind === "request" && li === rest.length - 1 ? bold(w) : w}` })), 6);
        continue;
      }
      if (kind === "full") {
        flat.push({ l: "" });
        flat.push({ l: `  ${who(e)}${dim("  " + when(e.ts))}`, meta: { item: k, textX: 3, header: true } });
        // Thoughts' "↩ from pi·wpzt" / "↪ to Blink" lead line (a direct message it is summing up): light grey like the other
        // indicator lines, and the summary right under it, no blank line between (Angus).
        let { lead, body } = splitLead(e);
        if (e.role === "thoughts" && reviews[room] && Number(e.ts) >= reviews[room].shownAt) // J280 #6: only the panel's 1/2/3 count while a review is open
          body = String(lead ? body : e.text).replace(/^(\s*(?:#+\s+|>\s*)*)(\*\*|__)?\s*\d+[a-z]?[.)]\s+(?!Approve, 2\. Deny, 3\. Allow Similar for 1 hr\s*(?:\*\*|__)?\s*$)/gm, "$1$2• "); // (J285: his own choices line stays as written) // only the panel's strip is numbered (also **1.**, # 1., 1a.)
        if (lead) add(md(lead, tw, "   ", dim), 4);
        add(md(e.role === "thoughts" && reviews[room] && Number(e.ts) >= reviews[room].shownAt ? body : lead ? body : e.text, tw, "   "), 4); // **bold**, *italic*, `code`, bullets, links
        const extra = (e.images || []).filter((f) => !String(e.text || "").includes(f) && !String(e.text || "").includes(f.replace(process.env.HOME || "\0", "~")));
        if (extra.length) add(md(extra.map((f) => `📎 ${f}`).join("\n"), tw, "   ", dim), 4); // images not already in the text as a (clickable) path
      } else if (kind === "action" || kind === "error") add(md(actionPrefix(e) + e.text, tw, "   ", kind === "error" ? red : dim), 4);
      else if (e.role === "agent") { flat.push({ l: `   ${dim(italic(`↪ ${e.from} asked Thoughts-${room}:`))}`, meta: { item: k, textX: 4 } }); add(md(e.text, tw - 2, "     ", dim).slice(0, 8), 6); }
      else if (e.role === "evidence") {
        items[k].copy = `${e.kind === "ask" ? "/ask" : e.kind === "digest" ? "/digest" : "/keyword"} ${e.query}${e.answer ? "\n" + e.answer : ""}`;
        if (e.kind === "digest") { // /digest: one line per Stream item (time · who · text [@project]), newest at the bottom
          flat.push({ l: "" });
          flat.push({ l: `  ${fg(c, bold("≡ digest"))} ${italic(e.query)}${dim(` · ${e.total} stream line${e.total === 1 ? "" : "s"}${e.older > 0 ? ` (the newest ${e.items.length} shown)` : ""} · ${when(e.ts)}`)}`, meta: { item: k, textX: 3, header: true } });
          for (const it of e.items || []) {
            const ki = items.push({ copy: `${when(it.ts)} ${it.text}` }) - 1;
            const lead = `   ${dim(when(it.ts))} `, room0 = Math.max(10, tw - 3 - width(strip(lead)));
            flat.push({ l: lead + clip(String(it.text).replace(/\s+/g, " "), room0), meta: { item: ki, textX: 4 + width(strip(lead)) - 3 } });
          }
          continue;
        }
        // /keyword · /ask (by you) or the Thoughts agent's own search: numbered, oldest first; the
        // answer (ask) last. Each line keeps its turn's reference (items[k].ref, for Ctrl+click).
        flat.push({ l: "" });
        const tag = e.kind === "ask" ? "✦ ask" : "⌕ keyword";
        const count = e.items?.length ? `${e.items.length}${e.total > e.items.length ? " of " + e.total : ""} ${e.kind === "ask" ? "cited" : "matching"} turn${e.items.length === 1 ? "" : "s"}` : "no matches";
        flat.push({ l: `  ${fg(c, bold(tag))} ${italic(`"${e.query}"`)}${dim(` · ${count}${e.filter?.length ? " · only " + e.filter.map((n) => "@" + n).join(" ") : ""}${e.by === "thoughts" ? ` · by Thoughts-${room}` : ""} · ${when(e.ts)}`)}`, meta: { item: k, textX: 3, header: true } });
        if (e.older > 0) flat.push({ l: `     ${dim(`+${e.older} older · /more`)}` });
        (e.items || []).forEach((it, n) => {
          const ki = items.push({ copy: `${it.who} · ${when(it.ts)}\n${String(it.text ?? (it.pre || "") + (it.match || "") + (it.post || "")).replace(/\s+/g, " ").trim()}`, ref: it.ref, who: it.who }) - 1;
          const also = it.also?.length ? dim(` · also ${it.also.slice(0, 4).join(", ")}${it.also.length > 4 ? ` +${it.also.length - 4}` : ""}`) : "";
          // Name · time (Angus): the name in its agent's colour (looked up when the result has none,
          // e.g. /ask), the time grey; no number, no role.
          const col = it.color || known.find((a) => a.display === it.who || a.name === it.who)?.color || "";
          const head = `   ${hexFg(col, bold(it.who))}${dim(" · " + when(it.ts))}${also}`;
          flat.push({ l: head, meta: { item: ki, textX: 4, header: true } });
          const body = it.text != null ? String(it.text).replace(/\s+/g, " ") : null;
          const lines = body != null ? wrap(body, tw - 4).slice(0, 3).map((x) => `        ${x}`) : resultLines({ ...it, name: it.who }, -1, W).slice(1, 4).filter((x) => strip(x).trim()).map((x) => "     " + x.slice(1));
          for (const l of lines) flat.push({ l, meta: { item: ki, textX: 9 } });
          if (it.link) for (const r of md(`↗ archived thread: ${it.link}`, tw - 4, "        ", dim)) flat.push({ ...r, meta: { item: ki, textX: 9 } }); // J119: open the archived thread
        });
        if (e.answer) { flat.push({ l: "" }); add(md("↳ " + e.answer, tw, "   "), 4); } // the answer prints last, below the evidence
      }
      else if (e.role === "reply") { flat.push({ l: `   ${dim(italic(`↩ ${e.from} replied:`))}`, meta: { item: k, textX: 4 } }); add(md(e.text, tw - 2, "     ", dim).slice(0, 12), 6); }
      else add(md(e.text, tw, "   ", e.text.startsWith("✗") ? red : dim), 4);
    }
      tag();
      return { flat, items };
    }
    const ck = `${tw}|${room}|${new Date().toDateString()}|${Object.values(theme).join()}|` + known.map((a) => a.display + (a.color || "")).join("");
    if (!threadCache.flat || threadCache.key !== ck) threadCache = { key: ck, ...buildThread() };
    items = threadCache.items;
    const flat = threadCache.flat.slice();
    if (!TH.entries.length) flat.push({ l: "" }, { l: dim(`   Thoughts-${room} is this world's own agent: think out loud, ask about what's going on,`) }, { l: dim("   have it keep a thought (\"keep this\"), ask an agent, or hand something off. It remembers.") }, { l: dim("   /keyword WORDS searches the history · /ask QUESTION answers from it, with the turns it used.") });
    if (TH.busy) flat.push({ l: "" }, { l: "   " + shimmer("thinking…", c) });
    if (EV.busy) flat.push({ l: "" }, { l: "   " + shimmerAt(EV.busy === "ask" ? "asking the history…" : "searching…", c, EV.startedAt) });
    // Pinned (J121): whatever was added below (or taken away: the thinking… lines) shifts scroll by as
    // much, so the same lines stay on screen. Not across a width or world change (the rows re-wrap).
    const pinKey = `${tw}|${room}|${avail}`;
    // After a restart onto new code (J247): the saved place, once this world's thread is loaded.
    if (TH.restore && TH.room === room && TH.entries.length) {
      const r = TH.restore; TH.restore = null;
      TH.pinned = true; TH.scroll = 1; TH.anchor = { ...r, scroll: 1 };
      TH.unseen = (r.unseen || 0) + TH.entries.filter((e) => (e.ts || 0) > (r.lastTs || 0) && shows(e)).length;
    }
    // Pinned (J121, J247): the first line on screen last time stays the first line, unless the scroll
    // was moved since (wheel, PgUp, ^↑↓): what's added below, the thinking… lines and re-wraps don't move it.
    if (TH.pinned && TH.scroll > 0 && TH.anchor && TH.scroll === TH.anchor.scroll) {
      const i0 = flat.findIndex((x) => x.ek === TH.anchor.ek);
      if (i0 >= 0) TH.scroll = Math.max(1, flat.length - avail - (i0 + TH.anchor.off));
    }
    TH.key = pinKey; TH.rows = flat.length;
    const maxScroll = Math.max(0, flat.length - avail);
    TH.max = maxScroll;
    TH.scroll = Math.max(0, Math.min(TH.scroll, maxScroll));
    const start = Math.max(0, flat.length - avail - TH.scroll), shown = flat.slice(start, start + avail);
    TH.anchor = null;
    if (TH.pinned && TH.scroll > 0) {
      let i = start; while (i < flat.length && flat[i].ek == null) i++;
      if (i < flat.length) TH.anchor = { ek: flat[i].ek, off: start - flat.findIndex((x) => x.ek === flat[i].ek), scroll: TH.scroll };
    }
    // Lines out of view, like the projects panel: "· ↑ N above · ↓ N below".
    const above = start, below = Math.max(0, flat.length - start - avail);
    if (above || below) rows[ruleAt] = rule(`${headLabel}${above ? ` · ↑ ${above} above` : ""}${below ? ` · ↓ ${below} below` : ""}`);
    while (shown.length < avail) shown.unshift({ l: "" }); // a short thread sits just above the box, like a chat
    shown.forEach((x, k) => { if (x.meta) rowMeta[rows.length + 1 + k] = x.meta; if (x.links?.length) linkRows[rows.length + 1 + k] = x.links; });
    rows.push(...shown.map((x) => x.l));
    TH.pill = null;
    if (TH.pinned && TH.scroll > 0 && TH.unseen > 0) { const pl = withPill(rows[rows.length - 1], TH.unseen, W, room); rows[rows.length - 1] = pl.line; TH.pill = { y: rows.length, x0: pl.x0, x1: pl.x1 }; }
  } else if (showHelp) {
    rows[ruleAt] = rule(`${headLabel} · help · Esc closes`);
    rows.push(...helpLines().slice(0, avail));
  } else if (S.busy) {
    // Nothing from the previous search stays on screen while this one runs.
    rows[ruleAt] = rule(S.mode === "ai" ? "answer" : "results");
  } else {
    // The pane: in AI mode the answer (not selectable, i = -1), then the results
    // (the evidence). Flattened to lines; the selected result is kept in view.
    const flat = [], starts = [];
    if (S.answer) {
      items.push({ copy: S.answer });
      for (const l of wrap(S.answer, Math.max(10, W - 4))) flat.push({ l: `   ${l}`, i: -1, meta: { item: 0, textX: 4 } });
      flat.push({ l: "", i: -1 });
      if (S.results.length) flat.push({ l: fg(c, dim(`   evidence · ${S.results.length} entr${S.results.length === 1 ? "y" : "ies"}`)), i: -1 }, { l: "", i: -1 });
    }
    S.results.forEach((r, i) => {
      starts.push(flat.length);
      const k = items.push({ copy: `${r.name} · ${ROLE[r.role] || r.role} · ${when(r.ts)}\n${String((r.pre || "") + (r.match || "") + (r.post || "")).replace(/\s+/g, " ").trim()}${r.why ? "\n↳ " + r.why : ""}` }) - 1;
      resultLines(r, i, W).forEach((l, n) => flat.push({ l, i, meta: l === "" ? null : { item: k, textX: 5, header: n === 0 } }));
    });
    if (S.selected >= 0 && starts.length) {
      // Selecting the first result scrolls back to the top so the answer shows again.
      const s = S.selected === 0 ? 0 : starts[S.selected], e = (starts[S.selected + 1] ?? flat.length) - 1;
      if (s < top) top = s;
      if (e >= top + avail) top = Math.min(starts[S.selected], e - avail + 1);
    }
    top = Math.max(0, Math.min(top, Math.max(0, flat.length - avail)));
    const shown = flat.slice(top, top + avail);
    // Results wholly or partly out of view, like the room TUI's "↓ N more".
    let above = 0, below = 0;
    starts.forEach((st, i) => { const en = (starts[i + 1] ?? flat.length) - 1; if (st < top) above++; if (en >= top + avail && st >= top + avail) below++; });
    const label = S.answer ? "answer" : S.results.length ? "results" : "";
    rows[ruleAt] = rule(label ? [label, above ? `↑ ${above} above` : "", below ? `↓ ${below} below` : ""].filter(Boolean).join(" · ") : "");
    shown.forEach((x, k) => { if (x.i >= 0) resultRows[rows.length + 1 + k] = x.i; if (x.meta) rowMeta[rows.length + 1 + k] = x.meta; });
    if (S.ranFor && !S.busy && !S.results.length && !S.answer && !S.status.startsWith("✗")) shown.push({ l: dim(S.mode === "ai" ? "  Nothing matched that idea." : "  No exact matches.") });
    rows.push(...shown.map((x) => x.l));
  }
  while (rows.length < headN + avail) rows.push(""); // the thread's area, then the bottom block
  rows.length = Math.min(rows.length, headN + avail);
  const bottomY = rows.length + 1;
  boxArea = { y0: bottomY + boxAt, n: inRows.length, inTop, pw };
  rows.push(...bottom);
  const cursorRow = bottomY + boxAt + (L.cRow - inTop), cursorCol = Math.min(W, pw + L.cCol + 1);
  while (rows.length < H - 1) rows.push("");

  // status bar: rooms as tabs (like the room TUI)
  // J198 (Angus): the footer shows only THIS world's letter (highlighted); Ctrl+Tab / Ctrl+Shift+Tab move between worlds.
  const tabs = rooms.filter((r) => r === room).map((r) => r === room ? `${ESC}${worldBg(r)};30m ${r} ${ESC}49;39m` : ` ${fg(worldFg(r), r)} `).join("");
  const left = ` hyprpi thoughts ${online ? "" : "· daemon offline "}`;
  const right = `/keyword · /ask · /more · /help · ^Q quit `;
  const mid = W - width(left) - width(strip(tabs)) - width(right);
  worldBar = { y: rows.length + 1, x0: width(left) }; // only this world's letter is drawn (J198); a click on it does nothing (lib/tui/world-tabs.mjs)
  rows.push(`${ESC}7m${left}${ESC}27m${tabs}${ESC}7m${" ".repeat(Math.max(0, mid))}${right}${ESC}27m`);

  out(`\x1b]2;hyprpi-search ${room}\x07`); // panel identity: mockups/panels finds it by this exact title
  const clipped = rows.slice(0, H).map((r) => clip(r, W));
  screen = clipped.map(strip);
  const spans = selSpans(W);
  out(`${ESC}?2026h${ESC}H` + clipped.map((r, i) => (spans[i + 1] ? overlay(r, spans[i + 1][0], spans[i + 1][1], selOn, selOff) : r) + `${ESC}0m${ESC}K`).join("\r\n") + `${ESC}J`);
  out(`${ESC}${cursorRow};${cursorCol}H${ESC}?25h${ESC}?2026l`); // one synchronized frame, cursor never hidden (no flicker while "thinking…" animates)
}

// Ctrl+click: a link opens; an agent's name under the pointer (@Name, or as shown, "Sankey[e]"
// too) jumps to its window; elsewhere on a result, that result's agent (if still open).
// Matching: lib/tui/agent-click.mjs.
function ctrlClick(x, y) {
  const lt = linkAt(x, y);
  if (lt) { if (openTarget(lt)) { note = `opened ${lt.replace(process.env.HOME || "\0", "~")}`; render(); } return; }
  const word = wordAt(screen[y - 1] || "", x, gw);
  const url = urlIn(word);
  if (url) { try { spawnChild("gio", ["open", url], { detached: true, stdio: "ignore" }).on("error", () => {}).unref(); } catch { /* none */ } return; }
  if (!api) return;
  let hit = word ? agentIn(word, known.filter((ag) => ag.live)) : null;
  const ref = rowMeta[y] != null ? items[rowMeta[y].item]?.ref : null; // an evidence line: its turn's agent
  if (!hit && ref?.kind === "agent") {
    hit = known.find((ag) => ag.live && ag.id === ref.source) || null;
    if (!hit) { note = `${items[rowMeta[y].item].who} is closed`; return render(); }
  }
  if (!hit) { const n = bareName(word); if (n) { note = `no live agent @${n}`; render(); } return; }
  api.call("agent.focus", { agent: hit.id }).then(() => { note = `→ @${hit.display}`; render(); }).catch((e) => { note = "✗ " + e.message; render(); });
}
function jump() {
  const r = S.current();
  if (!r || !api) return;
  if (r.kind !== "agent" || !r.live) { note = r.kind === "room" ? "that's the room log (open the room with Ctrl+Tab in the room panel)" : `${r.name} is closed`; return render(); }
  note = "";
  api.call("agent.focus", { agent: r.source }).then(() => { note = "→ " + r.name; render(); }).catch((e) => { note = "✗ " + e.message; render(); });
}

// J283 (Angus: "what happened, you went away"): a reconnect to the daemon is its own highlighted turn, saying
// whether the daemon restarted (another pid) or the connection only dropped, and for how long.
let daemonInfo = null, lostAt = 0, sysTurns = [];
async function noteReconnect() {
  let info = null; try { info = await api.call("ping"); } catch { return; }
  const before = daemonInfo; daemonInfo = { pid: info?.pid, started: info?.started };
  if (!before) { lostAt = 0; return; } // the first connection: nothing to say
  const restarted = before.pid !== daemonInfo.pid || before.started !== daemonInfo.started; // (pid reuse: started too)
  if (!lostAt && !restarted) return;
  const secs = lostAt ? Math.max(1, Math.round((Date.now() - lostAt) / 1000)) : 0, hhmm = (t) => new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const what = restarted ? `the hyprpi daemon restarted at ${hhmm(daemonInfo.started || Date.now())}` : "the connection to hyprpi dropped";
  sysTurns.push({ role: "held", icon: "🔌", ok: true, ts: Date.now(), text: `Reconnected: ${what}${secs ? ` (offline ${secs} s)` : ""}\nThe saved conversation is kept; a reply that was underway may need asking again.` });
  if (sysTurns.length > 20) sysTurns.shift();
  lostAt = 0; note = `🔌 reconnected: ${what}`; bumpThread(); if (TH.pinned) TH.unseen++; render(); // (review: don't jump a reader to the bottom)
}
async function start() {
  try {
    api = await connect({
      onEvent: (ev, data) => {
        if (ev === "agents") applyRooms(data);
        else if (ev === "search-run" && data?.room === room) runFrom(data.mode, data.query); // /search, /ai from another panel
        else if (ev === "thoughts" && data?.room === room) { const nt = heldTurns(room); if (nt.map((x) => x.ts).join() !== turns.map((x) => x.ts).join()) { turns = nt; bumpThread(); } if (data.reset) { TH.entries = []; follow(); bumpThread(); loadThoughts(); } if (data.entry) { TH.entries.push(data.entry); if (TH.pinned) { if (shows(data.entry)) TH.unseen++; } else TH.scroll = 0; bumpThread(); } if (data.busy !== undefined) { TH.busy = !!data.busy; if (!TH.busy) setTimeout(nextStep, 400); } if (thoughtsOn) render(); }
      },
      onClose: () => { online = false; api = null; lostAt ||= Date.now(); render(); setTimeout(start, 1500); },
    });
    online = true;
    noteReconnect();
    if (thoughtsOn) loadThoughts();
    applyRooms(await api.call("ui.subscribe", { windows: false }));
    if (!startRan) { startRan = true; runFrom(startArgs.mode, startArgs.query); } // opened by /search or /ai elsewhere
    render();
  } catch { online = false; render(); setTimeout(start, 1500); }
}
function applyRooms(r) {
  bumpThread(); // agents' colours/names feed the thread's evidence heads (Blink)
  known = [...(r.agents || []).map((a) => ({ ...a, live: true })), ...(r.dormant || []).map((a) => ({ ...a, live: false }))];
  rooms = (r.rooms || []).map((x) => x.id).sort();
  if (!room) room = r.active_room || rooms[0] || "A";
  if (!rooms.includes(room)) rooms = [...rooms, room].sort();
  render();
}

// ---- input --------------------------------------------------------------------
// Alt+<key> arrives as ESC followed by the key; read it as ONE key so it can never
// look like a lone Esc (a lone Esc is only an ESC at the end of a read).
const KEY = /\x1b\[<[\d;]+[Mm]|\x1b\[[\d;?]*[A-Za-z~]|\x1bO[A-Za-z]|\x1b[\s\S]|[\s\S]/gu;
process.stdin.setRawMode?.(true);
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { for (const [k] of String(chunk).matchAll(KEY)) onKey(k); });
function move(d) { if (showHelp) return; TH.scroll = Math.max(0, Math.min(TH.max, TH.scroll - d * (Math.abs(d) >= 5 ? 1 : 3))); if (TH.scroll > 0) TH.pinned = true; else follow(); render(); } // J121: up pins, the bottom follows
function onKey(d) {
  // SUPER+C (Omarchy's universal copy = Ctrl+Insert; kitty passes it on when it has no selection of its
  // own): the pane's highlighted selection, if there is one, else the box's (below). @hyprpi N49
  if (d === "\x1b[2;5~" && sel && selRange()) { copy(selectedText()); note = "copied"; return render(); }
  if (sel && !d.startsWith("\x1b[<")) sel = null; // a pane selection lasts until the next key
  if (d === "\x1a" || d === "\x1f" || d === "\x19" || d === "\x1b[122;6u" || d === "\x1bz") { box.key(d); note = box.note || ""; return render(); } // J194: Ctrl+Z undo · Ctrl+Y redo · Alt+Z cleared drafts
  // Bracketed paste (SUPER+V / Ctrl+Shift+V): inserted as text (line breaks become spaces).
  if (d === "\x1b[200~") { pasting = true; return; }
  if (d === "\x1b[201~") { pasting = false; return render(); }
  if (pasting) return insertText(d);
  if (d === "\x1b[O") return seen(); // focus out (DECSET 1004)
  if (d === "\x1b[I") return;        // focus in
  if (d === "\x11") return quit(); // Ctrl+Q
  if (d === "\x1b" || d === "\x1b\x1b") { // Esc: interrupt, else close help; never the box
    // Esc (Angus): interrupt what's running; else close help (pasted images are paths in the text now). It never
    // touches the text box (its text, cursor or selection).
    if (interrupt()) return;
    if (showHelp) { showHelp = false; return render(); }
    return;
  }
  // Ctrl+C: copy the box's selection, else the whole box; it never deletes it (Angus) and never
  // quits (Ctrl+Q does). Ctrl+U clears the box.
  if (d === "\x03") { if (copyBoxSel(false)) return; if (query) { copy(query); note = "copied the search"; } return render(); }
  if (d === "\x1b[2;5~") { copyBoxSel(false); return; } // SUPER+C (Ctrl+Insert, passed on when kitty has no selection)
  if (d === "\x18") { copyBoxSel(true); return; } // Ctrl+X: cut
  if (d === "\x16" || d === "\x1b[2;2~") { box.paste(); return; } // Ctrl+V / Shift+Insert: text, or a screenshot's path at the cursor (the shared box)
  // Ctrl+Tab / Ctrl+Shift+Tab: next / previous world. Plain Tab never switches world:
  // it completes a /command or an @name (again: next match; Shift+Tab: back).
  if (CTRL_TAB.has(d)) return cycle(1);
  if (CTRL_SHIFT_TAB.has(d)) return cycle(-1);
  if (d === "\t" || d === "\x1b[Z") {
    if (d === "\t" && /^\/\S*$/.test(query)) return complete();
    if (completeName(d === "\t" ? 1 : -1)) return;
    note = "Tab completes @names and /commands · Ctrl+Tab switches world"; return render();
  }
  // Same scheme as the board: plain keys type (⏎ searches); ↑↓ / ^↑↓ move the highlight;
  // ^⏎ acts on it (jumps to that agent's window); ^click on a name jumps too.
  // Plain keys are the box's (↑ start, ↓ end of the one-line box); Ctrl is the pane's.
  if (d === "\x1b[1;5F") { follow(); return render(); } // Ctrl+End: back to the newest (and follow, J121)
  if (d === "\x1b[1;5H") { TH.scroll = 1e9; TH.pinned = TH.max > 0; return render(); } // Ctrl+Home: the oldest (pinned)
  if ((d === "\x1b[F" || d === "\x1b[4~" || d === "\x1bOF") && !query && TH.pinned) { follow(); return render(); } // End with an empty box: follow again (J121)
  if (d === "\x1b[1;5A") return move(-1);
  if (d === "\x1b[1;5B") return move(1);
  // ↑↓ like a Pi window (Angus; shared by every panel since N51): within the box first (↑ to its
  // start, ↓ to its end); then ↑ steps back through your earlier messages in this thread, ↓ forward
  // again, to what you were typing.
  if (d === "\x1b[A" || d === "\x1b[B") { box.key(d); note = box.note || ""; return render(); }
  if (d === "\x1b[13;5u") { showHelp = false; selA = null; return enter(); } // Ctrl+Enter: the same as ⏎ here
  if (d === "\x1b[5~") return move(-5);
  if (d === "\x1b[6~") return move(5);
  if (d === "\r") { showHelp = false; selA = null; return enter(); }
  // Editing the box (the shared box): ←→, Ctrl/Alt+←→ by word, Home/End, Shift-select,
  // Backspace / Delete / Alt+Backspace / Ctrl+W, Ctrl+U clear. Ctrl+A = Home here.
  if (d === "\x01") { qc = 0; selA = null; return render(); }
  if (d.startsWith("\x1b") || d === "\x7f" || d === "\b" || d === "\x15" || d === "\x05" || d === "\x17") {
    if (box.key(d)) { note = ""; return render(); }
  }
  if (d.startsWith("\x1b[<")) {
    const m = /\x1b\[<(\d+);(\d+);(\d+)([Mm])/.exec(d); if (!m) return;
    const b = Number(m[1]), x = Number(m[2]), y = Number(m[3]);
    const tab = b === 0 && m[4] === "M" ? worldTabAt(worldBar, x, y, [room]) : null;
    if (tab) { const s = stepTo(rooms, room, tab); if (s) cycle(s); return; } // a world tab: like Ctrl+Tab
    if (b === 0 && pillHit(TH.pill, x, y)) { if (m[4] === "M") { follow(); sel = null; } return render(); } // J247: the "↓ N new" pill
    if (b === 64) return move(-1);
    if (b === 65) return move(1);
    // Left button (+4 = Shift): press starts a possible selection, motion drags it,
    // release copies it; without a drag it is a click (select a result) or a
    // double / triple click (word / whole item).
    if (b === 16 && m[4] === "M") return ctrlClick(x, y); // Ctrl+click: an agent's name → its window
    if (b === 16) return;
    if ((b === 0 || b === 4) && m[4] === "M") {
      const now = Date.now();
      clicks = b === 0 && now - lastPress.t < 400 && y === lastPress.y && Math.abs(x - lastPress.x) <= 1 ? clicks + 1 : 1;
      lastPress = { x, y, t: now };
      const bh = clicks >= 2 ? boxHit(boxArea, x, y) : null; // N79: a double / triple click in the box selects a word / the whole line
      if (bh) { box.selectAt(bh.row, bh.col, clicks); sel = null; return render(); }
      sel = { x0: x, y0: y, x1: x, y1: y, dragging: false, clicks, mode: b === 4 && rowMeta[y] ? "item" : rowMeta[y] ? "text" : "plain" };
      return render();
    }
    if ((b === 32 || b === 36) && sel) { sel.x1 = x; sel.y1 = y; sel.dragging = true; return render(); }
    if ((b === 0 || b === 4) && m[4] === "m" && sel) {
      sel.x1 = x; sel.y1 = y;
      if ((sel.dragging || sel.mode === "item") && selRange()) { copy(selectedText()); return render(); } // highlight stays until the next key or click
      if (sel.clicks >= 2) return multiClick(Math.min(3, sel.clicks), x, y);
      sel = null;
      const lt = linkAt(x, y); // a plain click on a link / file path in the thread opens it
      if (lt) { if (openTarget(lt)) note = `opened ${lt.replace(process.env.HOME || "\0", "~")}`; return render(); }
      return render();
    }
    return;
  }
  if (d.startsWith("\x1b")) return; // any other Alt+key / unknown sequence: ignored, never quits
  if (!d.replace(/[\x00-\x1f]/g, "")) return;
  return insertText(d);
}
const MODES_OFF = `${ESC}?1004l${ESC}?2004l${ESC}?1002l${ESC}?1000l${ESC}?1006l${ESC}?1049l${ESC}?25h`;
function quit() { seen(); out(MODES_OFF); process.exit(0); }
// Focus out (or quitting): tell the daemon Angus last looked at this world's Thoughts window now.
function seen() { try { api?.call("thoughts.seen", { room }).catch(() => {}); } catch { /* offline */ } }
process.on("SIGTERM", quit);
process.stdout.on("resize", render);

// Restart when this panel's own code changes (a hyprpi update), so it is never stale.
import { spawn as spawnChild } from "node:child_process";
const CODE = [new URL("./search-tui.mjs", import.meta.url).pathname,
  ...["client.mjs", "paths.mjs", "search-view.mjs", "at-names.mjs", "tui/shimmer.mjs", "tui/input-box.mjs", "tui/command-line.mjs", "tui/agent-click.mjs", "tui/markdown.mjs", "thoughts-lines.mjs", "tui/new-pill.mjs", "held.mjs"].map((f) => new URL("../lib/" + f, import.meta.url).pathname)];
const codeStamp = () => CODE.map((f) => { try { return fs.statSync(f).mtimeMs; } catch { return 0; } }).join(",");
const codeAtStart = codeStamp();
setInterval(() => {
  if (restarting || codeStamp() === codeAtStart || EV.busy) return; // (a Thoughts reply keeps coming in the daemon: fine to restart)
  restarting = true;
  try { api?.close?.(); } catch { /* fine */ }
  out(MODES_OFF);
  // The launcher (mockups/search-tui) loops on exit 75: the state goes in its file and this
  // process ends, so restarts don't pile up processes (N19). Older windows: a child, as before.
  const sf = process.env.HYPRPI_SEARCH_TUI_STATEFILE;
  const place = TH.pinned && TH.anchor ? { ek: TH.anchor.ek, off: TH.anchor.off, unseen: TH.unseen, lastTs: TH.entries.at(-1)?.ts || 0 } : null; // J247: where he was reading
  if (sf) { try { fs.writeFileSync(sf, JSON.stringify({ query, qc, place })); } catch { /* start fresh */ } process.exit(75); }
  spawnChild(process.execPath, [CODE[0], room], { stdio: "inherit", env: process.env }).on("exit", (code) => process.exit(code ?? 0));
  process.stdin.setRawMode?.(false); process.stdin.pause();
}, 3000);
out(`${ESC}?1049h${ESC}?1000h${ESC}?1002h${ESC}?1006h${ESC}?2004h${ESC}?1004h`); // + focus in/out reports (/digest: since you last looked) // alt screen + mouse (wheel, click, drag-select) + bracketed paste
{ // after a restart onto new code: the same words in the box, the same mode
  const sf = process.env.HYPRPI_SEARCH_TUI_STATEFILE;
  try { const k = sf && JSON.parse(fs.readFileSync(sf, "utf8") || "null"); if (sf) fs.writeFileSync(sf, "");
    if (k) { query = String(k.query || ""); qc = Math.min(Number(k.qc) || 0, graphemes(query).length); if (k.place?.ek) TH.restore = k.place; } } catch { /* fresh */ }
}
box.restore(); // J194: an unsent draft from before a close / crash
render();
start();
