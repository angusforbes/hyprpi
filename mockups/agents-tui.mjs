#!/usr/bin/env node
// Panel 1 of three (docs/panels-plan.md): the hyprpi AGENT PANEL, SUPER+ALT+A.
// A view of one world's agents and a selector — no messages, no stream, no search.
//
//   ~/Work/hyprpi/mockups/agents-tui [ROOM]     (kitty launcher)
//
// Rows: ● working · ✓ finished (unseen) · × blocked · ○ idle, then the name, topic and
// model. Greyed ◌ rows are agents that are not open: "closed" (lost to a reboot, or
// closed/killed while hyprpi ran) and "parked" (Reprieve, SUPER+W: still running, out
// of every room). Ctrl+O cycles: live · + parked.
//   Ctrl+↑↓ (or ↑↓) / click / wheel   move the cursor · PgUp PgDn · Home End / Ctrl+Home End
//   Enter                live: jump to its window · parked: revive it here · closed: resume it
//   Space / Shift+Space  mark ▸ (the shared per-room selection every panel uses)
//   Ctrl+A               mark all / none      Esc  mark all again
//   Ctrl+W / Ctrl+K      close / kill (twice); on a closed agent: forget it
//   Ctrl+N               new agent here       Tab / Shift+Tab  switch world
//   Ctrl+Q               quit
// Later: a 🎤 column for dictation targets, and commands that act on the selection.
import fs from "node:fs";
import { spawn } from "node:child_process";
import { connect } from "../lib/client.mjs";
import { loadConfig } from "../lib/paths.mjs";
import * as hypr from "../lib/hypr.mjs";
import { ESC, out, theme, onThemeChange, rgb, worldFg, worldBg, dim, midFg, bold, fg,
  markupFg, unnamed, nameFg, width, cut, clip } from "../lib/tui/term.mjs";

// ---- state -----------------------------------------------------------------
let agents = [], dormant = [], rooms = [], room = (process.argv[2] || "").toUpperCase();
let marks = { all: true, agents: [] };      // the daemon's per-room selection
let cursorId = "", listTop = 0, listRows = 0, listRowY = 0;
let note = "", online = false, confirm = null, api = null, restarting = false;
let showMode = 0;                            // 0 = live (+ lost to a restart), 1 = + parked/closed
const SHOW_LABEL = ["live", "+ parked"];
const closing = new Map();                   // id -> "close" | "kill" while we wait for the daemon
let pendingNew = [];

const hereLive = () => agents.filter((a) => a.room === room);
const hereParked = () => showMode >= 1 ? agents.filter((a) => a.parked && (!a.parked_from || a.parked_from === room)) : [];
const hereDormant = () => dormant.filter((a) => a.room === room && (a.kind !== "closed" || showMode >= 1));
const listHere = () => [...hereLive(), ...hereParked(), ...hereDormant()];
const byId = (id) => listHere().find((a) => a.id === id);
const isMarked = (id) => marks.all || marks.agents.includes(id);

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

  if (!here.find((a) => a.id === cursorId)) cursorId = here[0]?.id || "";
  const cur = Math.max(0, here.findIndex((a) => a.id === cursorId));
  listRows = Math.max(1, Math.min(here.length, H - 4));
  if (cur < listTop) listTop = cur;
  if (cur >= listTop + listRows) listTop = cur - listRows + 1;
  listTop = Math.max(0, Math.min(listTop, Math.max(0, here.length - listRows)));
  const nMarked = live.filter((a) => isMarked(a.id)).length;
  const hidden = here.length - listTop - listRows;
  rows.push(rule(`agents · room ${room} · ${SHOW_LABEL[showMode]} (^O)`
    + (here.length > listRows ? ` · ${listTop ? "↑" + listTop + " " : ""}${hidden > 0 ? "↓" + hidden : ""}` : "")
    + (nMarked === live.length ? "" : ` · ${nMarked}/${live.length} ▸ · Esc all`)));
  listRowY = rows.length + 1;

  const nameW = Math.min(24, Math.max(6, ...here.map((a) => width((a.icon ? a.icon + " " : "") + a.display))));
  const nameBg = theme.muted || theme.selection;
  if (!here.length) rows.push(dim("  no agents here · ^N opens one"));
  for (const a of here.slice(listTop, listTop + listRows)) {
    const name = cut((a.icon ? a.icon + " " : "") + a.display, nameW);
    const iconPart = a.icon && name.startsWith(a.icon + " ") ? a.icon + " " : "";
    const bare = name.slice(iconPart.length);
    const model = (a.model || "").replace(/^claude-/, "");
    const dot = " · ";
    const rest = (a.topic ? dot + `${ESC}3m${a.topic}${ESC}23m` : "") + (model ? dot + model : "");
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
    if (closing.has(a.id)) { rows.push(dim(`  ${mark(a)} ${name} · ${closing.get(a.id) === "kill" ? "killing" : "closing"}…`)); continue; }
    rows.push(`${sel}${fg(c, bold(mark(a)))} ${styled}${rest}`);
  }
  pendingNew = pendingNew.filter((p) => Date.now() - p.t < 30000);
  for (const p of pendingNew) rows.push(dim(`  ◌ starting a new agent in ${String(p.cwd).replace(process.env.HOME, "~")} …`));

  while (rows.length < H - 2) rows.push("");
  rows.push(dim(clip(confirm ? confirm.label : note || "^↑↓ move · ⏎ open · Space ▸ · ^O views · ^N new · ^W close · Tab world · ^Q quit", W)));

  // status bar: worlds, counts
  const tabs = rooms.map((r) => r.id === room ? `${ESC}${worldBg(r.id)};30m ${r.id} ${ESC}49;39m` : ` ${fg(worldFg(r.id), r.id)} `).join("");
  const nParked = agents.filter((a) => a.parked && (!a.parked_from || a.parked_from === room)).length;
  const nClosed = dormant.filter((a) => a.room === room).length;
  const extra = [nParked && `${nParked} parked`, nClosed && `${nClosed} closed`].filter(Boolean).join(" · ");
  const left = ` agents ${online ? "" : "· daemon offline "}`;
  const right = `${live.length} live${extra ? " · " + extra : ""} `;
  const mid = W - width(left) - width(tabs.replace(/\x1b\[[0-9;]*m/g, "")) - width(right);
  rows.push(`${ESC}7m${left}${ESC}27m${tabs}${ESC}7m${" ".repeat(Math.max(0, mid))}${right}${ESC}27m`);

  out(`\x1b]2;hyprpi agents · room ${room}\x07`); // how `mockups/panels` finds this window
  out(`${ESC}H${ESC}2J` + rows.slice(0, H).map((r) => clip(r, W) + `${ESC}0m${ESC}K`).join("\r\n"));
}

// ---- daemon ----------------------------------------------------------------
let lastFocusedId = "";
function applyList(r) {
  agents = r.agents || []; dormant = r.dormant || []; rooms = r.rooms || [];
  for (const id of closing.keys()) if (!agents.find((a) => a.id === id)) closing.delete(id);
  for (const a of agents) {
    const i = pendingNew.findIndex((p) => !p.known.has(a.id));
    if (i >= 0) { pendingNew.splice(i, 1); for (const p of pendingNew) p.known.add(a.id); }
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
      },
      onClose: () => { online = false; api = null; render(); setTimeout(start, 1500); },
    });
    online = true;
    applyList(await api.call("ui.subscribe", { windows: false }));
    await loadMarks();
  } catch { online = false; render(); setTimeout(start, 1500); }
}

// ---- actions ---------------------------------------------------------------
function enter() {
  const a = byId(cursorId);
  if (!a || !api) return;
  const fail = (e) => { note = "✗ " + e.message; render(); };
  if (a.parked) return api.call("agent.unpark", { agent: a.id }).then(() => { note = "→ " + a.display + " is back"; render(); }).catch(fail), render();
  if (a.dormant) return api.call("agent.resume", { agent: a.id }).then(() => { note = "resuming " + a.display + " …"; render(); }).catch(fail), render();
  api.call("agent.focus", { agent: a.id }).then(() => { note = "→ " + a.display; render(); }).catch(fail);
}

function toggleMark() {
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
    try { process.kill(a.pid, "SIGTERM"); note = "killed " + a.display; } catch (e) { note = "✗ " + e.message; }
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
  const here = listHere();
  if (!here.length) return;
  const i = Math.max(0, here.findIndex((a) => a.id === cursorId));
  cursorId = here[Math.max(0, Math.min(here.length - 1, i + d))].id;
  confirm = null; render();
}

function cycleRoom(d) {
  if (!rooms.length) return;
  const i = rooms.findIndex((r) => r.id === room);
  room = rooms[(i + d + rooms.length) % rooms.length].id;
  cursorId = ""; listTop = 0; confirm = null; note = ""; render();
  if (api) loadMarks();
}

// ---- input -----------------------------------------------------------------
process.stdin.setRawMode?.(true);
process.stdin.resume();
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => { batching = true; try { onKey(d); } finally { batching = false; if (dirty) draw(); } });

function onKey(d) {
  if (d === "\x03" || d === "\x11") return quit();            // Ctrl+C / Ctrl+Q
  if (d === "\r") return enter();
  if (d === " " || d === "\x1b[32;2u" || d === "\x00") return toggleMark();
  if (d === "\x01") return markAll(!(marks.all));             // Ctrl+A
  if (d === "\x1b") { confirm = null; note = ""; return markAll(true); }
  if (d === "\x0f") { showMode = (showMode + 1) % SHOW_LABEL.length; note = `agents: ${SHOW_LABEL[showMode]}`; return render(); }
  if (d === "\x17") return act("close");
  if (d === "\x0b") return act("kill");
  if (d === "\x0e") return newAgent();
  if (d === "\t") return cycleRoom(1);
  if (d === "\x1b[Z") return cycleRoom(-1);
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
    if (b === 64 || b === 65) { listTop = Math.max(0, listTop + (b === 64 ? -1 : 1)); return render(); }
    if (!press || b !== 0) return;
    const a = listHere()[listTop + y - listRowY];
    if (!a) return;
    if (a.id === cursorId) return toggleMark();                 // second click marks
    cursorId = a.id; confirm = null; return render();
  }
}

function quit() { out(`${ESC}?1002l${ESC}?1000l${ESC}?1006l${ESC}?1049l${ESC}?25h`); process.exit(0); }
process.on("SIGTERM", quit);
process.stdout.on("resize", render);
setInterval(render, 30000);

// Restart when the panel's own code changes (a hyprpi update), so it is never stale.
const CODE = [new URL("./agents-tui.mjs", import.meta.url).pathname,
  ...["client.mjs", "paths.mjs", "tui/term.mjs"].map((f) => new URL("../lib/" + f, import.meta.url).pathname)];
const codeStamp = () => CODE.map((f) => { try { return fs.statSync(f).mtimeMs; } catch { return 0; } }).join(",");
const codeAtStart = codeStamp();
setInterval(() => {
  if (restarting || codeStamp() === codeAtStart) return;
  restarting = true;
  try { api?.close?.(); } catch { /* fine */ }
  out(`${ESC}?1002l${ESC}?1000l${ESC}?1006l${ESC}?1049l${ESC}?25h`);
  spawn(process.execPath, [CODE[0], room], { stdio: "inherit", env: process.env }).on("exit", (code) => process.exit(code ?? 0));
  process.stdin.setRawMode?.(false); process.stdin.pause();
}, 3000);

out(`${ESC}?1049h${ESC}?1000h${ESC}?1002h${ESC}?1006h${ESC}?25l`); // alt screen + mouse, no cursor
render();
start();
