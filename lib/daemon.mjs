// hyprpi daemon: tracks Pi agents living in their own terminal windows, groups
// them into rooms (one per hyprwrld by default), and runs each room's shared
// conversation. One daemon per Hyprland instance; NDJSON over a Unix socket.
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { socketPath, runtimeDir, stateDir, loadConfig, worldOf, wsLabel, WORLD_LETTERS, ROOT } from "./paths.mjs";
import * as hypr from "./hypr.mjs";
import { sessionEntries, keywordSearch, aiSearch } from "./search.mjs";
import { topicInput, summarize } from "./topics.mjs";
import { askRoom, activitySource } from "./ask.mjs";
import { createBoards, boardText, slugify } from "./board.mjs";

const VERSION = 1;
const STARTED = Date.now();
const HISTORY_MESSAGES = 40;
const HISTORY_BYTES = 32768;
const MAX_TEXT = 8192;

export async function runDaemon({ env = process.env, log = (...a) => console.error(new Date().toISOString(), ...a) } = {}) {
  const cfg = loadConfig();
  const SOCK = socketPath(env);
  const STATE = stateDir(env);
  fs.mkdirSync(runtimeDir(env), { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.join(STATE, "rooms"), { recursive: true });

  // Refuse to start twice. Agents all call `ensure` at once after a restart, so
  // take an exclusive pid lock first (a stale lock from a dead pid is reclaimed).
  const LOCK = SOCK.replace(/\.sock$/, ".lock");
  for (let i = 0; ; i++) {
    try { fs.writeFileSync(LOCK, String(process.pid), { flag: "wx" }); break; }
    catch (e) {
      if (e.code !== "EEXIST" || i > 3) throw e;
      const pid = Number(fs.readFileSync(LOCK, "utf8")) || 0;
      let live = false;
      try { if (pid) { process.kill(pid, 0); live = true; } } catch (k) { live = k.code === "EPERM"; }
      if (live) { log("another hyprpi daemon (pid " + pid + ") holds", LOCK); process.exit(0); }
      try { fs.unlinkSync(LOCK); } catch {}
    }
  }
  const releaseLock = () => { try { if (fs.readFileSync(LOCK, "utf8") === String(process.pid)) fs.unlinkSync(LOCK); } catch {} };
  process.on("exit", releaseLock);
  // A live socket means a daemon from before the lock existed.
  if (fs.existsSync(SOCK)) {
    const alive = await new Promise((res) => {
      const c = net.createConnection(SOCK);
      c.on("connect", () => { c.destroy(); res(true); });
      c.on("error", () => res(false));
    });
    if (alive) { log("another hyprpi daemon is running at", SOCK); process.exit(0); }
    try { fs.unlinkSync(SOCK); } catch {}
  }

  // ---------------------------------------------------------------- state ---
  const agents = new Map();      // id -> agent (live, connected)
  const conns = new Set();
  const deliveries = new Map();  // delivery_id -> { agentId, room, seq, replied }
  const requests = new Map();    // request_id -> { from, mode, recipients:Set, replies:Map }
  const rooms = new Map();       // room -> { msgs:[], next }
  const registryFile = path.join(STATE, "agents.json");
  let registry = {};
  try { registry = JSON.parse(fs.readFileSync(registryFile, "utf8")); } catch { registry = {}; }
  let activeWs = null;
  const pendingPlacement = new Map(); // room-window key -> { ws, until }
  // Workspaces whose agents are out of every room (config offLimitsWorkspaces).
  const OFFLIMITS = new Set(cfg.offLimitsWorkspaces || ["special:reprieve"]);

  const saveRegistry = debounce(() => {
    try { fs.writeFileSync(registryFile + ".tmp", JSON.stringify(registry, null, 1)); fs.renameSync(registryFile + ".tmp", registryFile); }
    catch (e) { log("registry save failed", e.message); }
  }, 500);

  function remember(a) {
    const live = agents.get(a.id) === a;
    const old = registry[a.id] || {};
    registry[a.id] = {
      id: a.id, session: a.session, cwd: a.cwd, name: a.name, nameMarkup: a.nameMarkup || "", icon: a.icon, color: a.color,
      model: a.model, thinking: a.thinking, workspace: a.workspace, room: a.room, homeRoom: a.homeRoom,
      twinOf: a.twinOf, topic: a.topic || "", topicKey: a.topicKey || "", updatedAt: Date.now(),
      // Kept so a daemon restart doesn't turn every agent idle (restored for the same pid).
      status: a.status || "idle", ack: a.ack !== false, pid: a.pid || 0, hostPid: a.hostPid || 0,
      // Resume after a restart: connected = live when last saved; leftAt = when it went away.
      // resumable = it was still open when hyprpi (the daemon / the session) went down.
      connected: live, leftAt: live ? 0 : (old.connected === false && old.leftAt) || Date.now(),
      resumable: live ? false : !!old.resumable,
      forgotten: live ? false : !!old.forgotten,
      parkedFrom: a.parkedFrom || "",
    };
    saveRegistry();
  }
  const saveRegistryNow = () => {
    try { fs.writeFileSync(registryFile + ".tmp", JSON.stringify(registry, null, 1)); fs.renameSync(registryFile + ".tmp", registryFile); } catch { /* best effort */ }
  };

  // ------------------------------------------------ resume after a restart ---
  // The daemon writes a heartbeat every 10 s (and on a clean exit). On start, an agent
  // that was still connected then, or that went away at most 30 s before the last beat
  // (a reboot / logout kills agents and daemon together), is "dormant": the room TUI
  // lists it greyed and Enter resumes its Pi session with the same id (twins stay twins).
  // A window you close while hyprpi keeps running is gone for good.
  const beatFile = path.join(STATE, "daemon.beat");
  const beat = () => { try { fs.writeFileSync(beatFile, String(Date.now())); } catch { /* best effort */ } };
  const pidIsAgent = (pid, id) => {
    if (!pid) return false;
    try { return fs.readFileSync(`/proc/${pid}/environ`, "utf8").split("\0").includes("HYPRPI_AGENT_ID=" + id); } catch { return false; }
  };
  {
    let lastBeat = 0;
    try { lastBeat = Number(fs.readFileSync(beatFile, "utf8")) || 0; } catch { /* first run */ }
    let n = 0;
    for (const r of Object.values(registry)) {
      const wasOpen = r.connected === true || (lastBeat && r.connected === false && r.leftAt >= lastBeat - 30000);
      if (!wasOpen || pidIsAgent(r.pid, r.id) || pidIsAgent(r.hostPid, r.id)) continue; // still running: it reconnects by itself
      r.resumable = true; r.connected = false; r.leftAt = r.leftAt || lastBeat || Date.now(); n++;
    }
    if (n) { log(`${n} agent(s) from the last session can be resumed`); saveRegistryNow(); }
  }
  beat();
  const beatTimer = setInterval(beat, 10000);
  const resuming = new Map(); // id -> time the resume was started (hide it meanwhile)

  // Closed while hyprpi kept running (a window closed, a kill, /quit): listed as "closed"
  // for closedHours (default 24), behind the room TUI's Ctrl+O toggle.
  const CLOSED_MS = 3600000 * (Number(cfg.closedHours) || 24);
  const isClosedRecently = (r) => r.connected === false && !r.forgotten && r.leftAt && Date.now() - r.leftAt < CLOSED_MS;
  const canResume = (r) => !!r && !agents.has(r.id) && (r.resumable || isClosedRecently(r));
  function dormantList() {
    const liveSessions = new Set([...agents.values()].map((a) => a.session).filter(Boolean));
    const bySession = new Map();
    for (const r of Object.values(registry)) {
      if (!canResume(r) || !r.session || liveSessions.has(r.session)) continue;
      if (Date.now() - (resuming.get(r.id) || 0) < 30000) continue;
      const prev = bySession.get(r.session);
      if (!prev || (r.updatedAt || 0) > (prev.updatedAt || 0)) bySession.set(r.session, r);
    }
    return [...bySession.values()].filter((r) => fs.existsSync(r.session)).sort((x, y) => (x.updatedAt || 0) - (y.updatedAt || 0)).map((r) => ({
      id: r.id, name: r.name || "", display: displayName(r), icon: r.icon || "", color: r.color || "", name_markup: r.nameMarkup || "",
      status: "closed", dormant: true, kind: r.resumable ? "restart" : "closed", model: r.model || "", thinking: r.thinking || "", topic: r.topic || "",
      cwd: r.cwd || "", session: r.session, workspace: r.workspace ?? null,
      workspace_label: Number.isInteger(r.workspace) && r.workspace > 0 ? wsLabel(r.workspace, cfg.worldSize) : "",
      room: r.room || r.parkedFrom || r.homeRoom || "", twin_of: r.twinOf || "", left: r.leftAt || 0,
    }));
  }

  // ---------------------------------------------------------------- rooms ---
  const safeRoom = (r) => String(r ?? "").replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 40) || "_";

  function roomForWorkspace(ws) {
    if (!Number.isInteger(ws) || ws < 1) return null; // special workspaces keep the last room
    for (const [name, list] of Object.entries(cfg.groups || {})) {
      if (Array.isArray(list) && list.includes(ws)) return safeRoom(name);
    }
    if (cfg.rooms === "single") return "All";
    if (cfg.rooms === "workspace") return wsLabel(ws, cfg.worldSize);
    const w = worldOf(ws, cfg.worldSize);
    return WORLD_LETTERS[w - 1] ?? `W${w}`;
  }

  function roomLog(room) {
    room = safeRoom(room);
    let r = rooms.get(room);
    if (r) return r;
    r = { msgs: [], next: 1 };
    try {
      for (const line of fs.readFileSync(path.join(STATE, "rooms", `${room}.jsonl`), "utf8").split("\n")) {
        if (!line.trim()) continue;
        try { const m = JSON.parse(line); r.msgs.push(m); r.next = Math.max(r.next, m.seq + 1); } catch { /* skip */ }
      }
    } catch { /* new room */ }
    rooms.set(room, r);
    return r;
  }

  function appendMessage(room, msg) {
    const r = roomLog(room);
    const m = { seq: r.next++, ts: Date.now(), room: safeRoom(room), ...msg };
    r.msgs.push(m);
    fs.appendFileSync(path.join(STATE, "rooms", `${safeRoom(room)}.jsonl`), JSON.stringify(m) + "\n");
    broadcastUi("message", m);
    return m;
  }

  // A room's searchable sources: its agents' conversations (live and past) and the room log.
  // only: agent ids to restrict to (the room TUI's marked agents; an unknown id like "-none-" =
  // nobody): their conversations and room posts, plus Angus's room posts.
  // closed: false = live agents only (the room TUI); default true also searches agents
  // that have closed but were last in this room (their registry entry keeps the room).
  // roomLog: false = agents' conversations only (the room TUI's search).
  function roomSources(room, only = null, { closed = true, roomLog: withLog = true } = {}) {
    const keep = only && only.length ? new Set(only) : null;
    const sources = [];
    const seenSessions = new Set();
    for (const a of agents.values()) {
      if (a.room !== room || !a.session || (keep && !keep.has(a.id))) continue;
      seenSessions.add(a.session);
      sources.push({ key: a.id, kind: "agent", name: displayName(a), icon: a.icon, color: a.color, live: true, entries: sessionEntries(a.session) });
    }
    for (const r of closed ? Object.values(registry) : []) {
      if (r.room !== room || !r.session || seenSessions.has(r.session) || agents.has(r.id) || (keep && !keep.has(r.id))) continue;
      seenSessions.add(r.session);
      sources.push({ key: r.id, kind: "agent", name: r.name || `pi·${r.id.slice(-4)}`, icon: r.icon, color: r.color, live: false, entries: sessionEntries(r.session) });
    }
    // Angus's own posts always stay in (the room TUI shows them whatever is marked).
    if (!withLog) return sources;
    const log = roomLog(room).msgs.filter((m) => m.author?.kind === "human" || ((!keep || keep.has(m.author?.id)) && (closed || agents.has(m.author?.id)))).map((m) => ({ eid: String(m.seq), role: m.author?.kind === "agent" ? "room" : "angus", ts: m.ts, text: `${m.author?.name || "?"}: ${m.text}` }));
    sources.push({ key: `room-${room}`, kind: "room", name: `Room ${room}`, icon: "💬", color: "", live: true, entries: log });
    return sources;
  }

  // ------------------------------------------------------------- activity ---
  // The room's activity stream: what agents are doing (tools, topic changes, talk between
  // agents, finishes), shown with the room's messages in the room TUI. Never part of any
  // agent's context. ~/.local/state/hyprpi/activity/<room>.jsonl. Config: activity (default true).
  const ACTIVITY = path.join(STATE, "activity");
  const actTails = new Map(); // room -> last events (read lazily from the file)
  const gist = (t, n = 140) => { const s = String(t ?? "").replace(/\s+/g, " ").trim(); return s.length > n ? s.slice(0, n - 1) + "…" : s; };
  function activityTail(room) {
    room = safeRoom(room);
    let t = actTails.get(room);
    if (t) return t;
    t = [];
    try {
      const f = path.join(ACTIVITY, `${room}.jsonl`), size = fs.statSync(f).size;
      const fd = fs.openSync(f, "r"), n = Math.min(size, 512 * 1024), buf = Buffer.alloc(n);
      try { fs.readSync(fd, buf, 0, n, size - n); } finally { fs.closeSync(fd); }
      for (const line of buf.toString("utf8").split("\n").slice(size > n ? 1 : 0)) {
        if (!line.trim()) continue;
        try { t.push(JSON.parse(line)); } catch { /* skip */ }
      }
    } catch { /* none yet */ }
    t = t.slice(-500);
    actTails.set(room, t);
    return t;
  }
  // Every activity event of a room (the whole file; activityTail() keeps only the last 500).
  function activityAll(room) {
    const out = [];
    try {
      for (const line of fs.readFileSync(path.join(ACTIVITY, `${safeRoom(room)}.jsonl`), "utf8").split("\n")) {
        if (!line.trim()) continue;
        try { out.push(JSON.parse(line)); } catch { /* skip */ }
      }
    } catch { /* none yet */ }
    return out;
  }
  // History window for the room TUI and /ask: the last N "interactions", where an interaction
  // is a room message or one agent turn (all of that agent's activity up to its "done", however
  // many tool calls). Returns the start time of the oldest one kept (0 = everything).
  function historySince(room, n, acts = activityAll(room)) {
    if (n === "all" || !(Number(n) > 0)) return 0;
    const starts = roomLog(room).msgs.map((m) => m.ts);
    const open = new Map(); // agent id -> first event ts of its current turn
    for (const e of acts) {
      const id = e.agent?.id || "?";
      // Older logs miss some "done"s (daemon restarts): a new prompt to the agent also starts a turn.
      if (e.kind === "prompt" && open.has(id)) { starts.push(open.get(id)); open.delete(id); }
      if (!open.has(id)) open.set(id, e.ts);
      if (e.kind === "done") { starts.push(open.get(id)); open.delete(id); }
    }
    for (const t of open.values()) starts.push(t); // turns still running
    if (starts.length <= n) return 0;
    starts.sort((a, b) => b - a);
    return starts[Number(n) - 1];
  }

  // Messages (talk / demand / reply / Angus's direct prompts) keep their text (up to 4000 chars);
  // everything else is one short line (200).
  const FULL_TEXT = new Set(["talk", "demand", "reply", "prompt"]);
  function recordActivity(a, kind, text, extra = {}, inRoom = null) {
    if (cfg.activity === false || !a) return;
    if (!inRoom && (!a.room || a.parked)) return;
    text = FULL_TEXT.has(kind) ? String(text ?? "").trim().slice(0, 4000) : gist(text, 200);
    if (!text) return;
    const room = safeRoom(inRoom || a.room);
    const ev = { v: 1, ts: Date.now(), room, kind, text, agent: { id: a.id, name: displayName(a), icon: a.icon || "", color: a.color || "", markup: a.nameMarkup || "" }, ...extra };
    const t = activityTail(room);
    t.push(ev); if (t.length > 600) t.splice(0, t.length - 500);
    try { fs.mkdirSync(ACTIVITY, { recursive: true }); fs.appendFileSync(path.join(ACTIVITY, `${room}.jsonl`), JSON.stringify(ev) + "\n"); }
    catch (e) { log("activity write failed:", e.message); }
    broadcastUi("activity", ev);
  }

  const wsName = (a) => Number.isInteger(a.workspace) && a.workspace > 0 ? wsLabel(a.workspace, cfg.worldSize) : String(a.workspaceName || "").replace(/^.*:/, "");

  function knownRooms() {
    const set = new Set();
    for (const a of agents.values()) if (a.room) set.add(a.room);
    for (const f of safeReaddir(path.join(STATE, "rooms"))) if (f.endsWith(".jsonl")) set.add(f.slice(0, -6));
    const cur = roomForWorkspace(activeWs);
    if (cur) set.add(cur);
    return [...set].sort().map((id) => ({
      id,
      members: [...agents.values()].filter((a) => a.room === id).map((a) => a.id),
      last_seq: roomLog(id).next - 1,
    }));
  }

  // ------------------------------------------------------------ selection ---
  // Which agents are marked (▸) in a room, shared by every panel: panel 1 (agents)
  // writes it, the room/stream panel and search read it. Per room, and only in memory:
  // it is about what you are doing now, not something to restore after a reboot.
  // A room with no entry means "all of them" (the default), so a new agent starts marked.
  const selection = new Map(); // room -> Set(agentId) | null (= all)
  const selectionView = (room) => {
    const r = safeRoom(room), sel = selection.get(r);
    const live = [...agents.values()].filter((a) => a.room === r).map((a) => a.id);
    return { room: r, all: !sel, agents: sel ? live.filter((id) => sel.has(id)) : live };
  };
  const pushSelection = (room) => broadcastUi("selection", selectionView(room));

  // --------------------------------------------------------------- agents ---
  const bare = (s) => String(s ?? "").replace(/\{#?[0-9a-fA-F]{0,6}\}/g, "").replace(/^[^\p{L}\p{N}]+/u, "").trim();
  const displayName = (a) => a.name || `pi·${a.id.slice(-4)}`;

  function view(a) {
    return {
      id: a.id, name: a.name || "", display: displayName(a), icon: a.icon || "", color: a.color || "",
      // Multicoloured name: the name with herdr-name's {#rrggbb} tags kept ("" if none).
      name_markup: a.nameMarkup || "",
      status: a.status, model: a.model || "", thinking: a.thinking || "", topic: a.topic || "",
      cwd: a.cwd || "", session: a.session || "", pid: a.pid, host_pid: a.hostPid || 0, container: a.container || "",
      address: a.address || "", workspace: a.workspace ?? null,
      workspace_label: Number.isInteger(a.workspace) && a.workspace > 0 ? wsLabel(a.workspace, cfg.worldSize) : (a.workspaceName || ""),
      room: a.room || "", parked: !!a.parked, parked_from: a.parkedFrom || "", twin_of: a.twinOf || "", since: a.createdAt, active: a.lastActive,
      focused: !!a.focused, seen: !(a.status === "done" || a.status === "blocked") || !!a.ack,
    };
  }
  const agentList = () => [...agents.values()].sort((x, y) => x.createdAt - y.createdAt).map(view);

  function findAgent(who, { exclude } = {}) {
    const w = String(who ?? "").trim();
    if (!w) return { error: "no agent given" };
    if (agents.has(w)) return { agent: agents.get(w) };
    const key = bare(w).toLowerCase();
    const hits = [...agents.values()].filter((a) => a.id !== exclude && (
      bare(a.name).toLowerCase() === key || displayName(a).toLowerCase() === key || a.address === w));
    if (hits.length === 1) return { agent: hits[0] };
    if (hits.length > 1) return { error: `ambiguous agent '${w}' (${hits.map((a) => a.id).join(", ")})` };
    return { error: `no live agent named '${w}'` };
  }

  function send(conn, event, data) {
    if (conn && !conn.sock.destroyed) conn.sock.write(JSON.stringify({ event, data }) + "\n");
  }
  function sendAgent(a, event, data) {
    if (!a?.conn || a.conn.sock.destroyed) return false;
    send(a.conn, event, data);
    return true;
  }
  // Tell an agent its own identity (name, colours, room) when that changes, so
  // its window can show it.
  function pushSelf(a) {
    const key = `${a.name}|${a.nameMarkup}|${a.icon}|${a.color}|${a.room}|${a.parked}`;
    if (a.selfKey === key) return;
    a.selfKey = key;
    sendAgent(a, "self", { name: a.name || "", display: displayName(a), markup: a.nameMarkup || "", icon: a.icon || "", color: a.color || "", room: a.room || "", parked: !!a.parked });
  }
  function broadcastUi(event, data) { for (const c of conns) if (c.ui) send(c, event, data); }
  const pushAgents = debounce(() => { for (const a of agents.values()) pushSelf(a); syncUnseen(); broadcastUi("agents", { agents: agentList(), dormant: dormantList(), rooms: knownRooms(), active_room: roomForWorkspace(activeWs), active_workspace: activeWs }); }, 80);
  // One empty file per agent window showing an unseen "done" (\u2713), named by its
  // address without 0x. The Hyprland click hook (~/.config/hypr/hyprpi.lua)
  // checks for it so ordinary clicks never spawn anything.
  const UNSEEN = path.join(runtimeDir(env), "unseen");
  const normAddr = (s) => String(s || "").toLowerCase().replace(/^0x/, "");
  function syncUnseen() {
    try {
      fs.mkdirSync(UNSEEN, { recursive: true });
      const want = new Set([...agents.values()].filter((a) => a.address && (a.status === "done" || a.status === "blocked") && !a.ack).map((a) => normAddr(a.address)));
      const mine = new Set([...agents.values()].map((a) => normAddr(a.address)).filter(Boolean));
      for (const f of fs.readdirSync(UNSEEN)) if (mine.has(f) && !want.has(f)) fs.rmSync(path.join(UNSEEN, f), { force: true });
      for (const f of want) fs.writeFileSync(path.join(UNSEEN, f), "");
    } catch (e) { log("unseen sync failed:", e.message); }
  }

  // -------------------------------------------------------------- windows ---
  let refreshing = false, again = false;
  // Agents in a container (hypr.windowForAgentId): found through a host process that carries
  // their HYPRPI_AGENT_ID (the docker client); a.hostPid caches it, and serves liveness checks.
  function windowViaHost(a, list) {
    if (a.hostPid && pidIsAgent(a.hostPid, a.id)) { const c = hypr.windowForPid(a.hostPid, list); if (c) return c; }
    const hit = hypr.windowForAgentId(a.id, list);
    a.hostPid = hit?.pid || 0;
    // Found through a docker/podman client: it runs in a container, even if its extension predates `container`.
    if (hit && !a.container) {
      let comm = "";
      try { comm = fs.readFileSync(`/proc/${hit.pid}/comm`, "utf8").trim(); } catch { /* gone */ }
      if (comm === "docker" || comm === "podman") a.container = comm;
    }
    return hit?.client || null;
  }
  async function refreshWindows() {
    if (refreshing) { again = true; return; }
    refreshing = true;
    try {
      const [list, aw, act] = await Promise.all([
        hypr.clients({ env }), hypr.activeWorkspace({ env }).catch(() => null), hypr.activeWindow({ env }).catch(() => null)]);
      if (aw && Number.isInteger(aw.id)) activeWs = aw.id;
      let changed = false;
      for (const a of agents.values()) {
        const c = hypr.windowForPid(a.pid, list) || windowViaHost(a, list);
        const ws = c?.workspace?.id ?? null;
        const before = `${a.address}|${a.workspace}|${a.room}|${a.focused}`;
        const oldRoom = a.room, oldWs = a.workspace, hadWindow = !!a.address;
        a.address = c?.address || "";
        a.workspace = ws;
        a.workspaceName = c?.workspace?.name || "";
        a.focused = !!(c && act && act.address === c.address);
        // A finished agent's "done" is marked seen by a click inside its
        // window (Hyprland click hook -> `hyprpi seen`), not by focus, which
        // follow-the-mouse hands out just by crossing the window.
        const r = roomForWorkspace(ws);
        // Off-limits workspaces (Reprieve's special:reprieve): the agent leaves
        // its room (no room panel, no room messages) until it is taken out.
        const wasParked = !!a.parked;
        a.parked = !!(c && OFFLIMITS.has(a.workspaceName));
        if (a.parked) { if (a.room) { a.parkedFrom = a.room; a.room = ""; changed = true; } }
        else {
          a.parkedFrom = "";
          if (!a.homeRoom && r) a.homeRoom = r;
          if (cfg.follow) { if (r) a.room = r; } else a.room = a.homeRoom || r || a.room;
          if (!a.room) a.room = roomForWorkspace(activeWs) || "A";
          if (wasParked) changed = true;
        }
        // Launcher asked for a workspace (e.g. a twin) and the window opened elsewhere.
        if (c && a.wantWorkspace && !a.wantDone) {
          a.wantDone = true;
          if (ws !== a.wantWorkspace) hypr.moveWindow(c.address, String(a.wantWorkspace), { env }).then(() => setTimeout(refreshWindows, 150)).catch(() => {});
        }
        if (before !== `${a.address}|${a.workspace}|${a.room}|${a.focused}`) { changed = true; remember(a); }
        // Moves (only for a window we already knew, not the first placement).
        if (hadWindow && c) {
          if (a.parked && !wasParked) recordActivity(a, "moved", "went to Reprieve (out of rooms)", {}, oldRoom);
          else if (!a.parked && wasParked) recordActivity(a, "moved", `back from Reprieve, to ${wsName(a)}`);
          else if (!a.parked && oldRoom && a.room && oldRoom !== a.room) {
            recordActivity(a, "moved", `moved to room ${a.room} (${wsName(a)})`, {}, oldRoom);
            recordActivity(a, "moved", `moved here from room ${oldRoom} (${wsName(a)})`);
          } else if (!a.parked && oldWs !== ws && oldWs != null && ws != null) recordActivity(a, "moved", `moved to workspace ${wsName(a)}`);
        }
      }
      // A room window we just asked for has mapped: make it the left-most root.
      for (const [key, want] of pendingPlacement) {
        if (Date.now() > want.until) { pendingPlacement.delete(key); continue; }
        const c = list.find((w) => (w.title || "").endsWith(" \u00b7 " + key));
        if (!c) continue;
        pendingPlacement.delete(key);
        placeLeftRoot(c, list).catch((e) => log("place failed:", e.message)).finally(() => restoreCursor(want.cursor));
      }
      if (changed) pushAgents();
      else pushAgentsIfActiveChanged();
    } catch (e) {
      log("refresh failed:", e.message);
    } finally {
      refreshing = false;
      if (again) { again = false; setTimeout(refreshWindows, 50); }
    }
  }
  // Make a room window the left-most root: full height, left side, whatever
  // the workspace's tree looked like before. movetoroot keeps the root's split
  // direction, so flip it (togglesplit) when that made us a top/bottom half.
  async function placeLeftRoot(c, list) {
    const ws = c.workspace?.id;
    const others = list.filter((w) => w.address !== c.address && w.workspace?.id === ws && !w.floating);
    if (!others.length || c.floating) return;            // alone: it simply fills the workspace
    const geo = async () => {
      const now = await hypr.clients({ env });
      const tiled = now.filter((w) => w.workspace?.id === ws && !w.floating);
      const me = tiled.find((w) => w.address === c.address);
      const rest = tiled.filter((w) => w.address !== c.address);
      if (!me || !rest.length) return null;
      return {
        me,
        fullHeight: me.at[1] <= Math.min(...rest.map((w) => w.at[1])) + 2 &&
          me.at[1] + me.size[1] >= Math.max(...rest.map((w) => w.at[1] + w.size[1])) - 2,
        left: me.at[0] <= Math.min(...rest.map((w) => w.at[0])),
      };
    };
    await hypr.focusWindow(c.address, { env });
    await hypr.dispatch('hl.dsp.layout("movetoroot")', { env });
    let g = await geo();
    if (g && !g.fullHeight) { await hypr.dispatch('hl.dsp.layout("togglesplit")', { env }); g = await geo(); }
    if (g && !g.left) { await hypr.dispatch('hl.dsp.layout("swapsplit")', { env }); g = await geo(); }
    if (g && (!g.fullHeight || !g.left)) log("room window placement incomplete", JSON.stringify({ at: g.me.at, size: g.me.size }));
  }

  // Put the pointer back now and once more after Hyprland's own
  // warp-on-workspace-change has had a chance to run.
  function restoreCursor(pos) {
    if (!pos || !Number.isFinite(pos.x)) return;
    const put = () => hypr.moveCursor(pos.x, pos.y, { env }).catch(() => {});
    put(); setTimeout(put, 120);
  }

  let lastActiveRoom = null;
  function pushAgentsIfActiveChanged() {
    const r = roomForWorkspace(activeWs);
    if (r !== lastActiveRoom) { lastActiveRoom = r; pushAgents(); }
  }
  const refreshSoon = debounce(refreshWindows, 60);
  const stopEvents = hypr.subscribe((ev) => {
    if (/^(openwindow|closewindow|movewindow|movewindowv2|workspace|workspacev2|focusedmon|activewindow|activewindowv2|changefloatingmode|windowtitle|windowtitlev2)$/.test(ev)) refreshSoon();
  }, env);
  const poll = setInterval(refreshWindows, 5000);

  // ---------------------------------------------------------------- tinker ---
  // /tinker: Angus drops off a piece of friction (a panel, a key, the bar) and goes
  // back to his work. The job goes to ONE free agent in the workshop world's room
  // (cfg.workshop, e.g. "D"), never to the whole room (two agents fixing the same
  // thing). No free agent: it waits in a queue and a new agent opens in the workshop
  // world (without taking focus); the queue drains as agents there become free.
  const TINKER_FILE = path.join(STATE, "tinker-queue.json");
  let tinkerQueue = [];
  try { tinkerQueue = JSON.parse(fs.readFileSync(TINKER_FILE, "utf8")) || []; } catch { /* none */ }
  const saveTinker = () => { try { fs.writeFileSync(TINKER_FILE, JSON.stringify(tinkerQueue)); } catch (e) { log("tinker queue write failed:", e.message); } };
  let tinkerSpawnedAt = 0;
  // "/tinker D: text" sets the workshop world and remembers it here (wins over the config),
  // so it is said once and never needs a config edit.
  const WORKSHOP_FILE = path.join(STATE, "workshop.json");
  try { const w = JSON.parse(fs.readFileSync(WORKSHOP_FILE, "utf8"))?.workshop; if (w) cfg.workshop = w; } catch { /* config value */ }
  const workshopRoom = () => cfg.workshop ? safeRoom(cfg.workshop) : "";
  function workshopWorkspace() { // first workspace of the workshop world (or of its group)
    const w = String(cfg.workshop || "");
    const g = cfg.groups?.[w];
    if (Array.isArray(g) && g.length) return Math.min(...g.filter(Number.isInteger));
    const i = WORLD_LETTERS.indexOf(w.toUpperCase());
    return i >= 0 ? i * (cfg.worldSize || 10) + 1 : null;
  }
  function tinkerPrompt(job) {
    const from = job.from ? `from ${job.from.name}${job.from.room ? ` in room ${job.from.room}` : ""}${job.from.cwd ? ` · ${job.from.cwd}` : ""}` : `via ${job.via || "cli"}`;
    return `[hyprpi tinker · dropped off by Angus ${from} · the workshop is world ${workshopRoom()}]\n${job.text}\n\n` +
      "This is a drop-off: Angus has gone back to his own work and is not watching. Finish it end to end yourself: " +
      "read the matching notes in ~/.pi/agent/notes/ first, verify the fix, and commit if it is in a repo (only your own files). " +
      "If it is a thought rather than a fix (how to organise something, an idea), think it through, write the proposal to ~/Obsidian/Tinker/<YYYY-MM-DD> <short title>.md " +
      "(what you'd do, the options, your recommendation, what you already built), build only the uncontroversial part, and post \"🔧 plan:\" with a one-line summary and a file:/// link to it. " +
      "Decisions: make small, reversible ones yourself and list each one in your result under \"Decided for you:\" with how to undo it. " +
      "Do NOT make the ones that are hard to undo or are his call (pushing or publishing anywhere public, sending anything to other people, deleting or rewriting his data, " +
      "changing how he works day to day, choosing between designs that differ in what he'd see); do everything that doesn't depend on it, then post " +
      "\"🔧 decide:\" with the question, the options and your recommendation (for anything longer than a few lines, write it to ~/Obsidian/Tinker/ as above and link it), and stop. " +
      "Don't bonk or ding yourself: a 🔧 decide post dings Angus (a decision is needed), a 🔧 plan / stuck post bonks him, automatically, and each is copied to the room the drop-off came from. " +
      `When finished, room_post a short result in room ${workshopRoom()} starting with "🔧 done:" (or "🔧 plan:" / "🔧 decide:" / "🔧 stuck:").`;
  }
  // chime = an agent went from working to done. The daemon plays it itself, so it sounds whichever
  // panels are open (the Quickshell room UI no longer plays "done"). Every finish chimes, even
  // several at once (Angus: fine); chimeGapSec > 0 would allow at most one per that many seconds.
  let lastChime = 0;
  function chime() {
    if (cfg.chime === false) return;
    const now = Date.now();
    if (now - lastChime < (Number(cfg.chimeGapSec) || 0) * 1000) return;
    lastChime = now;
    try {
      spawn("paplay", [path.join(ROOT, "assets/sounds/done.mp3")], { detached: true, stdio: "ignore" }).on("error", (e) => log("chime failed:", e.message)).unref();
    } catch (e) { log("chime failed:", e.message); }
  }
  // Getting Angus's attention on behalf of agent `a`. The three agent sounds (his names, 2026-09-28):
  //   bonk  = he asked to be told, or the agent thinks it's urgent: bonkFor(a, text). Two knocks,
  //           "Agent X needs you" toast; the agent shows × until it works again.
  //   ding  = a decision is needed from him: dingFor(a, text, { itemId }). The decision bell (`ding`; Angus
  //           2026-09-29: bell for decide, knocks for the rest; a click focuses the agent),
  //           "Agent X needs a decision from you" toast, right away (no delay); × until the
  //           decision is resolved: clearDing(a, itemId). THE hook for the board's Decide section:
  //           dingFor when an item is added, clearDing when Angus resolves it. Tinker "🔧 decide:"
  //           posts use itemId "tinker". remindAfterMin: ding once more if still open (off).
  //   chime = an agent went from working to done: chime() above, from agent.update.
  function runBonk(a, argv, { ownStatus = false } = {}) {
    try {
      // BONK_FOCUS_AGENT: clicking the toast runs `hyprpi focus <id>` (Angus 2026-09-29: take me to the agent).
      const env = { ...process.env, HYPRPI_AGENT_ID: a.id, BONK_FOCUS_AGENT: a.id };
      if (ownStatus) { // the daemon sets the × itself, so it knows this block is a decision's
        delete env.HYPRPI_AGENT_ID;
        env.BONK_NAME = `${a.icon ? a.icon + " " : ""}${displayName(a)}`;
      }
      spawn(path.join(process.env.HOME || "", ".local/bin/bonk"), argv, { detached: true, stdio: "ignore", env }).on("error", () => {}).unref();
    } catch (e) { log("bonk failed:", e.message); }
  }
  function bonkFor(a, text) {
    runBonk(a, [String(text || "").slice(0, 200)]);
  }
  function dingFor(a, text, { itemId = "", remindAfterMin = 0 } = {}) {
    const msg = String(text || "").slice(0, 200);
    runBonk(a, ["--ding", msg], { ownStatus: true });
    (a.openDings ||= new Set()).add(itemId || "ding");
    if (a.status !== "blocked") {
      a.status = "blocked"; a.ack = false;
      recordActivity(a, "blocked", `needs a decision: ${msg}`);
      remember(a); pushAgents();
    }
    if (remindAfterMin > 0) setTimeout(() => {
      if (agents.get(a.id) === a && a.openDings?.has(itemId || "ding")) dingFor(a, `still open: ${msg}`, { itemId });
    }, remindAfterMin * 60000).unref?.();
  }
  // Angus resolved a decision: drop it; the × clears only when the agent has no other open
  // decision and was not also blocked by something else (a plain bonk).
  function clearDing(a, itemId = "") {
    if (!a?.openDings) return;
    a.openDings.delete(itemId || "ding");
    if (!a.openDings.size && a.status === "blocked" && !a.otherBlock) {
      a.status = "idle"; a.ack = true;
      remember(a); pushAgents();
    }
  }
  // A tinker agent's "🔧 done: / plan: / decide: / stuck:" post is copied to the room the drop-off
  // came from, so Angus sees results and questions where he is working, not only in the workshop.
  // plan / decide / stuck need him: decide dings (a decision), plan and stuck bonk, and the agent
  // shows × until it works again, so a question never sits unseen.
  function relayTinkerResult(a, text, m) {
    const job = a.tinkerJob;
    const k = /^\s*🔧\s*(done|plan|decide|stuck)\b/i.exec(text)?.[1]?.toLowerCase();
    if (!job || !k) return;
    const origin = job.from?.room ? safeRoom(job.from.room) : "";
    if (origin && origin !== a.room)
      appendMessage(origin, { author: { kind: "agent", id: a.id, name: displayName(a), icon: a.icon, color: a.color, markup: a.nameMarkup || "" },
        text: `(workshop ${a.room} #${m.seq}) ${text}`, via: "tinker", relayed_from: { room: a.room, seq: m.seq } });
    const line = `🔧 ${text.replace(/^\s*🔧\s*/, "").split("\n")[0]}`;
    if (k === "decide") dingFor(a, line, { itemId: "tinker" });
    else if (k !== "done") bonkFor(a, line); // plan / stuck
    if (k === "done") clearDing(a, "tinker"); // it went on and finished: the question is settled
    if (k === "done" || k === "stuck") a.tinkerJob = null; // plan / decide keep the job: the answer continues it
  }
  function dispatchTinker() {
    const room = workshopRoom();
    if (!room || !tinkerQueue.length) return;
    const now = Date.now();
    const free = () => [...agents.values()]
      .filter((a) => a.room === room && !a.parked && a.conn && !a.conn.sock?.destroyed
        && (a.status === "idle" || a.status === "done") && now - (a.tinkerAt || 0) > 20000)
      .sort((x, y) => (y.lastActive || 0) - (x.lastActive || 0)); // warmest context first
    let changed = false;
    for (let a = free()[0]; a && tinkerQueue.length; a = free()[0]) {
      const job = tinkerQueue[0];
      if (!sendAgent(a, "prompt", { text: tinkerPrompt(job), via: "tinker" })) { a.tinkerAt = now; continue; }
      tinkerQueue.shift(); changed = true; a.tinkerAt = now; a.tinkerJob = job;
      recordActivity(a, "prompt", `Angus → ${displayName(a)} (tinker): ${job.text}`, {}, room);
      appendMessage(room, { author: { kind: "human", name: "Angus", via: "tinker" }, text: `🔧 → ${displayName(a)}: ${job.text}`, undelivered: true });
    }
    if (changed) saveTinker();
    if (tinkerQueue.length && now - tinkerSpawnedAt > 90000) { // nobody free: open one in the workshop
      const ws = workshopWorkspace();
      if (!ws) return;
      tinkerSpawnedAt = now;
      const bin = new URL("../bin/hyprpi", import.meta.url).pathname;
      const cenv = { ...process.env, ...env };
      for (const k of Object.keys(cenv)) if (/^(HYPRPI_AGENT_ID|HYPRPI_WORKSPACE|HYPRPI_TWIN_OF|PI_SESSION)/.test(k)) delete cenv[k];
      spawn(process.execPath, [bin, "new", "--workspace", String(ws), "--no-focus", "--cwd", process.env.HOME || "/"], { detached: true, stdio: "ignore", env: cenv }).unref();
      log(`tinker: no free agent in ${room}, opening one on workspace ${ws}`);
    }
  }
  const tinkerTimer = setInterval(dispatchTinker, 4000);

  // ----------------------------------------------------------------- board ---
  // The project board (docs/board-plan.md, lib/board.mjs): one per world. Here: who is acting
  // (an agent, or Angus from a panel / the CLI), dings for decisions, and delivery to members.
  const boards = createBoards({ dir: path.join(STATE, "boards"), log, onChange: (b) => broadcastUi("board", { room: b.room }) });
  const boardActor = (conn) => { const a = conn.agentId ? agents.get(conn.agentId) : null; return a ? { a, id: a.id, name: displayName(a), human: false } : { a: null, id: "", name: "Angus", human: true }; };
  // Which board: the one named, else (for an agent naming a project) the board that project is on,
  // wherever it is (a shared member left behind by /move keeps its cards in another world), else
  // the agent's / the active world's.
  const f0room = (found) => [...new Set(found.map((f) => f.board.room))].join("/");
  const welcomes = new Map(); // agent id -> its first prompt (a new agent made by /move)
  const boardRoom = (p, actor) => {
    if (p.room) return safeRoom(p.room);
    if (actor.a && p.project) { const f = boards.find(p.project); if (f) return f.board.room; }
    return safeRoom(actor.a?.room || roomForWorkspace(activeWs) || "A");
  };
  const nameOf = (id) => { const a = agents.get(id); if (a) return displayName(a); const r = registry[id]; return r ? (r.name || `pi·${id.slice(-4)}`) : id; };
  const agentNameTaken = (slug) => [...agents.values()].some((x) => displayName(x).toLowerCase() === slug || bare(x.name || "").toLowerCase() === slug);
  // Names or ids -> agent ids (live agents only).
  function agentIds(list) {
    const ids = [];
    for (const w of Array.isArray(list) ? list : String(list || "").split(/[\s,]+/)) {
      if (!String(w).trim()) continue;
      const { agent, error } = findAgent(String(w).replace(/^@/, ""));
      if (error) throw new Error(error);
      if (!ids.includes(agent.id)) ids.push(agent.id);
    }
    return ids;
  }
  const boardView = (room) => {
    const b = boards.load(room);
    const names = {};
    for (const p of b.projects) for (const m of [...p.members, p.writer]) if (m) names[m] = nameOf(m);
    return { room, projects: b.projects.map((p) => ({ ...p, short: projectShort(p, room) })), names, live: Object.fromEntries(Object.keys(names).map((id) => [id, agents.has(id) ? agents.get(id).status : "closed"])) };
  };
  // A project's "short": its `where` line summarised to agent-topic length (Angus: the agents
  // panel's projects section). Made by the topic model when `where` changes, cached by the where
  // text (state/project-shorts.json); "" until it is ready, then a "board" event re-sends the board.
  const shortsFile = path.join(STATE, "project-shorts.json");
  let shorts = {};
  try { shorts = JSON.parse(fs.readFileSync(shortsFile, "utf8")) || {}; } catch { shorts = {}; }
  const saveShorts = debounce(() => { try { fs.writeFileSync(shortsFile + ".tmp", JSON.stringify(shorts)); fs.renameSync(shortsFile + ".tmp", shortsFile); } catch { /* best effort */ } }, 1000);
  const shortBusy = new Set();
  function projectShort(p, room) {
    const w = String(p.where?.text || "").trim();
    if (!w) return "";
    if (shorts[w]) return shorts[w];
    if (cfg.topics === false || shortBusy.has(w) || shortBusy.size >= 2) return "";
    shortBusy.add(w);
    summarize(`Project @${p.name}${p.title ? ` (${p.title})` : ""}. Where things stand: ${w}`,
      { pi: cfg.pi || "pi", model: cfg.topicModel || cfg.searchModel || "claude-haiku-4-5", words: cfg.topicWords || 5, chars: cfg.topicChars || 40 })
      .then((t) => {
        if (!t) return;
        const live = new Set(boards.all().flatMap((x) => x.projects.map((q) => String(q.where?.text || "").trim())));
        for (const k of Object.keys(shorts)) if (!live.has(k)) delete shorts[k]; // forget old where lines
        shorts[w] = t; saveShorts(); broadcastUi("board", { room });
      })
      .catch(() => {})
      .finally(() => { shortBusy.delete(w); setTimeout(() => { for (const q of boards.load(room).projects) projectShort(q, room); }, 200); }); // the next ones
    return "";
  }
  // The agents panel's ⏎ on a project row: the projects panel (board-tui) opens that card. The
  // request is kept a few seconds so a panel that is only just opening picks it up too.
  const boardOpenReq = {}; // room -> { project, ts }
  // A prompt to one agent from the board (Angus's words stay verbatim at the top).
  function promptMember(a, text) { return a && sendAgent(a, "prompt", { text, via: "board" }); }
  function membersOf(p) { return p.members.map((id) => agents.get(id)).filter((a) => a && a.conn); }
  // Review fixes (gpt-6-sol): only Angus (a panel / the CLI, i.e. not an agent connection)
  // decides and sends board requests; agents change only cards they are members of
  // (create and join are open to all). The board given must hold the card (no silent
  // fallback to another world's board).
  const humanOnly = (actor, what) => { if (!actor.human) throw new Error(`${what} is Angus's (agents can't ${what})`); };
  function memberOnly(actor, ref, room) {
    const f = boards.must(ref, room);
    if (f.board.room !== room) throw new Error(`@${f.project.name} is on board ${f.board.room}, not ${room}`);
    if (!actor.human && !f.project.members.includes(actor.id)) throw new Error(`you are not on @${f.project.name}: join it first (project action join)`);
    return f;
  }

  // ---------------------------------------------------------------- topics ---
  // Short "current subject" label per agent (herdr's $topic), from its recent
  // user messages, when it finishes a turn; re-summarised only when the latest
  // one changes. At most two summaries run at once. Config: topics (default true), topicModel.
  const topicBusy = new Set();
  function refreshTopic(a) {
    if (cfg.topics === false) return;
    {
      if (!a.session || topicBusy.has(a.id)) return;
      if (topicBusy.size >= 2) { setTimeout(() => refreshTopic(a), 5000); return; } // two already running
      const inp = topicInput(a.session);
      if (!inp || inp.key === a.topicKey) return;
      topicBusy.add(a.id);
      summarize(inp.src, { pi: cfg.pi || "pi", model: cfg.topicModel || cfg.searchModel || "claude-haiku-4-5", words: cfg.topicWords || 5, chars: cfg.topicChars || 40 })
        .then((topic) => {
          a.topicKey = inp.key; // don't retry the same input on failure
          if (topic && topic !== a.topic) { a.topic = topic; remember(a); pushAgents(); recordActivity(a, "topic", topic); }
          else remember(a);
        })
        .finally(() => topicBusy.delete(a.id));
    }
  }
  // Checked when an agent finishes a turn (the ding), not on a timer.

  // --------------------------------------------------------------- deliver ---
  function historyFor(a, room, beforeSeq) {
    const r = roomLog(room);
    const seen = a.seen[room] ?? 0;
    const eligible = r.msgs.filter((m) => m.seq < beforeSeq && m.seq > seen);
    const out = []; let bytes = 0;
    for (let i = eligible.length - 1; i >= 0 && out.length < HISTORY_MESSAGES; i--) {
      const m = eligible[i];
      const v = { seq: m.seq, from: m.author?.kind === "agent" ? m.author.name : "Angus", ...(m.reply_to ? { reply_to: m.reply_to } : {}), text: m.text };
      const size = Buffer.byteLength(JSON.stringify(v));
      if (bytes + size > HISTORY_BYTES) break;
      out.unshift(v); bytes += size;
    }
    return { messages: out, truncated: eligible.length > out.length, first_seq: out[0]?.seq ?? null };
  }

  function deliverHumanPost(room, m) {
    const delivered = [];
    for (const a of agents.values()) {
      if (a.room !== room) continue;
      // One agent's trouble must not stop delivery to the rest of the room.
      try {
        if (!a.seen || typeof a.seen !== "object") a.seen = {};
        const delivery_id = `${room}:${m.seq}:${a.id}`;
        const history = historyFor(a, room, m.seq);
        deliveries.set(delivery_id, { agentId: a.id, room, seq: m.seq, replied: false });
        if (sendAgent(a, "room.question", {
          delivery_id, room, seq: m.seq, text: m.text, history, you: displayName(a),
          members: [...agents.values()].filter((x) => x.room === room).map(displayName),
        })) { a.seen[room] = m.seq; delivered.push(displayName(a)); }
      } catch (e) { log(`delivery to ${a.id} failed:`, e.message); }
    }
    return delivered;
  }

  // --------------------------------------------------------------- methods ---
  const methods = {
    ping: () => ({ ok: true, version: VERSION, socket: SOCK, pid: process.pid, started: STARTED }),

    "agent.hello": (p, conn) => {
      const id = String(p.agent_id || "").trim();
      if (!/^[A-Za-z0-9_.-]{3,64}$/.test(id)) throw new Error("bad agent_id");
      const prev = agents.get(id);
      if (prev?.conn && prev.conn !== conn && !prev.conn.sock.destroyed && prev.pid !== p.pid) throw new Error(`agent ${id} is already connected (pid ${prev.pid})`);
      const reg = registry[id] || {};
      const isNew = !prev && !registry[id];
      const a = prev || {
        // seen: room -> last delivered seq. ack: you have seen its ✓ / × (click or typing).
        id, createdAt: Date.now(), seen: {}, ack: true, status: "idle",
        name: reg.name || "", nameMarkup: reg.nameMarkup || "", icon: reg.icon || "", color: reg.color || "", topic: reg.topic || "", topicKey: reg.topicKey || "", parkedFrom: reg.parkedFrom || "", homeRoom: cfg.follow ? null : reg.homeRoom || null,
      };
      // Reconnect after a daemon restart (same process): keep its ●/✓/× instead of starting idle.
      if (!prev && reg.pid && reg.pid === (Number(p.pid) || 0) && ["idle", "working", "blocked", "done"].includes(reg.status)) {
        a.status = reg.status; a.ack = reg.ack !== false;
      }
      Object.assign(a, {
        conn, pid: Number(p.pid) || 0, session: p.session || a.session, cwd: p.cwd || a.cwd,
        model: p.model || a.model, thinking: p.thinking || a.thinking, lastActive: Date.now(),
        twinOf: p.twin_of || a.twinOf || "",
        // Runs in a container (HYPRPI_CONTAINER, e.g. "docker:pi-browser +web,nim"); the agents panel shows 🐳 docker.
        container: String(p.container || a.container || "").slice(0, 80),
      });
      // A session reopened under a new id (e.g. `pi --resume` outside hyprpi's own resume)
      // keeps the identity and topic of its most recent earlier record for that session.
      if (isNew && a.session && !a.twinOf) {
        const old = Object.values(registry).filter((r) => r.id !== id && r.session === a.session)
          .sort((x, y) => (y.updatedAt || 0) - (x.updatedAt || 0))[0];
        if (old) {
          // Names (and colours) are unique among live agents: don't take an identity still in use.
          const nameTaken = [...agents.values()].some((x) => x.id !== id && x.conn && x.name === old.name);
          for (const k of ["name", "nameMarkup", "icon", "color", "topic", "topicKey"]) {
            if (k !== "topic" && k !== "topicKey" && nameTaken) continue;
            if (!a[k] && old[k]) a[k] = old[k];
          }
        }
      }
      if (p.name && !a.name) a.name = String(p.name).slice(0, 60);
      // A twin starts with its parent's icon and colour.
      const parent = a.twinOf && agents.get(a.twinOf);
      if (parent && !prev) { a.icon = a.icon || parent.icon; a.color = a.color || parent.color; }
      if (Number.isInteger(p.want_workspace) && !prev) a.wantWorkspace = p.want_workspace;
      if (!a.room) a.room = roomForWorkspace(Number(p.want_workspace)) || roomForWorkspace(activeWs) || "A";
      // Names are unique among live agents. One that comes up with a name already in use (a fork
      // or twin inherits its parent's) gets its world's letter, capital (Angus): Sankey → Sankey[E],
      // then Sankey[E2], …
      if (a.name) {
        const taken = (nm) => [...agents.values()].some((x) => x.id !== id && x.conn && !x.conn.sock?.destroyed && x.name && x.name.toLowerCase() === nm.toLowerCase());
        if (taken(a.name)) {
          const base = a.name.replace(/\[[^\]]*\]$/, ""), L = String(a.room || "X").toUpperCase();
          let nm = `${base}[${L}]`, k = 2;
          while (taken(nm)) nm = `${base}[${L}${k++}]`;
          log(`agent ${id}: name "${a.name}" is taken, using "${nm}"`);
          a.name = nm; a.nameMarkup = "";
        }
      }
      agents.set(id, a);
      conn.agentId = id;
      resuming.delete(id);
      if (registry[id]) registry[id].forgotten = false;
      // Its session is open again: older registry entries for the same session are no longer dormant.
      for (const r of Object.values(registry)) if (r.id !== id && r.resumable && r.session && r.session === a.session) r.resumable = false;
      // A first prompt waiting for this agent (a /move hand-off: its new job), sent once it's up.
      const welcome = welcomes.get(id);
      if (welcome) { welcomes.delete(id); setTimeout(() => sendAgent(a, "prompt", { text: welcome, via: "board" }), 3000); }
      if (isNew) recordActivity(a, "joined", `joined · ${String(a.cwd || "").replace(/^\/home\/[^/]+/, "~")}${a.twinOf ? ` · twin of ${displayName(agents.get(a.twinOf) || { id: a.twinOf })}` : ""}`);
      remember(a);
      pushAgents();
      refreshSoon();
      return { agent_id: id, room: a.room, name: a.name, icon: a.icon, color: a.color };
    },

    "agent.update": (p, conn) => {
      const id = p.agent_id || conn.agentId;
      const a = agents.get(id);
      if (!a) throw new Error(`no live agent ${id}`);
      // Names are unique among live agents (talk / @Name / rooms address by name).
      if (typeof p.name === "string") {
        let want = p.name.replace(/\{#?[0-9a-fA-F]{0,6}\}/g, "").trim();
        const mm = want.match(/^(\S+)\s+(.+)$/);
        if (p.icon === undefined && mm && !/[\p{L}\p{N}]/u.test(mm[1])) want = mm[2].trim();
        if (boards.find(want.toLowerCase())) throw new Error(`"${want}" is a project on the board (@${want.toLowerCase()}); choose a different name`);
        const clash = [...agents.values()].find((x) => x.id !== a.id && x.name && x.name.toLowerCase() === want.toLowerCase());
        if (clash) throw new Error(`name "${want}" is taken by another agent (room ${clash.room || "none"}); choose a different name`);
      }
      if (p.resync && p.status && ["idle", "working", "blocked", "done"].includes(p.status)) {
        // The agent re-stating its state after a reconnect: no sound, no activity, keep "seen".
        if (!(a.status === "blocked" && p.status !== "working")) a.status = p.status;
      } else if (p.status && ["idle", "working", "blocked", "done"].includes(p.status)) {
        const prev = a.status;
        // Blocked (e.g. set by `bonk`) outlasts the end of the turn: it stays
        // until the agent starts working again (i.e. you answered it).
        const status = prev === "blocked" && (p.status === "done" || p.status === "idle") ? "blocked" : p.status;
        a.status = status; a.lastActive = Date.now();
        // A block from anything but a decision (a plain bonk) must survive clearDing().
        if (p.status === "blocked") a.otherBlock = true;
        else if (p.status === "working") a.otherBlock = false;
        // A finish (\u2713) or a block (\u00d7) is unseen until you click or type
        // in the agent's window, even if it was already focused.
        if ((status === "done" || status === "blocked") && prev !== status) a.ack = false;
        // Herdr-style sounds, played by the room app: "done" whenever a turn
        // finishes (even in the focused window), "request"
        // when an agent becomes blocked on you.
        // `quiet`: the caller makes its own sound (bonk's knock).
        if (prev === "working" && status === "done") setTimeout(() => refreshTopic(a), 500); // session file flushed
        if (prev === "working" && status === "done") recordActivity(a, "done", "finished");
        else if (prev !== "blocked" && status === "blocked") recordActivity(a, "blocked", "needs you");
        if (prev === "working" && status === "done") { broadcastUi("sound", { sound: "done", agent_id: id, name: a.name, room: a.room }); chime(); }
        else if (prev !== "blocked" && status === "blocked" && !p.quiet) broadcastUi("sound", { sound: "request", agent_id: id, name: a.name, room: a.room });
      }
      const oldModel = a.model || "", oldName = displayName(a), oldIcon = a.icon || "";
      for (const k of ["model", "thinking", "session", "topic", "cwd"]) if (typeof p[k] === "string") a[k] = p[k].slice(0, 200);
      if (oldModel && a.model && a.model !== oldModel) recordActivity(a, "model", `switched model to ${a.model}`);
      if (typeof p.name === "string") {
        // herdr-name style: "👻 Ghost" -> icon + name
        // herdr-name markup: "{#f7768e}S{#ff9e64}p…" colours parts of the name.
        let raw = p.name.trim(), icon = p.icon;
        const rm = raw.match(/^(\S+)\s+(.+)$/);
        if (icon === undefined && rm && !/[\p{L}\p{N}{]/u.test(rm[1])) { icon = rm[1]; raw = rm[2].trim(); }
        const name = raw.replace(/\{#?[0-9a-fA-F]{0,6}\}/g, "").trim();
        a.name = name.slice(0, 60);
        a.nameMarkup = /\{#[0-9a-fA-F]{6}\}/.test(raw) ? raw.slice(0, 200) : "";
        if (icon !== undefined) a.icon = String(icon).slice(0, 8);
      } else if (typeof p.icon === "string") a.icon = p.icon.slice(0, 8);
      if (typeof p.color === "string" && (/^#[0-9a-fA-F]{6}$/.test(p.color) || p.color === "")) a.color = p.color;
      if (displayName(a) !== oldName) recordActivity(a, "renamed", `${oldIcon ? oldIcon + " " : ""}${oldName} is now ${a.icon ? a.icon + " " : ""}${displayName(a)}`);
      remember(a);
      pushAgents();
      return view(a);
    },

    whoami: (p, conn) => {
      const a = agents.get(p.agent_id || conn.agentId);
      if (!a) throw new Error("not a live hyprpi agent");
      return view(a);
    },

    list: () => ({ agents: agentList(), dormant: dormantList(), rooms: knownRooms(), active_room: roomForWorkspace(activeWs), active_workspace: activeWs }),

    "ui.subscribe": (p, conn) => { conn.ui = true; conn.windows = !!p.windows; return methods.list(); },

    // Ask this instance's room-window process to open/raise a room window.
    // The world click / SUPER+ALT+A. Room windows are normal windows, at most
    // one per workspace:
    //   this workspace has one      -> close it (toggle) / focus it (open)
    //   another workspace of this
    //   room has one                -> go to it
    //   none                        -> the UI opens one; we place it as the
    //                                  left-most root of the dwindle tree
    "ui.open": async (p) => {
      // Focusing windows makes Hyprland warp the pointer; the click came from
      // the bar, so keep the pointer where it was (over the world letter).
      const [list, aw, cur] = await Promise.all([hypr.clients({ env }), hypr.activeWorkspace({ env }).catch(() => null), hypr.cursorPos({ env }).catch(() => null)]);
      if (aw && Number.isInteger(aw.id)) activeWs = aw.id;
      const room = p.room ? safeRoom(p.room) : (roomForWorkspace(activeWs) || "A");
      const wins = list.filter((c) => /^hyprpi room /.test(c.title || "")).map((c) => ({
        address: c.address, ws: c.workspace?.id, room: (c.title.match(/^hyprpi room (\S+)/) || [])[1] || "" }));
      const here = wins.find((w) => w.ws === activeWs);
      if (here) {
        if (p.toggle) await hypr.closeWindow(here.address, { env });
        else await hypr.focusWindow(here.address, { env });
        restoreCursor(cur);
        return { room: here.room, action: p.toggle ? "closed" : "focused", delivered: 1 };
      }
      const elsewhere = wins.find((w) => w.room === room);
      if (elsewhere) {
        await hypr.focusWindow(elsewhere.address, { env });
        restoreCursor(cur);
        return { room, action: "moved", workspace: elsewhere.ws, delivered: 1 };
      }
      const key = "w" + Date.now().toString(36);
      let n = 0;
      for (const c of conns) if (c.windows) { send(c, "open", { room, key }); n++; }
      if (n) pendingPlacement.set(key, { ws: activeWs, until: Date.now() + 8000, cursor: cur });
      return { room, action: "opened", key, delivered: n };
    },

    "room.current": () => ({ room: roomForWorkspace(activeWs), workspace: activeWs }),
    // /search WORDS or /ai Q typed in another panel: the (already open) search panel for that
    // world runs it (mockups/panel-here sends this after jumping to it; search-tui listens).
    "ui.searchRun": (p) => {
      const room = safeRoom(p.room || roomForWorkspace(activeWs));
      const mode = p.mode === "ai" ? "ai" : p.mode === "keyword" ? "keyword" : "";
      broadcastUi("search-run", { room, query: String(p.query ?? "").slice(0, 2000), mode });
      return { room, mode };
    },

    "room.read": (p, conn) => {
      const room = safeRoom(p.room || agents.get(conn.agentId)?.room);
      if (!room || room === "_") throw new Error("no room");
      const r = roomLog(room);
      const after = Math.max(0, Number(p.after_sequence ?? p.after) || 0);
      const limit = Math.min(200, Math.max(1, Number(p.limit) || 20));
      let msgs = r.msgs.filter((m) => m.seq > after);
      msgs = p.tail ? msgs.slice(-limit) : msgs.slice(0, limit);
      return { room, messages: msgs, next_sequence: r.next };
    },

    // Tool activity from an agent's Pi extension (already batched there): [{ text }].
    "agent.activity": (p, conn) => {
      const a = agents.get(conn.agentId);
      if (!a) throw new Error("activity is for hyprpi agents");
      const items = Array.isArray(p.items) ? p.items.slice(0, 10) : [];
      for (const it of items) {
        const kind = ["aborted", "error"].includes(it?.kind) ? it.kind : "tool";
        if (kind === "tool" && cfg.activityTools === false) continue;
        recordActivity(a, kind, it?.text);
      }
      return { recorded: items.length };
    },

    // The room TUI's history: room messages + activity events of the last `interactions`
    // (default 200; "all" = everything). -> { room, since, messages, events }
    "history.read": (p) => {
      const room = safeRoom(p.room || roomForWorkspace(activeWs));
      const acts = activityAll(room);
      const since = historySince(room, p.interactions ?? 200, acts);
      return { room, since, messages: roomLog(room).msgs.filter((m) => m.ts >= since), events: acts.filter((e) => e.ts >= since) };
    },

    "activity.read": (p) => {
      const room = safeRoom(p.room || roomForWorkspace(activeWs));
      const limit = Math.min(500, Math.max(1, Number(p.limit) || 200));
      return { room, events: activityTail(room).slice(-limit) };
    },

    "room.post": (p, conn) => {
      const text = String(p.text ?? "");
      if (!text.trim() || Buffer.byteLength(text) > MAX_TEXT) throw new Error("text must be 1..8192 bytes");
      const a = conn.agentId && !p.as_human ? agents.get(conn.agentId) : null;
      if (a) {
        if (a.parked || !a.room) throw new Error("this agent is in Reprieve (off-limits workspace): out of every room until it is moved out");
        const author = { kind: "agent", id: a.id, name: displayName(a), icon: a.icon, color: a.color, markup: a.nameMarkup || "" };
        const m = appendMessage(a.room, { author, text });
        a.lastActive = Date.now();
        relayTinkerResult(a, text, m);
        return { room: a.room, sequence: m.seq, persistence: "saved" };
      }
      const room = safeRoom(p.room || roomForWorkspace(activeWs));
      const m = appendMessage(room, { author: { kind: "human", name: "Angus", via: p.via || "" }, text, ...(p.deliver === false ? { undelivered: true } : {}) });
      // deliver: false = written to the room only (the room TUI with no agent marked).
      const delivered = p.deliver === false ? [] : deliverHumanPost(room, m);
      return { room, sequence: m.seq, persistence: "saved", delivered };
    },

    "room.reply": (p, conn) => {
      const d = deliveries.get(String(p.delivery_id || ""));
      const a = agents.get(conn.agentId);
      if (!d || !a || d.agentId !== a.id) throw new Error("unknown delivery_id for this agent");
      if (d.replied) throw new Error("already replied to this question");
      const text = String(p.text ?? "");
      if (!text.trim() || Buffer.byteLength(text) > MAX_TEXT) throw new Error("text must be 1..8192 bytes");
      d.replied = true;
      const m = appendMessage(d.room, { author: { kind: "agent", id: a.id, name: displayName(a), icon: a.icon, color: a.color, markup: a.nameMarkup || "" }, reply_to: d.seq, text });
      return { room: d.room, sequence: m.seq, persistence: "saved" };
    },

    "agent.prompt": (p) => {
      const { agent, error } = findAgent(p.agent);
      if (error) throw new Error(error);
      const text = String(p.text ?? "");
      if (!text.trim()) throw new Error("empty text");
      if (!sendAgent(agent, "prompt", { text, via: p.via || "" })) throw new Error("agent not connected");
      recordActivity(agent, "prompt", `Angus → ${displayName(agent)}: ${text}`);
      return { agent: agent.id, name: displayName(agent) };
    },

    // Click inside an agent window (Hyprland hook, by address) or typing in it
    // (the agent's extension, by its connection): its \u2713 or \u00d7 becomes seen.
    "agent.seen": (p, conn) => {
      const addr = String(p.address || "").toLowerCase().replace(/^0x/, "");
      const a = addr
        ? [...agents.values()].find((x) => x.address && x.address.toLowerCase().replace(/^0x/, "") === addr)
        : agents.get(p.agent_id || conn.agentId);
      if (!a) return { seen: false };
      if ((a.status === "done" || a.status === "blocked") && !a.ack) { a.ack = true; remember(a); pushAgents(); }
      return { seen: true, agent: a.id };
    },

    // Reopen a dormant agent (see dormantList) in its own window, on its Pi session.
    "agent.resume": (p) => {
      const id = String(p.agent || "");
      const r = registry[id];
      if (agents.has(id)) throw new Error(`${displayName(r || { id })} is already open`);
      if (!canResume(r)) throw new Error(`no closed agent ${id} to resume`);
      if (Date.now() - (resuming.get(id) || 0) < 30000) return { agent: id, resuming: true };
      if (!r.session || !fs.existsSync(r.session)) throw new Error(`session file missing for ${displayName(r)}`);
      // Its old workspace if that is a normal one in the current world, else the active workspace.
      let ws = Number.isInteger(r.workspace) && r.workspace > 0 ? r.workspace : null;
      if (Number.isInteger(activeWs) && activeWs > 0 && (!ws || roomForWorkspace(ws) !== roomForWorkspace(activeWs))) ws = activeWs;
      const bin = new URL("../bin/hyprpi", import.meta.url).pathname;
      const argv = ["new", "--id", id, "--cwd", r.cwd && fs.existsSync(r.cwd) ? r.cwd : process.env.HOME,
        ...(ws ? ["--workspace", String(ws)] : []), ...(r.twinOf ? ["--twin-of", r.twinOf] : []), "--", "--session", r.session];
      const cenv = { ...process.env, ...env };
      for (const k of Object.keys(cenv)) if (/^(HYPRPI_AGENT_ID|HYPRPI_WORKSPACE|HYPRPI_TWIN_OF|PI_SESSION)/.test(k)) delete cenv[k];
      spawn(process.execPath, [bin, ...argv], { detached: true, stdio: "ignore", env: cenv }).unref();
      resuming.set(id, Date.now());
      recordActivity({ ...r, room: r.room || r.parkedFrom || r.homeRoom }, "resumed", `resumed · ${String(r.cwd || "").replace(/^\/home\/[^/]+/, "~")}`);
      pushAgents();
      setTimeout(pushAgents, 30500); // shows it again if it never connected
      return { agent: id, resuming: true, workspace: ws };
    },

    // Move agents to another workspace or world (their windows, silently: focus stays put).
    // agents: names/ids, or room: "C" = every live agent in room C. to: a workspace number
    // (all go there) or a world letter (each keeps its slot: C4 -> F4). With follow on, their
    // room follows the window, as with a manual move. Room logs, activity and marks stay with
    // the old letter (moving a whole project's state is a separate step: see the Tinker note).
    "agent.move": async (p) => {
      const to = String(p.to ?? "").trim().toUpperCase();
      const size = cfg.worldSize || 10;
      let world = null, ws = null;
      if (/^\d+$/.test(to) && Number(to) > 0) ws = Number(to);
      else if (to.length === 1 && WORLD_LETTERS.includes(to)) world = WORLD_LETTERS.indexOf(to);
      else throw new Error(`to: give a workspace number or a world letter (${WORLD_LETTERS[0]}-${WORLD_LETTERS.at(-1)})`);
      let list;
      if (p.room) {
        const r = safeRoom(p.room);
        list = [...agents.values()].filter((a) => a.room === r && a.conn && !a.conn.sock?.destroyed);
        if (!list.length) throw new Error(`no live agents in room ${r}`);
      } else {
        const names = (Array.isArray(p.agents) ? p.agents : [p.agent]).filter((x) => x != null && String(x).trim());
        if (!names.length) throw new Error("no agents given");
        list = names.map((n) => { const { agent, error } = findAgent(n); if (error) throw new Error(error); return agent; });
      }
      if (list.some((a) => !a.address)) await refreshWindows();
      const moved = [], skipped = [];
      for (const a of list) {
        if (!a.address) { skipped.push({ agent: displayName(a), why: "window not found" }); continue; }
        const slot = Number.isInteger(a.workspace) && a.workspace > 0 ? (a.workspace - 1) % size : 0;
        const dest = ws ?? world * size + 1 + slot;
        if (a.workspace === dest) { skipped.push({ agent: displayName(a), why: `already on ${dest}` }); continue; }
        await hypr.moveWindow(a.address, String(dest), { env });
        moved.push({ agent: displayName(a), from: a.workspace ?? null, to: dest });
        // (the window watcher logs the move itself: "moved to workspace D8" / "moved to room F")
      }
      setTimeout(refreshWindows, 150);
      return { moved, skipped };
    },

    // Spin a project out to another world (~/Obsidian/Tinker/2026-09-28 Moving a project.md):
    // its card moves to that world's board (destination first), its members' windows follow
    // (agent.move, slots kept), closed members are re-homed in the registry, and both rooms get a
    // pointer message. Members also on another non-archived project STAY ("shared, not moved").
    // Room logs are not copied or rewritten.
    "project.spinout": async (p, conn) => {
      // One project (project) or several at once (projects: [...], Angus): moved as ONE group, so an
      // agent on two of the moving projects goes with them instead of counting as "shared".
      const actor = boardActor(conn), by = { id: actor.id, name: actor.name, human: actor.human };
      const to = String(p.to ?? "").trim().toUpperCase();
      if (!(to.length === 1 && WORLD_LETTERS.includes(to))) throw new Error(`to: a world letter (${WORLD_LETTERS[0]}-${WORLD_LETTERS.at(-1)})`);
      const refs = Array.isArray(p.projects) && p.projects.length ? p.projects : [p.project];
      const fromHint = p.from ? safeRoom(String(p.from).toUpperCase()) : null;
      const found = refs.map((r) => boards.must(r, fromHint));
      for (const f of found) {
        if (f.board.room === to) throw new Error(`@${f.project.name} is already on board ${to}`);
        memberOnly(actor, f.project.id, f.board.room);
      }
      const moving = new Set(found.map((f) => f.project.id));
      const members = [...new Set(found.flatMap((f) => f.project.members))];
      const others = boards.all().flatMap((b) => b.projects).filter((x) => !moving.has(x.id) && x.status !== "archived");
      const shared = members.filter((id) => others.some((x) => x.members.includes(id)));
      const going = members.filter((id) => !shared.includes(id));
      for (const f of found) boards.move(f.project.id, f.board.room, to, by);
      const live = going.filter((id) => agents.get(id)?.conn);
      const r = live.length ? await methods["agent.move"]({ agents: live, to }) : { moved: [], skipped: [] };
      const size = cfg.worldSize || 10, world = WORLD_LETTERS.indexOf(to), rehomed = [];
      for (const id of going.filter((x) => !live.includes(x))) {
        const reg = registry[id];
        if (!reg) continue;
        const slot = Number.isInteger(reg.workspace) && reg.workspace > 0 ? (reg.workspace - 1) % size : 0;
        reg.workspace = world * size + 1 + slot; reg.room = to; reg.updatedAt = Date.now();
        rehomed.push(nameOf(id));
      }
      if (rehomed.length) saveRegistry();
      // Shared members (also on projects that aren't moving) stay where they are. For each, a NEW
      // agent opens in the new world and takes their place on the moved cards; the one staying
      // behind writes it a hand-off (Angus: the context and reasoning for the project, nothing else).
      const handoffs = [];
      const bin = new URL("../bin/hyprpi", import.meta.url).pathname;
      for (const oldId of shared) {
        const projs = found.map((f) => boards.must(f.project.id, to).project).filter((x) => x.members.includes(oldId));
        if (!projs.length) continue;
        const newId = "hp-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
        const newName = `pi·${newId.slice(-4)}`, oldName = nameOf(oldId), old = agents.get(oldId);
        const pnames = projs.map((x) => "@" + x.name).join(" ");
        for (const pr of projs) {
          const wasWriter = pr.writer === oldId;
          boards.leave(pr.id, to, oldId, { ...by, who: oldName });
          boards.join(pr.id, to, newId, { ...by, who: newName });
          if (wasWriter) boards.update(pr.id, to, { writer: newId }, by, agentNameTaken);
        }
        const reg = registry[oldId] || {}, oldWs = old?.workspace ?? reg.workspace;
        const slot = Number.isInteger(oldWs) && oldWs > 0 ? (oldWs - 1) % size : 0;
        const cwd = (old?.cwd || reg.cwd) && fs.existsSync(old?.cwd || reg.cwd) ? (old?.cwd || reg.cwd) : process.env.HOME || "/";
        const live = !!old?.conn;
        welcomes.set(newId, `[hyprpi · /move: you are the new agent for ${pnames}, now in world ${to}]\n` +
          `${pnames} moved from world ${f0room(found)} to world ${to}. @${oldName} worked on ${projs.length > 1 ? "them" : "it"} but stays in world ${f0room(found)} with its other projects, so you take over here${projs.some((x) => x.writer === newId) ? " (you are the owner, the card's writer)" : ""}.\n` +
          (live ? `@${oldName} is sending you a hand-off via talk: the context and reasoning for ${pnames}. Read the card first (board_read), then wait for the hand-off before starting; if none arrives within a few minutes, ask @${oldName} via talk. ` : `@${oldName} is closed, so no hand-off will come: work from the card (board_read) and search the old world's history. `) +
          `Work only on ${pnames}; ignore anything else from @${oldName}'s past. Keep the card current.`);
        const env2 = { ...process.env, ...env };
        for (const k of Object.keys(env2)) if (/^(HYPRPI_AGENT_ID|HYPRPI_WORKSPACE|HYPRPI_TWIN_OF|PI_SESSION)/.test(k)) delete env2[k];
        spawn(process.execPath, [bin, "new", "--id", newId, "--workspace", String(world * size + 1 + slot), "--no-focus", "--cwd", cwd], { detached: true, stdio: "ignore", env: env2 }).unref();
        if (live) promptMember(old, `[hyprpi · /move: write a hand-off]\n${pnames} moved to world ${to}. You stay in world ${old.room || "here"} with your other projects, and you are no longer on ${pnames}: a new agent, @${newName}, takes over there.\n\n` +
          `Write @${newName} a hand-off and send it with talk (it may take a minute to start; check \`hyprpi list\` and retry if talk says it isn't live yet). In it, provide and explain the context and reasoning relevant to ${pnames}: what it is for, where it stands, the decisions made and WHY, what was tried and didn't work, what's left, open questions, the files, commits and commands that matter, and any traps. Ignore everything else you know: your other projects and unrelated work stay out of it. Don't change the moved card${projs.length > 1 ? "s" : ""} yourself; @${newName} owns ${projs.length > 1 ? "them" : "it"} now.`);
        handoffs.push({ from: oldName, to: newName, projects: projs.map((x) => x.name), handoff: live });
      }
      const list = (ids) => ids.map(nameOf).join(", ");
      const author = { kind: "system", name: "hyprpi", icon: "📋" };
      for (const f of found) {
        const pr = f.project, from = f.board.room;
        const g = pr.members.filter((id) => going.includes(id));
        const ho = handoffs.filter((h) => h.projects.includes(pr.name)).map((h) => `${h.from} stays, new agent ${h.to} takes over${h.handoff ? " with a hand-off" : ""}`);
        const tail = [g.length ? `agents: ${list(g)}` : "", ...ho].filter(Boolean).join(" · ");
        const base = { author, kind: "spinout", project: pr.id, from, to, by: by.name };
        appendMessage(from, { ...base, text: `📋 @${pr.name} moved to world ${to}${tail ? ` (${tail})` : ""}` });
        appendMessage(to, { ...base, text: `📋 @${pr.name} arrived from world ${from}${tail ? ` (${tail})` : ""}` });
      }
      pushAgents();
      const names = found.map((f) => f.project.name);
      return { project: found[0].project.id, name: names.join(" @"), names, from: found[0].board.room, to, moved: r.moved, skipped: r.skipped, shared: shared.map(nameOf), rehomed, handoffs };
    },

    // Bring a parked agent (Reprieve / off-limits workspace) back to the active workspace.
    "agent.unpark": async (p) => {
      const { agent, error } = findAgent(p.agent);
      if (error) throw new Error(error);
      if (!agent.address) await refreshWindows();
      if (!agent.address) throw new Error("agent window not found");
      const ws = Number.isInteger(activeWs) && activeWs > 0 ? activeWs : null;
      if (!ws) throw new Error("no normal workspace is active");
      await hypr.moveWindow(agent.address, String(ws), { env });
      setTimeout(refreshWindows, 150);
      await hypr.focusWindow(agent.address, { env }).catch(() => {});
      return { agent: agent.id, workspace: ws };
    },

    // Drop a dormant agent from the list (its session file stays).
    "agent.forget": (p) => {
      const r = registry[String(p.agent || "")];
      if (!canResume(r)) throw new Error("no closed agent to forget");
      r.resumable = false; r.forgotten = true; saveRegistry(); pushAgents();
      return { agent: r.id, forgotten: true };
    },

    // Marks: all = every agent in the room (the default), or an explicit list.
    "selection.get": (p) => selectionView(p.room),
    "selection.set": (p) => {
      const r = safeRoom(p.room);
      if (p.all) selection.delete(r);
      else selection.set(r, new Set((Array.isArray(p.agents) ? p.agents : []).map(String)));
      pushSelection(r);
      return selectionView(r);
    },
    "selection.toggle": (p) => {
      const r = safeRoom(p.room), id = String(p.agent || "");
      const live = [...agents.values()].filter((a) => a.room === r).map((a) => a.id);
      const sel = selection.get(r) || new Set(live);
      if (sel.has(id)) sel.delete(id); else sel.add(id);
      selection.set(r, sel);
      pushSelection(r);
      return selectionView(r);
    },

    // ---- board ----
    "board.get": (p, conn) => boardView(boardRoom(p, boardActor(conn))),
    "board.text": (p, conn) => {
      const actor = boardActor(conn), room = boardRoom(p, actor);
      const f = p.project ? boards.must(p.project, room) : null;
      return { room, text: boardText(f ? f.board : boards.load(room), nameOf, { project: f?.project }) };
    },
    "board.changes": (p, conn) => {
      const actor = boardActor(conn), room = boardRoom(p, actor);
      const f = p.project ? boards.must(p.project, room) : null;
      return { room, changes: boards.changes(f ? f.board.room : room, Math.min(200, Number(p.limit) || 30), f?.project.id) };
    },
    // { room, project }: ask the projects panel of that world to open the card. No project = the
    // pending request for that room (a projects panel just starting), if under 15 s old.
    "board.open": (p, conn) => {
      const room = boardRoom(p, boardActor(conn));
      if (!p.project) { const r = boardOpenReq[room]; return r && Date.now() - r.ts < 15000 ? { room, project: r.project } : { room, project: null }; }
      const f = boards.must(p.project, room);
      boardOpenReq[room] = { project: f.project.id, ts: Date.now() };
      broadcastUi("board.open", { room, project: f.project.id });
      return { room, project: f.project.id };
    },
    "board.seen": (p, conn) => { const pr = boards.seen(p.project, boardRoom(p, boardActor(conn))); return { seen: !!pr }; },
    // Projects: create | update (name, title, status, writer, where, next_step) | join | leave
    // (note: a hand-off to the remaining members, required for agents) | assign (+/- members,
    // Angus) | remove | move (to another world's board; spin-out).
    "board.project": (p, conn) => {
      const actor = boardActor(conn), room = boardRoom(p, actor), by = { id: actor.id, name: actor.name, human: actor.human };
      switch (p.action) {
        case "create": {
          const members = p.members ? agentIds(p.members) : actor.a ? [actor.a.id] : [];
          // A project closed (archived) earlier under that name: reopen it (history and all)
          // instead of refusing or starting a duplicate.
          const old = boards.find(slugify(p.name), room);
          if (old && old.board.room === room && old.project.status === "archived") {
            boards.update(old.project.id, room, { status: "active" }, by, agentNameTaken);
            for (const id of members) boards.join(old.project.id, room, id, { ...by, who: nameOf(id) });
            return { ...boards.must(old.project.id, room).project, reopened: true };
          }
          const pr = boards.create(room, { name: p.name, title: p.title, icon: p.icon, members, by, status: actor.human ? "active" : "new" }, agentNameTaken);
          if (actor.human) for (const id of members) promptMember(agents.get(id), `[hyprpi board · Angus created @${pr.name} and assigned you${pr.writer === id ? " (you are its writer)" : ""}]\n${pr.title || ""}\n\nKeep its card current with board_update (board_read shows it).`);
          return pr;
        }
        case "update": memberOnly(actor, p.project, room); return boards.update(p.project, room, p, by, agentNameTaken);
        case "join": {
          const id = actor.a ? actor.a.id : agentIds([p.agent])[0];
          const f0 = boards.must(p.project, room);
          if (f0.project.status === "archived") boards.update(f0.project.id, room, { status: "active" }, by, agentNameTaken); // joining a closed project reopens it
          return boards.join(p.project, room, id, { ...by, who: nameOf(id) });
        }
        case "leave": {
          const id = actor.a ? actor.a.id : agentIds([p.agent])[0];
          const note = String(p.note || "").trim();
          if (actor.a && !note) throw new Error("leaving needs a note for the remaining members (what you did, what's left)");
          const pr = boards.leave(p.project, room, id, { ...by, who: nameOf(id) });
          const rest = membersOf(pr);
          if (actor.a && rest.length) methods.talk({ to: rest.map((x) => x.id), text: `[leaving @${pr.name}] ${note}` }, conn);
          return { ...pr, told: rest.map(displayName) };
        }
        case "assign": { // "+@A -@B"
          memberOnly(actor, p.project, room);
          const f = boards.must(p.project, room);
          for (const tok of String(p.members || "").split(/[\s,]+/).filter(Boolean)) {
            const add = !tok.startsWith("-"), id = agentIds([tok.replace(/^[+-]/, "")])[0];
            if (add && f.project.members.includes(id)) continue; // already a member: no second "join", no second notice
            if (add) { boards.join(f.project.id, room, id, { ...by, who: nameOf(id) }); promptMember(agents.get(id), `[hyprpi board · ${by.name} assigned you to @${f.project.name}${f.project.writer === id ? " (you are its writer)" : ""}]\nRead it with board_read and keep its card current with board_update.`); }
            else boards.leave(f.project.id, room, id, { ...by, who: nameOf(id) });
          }
          return boards.must(f.project.id, room).project;
        }
        // Split: new projects (`into`, names) with the same members and writer; `items` maps
        // handles to a new project's name (unlisted items stay). The original stays too.
        case "split": {
          const f = memberOnly(actor, p.project, room), src = f.project;
          const names = (Array.isArray(p.into) ? p.into : String(p.into || "").split(/[\s,]+/)).map((x) => slugify(x)).filter(Boolean);
          if (!names.length) throw new Error("split into what? e.g. into: [\"a\", \"b\"]");
          const map = p.items && typeof p.items === "object" ? p.items : {};
          for (const [h, to] of Object.entries(map)) {
            if (!src.items.some((x) => x.h.toLowerCase() === h.toLowerCase())) throw new Error(`no item ${h} on @${src.name}`);
            if (!names.includes(slugify(to))) throw new Error(`${h} → @${slugify(to)}: not one of the new projects (${names.map((n) => "@" + n).join(" ")})`);
          }
          const made = [];
          for (const n of names) {
            const pr = boards.create(room, { name: n, title: `split from @${src.name}`, members: src.members.includes(src.writer) ? [src.writer, ...src.members.filter((x) => x !== src.writer)] : src.members, by, status: "active" }, agentNameTaken);
            made.push(pr);
          }
          const moves = [];
          for (const [h, to] of Object.entries(map)) { const r = boards.transferItem(src.id, slugify(to), room, h, by); moves.push(`${r.from}→@${slugify(to)} ${r.to}`); }
          const rest = membersOf(src);
          for (const a of rest) promptMember(a, `[hyprpi board · ${by.name} split @${src.name} into ${made.map((x) => "@" + x.name).join(" ")}]\n${moves.length ? "Items moved: " + moves.join(", ") + "\n" : ""}You are a member of the new projects. Fill in their where / next_step, move anything else that belongs there (board_update add + drop), and leave the ones that aren't yours (project leave, with a note).`);
          return { project: src.id, name: src.name, made: made.map((x) => x.name), moves };
        }
        // Merge: every item of `project` moves to `into` (new handles there), members are joined,
        // and `project` is archived (reopenable).
        case "merge": {
          const f = memberOnly(actor, p.project, room), src = f.project;
          const g = memberOnly(actor, p.into, room), dst = g.project;
          if (src.id === dst.id) throw new Error("merge a project into another one");
          const moves = [];
          for (const it of [...src.items]) { const r = boards.transferItem(src.id, dst.id, room, it.h, by); moves.push(`${r.from}→${r.to}`); }
          for (const id of src.members) if (!dst.members.includes(id)) boards.join(dst.id, room, id, { ...by, who: nameOf(id) });
          boards.update(src.id, room, { status: "archived" }, by, agentNameTaken);
          for (const a of membersOf(boards.must(dst.id, room).project)) promptMember(a, `[hyprpi board · ${by.name} merged @${src.name} into @${dst.name}]\nItems moved: ${moves.join(", ") || "none"}. @${src.name} is archived. Tidy @${dst.name}: merge its Where and next_step, drop duplicates.`);
          return { project: dst.id, name: dst.name, merged: src.name, moves };
        }
        case "spinout": return methods["project.spinout"]({ project: p.project, to: p.to, from: room }, conn);
        case "remove": humanOnly(actor, "remove a project"); return boards.remove(p.project, room, by);
        case "move": memberOnly(actor, p.project, room); return boards.move(p.project, room, safeRoom(p.to), by);
        default: throw new Error("action: create, update, join, leave, assign, split, merge, spinout, remove or move");
      }
    },
    // Items: add | edit | done | drop | decide (Angus answers a Decide item).
    "board.item": (p, conn) => {
      const actor = boardActor(conn), room = boardRoom(p, actor), by = { id: actor.id, name: actor.name, human: actor.human };
      switch (p.action) {
        case "add": {
          memberOnly(actor, p.project, room);
          const r = boards.addItem(p.project, room, p, by);
          if (r.item.sec === "decide" && actor.a) dingFor(actor.a, `@${r.project.name} ${r.item.h}: ${r.item.text}`, { itemId: `${r.project.id}:${r.item.h}` });
          return r;
        }
        case "edit": memberOnly(actor, p.project, room); return boards.editItem(p.project, room, p.h, p, by);
        case "done": {
          memberOnly(actor, p.project, room);
          const f = boards.must(p.project, room), it = f.project.items.find((x) => x.h.toLowerCase() === String(p.h).toLowerCase());
          const wasDecide = it?.sec === "decide";
          const r = boards.doneItem(p.project, room, p.h, p, by);
          const raiser = wasDecide && agents.get(it.by?.id);
          if (raiser) clearDing(raiser, `${r.project.id}:${r.item.h}`);
          return r;
        }
        case "drop": {
          memberOnly(actor, p.project, room);
          const r = boards.dropItem(p.project, room, p.h, by);
          const raiser = r.item.sec === "decide" && agents.get(r.item.by?.id);
          if (raiser) clearDing(raiser, `${r.project.id}:${r.item.h}`);
          return r;
        }
        case "decide": {
          humanOnly(actor, "answer decisions");
          const f = memberOnly(actor, p.project, room);
          const it = f.project.items.find((x) => x.h.toLowerCase() === String(p.h).toLowerCase());
          if (!it) throw new Error(`no item ${p.h} on @${f.project.name}`);
          const ans = String(p.answer || "").trim();
          if (!ans) throw new Error("no answer");
          const m = /^([a-z])\b[\s.):,-]*([\s\S]*)$/i.exec(ans), opt = m && it.options?.find((o) => o.key === m[1].toLowerCase());
          const resolution = opt ? `${opt.key}) ${opt.text}${m[2] ? " — " + m[2] : ""}` : ans;
          const r = boards.doneItem(f.project.id, room, it.h, { resolution }, by);
          const raiser = agents.get(it.by?.id);
          if (raiser) clearDing(raiser, `${f.project.id}:${it.h}`);
          const told = [];
          for (const a of new Set([raiser, agents.get(f.project.writer)].filter(Boolean))) {
            if (promptMember(a, `[hyprpi board · ${by.name} decided @${f.project.name} ${it.h}]\n${it.text}\n→ ${resolution}\n\nAct on it and update the card (board_update). Tell other members via talk if it affects them.`)) told.push(displayName(a));
          }
          return { ...r, told };
        }
        case "restore": { memberOnly(actor, p.project, room); return boards.restoreItem(p.project, room, p.h, by); }
        default: throw new Error("action: add, edit, done, drop, restore or decide");
      }
    },
    // Angus talks to a project: where "room" (a room message tagged with the project, delivered to
    // its members) or "board" (update the card: members coordinate, the writer writes, no room post).
    "board.request": (p, conn) => {
      const actor = boardActor(conn), room = boardRoom(p, actor);
      humanOnly(actor, "send board requests (they speak as Angus); use talk to reach members");
      const f = memberOnly(actor, p.project, room), pr = f.project;
      const text = String(p.text ?? "").trim();
      if (!text || Buffer.byteLength(text) > MAX_TEXT) throw new Error("text must be 1..8192 bytes");
      const members = membersOf(pr);
      if (!members.length) throw new Error(`nobody live on @${pr.name} (/assign @${pr.name} +@Name)`);
      const writer = members.find((a) => a.id === pr.writer) || members[0]; // a live writer (the named one may be closed)
      const names = members.map((a) => "@" + displayName(a)).join(" ");
      const onBoard = p.where === "board";
      if (!onBoard) appendMessage(room, { author: { kind: "human", name: actor.name, via: p.via || "board" }, text: `@${pr.name} ${text}`, project: pr.id, undelivered: true });
      const told = [];
      for (const a of members) {
        const head = onBoard
          ? `[hyprpi board request · Angus → @${pr.name} · members ${names} · writer @${displayName(writer)}]`
          : `[hyprpi · Angus → @${pr.name} (a project you are on; members ${names} · owner @${displayName(writer)})]`;
        const tail = onBoard
          ? (a === writer
            ? "You are the writer: gather what the other members know (talk), then update the card with board_update so it answers this. Then room_post a short summary (1-3 lines) of what changed on the card. Narrate while you work."
            : `Send the writer (@${displayName(writer)}) what you know about this via talk, briefly; the writer updates the card and posts the summary.`)
          // Angus: the project's owner (its writer) coordinates and answers; the others feed the owner.
          // One answer, never several crossing ones.
          : (a === writer
            ? "You own this project (its writer): YOU answer. Coordinate: ask the other members for what they know (talk) if you need it, do or hand out the work, then answer in the room (room_post) and update the card (board_update). No other member will post."
            : `The owner @${displayName(writer)} answers this and coordinates. Don't post in the room and don't start on it yourself: if you know something relevant, send it to @${displayName(writer)} via talk (briefly), then wait to be asked.`);
        if (sendAgent(a, "prompt", { text: `${head}\n${text}\n\n${tail}`, via: "board" })) told.push(displayName(a));
        recordActivity(a, "prompt", `Angus → @${pr.name}${onBoard ? " (board)" : ""}: ${text}`, { project: pr.id }, room);
      }
      return { project: pr.id, name: pr.name, told, writer: displayName(writer) };
    },

    tinker: (p, conn) => {
      let text = String(p.text ?? "").trim();
      const a = conn.agentId ? agents.get(conn.agentId) : null;
      // "D: text" / "D : text": the workshop is world D from now on (remembered, announced).
      let set = null;
      const lm = /^([A-Z])\s*:\s*([\s\S]*)$/.exec(text);
      if (lm && WORLD_LETTERS.includes(lm[1])) {
        const prev = workshopRoom();
        text = lm[2].trim();
        if (lm[1] !== prev) {
          cfg.workshop = lm[1];
          try { fs.writeFileSync(WORKSHOP_FILE, JSON.stringify({ workshop: lm[1], set_at: Date.now() })); } catch (e) { log("workshop write failed:", e.message); }
          set = { workshop: lm[1], previous: prev || null };
          const note = `🔧 The workshop is world ${lm[1]} now${prev ? ` (was ${prev})` : ""}: /tinker drops friction fixes off there. Set with "/tinker ${lm[1]}: …"; say it again with another letter to move it.`;
          for (const r of new Set([a?.room || roomForWorkspace(activeWs), lm[1]].filter(Boolean)))
            appendMessage(safeRoom(r), { author: { kind: "human", name: "Angus", via: "tinker" }, text: note, undelivered: true });
          log(`tinker: workshop set to ${lm[1]}${prev ? ` (was ${prev})` : ""}`);
        }
      }
      const room = workshopRoom();
      if (!room) throw new Error('no workshop world yet: say which once, e.g. "/tinker D: what to fix"');
      if (!text) return { room, set, queued: false, position: 0, nothing: true };
      if (Buffer.byteLength(text) > MAX_TEXT) throw new Error("text must be 1..8192 bytes");
      const job = { text, ts: Date.now(), via: p.via || "", from: a ? { name: displayName(a), room: a.room || "", cwd: String(a.cwd || "").replace(/^\/home\/[^/]+/, "~") } : null };
      tinkerQueue.push(job); saveTinker();
      dispatchTinker();
      const waiting = tinkerQueue.indexOf(job) + 1;
      return { room, set, queued: waiting > 0, position: waiting || 0, spawning: waiting > 0 && Date.now() - tinkerSpawnedAt < 2000 };
    },

    "agent.focus": async (p) => {
      const { agent, error } = findAgent(p.agent);
      if (error) throw new Error(error);
      if (!agent.address) { await refreshWindows(); }
      if (!agent.address) throw new Error("agent window not found");
      await hypr.focusWindow(agent.address, { env });
      return { agent: agent.id, address: agent.address, workspace: agent.workspace };
    },

    talk: (p, conn) => {
      const from = agents.get(conn.agentId);
      if (!from) throw new Error("talk is for hyprpi agents");
      const text = String(p.text ?? "");
      if (!text.trim() || Buffer.byteLength(text) > MAX_TEXT) throw new Error("message must be 1..8192 bytes");
      const mode = p.mode === "demand" ? "demand" : "talk";
      const names = Array.isArray(p.to) ? p.to.map(String) : [];
      let targets = [], skipped = [];
      if (names.length === 1 && names[0].toLowerCase() === "all") targets = [...agents.values()].filter((a) => a.id !== from.id);
      else for (const n of names) {
        const { agent, error } = findAgent(n, { exclude: from.id });
        if (error || agent.id === from.id) skipped.push({ name: n, reason: error || "that is you" });
        else if (!targets.includes(agent)) targets.push(agent);
      }
      const request_id = randomUUID();
      const req = { from: from.id, mode, recipients: new Set(), replies: new Map() };
      const delivered = [];
      for (const t of targets) {
        if (sendAgent(t, "talk", { request_id, mode, text, from: { id: from.id, name: displayName(from) }, expires_in: Number(p.timeout_seconds) || (mode === "demand" ? 120 : 1800) })) {
          req.recipients.add(t.id); delivered.push(displayName(t));
        } else skipped.push({ name: displayName(t), reason: "not connected" });
      }
      if (delivered.length) recordActivity(from, mode, `${mode === "demand" ? "asks" : "to"} ${delivered.join(", ")}: ${text}`, { to: delivered });
      if (req.recipients.size) {
        requests.set(request_id, req);
        setTimeout(() => requests.delete(request_id), 1000 * Math.min(3600, Number(p.timeout_seconds) || 1800) + 5000).unref?.();
      }
      return { request_id, delivered, skipped };
    },

    "talk.reply": (p, conn) => {
      const req = requests.get(String(p.request_id || ""));
      const a = agents.get(conn.agentId);
      if (!req || !a) throw new Error("unknown or expired request_id");
      if (!req.recipients.has(a.id)) throw new Error("that request was not sent to you");
      if (req.replies.has(a.id)) throw new Error("you already replied to this request");
      const text = String(p.text ?? "");
      if (!text.trim() || Buffer.byteLength(text) > 32768) throw new Error("reply must be 1..32768 bytes");
      req.replies.set(a.id, text);
      const sender = agents.get(req.from);
      recordActivity(a, "reply", `replies to ${sender ? displayName(sender) : "?"}: ${text}`, { to: sender ? [displayName(sender)] : [] });
      const ok = sendAgent(sender, "talk.reply", { request_id: p.request_id, mode: req.mode, from: { id: a.id, name: displayName(a) }, text, remaining: req.recipients.size - req.replies.size });
      return { delivered: ok };
    },

    // One-shot answer about a room (the room TUI's /ask): conversations, room log and activity,
    // one small-model call, no memory. -> { answer, citations: [{ kind, who, ts, text }], model }
    ask: async (p) => {
      const room = safeRoom(p.room || roomForWorkspace(activeWs) || "A");
      const question = String(p.question || "").trim();
      if (!question) throw new Error("no question");
      const only = Array.isArray(p.agents) && p.agents.length ? p.agents.map(String) : null;
      const closed = p.closed !== false;
      // interactions: the same history window as the room TUI (default 200, "all" = everything).
      const all = activityAll(room), since = historySince(room, p.interactions ?? 200, all);
      const acts = all.filter((e) => e.ts >= since && (!only || only.includes(e.agent?.id)) && (closed || agents.has(e.agent?.id)));
      const sources = [...roomSources(room, only, { closed }), activitySource(acts)];
      if (since) for (const s of sources) s.entries = s.entries.filter((e) => e.ts >= since);
      const t0 = Date.now();
      const r = await askRoom(question, sources, { model: cfg.askModel || cfg.searchModel || "claude-haiku-4-5", pi: cfg.pi });
      return { room, ...r, ms: Date.now() - t0 };
    },

    // Search the conversations of a room's agents (live, and ones that were
    // in the room before) plus the room log.
    search: async (p) => {
      const room = safeRoom(p.room || roomForWorkspace(activeWs) || "A");
      const query = String(p.query || "").trim();
      if (!query) return { room, mode: p.mode, results: [], sources: 0 };
      const only = Array.isArray(p.agents) ? p.agents.map(String) : null;
      const sources = roomSources(room, only, { closed: p.closed !== false, roomLog: p.room_log !== false });
      const t0 = Date.now();
      if (p.mode === "ai") {
        // Read the config per search so aiSearchChars / aiSearchActivityShare apply without a restart.
        const c = loadConfig();
        const closed = p.closed !== false;
        const acts = activityAll(room).filter((e) => e.kind !== "done" && e.agent?.id && (!only || only.includes(e.agent.id)) && (closed || agents.has(e.agent.id)));
        const actSource = { key: "activity", kind: "activity", name: "activity", live: true, entries: acts.map((e, i) => {
          const live = agents.get(e.agent.id);
          return { eid: String(i), role: "activity", ts: e.ts, text: `${e.kind === "tool" ? "" : e.kind + ": "}${e.text}`,
            agent: { id: e.agent.id, name: live ? displayName(live) : (e.agent.name || "?"), icon: live?.icon || e.agent.icon || "", color: live?.color || e.agent.color || "", live: !!live } };
        }) };
        const { results, scanned, answer, activityChars, named } = await aiSearch(query, [...sources, actSource], {
          model: c.searchModel, pi: c.pi, budget: Number(c.aiSearchChars) || 110000, activityShare: c.aiSearchActivityShare ?? 0.2,
        });
        return { room, mode: "ai", results, answer, named, sources: sources.length, scanned, activity_chars: activityChars, ms: Date.now() - t0 };
      }
      const results = keywordSearch(query, sources);
      return { room, mode: "keyword", results, sources: sources.length, ms: Date.now() - t0 };
    },

    "ui.search": (p) => {
      const room = p.room ? safeRoom(p.room) : (roomForWorkspace(activeWs) || "A");
      let n = 0;
      for (const c of conns) if (c.windows) { send(c, "search", { room, toggle: !!p.toggle }); n++; }
      return { room, delivered: n };
    },

    shutdown: () => { setTimeout(() => process.exit(0), 50); return { ok: true }; },
  };

  // ---------------------------------------------------------------- server ---
  const server = net.createServer((sock) => {
    const conn = { sock, ui: false, agentId: null };
    conns.add(conn);
    let buf = "";
    sock.on("data", async (d) => {
      buf += d.toString();
      if (buf.length > 1 << 20) { sock.destroy(); return; }
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        if (!line.trim()) continue;
        let req; try { req = JSON.parse(line); } catch { continue; }
        const fn = methods[req.method];
        let reply;
        try {
          if (!fn) throw new Error(`unknown method ${req.method}`);
          reply = { id: req.id, result: await fn(req.params || {}, conn) };
        } catch (e) { reply = { id: req.id, error: e.message }; }
        if (!sock.destroyed) sock.write(JSON.stringify(reply) + "\n");
      }
    });
    sock.on("error", () => {});
    sock.on("close", () => {
      conns.delete(conn);
      const a = conn.agentId && agents.get(conn.agentId);
      if (a && a.conn === conn) {
        // Give a /reload a moment to reconnect before dropping the agent, but if
        // the process is already gone (closed, killed, crashed) drop it at once,
        // so room lists update in well under a second.
        a.conn = null;
        const drop = () => { if (!a.conn && agents.get(a.id) === a) { recordActivity(a, "left", "left"); agents.delete(a.id); remember(a); for (const [r, sel] of selection) if (sel.delete(a.id)) pushSelection(r); pushAgents(); } };
        const dead = () => { const pid = a.hostPid || a.pid; if (!pid) return false; try { process.kill(pid, 0); return false; } catch (e) { return e.code === "ESRCH"; } };
        setTimeout(() => { if (dead()) drop(); }, 150);
        setTimeout(() => { if (dead()) drop(); }, 600);
        setTimeout(drop, 4000);
      }
    });
  });
  server.listen(SOCK, () => {
    fs.chmodSync(SOCK, 0o600);
    log(`hyprpi daemon listening on ${SOCK} (rooms=${cfg.rooms}, follow=${cfg.follow})`);
  });
  refreshWindows();

  const quit = () => { clearInterval(poll); clearInterval(tinkerTimer); clearInterval(beatTimer); beat(); saveRegistryNow(); stopEvents(); server.close(); try { fs.unlinkSync(SOCK); } catch {} process.exit(0); };
  process.on("SIGTERM", quit);
  process.on("SIGINT", quit);
}

function debounce(fn, ms) {
  let t = null;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}
function safeReaddir(d) { try { return fs.readdirSync(d); } catch { return []; } }
