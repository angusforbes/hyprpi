#!/usr/bin/env node
// Summon pop-up (SUPER+S; Angus, 2026-09-30, "summon & dismiss" v1): THIS world's agents and projects,
// needs-you first, then most recent. Enter summons the row (or the Tab-marked rows) to the workspace
// you're on; this workspace's earlier unpinned guests go home first. A project brings its live members.
// SUPER+D sends the focused guest home, SUPER+ALT+D all unpinned guests, SUPER+ALT+S pins / unpins.
//   type to filter · ↑↓ / ^P ^N move · Tab mark (several come together) · Enter summon · Esc close
// Launched by mockups/summon (a small floating kitty, class hyprpi.summon).
import { request } from "../lib/client.mjs";
import { loadConfig, wsLabel } from "../lib/paths.mjs";
import { ESC, out, worldFg, fg, dim, bold, nameFg, width, clip, theme, rgb } from "../lib/tui/term.mjs";
import { markOf, projMark, byNeedThenRecent, since, lastTurns } from "../lib/tui/rows.mjs";

const WORLD_SIZE = loadConfig().worldSize || 10;
let rows = [], room = "", here = 0, query = "", cur = 0, top = 0, note = "", busy = false;
const marked = new Set();

async function load() {
  const rc = await request("room.current", {});
  room = rc.room; here = rc.workspace;
  const [l, b] = await Promise.all([request("list"), request("board.get", { room }).catch(() => ({ projects: [] }))]);
  const turns = lastTurns(), byId = Object.fromEntries((l.agents || []).map((a) => [a.id, a]));
  const agents = (l.agents || []).filter((a) => a.room === room && !a.parked);
  const ar = agents.map((a) => ({ kind: "agent", key: a.id, sort: a.display, mark: markOf(a), recent: turns[a.id] || a.since || 0,
    icon: a.icon || "🤖", name: a.display, a, loc: Number.isInteger(a.workspace) && a.workspace > 0 ? wsLabel(a.workspace, WORLD_SIZE) : room, isHere: a.workspace === here }));
  const pr = (b.projects || []).filter((p) => p.status !== "archived" && (p.members || []).some((id) => agents.some((a) => a.id === id)))
    .map((p) => ({ kind: "project", key: p.id, sort: p.name, mark: projMark(p, byId), recent: p.updated || p.created || 0, icon: p.icon || "📋", name: "@" + p.name, p, loc: room }));
  rows = [...ar.sort(byNeedThenRecent), ...pr.sort(byNeedThenRecent)];
}

const shown = () => { const q = query.toLowerCase(); return q ? rows.filter((r) => r.name.toLowerCase().includes(q) || r.loc.toLowerCase().includes(q)) : rows; };

function draw() {
  const W = process.stdout.columns || 60, H = process.stdout.rows || 20, list = shown();
  cur = Math.max(0, Math.min(cur, list.length - 1));
  const avail = Math.max(1, H - 3);
  if (cur < top) top = cur; if (cur >= top + avail) top = cur - avail + 1;
  const c = worldFg(room), sel = theme.selection ? `${ESC}48;2;${rgb(theme.selection)}m` : `${ESC}7m`;
  const lines = [fg(c, bold(`summon to ${wsLabel(here, WORLD_SIZE)} ❯ `)) + query + `${ESC}7m ${ESC}27m`];
  if (!list.length) lines.push(dim("  nothing matches"));
  list.slice(top, top + avail).forEach((r, i) => {
    const idx = top + i, mk = marked.has(r.key) ? fg(c, bold("▸")) : " ";
    const name = r.kind === "agent" ? nameFg(r.a.name, r.a.color, r.name) : fg(c, bold(r.name));
    let line = `${mk}${fg(c, bold(r.mark))} ${r.icon} ${name} ${dim("·")} ${fg(worldFg(room), r.loc)}${r.recent ? " " + dim("· " + since(r.recent)) : ""}${r.isHere ? " " + dim("(here)") : ""}`;
    line = clip(line, W);
    lines.push(idx === cur ? sel + line + " ".repeat(Math.max(0, W - width(line))) + `${ESC}49m${ESC}27m` : line);
  });
  while (lines.length < H - 1) lines.push("");
  lines.push(dim(clip(note || (busy ? "summoning…" : `Tab mark${marked.size ? ` (${marked.size})` : ""} · ⏎ summon · Esc close`), W)));
  out(`${ESC}?2026h${ESC}H` + lines.slice(0, H).map((l) => l + `${ESC}0m${ESC}K`).join("\r\n") + `${ESC}?2026l`);
}

async function summon() {
  const list = shown(), pick = marked.size ? rows.filter((r) => marked.has(r.key)) : list[cur] ? [list[cur]] : [];
  if (!pick.length) return;
  busy = true; draw();
  try {
    const r = await request("guest.summon", { auto: true, workspace: here, agents: pick.filter((x) => x.kind === "agent").map((x) => x.key), projects: pick.filter((x) => x.kind === "project").map((x) => x.key) }, { timeoutMs: 20000 });
    quit(0, r);
  } catch (e) { busy = false; note = "✗ " + e.message; draw(); }
}

function quit(code = 0) { out(`${ESC}?1049l${ESC}?25h`); process.exit(code); }

process.stdin.setRawMode?.(true); process.stdin.resume(); process.stdin.setEncoding("utf8");
const KEY = /\x1b\[[\d;]*[A-Za-z~]|\x1bO[A-Za-z]|\x1b|[\s\S]/gu;
process.stdin.on("data", (chunk) => {
  for (const [d] of String(chunk).matchAll(KEY)) {
    if (busy) continue;
    if (d === "\x1b" || d === "\x03" || d === "\x11") return quit(0);
    if (d === "\r") { summon(); continue; }
    if (d === "\t") { const r = shown()[cur]; if (r) { marked.has(r.key) ? marked.delete(r.key) : marked.add(r.key); cur++; } note = ""; continue; }
    if (d === "\x1b[A" || d === "\x10") { cur--; continue; }
    if (d === "\x1b[B" || d === "\x0e") { cur++; continue; }
    if (d === "\x7f" || d === "\b") { query = [...query].slice(0, -1).join(""); cur = 0; top = 0; continue; }
    if (d === "\x15") { query = ""; cur = 0; top = 0; continue; }
    if (!/[\x00-\x1f]/.test(d) && !d.startsWith("\x1b")) { query += d; cur = 0; top = 0; }
  }
  draw();
});
process.stdout.on("resize", draw);

if (process.argv.includes("--list")) { // for tests: print the rows
  await load();
  for (const r of rows) console.log(`${r.mark} ${r.icon} ${r.name} · ${r.loc}${r.recent ? " · " + since(r.recent) : ""}${r.isHere ? " (here)" : ""}`);
  process.exit(0);
}
out(`${ESC}?1049h${ESC}?25l`);
try { await load(); } catch (e) { note = "✗ " + e.message; }
draw();
