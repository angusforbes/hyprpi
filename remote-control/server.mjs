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
import { worldHex, theme } from "../lib/tui/term.mjs";

const HERE = path.dirname(new URL(import.meta.url).pathname);
const HOME = os.homedir();
const PORT = Number(process.env.HYPRPI_REMOTE_PORT) || 8897;
const FILE_ROOTS = [path.join(HOME, "Obsidian"), path.join(HOME, "Work")];
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
        if (ev === "agents") broadcast("agents", {}); // statuses changed: the page re-fetches its Agnt lists // a card changed: the page re-fetches that world
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
const agentMark = (a) => a.dormant || a.parked ? "◌" : a.status === "working" ? "●" : a.status === "blocked" ? "×" : a.status === "done" && !a.seen ? "✓" : "○";
async function agentsSummary(r) {
  const l = await api.call("list");
  const here = [...(l.agents || []).filter((a) => a.room === r && !a.parked), ...(l.dormant || []).filter((a) => a.room === r && a.kind !== "closed").map((a) => ({ ...a, dormant: true }))];
  const [board, briefs, log] = await Promise.all([
    api.call("board.get", { room: r }).catch(() => ({ projects: [] })),
    api.call("thoughts.briefs", { room: r }).catch(() => ({ briefs: [] })),
    api.call("room.read", { room: r, limit: 200 }).catch(() => ({ messages: [] })),
  ]);
  const size = Number(loadConfig()?.worldSize) || 10;
  return {
    room: r,
    agents: here.map((a) => {
      const name = a.display || a.name || a.id;
      const job = [...(briefs.briefs || [])].reverse().find((b) => b.agent === name && /^(running|queued|stopped)$/.test(b.state || ""));
      return {
        id: a.id, name, icon: a.icon || "", color: a.color || "", mark: agentMark(a),
        status: a.dormant ? (a.kind === "restart" ? "lost to a restart" : "closed") : a.status || "idle",
        topic: a.topic || "", ws: !a.parked && Number.isInteger(a.workspace) && a.workspace > 0 ? wsLabel(a.workspace, size) : "",
        active: a.last_did?.ts || a.left || null, // its last finished turn (since resets on a daemon restart)
        did: a.last_did?.text || "",
        model: (a.model || "").replace(/^claude-/, ""), thinking: a.thinking || "",
        job: job ? { id: job.job, version: job.version, state: job.state, goal: job.goal || "", project: job.project || "" } : null,
        projects: (board.projects || []).filter((p) => p.status !== "archived" && (p.members || []).includes(a.id)).map((p) => ({ name: p.name, icon: p.icon || "📋", writer: p.writer === a.id })),
        posts: (log.messages || []).filter((m) => m.author?.id === a.id).slice(-4).map((m) => ({ ts: m.ts, text: String(m.text || "").slice(0, 400) })),
      };
    }),
  };
}

// ---- http ------------------------------------------------------------------------------------
const room = (w) => /^[A-Z]$/.test(String(w || "")) ? String(w) : null;
const json = (res, code, obj) => { res.writeHead(code, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }); res.end(JSON.stringify(obj)); };
async function body(req, max = 1e6) {
  let s = ""; for await (const c of req) { s += c; if (s.length > max) throw new Error("too large"); }
  return s ? JSON.parse(s) : {};
}
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json", ".webmanifest": "application/manifest+json", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml", ".pdf": "application/pdf", ".md": "text/plain; charset=utf-8", ".txt": "text/plain; charset=utf-8" };
const STATIC = { "/": "index.html", "/index.html": "index.html", "/app.js": "app.js", "/style.css": "style.css", "/manifest.webmanifest": "manifest.webmanifest", "/icon.svg": "icon.svg", "/icon-180.png": "icon-180.png" };

function serveFile(res, file, type) {
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return json(res, 404, { error: "not found" });
    res.writeHead(200, { "content-type": type || TYPES[path.extname(file).toLowerCase()] || "text/plain; charset=utf-8", "content-length": st.size, "cache-control": "no-cache" });
    fs.createReadStream(file).pipe(res);
  });
}

// /file: only real files under the allowed roots (symlinks resolved first).
function fileAllowed(p) {
  if (p?.startsWith("~/")) p = path.join(HOME, p.slice(2));
  if (!p || !path.isAbsolute(p)) return null;
  let real; try { real = fs.realpathSync(p); } catch { return null; }
  return FILE_ROOTS.some((r) => real === r || real.startsWith(r + path.sep)) ? real : null;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  if (!allowed(req)) { log("refused", req.headers["tailscale-user-login"] || req.socket.remoteAddress, url.pathname); return json(res, 403, { error: "not allowed" }); }
  // A POST must come from this page (no cross-site form posts).
  if (req.method === "POST") {
    const origin = req.headers.origin;
    if (origin && new URL(origin).host !== req.headers.host) return json(res, 403, { error: "bad origin" });
  }
  try {
    if (req.method === "GET" && STATIC[url.pathname]) return serveFile(res, path.join(HERE, STATIC[url.pathname]));
    // The thread's display rule, shared with the desktop Thoughts window (J38).
    if (req.method === "GET" && url.pathname === "/lib/thoughts-lines.mjs") return serveFile(res, path.join(HERE, "..", "lib", "thoughts-lines.mjs"), "text/javascript; charset=utf-8");
    // The desktop panels' Ctrl+click name matcher, as-is (pure, no imports): the page's links (J45).
    if (req.method === "GET" && url.pathname === "/lib/tui/agent-click.mjs") return serveFile(res, path.join(HERE, "..", "lib", "tui", "agent-click.mjs"), "text/javascript; charset=utf-8");
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
      return serveFile(res, real);
    }
    json(res, 404, { error: "not found" });
  } catch (e) { json(res, 500, { error: e.message }); }
});
server.listen(PORT, "127.0.0.1", () => log(`hyprpi remote control on http://127.0.0.1:${PORT}/`));
