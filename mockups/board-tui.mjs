#!/usr/bin/env node
// Panel 4 (N26): the hyprpi PROJECT BOARD in its own window: the "projects panel", SUPER+ALT+P (was SUPER+ALT+B). One world's board
// (lib/board.mjs via the daemon): a "Needs you" strip, then one card per project. The pane is
// lib/tui/board-view.mjs (the same view the room panel had under Ctrl+B); the box at the bottom
// is lib/tui/input-box.mjs.
//
//   ~/Work/hyprpi/mockups/board-tui [ROOM]   (kitty launcher: key maps + the exit-75 restart loop)
//
// Keys: plain keys are the box's (typing, ←→↑↓, Shift+arrows select, ⏎ sends); the board needs a
// modifier. ^↑↓ move the highlight · ^⏎ (or ⏎ with an empty box) opens the highlighted card /
// goes back to all projects / puts an item's handle in the box · ^Space or ^O fold · ^D drop
// (on a project: archive) · ^T done · ^Z undo · Alt+1…9 answer the highlighted decision ·
// Esc: the box's selection, then the highlight, then the open card / help · PgUp PgDn / wheel
// scroll · ^Home ^End top / bottom · Tab completes /commands, item handles after "@p " and
// @projects; Shift+Tab @agents · ^Tab / ^Shift+Tab switch world · ^Q quits.
// Mouse: click the −/+ on a card header to fold · click a row to highlight it · drag selects and
// copies · Shift+click copies a whole item · double-click a word · Ctrl+click an @agent jumps to
// its window (a link opens).
// What is typed goes to the board: "@p text" (to its members: update the card), "@p" alone (the
// card, who, changes), "D1 b", "N2 ?", /todo /note /done /drop /fold /split /merge /spinout …
// (/help lists them).

import fs from "node:fs";
import { spawn } from "node:child_process";
import { connect } from "../lib/client.mjs";
import { completeAt } from "../lib/at-names.mjs";
import { urlIn, agentIn, bareName } from "../lib/tui/agent-click.mjs";
import { worldTabAt, stepTo } from "../lib/tui/world-tabs.mjs";
let worldBar = null;
import { ESC, out, theme, onThemeChange, rgb, worldFg, worldBg, dim, bold, fg, nameFg,
  graphemes, gw, strip, width, clip } from "../lib/tui/term.mjs";
import { createBoardView, boardCompletions } from "../lib/tui/board-view.mjs";
import { createInputBox, atTint } from "../lib/tui/input-box.mjs";
import { createCommands, parseCommand } from "../lib/tui/command-line.mjs";

let room = (process.argv[2] || "").toUpperCase(), rooms = [], agents = [], online = false, api = null, note = "";
let board = { room: "", projects: [], names: {}, live: {} };
const bv = createBoardView({ render: () => render() });
const hereAgents = () => agents.filter((a) => a.room === room);
const hereProjects = () => (board.room === room ? board.projects : []).filter((p) => p.status !== "archived");
const boardHere = () => (board.room === room ? board : null);

// The box: @names tinted (projects in the world colour, agents in theirs); sent text in the
// world colour until edited (the first typed key replaces it).
const box = createInputBox({
  onChange: () => { note = note.startsWith("✗") ? note : ""; render(); },
  copy: (t) => copy(t),
  tint: atTint((n) => {
    const k = n.toLowerCase();
    if (hereProjects().some((p) => p.name === k || p.id === k)) return { project: true };
    const a = hereAgents().find((x) => (x.display || "").toLowerCase() === k || (x.name || "").toLowerCase() === k);
    if (a) return { agent: a };
    return ["all", "everyone", "nobody", "none"].includes(k) ? { special: true } : null;
  }, { worldFg: (s) => fg(worldFg(room), s), bold, nameFg }),
  sentStyle: (g) => fg(worldFg(room), g),
});
let resendAsk = 0;   // ⏎ on unchanged sent text asks first (a second ⏎ within 4 s resends)
// The board's commands are lib/tui/board-view.mjs's; these are the ones every panel has, run when
// the board doesn't know a command (/help is the board's own: it shows the board's list).
const cmds = createCommands({
  ctx: {
    panel: "board", world: () => room, worlds: () => rooms.map((r) => r.id), cycle: (d) => cycle(d), agents: () => agents,
    api: () => api, via: "board-tui", render: () => render(),
    note: (t) => { note = t; render(); },
    showHelp: () => { bv.st.help = true; render(); },
    quit: () => quit(),
    setBox: (t) => box.set(t),
  },
});
let hcycle = null;   // Tab state for @names

// ---- selection & copy (the TUI owns the mouse) ------------------------------------------
let screen = [], rowMeta = {}, items = [], sel = null, lastPress = { x: 0, y: 0, t: 0 }, clicks = 0;
function copy(text) {
  if (!text) return;
  process.stdout.write(`\x1b]52;c;${Buffer.from(text).toString("base64")}\x07`);
  try { const p = spawn("wl-copy", ["--type", "text/plain;charset=utf-8"], { stdio: ["pipe", "ignore", "ignore"] }); p.on("error", () => {}); p.stdin.on("error", () => {}); p.stdin.end(text); } catch { /* OSC 52 only */ } // no wl-copy / no Wayland: OSC 52 alone
  note = `copied ${text.length} character${text.length === 1 ? "" : "s"}`;
}
const cellsOf = (line) => { const cs = []; let col = 1; for (const g of graphemes(line)) { cs.push([col, g]); col += gw(g); } return cs; };
function selRange() {
  if (!sel || (sel.x0 === sel.x1 && sel.y0 === sel.y1)) return null;
  const fwd = sel.y0 < sel.y1 || (sel.y0 === sel.y1 && sel.x0 <= sel.x1);
  return fwd ? { y0: sel.y0, x0: sel.x0, y1: sel.y1, x1: sel.x1 } : { y0: sel.y1, x0: sel.x1, y1: sel.y0, x1: sel.x0 };
}
function selSpans(W) {
  const r = selRange(), o = {}; if (!r) return o;
  for (let y = r.y0; y <= r.y1; y++) { const a = y === r.y0 ? r.x0 : 1, b = y === r.y1 ? r.x1 : W; if (a <= b) o[y] = [a, b]; }
  return o;
}
function selectedText() {
  const sp = selSpans(process.stdout.columns || 100), outl = [];
  for (const y of Object.keys(sp).map(Number).sort((a, b) => a - b)) {
    let col = 1, t = ""; for (const g of graphemes(screen[y - 1] || "")) { const w = gw(g); if (col >= sp[y][0] && col + w - 1 <= sp[y][1]) t += g; col += w; }
    outl.push(t.trimEnd());
  }
  return outl.join("\n");
}
function overlay(line, a, b, on, off) {
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
  if (inside) r += off;
  return r;
}
// The word under (x, y) on screen: double-click selects it; Ctrl+click jumps to an @agent.
function wordAt(x, y) {
  const cs = cellsOf(screen[y - 1] || "");
  const i = cs.findIndex(([c, g], k) => c <= x && (cs[k + 1]?.[0] ?? c + gw(g)) > x);
  if (i < 0 || /\s/.test(cs[i][1])) return null;
  let a = i, b = i;
  while (a > 0 && !/\s/.test(cs[a - 1][1])) a--;
  while (b < cs.length - 1 && !/\s/.test(cs[b + 1][1])) b++;
  return { a: cs[a][0], b: cs[b][0] + gw(cs[b][1]) - 1, word: cs.slice(a, b + 1).map(([, g]) => g).join("") };
}
function ctrlClick(x, y) { // a link opens; an agent's name ("Sankey[e]" too) → its window (lib/tui/agent-click.mjs)
  const w = wordAt(x, y); if (!w) return;
  const url = urlIn(w.word);
  if (url) { try { spawn("gio", ["open", url], { detached: true, stdio: "ignore" }).on("error", () => {}).unref(); note = "opening link"; } catch { /* none */ } return render(); }
  if (!api) return;
  const hit = agentIn(w.word, agents);
  if (!hit) { const n = bareName(w.word); if (n) { note = `no live agent @${n}`; render(); } return; }
  api.call("agent.focus", { agent: hit.id }).then(() => { note = `→ @${hit.display}`; render(); }).catch((e) => { note = "✗ " + e.message; render(); });
}

// ---- drawing ---------------------------------------------------------------------------
let restarting = false, batching = false, dirty = false;
function render() { if (restarting) return; if (batching) { dirty = true; return; } draw(); }
function draw() {
  dirty = false;
  const W = process.stdout.columns || 100, H = process.stdout.rows || 30, c = worldFg(room);
  const rule = (label = "") => fg(c, "─" + (label ? ` ${label} ` : "") + "─".repeat(Math.max(0, W - 1 - (label ? width(label) + 2 : 0))));
  const rows = [];
  const open = hereProjects().find((p) => p.id === bv.focused);
  // The box first (its height decides the pane's).
  const prompt = fg(c, bold(`${room} projects${open ? " @" + open.name : ""} ❯ `)), pw = width(prompt);
  const L = box.layout(Math.max(10, W - pw)), MAXI = Math.max(3, Math.min(10, Math.floor(H / 3)));
  const inTop = L.rows.length > MAXI ? Math.max(0, Math.min(L.cRow - MAXI + 1, L.rows.length - MAXI)) : 0;
  const inRows = L.rows.slice(inTop, inTop + MAXI);
  const avail = Math.max(1, H - 1 - 2 - inRows.length); // pane rule + input rule + status bar
  const b = bv.frame({ board: boardHere(), room, W, avail, c, agents, standalone: true });
  rows.push(rule(b.label));
  rowMeta = {}; items = b.items;
  b.rows.forEach((r, i) => { rowMeta[rows.length + 1 + i] = r; });
  rows.push(...b.rows.map((r) => r.line));
  const inputRule = rows.push(fg(c, "─".repeat(W))) - 1;
  // The hint after the box: typing a /command → its matches; else the note, the highlight's
  // keys, or what the box takes.
  const text = box.text;
  const slash = /^\/[^\s/]*$/.test(text) && !note.startsWith("✗") ? boardCompletions(text) : null;
  const busy = bv.status(c, false);
  const hint = slash ? dim("  " + (slash.length ? slash.join(" · ") + (slash.length === 1 ? "  (Tab)" : "") : "unknown command · /help"))
    : (busy ? "  " + busy : "") + (note ? dim("  " + note) : text ? "" : dim(bv.cursorHint() || (open
      ? `text → @${open.name}'s members · D1 b answers · N2 ? asks · /todo /note /done · ⏎ or Esc: all projects`
      : "@project text · @project alone opens it · D1 b answers · N2 ? asks · ^↑↓ highlight · /help")));
  // A hint that doesn't fit after the text (a narrow panel, e.g. in the 2x2 grid) goes on the
  // rule above the box instead of off the edge (Angus: "/assign … doesn't work": it had, but the
  // confirmation was past the right edge).
  const fits = !hint || pw + width(inRows[0] || "") + width(hint) <= W;
  if (!fits) { const h = clip(hint.replace(/^(\s|\x1b\[[0-9;]*m)+/, (m) => m.replace(/ /g, "")), W - 3); rows[inputRule] = fg(c, "─ ") + h + " " + fg(c, "─".repeat(Math.max(0, W - 3 - width(h)))); }
  inRows.forEach((l, i) => rows.push((i === 0 ? prompt : " ".repeat(pw)) + l + (i === 0 && fits ? hint : "")));
  // Status bar: the worlds, this one highlighted.
  const tabs = rooms.map((r) => r.id === room ? `${ESC}${worldBg(r.id)};30m ${r.id} ${ESC}49;39m` : ` ${fg(worldFg(r.id), r.id)} `).join("");
  const left = ` hyprpi projects ${online ? "" : "· daemon offline "}`;
  const right = " "; // no clock (Angus)
  worldBar = { y: rows.length + 1, x0: width(left) }; // a click on a world tab switches this panel (lib/tui/world-tabs.mjs)
  rows.push(`${ESC}7m${left}${ESC}27m${tabs}${ESC}7m${" ".repeat(Math.max(0, W - width(left) - width(strip(tabs)) - width(right)))}${right}${ESC}27m`);

  out(`\x1b]2;hyprpi-board ${room}\x07`);
  const lines = rows.slice(0, H).map((r) => clip(r, W));
  screen = lines.map(strip);
  const sp = selSpans(W);
  const on = theme.selection ? `${ESC}48;2;${rgb(theme.selection)}m` : `${ESC}7m`, off = theme.selection ? `${ESC}49m` : `${ESC}27m`;
  const shown = lines.map((l, i) => sp[i + 1] ? overlay(l, sp[i + 1][0], sp[i + 1][1], on, off) : l);
  // One synchronized frame (DEC 2026: kitty shows it all at once) and the cursor is never hidden,
  // so the "thinking…" shimmer (a frame every 90 ms) doesn't make the text cursor flicker (Angus).
  const crow = H - 1 - inRows.length + (L.cRow - inTop) + 1, ccol = Math.min(W, pw + L.cCol + 1);
  out(`${ESC}?2026h` + shown.map((l, i) => `${ESC}${i + 1};1H` + l + `${ESC}0m${ESC}K`).join("") + (shown.length < H ? `${ESC}${shown.length + 1};1H${ESC}J` : "")
    + `${ESC}${crow};${ccol}H${ESC}?25h${ESC}?2026l`);
}
onThemeChange(() => render());

// ---- the daemon ------------------------------------------------------------------------
async function loadBoard() {
  if (!api || !room) return;
  const r = room;
  try { const b = await api.call("board.get", { room: r }); if (r === room) { board = b; await bv.refresh(api, r, b); render(); } } catch { /* older daemon */ }
}
function applyList(r) {
  agents = r.agents || []; rooms = r.rooms || [];
  if (!room) room = r.active_room || rooms[0]?.id || "A";
  if (!rooms.find((x) => x.id === room)) rooms = [...rooms, { id: room }].sort((a, b) => a.id.localeCompare(b.id));
  render();
}
async function start() {
  if (restarting) return;
  try {
    api = await connect({
      onEvent: (ev, data) => {
        if (ev === "agents") applyList(data);
        else if (ev === "board" && data?.room === room) loadBoard();
        else if (ev === "board.open" && data?.room === room && data.project) openCard(data.project);
      },
      onClose: () => { online = false; api = null; render(); setTimeout(start, 1500); },
    });
    online = true;
    applyList(await api.call("ui.subscribe", { windows: false }));
    await loadBoard();
    // Opened by ⏎ on a project row in the agents panel: that card (asked just before we started).
    const req = await api.call("board.open", { room }).catch(() => null);
    if (req?.project) openCard(req.project);
  } catch { online = false; render(); setTimeout(start, 1500); }
}
// The agents panel's ⏎ on a project row (daemon board.open): show that card.
function openCard(id) { bv.focus(id); note = ""; loadBoard(); }
function cycle(dir) {
  if (!rooms.length) return;
  const i = rooms.findIndex((r) => r.id === room);
  room = rooms[(i + dir + rooms.length) % rooms.length].id;
  note = ""; bv.focus(null); bv.st.cur = null; bv.st.top = 0; board = { room: "", projects: [], names: {}, live: {} };
  render(); loadBoard();
}

// ---- sending ---------------------------------------------------------------------------
async function send() {
  const raw = box.text.trim();
  if (!raw) return render();
  // Unchanged sent text: ask before sending it again (a second ⏎ within 4 s resends).
  if (box.sent) {
    if (Date.now() - resendAsk > 4000) { resendAsk = Date.now(); note = "already sent · ⏎ again to send it again · type to change it"; return render(); }
    resendAsk = 0;
  }
  try {
    const r = await bv.input(raw, { api, room, board: boardHere() || { projects: [] } });
    if (!r) { // not the board's: the commands every panel has (/tinker, /quit; lib/tui/command-line.mjs)
      if (parseCommand(raw)) { box.clear(); cmds.run(raw); return render(); }
      note = "✗ not a board command · /help"; return render();
    }
    if (r.confirm) note = r.note; // a confirm prompt (/spinout, /merge): not sent yet, ⏎ again runs it
    else { box.markSent(); note = r.note; }
  } catch (e) { note = "✗ " + e.message; }
  render();
}
// Apply what bv.key returned: true (redraw) or a promise of { note?, input? }.
function applyKey(r) {
  if (r === true) { note = ""; render(); return true; }
  if (!r) return false;
  Promise.resolve(r).then((x) => { if (x?.input != null) box.set(x.input); if (x?.note != null) note = x.note; render(); })
    .catch((e) => { note = "✗ " + e.message; render(); });
  render(); return true;
}

// ---- keys ------------------------------------------------------------------------------
process.stdin.setRawMode?.(true);
process.stdin.setEncoding("utf8");
// Chunks → single keys (Alt+1..9 and Alt+letters whole, SGR mouse, CSI, SS3, bracketed paste).
const KEY = /\x1b[bfsS\x7f1-9]|\x1b\[<[\d;]+[Mm]|\x1b\[[\d;]*[A-Za-z~]|\x1bO[A-Za-z]|\x1b|[\s\S]/gu;
process.stdin.on("data", (chunk) => { batching = true; try { for (const [k] of String(chunk).matchAll(KEY)) onKey(k); } finally { batching = false; if (dirty) render(); } });
const CTRL_TAB = new Set(["\x1b[9;5u", "\x1b[27;5;9~"]), CTRL_SHIFT_TAB = new Set(["\x1b[9;6u", "\x1b[27;6;9~", "\x1b[1;5Z"]);
let pasting = false; // inside a bracketed paste: everything goes to the box (a pasted line break doesn't send)
function onKey(d) {
  if (d === "\x1b[200~") pasting = true;
  if (pasting) { if (d === "\x1b[201~") pasting = false; box.key(d); return; }
  if (sel && !d.startsWith("\x1b[<")) { sel = null; dirty = true; }
  if (d === "\x11") return quit(); // Ctrl+Q
  if (d.startsWith("\x1b[<")) return mouse(d);
  // (No Ctrl+B here: it pulled the room panel onto this workspace. Angus: removed.)
  if (CTRL_TAB.has(d)) return cycle(1);
  if (CTRL_SHIFT_TAB.has(d)) return cycle(-1);
  const ctx = () => ({ empty: !box.text, api, room, board: boardHere() });
  // Enter: the box's text is sent; with an empty box (or Ctrl+Enter, whatever is typed) it is the
  // board's ⏎: open the highlighted card, back to all projects, or an item's handle into the box.
  if (d === "\x1b[13;5u") { if (applyKey(bv.key("\r", { ...ctx(), empty: true }))) return; note = "^⏎: highlight a card or item first (^↑↓)"; return render(); }
  if (d === "\r") { if (!box.text && applyKey(bv.key("\r", ctx()))) return; return send(); }
  // Esc: the box's selection, then the highlight, then the open card / help; never quits.
  if (d === "\x1b") {
    if (box.dropSelection()) return;
    if (applyKey(bv.key("\x1b", ctx()))) return;
    if (bv.focused || bv.st.help) { if (bv.st.help) bv.st.help = false; else bv.focus(null); note = ""; return render(); }
    note = ""; return render();
  }
  // Tab: a /command · an item handle after "@p " · @projects. Shift+Tab: @agents.
  if (d === "\t" || d === "\x1b[Z") return tab(d === "\t");
  // Scrolling: PgUp/PgDn a page, ^Home/^End top / bottom.
  const sc = { "\x1b[5~": bv.page(), "\x1b[6~": -bv.page(), "\x1b[1;5H": Infinity, "\x1b[1;5F": -Infinity }[d];
  if (sc !== undefined) { bv.scroll(sc); return render(); }
  // The board's keys (all behind a modifier): ^↑↓ ^Space/^O ^D ^T ^Z Alt+1..9. Plain ↑↓ are the box's.
  if (d !== "\x1b[A" && d !== "\x1b[B" && applyKey(bv.key(d, ctx()))) return;
  if (box.key(d)) { hcycle = null; return; }
}
function tab(fwd) {
  const text = box.text, at = graphemes(text.slice(0)).slice(0, box.cursor).join("").length;
  if (fwd && /^\/[^\s/]*$/.test(text)) { // a board command
    const cs = boardCompletions(text);
    if (cs.length === 1) box.set(cs[0] + " ");
    else if (cs.length) { let p = cs[0]; while (!cs.every((x) => x.startsWith(p))) p = p.slice(0, -1); box.set(p.length > text.length ? p : cs[(cs.indexOf(text) + 1) % cs.length]); note = cs.join(" · "); }
    return render();
  }
  if (fwd) { // an item handle after "@p " (or a bare one)
    const h = bv.complete(text, at, boardHere(), 1);
    if (h) { if (!h.options.length) { note = h.hint || "no open item by that handle"; return render(); } box.set(h.text, graphemes(h.text.slice(0, h.cursor)).length); note = h.hint || ""; return render(); }
  }
  const pool = fwd ? hereProjects().map((p) => ({ id: p.id, name: p.name, display: p.name })) : hereAgents();
  const r = completeAt(text, at, pool, hcycle, 1);
  if (!r) { note = fwd ? "Tab: @projects, item handles, /commands · Shift+Tab: @agents" : "Shift+Tab completes @agents"; return render(); }
  if (!r.options.length) { note = fwd ? "no project here by that name" : "no agent here by that name"; return render(); }
  box.set(r.text, graphemes(r.text.slice(0, r.cursor)).length); hcycle = r.state;
  note = r.options.length > 1 ? r.options.map((o) => (o === r.pick ? "▸" : "") + (fwd ? "📋@" : "@") + o).join("  ") : "";
  render();
}
function mouse(d) {
  for (const m of d.matchAll(/\x1b\[<(\d+);(\d+);(\d+)([Mm])/g)) {
    const b = Number(m[1]), x = Number(m[2]), y = Number(m[3]), press = m[4] === "M";
    const tab = b === 0 && press ? worldTabAt(worldBar, x, y, rooms.map((r) => r.id)) : null;
    if (tab) { const s = stepTo(rooms.map((r) => r.id), room, tab); if (s) cycle(s); continue; } // a world tab: like Ctrl+Tab
    if (b === 64 || b === 65) { bv.scroll(b === 64 ? 3 : -3); continue; } // wheel
    if (b === 16) { if (press) ctrlClick(x, y); continue; }            // Ctrl+click: @agent / link
    if (b === 4 && press) { const r = rowMeta[y]; if (r?.msg != null && items[r.msg]) copy(items[r.msg].copy); continue; } // Shift+click: the whole item
    if (b === 0 && press) {
      if (bv.click(rowMeta[y], x)) { sel = null; continue; }           // a card's −/+ marker
      bv.pick(rowMeta[y], items);                                       // the highlight goes there
      const now = Date.now();
      clicks = now - lastPress.t < 400 && y === lastPress.y && Math.abs(x - lastPress.x) <= 1 ? clicks + 1 : 1;
      lastPress = { x, y, t: now };
      if (clicks === 2) { const w = wordAt(x, y); if (w) { sel = { x0: w.a, y0: y, x1: w.b, y1: y, done: true }; copy(selectedText()); } continue; }
      sel = { x0: x, y0: y, x1: x, y1: y };
      continue;
    }
    if (b === 32 && sel && !sel.done) { sel.x1 = x; sel.y1 = y; continue; } // drag
    if (b === 0 && !press && sel && !sel.done) { sel.x1 = x; sel.y1 = y; if (selRange()) { copy(selectedText()); sel.done = true; } else sel = null; }
  }
  render();
}
function quit() { out(`${ESC}?2004l${ESC}?1002l${ESC}?1000l${ESC}?1006l${ESC}?1049l${ESC}?25h`); process.exit(0); }
process.on("SIGTERM", quit);

// ---- restart onto new code (the launcher loops on exit 75; the state rides along) ------
const CODE = [new URL("./board-tui.mjs", import.meta.url).pathname,
  ...["client.mjs", "paths.mjs", "at-names.mjs", "tui/board-view.mjs", "tui/input-box.mjs", "tui/shimmer.mjs", "tui/term.mjs", "tui/command-line.mjs", "tui/agent-click.mjs"].map((f) => new URL("../lib/" + f, import.meta.url).pathname)];
const codeStamp = () => CODE.map((f) => { try { return fs.statSync(f).mtimeMs; } catch { return 0; } }).join(",");
const codeAtStart = codeStamp();
setInterval(() => {
  if (restarting || codeStamp() === codeAtStart) return;
  restarting = true;
  try { api?.close?.(); } catch { /* fine */ }
  out(`${ESC}?2004l${ESC}?1002l${ESC}?1000l${ESC}?1006l${ESC}?1049l${ESC}?25h`);
  const keep = JSON.stringify({ room, focus: bv.focused || null, top: bv.st.top, anchor: bv.st.anchor, cur: bv.st.cur, help: bv.st.help, input: box.text, cursor: box.cursor, sent: box.sent });
  const sf = process.env.HYPRPI_BOARD_TUI_STATEFILE;
  if (sf) { try { fs.writeFileSync(sf, keep); } catch { /* start fresh */ } process.exit(75); }
  spawn(process.execPath, [CODE[0], room], { stdio: "inherit", env: { ...process.env, HYPRPI_BOARD_TUI_STATE: keep } }).on("exit", (code) => process.exit(code ?? 0));
  process.stdin.setRawMode?.(false); process.stdin.pause();
}, 3000);
try { // back where we were after a restart
  let raw = process.env.HYPRPI_BOARD_TUI_STATE || "";
  const sf = process.env.HYPRPI_BOARD_TUI_STATEFILE;
  if (!raw && sf) { try { raw = fs.readFileSync(sf, "utf8"); fs.writeFileSync(sf, ""); } catch { /* none */ } }
  delete process.env.HYPRPI_BOARD_TUI_STATE;
  const k = raw ? JSON.parse(raw) : null;
  if (k) {
    if (!process.argv[2] && k.room) room = k.room;
    if (k.focus) bv.focus(k.focus);
    bv.st.top = Number(k.top) || 0; bv.st.anchor = k.anchor || null; bv.st.cur = k.cur || null; bv.st.help = !!k.help;
    if (typeof k.input === "string" && k.input) { box.set(k.input, k.cursor); if (k.sent) box.markSent(); }
  }
} catch { /* start fresh */ }
process.stdout.on("resize", render);
out(`${ESC}?1049h${ESC}?1000h${ESC}?1002h${ESC}?1006h${ESC}?2004h`); // alt screen + mouse + bracketed paste
render();
start();
