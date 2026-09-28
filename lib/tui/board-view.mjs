// The board view of the room panel (docs/board-plan.md): Ctrl+B toggles board ⇄ stream.
// An edited page, not a stream: a "Needs you" strip (every open Decide item on this world's
// board), then one card per project (not archived). "@project" alone + Enter expands that
// card, with WHO (members and what they are doing now) and recent CHANGES.
//
// room-tui.mjs keeps only hooks: it calls view.frame() to draw, view.input() for what is
// typed in board mode, view.complete() for Tab after "@project ", view.scroll() for the
// wheel / PgUp / PgDn, and view.refresh() on the daemon's "board" event.
//
// The box in board mode:
//   @p text          → the project's members, "update the card" (board.request where:board)
//   @p               → the combined view (card + who + changes); Esc goes back
//   @p D1 b          → answers decision D1 (board.item decide)
//   @p N2 ?          → asks the members to expand N2 on the card
//   @p N2 text       → a board request about N2
//   (while a card is open, "@p" may be left out: "D1 b", "N2 ?", "text")
//   /fold @p · /fold all · /unfold (/open) … · a click on a card's −/+ marker: fold / unfold
//   A bare handle (no @p) works anywhere: "D1 b", "N2 ?", /drop H3, /clarify D1 …: it resolves
//   to the open card's project, else to the one project on the board with that handle
//   (several = nothing changes, and the error says which @p to add).
//   /todo @p text · /note @p text (verbatim) · /done @p N2 [N3 …] [how verified] · /drop @p N2 [N3 …]
//   /new @name [title] [+@Agent…] · /assign @p +@A -@B · /rename @p @new · /writer @p @A
//   /pause @p · /archive @p · /activate @p · /refresh [@p] · /clarify @p D1 question · /help

import { ESC, dim, midFg, bold, fg, nameFg, graphemes, gw, width, cut, wrap, strip, theme, rgb } from "./term.mjs";
import { shimmer, createAnim } from "./shimmer.mjs";
import fs from "node:fs";
import path from "node:path";
import { stateDir } from "../paths.mjs";

// Folded cards (Angus: "click on the minus by the project, or another keyboard command, to
// close it"): a set of project ids, per machine, in ~/.local/state/hyprpi/board-folds.json
// (never on the board itself), so it survives the panel restarting on every code change.
const FOLDS_FILE = path.join(stateDir(), "board-folds.json");
function loadFolds() { try { const a = JSON.parse(fs.readFileSync(FOLDS_FILE, "utf8")); return new Set(Array.isArray(a) ? a : []); } catch { return new Set(); } }
function saveFolds(set) {
  try { fs.mkdirSync(path.dirname(FOLDS_FILE), { recursive: true }); fs.writeFileSync(FOLDS_FILE + ".tmp", JSON.stringify([...set])); fs.renameSync(FOLDS_FILE + ".tmp", FOLDS_FILE); } catch { /* fold stays for this run */ }
}

// "Thinking": after a request goes to a project's agents (board.request), the project is
// pending until its card changes by someone other than Angus (a change newer than the
// request); after WAIT_MS without one it shows a dim "no update yet". Quick board commands
// (/todo /done /drop, decide, "@p" alone "") shimmer only while their call is in flight.
const WAIT_MS = 10 * 60e3;
const HUMAN = "Angus";

export const BOARD_COMMANDS = [
  ["/todo", "/todo @p text: add a Next item, your words verbatim"],
  ["/note", "/note @p text: add a Heard item, verbatim"],
  ["/done", "/done N2 [N3 …] [how it was verified] (@p before the handles when several projects have one)"],
  ["/drop", "/drop N2 [N3 …] (or /drop @p N2 …)"],
  ["/new", "/new @name [title] [+@Agent …]: a new project (members optional)"],
  ["/assign", "/assign @p +@A -@B"],
  ["/writer", "/writer @p @A: hand the writer role to a member"],
  ["/rename", "/rename @p @new"],
  ["/pause", "/pause @p"],
  ["/archive", "/archive @p (hidden from the board)"],
  ["/activate", "/activate @p (back from paused / archived)"],
  ["/refresh", "/refresh [@p]: members reconcile the card with reality (all projects without @p)"],
  ["/clarify", "/clarify D1 question: ask the members about an item (or /clarify @p D1 …)"],
  ["/fold", "/fold @p · /fold all · /fold (the open card): the card as one line; + or /unfold opens it"],
  ["/unfold", "/unfold @p · /unfold all (also /open)"],
  ["/open", "/open @p: the same as /unfold"],
  ["/help", "this list"],
];
export const boardCompletions = (prefix) => BOARD_COMMANDS.map(([c]) => c).filter((c) => c.startsWith(prefix.toLowerCase()));

const SEC = { decide: "Decide", next: "Next", heard: "Heard", done: "Done" };
const LABEL_W = 7;   // "Decide " etc.
const HANDLE_W = 5;  // "D12  "
const ago = (ts) => {
  if (!ts) return "";
  const m = Math.max(0, Math.round((Date.now() - ts) / 60000));
  return m < 1 ? "now" : m < 60 ? `${m}m` : m < 2880 ? `${Math.round(m / 60)}h` : `${Math.round(m / 1440)}d`;
};
const hhmm = (ts) => { const d = new Date(ts); return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`; };
const STALE_MS = 3 * 86400e3; // an open item untouched this long is flagged
const DONE_SHOWN = 5;         // done items on a card (the combined view shows all)
const statusMark = (s) => s === "working" ? "●" : s === "blocked" ? "×" : s === "done" ? "✓" : s === "closed" ? "✗" : "○";
const norm = (s) => String(s || "").trim().replace(/^@/, "").toLowerCase();

// render: the panel's redraw (the shimmer's timer calls it while something is pending).
export function createBoardView({ render = () => {} } = {}) {
  const anim = createAnim(() => render());
  const pending = new Map(); // project id -> { since } (a request is out to its agents)
  let inflight = 0;          // quick board calls in flight
  const waiting = (id) => { const w = pending.get(id); return w && Date.now() - w.since < WAIT_MS ? "thinking" : w ? "stale" : ""; };
  const busy = () => inflight > 0 || [...pending.keys()].some((id) => waiting(id) === "thinking");
  let visible = false; // the board is on screen (the timer only runs then)
  const folds = loadFolds();
  function setFold(ids, on) { for (const id of ids) { if (on) folds.add(id); else folds.delete(id); } saveFolds(folds); }
  const st = {
    focus: null,   // project id shown expanded (the combined view), or null = the whole board
    top: 0,        // lines scrolled down from the top
    changes: [],   // board.changes for the focused project
    help: false,   // the command list at the top
    cur: null,     // the cursor: the key of the highlighted row's item (card:pid, it:pid:h, need:pid:h)
    keys: [],      // selectable keys in board order (the last frame)
    drops: [],     // drops made from this panel, for ^Z: [{ project, h }]
    hcycle: null,  // Tab state for item handles
    lastRows: 0, lastAvail: 10,
  };

  // ---- drawing -------------------------------------------------------------------------
  // ctx: { board: {room, projects, names, live}, room, W, avail, c (world colour), agents }
  // -> { rows: [{ line, msg, textX, hard, header }], items: [{ copy, key }], label }
  // Rows use the stream's row shape so selection and copying work unchanged.
  function frame(ctx) {
    const { W, avail, c } = ctx;
    visible = true; anim.sync(busy());
    const board = ctx.board || { projects: [], names: {}, live: {} };
    const agentOf = (id) => (ctx.agents || []).find((a) => a.id === id);
    const nameOf = (id) => board.names?.[id] || agentOf(id)?.display || id;
    const who = (id) => { const a = agentOf(id); const n = "@" + nameOf(id); return a ? nameFg(a.name, a.color, n) : bold(n); };
    const rows = [], items = [];
    const blank = () => rows.push({ line: "", msg: null });
    const item = (copy, key) => items.push({ copy, key }) - 1;
    // One paragraph of text at column x (1-based), wrapped; first line may have a lead-in.
    const para = (lead, text, x, mi, { meta = "", style = (s) => s, max = 0 } = {}) => {
      const tw = Math.max(10, W - x);
      let ls = [];
      for (const p of String(text).split("\n")) ls.push(...wrap(p, tw));
      if (max && ls.length > max) { ls = ls.slice(0, max); ls[max - 1] = cut(ls[max - 1] + " …", tw); }
      const indent = " ".repeat(x - 1);
      ls.forEach((l, i) => rows.push({ line: (i === 0 ? lead : indent) + style(l), msg: mi, textX: x, hard: i === ls.length - 1 }));
      if (meta) {
        const last = rows[rows.length - 1];
        if (width(strip(last.line)) + 2 + width(meta) <= W - 1) last.line += "  " + dim(meta);
        else rows.push({ line: indent + dim(meta), msg: mi, textX: x, hard: true });
      }
    };
    const secRule = (label, right = "") => {
      const l = ` ${label} `, r = right ? ` ${right} ` : "";
      return fg(c, "──" + bold(l) + "─".repeat(Math.max(2, W - 3 - width(l) - width(r)))) + dim(r);
    };
    const all = board.projects || [];
    const projects = all.filter((p) => p.status !== "archived");
    const focused = st.focus ? all.find((p) => p.id === st.focus) : null;
    // (a focus the board doesn't have yet, e.g. just created, stays until the refetch lands)

    if (st.help) {
      rows.push({ line: secRule("board commands", "/help again hides this"), msg: null });
      const w = Math.max(...BOARD_COMMANDS.map(([k]) => k.length));
      for (const [k, d] of BOARD_COMMANDS) rows.push({ line: `   ${bold(k.padEnd(w))}  ${d}`, msg: null });
      for (const [k, d] of [["@p text", "to the project's members: update the card"], ["@p", "alone: the card expanded + who + recent changes (Esc back)"],
        ["D1 b", "answer decision D1 with option b (or any words); @p D1 b if several projects have a D1"], ["N2 ?", "ask for more detail on N2, written into the card (N2 text: say something about it)"]])
        rows.push({ line: `   ${bold(k.padEnd(w))}  ${dim(d)}`, msg: null });
      rows.push({ line: `   ${dim("cursor: ↑↓ (empty box) or ^↑↓ · Space folds / opens a card · ⏎ opens it (or puts \"@p N6 \" in the box) · ^D drop · ^T done · ^Z undo a drop · Esc")}`, msg: null });
      rows.push({ line: `   ${dim("Tab completes @projects, @agents and item handles after \"@p \" · ^B back to the stream · wheel / PgUp PgDn / ^↑↓ scroll")}`, msg: null });
      blank();
    }

    // Needs you: every open decide item on the board (all projects, even when one is open).
    const open = [];
    for (const p of projects) for (const it of p.items || []) if (it.sec === "decide") open.push({ p, it });
    rows.push({ line: secRule(open.length ? `Needs you · ${open.length}` : "Needs you", open.length ? "answer: D1 b" : ""), msg: null, header: true });
    if (!open.length) rows.push({ line: "   " + dim("nothing waiting on you ✓"), msg: null });
    for (const { p, it } of open) {
      const mi = item(`@${p.name} ${it.h} ${it.text}${optText(it)}`, `need:${p.id}:${it.h}`);
      const lead = `   ${fg(c, bold("@" + p.name))} ${fg(c, bold(it.h))}  `;
      para(lead, it.text, width(strip(lead)) + 1, mi, { meta: `${it.by?.name || "?"} ${ago(it.updated || it.ts)}` });
      optionRows(it, width(strip(lead)) + 1, mi);
    }

    if (focused) {
      blank();
      card(focused, true);
      // WHO: each member, its live status and what it is doing now.
      blank();
      rows.push({ line: secRule("Who"), msg: null, header: true });
      if (!focused.members.length) rows.push({ line: "   " + dim("⚠ nobody on it · /assign @" + focused.name + " +@Name"), msg: null });
      for (const id of focused.members) {
        const a = agentOf(id), s = board.live?.[id] || (a ? a.status : "closed");
        const topic = a?.topic ? "  " + midFg(`${ESC}3m${a.topic}${ESC}23m`) : "";
        const mi = item(`@${nameOf(id)} ${s}${a?.topic ? " · " + a.topic : ""}`, `who:${id}`);
        rows.push({ line: `   ${statusMark(s)} ${a?.icon ? a.icon + " " : ""}${who(id)}${id === focused.writer ? dim(" (writer)") : ""}  ${dim(s)}${topic}`, msg: mi, textX: 6, hard: true });
      }
      blank();
      rows.push({ line: secRule("Changes", "newest first"), msg: null, header: true });
      const ch = st.changes || [];
      if (!ch.length) rows.push({ line: "   " + dim("(none yet)"), msg: null });
      for (const x of ch) {
        const lead = `   ${dim(hhmm(x.ts))} ${bold(x.by || "?")} ${midFg(x.op)}${x.h ? " " + fg(c, x.h) : ""}  `;
        const mi = item(`${hhmm(x.ts)} ${x.by || "?"} ${x.op}${x.h ? " " + x.h : ""}: ${x.text || ""}`, `ch:${x.ts}:${x.op}:${x.h || ""}`);
        para(lead, x.text || "", Math.min(W - 20, width(strip(lead)) + 1), mi, { max: 3, style: dim });
      }
    } else {
      if (!projects.length) { blank(); rows.push({ line: "   " + dim("no projects on board " + (board.room || ctx.room) + " yet · /new @name [title] [+@Agent …]"), msg: null }); }
      for (const p of projects) { blank(); card(p, false); }
    }

    // The cursor (↑↓ with an empty box, ^↑↓, a click): project headers and items, like search's
    // selected result. Kept in view; its rows get the selection background.
    st.keys = items.map((x) => x.key).filter(selectable);
    // A cursor not on the board (yet: a restore still loading; or folded away) is kept, unshown.
    st.curShown = !!st.cur && st.keys.includes(st.cur);
    const ci = st.cur ? items.findIndex((x) => x.key === st.cur) : -1;
    if (ci >= 0) {
      const r0 = rows.findIndex((r) => r.msg === ci), r1 = rows.findLastIndex((r) => r.msg === ci);
      if (st.moved) { if (r0 < st.top) st.top = r0; else if (r1 >= st.top + avail) st.top = r1 - avail + 1; st.moved = false; }
      for (const r of rows) if (r.msg === ci) r.line = paintBg(r.line, W);
    }

    // Scroll (from the top) and pad to the pane.
    st.lastRows = rows.length; st.lastAvail = avail;
    st.top = Math.max(0, Math.min(st.top, rows.length - avail));
    const shown = rows.slice(st.top, st.top + avail);
    while (shown.length < avail) shown.push({ line: "", msg: null });
    const below = rows.length - st.top - avail;
    const label = `board ${board.room || ctx.room}${focused ? ` · @${focused.name} (Esc: whole board)` : ` · ${projects.length} project${projects.length === 1 ? "" : "s"}`}`
      + (st.top > 0 ? ` · ↑ ${st.top} above` : "") + (below > 0 ? ` · ↓ ${below} below` : "") + " (^B stream)";
    return { rows: shown, items, label };

    // ---- a card -------------------------------------------------------------------------
    function card(p, full) {
      const badge = p.status === "new" ? " " + inverse(" new ") : p.status === "paused" ? " " + inverse(" paused ") : p.status === "archived" ? " " + inverse(" archived ") : "";
      const warn = p.members.length ? "" : " " + `${ESC}31m⚠ nobody on it${ESC}39m`;
      const w = waiting(p.id);
      const think = w === "thinking" ? " " + shimmer("thinking\u2026", c, pending.get(p.id).since) : w === "stale" ? " " + dim("no update yet") : "";
      // The marker in column 1: "−" open, "+" folded; a click on it (or /fold /unfold) toggles.
      // The combined view ("@p" alone) always shows the card open (its marker folds it and goes back).
      const folded = !full && folds.has(p.id);
      const marker = fg(c, bold(folded ? "+" : "\u2212"));
      const hi = item(`@${p.name}${p.title ? " — " + p.title : ""}`, `card:${p.id}`);
      if (folded) { // one line: marker, @name, badges, thinking…, counts (decisions stay visible)
        const n = (sec) => (p.items || []).filter((it) => it.sec === sec).length;
        // "D1 · N4 · H2" (open decide / next / heard); D in the world colour so decisions stand out.
        const counts = [["D", n("decide")], ["N", n("next")], ["H", n("heard")]].filter(([, k]) => k).map(([l, k]) => l === "D" ? fg(c, bold(`D${k}`)) : dim(`${l}${k}`)).join(dim(" · "));
        const line = `${marker} 📋 ${fg(c, bold("@" + p.name))}${think}${badge}${warn}  ` + (counts || dim("empty"));
        const room = W - 3 - width(strip(line));
        rows.push({ line: line + (p.title && room > 8 ? dim("  " + cut(p.title, room)) : ""), msg: hi, textX: 3, header: true, fold: p.id });
        return;
      }
      const head = ` 📋 ${bold("@" + p.name)}${think}${badge}${warn} `;
      const right = ` updated ${ago(p.updated)}${p.lastBy ? " by " + p.lastBy : ""}`;
      const fill = Math.max(2, W - 2 - width(strip(head)) - width(right));
      rows.push({ line: marker + fg(c, head) + fg(c, "━".repeat(fill)) + dim(right), msg: hi, textX: 3, header: true, fold: p.id });
      if (p.title) para("  ", p.title, 3, hi, { style: bold });
      const people = `writer ${p.writer ? who(p.writer) : dim("none")} · members ${p.members.map((id) => statusMark(board.live?.[id]) + " " + who(id)).join("  ") || dim("none")}`;
      rows.push({ line: "  " + people, msg: hi, textX: 3, hard: true });
      const labelled = (label, first) => `  ${first ? fg(c, bold(label.padEnd(LABEL_W))) : " ".repeat(LABEL_W)} `;
      const X = 3 + LABEL_W + 1; // text column for Where / Step
      if (p.where?.text) { const mi = item(`@${p.name} where: ${p.where.text}`, `where:${p.id}`); para(labelled("Where", true), p.where.text, X, mi, { meta: `${p.where.by || "?"} ${ago(p.where.ts)}`, max: full ? 0 : 3 }); }
      else rows.push({ line: labelled("Where", true) + dim("(not written yet)"), msg: null });
      for (const sec of ["decide", "next", "heard", "done"]) {
        let its = (p.items || []).filter((it) => it.sec === sec);
        if (sec === "heard") its = its.sort((x, y) => (y.prio || 0) - (x.prio || 0) || x.ts - y.ts);
        let more = 0;
        if (sec === "done") { its = its.sort((x, y) => (x.updated || x.ts) - (y.updated || y.ts)); if (!full && its.length > DONE_SHOWN) { more = its.length - DONE_SHOWN; its = its.slice(-DONE_SHOWN); } }
        its.forEach((it, i) => {
          const hx = 3 + LABEL_W + 1, tx = hx + HANDLE_W + (sec === "done" ? 2 : 0);
          const h = sec === "done" ? fg(c, "✓ ") + fg(c, bold(it.h.padEnd(HANDLE_W))) : fg(c, bold(it.h.padEnd(HANDLE_W)));
          const pr = sec === "heard" && it.prio ? dim(`[${it.prio}] `) : "";
          const stale = sec !== "done" && Date.now() - (it.updated || it.ts) > STALE_MS ? " · stale" : "";
          const mi = item(`@${p.name} ${it.h} ${it.text}${optText(it)}${it.resolution ? " → decided: " + it.resolution : ""}${it.verified ? " ✓ verified: " + it.verified : ""}`, `it:${p.id}:${it.h}`);
          para(labelled(SEC[sec], i === 0) + h + pr, it.text, tx + width(strip(pr)), mi, { meta: `${it.by?.name || "?"} ${ago(it.updated || it.ts)}${stale}`, max: full ? 0 : 4 });
          if (sec === "decide") optionRows(it, tx, mi);
          if (it.resolution) para(" ".repeat(tx - 1) + dim("→ decided: "), it.resolution, tx + 11, mi, { style: dim, max: full ? 0 : 2 });
          if (it.verified) para(" ".repeat(tx - 1) + dim("verified: "), it.verified, tx + 10, mi, { style: dim, max: full ? 0 : 2 });
        });
        if (more) rows.push({ line: " ".repeat(3 + LABEL_W) + dim(`… ${more} earlier (@${p.name} shows all)`), msg: null });
      }
      if (p.next_step?.text) { const mi = item(`@${p.name} next step: ${p.next_step.text}`, `step:${p.id}`); para(labelled("Step", true) + dim("▸ "), p.next_step.text, X + 2, mi, { meta: `${p.next_step.by || "?"} ${ago(p.next_step.ts)}`, max: full ? 0 : 3 }); }
    }
    function optionRows(it, x, mi) {
      for (const o of it.options || []) {
        const rec = o.key === it.recommend ? "  " + fg(c, "★ recommended") : "";
        para(" ".repeat(x - 1) + fg(c, bold(o.key + ")")) + " ", o.text + (o.key === it.default ? " (default)" : ""), x + 3, mi, { style: (s) => s });
        if (rec) rows[rows.length - 1].line += rec;
      }
      if (it.default && !(it.options || []).some((o) => o.key === it.default)) rows.push({ line: " ".repeat(x - 1) + dim(`default: ${it.default}`), msg: mi, textX: x, hard: true });
    }
  }
  const selectable = (k) => /^(card|it|need):/.test(k || "");
  // The whole row on the selection background (kept across the line's own colour resets).
  function paintBg(line, W) {
    const bg = theme.muted || theme.selection;
    const on = bg ? `${ESC}48;2;${rgb(bg)}m` : `${ESC}7m`, off = bg ? `${ESC}49m` : `${ESC}27m`;
    const body = line.replace(/\x1b\[(?:0|49|27)?m/g, (m) => m + on);
    return on + body + " ".repeat(Math.max(0, W - width(strip(line)))) + off;
  }
  const inverse = (s) => theme.selection ? `${ESC}48;2;${rgb(theme.selection)}m${s}${ESC}49m` : `${ESC}7m${s}${ESC}27m`;
  const optText = (it) => it.options?.length ? " — " + it.options.map((o) => `${o.key}) ${o.text}${o.key === it.recommend ? " (recommended)" : ""}`).join(" · ") + (it.default ? ` · default ${it.default}` : "") : "";

  // ---- scrolling -----------------------------------------------------------------------
  // n > 0 = up (towards the top), as in the stream; ±Infinity = top / bottom.
  function scroll(n) {
    if (n === Infinity) st.top = 0;
    else if (n === -Infinity) st.top = 1e9;
    else st.top = Math.max(0, st.top - n);
  }
  const page = () => Math.max(1, st.lastAvail - 2);

  // Changes for the open card (the daemon's "board" event also lands here).
  // Pending projects whose card changed by someone else since the request: done waiting.
  async function settle(api, room, projects) {
    for (const [id, w] of pending) {
      const p = (projects || []).find((x) => x.id === id);
      if (!p) continue; // another world's board, or not loaded yet
      if (!(p.updated > w.since)) continue; // nothing new on it at all
      try {
        const ch = (await api.call("board.changes", { room, project: id, limit: 20 })).changes || [];
        if (ch.some((x) => x.ts > w.since && x.by && x.by !== HUMAN) && pending.get(id) === w) pending.delete(id);
      } catch { /* keep waiting */ }
    }
  }
  async function refresh(api, room, board) {
    if (api && pending.size && board) await settle(api, room, board.projects);
    anim.sync(visible && busy());
    if (!api || !st.focus) return;
    try { st.changes = (await api.call("board.changes", { room, project: st.focus, limit: 30 })).changes || []; } catch { st.changes = []; }
  }
  function focus(id) { st.focus = id; st.top = 0; st.changes = []; }

  // ---- what is typed in board mode -----------------------------------------------------
  // ctx: { api, room, board } -> { note, focus?, keep? (put the text back) }. Throws on errors
  // (room-tui puts the text back and shows ✗ message).
  async function input(text, { api, room, board }) {
    const t = String(text || "").trim();
    if (!t) return { note: "" };
    if (!api) throw new Error("daemon offline");
    const projects = board?.projects || [];
    const proj = (ref, { any = false } = {}) => {
      const k = norm(ref);
      const p = projects.find((x) => (any || x.status !== "archived") && (x.id === k || x.name === k));
      if (!p) throw new Error(`no project @${k} on board ${room}${k ? "" : " (@name)"}`);
      return p;
    };
    const itemOf = (p, h) => (p.items || []).find((x) => x.h.toLowerCase() === String(h).toLowerCase());
    const openP = st.focus && projects.find((x) => x.id === st.focus);
    // A bare handle (no @p): handles are unique only within a project, so it resolves to the
    // open card's project if that has it, else to the one project on this board that has it.
    // usage(p, H) = how to say it with @p, for the error when several projects have it.
    const isHandle = (w) => /^[dnh]\d+$/i.test(String(w || ""));
    const locate = (h, usage) => {
      if (openP && itemOf(openP, h)) return openP;
      const hits = projects.filter((x) => x.status !== "archived" && itemOf(x, h)), H = String(h).toUpperCase();
      if (hits.length === 1) return hits[0];
      if (!hits.length) throw new Error(`no item ${H} on this board`);
      throw new Error(`${H} is on ${hits.map((x) => "@" + x.name).join(" and ")}: ${usage(hits[0], H)}`);
    };
    const call = async (m, p) => {
      if (m === "board.request") { // out to the agents: pending until the card changes
        const since = Date.now(), r = await api.call(m, { room, ...p });
        pending.set(p.project, { since }); anim.sync(visible && busy()); render();
        return r;
      }
      inflight++; anim.sync(visible);
      try { return await api.call(m, { room, ...p }); } finally { inflight--; anim.sync(visible && busy()); }
    };
    const told = (r) => r?.told?.length ? r.told.join(", ") : "nobody live";

    // Commands.
    const cm = /^\/([a-z]+)(?:\s+([\s\S]*))?$/i.exec(t);
    if (cm && !t.startsWith("//")) {
      const cmd = cm[1].toLowerCase();
      let arg = (cm[2] || "").trim();
      // A card is open: its commands may leave out "@p". (/done /drop /clarify take bare handles
      // anywhere: they resolve per handle, the open card first.)
      if (openP && !arg.startsWith("@") && ["todo", "note", "assign", "writer", "pause", "archive", "activate", "refresh"].includes(cmd)) arg = `@${openP.name} ${arg}`.trim();
      const [p0, ...rest] = arg.split(/\s+/);
      const restText = arg.slice((p0 || "").length).trim();
      const needP = () => { if (!p0 || !p0.startsWith("@")) throw new Error(`/${cmd} needs @project first`); return p0; };
      switch (cmd) {
        case "fold": case "unfold": case "open": { // /fold @p · /fold all · /fold (open card, or the only project)
          const on = cmd === "fold", live = projects.filter((x) => x.status !== "archived");
          let ps;
          if (/^all$/i.test(p0 || "")) ps = live;
          else if (p0) ps = [proj(p0)];
          else if (openP) ps = [openP];
          else if (live.length === 1) ps = live;
          else throw new Error(`/${cmd} @project (or /${cmd} all)`);
          setFold(ps.map((x) => x.id), on);
          if (on && openP && ps.includes(openP)) st.focus = null; // folding the open card: back to the board
          return { note: `${ps.length === live.length && ps.length > 1 ? "all cards" : ps.map((x) => "@" + x.name).join(" ")} ${on ? "folded (+ or /unfold opens)" : "open"}` };
        }
        case "help": st.help = !st.help; st.top = 0; return { note: st.help ? "board commands at the top · /help again hides them" : "" };
        case "todo": case "note": {
          const p = proj(needP());
          if (!restText) throw new Error(`/${cmd} @${p.name} what to write`);
          const r = await call("board.item", { action: "add", project: p.id, section: cmd === "todo" ? "next" : "heard", text: restText });
          return { note: `@${p.name} ${r.item.h} added (${cmd === "todo" ? "next" : "heard"})` };
        }
        case "done": case "drop": { // several handles at once: /drop @p N1 N2 N3 (commas fine), or bare: /drop H3 N1
          const bare = !arg.startsWith("@"), p = bare ? null : proj(p0);
          const words = (bare ? arg : rest.join(" ")).split(/[\s,]+/).filter(Boolean);
          let k = 0; while (k < words.length && /^[a-z✓]?\d+$/i.test(words[k].replace(/^✓/, ""))) k++;
          const hs = words.slice(0, k).map((w) => w.replace(/^✓/, ""));
          if (!hs.length) throw new Error(`/${cmd} N2 [N3 …] or /${cmd} @project N2 …`);
          // Resolve every handle first: any problem = nothing changes.
          const errs = [], todo = [];
          for (const h of hs) {
            try {
              const q = p || locate(h, (x, H) => `/${cmd} @${x.name} ${H}`);
              const it = itemOf(q, h);
              if (!it) throw new Error(`no item ${h.toUpperCase()} on @${q.name}`);
              todo.push({ q, it });
            } catch (e) { errs.push(e.message); }
          }
          if (errs.length) throw new Error(errs.join(" · ") + " (nothing changed)");
          const verified = words.slice(k).join(" ");
          for (const { q, it } of todo) {
            if (cmd === "done") await call("board.item", { action: "done", project: q.id, h: it.h, verified: verified || "marked done by Angus" });
            else await call("board.item", { action: "drop", project: q.id, h: it.h });
          }
          const byP = new Map(); for (const { q, it } of todo) byP.set(q.name, [...(byP.get(q.name) || []), it.h]);
          return { note: [...byP].map(([n, h]) => `@${n} ${h.join(" ")}`).join(" · ") + ` ${cmd === "done" ? "done ✓" : "dropped"}` };
        }
        case "new": {
          const name = needP().replace(/^@/, "");
          const members = rest.filter((w) => /^\+?@/.test(w)).map((w) => w.replace(/^\+?@/, ""));
          const title = rest.filter((w) => !/^\+?@/.test(w)).join(" ");
          const r = await call("board.project", { action: "create", name, title, members });
          focus(r.id);
          return { note: `@${r.name} created${members.length ? " · members " + members.map((m) => "@" + m).join(" ") : " · ⚠ nobody on it yet (/assign)"}`, focus: r.id };
        }
        case "assign": {
          const p = proj(needP(), { any: true });
          if (!rest.length) throw new Error(`/assign @${p.name} +@Name -@Name`);
          await call("board.project", { action: "assign", project: p.id, members: rest.join(" ") });
          return { note: `@${p.name}: ${rest.join(" ")}` };
        }
        case "writer": {
          const p = proj(needP(), { any: true }), w = norm(rest[0]);
          const id = p.members.find((m) => m === w || norm(board.names?.[m]) === w);
          if (!id) throw new Error(`the writer must be a member of @${p.name}`);
          await call("board.project", { action: "update", project: p.id, writer: id });
          return { note: `@${p.name}: writer @${board.names?.[id] || id}` };
        }
        case "rename": {
          const p = proj(needP(), { any: true });
          if (!rest[0]) throw new Error(`/rename @${p.name} @new-name`);
          const r = await call("board.project", { action: "update", project: p.id, name: rest[0].replace(/^@/, "") });
          return { note: `@${p.name} → @${r.name}` };
        }
        case "pause": case "archive": case "activate": {
          const p = proj(needP(), { any: true });
          const status = cmd === "pause" ? "paused" : cmd === "archive" ? "archived" : "active";
          await call("board.project", { action: "update", project: p.id, status });
          if (status === "archived" && st.focus === p.id) st.focus = null;
          return { note: `@${p.name} ${status}` };
        }
        case "refresh": {
          const ps = p0 ? [proj(p0)] : projects.filter((x) => x.status !== "archived" && x.members.length);
          const said = [];
          for (const p of ps) {
            try { const r = await call("board.request", { project: p.id, where: "board", text: "Refresh the card: reconcile it with reality (what is actually done, in progress, decided and next). Drop what's stale, mark what's finished done with how it was verified, and set Where and the next first step." }); said.push(`@${p.name} → ${told(r)}`); }
            catch (e) { said.push(`@${p.name} ✗ ${e.message}`); }
          }
          return { note: said.length ? "refresh: " + said.join(" · ") : "nothing to refresh (no projects with members)" };
        }
        case "clarify": { // /clarify @p D1 question, or bare: /clarify D1 question
          const bare = !arg.startsWith("@"), h = bare ? p0 : rest[0];
          if (bare && !isHandle(h)) throw new Error("/clarify D1 your question (or /clarify @project D1 …)");
          const p = bare ? locate(h, (x, H) => `/clarify @${x.name} ${H} …`) : proj(p0), it = h && itemOf(p, h);
          if (!it) throw new Error(`/clarify @${p.name} D1 your question`);
          const q = (bare ? rest : rest.slice(1)).join(" ");
          if (!q) throw new Error(`/clarify @${p.name} ${it.h} what you want to know`);
          const r = await call("board.request", { project: p.id, where: "board", text: `About ${it.h} ("${it.text}"): ${q}\nAnswer on the card (edit ${it.h} or add to it).` });
          return { note: `@${p.name} ${it.h}? → ${told(r)}` };
        }
      }
      return null; // not a board command: room-tui tries its own
    }

    // "@p …", or (a card open) the same without "@p".
    let m = /^@(\S+)(?:\s+([\s\S]*))?$/.exec(t), p, body;
    if (m) {
      const k = norm(m[1]);
      p = projects.find((x) => x.status !== "archived" && (x.id === k || x.name === k));
      if (!p) {
        if (!projects.some((x) => x.name === k)) throw new Error(`no project @${k} on board ${room} · in board mode @ means a project (^B: the stream, for @agents)`);
        p = proj(k, { any: true });
      }
      body = (m[2] || "").trim();
      if (!body) { focus(p.id); await refresh(api, room); return { note: "", focus: p.id }; }
    } else {
      // No @p: a leading handle resolves on the board (open card first); other text goes
      // to the open card's project.
      body = t.replace(/^\/\//, "/");
      const h0 = /^([dnh]\d+)(?=\s|$)/i.exec(body)?.[1];
      const rest0 = body.slice(h0 ? h0.length : 0).trim();
      if (h0 && (!openP || projects.some((x) => x.status !== "archived" && itemOf(x, h0)))) p = locate(h0, (x, H) => `@${x.name} ${H}${rest0 ? " " + rest0 : ""}`);
      else if (openP) p = openP;
      else throw new Error("board mode: start with @project or an item handle (D1 b, N2 ?) · Tab completes · /help · ^B for the stream");
    }

    const hm = /^([dnh]\d+)(?:\s+([\s\S]*))?$/i.exec(body);
    const it = hm && itemOf(p, hm[1]);
    if (it) {
      const rest = (hm[2] || "").trim();
      if (!rest || rest === "?") {
        const r = await call("board.request", { project: p.id, where: "board", text: `More detail on ${it.h} ("${it.text}"), please: expand it on the card (edit ${it.h}), briefly.` });
        return { note: `@${p.name} ${it.h}? → ${told(r)}` };
      }
      if (it.sec === "decide") {
        const r = await call("board.item", { action: "decide", project: p.id, h: it.h, answer: rest });
        return { note: `@${p.name} ${it.h} decided: ${r.item?.resolution || rest}${r.told?.length ? " → " + r.told.join(", ") : ""}` };
      }
      const r = await call("board.request", { project: p.id, where: "board", text: `About ${it.h} ("${it.text}"): ${rest}` });
      return { note: `@${p.name} ${it.h} → ${told(r)}` };
    }
    const r = await call("board.request", { project: p.id, where: "board", text: body });
    return { note: `@${p.name} (board) → ${told(r)}${r.writer ? " · writer @" + r.writer : ""}` };
  }

  // ---- Tab: item handles after "@p " (also "/done @p ", "/drop @p ", "/clarify @p ") ------
  // -> { text, cursor, options, pick } or null (not after "@p ").
  function complete(text, at, board, dir = 1) {
    const s = st.hcycle;
    if (s && s.text === text && s.at === at && s.options.length > 1) {
      const n = s.options.length, i = (s.i + dir + n) % n, pick = s.options[i];
      const out = text.slice(0, s.start) + pick + text.slice(at), cursor = s.start + pick.length;
      st.hcycle = { ...s, i, text: out, at: cursor };
      return { text: out, cursor, options: s.options, pick, hint: hintOf(s.options, pick, s.where) };
    }
    st.hcycle = null;
    const before = text.slice(0, at);
    // /done and /drop take several handles: "/drop @p N1 N2 N" completes the third.
    const m = /(?:^|^\/(done|drop|clarify)\s+)@(\S+)\s+((?:[a-z]\d+[\s,]+)*)([A-Za-z]?\d*)$/i.exec(before);
    if (m && m[3] && !/^(done|drop)$/i.test(m[1] || "")) return null; // only /done /drop take more than one
    const all = (board?.projects || []).filter((x) => x.status !== "archived");
    const openP = st.focus && all.find((x) => x.id === st.focus);
    let pool, part, cmd, typedStr = "";
    if (m) { const p = all.find((x) => x.name === norm(m[2]) || x.id === norm(m[2])); pool = p ? [p] : []; part = m[4]; typedStr = m[3]; cmd = (m[1] || "").toLowerCase(); }
    else {
      // Bare handles (no @p): "N", "D1 ", "/drop H", "/drop N1 N", "/clarify D" \u2014 the whole
      // board, the open card's items first. An empty word completes only inside an open card.
      const b = /^(?:\/(done|drop|clarify)\s+)?((?:[a-z]\d+[\s,]+)*)([A-Za-z]?\d*)$/i.exec(before);
      if (!b) return null;
      cmd = (b[1] || "").toLowerCase(); typedStr = b[2]; part = b[3];
      if (b[2] && !/^(done|drop)$/.test(cmd)) return null;
      if (!cmd && !b[2] && !part && !openP) return null;
      if (part && !/^[dnh]/i.test(part)) return null;
      pool = openP ? [openP, ...all.filter((x) => x !== openP)] : all;
      if (openP && !cmd && !b[2]) pool = [openP]; // "D1 b" inside a card: that card's items
    }
    if (!pool.length) return null;
    const typed = new Set(String(typedStr || "").toLowerCase().split(/[\s,]+/).filter(Boolean));
    const where = {}; // handle -> [@project] (several projects can share a handle)
    for (const p of pool) for (const it of p.items || []) {
      if (cmd !== "drop" && it.sec === "done") continue;
      if (typed.has(it.h.toLowerCase()) || !it.h.toLowerCase().startsWith(part.toLowerCase())) continue;
      (where[it.h] ||= []).push(p.name);
    }
    const options = Object.keys(where);
    const start = before.length - part.length, after = text.slice(at);
    const multi = pool.length > 1 ? where : null; // show @project only when it isn't obvious
    if (!options.length) return { text, cursor: at, options, hint: "no open item by that handle" };
    if (options.length === 1) {
      const ins = options[0] + (after.startsWith(" ") ? "" : " ");
      return { text: text.slice(0, start) + ins + after, cursor: start + ins.length, options, pick: options[0], hint: hintOf(options, options[0], multi, pool) };
    }
    const pick = options[0], out = text.slice(0, start) + pick + after, cursor = start + pick.length;
    st.hcycle = { options, start, i: 0, text: out, at: cursor, where: multi };
    return { text: out, cursor, options, pick, hint: hintOf(options, pick, multi) };
  }
  // "\u25b8N1 @boards @hyprpi  H3 @boards" (several) or the item's text (one).
  function hintOf(options, pick, where, pool) {
    const tag = (h) => where?.[h] ? " " + where[h].map((n) => "@" + n).join(" ") : "";
    if (options.length === 1) {
      const ps = pool || [];
      const it = ps.map((p) => (p.items || []).find((x) => x.h === pick)).find(Boolean);
      return (where?.[pick]?.length > 1 ? `${pick} is on${tag(pick)}: add @project \u00b7 ` : where ? `${pick}${tag(pick)} \u00b7 ` : "") + (it ? it.text : "");
    }
    return options.map((o) => (o === pick ? "\u25b8" : "") + o + tag(o)).join("  ");
  }
  // A handle's item text (for the hint under the box while Tab cycles).
  const itemText = (board, h) => { for (const p of board?.projects || []) { const it = (p.items || []).find((x) => x.h === h && (!st.focus || p.id === st.focus)); if (it) return it.text; } return ""; };

  // The line under the box: the shimmer while anything is in flight or pending ("" = idle).
  function status(c) {
    if (inflight) return shimmer("working\u2026", c);
    const ids = [...pending.keys()].filter((id) => waiting(id) === "thinking");
    if (!ids.length) return "";
    return shimmer("thinking\u2026", c, Math.min(...ids.map((id) => pending.get(id).since)));
  }
  // ---- the cursor ----------------------------------------------------------------------
  // What the cursor is on: { kind: "card" | "item", project, h }.
  const cursorAt = () => !st.curShown ? null : cursorAtRaw();
  const cursorAtRaw = () => { const m = /^(card|it|need):([^:]+)(?::(.+))?$/.exec(st.cur || ""); return m ? { kind: m[1] === "card" ? "card" : "item", project: m[2], h: m[3] || "" } : null; };
  function move(d) {
    const ks = st.keys; if (!ks.length) return;
    let i = ks.indexOf(st.cur);
    i = i < 0 ? (d > 0 ? 0 : ks.length - 1) : Math.max(0, Math.min(ks.length - 1, i + d));
    st.cur = ks[i]; st.moved = true;
  }
  // A click on a row: the cursor goes to its item (if it is a header or an item).
  function pick(row, items) { const k = row && row.msg != null && items?.[row.msg]?.key; if (selectable(k)) { st.cur = k; return true; } return false; }
  // Keys in board mode. ctx: { empty (the box is empty), api, room, board }. Returns false (not
  // ours), true (handled, redraw) or a promise of { note?, input? } (room-tui applies it).
  function key(d, { empty, api, room, board }) {
    const up = d === "\x1b[A" || d === "\x1b[1;5A", down = d === "\x1b[B" || d === "\x1b[1;5B";
    if ((up || down) && (empty || d.includes(";5"))) { move(up ? -1 : 1); return true; }
    if (d === "\x1b" && st.cur) { st.cur = null; return true; } // Esc: the cursor first
    if (d === "\x1a") return undo(api, room);                      // ^Z: undo the last drop
    const at = cursorAt(); if (!at) return false;
    const p = (board?.projects || []).find((x) => x.id === at.project); if (!p) return false;
    if (at.kind === "card" && empty) {
      if (d === " ") { setFold([p.id], !folds.has(p.id) || st.focus === p.id); if (st.focus === p.id) st.focus = null; return true; }
      if (d === "\r") { focus(p.id); st.cur = `card:${p.id}`; return refresh(api, room).then(() => ({ note: "" })); }
    }
    if (at.kind === "item") {
      const it = (p.items || []).find((x) => x.h === at.h); if (!it) return false;
      if (d === "\r" && empty) return Promise.resolve({ input: st.focus === p.id ? `${it.h} ` : `@${p.name} ${it.h} `, note: it.text });
      const call = async (m, q) => { inflight++; anim.sync(visible); try { return await api.call(m, { room, ...q }); } finally { inflight--; anim.sync(visible && busy()); } };
      if (d === "\x04") { // ^D: drop
        return call("board.item", { action: "drop", project: p.id, h: it.h }).then(() => { st.drops.push({ project: p.id, h: it.h, name: p.name }); moveOff(); return { note: `dropped @${p.name} ${it.h} · ^Z undo` }; });
      }
      if (d === "\x14") { // ^T: done (an item already done: say so, change nothing)
        if (it.sec === "done") return Promise.reject(new Error(`@${p.name} ${it.h} is already done`));
        return call("board.item", { action: "done", project: p.id, h: it.h, verified: "marked done by Angus" }).then(() => ({ note: `@${p.name} ${it.h} done ✓` }));
      }
    }
    return false;
    // After a drop the item is gone: keep the cursor near it (the next item, else the previous).
    function moveOff() { const ks = st.keys, i = ks.indexOf(st.cur); st.cur = ks[i + 1] || ks[i - 1] || null; }
  }
  // The hint under the box while the cursor is on something.
  function cursorHint() {
    const at = cursorAt(); if (!at) return "";
    return at.kind === "card" ? "Space fold / open · ⏎ open the card · ↑↓ move · Esc" : `⏎ ${at.h} … (answer, ?, text) · ^D drop · ^T done · ^Z undo drop · ↑↓ move · Esc`;
  }
  async function undo(api, room) {
    const last = st.drops.pop();
    if (!last) return { note: "nothing to undo (^Z undoes drops made here)" };
    try { await api.call("board.item", { room, action: "restore", project: last.project, h: last.h }); }
    catch (e) { st.drops.push(last); throw e; }
    st.cur = `it:${last.project}:${last.h}`; st.moved = true;
    return { note: `restored @${last.name} ${last.h}` };
  }

  // A left click on a card header's marker (the first two cells): fold / unfold. true = handled.
  function click(row, x) {
    if (!row?.fold || x > 2) return false;
    const on = !folds.has(row.fold) || st.focus === row.fold; // in the combined view it shows open: fold
    setFold([row.fold], on);
    if (on && st.focus === row.fold) st.focus = null;
    return true;
  }
  // The panel shows the board (frame) or not (hide): the timer only runs while it is seen.
  function hide() { visible = false; anim.sync(false); }

  return { st, frame, scroll, page, refresh, focus, input, complete, itemText, status, hide, click, folds, pending, key, pick, cursorHint, get focused() { return st.focus; } };
}
