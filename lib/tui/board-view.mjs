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
//   /todo @p text · /note @p text (verbatim) · /done @p N2 [N3 …] [how verified] · /drop @p N2 [N3 …]
//   /new @name [title] [+@Agent…] · /assign @p +@A -@B · /rename @p @new · /writer @p @A
//   /pause @p · /archive @p · /activate @p · /refresh [@p] · /clarify @p D1 question · /help

import { ESC, dim, midFg, bold, fg, nameFg, graphemes, gw, width, cut, wrap, strip, theme, rgb } from "./term.mjs";

export const BOARD_COMMANDS = [
  ["/todo", "/todo @p text: add a Next item, your words verbatim"],
  ["/note", "/note @p text: add a Heard item, verbatim"],
  ["/done", "/done @p N2 [how it was verified]"],
  ["/drop", "/drop @p N2 [N3 …]"],
  ["/new", "/new @name [title] [+@Agent …]: a new project (members optional)"],
  ["/assign", "/assign @p +@A -@B"],
  ["/writer", "/writer @p @A: hand the writer role to a member"],
  ["/rename", "/rename @p @new"],
  ["/pause", "/pause @p"],
  ["/archive", "/archive @p (hidden from the board)"],
  ["/activate", "/activate @p (back from paused / archived)"],
  ["/refresh", "/refresh [@p]: members reconcile the card with reality (all projects without @p)"],
  ["/clarify", "/clarify @p D1 question: ask the members about an item"],
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

export function createBoardView() {
  const st = {
    focus: null,   // project id shown expanded (the combined view), or null = the whole board
    top: 0,        // lines scrolled down from the top
    changes: [],   // board.changes for the focused project
    help: false,   // the command list at the top
    hcycle: null,  // Tab state for item handles
    lastRows: 0, lastAvail: 10,
  };

  // ---- drawing -------------------------------------------------------------------------
  // ctx: { board: {room, projects, names, live}, room, W, avail, c (world colour), agents }
  // -> { rows: [{ line, msg, textX, hard, header }], items: [{ copy, key }], label }
  // Rows use the stream's row shape so selection and copying work unchanged.
  function frame(ctx) {
    const { W, avail, c } = ctx;
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
        ["@p D1 b", "answer decision D1 with option b (or any words)"], ["@p N2 ?", "ask for more detail on N2, written into the card"]])
        rows.push({ line: `   ${bold(k.padEnd(w))}  ${dim(d)}`, msg: null });
      rows.push({ line: `   ${dim("Tab completes @projects, @agents and item handles after \"@p \" · ^B back to the stream · wheel / PgUp PgDn / ^↑↓ scroll")}`, msg: null });
      blank();
    }

    // Needs you: every open decide item on the board (all projects, even when one is open).
    const open = [];
    for (const p of projects) for (const it of p.items || []) if (it.sec === "decide") open.push({ p, it });
    rows.push({ line: secRule(open.length ? `Needs you · ${open.length}` : "Needs you", open.length ? "answer: @p D1 b" : ""), msg: null, header: true });
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
      const head = `━ 📋 ${bold("@" + p.name)}${badge}${warn} `;
      const right = ` updated ${ago(p.updated)}${p.lastBy ? " by " + p.lastBy : ""}`;
      const fill = Math.max(2, W - 1 - width(strip(head)) - width(right));
      const hi = item(`@${p.name}${p.title ? " — " + p.title : ""}`, `card:${p.id}`);
      rows.push({ line: fg(c, head) + fg(c, "━".repeat(fill)) + dim(right), msg: hi, textX: 3, header: true });
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
  async function refresh(api, room) {
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
    const call = (m, p) => api.call(m, { room, ...p });
    const told = (r) => r?.told?.length ? r.told.join(", ") : "nobody live";

    // Commands.
    const cm = /^\/([a-z]+)(?:\s+([\s\S]*))?$/i.exec(t);
    if (cm && !t.startsWith("//")) {
      const cmd = cm[1].toLowerCase();
      let arg = (cm[2] || "").trim();
      // A card is open: its commands may leave out "@p".
      const openP = st.focus && projects.find((x) => x.id === st.focus);
      if (openP && !arg.startsWith("@") && ["todo", "note", "done", "drop", "assign", "writer", "pause", "archive", "activate", "clarify", "refresh"].includes(cmd)) arg = `@${openP.name} ${arg}`.trim();
      const [p0, ...rest] = arg.split(/\s+/);
      const restText = arg.slice((p0 || "").length).trim();
      const needP = () => { if (!p0 || !p0.startsWith("@")) throw new Error(`/${cmd} needs @project first`); return p0; };
      switch (cmd) {
        case "help": st.help = !st.help; st.top = 0; return { note: st.help ? "board commands at the top · /help again hides them" : "" };
        case "todo": case "note": {
          const p = proj(needP());
          if (!restText) throw new Error(`/${cmd} @${p.name} what to write`);
          const r = await call("board.item", { action: "add", project: p.id, section: cmd === "todo" ? "next" : "heard", text: restText });
          return { note: `@${p.name} ${r.item.h} added (${cmd === "todo" ? "next" : "heard"})` };
        }
        case "done": case "drop": { // several handles at once: /drop @p N1 N2 N3 (commas fine)
          const p = proj(needP());
          const words = rest.join(" ").split(/[\s,]+/).filter(Boolean);
          let k = 0; while (k < words.length && /^[a-z✓]?\d+$/i.test(words[k].replace(/^✓/, ""))) k++;
          const hs = words.slice(0, k).map((w) => w.replace(/^✓/, ""));
          if (!hs.length) throw new Error(`/${cmd} @${p.name} N2 [N3 …]`);
          const missing = hs.filter((h) => !itemOf(p, h));
          if (missing.length) throw new Error(`no item ${missing.join(" ")} on @${p.name} (nothing changed)`);
          const verified = words.slice(k).join(" ");
          for (const h of hs) {
            const it = itemOf(p, h);
            if (cmd === "done") await call("board.item", { action: "done", project: p.id, h: it.h, verified: verified || "marked done by Angus" });
            else await call("board.item", { action: "drop", project: p.id, h: it.h });
          }
          return { note: `@${p.name} ${hs.map((h) => h.toUpperCase()).join(" ")} ${cmd === "done" ? "done ✓" : "dropped"}` };
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
        case "clarify": {
          const p = proj(needP()), it = rest[0] && itemOf(p, rest[0]);
          if (!it) throw new Error(`/clarify @${p.name} D1 your question`);
          const q = rest.slice(1).join(" ");
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
    } else if (st.focus && (p = projects.find((x) => x.id === st.focus))) body = t.replace(/^\/\//, "/");
    else throw new Error("board mode: start with @project (Tab completes) · /help · ^B for the stream");

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
      return { text: out, cursor, options: s.options, pick };
    }
    st.hcycle = null;
    const before = text.slice(0, at);
    const m = /(?:^|^\/(done|drop|clarify)\s+)@(\S+)\s+([A-Za-z]?\d*)$/i.exec(before);
    let p, part, cmd;
    if (m) { p = (board?.projects || []).find((x) => x.name === norm(m[2]) || x.id === norm(m[2])); part = m[3]; cmd = (m[1] || "").toLowerCase(); }
    else if (st.focus && /^[A-Za-z]?\d*$/.test(before)) { p = (board?.projects || []).find((x) => x.id === st.focus); part = before; cmd = ""; }
    if (!p) return null;
    const open = (p.items || []).filter((it) => cmd === "drop" ? true : it.sec !== "done");
    const options = open.map((it) => it.h).filter((h) => h.toLowerCase().startsWith(part.toLowerCase()));
    const start = before.length - part.length, after = text.slice(at);
    if (!options.length) return { text, cursor: at, options };
    if (options.length === 1) {
      const ins = options[0] + (after.startsWith(" ") ? "" : " ");
      return { text: text.slice(0, start) + ins + after, cursor: start + ins.length, options, pick: options[0] };
    }
    const pick = options[0], out = text.slice(0, start) + pick + after, cursor = start + pick.length;
    st.hcycle = { options, start, i: 0, text: out, at: cursor };
    return { text: out, cursor, options, pick };
  }
  // A handle's item text (for the hint under the box while Tab cycles).
  const itemText = (board, h) => { for (const p of board?.projects || []) { const it = (p.items || []).find((x) => x.h === h && (!st.focus || p.id === st.focus)); if (it) return it.text; } return ""; };

  return { st, frame, scroll, page, refresh, focus, input, complete, itemText, get focused() { return st.focus; } };
}
