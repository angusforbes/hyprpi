// hyprpi remote control: a small web app (phone first) to talk to a world's Thoughts agent from
// Angus's iPhone over Tailscale (Angus, 2026-10-02; board card @hyprpi-remote-control).
//
// Plain Node, no dependencies. Listens on 127.0.0.1 only; `tailscale serve` publishes it to the
// tailnet with HTTPS (see README.md). One daemon connection (lib/client.mjs) with ui.subscribe,
// relayed to the page as Server-Sent Events.
//
// Who may use it: a request that came through `tailscale serve` carries Tailscale-User-Login; it
// must be this machine's own Tailscale login (or one in HYPRPI_REMOTE_LOGINS, comma-separated).
// A request without that header must come from 127.0.0.1 (a browser on this machine).
//
//   GET  /                     the page (index.html), manifest, icon
//   GET  /api/state            worlds (colours, Thoughts busy), the desktop's active world
//   GET  /api/thoughts?world=C the thread
//   POST /api/send   {world, text}   to Thoughts, marked via "phone"
//   POST /api/stop   {world, ask?}   interrupt Thoughts (ask: it then says what got cut off)
//   GET  /lib/thoughts-lines.mjs     the thread's display rule, shared with the desktop
//   GET  /api/board?world=C    the Proj tab: each project's summary (open items only)
//   GET  /api/agents?world=C   the Agnt tab: the world's agents as the desktop agents panel lists them
//   GET  /api/stream?world=C[&agent=Name]   the Strm tab: the world's Stream (lib/stream.mjs, last 200
//                              interactions), or one agent's lines (the desktop's /stream @Name rule)
//   GET  /events               live: thoughts entries / busy, worlds, board (a card changed), agents
//   GET  /file?path=/abs/path  read-only, only under ~/Obsidian and ~/Work (links in replies)
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { connect } from "../lib/client.mjs";
import { socketPath, runtimeDir, loadConfig, wsLabel } from "../lib/paths.mjs";
import { hyprJson, subscribe as hyprSubscribe } from "../lib/hypr.mjs";
import { buildStream, streamLine, DIRECT, parseStreamFilter, resolveFilterNames, filterStream } from "../lib/stream.mjs"; // the desktop Stream panel's own timeline (J49) and @Name filter
import { worldHex, theme } from "../lib/tui/term.mjs";
import { filesRoutes } from "./files-routes.mjs"; // the Files app (J74)

const HERE = path.dirname(new URL(import.meta.url).pathname);
const HOME = os.homedir();
const PORT = Number(process.env.HYPRPI_REMOTE_PORT) || 8897;
// /file: read-only, only under these folders (J47 added Downloads and Documents, J69 Screenshots,
// J74 Phone: the Files app's upload inbox, its only write), real paths.
try { fs.mkdirSync(path.join(HOME, "Phone"), { recursive: true }); } catch { /* there */ }
const FILE_ROOTS = ["Obsidian", "Work", "Downloads", "Documents", "Screenshots", "Phone"]
  .filter((d) => d !== "Phone" || (() => { try { return !fs.lstatSync(path.join(HOME, d)).isSymbolicLink(); } catch { return false; } })()) // the upload inbox: never through a link
  .map((d) => { try { return fs.realpathSync(path.join(HOME, d)); } catch { return path.join(HOME, d); } });
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

// ---- who may use it --------------------------------------------------------------------------
function ownLogins() {
  const extra = String(process.env.HYPRPI_REMOTE_LOGINS || "").split(",").map((s) => s.trim()).filter(Boolean);
  try {
    const st = JSON.parse(execFileSync("tailscale", ["status", "--json"], { encoding: "utf8", timeout: 5000 }));
    const me = st.User?.[String(st.Self?.UserID)]?.LoginName;
    if (me) extra.push(me);
  } catch (e) { log("tailscale status failed:", e.message); }
  return new Set(extra);
}
const LOGINS = ownLogins();
log("allowed tailscale logins:", [...LOGINS].join(", ") || "(none: local only)");
// The Host names it answers to (J74 security review: DNS rebinding). A page on another site whose
// name is re-pointed at 127.0.0.1 would otherwise count as "local" and as same-origin. Only these
// hosts are served: this machine's tailnet name (any port: tailscale serve) and localhost on PORT;
// more with HYPRPI_REMOTE_HOSTS=a,b.
function ownHosts() {
  const hosts = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`, `[::1]:${PORT}`]);
  const names = new Set(String(process.env.HYPRPI_REMOTE_HOSTS || "").split(",").map((x) => x.trim().toLowerCase()).filter(Boolean));
  try {
    const st = JSON.parse(execFileSync("tailscale", ["status", "--json"], { encoding: "utf8", timeout: 5000 }));
    const dns = String(st.Self?.DNSName || "").replace(/\.$/, "").toLowerCase();
    if (dns) names.add(dns);
  } catch { /* local only */ }
  return { hosts, names };
}
const HOSTS = ownHosts();
log("hosts:", [...HOSTS.hosts, ...[...HOSTS.names].map((n) => n + "[:port]")].join(", "));
function hostOk(h) {
  h = String(h || "").toLowerCase();
  if (HOSTS.hosts.has(h)) return true;
  const name = h.replace(/:\d+$/, "");
  return HOSTS.names.has(name);
}

function allowed(req) {
  const login = req.headers["tailscale-user-login"];
  if (login) return LOGINS.has(String(login));
  const ip = req.socket.remoteAddress || "";
  // tailscale serve always adds the login header for a tailnet user; without it, local only.
  return (ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1") && !req.headers["tailscale-headers-info"];
}

// ---- the daemon ------------------------------------------------------------------------------
let api = null, listing = null;
const clients = new Set(); // SSE responses

function broadcast(event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) { try { res.write(msg); } catch { /* gone */ } }
}

const busy = new Map(); // room -> Thoughts is working (from thoughts.get and the thoughts events)

// ---- which worlds to show: the desktop bar's rule (agf.hyprwrlds, BarWidget.qml worldIds()) ----
// The bar shows worlds 1..n, n = the largest of: its "worlds" setting (shell.json; 5 here, the
// widget's default 3), the focused world, and the highest world that has a Hyprland workspace
// (Hyprland keeps a workspace while it has windows or is focused). So A–E always, and F–I while
// in use; a gap below a used world is shown too (G in use shows F), as on the bar.
const LETTERS = "ABCDEFGHI";
const SHELL_JSON = path.join(HOME, ".config/omarchy/shell.json");
function barMinWorlds() {
  try {
    const find = (o) => { if (!o || typeof o !== "object") return null; if (o.id === "agf.hyprwrlds") return o; for (const v of Object.values(o)) { const r = find(v); if (r) return r; } return null; };
    const n = Number(find(JSON.parse(fs.readFileSync(SHELL_JSON, "utf8")))?.worlds);
    return n >= 1 ? Math.min(9, n) : 3;
  } catch { return 3; }
}
// Hyprland's instance: as for the daemon socket, ours may be from an older login.
function hyprEnv() {
  const base = path.join(process.env.XDG_RUNTIME_DIR || "/tmp", "hypr");
  if (process.env.HYPRLAND_INSTANCE_SIGNATURE && fs.existsSync(path.join(base, process.env.HYPRLAND_INSTANCE_SIGNATURE))) return process.env;
  try {
    const his = fs.readdirSync(base).filter((d) => fs.existsSync(path.join(base, d, ".socket.sock"))).sort((a, b) => fs.statSync(path.join(base, b)).mtimeMs - fs.statSync(path.join(base, a)).mtimeMs)[0];
    if (his) return { ...process.env, HYPRLAND_INSTANCE_SIGNATURE: his };
  } catch { /* none */ }
  return process.env;
}
let shownWorlds = LETTERS.slice(0, 5).split(""), hyprStop = null;
async function refreshShown() {
  try {
    const env = hyprEnv(), size = Number(loadConfig()?.worldSize) || 10;
    const [wss, act] = await Promise.all([hyprJson("workspaces", { env }), hyprJson("activeworkspace", { env })]);
    const worldOf = (id) => id >= 1 ? Math.floor((id - 1) / size) + 1 : 0;
    let n = Math.max(barMinWorlds(), worldOf(act?.id || 0));
    for (const w of wss) { const k = worldOf(w.id); if (k > n && k <= 9) n = k; }
    const next = LETTERS.slice(0, Math.min(9, n)).split("");
    if (next.join("") !== shownWorlds.join("")) { shownWorlds = next; log("worlds shown:", next.join("")); broadcast("state", state()); }
    if (!hyprStop) hyprStop = hyprSubscribe((ev) => { if (/workspace|focusedmon/.test(ev)) refreshSoon(); }, env);
  } catch (e) { log("hyprland:", e.message); }
}
let refreshTimer = null;
const refreshSoon = () => { clearTimeout(refreshTimer); refreshTimer = setTimeout(refreshShown, 150); };
refreshShown();
setInterval(refreshShown, 30000); // a safety net (shell.json edits, a new Hyprland login)

function worlds() {
  const ids = new Set((listing?.rooms || []).map((r) => r.id));
  return [...ids].filter((id) => /^[A-Z]$/.test(id)).sort().map((id) => ({
    id,
    color: "#" + (worldHex(id) || "7aa2f7"),
    agents: (listing?.agents || []).filter((a) => a.room === id).length,
    thoughtsBusy: !!busy.get(id),
    // Activity dot (like the agents panel's ● and ×): an agent working, or one blocked on Angus
    // (a bonk or a ding: status "blocked" until it works again).
    working: (listing?.agents || []).filter((a) => a.room === id && !a.parked && a.status === "working").length,
    needsYou: (listing?.agents || []).filter((a) => a.room === id && !a.parked && a.status === "blocked").length,
    shown: shownWorlds.includes(id),
  }));
}
// The names the page turns into links (J45): every world's agents as the Agnt tab lists them (live,
// or lost to a restart; parked and closed ones aren't listed there), each world's Thoughts, and
// every world's open projects (as the Proj tab lists them). Matching itself is the desktop panels'
// own lib/tui/agent-click.mjs agentIn(), run in the page.
const projectNames = new Map(); // room -> [{ id, name }]
async function refreshProjects(room) {
  if (!api) return;
  try {
    const b = await api.call("board.get", { room });
    const next = (b.projects || []).filter((p) => p.status !== "archived").map((p) => ({ id: p.id, name: p.name, icon: p.icon || "📋" }));
    if (JSON.stringify(next) !== JSON.stringify(projectNames.get(room))) { projectNames.set(room, next); broadcast("state", state()); }
  } catch { /* no board */ }
}
function directory() {
  const ids = new Set((listing?.rooms || []).map((r) => r.id).filter((id) => /^[A-Z]$/.test(id)));
  const agents = [
    ...(listing?.agents || []).filter((a) => !a.parked && ids.has(a.room)),
    ...(listing?.dormant || []).filter((a) => a.kind !== "closed" && ids.has(a.room)),
  ].map((a) => ({ id: a.id, name: a.name || "", display: a.display || a.name || "", room: a.room, color: a.color || "", kind: "agent" }));
  for (const r of ids) agents.push({ id: "thoughts-" + r, name: "", display: "Thoughts-" + r, room: r, color: "", kind: "thoughts" });
  const projects = [];
  for (const [room, list] of projectNames) for (const p of list) projects.push({ ...p, display: p.name, room, kind: "project" });
  return { agents, projects };
}
function state() {
  return {
    directory: directory(),
    worlds: worlds(),
    active: listing?.active_room || "A",
    online: !!api,
    theme: { bg: "#" + (theme.background || "1a1b26"), fg: "#" + (theme.foreground || "c0caf5"), accent: "#" + (theme.accent || theme.color4 || "7aa2f7") },
  };
}

// The daemon's socket is per Hyprland instance. Run as a systemd service, our environment may be
// from an older login: then take the newest socket in the runtime dir.
function daemonSocket() {
  const p = socketPath();
  if (fs.existsSync(p)) return p;
  try {
    const dir = runtimeDir();
    const socks = fs.readdirSync(dir).filter((f) => f.endsWith(".sock")).map((f) => path.join(dir, f)).sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
    if (socks[0]) return socks[0];
  } catch { /* none */ }
  return p;
}

async function start() {
  try {
    api = await connect({
      path: daemonSocket(),
      timeout: 3000,
      onEvent: (ev, data) => {
        if (ev === "board") { broadcast("board", { room: data?.room }); if (data?.room) refreshProjects(data.room); }
        if (ev === "agents") broadcast("agents", {}); // statuses changed: the page re-fetches its Agnt lists
        if ((ev === "message" || ev === "activity" || ev === "board") && data?.room) streamSoon(data.room); // a card changed: the page re-fetches that world
        if (ev === "thoughts") {
          broadcast("thoughts", data);
          if (data?.busy !== undefined && !!data.busy !== !!busy.get(data.room)) { busy.set(data.room, !!data.busy); broadcast("state", state()); }
        }
        else if (ev === "agents") { listing = { ...listing, ...data }; broadcast("state", state()); }
      },
      onClose: () => { api = null; log("daemon connection closed; retrying"); broadcast("state", state()); setTimeout(start, 2000); },
    });
    listing = await api.call("ui.subscribe", { windows: false });
    for (const t of listing.thoughts || []) if (t.running) api.call("thoughts.get", { room: t.room, limit: 1 }).then((g) => { busy.set(t.room, !!g.busy); broadcast("state", state()); }).catch(() => {});
    log("connected to the hyprpi daemon; worlds", (listing.rooms || []).map((r) => r.id).join(""));
    for (const r of (listing.rooms || []).map((x) => x.id).filter((id) => /^[A-Z]$/.test(id))) refreshProjects(r);
    broadcast("state", state());
  } catch (e) { api = null; log("daemon not reachable:", e.message); setTimeout(start, 2000); }
}
start();

// ---- the Proj tab (J39): each project's summary only ----------------------------------------
// Angus: "just the summary not the full thing, not the entire archive": status, Where, Next items,
// Done items (current, not archived), the next first step, and the open Decide items ("Needs you").
// No archived items, no Heard, no history. Archived projects are left out.
function boardSummary(b) {
  const open = (p, sec) => (p.items || []).filter((it) => it.sec === sec && !it.archived);
  const item = (it) => ({ h: it.h, text: it.text, by: it.by?.name || "", ...(it.verified ? { verified: it.verified } : {}), ...(it.resolution ? { resolution: it.resolution } : {}), ...(it.options ? { options: it.options, recommend: it.recommend || "", default: it.default || "" } : {}), ts: it.updated || it.ts });
  return {
    room: b.room,
    projects: (b.projects || []).filter((p) => p.status !== "archived").map((p) => ({
      id: p.id, name: p.name, title: p.title || "", icon: p.icon || "📋", status: p.status || "active",
      where: p.where?.text || "", next_step: p.next_step?.text || "", updated: p.updated || 0,
      writer: b.names?.[p.writer] || "", members: (p.members || []).map((m) => b.names?.[m]).filter(Boolean),
      decide: open(p, "decide").map(item), next: open(p, "next").map(item),
      done: open(p, "done").sort((x, y) => (x.updated || x.ts) - (y.updated || y.ts)).map(item),
    })),
  };
}

// ---- the Agnt tab (J43): the world's agents as the desktop agents panel lists them -----------
// Same data and order as mockups/agents-tui.mjs (its default view): the daemon's live agents of the
// world in list order, then the ones lost to a restart (dormant, kind != "closed"); parked and
// closed ones are its ^O view, left out here. Mark: as agents-tui mark() (● working · × blocked
// = needs Angus · ✓ done, unseen · ○ idle) and ◌ for one that isn't open.
// Each agent's summary (read-only): status, topic, current job, projects, model, last room posts.
const agentMark = (a) => a.dormant || a.parked ? "◌" : a.status === "working" ? "●" : a.status === "background" ? "◐" : a.status === "blocked" ? "×" : a.status === "done" && !a.seen ? "✓" : "○";
async function agentsSummary(r) {
  const l = await api.call("list");
  const here = [...(l.agents || []).filter((a) => a.room === r && !a.parked), ...(l.dormant || []).filter((a) => a.room === r && a.kind !== "closed").map((a) => ({ ...a, dormant: true }))];
  const [board, briefs, log] = await Promise.all([
    api.call("board.get", { room: r }).catch(() => ({ projects: [] })),
    api.call("thoughts.briefs", { room: r }).catch(() => ({ briefs: [] })),
    api.call("room.read", { room: r, limit: 200 }).catch(() => ({ messages: [] })),
  ]);
  const size = Number(loadConfig()?.worldSize) || 10;
  const st = streams.get(r) || await buildStreamFor(r).catch(() => null);
  return {
    room: r,
    agents: here.map((a) => {
      const name = a.display || a.name || a.id;
      const job = [...(briefs.briefs || [])].reverse().find((b) => b.agent === name && /^(running|queued|stopped)$/.test(b.state || ""));
      return {
        id: a.id, name, icon: a.icon || "", color: a.color || "", mark: agentMark(a),
        status: a.dormant ? (a.kind === "restart" ? "lost to a restart" : "closed") : a.status || "idle",
        helpers: (a.helpers || []).map((h) => ({ description: h.description || "", type: h.type || "", startedAt: h.startedAt || 0 })), // J93 ◐
        topic: a.topic || "", ws: !a.parked && Number.isInteger(a.workspace) && a.workspace > 0 ? wsLabel(a.workspace, size) : "",
        active: a.last_did?.ts || a.left || null, // its last finished turn (since resets on a daemon restart)
        did: a.last_did?.text || "",
        model: (a.model || "").replace(/^claude-/, ""), thinking: a.thinking || "",
        job: job ? { id: job.job, version: job.version, state: job.state, goal: job.goal || "", project: job.project || "" } : null,
        projects: (board.projects || []).filter((p) => p.status !== "archived" && (p.members || []).includes(a.id)).map((p) => ({ name: p.name, icon: p.icon || "📋", writer: p.writer === a.id })),
        posts: (log.messages || []).filter((m) => m.author?.id === a.id).slice(-4).map((m) => ({ ts: m.ts, text: String(m.text || "").slice(0, 400) })),
        // Its last lines in the Stream, any kind (posts, did lines, topics, talk): every agent has some (room D #304).
        recent: st ? streamFor(st, name).slice(-5).map((it) => ({ ts: it.ts, kind: it.kind, text: String(it.text || "").slice(0, 400) })) : [],
      };
    }),
  };
}

// ---- the Strm tab (J49): the world's Stream, as the desktop Stream panel (room-tui) builds it ---
// Same data and builder: history.read (the last 200 interactions, the panel's default /history)
// and lib/stream.mjs buildStream (room posts, did lines, topics, talk, board changes, Thoughts).
// Cached per world; rebuilt (debounced) when a message / activity / board event for it arrives,
// and the page is told only when the timeline really changed.
const streams = new Map(); // room -> { items, sig }
async function buildStreamFor(r) {
  const [h, b] = await Promise.all([api.call("history.read", { room: r, interactions: 200 }), api.call("board.get", { room: r }).catch(() => ({ projects: [] }))]);
  const projects = b.projects || [], pname = (id) => projects.find((p) => p.id === id)?.name || "";
  const raw = buildStream({ msgs: h.messages || [], events: h.events || [], changes: h.changes || [], projects });
  const items = raw.map((it) => phoneRow(it, pname));
  const sig = `${items.length}|${items.at(-1)?.k || ""}|${items.at(-1)?.text?.length || 0}`;
  const old = streams.get(r);
  streams.set(r, { items, sig, raw, projects });
  if (old && old.sig !== sig) broadcast("stream", { room: r });
  return streams.get(r);
}
// One stream item as the phone's row. Besides what it shows, it carries the fields the shared
// filter (lib/stream.mjs filterStream, run in the page, J60) looks at: who (id, raw name, human),
// to, the project id, the raw text and the board line's project name.
function phoneRow(it, pname) {
  {
    const full = streamLine(it, { projectName: pname, time: false }); // "who: text [@project]", as /digest says it
    const who = it.kind === "board" ? { name: "📋 " + it.who.name, color: "" } : { name: (it.who.icon ? it.who.icon + " " : "") + it.who.name, color: it.who.color || "", human: !!it.who.human };
    // The body without the "who" lead (the row shows who in its colour); DIRECT / did / topic keep their verb.
    const body = DIRECT[it.kind] ? full.replace(/^.*?(?= (to|asks|replies to) )/, "").trim() : it.kind === "turn" ? "did: " + it.text : it.kind === "topic" ? "topic: " + it.text : it.text;
    // by: whose line it is, for "only X" in the open view: an agent, a Thoughts agent, "Angus" (his
    // messages, and prompts he sent), or whoever made a board change.
    const by = it.who.human || it.kind === "prompt" ? "Angus" : it.who.name || "";
    return { k: it.key, ts: it.ts, kind: it.kind, who, by, project: it.kind === "board" ? it.pname || "" : pname(it.project), text: body,
      f: { id: it.who.id || "", name: it.who.name || "", human: !!it.who.human, to: it.to || [], project: it.project || null, text: it.text, pname: it.pname || "" } };
  }
}
// The name pool and projects the desktop Stream panel resolves @names against (room-tui: the
// world's agents, live and parked, plus its dormant ones; the board's projects with members).
function filterPool(r, projects) {
  const agents = [...(listing?.agents || []).filter((a) => a.room === r), ...(listing?.dormant || []).filter((a) => a.room === r)].map((a) => ({ id: a.id, name: a.name || "", display: a.display || a.name || "" }));
  return { agents, projects: (projects || []).map((p) => ({ id: p.id, name: p.name, members: p.members || [], status: p.status })) };
}
// "search all history" (J60): the same filter over the world's whole history, newest 400 matches.
async function searchAll(r, q, kinds) {
  const [h, b] = await Promise.all([api.call("history.read", { room: r, since: 0 }, { timeoutMs: 60000 }), api.call("board.get", { room: r }).catch(() => ({ projects: [] }))]);
  const projects = b.projects || [], pname = (id) => projects.find((p) => p.id === id)?.name || "";
  const raw = buildStream({ msgs: h.messages || [], events: h.events || [], changes: h.changes || [], projects });
  const f = parseStreamFilter(q), pool = filterPool(r, projects);
  const res = f.names.length ? resolveFilterNames(f.names, { agents: pool.agents, projects: pool.projects, items: raw }) : null;
  const keep = new Set(filterStream(raw, f, res).map((it) => it.key));
  for (const n of f.names) { // the phone's extras (as in the page): Angus's lines, board changes made under a name
    if (n.toLowerCase() === "angus") for (const it of raw) if (it.who?.human || it.kind === "prompt") keep.add(it.key);
    for (const it of raw) if (it.kind === "board" && it.who?.name?.toLowerCase() === n.toLowerCase()) keep.add(it.key);
  }
  const ks = new Set(kinds || []);
  const hits = raw.filter((it) => keep.has(it.key) && (!ks.size || ks.has(kindGroup(it.kind))));
  return { total: hits.length, from: raw[0]?.ts || 0, items: hits.slice(-400).map((it) => phoneRow(it, pname)) };
}
// The chips' kind groups (the same in the page).
const kindGroup = (k) => k === "post" || k === "angus" || k === "thoughts" ? "posts" : k === "turn" ? "did" : k === "topic" ? "topics" : k === "board" ? "board" : ["talk", "demand", "reply", "prompt"].includes(k) ? "talk" : "other";
// One agent's lines: the desktop Stream panel's "/stream @Name" rule (lib/stream.mjs): lines by
// that agent, to it, and Angus's / prompts naming it. (Angus, room D #304: filter Strm on an agent.)
function streamFor(st, name) {
  // Angus isn't an agent, so the @Name rule can't resolve him: his lines are his room messages, the
  // prompts he sent (Angus → X) and his board changes (Angus, after J53: "stream only Angus").
  if (name === "Angus") { const keep = new Set((st.raw || []).filter((it) => it.who?.human || it.kind === "prompt").map((it) => it.key)); return st.items.filter((it) => keep.has(it.k)); }
  // Board changes carry the name of who made them, not an id: count those too (e.g. Thoughts-D's).
  const byName = new Set((st.raw || []).filter((it) => it.kind === "board" && it.who?.name === name).map((it) => it.key));
  const f = parseStreamFilter("@" + name);
  const pool = [...(listing?.agents || []), ...(listing?.dormant || [])].map((a) => ({ id: a.id, name: a.name || "", display: a.display || a.name || "" }));
  const r = resolveFilterNames(f.names, { agents: pool, projects: st.projects || [], items: st.raw || [] });
  const keep = new Set(filterStream(st.raw || [], f, r).map((it) => it.key));
  return st.items.filter((it) => keep.has(it.k) || byName.has(it.k));
}
const streamTimers = new Map();
function streamSoon(r) {
  if (!streams.has(r)) return; // nobody has asked for it yet
  clearTimeout(streamTimers.get(r));
  streamTimers.set(r, setTimeout(() => buildStreamFor(r).catch((e) => log("stream", r, e.message)), 600));
}

// ---- http ------------------------------------------------------------------------------------
const room = (w) => /^[A-Z]$/.test(String(w || "")) ? String(w) : null;
const json = (res, code, obj) => { res.writeHead(code, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }); res.end(JSON.stringify(obj)); };
async function body(req, max = 1e6) {
  let s = ""; for await (const c of req) { s += c; if (s.length > max) throw new Error("too large"); }
  return s ? JSON.parse(s) : {};
}
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json", ".webmanifest": "application/manifest+json", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml", ".pdf": "application/pdf", ".md": "text/plain; charset=utf-8", ".txt": "text/plain; charset=utf-8" };
const STATIC = { "/": "index.html", "/index.html": "index.html", "/app.js": "app.js", "/style.css": "style.css", "/manifest.webmanifest": "manifest.webmanifest", "/icon.svg": "icon.svg", "/icon-180.png": "icon-180.png", "/md.mjs": "md.mjs", "/viewer.js": "viewer.js", "/icon-192.png": "icon-192.png", "/icon-512.png": "icon-512.png", "/icon-maskable-512.png": "icon-maskable-512.png", "/favicon.png": "favicon.png",
  // the Files app (J74): its own page, manifest and icon, so it installs as a second Home Screen app
  "/files/": "files.html", "/files": "files.html", "/files.js": "files.js", "/files.css": "files.css", "/fileview.mjs": "fileview.mjs", "/files-manifest.webmanifest": "files-manifest.webmanifest",
  "/files-icon-180.png": "files-icon-180.png", "/files-icon-192.png": "files-icon-192.png", "/files-icon-512.png": "files-icon-512.png", "/files-icon-maskable-512.png": "files-icon-maskable-512.png" };

function serveFile(res, file, type, user = false) { // user: a file from /file (not the app's own)
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return json(res, 404, { error: "not found" });
    const ext = path.extname(file).toLowerCase();
    // A user's file (not the app's own): never sniffed, and anything that could run script (HTML,
    // SVG, XML, …) opens sandboxed, without script and with no access to the app (J74 security
    // review: an uploaded or shared page could otherwise use the app's token). Images and PDFs as they are.
    const extra = !user ? {} : { "x-content-type-options": "nosniff", ...(/^\.(png|jpe?g|gif|webp|pdf)$/.test(ext) ? {} : { "content-security-policy": "sandbox; default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; media-src 'self'" }) };
    res.writeHead(200, { "content-type": type || TYPES[ext] || "text/plain; charset=utf-8", "content-length": st.size, "cache-control": "no-cache", ...extra });
    const rs = fs.createReadStream(file);
    rs.on("error", () => res.destroy()); // gone or unreadable after stat: drop the response, don't crash
    rs.pipe(res);
  });
}

// /file: only real files under the allowed roots (symlinks resolved first).
// Never served, in any allowed folder (J47): a hidden path component (".x", ".env", ".ssh", .git
// internals), and anything named like a key or credential. Checked on the path as asked AND after
// symlinks are resolved, so a link can't point past the roots or at a secret under another name.
const SECRET = /\.(pem|key|p12|pfx|kdbx|keystore|jks|gpg|pgp|asc|ovpn|ppk)$|^id_(rsa|dsa|ecdsa|ed25519)|credential|secret|token|password|passwd|wallet|private[-_. ]?key/i;
const refusedPart = (seg) => seg.startsWith(".") || SECRET.test(seg);
function underRoot(p) {
  const r = FILE_ROOTS.find((x) => p === x || p.startsWith(x + path.sep));
  return r ? path.relative(r, p).split(path.sep).filter(Boolean) : null;
}
function fileAllowed(p) {
  if (p?.startsWith("~/")) p = path.join(HOME, p.slice(2));
  if (!p || !path.isAbsolute(p)) return null;
  const asked = path.resolve(p); // "../" folded away first
  const askedParts = underRoot(asked) ?? (asked.startsWith(HOME + path.sep) ? path.relative(HOME, asked).split(path.sep) : null);
  if (askedParts?.some(refusedPart)) return null;
  let real; try { real = fs.realpathSync(asked); } catch { return null; }
  const parts = underRoot(real);
  if (!parts || parts.some(refusedPart)) return null;
  return real;
}

// The vault's files by name, for /wiki (rebuilt at most once a minute; hidden folders skipped).
const VAULT = path.join(HOME, "Obsidian");
let vaultIdx = null, vaultAt = 0;
function vaultIndex() {
  if (vaultIdx && Date.now() - vaultAt < 60000) return vaultIdx;
  const idx = new Map(), walk = (d, depth) => {
    if (depth > 12) return;
    let ents = []; try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (e.name.startsWith(".")) continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p, depth + 1);
      else for (const k of [e.name.toLowerCase(), e.name.toLowerCase().replace(/\.md$/, "")]) { if (!idx.has(k)) idx.set(k, []); idx.get(k).push(p); }
    }
  };
  walk(VAULT, 0); vaultIdx = idx; vaultAt = Date.now();
  return idx;
}
function wikiFind(name, from) {
  const n = name.trim().toLowerCase().replace(/^\/+/, ""); if (!n) return null;
  const idx = vaultIndex(), base = n.split("/").pop();
  let hits = [...(idx.get(base) || []), ...(idx.get(base + ".md") || [])];
  if (n.includes("/")) hits = hits.filter((p) => p.toLowerCase().endsWith("/" + n) || p.toLowerCase().endsWith("/" + n + ".md")); // [[Folder/Note]]
  hits = [...new Set(hits)];
  if (!hits.length) return null;
  const dir = from ? path.dirname(from) : VAULT;
  hits.sort((a, b) => (path.dirname(a) === dir ? 0 : 1) - (path.dirname(b) === dir ? 0 : 1) || a.length - b.length);
  return hits[0];
}

const filesHandle = filesRoutes({ HOME, FILE_ROOTS, fileAllowed, refusedPart, underRoot, json, body, log, getApi: () => api, room });

const server = http.createServer(async (req, res) => {
  // A malformed path ("//", "//x") made new URL() throw outside any try, which killed the server
  // (systemd restarted it): any request could take it down. Refuse it instead.
  let url; try { url = new URL(req.url, "http://x"); } catch { res.writeHead(400, { "content-type": "text/plain" }); return res.end("bad request"); }
  if (!hostOk(req.headers.host)) { log("refused host", req.headers.host, url.pathname); return json(res, 421, { error: "unknown host" }); }
  if (!allowed(req)) { log("refused", req.headers["tailscale-user-login"] || req.socket.remoteAddress, url.pathname); return json(res, 403, { error: "not allowed" }); }
  // A POST must come from this page (no cross-site form posts).
  if (req.method === "POST") {
    const origin = req.headers.origin;
    let oh = null; try { oh = origin ? new URL(origin).host : null; } catch { oh = ""; } // "null" or junk: refused, not a crash
    if (origin && oh !== req.headers.host) return json(res, 403, { error: "bad origin" });
  }
  try {
    if (req.method === "GET" && STATIC[url.pathname]) return serveFile(res, path.join(HERE, STATIC[url.pathname]));
    // The thread's display rule, shared with the desktop Thoughts window (J38).
    if (req.method === "GET" && url.pathname === "/lib/thoughts-lines.mjs") return serveFile(res, path.join(HERE, "..", "lib", "thoughts-lines.mjs"), "text/javascript; charset=utf-8");
    // The desktop Stream panel's timeline + filter, as-is (pure, no imports): the Strm filter bar (J60).
    if (req.method === "GET" && url.pathname === "/lib/stream.mjs") return serveFile(res, path.join(HERE, "..", "lib", "stream.mjs"), "text/javascript; charset=utf-8");
    // The desktop panels' Ctrl+click name matcher, as-is (pure, no imports): the page's links (J45).
    if (req.method === "GET" && url.pathname === "/lib/tui/agent-click.mjs") return serveFile(res, path.join(HERE, "..", "lib", "tui", "agent-click.mjs"), "text/javascript; charset=utf-8");
    if (await filesHandle(req, res, url)) return;
    if (req.method === "GET" && url.pathname === "/api/state") return json(res, 200, state());
    if (req.method === "GET" && url.pathname === "/api/thoughts") {
      const r = room(url.searchParams.get("world")); if (!r) return json(res, 400, { error: "world?" });
      if (!api) return json(res, 503, { error: "hyprpi daemon not reachable" });
      return json(res, 200, await api.call("thoughts.get", { room: r, limit: 300 }));
    }
    if (req.method === "GET" && url.pathname === "/api/board") {
      const r = room(url.searchParams.get("world")); if (!r) return json(res, 400, { error: "world?" });
      if (!api) return json(res, 503, { error: "hyprpi daemon not reachable" });
      return json(res, 200, boardSummary(await api.call("board.get", { room: r })));
    }
    if (req.method === "GET" && url.pathname === "/api/agents") {
      const r = room(url.searchParams.get("world")); if (!r) return json(res, 400, { error: "world?" });
      if (!api) return json(res, 503, { error: "hyprpi daemon not reachable" });
      return json(res, 200, await agentsSummary(r));
    }
    if (req.method === "GET" && url.pathname === "/api/stream") {
      const r = room(url.searchParams.get("world")); if (!r) return json(res, 400, { error: "world?" });
      if (!api) return json(res, 503, { error: "hyprpi daemon not reachable" });
      const q = String(url.searchParams.get("q") || "").trim();
      if (url.searchParams.get("all") === "1") return json(res, 200, { room: r, q, ...(await searchAll(r, q, String(url.searchParams.get("kinds") || "").split(",").filter(Boolean))) });
      const st = streams.get(r) || await buildStreamFor(r);
      const agent = String(url.searchParams.get("agent") || "").trim();
      if (!agent) return json(res, 200, { room: r, items: st.items, ...filterPool(r, st.projects) });
      return json(res, 200, { room: r, agent, items: streamFor(st, agent) });
    }
    if (req.method === "POST" && url.pathname === "/api/send") {
      const b = await body(req), r = room(b.world), text = String(b.text || "").trim();
      if (!r || !text) return json(res, 400, { error: "world and text needed" });
      if (!api) return json(res, 503, { error: "hyprpi daemon not reachable" });
      log("send", r, JSON.stringify(text.slice(0, 80)));
      return json(res, 200, await api.call("thoughts.send", { room: r, text, via: "phone" }));
    }
    if (req.method === "POST" && url.pathname === "/api/stop") {
      const b = await body(req), r = room(b.world); if (!r) return json(res, 400, { error: "world?" });
      if (!api) return json(res, 503, { error: "hyprpi daemon not reachable" });
      return json(res, 200, await api.call("thoughts.interrupt", { room: r, ask: !!b.ask }));
    }
    if (req.method === "GET" && url.pathname === "/events") {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive", "x-accel-buffering": "no" });
      res.write(`retry: 2000\nevent: state\ndata: ${JSON.stringify(state())}\n\n`);
      clients.add(res);
      const ping = setInterval(() => { try { res.write(": ping\n\n"); } catch { /* gone */ } }, 20000);
      req.on("close", () => { clearInterval(ping); clients.delete(res); });
      return;
    }
    if (req.method === "GET" && url.pathname === "/file") {
      const real = fileAllowed(url.searchParams.get("path"));
      if (!real) return json(res, 404, { error: "not found or not allowed" });
      // A Markdown file opens rendered (J56): the viewer page, which fetches the text with raw=1
      // (the same guard) and draws it. raw=1 gives the text itself.
      if (/\.(md|markdown)$/i.test(real) && url.searchParams.get("raw") !== "1") return serveFile(res, path.join(HERE, "viewer.html"));
      return serveFile(res, real, undefined, true);
    }
    // [[wiki links]] in Obsidian notes (J56): the note (or embedded file) of that name in the vault,
    // nearest to the note it's linked from; then /file as usual (same guard).
    if (req.method === "GET" && url.pathname === "/wiki") {
      const found = wikiFind(String(url.searchParams.get("name") || ""), String(url.searchParams.get("from") || ""));
      if (!found) { res.writeHead(404, { "content-type": "text/plain; charset=utf-8" }); return res.end(`Not found in the vault: ${url.searchParams.get("name") || ""}`); }
      res.writeHead(302, { location: "/file?path=" + encodeURIComponent(found) }); return res.end();
    }
    json(res, 404, { error: "not found" });
  } catch (e) { json(res, 500, { error: e.message }); }
});
server.listen(PORT, "127.0.0.1", () => log(`hyprpi remote control on http://127.0.0.1:${PORT}/`));
