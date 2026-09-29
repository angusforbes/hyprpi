#!/usr/bin/env node
// Panel 1 of three (docs/panels-plan.md): the hyprpi AGENT PANEL, SUPER+ALT+A.
// A view of one world's agents and a selector — no messages, no stream, no search.
//
//   ~/Work/hyprpi/mockups/agents-tui [ROOM]     (kitty launcher)
//
// Rows: ● working · ✓ finished (unseen) · × blocked · ○ idle, then the name, workspace (C2), topic and
// model. Greyed ◌ rows are agents that are not open: "closed" (lost to a reboot, or
// closed/killed while hyprpi ran) and "parked" (Reprieve, SUPER+W: still running, out
// of every room). Ctrl+O cycles: live · + parked.
//   Ctrl+↑↓ (or ↑↓) / click / wheel   move the cursor · PgUp PgDn · Home End / Ctrl+Home End
//   Enter / Ctrl+click   live: jump to its window · parked: revive it here · closed: resume it
//   Space / Shift+Space  mark ▸ (the shared per-room selection every panel uses)
//   Ctrl+A               mark all / none      Esc  mark all again
//   Ctrl+W / Ctrl+K      close / kill (twice); on a closed agent: forget it
//   Ctrl+N               new agent here       ^Tab / ^⇧Tab  switch world
//   Ctrl+Q               quit
// Command line (lib/tui/command-line.mjs + lib/tui/input-box.mjs, shared with the room, search and
// board panels): type /command + ⏎ (Tab completes). While the box has text, typing, Space, ⏎,
// Esc (clears it) and ^W (a word) are the box's; empty, every key above works as before.
//   the commands every panel has (lib/tui/command-line.mjs): /help · /agents /room /search /board
//   (go to that panel) · /search WORDS · /ai Q · /world X · /go @Name · /new · /tinker · /quit
// Later: a 🎤 column for dictation targets, and commands that act on the selection.
import fs from "node:fs";
import { spawn } from "node:child_process";
import { connect } from "../lib/client.mjs";
import { loadConfig, wsLabel } from "../lib/paths.mjs";
const WORLD_SIZE = loadConfig().worldSize || 10; // workspaces per world (for "C2" labels)
import * as hypr from "../lib/hypr.mjs";
import { ESC, out, theme, onThemeChange, rgb, worldFg, worldBg, dim, midFg, bold, fg,
  markupFg, unnamed, nameFg, width, cut, clip } from "../lib/tui/term.mjs";
import { createInputBox } from "../lib/tui/input-box.mjs";
import { createCommands, inputRows } from "../lib/tui/command-line.mjs";
import { worldTabAt, stepTo } from "../lib/tui/world-tabs.mjs";
let worldBar = null;

// ---- state -----------------------------------------------------------------
let agents = [], dormant = [], rooms = [], room = (process.argv[2] || "").toUpperCase();
let marks = { all: true, agents: [] };      // the daemon's per-room selection
let cursorId = "", listTop = 0, listRows = 0, listRowY = 0, lastCursorIdx = 0;
let note = "", online = false, confirm = null, api = null, restarting = false;
let showMode = 0;                            // 0 = live (+ lost to a restart), 1 = + parked/closed
const SHOW_LABEL = ["live", "+ parked"];
const closing = new Map();                   // id -> "close" | "kill" while we wait for the daemon
let pendingNew = [];
let showHelp = false;                        // /help: the commands and keys instead of the list

// The command line: the shared box (single line) and the shared commands.
function copy(text) {
  if (!text) return;
  try { const p = spawn("wl-copy", [], { stdio: ["pipe", "ignore", "ignore"] }); p.on("error", () => {}); p.stdin.on("error", () => {}); p.stdin.end(text); note = "copied"; } catch { /* no wl-copy */ }
}
const box = createInputBox({ onChange: () => { if (!note.startsWith("✗")) note = ""; render(); }, copy, multiline: false });
const cmds = createCommands({
  commands: [],
  ctx: {
    panel: "agents", world: () => room, worlds: () => rooms.map((r) => r.id), cycle: (d) => cycleRoom(d), agents: () => agents,
    newAgent: () => newAgent(),
    api: () => api, via: "agents-tui", render: () => render(),
    note: (t) => { note = t; render(); },
    showHelp: () => { showHelp = true; note = ""; render(); },
    quit: () => quit(),
    setBox: (t) => box.set(t),
  },
});

const hereLive = () => agents.filter((a) => a.room === room);
const hereParked = () => showMode >= 1 ? agents.filter((a) => a.parked && (!a.parked_from || a.parked_from === room)) : [];
const hereDormant = () => dormant.filter((a) => a.room === room && (a.kind !== "closed" || showMode >= 1));
const listHere = () => [...hereLive(), ...hereParked(), ...hereDormant()];
const byId = (id) => listHere().find((a) => a.id === id);
const isMarked = (id) => marks.all || marks.agents.includes(id);

// Projects (Angus, 2026-09-29; ~/Obsidian/Tinker/2026-09-29 Projects in the agents panel.md): a
// section below the agents, one row per project of this world's board: "@name · members · short"
// (short = the card's where line summarised to topic length by the daemon). Active and new ones;
// paused ones dimmed at the end; archived only in the ^O "+ parked" view. Projects with open
// Decide items first (a D badge), then the most recently changed. The cursor runs on into them
// (cursorId "p:<id>"): ⏎ opens the card in the projects panel, Space marks its members.
let board = { room: "", projects: [], names: {} };
let projRowY = {};                           // screen row -> project id (clicks)
let projMemberX = {};                        // screen row -> [{ x0, x1, id }] where each @member is (clicks)
// A project's mark, from its live members, most urgent first (Angus): × one needs you · ● one is
// working · ✓ one finished (unseen) · ○ idle · ◌ nobody live.
function projMark(p) {
  const live = (p.members || []).map((id) => agents.find((a) => a.id === id)).filter(Boolean);
  if (!live.length) return "◌";
  const ms = live.map(mark);
  return ["×", "●", "✓"].find((k) => ms.includes(k)) || "○";
}
const openDecides = (p) => (p.items || []).filter((it) => it.sec === "decide").length;
function hereProjects() {
  if (board.room !== room) return [];
  const rank = (p) => p.status === "archived" ? 2 : p.status === "paused" ? 1 : 0;
  return (board.projects || []).filter((p) => p.status !== "archived" || showMode >= 1)
    .sort((a, b) => rank(a) - rank(b) || (openDecides(b) > 0) - (openDecides(a) > 0) || (b.updated || 0) - (a.updated || 0));
}
const projOf = (cid) => String(cid).startsWith("p:") ? hereProjects().find((p) => p.id === cid.slice(2)) : null;
async function loadBoard() {
  if (!api || !room) return;
  try { const b = await api.call("board.get", { room }); if (b?.room === room) { board = b; render(); } } catch { /* older daemon */ }
}

function mark(a) { // same marks as the room window
  if (a.status === "working") return "●";
  if (a.status === "blocked") return "×";
  if (a.status === "done" && !a.seen) return "✓";
  return "○";
}

// ---- drawing ---------------------------------------------------------------
let batching = false, dirty = false;
function render() { if (restarting) return; if (batching) { dirty = true; return; } draw(); }
onThemeChange(render);

function draw() {
  dirty = false;
  const W = process.stdout.columns || 80, H = process.stdout.rows || 24;
  const c = worldFg(room);
  const here = listHere(), live = hereLive();
  const rule = (label = "") => fg(c, "─" + (label ? ` ${label} ` : "") + "─".repeat(Math.max(0, W - 1 - (label ? width(label) + 2 : 0))));
  const rows = [];

  // The agent under the cursor went away (closed, killed, moved out of the room): stay in
  // place — the one that took its row, or the last row if it was the bottom one.
  const projs = showHelp ? [] : hereProjects();
  if (!here.find((a) => a.id === cursorId) && !projOf(cursorId)) cursorId = here[Math.min(lastCursorIdx, here.length - 1)]?.id || "";
  const cur = Math.max(0, here.findIndex((a) => a.id === cursorId));
  if (here.length) lastCursorIdx = cur;
  // The command line first: its height decides the list's.
  const prompt = fg(c, bold(`${room} ❯ `)), promptW = width(prompt);
  const text = box.text;
  const hintText = (note.startsWith("✗") ? null : cmds.hint(text)) ?? (confirm ? confirm.label : note || (text ? "" : showHelp ? "Esc back"
    : "/help · ^↑↓ move · ⏎ open · Space ▸ · ^O views · ^N new · ^W close · ^Tab world · ^Q quit"));
  const IR = inputRows(box, { W, H, prompt, promptW, hint: hintText ? dim("  " + hintText) : "", width, clip,
    rule: (h) => fg(c, "─ ") + h + " " + fg(c, "─".repeat(Math.max(0, W - 3 - width(h)))) });
  // The projects section takes at most about half the height (header rule + one row each).
  const projShow = projs.length ? Math.min(projs.length, Math.max(1, Math.floor((H - 4 - IR.rows.length) / 2))) : 0;
  const projRows = projShow ? projShow + 2 : 0; // a blank row, the rule, the projects
  listRows = Math.max(1, Math.min(here.length, H - 3 - IR.rows.length - projRows));
  if (cur < listTop) listTop = cur;
  if (cur >= listTop + listRows) listTop = cur - listRows + 1;
  listTop = Math.max(0, Math.min(listTop, Math.max(0, here.length - listRows)));
  const nMarked = live.filter((a) => isMarked(a.id)).length;
  const hidden = here.length - listTop - listRows;
  rows.push(rule(`agents · room ${room} · ${SHOW_LABEL[showMode]} (^O)`
    + (here.length > listRows ? ` · ${listTop ? "↑" + listTop + " " : ""}${hidden > 0 ? "↓" + hidden : ""}` : "")
    + (nMarked === live.length ? "" : ` · ${nMarked}/${live.length} ▸ · Esc all`)));
  listRowY = rows.length + 1;

  const nameW = Math.min(24, Math.max(6, ...here.map((a) => width(a.display))));
  // A fixed icon column (Angus: the names in the agent list and the project list line up): the
  // icon padded to 2 cells + a space, or 3 spaces for an agent without one; projects skip it too.
  const ICON_W = 3;
  const iconCol = (a) => a.icon ? a.icon + " ".repeat(Math.max(1, ICON_W - width(a.icon))) : " ".repeat(ICON_W);
  const nameBg = theme.muted || theme.selection;
  if (showHelp) {
    for (const [k, d] of [...cmds.help(), ["", ""], ["^↑↓ ↑↓ · click", "move the cursor · wheel scrolls"], ["⏎ · ^click", "live: jump to its window · parked: revive it here · closed: resume it"],
      ["Space · ^A · Esc", "mark ▸ (the shared per-room selection) · all / none · all again"], ["^O", "views: live · + parked / closed (and archived projects)"],
      ["⏎ · Space on @project", "its card in the projects panel (SUPER+ALT+P) · mark its members ▸"],
      ["^W ^W · ^K ^K", "close / kill (on a closed agent: forget it)"], ["^N · ^Tab ^⇧Tab · ^Q", "new agent here · switch world · quit"],
      ["box", "Tab completes a /command · //text is not a command · Esc clears the box"]])
      rows.push(k ? `   ${bold(k.padEnd(22))} ${dim(d)}` : "");
  }
  if (!showHelp && !here.length) rows.push(dim("  no agents here · ^N opens one"));
  for (const a of showHelp ? [] : here.slice(listTop, listTop + listRows)) {
    const name = cut(a.display, nameW);
    const iconPart = iconCol(a);
    const bare = name;
    const model = (a.model || "").replace(/^claude-/, "");
    const dot = " · ";
    // Where it is, as hyprpi list says it (Angus): "pi·k3vg · C2 · topic · opus-5-5". Parked rows say "parked" instead.
    const ws = !a.parked && Number.isInteger(a.workspace) && a.workspace > 0 ? dot + wsLabel(a.workspace, WORLD_SIZE) : "";
    // Runs in a container (Angus): " (🐳 docker)" right after the name, then the usual " · …".
    const box = a.container ? " (🐳 " + String(a.container).split(":")[0] + ")" : "";
    const rest = box + ws + (a.topic ? dot + `${ESC}3m${a.topic}${ESC}23m` : "") + (model ? dot + model : "");
    if (a.dormant || a.parked) { // greyed, same columns as a live row
      const nm = a.id === cursorId ? (nameBg ? `${ESC}48;2;${rgb(nameBg)}m${bare}${ESC}49m` : `${ESC}4m${bare}${ESC}24m`) : bare;
      const what = a.parked ? "parked" : "closed";
      const how = a.parked ? " · ⏎ revive" : " · ⏎ resume · ^W^W forget";
      rows.push(midFg(` ◌ ${iconPart}${nm}${rest}${dot}${what}${a.id === cursorId ? how : ""}`));
      continue;
    }
    let styled = a.name_markup && !name.endsWith("…") && !unnamed(a.name) ? bold(markupFg(a.name_markup, a.color)) : nameFg(a.name, a.color, bare);
    if (a.id === cursorId && nameBg) styled = `${ESC}48;2;${rgb(nameBg)}m${styled}${ESC}49m`;
    else if (a.id === cursorId || a.focused) styled = `${ESC}4m${styled}${ESC}24m`;
    styled = iconPart + styled;
    const sel = isMarked(a.id) ? fg(c, bold("▸")) : " ";
    if (closing.has(a.id)) { rows.push(dim(`  ${mark(a)} ${iconPart}${name} · ${closing.get(a.id) === "kill" ? "killing" : "closing"}…`)); continue; }
    rows.push(`${sel}${fg(c, bold(mark(a)))} ${styled}${rest}`);
  }
  pendingNew = pendingNew.filter((p) => Date.now() - p.t < 30000);
  if (!showHelp) for (const p of pendingNew) rows.push(dim(`  ◌ ${" ".repeat(ICON_W)}starting a new agent in ${String(p.cwd).replace(process.env.HOME, "~")} …`));
  projRowY = {}; projMemberX = {};
  if (projShow && rows.length < H - 2 - IR.rows.length - 2) {
    const more = projs.length - projShow;
    // What ^O does here too (Angus): the "+ parked" view also shows archived projects.
    const view = showMode >= 1 ? "+ archived (^O)" : "open (^O)"; // no archived count (Angus)
    rows.push(""); // a line of space between the agents and the projects (Angus)
    rows.push(rule(`projects · room ${room} · ${view}${more > 0 ? ` · +${more} more (SUPER+ALT+P)` : ""}`));
    const dot = " · ";
    for (const p of projs.slice(0, projShow)) {
      const cur = cursorId === "p:" + p.id;
      let nm = bold("@" + p.name);
      if (cur) nm = nameBg ? `${ESC}48;2;${rgb(nameBg)}m${nm}${ESC}49m` : `${ESC}4m${nm}${ESC}24m`;
      // Members as the projects panel writes them (lib/tui/board-view.mjs who()): "@Name" in the
      // agent's colour, no icon; bold when it isn't live; space-separated; the writer first (Angus).
      const ids = [...(p.writer && (p.members || []).includes(p.writer) ? [p.writer] : []), ...(p.members || []).filter((id) => id !== p.writer)];
      const w0 = String(p.where?.text || "").trim(); // until the daemon's summary is ready: its start
      const short = p.short || (w0.length > 40 ? w0.slice(0, 39).replace(/\s+\S*$/, "") + "…" : w0);
      const d = openDecides(p);
      const badge = d ? fg(c, bold("D")) : " ";
      // Columns as an agent row (▸ · mark · space · name), so the names line up: D badge · the
      // project's mark · space · @name. Each @member's columns are kept for clicks.
      let x = 4 + ICON_W + width("@" + p.name);
      const spans = [];
      const members = ids.map((id, k) => {
        const a = agents.find((q) => q.id === id);
        const n = "@" + (board.names?.[id] || a?.display || "pi·" + id.slice(-4));
        x += k === 0 ? width(dot) : 1;
        spans.push({ x0: x, x1: x + width(n) - 1, id });
        x += width(n);
        return a ? nameFg(a.name, a.color, n) : bold(n);
      });
      const text = `${nm}${members.length ? dot + members.join(" ") : dot + dim("nobody")}${short ? dot + `${ESC}3m${short}${ESC}23m` : ""}`;
      projRowY[rows.length + 1] = p.id; projMemberX[rows.length + 1] = spans;
      const pm = projMark(p), pmark = pm === "◌" ? midFg(pm) : fg(c, bold(pm));
      // The project's icon in the agents' icon column (📋 until one is set), so @name lines up.
      const pic = p.icon || "📋", skip = pic + " ".repeat(Math.max(1, ICON_W - width(pic)));
      rows.push(p.status === "paused" || p.status === "archived" ? midFg(`${badge}${pm} ${skip}${text}${dot}${p.status}`) : `${badge}${pmark} ${skip}${text}`);
    }
  }

  while (rows.length < H - 2 - IR.rows.length) rows.push("");
  rows.length = Math.min(rows.length, H - 2 - IR.rows.length);
  rows.push(IR.ruleOverride || fg(c, "─".repeat(W)));
  rows.push(...IR.rows);

  // status bar: worlds, counts
  const tabs = rooms.map((r) => r.id === room ? `${ESC}${worldBg(r.id)};30m ${r.id} ${ESC}49;39m` : ` ${fg(worldFg(r.id), r.id)} `).join("");
  const nParked = agents.filter((a) => a.parked && (!a.parked_from || a.parked_from === room)).length;
  const nClosed = dormant.filter((a) => a.room === room).length;
  const extra = [nParked && `${nParked} parked`, nClosed && `${nClosed} closed`].filter(Boolean).join(" · ");
  const left = ` agents ${online ? "" : "· daemon offline "}`;
  const right = `${live.length} live${extra ? " · " + extra : ""} `;
  const mid = W - width(left) - width(tabs.replace(/\x1b\[[0-9;]*m/g, "")) - width(right);
  worldBar = { y: rows.length + 1, x0: width(left) }; // a click on a world tab switches this panel (lib/tui/world-tabs.mjs)
  rows.push(`${ESC}7m${left}${ESC}27m${tabs}${ESC}7m${" ".repeat(Math.max(0, mid))}${right}${ESC}27m`);

  out(`\x1b]2;hyprpi-router ${room}\x07`); // how `mockups/panels` finds this window
  // One synchronized frame, then the text cursor in the command line.
  const crow = H - IR.rows.length + IR.cursorRow;
  out(`${ESC}?2026h${ESC}H${ESC}2J` + rows.slice(0, H).map((r) => clip(r, W) + `${ESC}0m${ESC}K`).join("\r\n")
    + `${ESC}${crow};${IR.cursorCol}H${ESC}?25h${ESC}?2026l`);
}

// ---- daemon ----------------------------------------------------------------
let lastFocusedId = "";
function applyList(r) {
  agents = r.agents || []; dormant = r.dormant || []; rooms = r.rooms || [];
  for (const id of closing.keys()) if (!agents.find((a) => a.id === id)) closing.delete(id);
  for (const a of agents) {
    const i = pendingNew.findIndex((p) => !p.known.has(a.id));
    if (i >= 0) {
      pendingNew.splice(i, 1); for (const p of pendingNew) p.known.add(a.id);
      // The agent we just opened: jump to its window (it may be on another workspace —
      // `hyprpi new` avoids a workspace in panel mode).
      cursorId = a.id;
      api?.call("agent.focus", { agent: a.id }).then(() => { note = "\u2192 " + a.display; render(); }).catch(() => {});
    }
  }
  const f = agents.find((a) => a.focused);
  if (f && f.id !== lastFocusedId && f.room === (room || r.active_room)) cursorId = f.id;
  lastFocusedId = f ? f.id : "";
  if (!room) room = r.active_room || rooms[0]?.id || "A";
  if (!rooms.find((x) => x.id === room)) rooms = [...rooms, { id: room }].sort((a, b) => a.id.localeCompare(b.id));
  render();
}

async function loadMarks() {
  try { marks = await api.call("selection.get", { room }); } catch { marks = { all: true, agents: [] }; }
  render();
}

async function start() {
  if (restarting) return;
  try {
    api = await connect({
      onEvent: (ev, data) => {
        if (ev === "agents") applyList(data);
        else if (ev === "selection" && data?.room === room) { marks = data; render(); }
        else if (ev === "board" && data?.room === room) loadBoard();
      },
      onClose: () => { online = false; api = null; render(); setTimeout(start, 1500); },
    });
    online = true;
    applyList(await api.call("ui.subscribe", { windows: false }));
    await loadMarks();
    await loadBoard();
  } catch { online = false; render(); setTimeout(start, 1500); }
}

// ---- actions ---------------------------------------------------------------
// ⏎ on a project: its card in this world's projects panel (jump to it, or open it here).
function openProject(p) {
  if (!api) return;
  api.call("board.open", { room, project: p.id }).catch(() => {});
  const env = { ...process.env }; delete env.HYPRPI_AGENT_ID;
  const c = spawn(new URL("./panel-here", import.meta.url).pathname, ["board", room], { detached: true, stdio: "ignore", env });
  c.on("error", () => {}); c.unref();
  note = `→ @${p.name} in the projects panel`; render();
}
// Space on a project: mark just its live members (the shared selection), so a message goes to them.
function markProject(p) {
  if (!api) return;
  const ids = (p.members || []).filter((id) => agents.find((a) => a.id === id && a.room === room));
  if (!ids.length) { note = `✗ none of @${p.name}'s members are live here`; return render(); }
  api.call("selection.set", { room, all: false, agents: ids }).then((m) => { marks = m; note = `▸ @${p.name}'s members · Esc all`; render(); }).catch(() => {});
}

function enter() {
  const pj = projOf(cursorId);
  if (pj) return openProject(pj);
  const a = byId(cursorId);
  if (!a || !api) return;
  const fail = (e) => { note = "✗ " + e.message; render(); };
  if (a.parked) return api.call("agent.unpark", { agent: a.id }).then(() => { note = "→ " + a.display + " is back"; render(); }).catch(fail), render();
  if (a.dormant) return api.call("agent.resume", { agent: a.id }).then(() => { note = "resuming " + a.display + " …"; render(); }).catch(fail), render();
  api.call("agent.focus", { agent: a.id }).then(() => { note = "→ " + a.display; render(); }).catch(fail);
}

function toggleMark() {
  const pj = projOf(cursorId);
  if (pj) return markProject(pj);
  const a = byId(cursorId);
  if (!a || a.dormant || a.parked || !api) return;
  api.call("selection.toggle", { room, agent: a.id }).then((m) => { marks = m; render(); }).catch(() => {});
}

function markAll(all) {
  if (!api) return;
  api.call("selection.set", { room, all, agents: [] }).then((m) => { marks = m; render(); }).catch(() => {});
}

function act(kind) { // ^W close / ^K kill; on a closed agent both mean "forget"
  const a = byId(cursorId);
  if (!a) return;
  const again = `press ^${kind === "close" ? "W" : "K"} again`;
  if (!confirm || confirm.kind !== kind || confirm.id !== a.id || Date.now() > confirm.until) {
    confirm = { kind, id: a.id, until: Date.now() + 3000,
      label: a.dormant ? `forget ${a.display}? (its session stays) ${again}` : `${kind === "close" ? "close" : "KILL"} ${a.display}? ${again}` };
    setTimeout(() => { if (confirm && Date.now() > confirm.until) { confirm = null; render(); } }, 3100);
    return render();
  }
  confirm = null;
  if (a.dormant) {
    api?.call("agent.forget", { agent: a.id }).then(() => { note = "forgot " + a.display; render(); }).catch((e) => { note = "✗ " + e.message; render(); });
    return render();
  }
  closing.set(a.id, kind);
  setTimeout(() => { if (closing.delete(a.id)) render(); }, 10000);
  if (kind === "close") {
    if (!a.address) { note = "✗ no window for " + a.display; return render(); }
    hypr.closeWindow(a.address).then(() => { note = "closed " + a.display; render(); }).catch((e) => { note = "✗ " + e.message; render(); });
  } else {
    try { process.kill(a.host_pid || a.pid, "SIGTERM"); note = "killed " + a.display; } catch (e) { note = "✗ " + e.message; }
    setTimeout(() => { try { process.kill(a.pid, 0); process.kill(a.pid, "SIGKILL"); } catch { /* gone */ } }, 2000);
  }
  render();
}

let lastNew = 0;
function newAgent() {
  if (Date.now() - lastNew < 2000) return;
  lastNew = Date.now();
  const cwd = loadConfig().cwd.replace(/^~(?=$|\/)/, process.env.HOME);
  const env = { ...process.env }; delete env.HYPRPI_AGENT_ID;
  spawn(new URL("../bin/hyprpi", import.meta.url).pathname, ["new", "--cwd", cwd], { detached: true, stdio: "ignore", env }).unref();
  pendingNew.push({ cwd, t: Date.now(), known: new Set(agents.map((a) => a.id)) });
  setTimeout(render, 30500);
  note = ""; render();
}

function moveCursor(d) {
  const nav = [...listHere().map((a) => a.id), ...hereProjects().map((p) => "p:" + p.id)];
  if (!nav.length) return;
  const i = nav.indexOf(cursorId);
  cursorId = nav[i < 0 ? 0 : Math.max(0, Math.min(nav.length - 1, i + d))];
  confirm = null; render();
}

function cycleRoom(d) {
  if (!rooms.length) return;
  const i = rooms.findIndex((r) => r.id === room);
  room = rooms[(i + d + rooms.length) % rooms.length].id;
  cursorId = ""; listTop = 0; confirm = null; note = ""; render();
  if (api) { loadMarks(); loadBoard(); }
}

// ---- input -----------------------------------------------------------------
process.stdin.setRawMode?.(true);
process.stdin.resume();
process.stdin.setEncoding("utf8");
// Input arrives in chunks (held keys, pastes, press + release): split into single keys first
// (the same splitter as the room panel).
const KEY = /\x1b[bfsS\x7f1-9]|\x1b\[<[\d;]+[Mm]|\x1b\[[\d;]*[A-Za-z~]|\x1bO[A-Za-z]|\x1b|[\s\S]/gu;
process.stdin.on("data", (chunk) => {
  batching = true;
  try { for (const [k] of String(chunk).matchAll(KEY)) onKey(k); }
  finally { batching = false; if (dirty) draw(); }
});
let pasting = false; // inside a bracketed paste: everything is the box's (a pasted ⏎ must not open an agent)

function onKey(d) {
  if (d === "\x1b[200~") { pasting = true; showHelp = false; box.key(d); return; }
  if (d === "\x1b[201~") { pasting = false; box.key(d); return; }
  if (pasting) { box.key(d); return; }
  const typing = box.text.length > 0;
  if (d === "\x11") return quit();                            // Ctrl+Q
  if (d === "\x03") { if (box.key(d)) return; return quit(); } // Ctrl+C: the box's copy / clear, else quit
  if (d === "\r") {                                           // ⏎: run the command, else open the agent
    if (!typing) { if (showHelp) { showHelp = false; return render(); } return enter(); }
    const t = box.text.trim(); box.clear();
    if (cmds.run(t)) return render();
    box.set(t); note = "✗ commands start with / (Tab completes · /help)"; return render();
  }
  if (d === "\t") { if (cmds.tab(box)) return render(); note = typing ? "Tab completes a /command" : "Ctrl+Tab switches world"; return render(); }
  if (typing && d === "\x1b") { if (!box.dropSelection()) box.clear(); return; } // Esc: the box's selection, else clear it
  if (!typing && (d === "/" )) { showHelp = false; box.insert(d); return; }      // a command starts
  if (typing && (d === " " || d === "\x17" || d === "\x7f" || d === "\b" || d === "\x15" || d === "\x18" || d === "\x16"
    || /^\x1b\[(1;[2356])?[CDHF]$/.test(d) || d === "\x1b[3~" || d === "\x1b\x7f" || d === "\x1b[200~" || d === "\x1b[201~"
    || !/[\x00-\x1f]/.test(d))) { if (box.key(d)) return; }                        // editing keys while typing
  if (!typing && d.length && !/[\x00-\x1f\x7f]/.test(d) && d !== " ") { showHelp = false; box.insert(d); return; } // typing starts
  if (d === " " || d === "\x1b[32;2u" || d === "\x00") return toggleMark();
  if (d === "\x01") return markAll(!(marks.all));             // Ctrl+A
  if (d === "\x1b") { if (showHelp) { showHelp = false; return render(); } confirm = null; note = ""; return markAll(true); }
  if (d === "\x0f") { showMode = (showMode + 1) % SHOW_LABEL.length; note = `agents: ${SHOW_LABEL[showMode]}`; return render(); }
  if (d === "\x17") return act("close");
  if (d === "\x0b") return act("kill");
  if (d === "\x0e") return newAgent();
  // Ctrl+Tab / Ctrl+Shift+Tab: next / previous world (plain Tab no longer does: too easy to
  // hit; the launcher maps Ctrl+Tab, which kitty would otherwise use for its own tabs).
  if (d === "\x1b[9;5u" || d === "\x1b[27;5;9~") return cycleRoom(1);
  if (d === "\x1b[9;6u" || d === "\x1b[27;6;9~" || d === "\x1b[1;5Z") return cycleRoom(-1);
  if (d === "\x1b[Z") { note = "Ctrl+Tab switches world"; return render(); }
  if (d === "\x1b[A" || d === "\x1b[1;5A") return moveCursor(-1);   // ↑ / Ctrl+↑
  if (d === "\x1b[B" || d === "\x1b[1;5B") return moveCursor(1);    // ↓ / Ctrl+↓
  if (d === "\x1b[1;5H") return moveCursor(-1e6);
  if (d === "\x1b[1;5F") return moveCursor(1e6);
  if (d === "\x1b[5~") return moveCursor(-5);
  if (d === "\x1b[6~") return moveCursor(5);
  if (d === "\x1b[H" || d === "\x1b[1~") return moveCursor(-1e6);
  if (d === "\x1b[F" || d === "\x1b[4~") return moveCursor(1e6);
  const m = d.match(/^\x1b\[<(\d+);(\d+);(\d+)([Mm])$/);       // SGR mouse
  if (m) {
    const b = Number(m[1]), y = Number(m[3]), press = m[4] === "M";
    const tab = b === 0 && press ? worldTabAt(worldBar, Number(m[2]), y, rooms.map((r) => r.id)) : null;
    if (tab) { const s = stepTo(rooms.map((r) => r.id), room, tab); if (s) cycleRoom(s); return; } // a world tab: like Ctrl+Tab
    if (b === 64 || b === 65) { listTop = Math.max(0, listTop + (b === 64 ? -1 : 1)); return render(); }
    const pid = projRowY[y];
    if (pid && press && (b === 0 || b === 16)) {
      const pj = hereProjects().find((p) => p.id === pid);
      if (!pj) return;
      // On an @member: that agent's window (click or Ctrl+click; Angus). Elsewhere on the row: the project.
      const x = Number(m[2]), hit = (projMemberX[y] || []).find((sp) => x >= sp.x0 && x <= sp.x1);
      if (hit) {
        const a = agents.find((q) => q.id === hit.id);
        if (!a) { note = `@${board.names?.[hit.id] || hit.id} isn't live`; return render(); }
        cursorId = a.id; confirm = null;
        api?.call("agent.focus", { agent: a.id }).then(() => { note = "→ " + a.display; render(); }).catch((e) => { note = "✗ " + e.message; render(); });
        return render();
      }
      if (b === 16) { cursorId = "p:" + pid; return openProject(pj); }
      if (cursorId === "p:" + pid) return markProject(pj);            // second click marks its members
      cursorId = "p:" + pid; confirm = null; return render();
    }
    if (b === 16) { // Ctrl+click: that agent, as Enter would (live: jump to it · parked: revive · closed: resume)
      const a = press && listHere()[listTop + y - listRowY];
      if (a) { cursorId = a.id; confirm = null; enter(); render(); }
      return;
    }
    if (!press || b !== 0) return;
    const a = listHere()[listTop + y - listRowY];
    if (!a) return;
    if (a.id === cursorId) return toggleMark();                 // second click marks
    cursorId = a.id; confirm = null; return render();
  }
}

function quit() { out(`${ESC}?2004l${ESC}?1002l${ESC}?1000l${ESC}?1006l${ESC}?1049l${ESC}?25h`); process.exit(0); }
process.on("SIGTERM", quit);
process.stdout.on("resize", render);
setInterval(render, 30000);

// Restart when the panel's own code changes (a hyprpi update), so it is never stale.
const CODE = [new URL("./agents-tui.mjs", import.meta.url).pathname,
  ...["client.mjs", "paths.mjs", "tui/term.mjs", "tui/input-box.mjs", "tui/command-line.mjs"].map((f) => new URL("../lib/" + f, import.meta.url).pathname)];
const codeStamp = () => CODE.map((f) => { try { return fs.statSync(f).mtimeMs; } catch { return 0; } }).join(",");
const codeAtStart = codeStamp();
setInterval(() => {
  if (restarting || codeStamp() === codeAtStart) return;
  restarting = true;
  try { api?.close?.(); } catch { /* fine */ }
  out(`${ESC}?2004l${ESC}?1002l${ESC}?1000l${ESC}?1006l${ESC}?1049l${ESC}?25h`);
  // The launcher (mockups/agents-tui) loops on exit 75: restart in place instead of stacking a
  // child each time (N19). Older windows (no loop): a child, as before.
  if (process.env.HYPRPI_AGENTS_TUI_LOOP) process.exit(75);
  spawn(process.execPath, [CODE[0], room], { stdio: "inherit", env: process.env }).on("exit", (code) => process.exit(code ?? 0));
  process.stdin.setRawMode?.(false); process.stdin.pause();
}, 3000);

out(`${ESC}?1049h${ESC}?1000h${ESC}?1002h${ESC}?1006h${ESC}?2004h`); // alt screen + mouse + bracketed paste
render();
start();
