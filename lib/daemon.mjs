// hyprpi daemon: tracks Pi agents living in their own terminal windows, groups
// them into rooms (one per hyprwrld by default), and runs each room's shared
// conversation. One daemon per Hyprland instance; NDJSON over a Unix socket.
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { socketPath, runtimeDir, stateDir, loadConfig, worldOf, wsLabel, WORLD_LETTERS } from "./paths.mjs";
import * as hypr from "./hypr.mjs";
import { sessionEntries, keywordSearch, aiSearch } from "./search.mjs";

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

  // Refuse to start twice: a live socket means another daemon.
  if (fs.existsSync(SOCK)) {
    const alive = await new Promise((res) => {
      const c = net.createConnection(SOCK);
      c.on("connect", () => { c.destroy(); res(true); });
      c.on("error", () => res(false));
    });
    if (alive) { log("another hyprpi daemon is running at", SOCK); process.exit(0); }
    fs.unlinkSync(SOCK);
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

  const saveRegistry = debounce(() => {
    try { fs.writeFileSync(registryFile + ".tmp", JSON.stringify(registry, null, 1)); fs.renameSync(registryFile + ".tmp", registryFile); }
    catch (e) { log("registry save failed", e.message); }
  }, 500);

  function remember(a) {
    registry[a.id] = {
      id: a.id, session: a.session, cwd: a.cwd, name: a.name, icon: a.icon, color: a.color,
      model: a.model, thinking: a.thinking, workspace: a.workspace, room: a.room, homeRoom: a.homeRoom,
      twinOf: a.twinOf, updatedAt: Date.now(),
    };
    saveRegistry();
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

  // --------------------------------------------------------------- agents ---
  const bare = (s) => String(s ?? "").replace(/\{#?[0-9a-fA-F]{0,6}\}/g, "").replace(/^[^\p{L}\p{N}]+/u, "").trim();
  const displayName = (a) => a.name || `pi·${a.id.slice(-4)}`;

  function view(a) {
    return {
      id: a.id, name: a.name || "", display: displayName(a), icon: a.icon || "", color: a.color || "",
      status: a.status, model: a.model || "", thinking: a.thinking || "", topic: a.topic || "",
      cwd: a.cwd || "", session: a.session || "", pid: a.pid,
      address: a.address || "", workspace: a.workspace ?? null,
      workspace_label: Number.isInteger(a.workspace) && a.workspace > 0 ? wsLabel(a.workspace, cfg.worldSize) : (a.workspaceName || ""),
      room: a.room || "", twin_of: a.twinOf || "", since: a.createdAt, active: a.lastActive,
      focused: !!a.focused,
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
  function broadcastUi(event, data) { for (const c of conns) if (c.ui) send(c, event, data); }
  const pushAgents = debounce(() => broadcastUi("agents", { agents: agentList(), rooms: knownRooms(), active_room: roomForWorkspace(activeWs), active_workspace: activeWs }), 80);

  // -------------------------------------------------------------- windows ---
  let refreshing = false, again = false;
  async function refreshWindows() {
    if (refreshing) { again = true; return; }
    refreshing = true;
    try {
      const [list, aw, act] = await Promise.all([
        hypr.clients({ env }), hypr.activeWorkspace({ env }).catch(() => null), hypr.activeWindow({ env }).catch(() => null)]);
      if (aw && Number.isInteger(aw.id)) activeWs = aw.id;
      let changed = false;
      for (const a of agents.values()) {
        const c = hypr.windowForPid(a.pid, list);
        const ws = c?.workspace?.id ?? null;
        const before = `${a.address}|${a.workspace}|${a.room}|${a.focused}`;
        a.address = c?.address || "";
        a.workspace = ws;
        a.workspaceName = c?.workspace?.name || "";
        a.focused = !!(c && act && act.address === c.address);
        const r = roomForWorkspace(ws);
        if (!a.homeRoom && r) a.homeRoom = r;
        if (cfg.follow) { if (r) a.room = r; } else a.room = a.homeRoom || r || a.room;
        if (!a.room) a.room = roomForWorkspace(activeWs) || "A";
        // Launcher asked for a workspace (e.g. a twin) and the window opened elsewhere.
        if (c && a.wantWorkspace && !a.wantDone) {
          a.wantDone = true;
          if (ws !== a.wantWorkspace) hypr.moveWindow(c.address, String(a.wantWorkspace), { env }).then(() => setTimeout(refreshWindows, 150)).catch(() => {});
        }
        if (before !== `${a.address}|${a.workspace}|${a.room}|${a.focused}`) { changed = true; remember(a); }
      }
      // A room window we just asked for has mapped: make it the left-most root.
      for (const [key, want] of pendingPlacement) {
        if (Date.now() > want.until) { pendingPlacement.delete(key); continue; }
        const c = list.find((w) => (w.title || "").endsWith(" \u00b7 " + key));
        if (!c) continue;
        pendingPlacement.delete(key);
        placeLeftRoot(c, list).catch((e) => log("place failed:", e.message));
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
  async function placeLeftRoot(c, list) {
    const ws = c.workspace?.id;
    const others = list.filter((w) => w.address !== c.address && w.workspace?.id === ws && !w.floating);
    if (!others.length || c.floating) return;            // alone: it simply fills the workspace
    await hypr.focusWindow(c.address, { env });
    await hypr.dispatch('hl.dsp.layout("movetoroot")', { env });
    const now = await hypr.clients({ env });
    const me = now.find((w) => w.address === c.address);
    const minX = Math.min(...now.filter((w) => w.workspace?.id === ws && !w.floating && w.address !== c.address).map((w) => w.at[0]));
    if (me && me.at[0] > minX) await hypr.dispatch('hl.dsp.layout("swapsplit")', { env });
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
      const delivery_id = `${room}:${m.seq}:${a.id}`;
      const history = historyFor(a, room, m.seq);
      deliveries.set(delivery_id, { agentId: a.id, room, seq: m.seq, replied: false });
      if (sendAgent(a, "room.question", {
        delivery_id, room, seq: m.seq, text: m.text, history, you: displayName(a),
        members: [...agents.values()].filter((x) => x.room === room).map(displayName),
      })) { a.seen[room] = m.seq; delivered.push(displayName(a)); }
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
      const a = prev || {
        id, createdAt: Date.now(), seen: {}, status: "idle",
        name: reg.name || "", icon: reg.icon || "", color: reg.color || "", homeRoom: cfg.follow ? null : reg.homeRoom || null,
      };
      Object.assign(a, {
        conn, pid: Number(p.pid) || 0, session: p.session || a.session, cwd: p.cwd || a.cwd,
        model: p.model || a.model, thinking: p.thinking || a.thinking, lastActive: Date.now(),
        twinOf: p.twin_of || a.twinOf || "",
      });
      if (p.name && !a.name) a.name = String(p.name).slice(0, 60);
      // A twin starts with its parent's icon and colour.
      const parent = a.twinOf && agents.get(a.twinOf);
      if (parent && !prev) { a.icon = a.icon || parent.icon; a.color = a.color || parent.color; }
      if (Number.isInteger(p.want_workspace) && !prev) a.wantWorkspace = p.want_workspace;
      if (!a.room) a.room = roomForWorkspace(Number(p.want_workspace)) || roomForWorkspace(activeWs) || "A";
      agents.set(id, a);
      conn.agentId = id;
      remember(a);
      pushAgents();
      refreshSoon();
      return { agent_id: id, room: a.room, name: a.name, icon: a.icon, color: a.color };
    },

    "agent.update": (p, conn) => {
      const id = p.agent_id || conn.agentId;
      const a = agents.get(id);
      if (!a) throw new Error(`no live agent ${id}`);
      if (p.status && ["idle", "working", "blocked", "done"].includes(p.status)) { a.status = p.status; a.lastActive = Date.now(); }
      for (const k of ["model", "thinking", "session", "topic", "cwd"]) if (typeof p[k] === "string") a[k] = p[k].slice(0, 200);
      if (typeof p.name === "string") {
        // herdr-name style: "👻 Ghost" -> icon + name
        let name = p.name.replace(/\{#?[0-9a-fA-F]{0,6}\}/g, "").trim(), icon = p.icon;
        const m = name.match(/^(\S+)\s+(.+)$/);
        if (icon === undefined && m && !/[\p{L}\p{N}]/u.test(m[1])) { icon = m[1]; name = m[2].trim(); }
        a.name = name.slice(0, 60);
        if (icon !== undefined) a.icon = String(icon).slice(0, 8);
      } else if (typeof p.icon === "string") a.icon = p.icon.slice(0, 8);
      if (typeof p.color === "string" && (/^#[0-9a-fA-F]{6}$/.test(p.color) || p.color === "")) a.color = p.color;
      remember(a);
      pushAgents();
      return view(a);
    },

    whoami: (p, conn) => {
      const a = agents.get(p.agent_id || conn.agentId);
      if (!a) throw new Error("not a live hyprpi agent");
      return view(a);
    },

    list: () => ({ agents: agentList(), rooms: knownRooms(), active_room: roomForWorkspace(activeWs), active_workspace: activeWs }),

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
      const [list, aw] = await Promise.all([hypr.clients({ env }), hypr.activeWorkspace({ env }).catch(() => null)]);
      if (aw && Number.isInteger(aw.id)) activeWs = aw.id;
      const room = p.room ? safeRoom(p.room) : (roomForWorkspace(activeWs) || "A");
      const wins = list.filter((c) => /^hyprpi room /.test(c.title || "")).map((c) => ({
        address: c.address, ws: c.workspace?.id, room: (c.title.match(/^hyprpi room (\S+)/) || [])[1] || "" }));
      const here = wins.find((w) => w.ws === activeWs);
      if (here) {
        if (p.toggle) await hypr.closeWindow(here.address, { env });
        else await hypr.focusWindow(here.address, { env });
        return { room: here.room, action: p.toggle ? "closed" : "focused", delivered: 1 };
      }
      const elsewhere = wins.find((w) => w.room === room);
      if (elsewhere) {
        await hypr.focusWindow(elsewhere.address, { env });
        return { room, action: "moved", workspace: elsewhere.ws, delivered: 1 };
      }
      const key = "w" + Date.now().toString(36);
      let n = 0;
      for (const c of conns) if (c.windows) { send(c, "open", { room, key }); n++; }
      if (n) pendingPlacement.set(key, { ws: activeWs, until: Date.now() + 8000 });
      return { room, action: "opened", key, delivered: n };
    },

    "room.current": () => ({ room: roomForWorkspace(activeWs), workspace: activeWs }),

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

    "room.post": (p, conn) => {
      const text = String(p.text ?? "");
      if (!text.trim() || Buffer.byteLength(text) > MAX_TEXT) throw new Error("text must be 1..8192 bytes");
      const a = conn.agentId && !p.as_human ? agents.get(conn.agentId) : null;
      if (a) {
        const m = appendMessage(a.room, { author: { kind: "agent", id: a.id, name: displayName(a), icon: a.icon, color: a.color }, text });
        a.lastActive = Date.now();
        return { room: a.room, sequence: m.seq, persistence: "saved" };
      }
      const room = safeRoom(p.room || roomForWorkspace(activeWs));
      const m = appendMessage(room, { author: { kind: "human", name: "Angus", via: p.via || "" }, text });
      const delivered = deliverHumanPost(room, m);
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
      const m = appendMessage(d.room, { author: { kind: "agent", id: a.id, name: displayName(a), icon: a.icon, color: a.color }, reply_to: d.seq, text });
      return { room: d.room, sequence: m.seq, persistence: "saved" };
    },

    "agent.prompt": (p) => {
      const { agent, error } = findAgent(p.agent);
      if (error) throw new Error(error);
      const text = String(p.text ?? "");
      if (!text.trim()) throw new Error("empty text");
      if (!sendAgent(agent, "prompt", { text, via: p.via || "" })) throw new Error("agent not connected");
      return { agent: agent.id, name: displayName(agent) };
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
      const ok = sendAgent(sender, "talk.reply", { request_id: p.request_id, mode: req.mode, from: { id: a.id, name: displayName(a) }, text, remaining: req.recipients.size - req.replies.size });
      return { delivered: ok };
    },

    // Search the conversations of a room's agents (live, and ones that were
    // in the room before) plus the room log.
    search: async (p) => {
      const room = safeRoom(p.room || roomForWorkspace(activeWs) || "A");
      const query = String(p.query || "").trim();
      if (!query) return { room, mode: p.mode, results: [], sources: 0 };
      const sources = [];
      const seenSessions = new Set();
      for (const a of agents.values()) {
        if (a.room !== room || !a.session) continue;
        seenSessions.add(a.session);
        sources.push({ key: a.id, kind: "agent", name: displayName(a), icon: a.icon, color: a.color, live: true, entries: sessionEntries(a.session) });
      }
      for (const r of Object.values(registry)) {
        if (r.room !== room || !r.session || seenSessions.has(r.session) || agents.has(r.id)) continue;
        seenSessions.add(r.session);
        sources.push({ key: r.id, kind: "agent", name: r.name || `pi·${r.id.slice(-4)}`, icon: r.icon, color: r.color, live: false, entries: sessionEntries(r.session) });
      }
      const log = roomLog(room).msgs.map((m) => ({ eid: String(m.seq), role: m.author?.kind === "agent" ? "room" : "angus", ts: m.ts, text: `${m.author?.name || "?"}: ${m.text}` }));
      sources.push({ key: `room-${room}`, kind: "room", name: `Room ${room}`, icon: "💬", color: "", live: true, entries: log });
      const t0 = Date.now();
      if (p.mode === "ai") {
        const { results, scanned } = await aiSearch(query, sources, { model: cfg.searchModel, pi: cfg.pi });
        return { room, mode: "ai", results, sources: sources.length, scanned, ms: Date.now() - t0 };
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
        // Give a /reload a moment to reconnect before dropping the agent.
        a.conn = null;
        setTimeout(() => { if (!a.conn && agents.get(a.id) === a) { agents.delete(a.id); remember(a); pushAgents(); } }, 4000);
      }
    });
  });
  server.listen(SOCK, () => {
    fs.chmodSync(SOCK, 0o600);
    log(`hyprpi daemon listening on ${SOCK} (rooms=${cfg.rooms}, follow=${cfg.follow})`);
  });
  refreshWindows();

  const quit = () => { clearInterval(poll); stopEvents(); server.close(); try { fs.unlinkSync(SOCK); } catch {} process.exit(0); };
  process.on("SIGTERM", quit);
  process.on("SIGINT", quit);
}

function debounce(fn, ms) {
  let t = null;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}
function safeReaddir(d) { try { return fs.readdirSync(d); } catch { return []; } }
