// hyprpi daemon: tracks Pi agents living in their own terminal windows, groups
// them into rooms (one per hyprwrld by default), and runs each room's shared
// conversation. One daemon per Hyprland instance; NDJSON over a Unix socket.
import { emptiestWs as placeEmptiest, nearbyWs as placeNearby } from "./placement.mjs";
import { isAppWindow, appName, isTransient } from "./apps.mjs";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawn, execFile, execFileSync } from "node:child_process";
import { socketPath, runtimeDir, stateDir, loadConfig, worldOf, wsLabel, WORLD_LETTERS, ROOT, adoptedSignature, liveHyprlandSignatures } from "./paths.mjs";
import * as hypr from "./hypr.mjs";
import { guessIcon, askIcon } from "./project-icon.mjs";
import { sessionEntries, keywordSearch, aiSearch } from "./search.mjs";
import { topicInput, summarize, turnInput, summarizeTurn } from "./topics.mjs";
import { askRoom, activitySource } from "./ask.mjs";
import { createBoards, boardText, slugify, staleItems } from "./board.mjs";
import { buildStream, parseStreamFilter, resolveFilterNames, filterStream, streamLine } from "./stream.mjs";
import { createThoughts, thoughtsName } from "./thoughts.mjs";
import { parseDecision, sameDecision, isCatchAll } from "./decisions.mjs";
import { createBriefs, fieldsFrom, render as renderBrief, checkReport, cardText as briefCard } from "./briefs.mjs";
import { agentIn } from "./tui/agent-click.mjs";
import { loadUpkeep, expandHome, UPKEEP_FILE as UPKEEP_FILE_PATH } from "./upkeep.mjs";
import { panelOf, panelKey, panelTitle, launcherFor, writeJsonAtomic, readJson, loadJsonSafe, sessionModel, restoreOrder, summaryText } from "./openmap.mjs";
import { createRestartQueue } from "./restartq.mjs";

const VERSION = 1;
const STARTED = Date.now();
const HISTORY_MESSAGES = 40;
const HISTORY_BYTES = 32768;
const MAX_TEXT = 8192;

export async function runDaemon({ env = process.env, log = (...a) => console.error(new Date().toISOString(), ...a) } = {}) {
  process.env.HYPRPI_FROM_DAEMON = "1"; // J15: what the daemon spawns (`hyprpi new`, …) never restarts it (bin/hyprpi ensureDaemon)
  const cfg = loadConfig();
  const SOCK = socketPath(env);
  const STATE = stateDir(env);
  // J80 backstop: never a "nohypr" daemon while a Hyprland session is live (it would share STATE
  // with the live daemon and overwrite it). Clients normally adopt the live instance (paths.mjs).
  const liveHypr = env.HYPRPI_SOCKET ? [] : liveHyprlandSignatures(env);
  if (liveHypr.length && !liveHypr.includes(adoptedSignature(env))) {
    log("refusing to start a daemon outside the live Hyprland session(s) (" + liveHypr.join(", ") + "); start hyprpi from the Hyprland session");
    process.exit(1);
  }
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
  const requests = new Map();    // request_id -> { from, mode, recipients:Set, replies:Map, ts }
  // talk / demand requests are kept 12 h and survive a daemon restart (STATE/requests.json), so a
  // late talk_reply still arrives (Blink + pi·wpzt, @hyprpi N44: replies kept failing with "unknown
  // or expired request_id" after a restart, or a demand's 2 min, while the recipient was mid-turn).
  const REQ_FILE = path.join(STATE, "requests.json"), REQ_KEEP = 12 * 3600e3;
  let reqSave = null;
  const saveRequests = () => {
    if (reqSave) return;
    reqSave = setTimeout(writeRequests, 300);
    reqSave.unref?.();
  };
  // Also at quit (J15): a request made just before a restart (open_agent's brief, ~0.2 s before
  // `hyprpi new` restarted the daemon for Dormouse) was lost with the 300 ms debounce.
  function writeRequests() {
      if (reqSave) { clearTimeout(reqSave); reqSave = null; }
      const now = Date.now(), out = [];
      for (const [id, r] of requests) { if (now - (r.ts || now) > REQ_KEEP) { requests.delete(id); continue; } out.push([id, { ...r, recipients: [...r.recipients], replies: [...r.replies] }]); }
      try { fs.writeFileSync(REQ_FILE + ".tmp", JSON.stringify(out)); fs.renameSync(REQ_FILE + ".tmp", REQ_FILE); } catch { /* best effort */ }
  }
  const keepRequest = (id, req) => { req.ts ||= Date.now(); requests.set(id, req); saveRequests(); };
  try {
    for (const [id, r] of JSON.parse(fs.readFileSync(REQ_FILE, "utf8")))
      if (Date.now() - (r.ts || 0) < REQ_KEEP) requests.set(id, { ...r, recipients: new Set(r.recipients || []), replies: new Map(r.replies || []) });
  } catch { /* none yet */ }
  setInterval(saveRequests, 600e3).unref?.(); // sweeps the old ones
  const rooms = new Map();       // room -> { msgs:[], next }
  const registryFile = path.join(STATE, "agents.json");
  let registry = {};
  { // A torn agents.json falls back to agents.json.bak and is kept aside, never overwritten (pi·wpzt, J8).
    const got = loadJsonSafe(registryFile, {});
    registry = got.data && typeof got.data === "object" ? got.data : {};
    if (got.from !== "file" && fs.existsSync(registryFile)) log(`!! agents.json was unreadable: kept as ${got.torn || "(copy failed)"}; loaded ${got.from === "bak" ? "agents.json.bak" : "nothing"} (${Object.keys(registry).length} records)`);
  }
  let activeWs = null;
  const pendingPlacement = new Map(); // room-window key -> { ws, until }
  // Workspaces whose agents are out of every room (config offLimitsWorkspaces).
  const OFFLIMITS = new Set(cfg.offLimitsWorkspaces || ["special:reprieve"]);

  // Atomic, and the previous version kept as agents.json.bak (restore-all, J8).
  const saveRegistry = debounce(() => {
    try { writeJsonAtomic(registryFile, registry); }
    catch (e) { log("registry save failed", e.message); }
  }, 500);

  function remember(a) {
    const live = agents.get(a.id) === a;
    const old = registry[a.id] || {};
    // The last workspace it was seen on (a window not found for a moment is not "no workspace");
    // homeWs = the last normal (positive) one, where a parked agent goes back to.
    const ws = Number.isInteger(a.workspace) ? a.workspace : (Number.isInteger(old.workspace) ? old.workspace : null);
    const homeWs = Number.isInteger(ws) && ws > 0 ? ws : (Number.isInteger(old.homeWs) ? old.homeWs : null);
    registry[a.id] = {
      id: a.id, session: a.session, cwd: a.cwd, name: a.name, nameMarkup: a.nameMarkup || "", icon: a.icon, color: a.color,
      model: a.model, thinking: a.thinking, workspace: ws, homeWs, wsName: a.workspaceName || old.wsName || "", room: a.room, homeRoom: a.homeRoom,
      // Restore-all (J8): open = restore it after a crash / shutdown / daemon stop, until it is
      // closed on purpose: it went away on its own, see agentGone; closedBy / closedReason / closedAt).
      open: a.bye ? false : live ? true : old.open === true,
      closedBy: a.bye ? a.bye.by : live ? "" : old.closedBy || "", closedReason: a.bye ? a.bye.reason : live ? "" : old.closedReason || "",
      closedAt: a.bye ? a.bye.at : live ? 0 : old.closedAt || 0, parked: !!a.parked,
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
    try { writeJsonAtomic(registryFile, registry); } catch { /* best effort */ }
  };

  // ------------------------------------------------ resume after a restart ---
  // The daemon writes a heartbeat every 10 s (and on a clean exit). On start, an agent
  // that was still connected then, or that went away at most 30 s before the last beat
  // (a reboot / logout kills agents and daemon together), is "dormant": the room TUI
  // lists it greyed and Enter resumes its Pi session with the same id (twins stay twins).
  // A window you close while hyprpi keeps running is gone for good.
  // Same login as the previous daemon (Angus, 2026-10-02: "why when I went to open an agent it asked me
  // to restore one window???"): a restart within one Hyprland session and one boot (a code deploy,
  // the daemon alone crashing) leaves every window open, so there is nothing to restore and no
  // offer. A panel still in the map but not on screen was closed while no daemon was watching (the
  // restart gap): it is let go at the first refresh; so is an open agent whose pi is gone (Phoenix).
  // Within one login a close just before the end is a real close (no 5 s re-instate). After a logout,
  // reboot or Hyprland crash (a new instance signature or boot id), or with no / an unreadable session
  // file (fail safe), everything works as before. `hyprpi restore` works any time, without this check.
  const SESSION_FILE = path.join(STATE, "daemon.session");
  const thisSession = { his: env.HYPRLAND_INSTANCE_SIGNATURE || "", boot: (() => { try { return fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim(); } catch { return ""; } })() };
  const prevSession = loadJsonSafe(SESSION_FILE, {}).data || {};
  const sameSession = !!(thisSession.his && thisSession.boot && prevSession.his === thisSession.his && prevSession.boot === thisSession.boot);
  try { writeJsonAtomic(SESSION_FILE, thisSession); } catch { /* best effort */ }
  let gapPanelsPending = sameSession; // reconcile the panel map once, at the first window refresh
  if (sameSession) log("restart within the same login: no restore offer");
  // J78: how long a crash leftover (resumable) is listed and offered: cfg.resumableHours, default 72 h.
  const RESUME_H = Number(cfg.resumableHours) || 72;
  // Counted from when a daemon first found it lost (lostSeenAt), not from leftAt: a machine that was
  // off for a long weekend must still offer the windows that were open when it went down.
  const tooOld = (r) => { const t = r.lostSeenAt || r.leftAt; return !!t && Date.now() - t > RESUME_H * 3600000; };
  const beatFile = path.join(STATE, "daemon.beat");
  let lastEnd = 0; // the previous daemon's last beat (its end)
  const beat = () => { try { fs.writeFileSync(beatFile, String(Date.now())); } catch { /* best effort */ } };
  const pidIsAgent = (pid, id) => {
    if (!pid) return false;
    try { return fs.readFileSync(`/proc/${pid}/environ`, "utf8").split("\0").includes("HYPRPI_AGENT_ID=" + id); } catch { return false; }
  };
  {
    let lastBeat = 0;
    try { lastBeat = Number(fs.readFileSync(beatFile, "utf8")) || 0; } catch { /* first run */ }
    let n = 0, back = 0, gapGone = 0, cleared = 0, expired = 0;
    for (const r of Object.values(registry)) {
      // Restore-all (J8): a window closed (not an explicit bye) within 5 s of the daemon's end was
      // the shutdown closing it, not Angus: it stays open (restorable).
      if (!sameSession && "open" in r && r.open === false && (r.closedBy === "gone" || r.closedBy === "window") && lastBeat && r.closedAt >= lastBeat - 5000) {
        r.open = true; r.closedBy = ""; r.closedReason = ""; r.closedAt = 0; back++;
      }
      // Records that know "open" use it: an agent that said bye is never resumable, however close
      // to the end it quit (was: anything gone within 30 s of the last beat).
      const wasOpen = "open" in r ? r.open === true && !r.forgotten
        : r.connected === true || (lastBeat && r.connected === false && r.leftAt >= lastBeat - 30000);
      // J78: a J8 record that wasn't open is never resumable, whatever an older restart left behind.
      if (!wasOpen && "open" in r && r.resumable) { r.resumable = false; cleared++; }
      if (!wasOpen || pidIsAgent(r.pid, r.id) || pidIsAgent(r.hostPid, r.id)) continue; // still running: it reconnects by itself
      if (sameSession && "open" in r) { // same login: its pi went away while no daemon was watching
        Object.assign(r, { open: false, closedBy: "gone", closedReason: "closed while the daemon was down", closedAt: Date.now(), resumable: false }); gapGone++; continue;
      }
      r.resumable = true; r.connected = false; r.leftAt = r.leftAt || lastBeat || Date.now(); n++;
      // J78 expiry clock: lost while a daemon ran (well before its last beat) → from leftAt; lost at the
      // shutdown itself or unknown → from now, so time the machine was off doesn't count.
      r.lostSeenAt = r.lostSeenAt || (r.leftAt && lastBeat && r.leftAt < lastBeat - 30000 ? r.leftAt : Date.now());
    }
    if (back) log(`${back} agent window(s) closed by the shutdown itself: kept for restore`);
    if (gapGone) log(`${gapGone} agent(s) went away while the daemon restarted: closed (same login)`);
    // J78 (Angus: "yes to all"): crash leftovers expire after resumableHours (default 72 h from when they
    // were lost). The record and its session stay (closedBy "expired"); restore-all no longer offers it.
    for (const r of Object.values(registry)) {
      if (!tooOld(r) || pidIsAgent(r.pid, r.id) || pidIsAgent(r.hostPid, r.id)) continue;
      if (!r.resumable && !("open" in r && r.open === true && r.connected === false)) continue;
      Object.assign(r, { resumable: false, closedBy: "expired", closedReason: `lost in a restart more than ${RESUME_H} h ago`, closedAt: r.closedAt || Date.now() });
      if ("open" in r) r.open = false;
      expired++;
    }
    if (cleared) log(`${cleared} closed agent(s) were still marked resumable: cleared`);
    if (expired) log(`${expired} crash leftover(s) older than ${RESUME_H} h: expired (records and sessions kept)`);
    if (n || back || gapGone || cleared || expired) { if (n || back) log(`${n} agent(s) from the last session can be resumed`); saveRegistryNow(); }
    lastEnd = lastBeat;
  }
  beat();
  const beatTimer = setInterval(beat, 10000);
  const resuming = new Map(); // id -> time the resume was started (hide it meanwhile)
  // J87 /restart: id -> { by, compact, before, ws, guest, focused, at } while an agent's pi is replaced.
  const restarts = new Map();
  const lastRestart = new Map(); // id -> the finished restart (its report)
  // An agent process's numbers for the restart report: pid, pi version (from its binary's path), RSS in MB.
  function procInfo(pid) {
    const out = { pid: Number(pid) || 0, version: "", rssMb: 0 };
    if (!out.pid) return out;
    try { const exe = fs.realpathSync(`/proc/${out.pid}/exe`); out.version = (exe.match(/installs\/pi\/([^/]+)\//) || [])[1] || exe; } catch { /* gone */ }
    try { const m = fs.readFileSync(`/proc/${out.pid}/status`, "utf8").match(/VmRSS:\s+(\d+)/); if (m) out.rssMb = Math.round(Number(m[1]) / 1024); } catch { /* gone */ }
    return out;
  }

  // ------------------------------------------------------- restore-all (J8) ---
  // What is open, kept current so a crash, shutdown or `hyprpi stop` loses nothing: agents in the
  // registry (open: true until closed on purpose), panels in STATE/panels.json. On SIGTERM / SIGHUP
  // / shutdown the daemon saves both and freezes them (closes after that are the shutdown's).
  // When a fresh daemon finds open agents / panels that aren't live, the first deliberate entry
  // point (hyprpi new, the panel keys) offers to restore them once; `hyprpi restore` any time.
  const PANELS_FILE = path.join(STATE, "panels.json");
  const panelState = loadJsonSafe(PANELS_FILE, {}).data || {};
  if (!Array.isArray(panelState.panels)) panelState.panels = [];
  if (!Array.isArray(panelState.closed)) panelState.closed = [];
  { // Panels closed within 5 s of the previous daemon's end were closed by the shutdown: keep them.
    const keep = [];
    for (const p of panelState.closed) {
      if (!sameSession && lastEnd && p.closedAt >= lastEnd - 5000 && !panelState.panels.some((x) => panelKey(x) === panelKey(p))) panelState.panels.push({ ...p, closedAt: undefined });
      else keep.push(p);
    }
    panelState.closed = keep.slice(-20);
  }
  let frozen = false;          // set on the way out: no close / gone event changes the map after it
  let panelsMayEmpty = false;  // the never-empty rule: only a deliberate removal may empty it
  let panelsSavedCount = panelState.panels.length;
  function savePanelsNow(reason = "change") {
    if (!panelState.panels.length && panelsSavedCount > 0 && !panelsMayEmpty) { log("panels map: refusing to replace a non-empty map with an empty one"); return; }
    panelsMayEmpty = false;
    try {
      writeJsonAtomic(PANELS_FILE, { version: 1, savedAt: Date.now(), reason, frozen, daemonPid: process.pid, panels: panelState.panels, closed: panelState.closed });
      panelsSavedCount = panelState.panels.length;
    } catch (e) { log("panels save failed", e.message); }
  }
  const savePanels = debounce(() => { if (!frozen) savePanelsNow("change"); }, 2000);
  // Every refresh: add / update the panels that are open (never removes: see windowClosed).
  function panelsSeen(list) {
    if (frozen) return;
    let changed = false;
    if (gapPanelsPending) { // same login: panels in the map that aren't on screen were closed during the restart
      gapPanelsPending = false;
      const titles = new Set(list.map((c) => c.title || ""));
      const gone = panelState.panels.filter((p) => !titles.has(panelTitle(p.kind, p.world)));
      if (gone.length) {
        panelState.panels = panelState.panels.filter((p) => !gone.includes(p));
        for (const p of gone) panelState.closed.push({ ...p, closedAt: Date.now() });
        panelState.closed = panelState.closed.slice(-20);
        panelsMayEmpty = true; changed = true;
        log(`closed while the daemon restarted: ${gone.map(panelKey).join(", ")} (let go)`);
      }
    }
    const seen = new Set();
    for (const c of list) {
      const p = panelOf(c);
      if (!p || seen.has(panelKey(p))) continue;
      seen.add(panelKey(p));
      // A panel switched to another world (/world, ^Tab) keeps its window but changes its title:
      // drop its old entries (same window, other world), or a restore would open one per world it visited.
      const stale = panelState.panels.filter((x) => x.address === p.address && panelKey(x) !== panelKey(p));
      if (stale.length) { panelState.panels = panelState.panels.filter((x) => !stale.includes(x)); changed = true; }
      const i = panelState.panels.findIndex((x) => panelKey(x) === panelKey(p));
      if (i >= 0 && JSON.stringify(panelState.panels[i]) === JSON.stringify(p)) continue;
      if (i >= 0) panelState.panels[i] = p; else panelState.panels.push(p);
      changed = true;
    }
    if (changed) savePanels();
  }
  // A deliberate close: the agent is not restored (its record stays, with who closed it and why).
  function closeAgent(id, by, reason) {
    const at = Date.now(), a = agents.get(id);
    if (a) { a.bye = { by, reason, at }; remember(a); }
    const r = registry[id];
    if (r) { Object.assign(r, { open: false, closedBy: by, closedReason: reason, closedAt: at, resumable: false }); saveRegistry(); }
    log(`closed ${id} on purpose (${by}: ${reason})`);
  }
  // The one rule (Angus, 2026-10-01: "the simple one"): an agent or panel that goes away ON ITS
  // OWN was closed on purpose (a window closed by hand, /quit, /handoff, ^W / ^K) and is dropped
  // from the map. One that goes away TOGETHER with others (3+ hyprpi windows within 3 s: a logout,
  // Hyprland going down), or while the daemon is going down (frozen), or in a power cut, stays and
  // is restored. Each removal waits 6 s first, so a shutdown that follows can still freeze it.
  // (A pi that crashes alone counts as closed; it stays in the room panel's closed list.)
  const goneAt = new Map(); // window address -> when a hyprpi window (agent or panel) closed
  const togetherWith = (t) => [...goneAt.values()].filter((x) => Math.abs(x - t) <= 3000).length;
  function noteGone(addr, t = Date.now()) {
    if (addr) goneAt.set(addr, t);
    for (const [k, v] of goneAt) if (t - v > 20000) goneAt.delete(k);
  }
  function windowClosed(raw) {
    if (frozen || !raw) return;
    const addr = raw.startsWith("0x") ? raw : "0x" + raw;
    const a = [...agents.values()].find((x) => x.address === addr);
    const p = panelState.panels.find((x) => x.address === addr);
    if (!a && !p) return;
    const now = Date.now();
    noteGone(addr, now);
    if (!p) return; // an agent is handled when its connection drops (agentGone)
    setTimeout(() => {
      if (frozen) return;
      const n = togetherWith(now);
      if (n >= 3) { log(`${n} hyprpi windows closed together: taken as a shutdown, kept for restore`); return; }
      const i = panelState.panels.indexOf(p);
      if (i < 0) return;
      panelState.panels.splice(i, 1);
      panelState.closed.push({ ...p, closedAt: Date.now() });
      panelState.closed = panelState.closed.slice(-20);
      panelsMayEmpty = true; savePanelsNow("change");
      log(`panel ${panelKey(p)} closed`);
    }, 6000).unref?.();
  }
  // An agent's connection dropped and its process is gone (or never came back).
  function agentGone(a) {
    if (frozen) return;
    const now = Date.now();
    if (a.address && !goneAt.has(a.address)) noteGone(a.address, now);
    setTimeout(() => {
      if (frozen || agents.has(a.id) || restarts.has(a.id)) return; // going down, or it came back (a /reload, a restart, J87 /restart)
      const n = togetherWith(now);
      if (n >= 3) { log(`${displayName(a)} went with ${n - 1} other window(s): taken as a shutdown, kept for restore`); return; }
      closeAgent(a.id, "gone", "closed on its own (window closed, /quit or /handoff)");
    }, 6000).unref?.();
  }

  // The world an agent record belongs to (a parked one: the world it was parked from).
  const recordWorld = (r) => r.parked ? (r.parkedFrom || roomForWorkspace(r.homeWs) || r.room || "") : (roomForWorkspace(r.workspace) || r.room || r.homeRoom || "");
  // What a restore would bring back: open agents whose pi isn't running, open panels not on screen.
  async function restorePlan(scope = "all") {
    const want = scope && scope !== "all" ? safeRoom(scope) : "";
    const liveSessions = new Set([...agents.values()].map((a) => a.session).filter(Boolean));
    const bySession = new Map(), missing = [];
    for (const r of Object.values(registry)) {
      if (r.open !== true || r.forgotten || agents.has(r.id)) continue;
      if (pidIsAgent(r.pid, r.id) || pidIsAgent(r.hostPid, r.id)) continue; // still running: it reconnects by itself
      if (r.session && liveSessions.has(r.session)) continue;
      const world = recordWorld(r);
      if (want && String(world).toUpperCase() !== want.toUpperCase()) continue;
      if (!r.session || !fs.existsSync(r.session)) { missing.push({ id: r.id, name: displayName(r), world, session: r.session || "" }); continue; }
      const prev = bySession.get(r.session);
      if (!prev || (r.updatedAt || 0) > (prev.updatedAt || 0)) bySession.set(r.session, r);
    }
    const agentsOut = restoreOrder([...bySession.values()].sort((x, y) => (x.workspace ?? 0) - (y.workspace ?? 0))).map((r) => ({
      id: r.id, name: displayName(r), icon: r.icon || "", world: recordWorld(r), workspace: r.parked ? r.homeWs : r.workspace,
      parked: !!r.parked, wsName: r.wsName || "", cwd: r.cwd, session: r.session, twinOf: r.twinOf || "",
    }));
    // J34: if Hyprland's windows can't be read, restore no panels (it used to restore them all, so any
    // that were open got a second copy). Agents are unaffected (they're matched by id).
    let titles = null;
    try { titles = new Set((await hypr.clients({ env })).map((c) => c.title || "")); } catch (e) { log("restore: couldn't read Hyprland's windows, so no panels are offered:", e.message); }
    const panels = !titles ? [] : panelState.panels.filter((p) => (!want || String(p.world).toUpperCase() === want.toUpperCase()) && !titles.has(panelTitle(p.kind, p.world))).map((p) => ({ ...p }));
    return { agents: agentsOut, panels, missing, text: summaryText(agentsOut, panels) };
  }
  const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));
  const shq = (s) => "'" + String(s).replace(/'/g, "'\\''") + "'";
  // The env a launched window needs from this daemon (an isolated test daemon has its own socket).
  const passEnv = () => Object.entries({ ...process.env, ...env }).filter(([k]) => /^(HYPRPI_SOCKET|HYPRPI_STATE|XDG_RUNTIME_DIR|XDG_STATE_HOME|XDG_CONFIG_HOME)$/.test(k)).map(([k, v]) => `${k}=${shq(v)}`);
  let restoring = null;
  const NOTE_APP = "hyprpi restore"; // no window class matches it (see finish)
  async function runRestore(scope = "all", by = "") {
    if (restoring) throw new Error("a restore is already running");
    const plan = await restorePlan(scope);
    restoring = { scope, started: Date.now(), total: plan.agents.length + plan.panels.length, done: 0 };
    const bin = new URL("../bin/hyprpi", import.meta.url).pathname;
    const back = [], failed = [];
    let backPanels = 0;
    // ONE desktop notification (Angus): it counts up in place while windows open on other
    // workspaces, then turns into "hyprpi restore complete", the only one to dismiss. Critical,
    // because Omarchy keeps those until dismissed; sends are serialised so each update has the id.
    let noteId = "", sending = null, queued = null, firstAddr = "";
    const sendNote = (args) => new Promise((res) => {
      let c;
      try { c = spawn("sh", ["-c", 'command -v omarchy-notification-send >/dev/null && exec omarchy-notification-send "$@" || exec notify-send "$@"', "sh", ...args], { stdio: ["ignore", "pipe", "ignore"] }); } catch { return res(); }
      c.stdout.on("data", (d) => { noteId = String(d).trim().split(/\s+/)[0] || noteId; });
      c.on("error", () => res()); c.on("close", () => res());
    });
    const progress = (text) => {
      queued = text;
      if (!sending) sending = (async () => {
        while (queued != null) { const t = queued; queued = null; await sendNote(["--app-name", NOTE_APP, "-p", ...(noteId ? ["-r", noteId] : []), "-u", "critical", "hyprpi restore", t]); }
        sending = null;
      })();
      return sending;
    };
    // A click on the last note shows the first restored window (omarchy-notification-send --exec, as
    // bonk does); with none back, a click does nothing. The app name matches no window class: with
    // "hyprpi", a click made the notification centre focus the first hyprpi.* window it found (Angus
    // landed on Harbor in world B).
    const finish = async (title, body) => {
      queued = null; if (sending) await sending;
      const click = firstAddr ? ["--exec", "hyprctl", "dispatch", `hl.dsp.focus({ window = "address:${firstAddr}" })`] : [];
      await sendNote(["--app-name", NOTE_APP, ...(noteId ? ["-r", noteId] : []), "-u", "critical", title, ...(body ? [body] : [""]), ...click]);
    };
    const total = plan.agents.length + plan.panels.length;
    const tick = () => progress(`${restoring.done}/${total} windows open\u2026`);
    try {
      progress(`opening ${total} windows\u2026`);
      // All at once (Angus: "why can't [we] open them all at once"), in waves: every agent whose
      // original isn't still to come opens together; twins in the next wave, once their originals are up.
      const launch = (r) => {
        const { model, thinking } = sessionModel(r.session);
        const ws = Number.isInteger(r.workspace) && r.workspace > 0 ? r.workspace : null;
        const argv = ["new", "--id", r.id, "--cwd", r.cwd && fs.existsSync(r.cwd) ? r.cwd : process.env.HOME, "--no-focus",
          ...(ws ? ["--workspace", String(ws), "--silent"] : []), ...(r.twinOf ? ["--twin-of", r.twinOf] : []),
          "--", "--session", r.session, ...(model ? ["--model", thinking ? `${model}:${thinking}` : model] : [])];
        const cenv = { ...process.env, ...env };
        for (const k of Object.keys(cenv)) if (/^(HYPRPI_AGENT_ID|HYPRPI_WORKSPACE|HYPRPI_TWIN_OF|PI_SESSION)/.test(k)) delete cenv[k];
        spawn(process.execPath, [bin, ...argv], { detached: true, stdio: "ignore", env: cenv }).unref();
        resuming.set(r.id, Date.now());
        return ws;
      };
      const arrive = async (r, ws) => { // its hello and its window, up to 60 s
        let a = null;
        for (let i = 0; i < 240 && !(a = agents.get(r.id))?.address; i++) await sleepMs(250);
        if (!a) { failed.push(`${r.name} (no hello)`); return; }
        if (r.parked && a.address) { await hypr.moveWindow(a.address, r.wsName || "special:reprieve", { env }).catch(() => {}); refreshSoon(); }
        if (!r.parked) firstAddr ||= a.address;
        back.push(`${r.icon ? r.icon + " " : ""}${r.name} ${r.parked ? "parked" : ws ? wsLabel(ws, cfg.worldSize) : ""}`.trim());
        restoring.done++; tick();
      };
      let left = plan.agents.slice();
      while (left.length) {
        const wave = left.filter((r) => !left.some((o) => o.id === r.twinOf));
        const now = wave.length ? wave : left; // (a twin loop can't happen, but never stall)
        left = left.filter((r) => !now.includes(r));
        await Promise.all(now.map((r) => arrive(r, launch(r))));
      }
      // Panels last, all together, silently on their own workspaces (exec_cmd 'N silent').
      await Promise.all(plan.panels.map(async (p) => {
        const launcher = launcherFor(p.kind);
        if (!launcher) return;
        const where = Number.isInteger(p.workspace) && p.workspace > 0 ? String(p.workspace) : (p.wsName || "");
        const cmd = ["env", "-u", "HYPRPI_AGENT_ID", ...passEnv(), shq(path.join(ROOT, "mockups", launcher)), shq(p.world)].join(" ");
        await hypr.dispatch(`hl.dsp.exec_cmd([[${cmd}]]${where ? `, { workspace = "${where} silent" }` : ""})`, { env }).catch((e) => failed.push(`${p.kind} ${p.world} (${e.message})`));
        let c = null;
        for (let i = 0; i < 60 && !c; i++) { await sleepMs(250); c = (await hypr.clients({ env }).catch(() => [])).find((x) => x.title === panelTitle(p.kind, p.world)); }
        if (!c) { failed.push(`${p.kind} panel ${p.world} (no window)`); return; }
        if (p.floating && p.at && p.size) {
          const w = `window = "address:${c.address}"`;
          if (!c.floating) await hypr.dispatch(`hl.dsp.window.float({ ${w} })`, { env }).catch(() => {});
          await hypr.dispatch(`hl.dsp.window.resize({ x = ${p.size[0]}, y = ${p.size[1]}, relative = false, ${w} })`, { env }).catch(() => {});
          await hypr.dispatch(`hl.dsp.window.move({ x = ${p.at[0]}, y = ${p.at[1]}, relative = false, ${w} })`, { env }).catch(() => {});
        }
        firstAddr ||= c.address;
        backPanels++;
        back.push(`${p.kind} ${p.world}${where ? ` ${Number(where) > 0 ? wsLabel(Number(where), cfg.worldSize) : where}` : ""}`);
        restoring.done++; tick();
      }));
      // Angus: just "Restored X hyprpi windows." at the end, left until dismissed (no worlds: it is
      // the same with or without hyprwrlds).
      const notBack = failed.length + plan.missing.length;
      await finish(`Restored ${back.length} hyprpi window${back.length === 1 ? "" : "s"}.`, notBack ? `${notBack} couldn't be restored: see the room.` : "");
    } finally { restoring = null; }
    // Agents whose session file is gone can't come back: let them go, so they aren't listed every time.
    for (const m of plan.missing) { const x = registry[m.id]; if (x) Object.assign(x, { open: false, closedBy: "missing", closedReason: "session file missing at restore", closedAt: Date.now() }); }
    if (plan.missing.length) saveRegistry();
    const miss = [...plan.missing.map((m) => `${m.name} (session file missing)`), ...failed];
    const nA = back.length - backPanels, nP = backPanels;
    const text = `restored ${nA} agent${nA === 1 ? "" : "s"} and ${nP} panel${nP === 1 ? "" : "s"}${by ? ` (${by})` : ""}: ${back.join(", ") || "none"}${miss.length ? ` · not restored: ${miss.join(", ")}` : ""}`;
    const room = roomForWorkspace(activeWs) || "A";
    appendMessage(room, { author: { kind: "system", name: "hyprpi", icon: "" }, kind: "restore", text });
    log(text);
    pushAgents();
    return { restored: back, missing: plan.missing, failed, text };
  }
  // "No" to the offer: the last session's open agents and panels are let go (the agents stay
  // in the greyed list of the room TUI as before; their sessions are untouched).
  async function declineRestore() {
    const plan = await restorePlan("all");
    for (const r of [...plan.agents, ...plan.missing]) { const x = registry[r.id]; if (x) Object.assign(x, { open: false, closedBy: "declined", closedReason: "restore declined", closedAt: Date.now() }); }
    saveRegistry();
    const gone = new Set(plan.panels.map(panelKey));
    panelState.panels = panelState.panels.filter((p) => !gone.has(panelKey(p)));
    panelsMayEmpty = true; savePanelsNow("declined");
    return { declined: plan.text };
  }
  let restoreOffered = sameSession; // same login: nothing was closed by a shutdown, so no offer
  async function offerRestore(from) {
    if (restoreOffered || frozen) return { offered: false };
    restoreOffered = true; // at most once per daemon start (Blink)
    const plan = await restorePlan("all");
    if (!plan.agents.length && !plan.panels.length) return { offered: false, nothing: true };
    const here = roomForWorkspace(activeWs) || "";
    const herePlan = here ? await restorePlan(here) : null;
    const ALL = `Restore all: ${plan.text}`;
    const HERE = herePlan && (herePlan.agents.length || herePlan.panels.length) && herePlan.text !== plan.text ? `Restore world ${here} only: ${herePlan.text}` : "";
    const NO = "No: start fresh (they stay in the room panel's closed list)";
    const LATER = "Not now (hyprpi restore any time)";
    const rows = [ALL, ...(HERE ? [HERE] : []), LATER, NO];
    log(`restore offered (${from}): ${plan.text}`);
    const child = spawn(process.env.HYPRPI_RESTORE_MENU || cfg.restoreMenu || "omarchy-menu-select", ["hyprpi: restore what was open?", ...rows, "--", "--width", String(Math.min(900, Math.max(420, Math.max(...rows.map((r) => r.length)) * 9 + 60)))],
      { stdio: ["ignore", "pipe", "ignore"], env: { ...process.env, ...env } });
    let out = "";
    child.stdout.on("data", (d) => { out += d; });
    child.on("error", (e) => log("restore menu failed:", e.message));
    child.on("close", () => {
      const pick = out.trim();
      log(`restore menu: ${pick || "(dismissed)"}`);
      if (pick === ALL) runRestore("all", "all").catch((e) => log("restore failed:", e.message));
      else if (HERE && pick === HERE) runRestore(here, `world ${here}`).catch((e) => log("restore failed:", e.message));
      else if (pick === NO) declineRestore().catch((e) => log("decline failed:", e.message));
    });
    return { offered: true, text: plan.text };
  }

  // Closed while hyprpi kept running (a window closed, a kill, /quit): listed as "closed"
  // for closedHours (default 24), behind the room TUI's Ctrl+O toggle.
  const CLOSED_MS = 3600000 * (Number(cfg.closedHours) || 24);
  const isClosedRecently = (r) => r.connected === false && !r.forgotten && r.leftAt && Date.now() - r.leftAt < CLOSED_MS;
  const canResume = (r) => !!r && !agents.has(r.id) && ((r.resumable && !tooOld(r)) || isClosedRecently(r));
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
      status: "closed", dormant: true, kind: r.resumable && !tooOld(r) ? "restart" : "closed", model: r.model || "", thinking: r.thinking || "", topic: r.topic || "",
      cwd: r.cwd || "", session: r.session, workspace: r.workspace ?? null,
      workspace_label: Number.isInteger(r.workspace) && r.workspace > 0 ? wsLabel(r.workspace, cfg.worldSize) : "",
      room: r.room || r.parkedFrom || r.homeRoom || "", twin_of: r.twinOf || "", left: r.leftAt || 0,
      lost_at: r.resumable && !tooOld(r) ? r.leftAt || 0 : 0, // J78: the agents panel shows "lost in the 9/30 crash"
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
  // Archived Thoughts threads of a world (STATE/thoughts/archive/<W>-<stamp>/<W>.thread.jsonl), parsed once
  // and cached by path + size + mtime: they're read-only, so a search never re-reads them.
  const archCache = new Map();
  function archivedThoughtSources(room) {
    const base = path.join(STATE, "thoughts", "archive"), out = [];
    let dirs = []; try { dirs = fs.readdirSync(base).filter((d) => d.startsWith(room + "-")); } catch { return out; }
    for (const d of dirs.sort().reverse()) {
      const file = path.join(base, d, `${room}.thread.jsonl`);
      let st; try { st = fs.statSync(file); } catch { continue; }
      let c = archCache.get(file);
      if (!c || c.size !== st.size || c.mtimeMs !== st.mtimeMs) {
        const entries = [];
        try {
          fs.readFileSync(file, "utf8").split("\n").forEach((l, i) => {
            if (!l) return; let e; try { e = JSON.parse(l); } catch { return; }
            if ((e.role === "you" || e.role === "thoughts") && e.text) entries.push({ eid: `a${i}`, role: e.role === "you" ? "angus" : "agent", ts: e.ts || 0, text: String(e.text).slice(0, 20000) });
          });
        } catch { continue; }
        c = { size: st.size, mtimeMs: st.mtimeMs, entries };
        archCache.set(file, c);
      }
      if (!c.entries.length) continue;
      // The archive stamp is UTC (toISOString); the label shows Angus's local date.
      const m = /^[^-]+-(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})/.exec(d), at = m ? new Date(`${m[1]}T${m[2]}:${m[3]}:${m[4]}Z`) : null;
      const date = at && !isNaN(at) ? `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, "0")}-${String(at.getDate()).padStart(2, "0")}` : d;
      out.push({ key: `thoughts-${room}-archived-${d.slice(room.length + 1)}`, kind: "thoughts", archived: true, name: `${thoughtsName(room)} (archived ${date})`, icon: "💭", color: "", live: true,
        link: "file://" + file.split("/").map(encodeURIComponent).join("/"), entries: c.entries });
    }
    return out;
  }
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
    // The world's Thoughts thread: what Angus typed there (his /ignore signposts too, N52) and the
    // replies, so /keyword and /ask find them. Not when the search is limited to @agents.
    if (!keep) {
      let th = []; try { th = thoughts.get(room, 5000).entries || []; } catch { /* none yet */ }
      const tEntries = th.map((e, i) => (e.role === "you" || e.role === "thoughts") && e.text && !e.carried ? { eid: `t${i}`, role: e.role === "you" ? "angus" : "agent", ts: e.ts || 0, text: String(e.text).slice(0, 20000) } : null).filter(Boolean); // J124: carried turns are in the archive
      if (tEntries.length) sources.push({ key: `thoughts-${room}`, kind: "thoughts", name: thoughtsName(room), icon: "💭", color: "", live: true, entries: tEntries });
      // J119 (Angus: "can the keyword or ask commands search your archived version? … yes"): threads that
      // `hyprpi thoughts new` archived stay searchable, as "Thoughts-D (archived 2026-10-05)" with a link.
      sources.push(...archivedThoughtSources(room));
    }
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

  // (The ▸ marks, a shared per-room selection, are retired: Angus 2026-09-30. Messages go to
  // @Name / @project; searches and the room stream filter with @Name.)

  // --------------------------------------------------------------- agents ---
  const bare = (s) => String(s ?? "").replace(/\{#?[0-9a-fA-F]{0,6}\}/g, "").replace(/^[^\p{L}\p{N}]+/u, "").trim();
  const displayName = (a) => a.name || `pi·${a.id.slice(-4)}`;

  // An agent's latest "did" line: kept on the agent, else looked up in its room's activity tail
  // (after a daemon restart).
  function lastDidOf(a) {
    if (a.lastDid) return a.lastDid;
    if (!a.room) return null;
    const t = activityTail(safeRoom(a.room));
    for (let i = t.length - 1; i >= 0; i--) if (t[i].kind === "turn" && t[i].agent?.id === a.id) { a.lastDid = { text: t[i].text, ts: t[i].ts }; return a.lastDid; }
    a.lastDid = { text: "", ts: 0 }; return a.lastDid;
  }
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
      last_did: lastDidOf(a), // the latest "did" line (the agents panel's "last did")
      helpers: a.helpers || [], // J93: running subagents (◐ background)
      // J117: compactions of its current session, the session's start and size (null until counted)
      compactions: compactInfo(a)?.size >= 0 ? compactInfo(a).count : null, session_start: compactInfo(a)?.start || 0, session_bytes: Math.max(0, compactInfo(a)?.size || 0),
      refresh_due: refreshDue(compactInfo(a)),
    };
  }
  // J93: "2 subagents: research (Explore, 4 min), …" for ◐ background agents.
  const helpersText = (a) => { const hs = a.helpers || []; return `${hs.length} subagent${hs.length === 1 ? "" : "s"} running` + (hs.length ? ": " + hs.map((h) => `${h.description || h.type || "?"}${h.type ? ` (${h.type}` : " ("}${h.startedAt ? `${h.type ? ", " : ""}${Math.max(1, Math.round((Date.now() - h.startedAt) / 60000))} min` : ""})`).join(", ") : ""); };
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
  // An agent started from inside another agent's window (a headless test agent under pi·wpzt's
  // shell) has no window of its own: walking up its parents reaches the other agent before any
  // window, and taking that window for it moved pi·wpzt's window to the test's workspace.
  function nestedInAgent(a, list) {
    const winPids = new Set(list.map((c) => c.pid)), agentPids = new Set([...agents.values()].filter((x) => x !== a && x.pid).map((x) => x.pid));
    for (let q = hypr.ppid(a.pid), hops = 0; q > 1 && hops < 12; q = hypr.ppid(q), hops++) {
      if (winPids.has(q)) return false;
      if (agentPids.has(q)) return true;
    }
    return false;
  }
  // ---------------------------------------------------------- summon & dismiss ---
  // Guests (Angus, 2026-09-30, "summon & dismiss" v1): agents summoned to the workspace Angus is on
  // (SUPER+S), remembered with their home workspace so SUPER+D / SUPER+ALT+D send them back, and
  // whether they are pinned (SUPER+ALT+S; a pinned guest stays through auto-dismiss and SUPER+ALT+D,
  // shown by a green border: the window tag "guestpin", a rule in hypr/hyprpi.lua). One world at a
  // time: summons come from the current world only. Kept in state/guests.json (survives restarts);
  // an entry goes when its window closes or is moved off the workspace it was summoned to.
  const GUESTS_FILE = path.join(STATE, "guests.json");
  let guests = {}; // window address -> { agent, home, ws, pinned, ts }
  try { guests = JSON.parse(fs.readFileSync(GUESTS_FILE, "utf8")) || {}; } catch { guests = {}; }
  // J25 v2: pinned or not, nothing in between: drop the old "unpinned natives may go" markers (J11).
  let staleMarks = 0;
  for (const [addr, g] of Object.entries(guests)) if (g?.native && !g.pinned) { delete guests[addr]; staleMarks++; }
  const saveGuests = () => { try { fs.writeFileSync(GUESTS_FILE + ".tmp", JSON.stringify(guests)); fs.renameSync(GUESTS_FILE + ".tmp", GUESTS_FILE); } catch (e) { log("guests write failed:", e.message); } };
  if (staleMarks) { saveGuests(); log(`J25: dropped ${staleMarks} old "may go" marker(s) from guests.json`); }
  const PANEL_TITLE = /^hyprpi-(router|room|search|board|thoughts) /;
  // Pinned hyprpi panels (Angus, @hyprpi N65): SUPER+ALT+S pins a panel like an agent window (green
  // border), and SUPER+D then leaves it open. Kept apart from guests (a panel is never a guest, so
  // borders, auto-dismiss and SUPER+ALT+D don't see it). An entry goes when its window closes.
  const PANEL_PINS_FILE = path.join(STATE, "panel-pins.json");
  let panelPins = {}; // window address -> { title, ts }
  try { panelPins = JSON.parse(fs.readFileSync(PANEL_PINS_FILE, "utf8")) || {}; } catch { panelPins = {}; }
  const savePanelPins = () => { try { fs.writeFileSync(PANEL_PINS_FILE + ".tmp", JSON.stringify(panelPins)); fs.renameSync(PANEL_PINS_FILE + ".tmp", PANEL_PINS_FILE); } catch (e) { log("panel pins write failed:", e.message); } };
  const panelName = (title) => { const m = String(title || "").match(/^hyprpi-(\S+) (\S+)/); return m ? `${m[1]} panel ${m[2]}` : "panel"; };
  // Homes given to agents that had none (Angus: a window that lives where you summon to, e.g. opened
  // there, is dismissed to the emptiest workspace of the world, which becomes its home from then on).
  const HOMES_FILE = path.join(STATE, "agent-homes.json");
  let homes = {}; // agent id (or "win:" + an app window's address, J28) -> workspace
  const winUsed = {}; // window address -> when it last had focus (this daemon's lifetime; J28 pop-up ages)
  try { homes = JSON.parse(fs.readFileSync(HOMES_FILE, "utf8")) || {}; } catch { homes = {}; }
  const saveHomes = () => { try { fs.writeFileSync(HOMES_FILE + ".tmp", JSON.stringify(homes)); fs.renameSync(HOMES_FILE + ".tmp", HOMES_FILE); } catch (e) { log("homes write failed:", e.message); } };
  // The emptiest workspace of ws's world (fewest windows; never ws; ties: the lowest number).
  // The shared rule (lib/placement.mjs); near: ties to the nearest (panels), else the lowest (agents).
  async function emptiestWs(ws, near = false) {
    return placeEmptiest(await hypr.clients({ env }).catch(() => []), ws, cfg.worldSize || 10, near);
  }
  // Where dismissed windows go (Angus: not too far away): the nearest workspace with room for `need`
  // more, up to 4 tiled windows each (lib/placement.mjs nearbyWs), else the emptiest.
  async function nearbyWs(ws, need = 1) {
    return placeNearby(await hypr.clients({ env }).catch(() => []), ws, cfg.worldSize || 10, need, Number(cfg.dismissCap) || 4);
  }
  // Clear workspace ws (SUPER+S auto, SUPER+ALT+D, SUPER+SHIFT+ALT+S): unpinned guests go home;
  // natives explicitly unpinned (SUPER+ALT+S) go to their recorded home or the emptiest workspace (N60,
  // J11), natives never touched count as pinned and stay unless o.untouched; unpinned hyprpi panels move
  // together to the nearest workspace with room for all of them (nearbyWs; J16 was nearest emptiest). o.agents / o.addrs are kept.
  async function clearWs(ws, o = {}) {
    const keepA = o.agents || new Set(), keepW = o.addrs || new Set(), dismissed = [];
    const keep = (id, addr) => keepA.has(id) || keepW.has(addr);
    // Natives listed before the guests leave (their records are stale till the next refresh).
    // Natives: every one not pinned goes (J25 v2; SUPER+S used to leave never-touched ones, J11).
    const natives = nativesOn(ws).filter((a) => !keep(a.id, a.address) && !nativePinned(a));
    for (const [addr, g] of Object.entries(guests)) {
      if (g.ws !== ws || g.pinned || g.native || keep(g.agent, addr)) continue;
      if (await sendHome(addr)) dismissed.push(guestName(g));
    }
    for (const a of natives) { delete guests[a.address]; saveGuests(); if (await sendNativeAway(a, ws)) dismissed.push(displayName(a)); }
    // App windows (Angus, J28: "clear apps like agents"): every unpinned one on ws that isn't kept.
    // Summoned ones went home above; the rest go to their recorded home or the nearest workspace with
    // room. Only moved, never closed.
    const apps = (await hypr.clients({ env }).catch(() => [])).filter((c) => c.workspace?.id === ws && isApp(c) && !keepW.has(c.address) && !guests[c.address]);
    for (const c of apps) if (await sendAppAway(c, ws)) dismissed.push(appName(c));
    const panels = (await hypr.clients({ env }).catch(() => [])).filter((c) => c.workspace?.id === ws && PANEL_TITLE.test(c.title || "") && !panelPins[c.address] && !keepW.has(c.address));
    const dest = panels.length ? await nearbyWs(ws, panels.length) : null;
    if (dest) for (const c of panels) { await moveOut(c.address, dest); dismissed.push(panelName(c.title)); }
    return dest ? { dismissed, panelsTo: dest } : { dismissed };
  }
  // Dismiss an agent window that isn't a summoned guest: its recorded home (if elsewhere in this
  // world), else the nearest workspace with room (nearbyWs: up to 4 tiled windows), recorded as its home.
  async function sendNativeAway(a, ws) {
    const size = cfg.worldSize || 10;
    let dest = homes[a.id];
    if (!(Number.isInteger(dest) && dest !== ws && worldOf(dest, size) === worldOf(ws, size))) { dest = await nearbyWs(ws); if (!dest) return null; homes[a.id] = dest; saveHomes(); }
    await moveOut(a.address, dest);
    return dest;
  }
  const agentAt = (addr) => [...agents.values()].find((x) => x.address === addr && x.conn);
  // App windows (J28, lib/apps.mjs): tiled, floating or fullscreen windows that aren't hyprpi's, an agent's or a dialog.
  const isApp = (c) => isAppWindow(c, { agentAt });
  const guestName = (g) => g.app ? g.label || "window" : displayName(agents.get(g.agent) || { id: g.agent });
  // Dismiss an app window that isn't a summoned guest: like sendNativeAway, its home kept by address.
  async function sendAppAway(c, ws) {
    const size = cfg.worldSize || 10, key = "win:" + c.address;
    let dest = homes[key];
    if (!(Number.isInteger(dest) && dest !== ws && worldOf(dest, size) === worldOf(ws, size))) { dest = await nearbyWs(ws); if (!dest) return null; homes[key] = dest; saveHomes(); }
    await moveOut(c.address, dest);
    return dest;
  }
  // A window's dialogs (J31, Angus: "yes"): transient windows of the same app (same pid) on its
  // workspace. They go wherever it goes; on their own they are never listed or moved.
  // Hyprland gives no parent, so a dialog is matched by pid; if another top-level window of the same app
  // (same pid) shares the workspace, the owner is unknown and the dialog stays (Blink: never move the wrong one).
  const transientsOf = (c, list) => {
    if (!(c.pid > 1)) return [];
    const here = list.filter((t) => t.address !== c.address && t.pid === c.pid && t.workspace?.id === c.workspace?.id);
    if (here.some((t) => !isTransient(t))) return [];
    return here.filter((t) => isTransient(t));
  };
  // Dismissing (J31, Angus): a fullscreen window leaves fullscreen and arrives as a normal window; its
  // dialogs come along. Only ever moves windows.
  async function moveOut(addr, dest) {
    const list = await hypr.clients({ env }).catch(() => []), c = list.find((w) => w.address === addr);
    if (c?.fullscreen) await hypr.unfullscreen(addr, { env }).catch(() => {});
    await hypr.moveWindow(addr, String(dest), { env }).catch(() => {});
    if (c) for (const t of transientsOf(c, list)) await hypr.moveWindow(t.address, String(dest), { env }).catch(() => {});
  }
  // Summoning (J31): the window comes in with its dialogs; normal unless keepFull (the caller decides).
  async function moveIn(addr, ws, keepFull) {
    const list = await hypr.clients({ env }).catch(() => []), c = list.find((w) => w.address === addr);
    if (c?.fullscreen && !keepFull) await hypr.unfullscreen(addr, { env }).catch(() => {});
    await hypr.moveWindow(addr, String(ws), { env }).catch(() => {});
    if (c) for (const t of transientsOf(c, list)) await hypr.moveWindow(t.address, String(ws), { env }).catch(() => {});
  }
  // Natives: agent windows that live on a workspace. Nothing is pinned unless Angus pins it (J25,
  // 2026-10-01; before, natives counted as pinned by default and showed the border): SUPER+ALT+S pins
  // one (an entry { native, pinned: true }, green border); pressing it again unpins it (the entry
  // goes). Two states only, pinned or not (J25 v2, Angus: "any agent that's not pinned gets dismissed
  // when I summon something new"): SUPER+S's auto-clear, SUPER+ALT+D and keep send every unpinned
  // native away, and SUPER+D any unpinned one. nativesOn(ws): live agent windows on ws without a
  // guest entry, or with a native entry.
  const nativesOn = (ws) => [...agents.values()].filter((x) => x.conn && x.address && x.workspace === ws && !x.parked && (!guests[x.address] || guests[x.address].native));
  const nativePinned = (a) => !!guests[a.address]?.pinned;
  // The border shows an explicit pin only (J25).
  const nativeBorderOn = (a) => nativePinned(a);
  function nativeBorders(ws) { for (const a of nativesOn(ws)) guestTag(a.address, nativeBorderOn(a)); }
  // J34: say so in the log when one panel is open twice (the evidence the duplicates in world D lacked).
  let dupSeen = "";
  function panelDupesSeen(list) {
    const by = {};
    for (const c of list) if (PANEL_TITLE.test(c.title || "")) (by[c.title] = by[c.title] || []).push(c);
    const d = Object.entries(by).filter(([, cs]) => cs.length > 1).map(([t, cs]) => `${t} on ${cs.map((c) => `${c.workspace?.id} (pid ${c.pid})`).join(", ")}`).sort().join(" · ");
    if (d !== dupSeen) { dupSeen = d; if (d) log("duplicate panel:", d); }
  }
  function guestsSeen(list) {
    panelDupesSeen(list);
    let gone = false;
    for (const [addr, g] of Object.entries(guests)) {
      const c = list.find((w) => w.address === addr);
      // A native's pin state belongs to its window (Angus, J16): moved by hand to another normal
      // workspace, it keeps pinned / unpinned there. A guest moved by hand stops being a guest.
      if (c && g.native && c.workspace?.id > 0 && c.workspace.id !== g.ws) { g.ws = c.workspace.id; gone = true; continue; }
      if (!c || (c.workspace?.id !== g.ws && !(g.native && !(c.workspace?.id > 0)))) { delete guests[addr]; gone = true; }
    }
    if (gone) saveGuests();
    let pgone = false;
    for (const [addr, pp] of Object.entries(panelPins)) {
      const c = list.find((w) => w.address === addr);
      if (!c || !PANEL_TITLE.test(c.title || "")) { delete panelPins[addr]; pgone = true; }
    }
    if (pgone) savePanelPins();
    // An app window's home goes with the window (addresses are reused after a close).
    let hgone = false;
    for (const k of Object.keys(homes)) if (k.startsWith("win:") && !list.some((w) => w.address === k.slice(4))) { delete homes[k]; hgone = true; }
    if (hgone) saveHomes();
  }
  // Keep the green border true to the recorded pins (J3 / N69): a restarted daemon, a Hyprland reload
  // or a missed dispatch can leave a pinned window untagged (or the reverse). Only windows whose pin
  // state we know are touched: guests, pinned panels / panels, and connected agent windows.
  function pinTagsSeen(list) {
    for (const c of list) {
      const has = (c.tags || []).includes("guestpin");
      let want = null;
      const g = guests[c.address], a = agentAt(c.address);
      if (g) want = !!g.pinned; // a guest, or a native pinned / unpinned with SUPER+ALT+S (even before its agent reconnects)
      else if (a && Number.isInteger(a.workspace) && !a.parked && a.workspace === c.workspace?.id) want = nativeBorderOn(a);
      else if (panelPins[c.address]) want = true;
      else if (PANEL_TITLE.test(c.title || "")) want = false;
      else if (has && isApp(c)) want = false; // an app window pins only through its entry (J28)
      if (want !== null && want !== has) guestTag(c.address, want);
    }
  }
  const guestTag = (addr, on) => hypr.dispatch(`hl.dsp.window.tag({ tag = "${on ? "+" : "-"}guestpin", window = "address:${addr}" })`, { env }).catch(() => {});
  async function sendHome(addr) {
    const g = guests[addr];
    if (!g) return false;
    delete guests[addr]; saveGuests();
    if (g.pinned) guestTag(addr, false);
    if (Number.isInteger(g.home) && g.home > 0 && g.home !== g.ws) await moveOut(addr, g.home);
    return true;
  }
  async function hereWs() {
    const aw = await hypr.activeWorkspace({ env }).catch(() => null);
    const ws = aw && Number.isInteger(aw.id) && aw.id > 0 ? aw.id : null;
    if (!ws) throw new Error("no normal workspace is active");
    return ws;
  }

  async function refreshWindows() {
    if (refreshing) { again = true; return; }
    refreshing = true;
    try {
      const [list, aw, act] = await Promise.all([
        hypr.clients({ env }), hypr.activeWorkspace({ env }).catch(() => null), hypr.activeWindow({ env }).catch(() => null)]);
      if (aw && Number.isInteger(aw.id)) activeWs = aw.id;
      if (act?.address) winUsed[act.address] = Date.now(); // the summon pop-up's "last used" for app windows (J28)
      let changed = false;
      for (const a of agents.values()) {
        const c = nestedInAgent(a, list) ? null : hypr.windowForPid(a.pid, list) || windowViaHost(a, list);
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
      guestsSeen(list);
      pinTagsSeen(list);
      panelsSeen(list);
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
  const stopEvents = hypr.subscribe((ev, data) => {
    if (ev === "closewindow") windowClosed(String(data || "").trim()); // before the refresh clears addresses
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
      // Record every job on the board (agreed by the workshop agents, 2026-09-29; Angus: "coordinate and figure it out").
      // The workshop's cards (Angus split @workshop, then kept it for odds and ends, 2026-09-29): examples, not a fixed list.
      "Record it on the board, on the card of the project it belongs to (board_read shows them; the card can be on any world's board: " +
      "e.g. hyprpi → @hyprpi, desktop / Hyprland / bar / keys / Reprieve → @omarchy, machine health: processes, audio, services, packages → @system). " +
      "Join that project if needed and add a done item with how you verified it (a plan or decide: a next or decide item). " +
      `Anything else → @workshop on board ${workshopRoom()}, the card for odds and ends (join it if needed); create a new project only for something bigger than a fix. ` +
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
    if (k === "decide") { dingFor(a, line, { itemId: "tinker" }); autoDecide(a, text, { ding: "tinker" }); }
    else if (k !== "done") bonkFor(a, line); // plan / stuck
    if (k === "done") clearDing(a, "tinker"); // it went on and finished: the question is settled
    if (k === "done" || k === "stuck") a.tinkerJob = null; // plan / decide keep the job: the answer continues it
  }
  // A decision an agent asked for outside the board (a tinker "🔧 decide:" post, or `ding "…"`, which
  // sends `hyprpi status blocked --decision "…"`) becomes a Decide item, so the projects panel's
  // Decisions view holds every decision (@hyprpi N68). Always in the agent's OWN world (Thoughts-D:
  // never moved across worlds): its project there (the one it changed most recently, else the most
  // recently updated), else that world's catch-all card (isCatchAll: workshop, inbox…, misc,
  // general), else "unfiled" on that world's board (listed in its Decisions view). No sound here:
  // the caller already rang (ding / bonk). Not twice: skipped when the agent added a Decide item
  // itself in the last 2 min (board_update + ding for one question), or one with the same question is
  // still open. A different question later is filed (pi·wpzt's test: a second question was dropped).
  function autoDecide(a, text, { ding = "" } = {}) {
    try {
      const { question, options, recommend } = parseDecision(text);
      if (!question) return null;
      const room = a.room, b = room ? boards.load(room) : null;
      const mine = (b?.projects || []).filter((p) => p.status !== "archived" && p.members.includes(a.id));
      if (!b) return null; // parked (Reprieve): no world
      const openDecides = (ps) => ps.flatMap((p) => (p.items || []).filter((it) => it.sec === "decide" && !it.archived).map((it) => ({ p, it })));
      const allOpen = boards.all().flatMap((x) => [...openDecides(x.projects.filter((p) => p.status !== "archived")), ...(x.unfiled || []).map((it) => ({ p: { name: "unfiled", id: "unfiled" }, it }))]);
      const recent = allOpen.find(({ it }) => it.by?.id === a.id && !it.auto && Date.now() - (it.ts || 0) < 2 * 60000);
      if (recent) { log(`autoDecide: ${displayName(a)} already asked @${recent.p.name} ${recent.it.h}`); return null; }
      const same = allOpen.find(({ it }) => sameDecision(it.text, question));
      if (same) { log(`autoDecide: same question open as @${same.p.name} ${same.it.h}`); return null; }
      let pr = null;
      if (mine.length) {
        const who = displayName(a);
        const lastBy = boards.changes(room, 300).find((c) => c.by === who && mine.some((p) => p.id === c.project));
        pr = (lastBy && mine.find((p) => p.id === lastBy.project)) || [...mine].sort((x, y) => (y.updated || 0) - (x.updated || 0))[0];
      } else pr = b.projects.find(isCatchAll) || null;
      if (!pr) { // unfiled, in its own world
        const u = boards.addUnfiled(room, { text: question, options, recommend }, { id: a.id, name: displayName(a) });
        u.item.auto = true; if (ding) u.item.ding = ding;
        (a.openDings ||= new Set()).add(`unfiled:${room}:${u.item.h}`);
        log(`autoDecide: ${displayName(a)} → unfiled ${room} ${u.item.h}`);
        return u;
      }
      const r = boards.addItem(pr.id, room, { section: "decide", text: question, options: options.map((o) => ({ key: o.key, text: o.text })), recommend }, { id: a.id, name: displayName(a) });
      r.item.auto = true; if (ding) r.item.ding = ding;
      (a.openDings ||= new Set()).add(`${pr.id}:${r.item.h}`);
      log(`autoDecide: ${displayName(a)} → @${pr.name} ${r.item.h}`);
      return r;
    } catch (e) { log("autoDecide failed:", e.message); return null; }
  }
  // Routing (Angus, 2026-09-29: "shouldn't it go to Thoughts-D?"): each drop-off is first offered to
  // the workshop's Thoughts agent, which picks the agent (assign_tinker → thoughts.tinkerAssign) or
  // "new". No answer within TINKER_ROUTE_MS (Thoughts down, busy with Angus, …): the old rule, the most
  // recently active free agent in the workshop room. Jobs keep their id, offer time and assignment in
  // tinker-queue.json, so a restart falls back instead of losing one. "tinkerViaThoughts": false = off.
  const TINKER_ROUTE_MS = Number(process.env.HYPRPI_TINKER_ROUTE_MS) || 90000, TINKER_ASSIGN_WAIT_MS = 10 * 60000; // env only for tests
  const tinkerGiven = new Map(); // job id -> agent name (to answer a late assign_tinker), kept 1 h
  function deliverTinker(a, job, via = "") {
    if (!sendAgent(a, "prompt", { text: tinkerPrompt(job), via: "tinker" })) return false;
    tinkerQueue = tinkerQueue.filter((j) => j !== job); a.tinkerAt = Date.now(); a.tinkerJob = job;
    tinkerGiven.set(job.id, displayName(a)); setTimeout(() => tinkerGiven.delete(job.id), 3600000).unref?.();
    const room = workshopRoom() || a.room;
    recordActivity(a, "prompt", `Angus → ${displayName(a)} (tinker): ${job.text}`, {}, room);
    appendMessage(room, { author: { kind: "human", name: "Angus", via: "tinker" }, text: `🔧 → ${displayName(a)}${via ? ` (${via})` : ""}: ${job.text}`, undelivered: true });
    saveTinker();
    return true;
  }
  function dispatchTinker() {
    const room = workshopRoom();
    if (!room || !tinkerQueue.length) return;
    const now = Date.now();
    const free = () => [...agents.values()]
      .filter((a) => a.room === room && !a.parked && a.conn && !a.conn.sock?.destroyed
        && (a.status === "idle" || a.status === "done") && now - (a.tinkerAt || 0) > 20000)
      .sort((x, y) => (y.lastActive || 0) - (x.lastActive || 0)); // warmest context first
    const viaThoughts = loadConfig().tinkerViaThoughts !== false;
    let changed = false;
    for (const job of [...tinkerQueue]) {
      if (!job.id) { job.id = randomUUID().slice(0, 8); changed = true; }
      // Thoughts picked someone: that agent gets it as soon as it's live and free (a new one: once up).
      if (job.assignTo) {
        const a = agents.get(job.assignTo);
        if (a?.conn && !a.conn.sock?.destroyed && !a.parked && isFree(a) && deliverTinker(a, job, `picked by ${thoughtsName(room)}`)) { changed = true; continue; }
        if (now - (job.assignedAt || 0) < TINKER_ASSIGN_WAIT_MS) continue;
        log(`tinker: ${job.id} was assigned to ${job.assignTo} but it never became free; falling back`);
        delete job.assignTo; job.offeredAt = 1; changed = true; // straight to the old rule
      }
      // Offer it to Thoughts once, then wait for its pick.
      if (viaThoughts && !job.offeredAt) {
        try {
          const from = job.from ? `from ${job.from.name}${job.from.room ? ` in room ${job.from.room}` : ""}` : `via ${job.via || "cli"}`;
          thoughts.system(room, `[tinker drop-off · job ${job.id} · ${from}]\n${job.text}\n\n` +
            `Route it: call assign_tinker(job="${job.id}", agent=…) with a free agent (idle or done) whose project or recent work fits (check world), or agent="new". ` +
            `Never yourself; don't do it or tell Angus (the agent reports "🔧 done"). After 90 s without your pick the usual rule takes it.`,
            `🔧 drop-off ${job.id}: ${clipT(job.text, 160)}`);
          job.offeredAt = now; changed = true; continue;
        } catch (e) { log("tinker: offering to Thoughts failed:", e.message); job.offeredAt = 1; changed = true; }
      }
      if (job.offeredAt && now - job.offeredAt < TINKER_ROUTE_MS) continue; // Thoughts is deciding
      // The old rule.
      const a = free()[0];
      if (a) { if (deliverTinker(a, job)) changed = true; else a.tinkerAt = now; continue; }
      if (now - tinkerSpawnedAt > 90000) { // nobody free: open one in the workshop
        const ws = workshopWorkspace();
        if (!ws) continue;
        tinkerSpawnedAt = now;
        const bin = new URL("../bin/hyprpi", import.meta.url).pathname;
        const cenv = { ...process.env, ...env };
        for (const k of Object.keys(cenv)) if (/^(HYPRPI_AGENT_ID|HYPRPI_WORKSPACE|HYPRPI_TWIN_OF|PI_SESSION)/.test(k)) delete cenv[k];
        spawn(process.execPath, [bin, "new", "--workspace", String(ws), "--no-focus", "--cwd", process.env.HOME || "/"], { detached: true, stdio: "ignore", env: cenv }).unref();
        log(`tinker: no free agent in ${room}, opening one on workspace ${ws}`);
      }
    }
    if (changed) saveTinker();
  }
  const tinkerTimer = setInterval(dispatchTinker, 4000);

  // ------------------------------------------------------------ board care ---
  // Angus: every project should have a LIVE writer (owner), and cards should be tidied without him
  // having to ask. Every 10 min: a project whose writer isn't live → its world's Thoughts agent is
  // asked to pick one (assign_writer; at most every 6 h per project); a project with stale items
  // (lib/board.mjs staleItems) and a free writer → the writer is asked to tidy it (at most every 12 h).
  // board.tidy / Thoughts' tidy_projects / the board's /tidy do the same on demand.
  const tidyAt = new Map(), writerAskAt = new Map();
  function tidyPrompt(pr, stale) {
    return `[hyprpi board · tidy @${pr.name}]\nYou own @${pr.name} (you're its writer). Keep its card in sync with reality, so Angus doesn't have to: ` +
      `read it (board_read @${pr.name}), then for each item decide: done → done (with how it was verified); Done items that no longer matter to where things stand → archive (keep the few that explain the current state); no longer relevant → drop; worth keeping but not current → archive (board_update action archive, handle e.g. "N3 H2"; restorable); ` +
      `a heard item that is now work → a next item (or a decide item, with options, if Angus must choose), then drop the heard one; a question for Angus filed as next → a decide item. ` +
      `Update "where" (one line) and next_step. Don't ask Angus anything for this; decide yourself, and ask project peers (talk) or Thoughts-${roomOfProject(pr)} if unsure.` +
      (stale.length ? `\nLooks stale: ${stale.map((it) => `${it.h} (${Math.round((Date.now() - (it.updated || it.ts)) / 3600e3)}h)`).join(", ")}.` : "") +
      "\nWhen done, one short room_post: what you archived, dropped and changed.";
  }
  const roomOfProject = (pr) => boards.find(pr.id)?.board.room || "";
  function nudgeTidy(pr, force = false) {
    const w = agents.get(pr.writer);
    if (!w?.conn || (!force && !isFree(w))) return null;
    if (!force && Date.now() - (tidyAt.get(pr.id) || 0) < 12 * 3600e3) return null;
    tidyAt.set(pr.id, Date.now());
    promptMember(w, tidyPrompt(pr, staleItems(pr)));
    return displayName(w);
  }
  // A card whose writer is a Thoughts agent (Loose jobs, J10): its stale jobs go to Thoughts, at most every 12 h.
  function nudgeThoughtsTidy(room, pr, force = false) {
    if (!force && Date.now() - (tidyAt.get(pr.id) || 0) < 12 * 3600e3) return null;
    tidyAt.set(pr.id, Date.now());
    const stale = staleItems(pr).map((it) => `${it.h} ${clipT(it.text, 100)}`);
    thoughts.system(room, `[board care] @${pr.name} (Loose jobs, you are its writer) has items untouched for days:\n${stale.join("\n")}\n` +
      "For each: a job that led to decisions or more work belongs in a project (move_job to an existing one; or ask its agent to create one, which takes the job along); a finished or abandoned one can stay (done jobs archive themselves). Don't ask Angus.",
      `@${pr.name}: ${stale.length} stale loose job${stale.length === 1 ? "" : "s"}; asking ${thoughtsName(room)}`);
    return thoughtsName(room);
  }
  function askForWriter(room, pr, force = false) {
    if (!force && Date.now() - (writerAskAt.get(pr.id) || 0) < 6 * 3600e3) return false;
    writerAskAt.set(pr.id, Date.now());
    const live = pr.members.filter((id) => agents.get(id)?.conn).map((id) => displayName(agents.get(id)));
    const gone = pr.writer ? nameOf(pr.writer) : "nobody";
    thoughts.system(room, `[board care] @${pr.name} has no live writer (owner): ${pr.writer ? `its writer ${gone} is closed` : "none was set"}. ` +
      `Every project needs a live owner who keeps its card current and answers Angus's messages to it. Pick one with assign_writer(project, agent): ` +
      `${live.length ? `a live member (${live.join(", ")}) whose work fits best` : "no member is live, so a live agent in this world whose work fits (check world)"}. ` +
      "Don't ask Angus; tell him in one line only if it matters. The new owner will be asked to tidy the card.",
      `@${pr.name} has no live writer; asking ${thoughtsName(room)} to pick one`);
    return true;
  }
  // Done items clean themselves up (Angus: tidy should clear the Dones too): beyond the 5 newest,
  // those older than a day are archived (restorable, "+ N archived"). No model needed.
  function archiveOldDone(room, pr) {
    const done = pr.items.filter((it) => it.sec === "done" && !it.archived).sort((x, y) => (y.updated || y.ts) - (x.updated || x.ts));
    const old = done.slice(5).filter((it) => Date.now() - (it.updated || it.ts) > 86400e3); // the 5 newest stay
    if (old.length) boards.archiveItems(pr.id, room, old.map((it) => it.h), true, { id: "", name: "board care" });
    return old.length;
  }
  function boardCare() {
    for (const b of boards.all()) for (const pr of b.projects) {
      if (pr.status === "archived" || pr.status === "paused") continue;
      try { archiveOldDone(b.room, pr); } catch (e) { log("board care done:", e.message); }
      if (/^thoughts:/.test(pr.writer || "")) { if (staleItems(pr).length) nudgeThoughtsTidy(b.room, pr); continue; } // Loose jobs (J10)
      if (!agents.get(pr.writer)?.conn) { askForWriter(b.room, pr); continue; }
      if (staleItems(pr).length) nudgeTidy(pr);
    }
  }
  const careTimer = setInterval(() => { try { boardCare(); } catch (e) { log("board care:", e.message); } }, 10 * 60e3);

  // ----------------------------------------------------------------- board ---
  // The project board (docs/board-plan.md, lib/board.mjs): one per world. Here: who is acting
  // (an agent, or Angus from a panel / the CLI), dings for decisions, and delivery to members.
  const boards = createBoards({ dir: path.join(STATE, "boards"), log, onChange: (b, change) => broadcastUi("board", { room: b.room, ...(change ? { change } : {}) }) });
  const boardActor = (conn) => { const a = conn.agentId ? agents.get(conn.agentId) : null; return a ? { a, id: a.id, name: displayName(a), human: false } : { a: null, id: "", name: "Angus", human: true }; };
  // Which board: the one named, else (for an agent naming a project) the board that project is on,
  // wherever it is (a shared member left behind by /move keeps its cards in another world), else
  // the agent's / the active world's.
  const f0room = (found) => [...new Set(found.map((f) => f.board.room))].join("/");
  // Pending opens (J15): a new agent's first prompt (welcomes: open_agent's brief, a /move hand-off) and
  // its name / icon (preIdentity, J5) wait for its hello. Kept in state/pending-opens.json too, so a
  // daemon restart or crash between the spawn and the hello loses neither (Dormouse, 2026-10-01). An
  // entry goes when its hello delivers it, or after 24 h.
  const PENDING_FILE = path.join(STATE, "pending-opens.json"), pendingTs = new Map();
  class PendingMap extends Map {
    set(k, v) { super.set(k, v); if (!pendingTs.has(k)) pendingTs.set(k, Date.now()); savePending(); return this; }
    delete(k) { const r = super.delete(k); if (r) { if (!welcomes.has(k) && !preIdentity.has(k)) pendingTs.delete(k); savePending(); } return r; }
    load(k, v) { super.set(k, v); }
  }
  const welcomes = new PendingMap(); // agent id -> its first prompt
  const preIdentity = new PendingMap(); // agent id -> { name, icon } it starts with
  function savePending() {
    const out = {};
    for (const [id, t] of welcomes) (out[id] ||= { ts: pendingTs.get(id) || Date.now() }).welcome = t;
    for (const [id, x] of preIdentity) Object.assign(out[id] ||= { ts: pendingTs.get(id) || Date.now() }, { name: x.name || "", icon: x.icon || "" });
    try { fs.writeFileSync(PENDING_FILE + ".tmp", JSON.stringify(out)); fs.renameSync(PENDING_FILE + ".tmp", PENDING_FILE); } catch (e) { log("pending opens write failed:", e.message); }
  }
  try {
    const saved = JSON.parse(fs.readFileSync(PENDING_FILE, "utf8")) || {};
    for (const [id, e] of Object.entries(saved)) {
      if (!e || Date.now() - (e.ts || 0) > 24 * 3600e3) continue;
      pendingTs.set(id, e.ts);
      if (e.welcome) welcomes.load(id, e.welcome);
      if (e.name || e.icon) preIdentity.load(id, { name: e.name || "", icon: e.icon || "" });
    }
    if (welcomes.size || preIdentity.size) log(`pending opens: ${[...new Set([...welcomes.keys(), ...preIdentity.keys()])].join(", ")} (waiting for their hello)`);
  } catch { /* none */ }
  setInterval(() => { for (const [id, ts] of [...pendingTs]) if (Date.now() - ts > 24 * 3600e3) { welcomes.delete(id); preIdentity.delete(id); pendingTs.delete(id); } }, 3600e3).unref?.();
  // open_agent's name / icon: "🏷️ Namesmith" or name + icon. A name must be free (live agents, projects).
  const openIdentity = (p) => {
    let name = String(p.name || "").replace(/\{#?[0-9a-fA-F]{0,6}\}/g, "").replace(/\s+/g, " ").trim(), icon = String(p.icon || "").trim();
    const m = name.match(/^(\S+)\s+(.+)$/);
    if (m && !/[\p{L}\p{N}]/u.test(m[1])) { if (!icon) icon = m[1]; name = m[2].trim(); }
    if (name.length > 60) throw new Error("name: at most 60 characters");
    if (/[\p{L}\p{N}]/u.test(icon) || [...icon].length > 6) throw new Error("icon: one emoji, e.g. 🏷️");
    if (name) {
      if (/^pi·/i.test(name)) throw new Error(`name: "${name}" looks like an unnamed agent's; give a purpose-specific name`);
      if (boards.find(name.toLowerCase())) throw new Error(`name: "${name}" is a project on the board (@${name.toLowerCase()}); choose a different name`);
      const clash = [...agents.values()].find((x) => x.name && x.name.toLowerCase() === name.toLowerCase()) || [...preIdentity].find(([id, x]) => x.name && x.name.toLowerCase() === name.toLowerCase() && Date.now() - (pendingTs.get(id) || 0) < 10 * 60e3); // a pending open reserves its name 10 min
      if (clash) throw new Error(`name: "${name}" is taken by another agent; choose a different name`);
    }
    return { name, icon: icon.slice(0, 16) };
  };
  const boardRoom = (p, actor) => {
    if (p.room) return safeRoom(p.room);
    if (actor.a && p.project) { const f = boards.find(p.project); if (f) return f.board.room; }
    return safeRoom(actor.a?.room || roomForWorkspace(activeWs) || "A");
  };
  const nameOf = (id) => { if (/^thoughts:/.test(id || "")) return thoughtsName(id.slice(9)); const a = agents.get(id); if (a) return displayName(a); const r = registry[id]; return r ? (r.name || `pi·${id.slice(-4)}`) : id; };
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
    for (const it of b.unfiled || []) if (it.by?.id) names[it.by.id] = nameOf(it.by.id); // N68
    return { room, projects: b.projects.map((p) => ({ ...p, short: projectShort(p, room) })), unfiled: b.unfiled || [], names, live: Object.fromEntries(Object.keys(names).map((id) => [id, agents.has(id) ? agents.get(id).status : /^thoughts:/.test(id) ? "idle" : "closed"])) };
  };
  // A project's "short": its `where` line summarised to agent-topic length (Angus: the agents
  // panel's projects section). Made by the topic model when `where` changes, cached by the where
  // text (state/project-shorts.json); "" until it is ready, then a "board" event re-sends the board.
  // A project created without an icon gets one (Angus, 2026-09-29): the keyword guess at once, then
  // the topic model's pick (lib/project-icon.mjs), unless someone set an icon in between.
  const iconBy = { id: "", name: "hyprpi", human: false };
  function autoIcon(pid, room, name, title) {
    const g = guessIcon(name, title);
    if (g) { try { boards.update(pid, room, { icon: g }, iconBy); } catch (e) { log("icon guess:", e.message); } }
    if (cfg.topics === false) return;
    askIcon(name, title, { pi: cfg.pi || "pi", model: cfg.topicModel || cfg.searchModel || "claude-haiku-4-5" }).then((ic) => {
      const f = ic && boards.find(pid, room);
      if (!f || (f.project.icon || "") !== (g || "") || ic === g) return; // set by someone meanwhile, or the same
      try { boards.update(pid, room, { icon: ic }, iconBy); } catch (e) { log("icon pick:", e.message); }
    }).catch(() => {});
  }
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

  // --------------------------------------------------------------- thoughts ---
  // Thoughts-<room>: the world agent Angus talks to in the search panel's Thoughts mode
  // (lib/thoughts.mjs runs it; pi-extension/thoughts.ts are its tools, which call the
  // thoughts.* methods below). Its requests to agents come back through talk.reply.
  // J117: how often each agent's session has compacted, counted from its session file (pi appends one
  // {"type":"compaction",…} entry per compaction: /compact, automatic or overflow). The file is the
  // record, so nothing is kept here: the count survives daemon restarts, /restart (same session) keeps
  // it, a fresh session (/new, a new agent) starts at 0. An agent crossing the refresh threshold
  // (config refreshAfter: { compactions: 6, oldCompactions: 3, days: 3 }) gets its world's Thoughts one
  // quiet note, once per session (STATE/refresh-flags.json): a thread line and its next "since you last
  // spoke"; no toast, no sound, never a restart.
  const compactStats = new Map(); // session file -> { size, mtime, count, start, busy }
  const refreshFile = path.join(STATE, "refresh-flags.json");
  let refreshFlags = {};
  try { refreshFlags = JSON.parse(fs.readFileSync(refreshFile, "utf8")) || {}; } catch { refreshFlags = {}; }
  const refreshNotes = {}; // room -> [{ ts, text }]
  const compactInfo = (a) => (a?.session && compactStats.get(a.session)) || null;
  const ageText = (ms) => ms >= 864e5 ? `${Math.floor(ms / 864e5)} d` : ms >= 36e5 ? `${Math.floor(ms / 36e5)} h` : `${Math.max(1, Math.floor(ms / 6e4))} min`;
  function refreshDue(c) {
    const r = loadConfig().refreshAfter || {};
    const n = r.compactions ?? 6, oldN = r.oldCompactions ?? 3, days = r.days ?? 3;
    return !!c && c.count > 0 && (c.count >= n || (!!c.start && Date.now() - c.start >= days * 864e5 && c.count >= oldN));
  }
  // ------------------------------------------------------------ J125 upkeep ---
  // The editable strategy (~/.config/hyprpi/upkeep.jsonc, lib/upkeep.mjs) applied without asking Angus, each
  // world's Thoughts in charge: a note in its thread for every action, and its upkeep tool to pause an agent.
  // Agents prune their own context (pi-extension/upkeep.ts). Here: the overdue refresh, for agents (J117's
  // "due for a refresh", idle, not paused, cooldown) and for Thoughts themselves (session MB / compactions).
  const UPKEEP_STATE = path.join(STATE, "upkeep.json");
  const thoughtsCompacts = new Map(); // a Thoughts session file -> { size, mtime, count }
  let upk = { agents: {}, thoughts: {}, paused: [] };
  try { upk = { agents: {}, thoughts: {}, paused: [], ...JSON.parse(fs.readFileSync(UPKEEP_STATE, "utf8")) }; } catch { /* fresh */ }
  const saveUpk = () => { try { fs.writeFileSync(UPKEEP_STATE + ".tmp", JSON.stringify(upk, null, 1)); fs.renameSync(UPKEEP_STATE + ".tmp", UPKEEP_STATE); } catch (e) { log("upkeep state:", e.message); } };
  const upkNote = (room, text) => { try { thoughts.note(room, `🧹 upkeep: ${text}`); } catch { /* no thread */ } log(`upkeep ${room}: ${text}`); };
  const upkPaused = (a, S) => upk.paused.includes(a.id) || (S.paused || []).some((n) => String(n).toLowerCase() === String(a.name || displayName(a)).toLowerCase());
  const runningJobs = (a) => briefs.all().filter((b) => b.agent === a.id && b.state === "running");
  // For J126 (Blink's restart queue): an upkeep refresh in progress counts as "not idle".
  const upkeepBusy = () => Object.values(upk.agents).some((x) => x.phase === "asked" || x.phase === "refreshing") || Object.values(upk.thoughts).some((x) => x.phase === "asked" || x.pending);
  void upkeepBusy;
  function upkeepRefreshed(b, r) {
    const S = loadUpkeep(), st = (upk.agents[b.id] ||= { history: [] });
    st.history = [...(st.history || []).filter((t) => Date.now() - t < 7 * 864e5), Date.now()]; st.last = Date.now(); st.phase = ""; st.file = ""; saveUpk();
    const link = r.handoffFile ? "file://" + r.handoffFile.split("/").map(encodeURIComponent).join("/") : "";
    const what = `${displayName(b)} refreshed on a fresh session (the old one had ${r.oldCompactions ?? "?"} compactions); it starts from its handoff ${link}`;
    if (S.refresh.roomLine) thoughtsPost(b.room, `🔄 ${what}`);
    upkNote(b.room, what);
  }
  function upkeepAsk(a, S, why) {
    const dir = expandHome(S.refresh.handoffDir); fs.mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
    const file = path.join(dir, `${String(displayName(a)).replace(/[^\p{L}\p{N}._-]+/gu, "_")}-${stamp}.md`);
    const jobs = runningJobs(a).map((b) => `${b.id} v${b.version}`).join(", ");
    const st = (upk.agents[a.id] ||= { history: [] }); Object.assign(st, { phase: "asked", file, askedAt: Date.now() }); saveUpk();
    sendAgent(a, "prompt", { via: "upkeep", text: `[hyprpi upkeep, for ${thoughtsName(a.room)}] Your session is due for a refresh (${why}). Write a handoff note for your next self to ${file}: what you're working on${jobs ? ` (your jobs: ${jobs}; name them)` : ""}, where it stands, decisions made, open questions, next steps, key files and commands. Then call the upkeep_ready tool with that path and end your turn. You'll be reopened on a fresh session that starts from your note, with the same name, workspace, projects, jobs and pending replies. Don't start other work.` });
    upkNote(a.room, `asked ${displayName(a)} for a handoff (${why}); it's refreshed once the note is written`);
  }
  function thoughtsSessionInfo(room) {
    const dir = path.join(STATE, "thoughts", room); let bytes = 0, file = "";
    for (const f of safeReaddir(dir)) if (f.endsWith(".jsonl")) { try { const st = fs.statSync(path.join(dir, f)); bytes += st.size; file = path.join(dir, f); } catch { /* gone */ } }
    // Its compactions, counted like an agent's (J117) but on its own (no agent refresh flags for a Thoughts).
    let count = 0;
    if (file) {
      let st; try { st = fs.statSync(file); } catch { st = null; }
      const c = thoughtsCompacts.get(file);
      if (st && c && c.size === st.size && c.mtime === st.mtimeMs) count = c.count;
      else if (st) { try { count = parseInt(String(execFileSync("grep", ["-c", '^{"type":"compaction"', file], { timeout: 30000 })).trim(), 10) || 0; } catch { count = 0; } thoughtsCompacts.set(file, { size: st.size, mtime: st.mtimeMs, count }); }
    }
    return { bytes, count, file };
  }
  function upkeepPass() {
    let S; try { S = loadUpkeep(); } catch (e) { log("upkeep:", e.message); return; }
    if (S.error) log(S.error);
    const now = Date.now(), R = S.refresh;
    // A refresh whose new window never came up (restart gave up): don't stay "refreshing" forever.
    for (const [id, st] of Object.entries(upk.agents)) if (st.phase === "refreshing" && !restarts.has(id) && now - (st.askedAt || 0) > R.handoffWaitMinutes * 60e3) { st.phase = ""; st.last = now; saveUpk(); log(`upkeep: ${id} refresh didn't complete; cleared`); }
    for (const a of agents.values()) {
      const st = upk.agents[a.id];
      if (st?.phase === "asked" && now - st.askedAt > R.handoffWaitMinutes * 60e3) { st.phase = ""; st.last = now; saveUpk(); upkNote(a.room, `${displayName(a)} wrote no handoff in ${R.handoffWaitMinutes} min; left as it is (cooling down)`); continue; }
      if (!R.enabled || !a.conn || a.parked || !a.room || st?.phase === "asked" || restarts.has(a.id)) continue;
      if (!["idle", "done"].includes(a.status) || now - (a.lastActive || 0) < R.idleMinutes * 60e3) continue; // never a working agent
      const c = compactInfo(a);
      if (!refreshDue(c) || upkPaused(a, S)) continue;
      const hist = (st?.history || []).filter((t) => now - t < 864e5);
      if (st?.last && now - st.last < Math.max(R.cooldownHours * 36e5, 30 * 60e3)) continue; // never a session younger than 30 min
      if (R.maxPerDay > 0 && hist.length >= R.maxPerDay) continue; // 0 = no cap (Angus: a 3-hour cooldown instead)
      upkeepAsk(a, S, `⟳ ${c.count} compactions${c.start ? `, session ${ageText(now - c.start)}` : ""}`);
    }
    // Thoughts themselves (J116 fresh, J124 keeps the last turns visible).
    const T = S.thoughts, cfgN = (loadConfig().refreshAfter || {}).compactions ?? 6;
    for (const r of knownRooms().map((x) => x.id)) {
      const ts = (upk.thoughts[r] ||= {});
      if (ts.pending && !thoughts.busy(r)) {
        try { const res = thoughts.fresh(r, { handoff: ts.pending }); upkNote(r, `Thoughts-${r} refreshed on a fresh session from its handoff (archived in ${res.archived.replace(process.env.HOME || "\u0000", "~")})`); ts.pending = ""; ts.last = now; ts.phase = ""; saveUpk(); }
        catch (e) { if (now - (ts.handoffAt || 0) > R.handoffWaitMinutes * 60e3) { ts.pending = ""; ts.phase = ""; ts.last = now; saveUpk(); log(`upkeep: Thoughts-${r} refresh gave up: ${e.message}`); } }
        continue;
      }
      if (!T.enabled || ts.phase === "asked" && now - (ts.askedAt || 0) < R.handoffWaitMinutes * 60e3) continue;
      if (ts.phase === "asked") { ts.phase = ""; ts.last = now; saveUpk(); continue; } // no handoff came: cool down
      if (ts.last && now - ts.last < Math.max(T.cooldownHours * 36e5, 30 * 60e3)) continue; // never a session younger than 30 min
      if (!thoughts.running(r) || thoughts.busy(r)) continue;
      const th = thoughts.get(r, 1).entries.at(-1);
      if (th && now - (th.ts || 0) < R.idleMinutes * 60e3) continue;
      const info = thoughtsSessionInfo(r);
      const why = info.bytes >= T.sessionMB * 1048576 ? `session ${info.bytes >= 1048576 ? Math.round(info.bytes / 1048576) + " MB" : Math.round(info.bytes / 1024) + " KB"}` : T.useCompactions && info.count >= cfgN ? `⟳ ${info.count} compactions` : "";
      if (!why) continue;
      Object.assign(ts, { phase: "asked", askedAt: now }); saveUpk();
      thoughts.system(r, `[hyprpi upkeep] Your session is due for a refresh (${why}). Write a handoff for your next self (open jobs and who has them, what's waiting on Angus, decisions and context you'd need) and pass it to your write_handoff tool, then end your turn. You'll restart on a fresh session that reads it; the last turns of the thread stay visible to Angus.`, `🧹 upkeep: asked Thoughts-${r} for a handoff (${why})`);
    }
  }
  setTimeout(() => { try { upkeepPass(); } catch (e) { log("upkeep:", e.message); } }, 90e3).unref?.();
  const upkeepTimer = setInterval(() => { try { upkeepPass(); } catch (e) { log("upkeep:", e.message); } }, Number(process.env.HYPRPI_UPKEEP_MS) || 60e3);
  upkeepTimer.unref?.();
  const compactText = (a) => { const c = compactInfo(a); return c && c.count ? `⟳ compactions ${c.count}${c.start ? `, session ${ageText(Date.now() - c.start)}` : ""}` : ""; };
  function countCompactions(a) {
    const file = a?.session;
    if (!file) return;
    let st; try { st = fs.statSync(file); } catch { return; }
    let c = compactStats.get(file);
    if (!c) compactStats.set(file, c = { size: -1, mtime: 0, count: 0, start: 0, busy: false });
    if (c.busy) return;
    if (c.size === st.size && c.mtime === st.mtimeMs) { checkRefresh(a); return; }
    c.busy = true;
    // Anchored on the entry's own line start, so a tool output mentioning "type":"compaction" (escaped
    // inside a JSON string) never counts. grep -c prints 0 (exit 1) when there is none.
    execFile("grep", ["-c", '^{"type":"compaction"', file], { timeout: 30000 }, (_err, out) => {
      c.busy = false;
      const n = parseInt(String(out || "").trim(), 10);
      if (!Number.isFinite(n)) return;
      const changed = n !== c.count || c.size < 0;
      c.count = n; c.size = st.size; c.mtime = st.mtimeMs;
      if (!c.start) {
        try {
          const fd = fs.openSync(file, "r"), b = Buffer.alloc(600);
          fs.readSync(fd, b, 0, 600, 0); fs.closeSync(fd);
          c.start = Date.parse(JSON.parse(b.toString("utf8").split("\n")[0]).timestamp) || 0; // the session header
        } catch { /* no header yet */ }
      }
      if (changed) pushAgents();
      checkRefresh(a);
    });
  }
  function checkRefresh(a) {
    const c = compactInfo(a);
    if (!c || !a.room || !refreshDue(c) || refreshFlags[a.session]) return;
    const text = `${displayName(a)} has compacted ${c.count} times (session ${c.start ? ageText(Date.now() - c.start) : "?"}): consider a /handoff + fresh session`;
    refreshFlags[a.session] = { at: Date.now(), count: c.count, name: displayName(a), room: a.room };
    try { fs.writeFileSync(refreshFile + ".tmp", JSON.stringify(refreshFlags, null, 1)); fs.renameSync(refreshFile + ".tmp", refreshFile); } catch { /* best effort */ }
    (refreshNotes[a.room] ||= []).push({ ts: Date.now(), text });
    refreshNotes[a.room] = refreshNotes[a.room].slice(-20);
    try { thoughts.note(a.room, `⟳ ${text}`); } catch { /* no Thoughts */ }
    log("refresh due:", text);
  }
  const compactTimer = setInterval(() => { for (const a of agents.values()) if (a.conn) countCompactions(a); }, 5 * 60e3);
  setTimeout(() => { for (const a of agents.values()) countCompactions(a); }, 15e3);

  const asks = {}; // room -> [{ ts, q, a }]: Ask-mode questions, for its "since you last spoke"
  const clipT = (t, n) => { const x = String(t || "").replace(/\s+/g, " ").trim(); return x.length > n ? x.slice(0, n - 1) + "…" : x; };
  function thoughtsDigest(room, since) {
    const out = [];
    const msgs = roomLog(room).msgs.filter((m) => m.ts > since && m.author?.kind !== "system").slice(since ? -25 : -10);
    if (msgs.length) out.push("Room posts:", ...msgs.map((m) => `- ${m.author?.kind === "human" ? "Angus" : m.author?.name || "?"}: ${clipT(m.text, 280)}`));
    const ch = []; for (const b of boards.all()) if (b.room === room) ch.push(...boards.changes(room, 40).filter((c) => c.ts > since));
    if (ch.length) out.push("Board changes:", ...ch.slice(0, since ? 25 : 10).reverse().map((c) => `- ${c.by || "?"} ${c.op}${c.h ? " " + c.h : ""}: ${clipT(c.text, 200)}`));
    const q = (asks[room] || []).filter((x) => x.ts > since);
    if (q.length) out.push("Angus asked (Ask mode):", ...q.map((x) => `- ${clipT(x.q, 200)} → ${clipT(x.a, 300)}`));
    const rn = (refreshNotes[room] || []).filter((x) => x.ts > since);
    if (rn.length) out.push("Due for a refresh (J117):", ...rn.map((x) => `- ${x.text}`));
    const live = [...agents.values()].filter((a) => a.room === room && a.conn);
    if (live.length) out.push("Agents now:", ...live.map((a) => `- ${displayName(a)}: ${a.status}${a.topic ? " · " + a.topic : ""}${compactText(a) ? " · " + compactText(a) + (refreshDue(compactInfo(a)) ? " (due for a refresh)" : "") : ""}`));
    return out.join("\n");
  }
  let looked = null; // room -> when Angus last looked at its Thoughts window (STATE/thoughts/looked.json)
  const thoughtsLooked = () => { if (!looked) { try { looked = JSON.parse(fs.readFileSync(path.join(STATE, "thoughts", "looked.json"), "utf8")) || {}; } catch { looked = {}; } } return looked; };
  const thoughts = createThoughts({ stateDir: STATE, cfg: () => loadConfig(), log, env,
    broadcast: (ev, data) => broadcastUi(ev, data), digest: thoughtsDigest, post: (room, text) => thoughtsPost(room, text) });
  // Evidence (lines of history) for the Thoughts window's /keyword and /ask.
  const evRunning = new Map(), evCancelled = new Set(); // thoughts.evidence tokens -> room; cancelled ones
  const evidenceRef = (source, eid, kind) => ({ source: String(source || ""), eid: String(eid ?? ""), kind: kind || "", session: agents.get(source)?.session || registry[source]?.session || "" });
  async function buildEvidence(room, p) {
    const kind = p.kind === "ask" || p.kind === "ai" ? "ask" : "keyword", q = String(p.query ?? "").trim();
    if (!q) throw new Error(kind === "ask" ? "no question" : "no words to search for");
    const n = Math.max(1, Math.min(200, Number(p.n) || 10));
    const ids = Array.isArray(p.agents) && p.agents.length ? p.agents.map(String) : null;
    const filter = ids ? ids.map(nameOf) : null;
    if (kind === "keyword") {
      const r = await methods.search({ room, query: q, mode: "keyword", agents: ids || undefined });
      // The same turn often shows up several times (a room message every agent received): one line,
      // the newest copy, "also" naming the others.
      const all = (r.results || []).slice().sort((a, b) => (b.ts || 0) - (a.ts || 0)), byText = new Map(), hits = [];
      for (const h of all) {
        const key = String((h.pre || "") + (h.match || "") + (h.post || "")).replace(/\s+/g, " ").trim().toLowerCase();
        const seen = byText.get(key);
        if (seen) { if (h.name !== seen.name && !seen.also.includes(h.name)) seen.also.push(h.name); continue; }
        const x = { ...h, also: [] }; byText.set(key, x); hits.push(x);
      }
      const pick = hits.slice(0, n).reverse(); // the newest n, oldest first (newest at the bottom)
      return { kind, query: q, n, total: hits.length, older: hits.length - pick.length, filter,
        items: pick.map((h) => ({ who: h.name, icon: h.icon || "", color: h.color || "", role: h.role, ts: h.ts, pre: h.pre, match: h.match, post: h.post, count: h.count || 1, also: h.also, ...(h.link ? { link: h.link } : {}),
          ref: evidenceRef(h.source, String(h.id || "").slice(String(h.source || "").length + 1), h.kind) })) };
    }
    const r = await methods.ask({ room, question: q, agents: ids || undefined, maxCite: Math.min(10, n) });
    const cites = (r.citations || []).slice().sort((a, b) => (a.ts || 0) - (b.ts || 0));
    return { kind, query: q, n, total: cites.length, older: 0, filter, answer: r.answer,
      items: cites.map((c) => ({ who: c.who, role: c.kind, ts: c.ts, text: c.text, ...(c.link ? { link: c.link } : {}), ref: c.ref ? evidenceRef(c.ref.source, c.ref.eid, c.ref.kind) : null })) };
  }
  // Agents' replies to Thoughts: request id -> room (kept 12 h; work can take a while).
  // work: { task, project, item } when this hands out work (give_work / open_agent), so cancel_work
  // knows what it is stopping and which card item to mark (@hyprpi N57).
  function thoughtsRequest(room, targets, mode, text, { urgent = false, work = null } = {}) {
    const request_id = randomUUID(), from = { id: "thoughts:" + room, name: thoughtsName(room) };
    const req = { from: from.id, thoughts: room, mode, recipients: new Set(), replies: new Map(), ...(work || {}) };
    for (const t of targets) {
      if (typeof t === "string") { req.recipients.add(t); continue; } // an agent that is still opening
      if (talkOut(req, t, { request_id, mode, text, from, expires_in: 43200, ...(urgent ? { urgent: true } : {}) })) req.recipients.add(t.id); // urgent: the agent sees it at its next tool boundary
    }
    keepRequest(request_id, req);
    if (work) writeRequests(); // a brief's request is on disk at once, with its pending welcome (J15, pi·wpzt: a kill -9 inside the 300 ms debounce lost it)
    return request_id;
  }
  // Delivery receipts (Angus, J64: "nothing lost, or the sender told"). Every talk / demand to an agent
  // whose extension acks (hello acks: true) stays in req.outbox until the agent's window says it landed
  // in its session (agent.delivered). Until then it is sent again when the agent (re)connects and when
  // it finishes a run, and after talkUndeliveredMs (default 10 min) the sender is told once.
  function talkOut(req, a, data) {
    const ok = sendAgent(a, "talk", data);
    if (a.acks) { (req.outbox ||= {})[a.id] = { data, sentAt: Date.now(), firstAt: Date.now(), conn: a.conn?.id || 0, told: false }; saveRequests(); }
    return ok;
  }
  function resendFor(a, why) {
    if (!a?.acks || !a.conn) return 0;
    let n = 0;
    for (const [, req] of requests) {
      const o = req.outbox?.[a.id];
      if (!o || req.replies?.has?.(a.id)) continue;
      if (sendAgent(a, "talk", o.data)) { o.sentAt = Date.now(); n++; }
    }
    if (n) { log(`resent ${n} undelivered request${n === 1 ? "" : "s"} to ${displayName(a)} (${why})`); saveRequests(); }
    return n;
  }
  function undeliveredSweep() {
    const now = Date.now(), wait = Number(cfg.talkUndeliveredMs) || 600000;
    for (const [rid, req] of requests) for (const [aid, o] of Object.entries(req.outbox || {})) {
      if (o.told || now - o.firstAt < wait || req.replies?.has?.(aid)) continue;
      o.told = true; saveRequests();
      const a = agents.get(aid), who = a ? displayName(a) : nameOf(aid), st = a ? (a.conn ? a.status : "not connected") : "closed";
      const what = req.brief ? `${req.brief}${req.version ? " v" + req.version : ""}` : `request ${rid.slice(0, 8)}`;
      const msg = `${what} not delivered to ${who} yet (${st} since ${new Date(o.firstAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}); it is re-sent when ${who} finishes or reconnects.`;
      if (req.thoughts) { try { thoughts.note(req.thoughts, `⚠ ${msg}`); } catch { /* none */ } }
      else { const s = agents.get(req.from); if (s) sendAgent(s, "talk", { request_id: randomUUID(), mode: "talk", text: `[hyprpi delivery note] ${msg}`, from: { id: "hyprpi", name: "hyprpi" }, expires_in: 600 }); }
      log("undelivered:", msg);
    }
  }
  setInterval(undeliveredSweep, 30000).unref?.();
  const modelWaits = new Map(); // set_model token -> resolve
  // Briefs (lib/briefs.mjs): give_work / open_agent hand out versioned briefs; revise_work issues a new
  // version (stopping the old run through cancel_work's mechanism); a report must answer every done-when
  // line before the job is "done"; verify_work marks it "verified".
  const briefs = createBriefs(path.join(STATE, "briefs.json"));
  // The card item is the brief's home; if someone dropped it, put it back (pi·wpzt's N63 note 3).
  // Loose jobs (J10, Blink's design): a brief given with no project goes onto its world's catch-all
  // card (decisions.mjs isCatchAll: workshop, inbox…, misc, general), else a card created once on
  // demand, "inbox-<world>" titled Loose jobs, whose writer is that world's Thoughts agent (not a
  // member). The brief then lives there like any other (b.project = that card), and moves into a real
  // project with /move J<n> @p (projects panel), move_job (Thoughts) or when its agent creates one.
  function looseCard(room) {
    room = room || "A";
    const b = boards.load(room), have = b.projects.find(isCatchAll);
    if (have) return have;
    const tid = "thoughts:" + room, by = { id: "", name: thoughtsName(room) }, base = `inbox-${slugify(room)}`;
    const old = boards.find(base);
    if (old && old.board.room === room) { boards.update(old.project.id, room, { status: "active" }, by); return old.project; }
    const pr = boards.create(room, { name: old ? `${base}-jobs` : base, title: "Loose jobs: briefs given without a project", icon: "📥", members: [], by, status: "active" }, agentNameTaken);
    pr.writer = tid; // saved by the update below; a Thoughts writer is not a member (Blink)
    boards.update(pr.id, room, { where: `Jobs ${thoughtsName(room)} gave without a project. One that leads to decisions belongs in a project: /move J<n> @project (or move_job).` }, by);
    return pr;
  }
  // Move a brief to another card, keeping its id, versions and history: a line on the new card, the
  // old line marked done "moved to @x N12" (not dropped), a history note; the agent joins the project.
  function moveBrief(b, ref, by) {
    const t = boards.must(ref, null).project;
    if (t.status === "archived") throw new Error(`@${t.name} is archived`);
    if (b.project === t.id) throw new Error(`${b.id} is already on @${t.name}${b.item ? " " + b.item : ""}`);
    const of = b.project && boards.find(b.project), oldItem = b.item;
    const sec = b.state === "done" || b.state === "verified" ? "done" : "next";
    const r = boards.addItem(t.id, boards.find(t.id).board.room, { section: sec, text: briefCard(b), ...(sec === "done" ? { verified: b.verified_by ? `verified by ${b.verified_by}` : "report answered every done-when line" } : {}) }, by);
    const h = r?.item?.h || "";
    if (of && oldItem && (of.project.items || []).some((x) => x.h === oldItem)) {
      try { boards.doneItem(of.project.id, of.board.room, oldItem, { verified: `moved to @${t.name} ${h}` }, by); } catch (e) { log("brief move: old item", e.message); }
    }
    const from = of ? `@${of.project.name}${oldItem ? " " + oldItem : ""}` : "no card";
    b.project = t.id; b.projectName = t.name; b.item = h;
    b.history.push({ version: b.version, state: b.state, ts: Date.now(), note: `moved to @${t.name} ${h} (from ${from})`, by: by?.name || "" });
    briefs.save();
    const a = agents.get(b.agent);
    if (a && !t.members.includes(a.id)) { try { boards.join(t.id, boards.find(t.id).board.room, a.id, { ...by, who: displayName(a) }); } catch (e) { log("brief move: join", e.message); } }
    if (a?.conn && b.state === "running") promptMember(a, `[hyprpi board · ${by?.name || "hyprpi"} moved your job ${b.id} to @${t.name} ${h}]\nIt is now part of @${t.name}: read its card with board_read and keep it current (board_update).`);
    log(`brief ${b.id}: ${from} → @${t.name} ${h} (${by?.name || "?"})`);
    return { job: b.id, project: t.name, item: h, from };
  }
  // A brief on a catch-all card (or none): "loose".
  const isLoose = (b) => { if (!b.project) return true; const f = boards.find(b.project); return !f || isCatchAll(f.project); };
  function briefToCard(b) {
    if (!b.project) {
      try { const pr = looseCard(b.room); b.project = pr.id; b.projectName = pr.name; b.item = ""; briefs.save(); }
      catch (e) { log("brief loose card:", e.message); return; }
    }
    const f = boards.find(b.project); if (!f) return;
    const live = b.item && (f.project.items || []).some((x) => x.h === b.item);
    try {
      if (live) boards.editItem(b.project, f.board.room, b.item, { text: briefCard(b) }, { id: "", name: b.from });
      else { const sec = b.state === "done" || b.state === "verified" ? "done" : "next"; const r = boards.addItem(b.project, f.board.room, { section: sec, text: briefCard(b), ...(sec === "done" ? { verified: b.verified_by ? `verified by ${b.verified_by}` : "report answered every done-when line" } : {}) }, { id: "", name: b.from }); b.item = r?.item?.h || ""; briefs.save(); }
    } catch (e) { log("brief card:", e.message); }
  }
  // Backfill (J10): briefs from before Loose jobs (no card at all) go onto their world's Loose jobs card.
  setTimeout(() => { for (const b of briefs.all()) if (!b.project) { briefToCard(b); log(`brief ${b.id}: backfilled onto @${b.projectName} ${b.item}`); } }, 3000).unref?.();
  const briefFields = (p) => { const f = fieldsFrom(p); if (!f.goal) throw new Error("a brief needs a goal (one sentence) and Angus's words (angus)"); if (!f.angus) throw new Error("a brief needs Angus's words, verbatim (angus)"); return f; };
  // Thoughts-to-Thoughts (N58). Guard rails: not to its own world; depth 1 (a Thoughts agent that is
  // answering another one can't ask any Thoughts agent until it has answered). No hourly cap (Angus, N62:
  // depth 1 already prevents loops, and a cap could block real cross-world work).
  const t2tAnswering = new Map(); // room -> { from: asking room, ts }, while it owes an answer
  function thoughtsToThoughts(from, to, question, images) {
    if (!question) throw new Error("no question");
    if (to === from) throw new Error(`${thoughtsName(to)} is you`);
    if (!WORLD_LETTERS.includes(to) && !boards.all().some((b) => b.room === to) && !roomLog(to).msgs.length) throw new Error(`no world ${to}`);
    const now = Date.now(), owe = t2tAnswering.get(from);
    if (owe && now - owe.ts < 1800e3) throw new Error(`answer ${thoughtsName(owe.from)} first (answer_agent): a Thoughts agent answering another can't ask one back`);
    const request_id = randomUUID(), text = withImages(question, images);
    keepRequest(request_id, { from: "thoughts:" + from, thoughts: to, t2t: { from, to }, mode: "demand", text, recipients: new Set(["thoughts:" + to]), replies: new Map() });
    t2tAnswering.set(to, { from, ts: now }); // (forgotten after 30 min if it never answers)
    thoughts.fromAgent(to, { from: thoughtsName(from), request_id, mode: "demand", text: `${text}\n\n(${thoughtsName(from)} is world ${from}'s Thoughts agent. Answer it with answer_agent; don't send it a question back.)` });
    thoughtsPost(from, `↪ to ${thoughtsName(to)} (question): ${clipT(question, 200)}`);
    thoughtsPost(to, `↩ from ${thoughtsName(from)} (question): ${clipT(question, 200)}`);
    return { agent: thoughtsName(to) };
  }
  const cancelWaits = new Map(); // cancel_work token -> resolve
  const liveAgent = (who) => { const { agent, error } = findAgent(String(who || "").replace(/^@/, "")); if (error) throw new Error(error); if (!agent.conn) throw new Error(`${displayName(agent)} isn't live`); return agent; };
  const isFree = (a) => a.status === "idle" || a.status === "done" || a.status === "background"; // ◐ background (J93): its helpers work, it takes messages
  // Images Thoughts passes on (Angus's pasted screenshots): paths the agent opens with its read tool.
  const withImages = (text, images) => { const l = (Array.isArray(images) ? images : []).filter((f) => typeof f === "string" && f.startsWith("/") && fs.existsSync(f)).slice(0, 8); return l.length ? `${text}\n\nImage${l.length > 1 ? "s" : ""} from Angus (open with your read tool): ${l.join(", ")}` : text; };
  // What Thoughts does shows in its world's room (Angus): one-line posts for hand-offs, replies and
  // agents' questions, and its topic in the stream. Plain chat with Angus is not posted.
  const thoughtsAuthor = (room) => ({ kind: "agent", id: "thoughts:" + room, name: thoughtsName(room), icon: "💭", color: cfg.thoughtsColor || "#c4b5fd", markup: "" });
  function thoughtsPost(room, text) { try { appendMessage(room, { author: thoughtsAuthor(room), text: clipT(text, 400), via: "thoughts" }); } catch (e) { log("thoughts post", e.message); } }
  const lastTopic = {};
  function thoughtsTopic(room, topic) {
    const t = clipT(topic, 60);
    if (!t || lastTopic[room] === t) return false;
    lastTopic[room] = t;
    recordActivity({ id: "thoughts:" + room, name: thoughtsName(room), icon: "💭", color: cfg.thoughtsColor || "#c4b5fd", room }, "topic", t, {}, room);
    return true;
  }
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

  // "did" lines (Angus 2026-09-30): one activity line (kind "turn") per finished turn, what the agent
  // did and how it ended, from the turn's tool calls and final message (lib/topics.mjs summarizeTurn,
  // the topic model). The room panel's stream shows these instead of raw tool lines. Config:
  // "turnLines": false turns them off.
  const turnBusy = new Map(); // agent id -> a turn waiting (at most one queued per agent)
  function refreshTurn(a) {
    if (cfg.turnLines === false || cfg.activity === false || !a.session) return;
    if (turnBusy.get(a.id)) return;
    if ([...turnBusy.values()].filter(Boolean).length >= 3) { setTimeout(() => refreshTurn(a), 5000); return; }
    const inp = turnInput(a.session);
    if (!inp || inp.key === a.turnKey) return;
    a.turnKey = inp.key;
    if (inp.trivial) return; // a one-line chat reply: nothing to report
    turnBusy.set(a.id, true);
    summarizeTurn(inp.src, { pi: cfg.pi || "pi", model: cfg.turnModel || cfg.topicModel || cfg.searchModel || "claude-haiku-4-5" })
      .then((line) => { if (line) { a.lastDid = { text: line, ts: Date.now() }; recordActivity(a, "turn", line); remember(a); pushAgents(); } })
      .finally(() => turnBusy.delete(a.id));
  }

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
      if (!prev && reg.pid && reg.pid === (Number(p.pid) || 0) && ["idle", "working", "blocked", "done", "background"].includes(reg.status)) {
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
      // open_agent gave it a name / icon (J5): it starts with them.
      const pre = preIdentity.get(id);
      if (pre) { preIdentity.delete(id); if (!prev) { if (pre.name && !a.name) a.name = pre.name; if (pre.icon && !a.icon) a.icon = pre.icon; } }
      if (p.name && !a.name) a.name = String(p.name).slice(0, 60);
      if (p.icon && !a.icon && !prev) a.icon = String(p.icon).slice(0, 16); // open_agent's icon via the spawn (J15)
      // A twin starts with its parent's icon and colour.
      const parent = a.twinOf && agents.get(a.twinOf);
      if (parent && !prev) { a.icon = a.icon || parent.icon; a.color = a.color || parent.color; }
      // The launch workspace is for the first placement only: the same process reconnecting after a
      // daemon restart keeps wherever its window is now (it was moving parked / moved agents back to
      // their launch workspace on every restart; found in the J8 live test, pi·05mn out of Reprieve).
      const reconnecting = !!(reg.pid && reg.pid === (Number(p.pid) || 0));
      if (Number.isInteger(p.want_workspace) && !prev && !reconnecting) a.wantWorkspace = p.want_workspace;
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
      a.bye = null; // (re)connected: open again (restore-all)
      a.acks = !!p.acks; // its extension sends delivery receipts (J64)
      if (a.acks) setTimeout(() => resendFor(a, "reconnected"), 2000);
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
      a.selfKey = null; // a reloaded extension (same id) needs its "self" again: its footer identity (pi·26m9, via Knock)
      pushAgents();
      refreshSoon();
      setTimeout(() => countCompactions(a), 2000); // J117
      return { agent_id: id, room: a.room, name: a.name, icon: a.icon, color: a.color, ...(restarts.has(id) ? { restarted: restarts.get(id).before } : {}) };
    },

    // Delivery receipt (J64): a hyprpi request landed in the agent's session.
    "agent.delivered": (p, conn) => {
      const a = agents.get(conn.agentId), id = String(p.id || "");
      const req = a && requests.get(id);
      if (req?.outbox?.[a.id]) { delete req.outbox[a.id]; saveRequests(); }
      return { ok: true };
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
      if (p.resync && p.status && ["idle", "working", "blocked", "done", "background"].includes(p.status)) {
        // The agent re-stating its state after a reconnect: no sound, no activity, keep "seen".
        if (!(a.status === "blocked" && p.status !== "working")) a.status = p.status;
      } else if (p.status && ["idle", "working", "blocked", "done", "background"].includes(p.status)) {
        const prev = a.status;
        // Blocked (e.g. set by `bonk`) outlasts the end of the turn: it stays
        // until the agent starts working again (i.e. you answered it).
        const status = prev === "blocked" && (p.status === "done" || p.status === "idle" || p.status === "background") ? "blocked" : p.status;
        // `ding "question"` (bonk --ding) sends the question: it becomes a Decide item (N68).
        if (p.status === "blocked" && typeof p.decision === "string" && p.decision.trim()) autoDecide(a, p.decision.slice(0, 2000));
        a.status = status; a.lastActive = Date.now();
        if (prev === "working" && p.status !== "working") setTimeout(() => resendFor(a, "finished a run"), 1500); // J64
        // A block from anything but a decision (a plain bonk) must survive clearDing().
        // (`ding "question"` sends p.decision: a decision block, cleared when it is answered; N68.)
        if (p.status === "blocked") a.otherBlock = !(typeof p.decision === "string" && p.decision.trim());
        else if (p.status === "working") a.otherBlock = false;
        // A finish (\u2713) or a block (\u00d7) is unseen until you click or type
        // in the agent's window, even if it was already focused.
        if ((status === "done" || status === "blocked") && prev !== status) a.ack = false;
        // Herdr-style sounds, played by the room app: "done" whenever a turn
        // finishes (even in the focused window), "request"
        // when an agent becomes blocked on you.
        // `quiet`: the caller makes its own sound (bonk's knock).
        const finished = (prev === "working" || prev === "background") && status === "done"; // J93: a ◐ turns ✓ when its last helper ends
        if (prev === "working" && (status === "done" || status === "background")) setTimeout(() => { refreshTopic(a); refreshTurn(a); countCompactions(a); }, 500); // session file flushed
        if (finished) recordActivity(a, "done", "finished");
        else if (prev !== "blocked" && status === "blocked") recordActivity(a, "blocked", "needs you");
        if (finished) { broadcastUi("sound", { sound: "done", agent_id: id, name: a.name, room: a.room }); chime(); }
        else if (prev !== "blocked" && status === "blocked" && !p.quiet) broadcastUi("sound", { sound: "request", agent_id: id, name: a.name, room: a.room });
      }
      // J93: the agent's running subagents (its ◐ background state's helpers): [{ id, type, description, startedAt }].
      if (Array.isArray(p.helpers)) a.helpers = p.helpers.slice(0, 20).map((h) => ({ id: String(h?.id || "").slice(0, 40), type: String(h?.type || "").slice(0, 40), description: String(h?.description || "").slice(0, 160), startedAt: Number(h?.startedAt) || 0 }));
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

    list: () => ({ thoughts: knownRooms().map((r) => ({ room: r.id, name: thoughtsName(r.id), running: thoughts.running(r.id) })), agents: agentList(), dormant: dormantList(), rooms: knownRooms(), active_room: roomForWorkspace(activeWs), active_workspace: activeWs }),

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

    // Summon agents (names / ids) or a project's live members to the current workspace (or p.workspace).
    // auto (the SUPER+S pop-up): first send this workspace's unpinned guests home, except those summoned again.
    "guest.summon": async (p) => {
      await refreshWindows();
      const ws = Number(p.workspace) || await hereWs(), room = roomForWorkspace(ws);
      const want = new Map();
      for (const who of Array.isArray(p.agents) ? p.agents : []) { const { agent, error } = findAgent(String(who).replace(/^@/, "")); if (error) throw new Error(error); want.set(agent.id, agent); }
      for (const pr of Array.isArray(p.projects) ? p.projects : []) {
        const f = boards.must(String(pr).replace(/^@/, ""), null).project;
        for (const id of f.members) { const a = agents.get(id); if (a?.conn && a.room === room && !a.parked) want.set(a.id, a); }
      }
      // hyprpi panels (TUIs) by window address (the SUPER+S pop-up; Angus): moved here like agents,
      // kept by the auto-clear; a later dismiss sends an unpinned one to the emptiest workspace.
      const size = cfg.worldSize || 10, panels = [];
      if (Array.isArray(p.panels) && p.panels.length) {
        const cl = await hypr.clients({ env }).catch(() => []);
        for (const addr of p.panels) {
          const c = cl.find((w) => w.address === addr && PANEL_TITLE.test(w.title || ""));
          if (!c) throw new Error(`no hyprpi panel window ${addr}`);
          if (!(c.workspace?.id > 0) || worldOf(c.workspace.id, size) !== worldOf(ws, size)) throw new Error(`${panelName(c.title)} is in another world (summon works within a world)`);
          panels.push(c);
        }
      }
      // App windows by address (J28): moved here as guests (home = where they were), kept by the auto-clear.
      const apps = [];
      if (Array.isArray(p.windows) && p.windows.length) {
        const cl = await hypr.clients({ env }).catch(() => []);
        for (const addr of p.windows) {
          const c = cl.find((w) => w.address === addr);
          if (!c || !isApp(c)) throw new Error(`no app window ${addr} (dialogs, parked and hyprpi windows can't be summoned this way)`);
          if (worldOf(c.workspace.id, size) !== worldOf(ws, size)) throw new Error(`${appName(c)} is in another world (summon works within a world)`);
          apps.push(c);
        }
      }
      if (!want.size && !panels.length && !apps.length) throw new Error("nobody to summon (no live agent in this world)");
      const out = { summoned: [], here: [], dismissed: [] };
      // Angus (J28 b): the auto-clear keeps only pinned windows and what's being summoned, not the focused one.
      if (p.auto) Object.assign(out, await clearWs(ws, { agents: new Set(want.keys()), addrs: new Set([...panels, ...apps].map((c) => c.address)) }));
      // Fullscreen on arrival (J31, Angus): with 2+ windows coming in, any fullscreen one arrives normal;
      // a lone fullscreen window stays fullscreen only if nothing else is left on the workspace.
      const cl0 = await hypr.clients({ env }).catch(() => []);
      const incoming = [...panels, ...apps, ...[...want.values()].filter((a) => a.address && a.workspace !== ws && !a.parked).map((a) => cl0.find((w) => w.address === a.address)).filter(Boolean)].filter((c) => c.workspace?.id !== ws);
      const lone = incoming.length === 1 ? incoming[0] : null;
      const keepFull = !!lone && !cl0.some((w) => w.workspace?.id === ws && !transientsOf(lone, cl0).includes(w));
      out.fullscreen = lone?.fullscreen ? (keepFull ? "kept" : "normal") : incoming.some((c) => c.fullscreen) ? "normal" : undefined;
      for (const c of apps) {
        if (c.workspace.id === ws) { out.here.push(appName(c)); continue; }
        const prev = guests[c.address];
        guests[c.address] = { app: true, label: appName(c), home: prev && !prev.native ? prev.home : c.workspace.id, ws, pinned: !!prev?.pinned, ts: Date.now() };
        await moveIn(c.address, ws, keepFull);
        out.summoned.push(appName(c));
      }
      for (const c of panels) {
        if (c.workspace.id === ws) { out.here.push(panelName(c.title)); continue; }
        await moveIn(c.address, ws, keepFull);
        out.summoned.push(panelName(c.title));
      }
      for (const a of want.values()) {
        if (!a.address) { out.here.push(`${displayName(a)} (no window)`); continue; }
        if (a.workspace === ws) { out.here.push(displayName(a)); continue; }
        if (a.parked) throw new Error(`${displayName(a)} is parked in Reprieve; bring it back first`);
        if (worldOf(a.workspace, cfg.worldSize || 10) !== worldOf(ws, cfg.worldSize || 10)) throw new Error(`${displayName(a)} is in another world (summon works within a world)`);
        const prev = guests[a.address];
        guests[a.address] = { agent: a.id, home: prev ? prev.home : a.workspace, ws, pinned: !!prev?.pinned, ts: Date.now() };
        await moveIn(a.address, ws, keepFull);
        out.summoned.push(displayName(a));
      }
      saveGuests();
      nativeBorders(ws);
      const first = [...want.values()].find((a) => a.address) || panels[0] || apps[0];
      if (first) await hypr.focusWindow(first.address, { env }).catch(() => {});
      setTimeout(refreshWindows, 150);
      return out;
    },
    // SUPER+SHIFT+ALT+S (Angus, J18): keep the focused window (or p.address) as if it had just been
    // summoned, keep the explicitly pinned ones, and clear the rest of its workspace like SUPER+S, plus
    // the natives never pinned or unpinned (Angus, D2 "yes"). Any focused window counts (a browser
    // too); other non-hyprpi windows are never moved.
    "guest.keep": async (p) => {
      await refreshWindows();
      const addr = p.address || (await hypr.activeWindow({ env }).catch(() => null))?.address;
      const c = addr && (await hypr.clients({ env }).catch(() => [])).find((w) => w.address === addr);
      const ws = c?.workspace?.id;
      if (!(ws > 0)) throw new Error("no focused window on a normal workspace");
      const a = agentAt(addr), g = guests[addr];
      const keepAgents = new Set([a?.id, g?.agent].filter(Boolean));
      const r = await clearWs(ws, { agents: keepAgents, addrs: new Set([addr]), untouched: true }); // never-touched natives go too (Angus, D2)
      nativeBorders(ws);
      setTimeout(refreshWindows, 150);
      return { kept: a ? displayName(a) : PANEL_TITLE.test(c.title || "") ? panelName(c.title) : c.title || c.class, ...r };
    },
    // Send a guest home: the focused window (or p.address); all: every unpinned guest on this workspace.
    // A hyprpi panel that isn't a guest is closed, like its toggle key. Pinned guests stay.
    "guest.dismiss": async (p) => {
      if (p.all) {
        await refreshWindows();
        const ws = Number(p.workspace) || await hereWs();
        // DISMISS all (Angus, J22): everything hyprpi on ws goes, never-touched natives included (J21),
        // except explicitly pinned windows and the focused window, if it is on ws (else only pinned stay).
        const fa = p.address || (await hypr.activeWindow({ env }).catch(() => null))?.address;
        const fc = fa && (await hypr.clients({ env }).catch(() => [])).find((w) => w.address === fa && w.workspace?.id === ws);
        const keepA = new Set(fc ? [agentAt(fc.address)?.id, guests[fc.address]?.agent].filter(Boolean) : []);
        const r = await clearWs(ws, { untouched: true, agents: keepA, addrs: new Set(fc ? [fc.address] : []) });
        nativeBorders(ws);
        setTimeout(refreshWindows, 150);
        return r;
      }
      const addr = p.address || (await hypr.activeWindow({ env }).catch(() => null))?.address;
      if (!addr) throw new Error("no window");
      const g = guests[addr];
      if (g?.pinned) return { pinned: true, agent: guestName(g) };
      if (g && !g.native) { await sendHome(addr); nativeBorders(g.ws); setTimeout(refreshWindows, 150); return { dismissed: [guestName(g)], home: g.home }; }
      const na = agentAt(addr);
      if (na && Number.isInteger(na.workspace)) { // a native, pinned or not: SUPER+D is explicit
        const ws0 = na.workspace;
        if (guests[addr]) { delete guests[addr]; saveGuests(); }
        guestTag(addr, false);
        const dest = await sendNativeAway(na, ws0); nativeBorders(ws0); setTimeout(refreshWindows, 150);
        return dest ? { dismissed: [displayName(na)], home: dest } : { notGuest: true };
      }
      const c = (await hypr.clients({ env }).catch(() => [])).find((w) => w.address === addr);
      if (c && PANEL_TITLE.test(c.title || "")) {
        if (panelPins[addr]) return { pinned: true, agent: panelName(c.title) };
        await hypr.closeWindow(addr, { env }).catch(() => {}); return { panel: c.title };
      }
      // An app window (J28): moved to its home / the nearest workspace with room, NEVER closed.
      if (c && isApp(c)) { const dest = await sendAppAway(c, c.workspace.id); setTimeout(refreshWindows, 150); return dest ? { dismissed: [appName(c)], home: dest } : { notGuest: true }; }
      return { notGuest: true };
    },
    // Pin / unpin the focused guest (p.pinned: set; otherwise toggle).
    "guest.pin": async (p) => {
      const addr = p.address || (await hypr.activeWindow({ env }).catch(() => null))?.address;
      const g = addr && guests[addr];
      const na = addr && agentAt(addr);
      if (!g && !na && addr) { // a hyprpi panel: toggle its pin (green border); SUPER+D then leaves it open
        const c = (await hypr.clients({ env }).catch(() => [])).find((w) => w.address === addr);
        if (c && PANEL_TITLE.test(c.title || "")) {
          const want = typeof p.pinned === "boolean" ? p.pinned : !panelPins[addr];
          if (want) panelPins[addr] = { title: c.title, ts: Date.now() }; else delete panelPins[addr];
          savePanelPins();
          await guestTag(addr, want);
          return { agent: panelName(c.title), pinned: want, panel: true };
        }
      }
      if (!na && (!g || g.native)) { // an app window (J28): pinned or not, like an agent; light-blue border, no toast
        const c = (await hypr.clients({ env }).catch(() => [])).find((w) => w.address === addr);
        if (c && isApp(c)) {
          const want = typeof p.pinned === "boolean" ? p.pinned : !g?.pinned;
          if (want) guests[addr] = { app: true, native: true, label: appName(c), home: null, ws: c.workspace.id, pinned: true, ts: Date.now() };
          else delete guests[addr];
          saveGuests(); await guestTag(addr, want);
          return { agent: appName(c), pinned: want, app: true };
        }
      }
      if (!g || g.native) { // a native: the key toggles what you see (Angus pressed it and saw nothing)
        if (!na || !Number.isInteger(na.workspace)) throw new Error("not a hyprpi agent window or panel");
        // Not pinned unless pinned here (J25): the first press pins, the next unpins (the entry goes).
        const want = typeof p.pinned === "boolean" ? p.pinned : !nativePinned(na);
        if (want) guests[addr] = { agent: na.id, home: null, ws: na.workspace, pinned: true, native: true, ts: Date.now() };
        else delete guests[addr];
        saveGuests(); nativeBorders(na.workspace);
        return { agent: displayName(na), pinned: want };
      }
      g.pinned = typeof p.pinned === "boolean" ? p.pinned : !g.pinned;
      saveGuests();
      await guestTag(addr, g.pinned);
      return { agent: guestName(g), pinned: g.pinned };
    },
    "guest.list": async () => { await refreshWindows(); return { guests: Object.entries(guests).map(([address, g]) => ({ address, ...g, name: guestName(g) })) }; },
    // When each window last had focus (the summon pop-up's ages for app windows; J28).
    "window.recent": () => ({ used: { ...winUsed } }),
    "room.current": () => ({ room: roomForWorkspace(activeWs), workspace: activeWs }),
    // /search WORDS or /ai Q typed in another panel: the (already open) search panel for that
    // world runs it (mockups/panel-here sends this after jumping to it; search-tui listens).
    "ui.searchRun": (p) => {
      const room = safeRoom(p.room || roomForWorkspace(activeWs));
      const mode = ["ai", "keyword", "thoughts", "digest"].includes(p.mode) ? p.mode : "";
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

    // The Stream panel's history: room messages, activity events and board changes of the last
    // `interactions` (default 200; "all" = everything), or since `since` (ms; a time filter).
    // -> { room, since, messages, events, changes }
    "history.read": (p) => {
      const room = safeRoom(p.room || roomForWorkspace(activeWs));
      const acts = activityAll(room);
      const since = p.since != null ? Math.max(0, Number(p.since) || 0) : historySince(room, p.interactions ?? 200, acts);
      return { room, since, messages: roomLog(room).msgs.filter((m) => m.ts >= since), events: acts.filter((e) => e.ts >= since),
        changes: boards.changes(room, 20000).filter((c) => c.ts >= since).reverse() };
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
        // Any agent's "🔧 decide:" post becomes a Decide item (N68); a tinker job's was filed by
        // relayTinkerResult (which also dings). Others: the item only, no new sound.
        if (!a.tinkerJob && /^\s*🔧\s*decide\b/iu.test(text)) autoDecide(a, text);
        return { room: a.room, sequence: m.seq, persistence: "saved" };
      }
      const room = safeRoom(p.room || roomForWorkspace(activeWs));
      // J53 (Angus: "Plain room messages go to you"): a plain post goes to the world's Thoughts agent,
      // which routes, briefs or answers it; not to every agent in the room. Fallback (Thoughts can't
      // start, or hasn't taken it in 90 s): delivered to the room's agents as before, and said so.
      const viaThoughts = p.deliver !== false && cfg.roomToThoughts !== false;
      const m = appendMessage(room, { author: { kind: "human", name: "Angus", via: p.via || "" }, text, ...(p.deliver === false || viaThoughts ? { undelivered: true } : {}), ...(viaThoughts ? { routed: thoughtsName(room) } : {}) });
      if (!viaThoughts) {
        const delivered = p.deliver === false ? [] : deliverHumanPost(room, m);
        return { room, sequence: m.seq, persistence: "saved", delivered };
      }
      let taken = false;
      const fallback = (why) => {
        if (taken) return; taken = true;
        thoughts.withdrawRouted(room, `#${m.seq}`); // not yet in its conversation: it won't get it later too
        const delivered = deliverHumanPost(room, m);
        thoughtsPost(room, `${thoughtsName(room)} didn't take #${m.seq} (${why}): sent to the room's agents as before${delivered.length ? ` (${delivered.join(", ")})` : " (no agents here)"}`);
      };
      thoughtsPost(room, `#${m.seq} → ${thoughtsName(room)}`);
      try {
        const waitMs = Number(cfg.roomToThoughtsWaitMs) || 90000;
        thoughts.roomMessage(room, { seq: m.seq, text, via: p.via === "phone" || /📱/.test(String(p.via || "")) ? "phone" : "" }, () => { taken = true; }, (why) => fallback(why));
        setTimeout(() => fallback(`it hadn't taken it after ${Math.round(waitMs / 1000)} s`), waitMs).unref?.();
      } catch (e) { fallback(e.message); }
      return { room, sequence: m.seq, persistence: "saved", delivered: [thoughtsName(room)], routed: thoughtsName(room) };
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

    // J87 /restart (Angus): replace an agent's pi process with a fresh one on the same session, id,
    // workspace and identity (frees memory, picks up the current pi). Compacts first by default (J87 v2).
    // The agent's extension waits until it's idle with nothing held, compacts, calls agent.restartReady
    // and shuts its pi down; the daemon then reopens it like restore-all does and reports before/after.
    "agent.restart": async (p, conn) => {
      const { agent: a, error } = p.agent ? findAgent(String(p.agent).replace(/^@/, "")) : { agent: agents.get(conn.agentId), error: conn.agentId ? "" : "which agent?" };
      if (error || !a) throw new Error(error || "agent not found");
      if (!a.conn) throw new Error(`${displayName(a)} isn't connected`);
      if (!a.session || !fs.existsSync(a.session)) throw new Error(`${displayName(a)} has no session file to resume`);
      if (restarts.has(a.id)) return { agent: displayName(a), already: true };
      const compact = p.compact !== false;
      const by = String(p.by || "") || (conn.agentId && conn.agentId !== a.id ? displayName(agents.get(conn.agentId) || { id: conn.agentId }) : conn.agentId === a.id ? "itself" : "Angus");
      restarts.set(a.id, { by, compact, at: Date.now(), before: procInfo(a.hostPid || a.pid), pending: true });
      if (!sendAgent(a, "restart", { compact, by })) { restarts.delete(a.id); throw new Error(`couldn't reach ${displayName(a)}`); }
      // A restart that never gets going (no restartReady in 30 min) is dropped.
      setTimeout(() => { const r = restarts.get(a.id); if (r?.pending && r.at && Date.now() - r.at >= 1800000) restarts.delete(a.id); }, 1800000).unref?.();
      log(`restart of ${displayName(a)} asked by ${by}${compact ? " (compact first)" : ""}${a.status === "working" ? "; it waits until its turn ends" : ""}`);
      return { agent: displayName(a), queued: a.status === "working", compact };
    },
    // From the agent's own extension: idle, compacted (or not), about to shut down. Reopen it once its process is gone.
    "agent.restartReady": async (p, conn) => {
      const a = agents.get(conn.agentId), r = a && restarts.get(a.id);
      if (!a || !r) throw new Error("no restart pending for this agent");
      await refreshWindows().catch(() => {});
      const pid = a.hostPid || a.pid, addr = a.address, ws = Number.isInteger(a.workspace) && a.workspace > 0 ? a.workspace : null;
      Object.assign(r, { pending: false, ws, guest: addr && guests[addr] ? { ...guests[addr] } : null, focused: !!addr && (await hypr.activeWindow({ env }).catch(() => null))?.address === addr,
        compacted: p.compacted || "", session: a.session, cwd: a.cwd, twinOf: a.twinOf || "", parked: !!a.parked, before: { ...r.before, ...procInfo(pid) } });
      const id = a.id;
      (async () => {
        try {
          // Its pi exits (ctx.shutdown after this reply); wait up to 20 s, then make sure.
          const alive = () => { try { process.kill(pid, 0); return true; } catch { return false; } };
          for (let i = 0; i < 80 && alive(); i++) await sleepMs(250);
          if (alive()) { log(`restart ${id}: pi ${pid} didn't exit; closing its window`); if (addr) await hypr.closeWindow(addr, { env }).catch(() => {}); for (let i = 0; i < 40 && alive(); i++) await sleepMs(250); }
          for (let i = 0; i < 40 && agents.has(id); i++) await sleepMs(250); // its connection drops
          const { model, thinking } = sessionModel(r.session);
          const bin = new URL("../bin/hyprpi", import.meta.url).pathname;
          // J125: a fresh session (an overdue refresh) starts from the agent's handoff, not the old session file.
          if (r.fresh && r.handoffText) welcomes.set(id, r.handoffText);
          const argv = ["new", "--id", id, "--cwd", r.cwd && fs.existsSync(r.cwd) ? r.cwd : process.env.HOME, ...(r.focused ? [] : ["--no-focus"]),
            ...(r.ws ? ["--workspace", String(r.ws), ...(r.focused ? [] : ["--silent"])] : []), ...(r.twinOf ? ["--twin-of", r.twinOf] : []),
            "--", ...(r.fresh ? [] : ["--session", r.session]), ...(model ? ["--model", thinking ? `${model}:${thinking}` : model] : [])];
          const cenv = { ...process.env, ...env };
          for (const k of Object.keys(cenv)) if (/^(HYPRPI_AGENT_ID|HYPRPI_WORKSPACE|HYPRPI_TWIN_OF|PI_SESSION)/.test(k)) delete cenv[k];
          spawn(process.execPath, [bin, ...argv], { detached: true, stdio: "ignore", env: cenv }).unref();
          resuming.set(id, Date.now());
          let b = null;
          for (let i = 0; i < 240 && !(b = agents.get(id))?.address; i++) await sleepMs(250);
          if (!b?.address) { log(`restart ${id}: the new window didn't come up in 60 s`); const reg = registry[id]; if (reg) { reg.open = true; reg.resumable = true; saveRegistryNow(); } pushAgents(); return; }
          if (r.parked) await hypr.moveWindow(b.address, "special:reprieve", { env }).catch(() => {});
          // Pins / guest state belong to the window address: move them to the new window (J87).
          if (r.guest) { if (addr && addr !== b.address) delete guests[addr]; guests[b.address] = { ...r.guest, ts: Date.now() }; saveGuests(); await guestTag(b.address, !!r.guest.pinned); if (r.ws) nativeBorders(r.ws); }
          const after = procInfo(b.hostPid || b.pid), be = r.before;
          const line = `${r.fresh ? "refreshed on a fresh session" : "restarted"}${r.compacted ? ` (${r.compacted})` : ""}: pi ${be.version || "?"} → ${after.version || "?"} · pid ${be.pid} → ${after.pid} · RSS ${be.rssMb} → ${after.rssMb} MB`;
          log(`${displayName(b)} ${line} (asked by ${r.by})`);
          recordActivity(b, "restarted", line);
          sendAgent(b, "note", { text: `🔄 ${line}` });
          if (r.fresh) upkeepRefreshed(b, r); // J125: room line + Thoughts note
          Object.assign(r, { after, line, done: Date.now() });
          lastRestart.set(id, r);
        } catch (e) { log(`restart ${id} failed:`, e.message); }
        finally { setTimeout(() => restarts.delete(id), 3000); }
      })();
      return { ok: true };
    },
    "agent.restartStatus": (p) => {
      const w = String(p.agent || "").replace(/^@/, ""), { agent: a } = findAgent(w);
      const id = a?.id || Object.values(registry).find((x) => x.id === w || (x.name && bare(x.name).toLowerCase() === bare(w).toLowerCase()))?.id || w; const r = restarts.get(id) || lastRestart.get(id); return r ? { agent: id, pending: !!r.pending, done: !!r.done, line: r.line || "", before: r.before, after: r.after || null } : { agent: id, none: true }; },

    // ---- J125 upkeep (see upkeepPass) ----
    // From an agent's extension: it pruned its context (a quiet note to its Thoughts).
    "upkeep.note": (p, conn) => {
      const a = agents.get(conn.agentId); if (!a) return { ok: false };
      if (p.kind === "prune") upkNote(a.room, `${displayName(a)}: ${[p.images ? `${p.images} older image${p.images === 1 ? "" : "s"}` : "", p.outputs ? `${p.outputs} big tool output${p.outputs === 1 ? "" : "s"}` : ""].filter(Boolean).join(" and ")} left its context (~${p.kb} KB); stubs link to the files on disk (screenshots where they were, the rest saved in ${String(p.dir || "").replace(process.env.HOME || "\u0000", "~")})`);
      return { ok: true };
    },
    // From an agent's extension after a compaction: the jobs it is on (its compact-and-continue reminder).
    "upkeep.jobs": (p, conn) => {
      const a = agents.get(conn.agentId); if (!a) return { jobs: [] };
      return { jobs: runningJobs(a).map((b) => ({ job: b.id, version: b.version, goal: String(b.fields?.goal || "").slice(0, 300) })) };
    },
    // The agent's upkeep_ready tool: its handoff is written. Reopen it on a fresh session from it.
    "upkeep.ready": (p, conn) => {
      const a = agents.get(conn.agentId);
      if (!a) throw new Error("not a hyprpi agent");
      const st = upk.agents[a.id] || {}, S = loadUpkeep();
      const file = path.resolve(expandHome(String(p.file || st.file || "")));
      let text = ""; try { text = fs.readFileSync(file, "utf8"); } catch (e) { throw new Error(`can't read the handoff ${file}: ${e.message}`); }
      if (text.trim().length < 40) throw new Error(`the handoff ${file} is (nearly) empty; write it first`);
      if (restarts.has(a.id)) return { file, already: true };
      const oldCompactions = compactInfo(a)?.count ?? null;
      restarts.set(a.id, { by: `upkeep (${thoughtsName(a.room)})`, compact: false, at: Date.now(), before: procInfo(a.hostPid || a.pid), pending: true,
        fresh: true, handoffFile: file, oldCompactions,
        handoffText: `[hyprpi upkeep] You're on a FRESH session: your previous one (${oldCompactions ?? "many"} compactions) was refreshed, and it's kept on disk (${a.session}). You are the same agent (name, workspace, projects, jobs and pending replies are unchanged). Here is the handoff you wrote for yourself (${file}):\n\n${text.slice(0, 60000)}\n\nRead it, then reply in one or two lines saying you're back and what you're picking up. Carry on with your jobs as they stand; don't redo finished work.` });
      if (!sendAgent(a, "restart", { compact: false, by: "upkeep" })) { restarts.delete(a.id); throw new Error("couldn't reach the agent's window"); }
      // Blink's note (J126): an upkeep refresh that never gets going (no restartReady in 30 min) is dropped.
      setTimeout(() => { const r = restarts.get(a.id); if (r?.pending && r.fresh) { restarts.delete(a.id); log(`upkeep: ${displayName(a)}'s refresh never started; dropped`); } }, 1800000).unref?.();
      Object.assign(upk.agents[a.id] ||= { history: [] }, { phase: "refreshing", file }); saveUpk();
      void S;
      return { file, refreshing: true };
    },
    // Thoughts' upkeep tool: status, pause / resume an agent, or ask it for its handoff now (if idle).
    "thoughts.upkeep": (p) => {
      const room = safeRoom(p.room), S = loadUpkeep(), act = String(p.action || "status");
      if (act === "status") {
        const rows = [...agents.values()].filter((a) => a.room === room && a.conn).map((a) => {
          const c = compactInfo(a), st = upk.agents[a.id] || {};
          return `- ${displayName(a)}: ${a.status}${c ? ` · ⟳ ${c.count}` : ""}${refreshDue(c) ? " · due" : ""}${upkPaused(a, S) ? " · PAUSED" : ""}${st.phase ? ` · ${st.phase}` : ""}${st.last ? ` · last refresh ${new Date(st.last).toLocaleString()}` : ""}`;
        });
        return { text: `Upkeep strategy: ${UPKEEP_FILE_PATH}${S.error ? ` (⚠ ${S.error})` : ""}\nprune ${S.prune.enabled ? "on" : "off"} (keep ${S.prune.keepImages} images, ${S.prune.keepTurns} turns) · compact reminder ${S.compactContinue.enabled ? "on" : "off"} · refresh ${S.refresh.enabled ? "on" : "off"} (idle ${S.refresh.idleMinutes} min, cooldown ${S.refresh.cooldownHours} h${S.refresh.maxPerDay > 0 ? `, max ${S.refresh.maxPerDay}/day` : ""}) · Thoughts refresh ${S.thoughts.enabled ? "on" : "off"}\n${rows.join("\n") || "(no live agents)"}` };
      }
      const { agent: a, error } = findAgent(String(p.agent || "").replace(/^@/, ""));
      if (error || !a) throw new Error(error || "which agent?");
      if (act === "pause") { if (!upk.paused.includes(a.id)) upk.paused.push(a.id); saveUpk(); upkNote(room, `${displayName(a)} paused (no upkeep refresh until resumed)`); return { text: `${displayName(a)} paused.` }; }
      if (act === "resume") { upk.paused = upk.paused.filter((x) => x !== a.id); saveUpk(); upkNote(room, `${displayName(a)} resumed`); return { text: `${displayName(a)} resumed.` }; }
      if (act === "now") {
        if (!["idle", "done"].includes(a.status)) throw new Error(`${displayName(a)} is ${a.status}; upkeep never refreshes a working agent`);
        if (upk.agents[a.id]?.phase === "asked" || restarts.has(a.id)) return { text: `${displayName(a)} is already being refreshed.` };
        const c = compactInfo(a); upkeepAsk(a, S, `asked by ${thoughtsName(room)}${c ? `, ⟳ ${c.count}` : ""}`); return { text: `Asked ${displayName(a)} for its handoff.` };
      }
      throw new Error("action: status | pause | resume | now");
    },
    // Thoughts' write_handoff tool (its own upkeep refresh): saved, then the fresh session starts when it's idle.
    "thoughts.handoff": (p) => {
      const room = safeRoom(p.room), text = String(p.text || "").trim();
      if (text.length < 40) throw new Error("write the whole handoff (open jobs, what's waiting on Angus, context)");
      const S = loadUpkeep(), dir = expandHome(S.refresh.handoffDir); fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `Thoughts-${room}-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.md`);
      fs.writeFileSync(file, text + "\n");
      Object.assign(upk.thoughts[room] ||= {}, { pending: file, handoffAt: Date.now(), phase: "handoff" }); saveUpk();
      setTimeout(() => { try { upkeepPass(); } catch (e) { log("upkeep:", e.message); } }, 4000).unref?.();
      return { file, text: `Saved to ${file}. You'll restart on a fresh session from it when this turn ends.` };
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

    "restore.status": async (p) => {
      const plan = await restorePlan(p.scope || "all");
      return { ...plan, running: restoring, offered: restoreOffered, frozen, last_end: lastEnd };
    },
    "restore.run": async (p) => { restoreOffered = true; return runRestore(p.scope || "all", String(p.by || "")); },
    // The first deliberate entry point after a fresh start (hyprpi new, the panel keys) calls this:
    // a one-time menu "Restore all / this world / not now / no".
    "restore.offer": (p) => offerRestore(String(p.from || "")),
    "restore.decline": () => { restoreOffered = true; return declineRestore(); },

    // Drop a dormant agent from the list (its session file stays).
    "agent.forget": (p) => {
      const r = registry[String(p.agent || "")];
      if (!canResume(r)) throw new Error("no closed agent to forget");
      r.resumable = false; r.forgotten = true; r.open = false; r.closedBy ||= "forgotten"; r.closedAt ||= Date.now(); saveRegistry(); pushAgents();
      return { agent: r.id, forgotten: true };
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
    // ---- thoughts (the search panel's Thoughts mode; /thought) ----
    // /keyword and /ask in the Thoughts window (the search panel, Angus 2026-09-29): at most n (10)
    // matching turns, the newest ones, shown oldest first; each with a reference to its turn
    // (agent / session / entry id). Added to the thread and given to the model with the next message.
    "thoughts.evidence": async (p) => {
      const room = safeRoom(p.room || roomForWorkspace(activeWs) || "A"), token = String(p.token || randomUUID());
      evRunning.set(token, room);
      try {
        const ev = await buildEvidence(room, p);
        if (evCancelled.has(token)) return { cancelled: true }; // Esc: a late result is dropped
        return thoughts.evidence(room, ev, { inject: p.inject !== false });
      } finally { evRunning.delete(token); evCancelled.delete(token); }
    },
    // Esc in the Thoughts window: cancel running /keyword /ask /more (their results are dropped) and
    // abort the Thoughts agent's turn (its search_history too). "⏹ interrupted" in the thread.
    "thoughts.interrupt": (p) => {
      const room = safeRoom(p.room || roomForWorkspace(activeWs) || "A");
      let evidence = 0;
      for (const [t, r] of evRunning) if (r === room) { evCancelled.add(t); evidence++; }
      const turn = thoughts.interrupt(room, { ask: !!p.ask }); // ask: the phone's ■ (J38): Thoughts then says what got cut off
      if (evidence || turn) thoughts.note(room, "⏹ interrupted");
      return { room, evidence, turn };
    },
    // The Thoughts agent's own search_history: the same evidence, not added here (lib/thoughts.mjs
    // shows it in the thread when the tool returns).
    "thoughts.find": async (p) => buildEvidence(safeRoom(p.room || roomForWorkspace(activeWs) || "A"), p),
    // /digest [@names…] [time] [words] in the Thoughts window: the matching Stream lines (lib/stream.mjs,
    // the Stream panel's own filter) go to Thoughts as evidence; it writes a summary by project.
    // No time given: since Angus last looked at that Thoughts window (thoughts.seen), else 12 h.
    "thoughts.digest": (p) => {
      const room = safeRoom(p.room || roomForWorkspace(activeWs) || "A"), now = Date.now();
      const f = parseStreamFilter(p.filter || "", now);
      const looked = thoughtsLooked()[room] || 0;
      let label = f.text;
      if (!f.since) { f.since = looked && now - looked < 7 * 86400e3 ? looked : now - 12 * 3600e3; label = `${label ? label + " " : ""}${looked && f.since === looked ? "since you last looked" : "last 12 h"}`; }
      const msgs = roomLog(room).msgs.filter((m) => m.ts >= f.since && m.author?.kind !== "system");
      const events = activityAll(room).filter((e) => e.ts >= f.since - 3 * 3600e3); // a little earlier: turn boundaries for the dedupe
      const changes = boards.changes(room, 20000).filter((c) => c.ts >= f.since);
      const projects = boards.load(room).projects;
      const items = buildStream({ msgs, events, changes, projects, raw: f.raw });
      const pool = [...agents.values()].map((a) => ({ id: a.id, name: a.name, display: displayName(a) }));
      const r = resolveFilterNames(f.names, { agents: pool, projects, items });
      if (r.unknown.length) throw new Error(`no agent or project ${r.unknown.map((n) => "@" + n).join(" ")}`);
      const list = filterStream(items, f, r);
      if (!list.length) return { room, total: 0, label: label || "everything" }; // nothing to sum up: Thoughts isn't bothered
      const pn = (id) => projects.find((x) => x.id === id)?.name || "";
      const all = list.slice(-400), shown = list.slice(-30);
      const ev = { kind: "digest", query: label || "everything", n: shown.length, total: list.length, older: list.length - shown.length,
        items: shown.map((it) => ({ who: it.kind === "board" ? "📋 " + (it.pname || pn(it.project)) : it.who?.name || "?", ts: it.ts, text: streamLine(it, { projectName: pn, time: false, clip: 400 }) })) };
      const lines = all.map((it) => streamLine(it, { projectName: pn, clip: 600 })).join("\n");
      thoughts.digest(room, ev, lines, list.length > all.length ? list.length - all.length : 0);
      return { room, total: list.length, label: ev.query };
    },
    // The Thoughts window lost focus (or closed): Angus last looked at it now (for /digest).
    "thoughts.seen": (p) => {
      const room = safeRoom(p.room || roomForWorkspace(activeWs) || "A"), l = thoughtsLooked();
      l[room] = Date.now();
      try { fs.writeFileSync(path.join(STATE, "thoughts", "looked.json"), JSON.stringify(l)); } catch (e) { log("thoughts looked:", e.message); }
      return { room, ts: l[room] };
    },
    "thoughts.ignore": (p) => thoughts.ignore(safeRoom(p.room || roomForWorkspace(activeWs) || "A"), p.text),
    "thoughts.send": (p) => thoughts.send(safeRoom(p.room || roomForWorkspace(activeWs) || "A"), p.text, p.images, { via: p.via === "phone" || p.via === "voice" ? p.via : "" }), // voice: J98 dictation to the focused world's Thoughts
    // J98 v2 (Angus: "the option of sending it to a single agent or a project too. Let's make the current
    // world the default though."): a dictation (voice-agent) goes to the Thoughts of the world he is in,
    // marked 🎤, unless it clearly starts with an addressee: "Knock, …" / "to Knock …" / "@Knock …" (a live
    // agent, as Ctrl+click matches names: lib/tui/agent-click.mjs agentIn) → straight to it like "@Agent";
    // "project system, …" / "to project system …" / "@system …" → like "@project" (its owner, J54 rule).
    // p.to: a sticky target from the picker ("hp:<id>" agent, "proj:<name>" project). Anything unclear: Thoughts.
    "voice.dictate": (p, conn) => {
      const raw = String(p.text ?? "").trim();
      if (!raw || Buffer.byteLength(raw) > MAX_TEXT) throw new Error("text must be 1..8192 bytes");
      const room = safeRoom(p.room || roomForWorkspace(activeWs) || "A");
      const note = "🎤 (dictated: may contain misheard words)";
      const toAgent = (a, text) => { if (!sendAgent(a, "prompt", { text: `${note} ${text}`, via: "voice" })) throw new Error(`${displayName(a)} isn't connected`); recordActivity(a, "prompt", `Angus 🎤 → ${displayName(a)}: ${text}`); return { to: "agent", agent: displayName(a), room: a.room }; };
      const toProject = (pr, text) => { const r = methods["board.request"]({ project: pr.id, room: roomOfProject(pr) || room, text: `${note} ${text}`, where: "room", via: "voice" }, conn); return { to: "project", project: "@" + r.name, told: r.told, room: roomOfProject(pr) || room }; };
      const live = [...agents.values()].filter((a) => a.conn);
      const sticky = String(p.to || "");
      if (sticky.startsWith("hp:")) { const a = agents.get(sticky.slice(3)); if (a?.conn) return toAgent(a, raw); }
      if (sticky.startsWith("proj:")) { const f = boards.find(sticky.slice(5), room); if (f) return toProject(f.project, raw); }
      // A spoken addressee at the very start, then "," ":" or (after "to" / "@") a space.
      const m = /^(?:(to|hey)\s+|(@))?(project\s+)?(.+)$/i.exec(raw);
      const led = !!(m[1] || m[2]), rest = m[4];
      if (m[3] || m[2]) { // project words: "project X", "@X" — the name up to the first , : or space
        const pm = /^([\p{L}\p{N}][\p{L}\p{N}_-]*)(?:\s*[,:]\s*|\s+)([\s\S]+)$/u.exec(rest);
        const f = pm && boards.find(pm[1].toLowerCase(), room);
        if (f && f.project.status !== "archived") return toProject(f.project, pm[2].trim());
      }
      if (!m[3]) {
        const a = agentIn(rest.split(/\s+/)[0], live);
        if (a) {
          const names = [a.display, a.name].map((n) => String(n || "").toLowerCase()).filter(Boolean).sort((x, y) => y.length - x.length);
          const low = rest.toLowerCase(), n = names.find((k) => low.startsWith(k));
          const after = n ? rest.slice(n.length) : "";
          const sep = /^\s*[,:]/.test(after) || (led && /^\s+\S/.test(after));
          if (n && sep) return toAgent(a, after.replace(/^\s*[,:]?\s*/, ""));
        }
      }
      thoughts.send(room, raw, [], { via: "voice" });
      return { to: "thoughts", room, thoughts: thoughtsName(room) };
    },
    // J116: a fresh session (old one archived). Not while a question Thoughts asked an agent is unanswered
    // (Blink: its answer would land in a conversation that doesn't know it asked); force: true overrides.
    "thoughts.fresh": (p) => {
      const room = safeRoom(p.room);
      // J120: only a known world (a room hyprpi knows, or one whose Thoughts already has a thread); a typo or
      // a probe must not start a Thoughts for a world that doesn't exist (Summoner's ZZ_probe slip).
      const known = new Set(knownRooms().map((r) => r.id));
      if (!known.has(room) && !fs.existsSync(path.join(STATE, "thoughts", `${room}.thread.jsonl`)))
        throw new Error(`no world ${room} (known: ${[...known].join(", ")})`);
      // Only live agents count (Sweep's test: a question to an agent that has since closed blocked it for 12 h).
      const waiting = (r) => [...(r.recipients || [])].filter((id) => !r.replies?.has?.(id) && agents.get(id)?.conn);
      const open = [...requests.values()].filter((r) => r.thoughts === room && !r.brief && r.mode === "demand" && waiting(r).length);
      if (open.length && !p.force) throw new Error(`${thoughtsName(room)} is waiting for ${open.length} answer${open.length === 1 ? "" : "s"} (${[...new Set(open.flatMap((r) => waiting(r).map((id) => nameOf(id))))].join(", ")}); try when they've answered, or --force`);
      return thoughts.fresh(room, { handoff: String(p.handoff || "") });
    },
    "thoughts.get": (p) => thoughts.get(safeRoom(p.room || roomForWorkspace(activeWs) || "A"), Math.min(1000, Number(p.limit) || 200)),
    // Its tools (pi-extension/thoughts.ts):
    "thoughts.world": (p) => {
      const room = safeRoom(p.room);
      const inProjects = (id) => boards.load(room).projects.filter((x) => x.status !== "archived" && x.members.includes(id)).map((x) => "@" + x.name);
      const live = [...agents.values()].filter((a) => a.room === room && a.conn);
      const posts = roomLog(room).msgs.filter((m) => m.author?.kind !== "system").slice(-(Math.min(60, Number(p.posts) || 15)));
      const text = [`World ${room}.`, "", "Agents:", ...(live.length ? live.map((a) => `- ${displayName(a)} (${wsName(a)}): ${a.status === "background" ? `◐ background (its turn ended; ${helpersText(a)})` : a.status}${a.model ? ` · model ${a.model}${a.thinking ? "/" + a.thinking : ""}` : ""}${a.topic ? " · " + a.topic : ""}${inProjects(a.id).length ? " · " + inProjects(a.id).join(" ") : ""}${compactText(a) ? " · " + compactText(a) + (refreshDue(compactInfo(a)) ? " (due for a refresh)" : "") : ""}`) : ["- none live"]),
        "", "Board:", boardText(boards.load(room), nameOf, {}), "", "Recent room posts:", ...posts.map((m) => `- ${new Date(m.ts).toLocaleTimeString()} ${m.author?.kind === "human" ? "Angus" : m.author?.name || "?"}: ${clipT(m.text, 400)}`)].join("\n");
      return { room, text };
    },
    "thoughts.ask": (p) => {
      // "Thoughts-X": another world's Thoughts agent (Angus, @hyprpi N58). It gets "[message from agent
      // Thoughts-C …]" and answers with answer_agent; the answer comes back as "[reply from Thoughts-X]".
      const tx = /^@?thoughts-([A-Za-z0-9_-]+)$/i.exec(String(p.agent || "").trim());
      if (tx) return thoughtsToThoughts(safeRoom(p.room), safeRoom(tx[1].toUpperCase()), String(p.question || "").trim(), p.images);
      const room = safeRoom(p.room), a = liveAgent(p.agent);
      if (!isFree(a) && !p.urgent) throw new Error(`${displayName(a)} is ${a.status} right now; ask later (or urgent: true if Angus says so)`);
      const name = thoughtsName(room);
      thoughtsRequest(room, [a], "demand", withImages(`[${name}, asking for Angus] ${String(p.question || "").trim()}`, p.images) + `\n\n(Answer with talk_reply; ${name} passes it on to Angus.)`, { urgent: !!p.urgent });
      thoughtsPost(room, `→ ${displayName(a)} (question): ${clipT(p.question, 200)}`);
      return { agent: displayName(a) };
    },
    "thoughts.work": (p) => {
      const room = safeRoom(p.room), name = thoughtsName(room), task = String(p.task || p.goal || "").trim();
      if (!task) throw new Error("no task");
      let a = null, pr = null, item = "";
      if (p.project) {
        pr = boards.must(p.project, null).project;
        const ms = pr.members.map((id) => agents.get(id)).filter((x) => x?.conn);
        a = p.agent ? liveAgent(p.agent) : ms.find(isFree) || (p.urgent ? ms[0] : null);
        if (!a) throw new Error(ms.length ? `@${pr.name}'s members are all busy (${ms.map(displayName).join(", ")}); try again later, urgent: true, or open_agent` : `@${pr.name} has no live members; use open_agent`);
      } else a = liveAgent(p.agent);
      if (!isFree(a) && !p.urgent) throw new Error(`${displayName(a)} is ${a.status} right now; wait, pick another agent, or urgent: true if Angus says so`);
      const fields = briefFields(p);
      const b = briefs.create({ fields, project: pr?.id || "", projectName: pr?.name || "", item: "", agent: a.id, agent_name: displayName(a), from: name, room });
      if (pr) { try { const f = boards.find(pr.id); const r = boards.addItem(pr.id, f.board.room, { section: "next", text: briefCard(b) }, { id: "", name }); item = r?.item?.h || ""; b.item = item; briefs.save(); } catch (e) { log("thoughts.work: card", e.message); } }
      const text = renderBrief({ ...b, project: pr?.name || "" }) + (p.images ? withImages("", p.images) : "") + (pr ? `\n\n(Project @${pr.name}${item ? `, card item ${item}` : ""}: keep the card current.)` : "") + `\n${name} tells Angus.`;
      b.request = thoughtsRequest(room, [a], "demand", text, { urgent: !!p.urgent, work: { task: fields.goal, project: pr?.id || "", item, brief: b.id, version: 1 } }); briefs.save();
      if (!pr) { briefToCard(b); item = b.item; } // Loose jobs (J10)
      thoughtsPost(room, `→ ${displayName(a)}${pr ? ` (@${pr.name})` : ""} · brief ${b.id} v1${pr ? "" : ` (on @${b.projectName} ${b.item})`}: ${clipT(fields.goal, 200)}`);
      return { agent: displayName(a), project: pr?.name || "", item, job: b.id, version: 1, loose: pr ? "" : `@${b.projectName} ${b.item}` };
    },
    // set_model (Thoughts, Angus's standing permission, @hyprpi N47): the agent's own extension switches
    // its model (pi.setModel) and answers through agent.modelResult.
    "thoughts.setModel": async (p) => {
      const room = safeRoom(p.room), a = liveAgent(p.agent), model = String(p.model || "").trim(), thinking = String(p.thinking || "").trim();
      if (!model && !thinking) throw new Error("give a model (provider/id or id) and/or a thinking level");
      const token = randomUUID(), before = a.model || "";
      const done = new Promise((resolve) => { modelWaits.set(token, resolve); setTimeout(() => { if (modelWaits.delete(token)) resolve({ ok: false, error: `no answer from ${displayName(a)} (its hyprpi extension may predate set_model; it needs a /reload)` }); }, 8000).unref?.(); });
      if (!sendAgent(a, "set_model", { token, model, thinking })) { modelWaits.delete(token); throw new Error(`${displayName(a)} isn't connected`); }
      const r = await done;
      if (!r.ok) throw new Error(r.error || "the switch failed");
      thoughtsPost(room, `→ ${displayName(a)}: model ${before || "?"} → ${r.model || model}${r.thinking ? ` (thinking ${r.thinking})` : ""}${p.reason ? ` · ${clipT(p.reason, 120)}` : ""}`);
      return { agent: displayName(a), before, model: r.model, thinking: r.thinking || "" };
    },
    // cancel_work (Thoughts, @hyprpi N57): Angus withdrew or changed work Thoughts handed out. The
    // agent's own extension drops what it still holds of it (never starts), stops the run that work
    // started (like Esc), then gets the stop, or the replacement, as a turn of its own; its reply
    // comes back to Thoughts like any. Work that was already answered: "done", with any commit hash.
    "thoughts.cancel": async (p) => {
      const room = safeRoom(p.room), name = thoughtsName(room), from = "thoughts:" + room;
      const a = liveAgent(p.agent), reason = String(p.reason || "").replace(/\s+/g, " ").trim(), repl = String(p.replace_with || "").trim();
      if (!reason) throw new Error("give the reason, in Angus's words");
      const work = [...requests.entries()].filter(([, r]) => r.from === from && r.task && r.recipients.has(a.id))
        .sort((x, y) => (y[1].ts || 0) - (x[1].ts || 0));
      if (!work.length) throw new Error(`${name} has handed ${displayName(a)} no work to cancel (cancel_work is for give_work / open_agent tasks)`);
      const open = work.filter(([, r]) => !r.replies.has(a.id) && !r.cancelled);
      if (!open.length) { // finished already: say so, with the commit if the reply names one
        const [, r] = work[0], rep = String(r.replies.get(a.id) || r.cancelled || "");
        return { agent: displayName(a), state: r.cancelled ? "already cancelled" : "done", task: clipT(r.task, 200), hash: (rep.match(/\b[0-9a-f]{7,40}\b/) || [""])[0], reply: clipT(rep, 600) };
      }
      const what = clipT(String(open[0][1].task).replace(/\s+/g, " "), 120);
      const text = repl
        ? `[${name}, from Angus] Change of plan: Angus changed his mind about "${what}": ${reason}. Stop that and do this instead:\n${repl}\n\nDon't revert anything from the earlier task unless told. When it's done (or if you're stuck or need a decision), reply with talk_reply: what you did and how you checked it. ${name} tells Angus.`
        : `[${name}, from Angus] Stop: Angus changed his mind about "${what}": ${reason}. Don't continue it. Don't revert anything unless told. Reply with the state you left things in (committed / uncommitted / half-edited files).`;
      const rid = randomUUID(), token = randomUUID();
      const req = { from, thoughts: room, mode: "demand", recipients: new Set([a.id]), replies: new Map(), ...(repl ? { task: repl, project: open[0][1].project || "", item: "", ...(p.brief ? { brief: p.brief.id, version: p.brief.version } : {}) } : {}) };
      const answered = new Promise((resolve) => { cancelWaits.set(token, resolve); setTimeout(() => { if (cancelWaits.delete(token)) resolve({ ok: false, error: `no answer from ${displayName(a)} (its hyprpi extension may predate cancel_work; it needs a /reload)` }); }, 8000).unref?.(); });
      if (!sendAgent(a, "cancel", { token, ids: open.map(([id]) => id), replace: !!repl, talk: { request_id: rid, mode: "demand", text, from: { id: from, name }, expires_in: 43200 } })) { cancelWaits.delete(token); throw new Error(`${displayName(a)} isn't connected`); }
      const r = await answered;
      if (!r.ok) throw new Error(r.error || "the cancel failed");
      for (const [, o] of open) o.cancelled = reason;
      if (r.delivered) keepRequest(rid, req); else saveRequests();
      const items = []; // the work's card items: marked withdrawn in place (the card's owner archives them)
      // Briefs: a stop is a state change (stopped, or cancelled with final); a revise_work sets its own.
      if (!p.brief) for (const [, o] of open) if (o.brief) { const b = briefs.get(o.brief); if (b && b.state === "running") { briefs.setState(b.id, p.final ? "cancelled" : "stopped", { note: reason }); briefToCard(b); items.push(`${b.id} ${p.final ? "cancelled" : "stopped"}`); } }
      for (const [, o] of open) if (o.project && o.item && !o.brief) {
        try {
          const f = boards.find(o.project), it = (f.project.items || []).find((x) => x.h === o.item);
          if (it && !/^✋ WITHDRAWN/.test(it.text)) { boards.editItem(o.project, f.board.room, o.item, { text: `✋ WITHDRAWN (Angus via ${name}): ${clipT(reason, 160)} — ${it.text}` }, { id: "", name }); items.push(`@${f.project.name} ${o.item}`); }
        } catch (e) { log("thoughts.cancel: card", e.message); }
      }
      const state = r.aborted ? "stopped mid-turn" : r.started ? "told to stop" : "dropped before it started";
      thoughtsPost(room, `✋ stopped ${displayName(a)}: ${clipT(reason, 160)}${repl ? ` → instead: ${clipT(repl, 100)}` : ""}`);
      return { agent: displayName(a), state, task: what, dropped: r.dropped || 0, items, replaced: !!repl, delivered: !!r.delivered, request_id: rid };
    },
    // interrupt_agent (Angus, brief J12): any live agent, not only Thoughts' own jobs. Its run is aborted
    // like Esc (cancel_work's "cancel" event with interrupt: true and no work ids, so nothing held is
    // dropped and no brief or card item changes); the message arrives as its next turn; the agent
    // answers it and carries on. An agent whose extension predates it gets the message after its turn.
    "thoughts.interruptAgent": async (p) => {
      const room = safeRoom(p.room), name = thoughtsName(room), from = "thoughts:" + room;
      const a = liveAgent(p.agent), msg = String(p.message || "").trim();
      if (!msg) throw new Error("give the message to interrupt it with");
      const resume = p.resume !== false;
      const text = `[${name} interrupts you${p.from_angus ? ", for Angus" : ""}] ${withImages(msg, p.images)}\n\n` + (resume
        ? "This interrupt cut off your last step on purpose (it wasn't an error or a failure): answer this (talk_reply), then pick up exactly where you were, re-running the step that was cut off, and carry on with what you were doing, unless the message says otherwise."
        : "This interrupt cut off your last step on purpose. Answer this (talk_reply) and then stop: don't resume what you were doing until you're told to.");
      const rid = randomUUID(), token = randomUUID();
      const req = { from, thoughts: room, mode: "demand", recipients: new Set([a.id]), replies: new Map() };
      const busyBefore = a.status === "working";
      const answered = new Promise((resolve) => { cancelWaits.set(token, resolve); setTimeout(() => { if (cancelWaits.delete(token)) resolve({ ok: false, old: true }); }, 8000).unref?.(); });
      if (!sendAgent(a, "cancel", { token, ids: [], interrupt: true, replace: true, talk: { request_id: rid, mode: "demand", text, from: { id: from, name }, expires_in: 43200 } })) { cancelWaits.delete(token); throw new Error(`${displayName(a)} isn't connected`); }
      const r = await answered;
      keepRequest(rid, req);
      if (!r.ok && !r.old) throw new Error(r.error || "the interrupt failed");
      const busyNow = busyBefore;
      const state = r.aborted ? "interrupted mid-turn; the message is its next turn"
        : r.old || busyNow ? "sent, but its window predates interrupt_agent (it needs a /reload), so it reads the message after its current turn"
        : "it was idle; the message starts a turn";
      thoughtsPost(room, `⏸ ${name} interrupted ${displayName(a)}: ${clipT(msg, 160)}`);
      return { agent: displayName(a), state, request_id: rid };
    },
    "agent.cancelResult": (p) => { const f = cancelWaits.get(String(p.token || "")); if (f) { cancelWaits.delete(String(p.token)); f({ ok: !!p.ok, started: !!p.started, aborted: !!p.aborted, dropped: Number(p.dropped) || 0, delivered: !!p.delivered, error: p.error }); } return { ok: true }; },
    // Restart one world's Thoughts process (new tools / prompt) — only while it's idle; it starts
    // again on its next message (@hyprpi N57).
    // revise_work: a new version of a brief. Its fields replace the old ones (unchanged ones are kept);
    // the old version's run is stopped and its still-queued text dropped (cancel_work's mechanism),
    // then the new version arrives with the changed lines marked. Versions only go up, and only the
    // latest is ever sent, so an older one can't arrive after a newer one.
    "thoughts.revise": async (p) => {
      const room = safeRoom(p.room), name = thoughtsName(room), b0 = briefs.get(p.job);
      if (!b0) throw new Error(`no job ${p.job} (give_work / open_agent made the briefs; their ids are J1, J2, …)`);
      const reason = String(p.reason || "").replace(/\s+/g, " ").trim();
      if (!reason) throw new Error("give the reason, in Angus's words");
      const fields = fieldsFrom(p, b0.fields);
      if (p.angus) fields.angus = String(p.angus).trim();
      // done_when replaces the whole list (Angus, J26: J25 v3 silently lost v2's six checks): every
      // earlier check must be resent, or named in drop_checks ("W3" or its text) to drop it on purpose.
      if (p.done_when !== undefined) {
        const norm = (t) => String(t).replace(/^\s*W\d+[:.)]?\s+/i, "").replace(/\s+/g, " ").trim().toLowerCase();
        const now = new Set(fields.done_when.map(norm));
        const drop = (Array.isArray(p.drop_checks) ? p.drop_checks : p.drop_checks ? [p.drop_checks] : []).map(String);
        const dropped = (b0.fields.done_when || []).map((t, i) => ({ w: `W${i + 1}`, t })).filter(({ w, t }) => !now.has(norm(t))
          && !drop.some((d) => d.trim().toUpperCase() === w || norm(d) === norm(t)));
        if (dropped.length) throw new Error(`refused: done_when replaces the whole list, and this one leaves out ${dropped.map(({ w, t }) => `${w} "${t}"`).join(", ")}. Resend every check that still applies plus the new ones, or name the ones you drop on purpose in drop_checks (e.g. ["${dropped[0].w}"]) and say why in reason.`);
      }
      const { b, prev } = briefs.revise(b0.id, fields, name);
      const text = renderBrief({ ...b, project: b.projectName || "" }, { prev, note: reason }) + `\n${name} tells Angus.`;
      const a = agents.get(b.agent);
      if (!a?.conn) { briefs.setState(b.id, "stopped", { note: "agent not connected" }); briefToCard(b); throw new Error(`${b.agent_name} isn't connected; v${b.version} is kept (stopped): open_agent or give_work it to someone`); }
      // Its open work from Thoughts (the old version, or a queued stop): stop and replace it.
      const openWork = [...requests.values()].some((r) => r.from === "thoughts:" + room && r.task && r.recipients.has(a.id) && !r.replies.has(a.id) && !r.cancelled);
      let rid, state;
      if (openWork) {
        const r = await methods["thoughts.cancel"]({ room, agent: a.id, reason: `new version ${b.id} v${b.version}: ${reason}`, replace_with: text, brief: { id: b.id, version: b.version } });
        rid = r.request_id; state = r.state;
      } else {
        rid = thoughtsRequest(room, [a], "demand", text, { work: { task: fields.goal, project: b.project, item: b.item, brief: b.id, version: b.version } }); state = "sent";
      }
      b.request = rid; briefs.save(); briefToCard(b);
      thoughtsPost(room, `→ ${b.agent_name} · brief ${b.id} v${b.version}: ${clipT(reason, 160)}`);
      return { job: b.id, version: b.version, agent: b.agent_name, previous: state };
    },
    // verify_work: Angus or a second agent confirmed a done job's proof.
    "thoughts.verify": (p) => {
      const b = briefs.get(p.job);
      if (!b) throw new Error(`no job ${p.job}`);
      if (b.state !== "done") throw new Error(`${b.id} is ${b.state}; only a done job (its report answered every done-when line) can be verified`);
      const by = String(p.by || "").trim(); if (!by) throw new Error("by: who confirmed it (Angus, or a second agent's name)");
      if (by.toLowerCase() === String(b.agent_name).toLowerCase()) throw new Error("the agent that did the work can't verify it");
      briefs.setState(b.id, "verified", { verified_by: by, note: String(p.note || "") }); briefToCard(b);
      thoughtsPost(safeRoom(p.room), `✓✓ ${b.id} verified by ${by}${p.note ? `: ${clipT(p.note, 160)}` : ""}`);
      return { job: b.id, state: "verified", by };
    },
    "thoughts.briefs": (p) => p.id ? (() => { // one brief in full (the projects panel's J8 / ⏎ on a ⟦J line)
      const b = briefs.get(p.id); if (!b) throw new Error(`no job ${p.id}`);
      return { job: b.id, version: b.version, state: b.state, agent: b.agent_name, from: b.from, project: b.projectName, item: b.item, updated: b.updated,
        text: renderBrief({ ...b, project: b.projectName || "" }), report: b.report || "", history: b.history.filter((x) => x.note).map((x) => ({ ts: x.ts, state: x.state, note: x.note })) };
    })() : ({ briefs: briefs.all().filter((b) => !p.room || b.room === safeRoom(p.room)).slice(-30).map((b) => ({ job: b.id, version: b.version, state: b.state, agent: b.agent_name, goal: b.fields.goal, project: b.projectName, item: b.item })) }),
    "thoughts.restart": (p) => thoughts.restart(safeRoom(p.room)),
    "agent.modelResult": (p) => { const f = modelWaits.get(String(p.token || "")); if (f) { modelWaits.delete(String(p.token)); f({ ok: !!p.ok, model: p.model, thinking: p.thinking, error: p.error }); } return { ok: true }; },
    "thoughts.topic": (p) => ({ set: thoughtsTopic(safeRoom(p.room), p.topic) }),
    // Its answer to an agent that talked to it ("Thoughts-C" in talk / demand).
    "thoughts.answer": (p) => {
      const room = safeRoom(p.room), req = requests.get(String(p.request_id || "")), me = "thoughts:" + room;
      if (!req || !req.recipients.has(me)) throw new Error("unknown or expired request_id");
      if (req.replies.has(me)) throw new Error("already answered");
      const text = String(p.text ?? "");
      if (!text.trim() || Buffer.byteLength(text) > 32768) throw new Error("answer must be 1..32768 bytes");
      req.replies.set(me, text); saveRequests();
      if (req.t2t) { // an answer to another world's Thoughts (N58)
        t2tAnswering.delete(room);
        const asker = req.t2t.from;
        thoughts.reply(asker, thoughtsName(room), text);
        thoughtsPost(room, `↩ answered ${thoughtsName(asker)}: ${clipT(text, 200)}`);
        thoughtsPost(asker, `${thoughtsName(room)} ↩ ${clipT(text, 240)}`);
        return { agent: thoughtsName(asker) };
      }
      const sender = agents.get(req.from);
      if (!sender) throw new Error("that agent is gone");
      sendAgent(sender, "talk.reply", { request_id: p.request_id, mode: req.mode, from: { id: me, name: thoughtsName(room) }, text, remaining: req.recipients.size - req.replies.size });
      thoughtsPost(room, `↩ answered ${displayName(sender)}: ${clipT(req.text || "", 120)}${req.text ? " → " : ""}${clipT(text, 200)}`);
      return { agent: displayName(sender) };
    },
    // Its pick for a /tinker drop-off (assign_tinker): an agent, or "new" (opened in the workshop).
    // Tidy now: one project (its writer is asked) or every active project of the world. From the
    // board's /tidy, Thoughts' tidy_projects, or a writer for its own cards.
    "board.tidy": (p, conn) => {
      const actor = boardActor(conn), room = boardRoom(p, actor);
      const ps = p.project ? [boards.must(p.project, room).project] : boards.load(room).projects.filter((x) => x.status !== "archived");
      const told = [], noWriter = [];
      for (const pr of ps) { try { archiveOldDone(roomOfProject(pr) || room, pr); } catch { /* fine */ } const w = nudgeTidy(pr, true); if (w) told.push(`@${pr.name} → ${w}`); else { noWriter.push("@" + pr.name); askForWriter(roomOfProject(pr) || room, pr, true); } }
      return { room, told, noWriter };
    },
    // Thoughts picks a project's writer (assign_writer): joined if needed, made writer, asked to tidy.
    "thoughts.writer": (p) => {
      const room = safeRoom(p.room), f = boards.must(p.project, null), pr = f.project;
      const a = liveAgent(p.agent);
      if (!pr.members.includes(a.id)) boards.join(pr.id, f.board.room, a.id, { id: "", name: thoughtsName(room), who: displayName(a) });
      boards.update(pr.id, f.board.room, { writer: a.id }, { id: "", name: thoughtsName(room) }, agentNameTaken);
      promptMember(a, `[hyprpi board · ${thoughtsName(room)} made you the owner (writer) of @${pr.name}]\nYou keep its card current and answer Angus's messages to it.\n\n` + tidyPrompt(boards.must(pr.id, f.board.room).project, staleItems(pr)));
      tidyAt.set(pr.id, Date.now());
      thoughtsPost(room, `@${pr.name}: owner is now ${displayName(a)}`);
      return { project: pr.name, writer: displayName(a) };
    },
    "thoughts.tinkerAssign": (p) => {
      const room = safeRoom(p.room), id = String(p.job || "").trim(), who = String(p.agent || "").trim().replace(/^@/, "");
      const job = tinkerQueue.find((j) => j.id === id);
      if (!job) throw new Error(tinkerGiven.has(id) ? `job ${id} was already given to ${tinkerGiven.get(id)}` : `no drop-off ${id} waiting`);
      if (job.assignTo) throw new Error(`job ${id} is already assigned`);
      if (!who) throw new Error('agent: a name, or "new"');
      if (who.toLowerCase() === thoughtsName(room).toLowerCase()) throw new Error("not yourself: pick an agent, or \"new\"");
      if (who.toLowerCase() === "new") {
        const wroom = workshopRoom() || room, size = cfg.worldSize || 10, wi = WORLD_LETTERS.indexOf(wroom);
        if (wi < 0) throw new Error(`world ${wroom} has no workspaces`);
        const used = new Set([...agents.values()].filter((a) => Number.isInteger(a.workspace) && worldOf(a.workspace, size) === wi + 1).map((a) => (a.workspace - 1) % size));
        let slot = 0; for (let s2 = 1; s2 < size; s2++) if (!used.has(s2)) { slot = s2; break; }
        const ws = wi * size + 1 + slot;
        const newId = "hp-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 5), newName = `pi·${newId.slice(-4)}`;
        const bin = new URL("../bin/hyprpi", import.meta.url).pathname, env2 = { ...process.env, ...env };
        for (const k of Object.keys(env2)) if (/^(HYPRPI_AGENT_ID|HYPRPI_WORKSPACE|HYPRPI_TWIN_OF|PI_SESSION)/.test(k)) delete env2[k];
        spawn(process.execPath, [bin, "new", "--id", newId, "--workspace", String(ws), "--no-focus", "--cwd", process.env.HOME || "/"], { detached: true, stdio: "ignore", env: env2 }).unref();
        job.assignTo = newId; job.assignedAt = Date.now(); saveTinker();
        log(`tinker: ${thoughtsName(room)} gave ${id} to a new agent, ${newName}, on workspace ${ws}`);
        return { agent: newName, new: true, workspace: wsLabel(ws, size) };
      }
      const a = liveAgent(who);
      if (a.parked) throw new Error(`${displayName(a)} is parked; pick another agent, or "new"`);
      if (!isFree(a)) throw new Error(`${displayName(a)} is ${a.status} right now; pick a free agent (idle or done), or "new"`);
      job.assignTo = a.id; job.assignedAt = Date.now();
      if (!deliverTinker(a, job, `picked by ${thoughtsName(room)}`)) { saveTinker(); return { agent: displayName(a), queued: true }; }
      return { agent: displayName(a) };
    },
    // Move a job to another card (J10): /move J8 @p in the projects panel (Angus), move_job (Thoughts).
    "brief.move": (p, conn) => {
      const actor = boardActor(conn), b = briefs.get(p.job);
      if (!b) throw new Error(`no job ${p.job || "?"} (J1, J2, …)`);
      if (!p.project) throw new Error("move it where? @project");
      if (actor.a && actor.a.id !== b.agent) throw new Error(`${b.id} is ${b.agent_name}'s job; ask ${b.from} (or Angus) to move it`);
      return moveBrief(b, p.project, { id: actor.id, name: actor.name, human: actor.human });
    },
    "thoughts.moveJob": (p) => {
      const room = safeRoom(p.room), b = briefs.get(p.job);
      if (!b) throw new Error(`no job ${p.job || "?"} (J1, J2, …)`);
      return moveBrief(b, p.project, { id: "", name: thoughtsName(room) });
    },
    "thoughts.open": (p) => {
      const room = safeRoom(p.room), name = thoughtsName(room), task = String(p.task || p.goal || "").trim();
      if (!task) throw new Error("no task");
      const size = cfg.worldSize || 10, wi = WORLD_LETTERS.indexOf(room);
      if (wi < 0) throw new Error(`world ${room} has no workspaces`);
      const used = new Set([...agents.values()].filter((a) => Number.isInteger(a.workspace) && worldOf(a.workspace, size) === wi + 1).map((a) => (a.workspace - 1) % size));
      let slot = 0; for (let s = 1; s < size; s++) if (!used.has(s)) { slot = s; break; }
      const ws = wi * size + 1 + slot;
      const ident = openIdentity(p); // before anything is created: a taken name fails cleanly
      const newId = "hp-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 5), newName = ident.name || `pi·${newId.slice(-4)}`;
      if (ident.name || ident.icon) preIdentity.set(newId, ident); // persisted until its hello (J15)
      let pr = null;
      if (p.project) { const f = boards.must(p.project, null); pr = f.project; boards.join(pr.id, f.board.room, newId, { id: "", name, who: newName }); }
      const fields = briefFields({ ...p, task });
      const b = briefs.create({ fields, project: pr?.id || "", projectName: pr?.name || "", item: "", agent: newId, agent_name: newName, from: name, room });
      const rid = thoughtsRequest(room, [newId], "demand", "", { work: { task: fields.goal, project: pr?.id || "", item: "", brief: b.id, version: 1 } });
      // J15: its line on the project's card, like give_work (J13 had none).
      if (pr) { try { const f = boards.find(pr.id); const r = boards.addItem(pr.id, f.board.room, { section: "next", text: briefCard(b) }, { id: "", name }); b.item = r?.item?.h || ""; } catch (e) { log("thoughts.open: card", e.message); } }
      b.request = rid; briefs.save();
      const looseText = pr ? "" : "\n\n(Your job is on the Loose jobs card; if it turns into a project, create one with the project tool: it moves there.)";
      welcomes.set(newId, `[${name}, from Angus: you were opened for this job]\n` + (ident.name ? `(You are named ${ident.icon ? ident.icon + " " : ""}${ident.name} for this job: that is already your hyprpi name and icon, so don't rename yourself or wait for /name.)\n` : "") + renderBrief({ ...b, project: pr?.name || "" }) + withImages("", p.images) + `${pr ? `\n\n(You are on project @${pr.name}${b.item ? `, card item ${b.item}` : ""}: read its card with board_read and keep it current.)` : ""}${looseText}\n\nReply to ${name} with talk_reply(request_id="${rid}").`);
      if (!pr) briefToCard(b); // Loose jobs (J10)
      const cwd = String(p.cwd || "").replace(/^~(?=$|\/)/, process.env.HOME || "");
      const bin = new URL("../bin/hyprpi", import.meta.url).pathname, env2 = { ...process.env, ...env };
      for (const k of Object.keys(env2)) if (/^(HYPRPI_AGENT_ID|HYPRPI_WORKSPACE|HYPRPI_TWIN_OF|PI_SESSION)/.test(k)) delete env2[k];
      // model / thinking (open_agent's options; the tool checked the model against the registry): Pi's own flags.
      const model = /^[\w.:@~\/-]{1,120}$/.test(String(p.model || "")) ? String(p.model) : "", thinking = /^(off|minimal|low|medium|high|xhigh|max)$/.test(String(p.thinking || "")) ? String(p.thinking) : "";
      const piFlags = [...(model ? ["--model", model] : []), ...(thinking ? ["--thinking", thinking] : [])];
      spawn(process.execPath, [bin, "new", "--id", newId, "--workspace", String(ws), "--no-focus", ...(ident.name ? ["--name", ident.name] : []), ...(ident.icon ? ["--icon", ident.icon] : []), "--cwd", cwd && fs.existsSync(cwd) ? cwd : (loadConfig().cwd || "~/Work").replace(/^~(?=$|\/)/, process.env.HOME || ""), ...(piFlags.length ? ["--", ...piFlags] : [])], { detached: true, stdio: "ignore", env: env2 }).unref();
      log(`thoughts ${room}: opened ${newName} on workspace ${ws}${model ? ` (${model})` : ""}`);
      thoughtsPost(room, `opened a new agent, ${ident.icon ? ident.icon + " " : ""}${newName}${pr ? ` (@${pr.name})` : ""}${model ? ` on ${model}${thinking ? "/" + thinking : ""}` : ""}: ${clipT(task, 200)}`);
      return { agent: newName, icon: ident.icon, workspace: wsLabel(ws, size), project: pr?.name || "", item: b.item || "", model, job: b.id, version: 1 };
    },
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
            boards.update(old.project.id, room, { status: "active", ...(p.icon ? { icon: p.icon } : {}) }, by, agentNameTaken);
            if (!p.icon && !old.project.icon) autoIcon(old.project.id, room, old.project.name, old.project.title);
            for (const id of members) boards.join(old.project.id, room, id, { ...by, who: nameOf(id) });
            return { ...boards.must(old.project.id, room).project, reopened: true };
          }
          const pr = boards.create(room, { name: p.name, title: p.title, icon: p.icon, members, by, status: actor.human ? "active" : "new" }, agentNameTaken);
          if (!pr.icon) autoIcon(pr.id, room, pr.name, pr.title);
          if (actor.human) for (const id of members) promptMember(agents.get(id), `[hyprpi board · Angus created @${pr.name} and assigned you${pr.writer === id ? " (you are its writer)" : ""}]\n${pr.title || ""}\n\nKeep its card current with board_update (board_read shows it). Don't start any work on it until Angus asks for some.`);
          // J10: an agent that creates a project takes its running loose jobs with it.
          const moved = [];
          if (actor.a) for (const b of briefs.all()) if (b.agent === actor.a.id && b.state === "running" && isLoose(b)) { try { moved.push(moveBrief(b, pr.id, by)); } catch (e) { log("create: move", b.id, e.message); } }
          return moved.length ? { ...pr, moved_jobs: moved.map((m) => `${m.job} → ${m.item}`) } : pr;
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
          if (p.unfiled) { // an unfiled decision (N68): no card, so the asking agent is told
            const ans = String(p.answer || "").trim();
            if (!ans) throw new Error("no answer");
            const it = (boards.load(room).unfiled || []).find((x) => x.h.toLowerCase() === String(p.h).toLowerCase());
            if (!it) throw new Error(`no unfiled decision ${p.h} in world ${room}`);
            const m = !p.typed && /^([a-z])\b[\s.):,-]*([\s\S]*)$/i.exec(ans), opt = m && it.options?.find((o) => o.key === m[1].toLowerCase());
            const resolution = opt ? `${opt.key}) ${opt.text}${m[2] ? " — " + m[2] : ""}` : ans;
            const ding = it.ding, r = boards.decideUnfiled(room, it.h, { resolution }, by);
            const raiser = agents.get(it.by?.id), told = [];
            if (raiser) {
              clearDing(raiser, `unfiled:${room}:${it.h}`); if (ding) clearDing(raiser, ding);
              if (promptMember(raiser, `[hyprpi · ${by.name} decided your question (unfiled ${it.h}, world ${room}: it had no project card)]\n${it.text}\n→ ${resolution}\n\nAct on it. If it becomes work on a project, put it on that card (board_update).`)) told.push(displayName(raiser));
            }
            return { ...r, told };
          }
          const f = memberOnly(actor, p.project, room);
          const it = f.project.items.find((x) => x.h.toLowerCase() === String(p.h).toLowerCase());
          if (!it) throw new Error(`no item ${p.h} on @${f.project.name}`);
          const ans = String(p.answer || "").trim();
          if (!ans) throw new Error("no answer");
          // typed: Angus's own words (the Decisions view), never read as an option letter.
          const m = !p.typed && /^([a-z])\b[\s.):,-]*([\s\S]*)$/i.exec(ans), opt = m && it.options?.find((o) => o.key === m[1].toLowerCase());
          const resolution = opt ? `${opt.key}) ${opt.text}${m[2] ? " — " + m[2] : ""}` : ans;
          if (it.sec !== "decide") throw new Error(`${it.h} is not an open decision`);
          const question = it.text, ding = it.ding;
          // The Decide item becomes a Next item holding the answer (N68), same handle.
          const r = boards.decideItem(f.project.id, room, it.h, { resolution }, by);
          const raiser = agents.get(it.by?.id);
          if (raiser) { clearDing(raiser, `${f.project.id}:${it.h}`); if (ding) clearDing(raiser, ding); }
          const told = [];
          for (const a of new Set([raiser, agents.get(f.project.writer)].filter(Boolean))) {
            if (promptMember(a, `[hyprpi board · ${by.name} decided @${f.project.name} ${it.h}]\n${question}\n→ ${resolution}\n\n${it.h} is now a Next item on @${f.project.name} holding this answer. Act on it, mark it done when finished (board_update), and tell other members via talk if it affects them.`)) told.push(displayName(a));
          }
          return { ...r, told };
        }
        case "restore": { memberOnly(actor, p.project, room); return boards.restoreItem(p.project, room, p.h, by); }
        case "archive": case "unarchive": {
          memberOnly(actor, p.project, room);
          const r = boards.archiveItems(p.project, room, p.h, p.action === "archive", by);
          if (p.action === "archive") for (const it of r.items) if (it.sec === "decide") { const raiser = agents.get(it.by?.id); if (raiser) clearDing(raiser, `${r.project.id}:${it.h}`); }
          return { project: r.project, item: r.items[0], items: r.items };
        }
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
            ? `You own this project (its writer): YOU answer. Coordinate: ask the other members for what they know (talk) if you need it, then answer in the room (room_post) and update the card (board_update). No other member will post. ` +
              // J54 (Angus): a deliverable gets a brief first; the user-turn text must say so (it outweighs the system prompt).
              `If this asks for a deliverable (something to build, fix or change, not just an answer), DON'T build it yet: send ${thoughtsName(room)} one line with talk ("@${pr.name} got from Angus: '<his words verbatim>'; I'd <your plan in a few words>; brief it?"), tell Angus in the room in one line that you've asked for a brief, and wait for the brief (usually given back to you). Questions, card tidying and small card edits you just answer or do.`
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
      const toThoughts = []; // "Thoughts-C": a world's Thoughts agent (Angus: any agent may talk to it)
      if (!(names.length === 1 && names[0].toLowerCase() === "all")) for (const n of names) {
        const m = /^@?thoughts-([A-Za-z0-9_-]+)$/i.exec(n.trim());
        if (m) toThoughts.push(safeRoom(m[1].toUpperCase()));
      }
      if (toThoughts.length) for (let i = names.length - 1; i >= 0; i--) if (/^@?thoughts-/i.test(names[i].trim())) names.splice(i, 1);
      if (!(names.length === 1 && names[0].toLowerCase() === "all")) for (const n of names) {
        const { agent, error } = findAgent(n, { exclude: from.id });
        if (error || agent.id === from.id) skipped.push({ name: n, reason: error || "that is you" });
        else if (!targets.includes(agent)) targets.push(agent);
      }
      const request_id = randomUUID();
      const req = { from: from.id, mode, recipients: new Set(), replies: new Map() };
      const delivered = [];
      for (const t of targets) {
        if (talkOut(req, t, { request_id, mode, text, from: { id: from.id, name: displayName(from) }, expires_in: Number(p.timeout_seconds) || (mode === "demand" ? 120 : 1800) })) {
          req.recipients.add(t.id); delivered.push(displayName(t));
        } else skipped.push({ name: displayName(t), reason: "not connected" });
      }
      for (const room of [...new Set(toThoughts)]) {
        req.recipients.add("thoughts:" + room); req.text = text; delivered.push(thoughtsName(room));
        thoughts.fromAgent(room, { from: displayName(from), request_id, mode, text });
      }
      if (delivered.length) recordActivity(from, mode, `${mode === "demand" ? "asks" : "to"} ${delivered.join(", ")}: ${text}`, { to: delivered });
      if (req.recipients.size) {
        keepRequest(request_id, req); // 12 h, whatever the demand's own wait (a late reply still arrives)
      }
      return { request_id, delivered, skipped };
    },

    "talk.reply": (p, conn) => {
      const req = requests.get(String(p.request_id || ""));
      const a = agents.get(conn.agentId);
      if (!req || !a) throw new Error("unknown or expired request_id");
      if (req.thoughts) { // an answer for a world's Thoughts agent
        if (!req.recipients.has(a.id)) throw new Error("that request was not sent to you");
        const text = String(p.text ?? "");
        if (!text.trim() || Buffer.byteLength(text) > 32768) throw new Error("reply must be 1..32768 bytes");
        req.replies.set(a.id, text); saveRequests();
        let lead = "";
        if (req.brief) { // a report on a brief: it must answer every done-when line, for this version
          const b = briefs.get(req.brief);
          if (b && req.version !== b.version) lead = `[report on ${b.id} v${req.version}, which v${b.version} has replaced: not counted]\n`;
          else if (b && b.state === "running") {
            const c = checkReport(b, text);
            if (c.ok) { briefs.setState(b.id, "done", { report: text.slice(0, 8000) }); briefToCard(b); const n = b.fields.done_when.length; lead = `[brief ${b.id} v${b.version}: done ✓ (its report answers ${n > 1 ? "W1–W" + n : n ? "W1" : "the job"}); verified once Angus or a second agent confirms (verify_work)]\n`; }
            else lead = `[brief ${b.id} v${b.version}: NOT done: the report doesn't answer ${c.missing.join(", ")}. Ask ${displayName(a)} for those (or revise_work).]\n`;
          }
        }
        thoughtsPost(req.thoughts, `${displayName(a)} ↩ ${clipT(text, 240)}`);
        thoughts.reply(req.thoughts, displayName(a), lead + text);
        return { delivered: true };
      }
      if (!req.recipients.has(a.id)) throw new Error("that request was not sent to you");
      if (req.replies.has(a.id)) throw new Error("you already replied to this request");
      const text = String(p.text ?? "");
      if (!text.trim() || Buffer.byteLength(text) > 32768) throw new Error("reply must be 1..32768 bytes");
      req.replies.set(a.id, text); saveRequests();
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
      if (since) for (const s of sources) if (!s.archived) s.entries = s.entries.filter((e) => e.ts >= since); // J119: archived threads are older by nature; relevance picks from them
      const t0 = Date.now();
      const r = await askRoom(question, sources, { model: cfg.askModel || cfg.searchModel || "claude-haiku-4-5", pi: cfg.pi, maxCite: p.maxCite });
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
          return { eid: String(i), role: "activity", ts: e.ts, text: `${e.kind === "tool" ? "" : e.kind === "turn" ? "did: " : e.kind + ": "}${e.text}`,
            agent: { id: e.agent.id, name: live ? displayName(live) : (e.agent.name || "?"), icon: live?.icon || e.agent.icon || "", color: live?.color || e.agent.color || "", live: !!live } };
        }) };
        const { results, scanned, answer, activityChars, named } = await aiSearch(query, [...sources, actSource], {
          model: c.searchModel, pi: c.pi, budget: Number(c.aiSearchChars) || 110000, activityShare: c.aiSearchActivityShare ?? 0.2,
        });
        if (!p.from_thoughts && answer) { const l = (asks[room] ||= []); l.push({ ts: Date.now(), q: query, a: answer }); if (l.length > 20) l.shift(); }
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

    shutdown: () => { frozen = true; setTimeout(quit, 50); return { ok: true }; },
  };

  // J126: the daemon restarts itself once everyone is idle (lib/restartq.mjs), so no agent polls for it.
  const restartq = createRestartQueue({
    stateDir: STATE, log,
    liveAgents: () => [...agents.values()].filter((a) => a.conn).map((a) => ({ id: a.id, name: displayName(a), status: a.status })),
    thoughtsBusy: () => knownRooms().filter((r) => thoughts.busy(r.id)).map((r) => thoughtsName(r.id)),
    // J87 /restart and J125 refreshes (same restarts map): waiting = still asked, not yet reopening.
    // Knock's D1: an entry whose agent went away while still asked (closed, crashed) doesn't hold the restart,
    // and none counts for more than 30 min (J125's upkeep entries have no cleanup of their own).
    agentRestartsPending: () => [...restarts].filter(([id, r]) => !(r.pending && !agents.get(id)?.conn) && !(r.at && Date.now() - r.at > 1800000)).map(([id, r]) => { const a = agents.get(id) || registry[id] || { id }; return { id, name: displayName(a), room: a.room, by: r.by, at: r.at, waiting: !!r.pending }; }),
    note: (room, text) => { try { thoughts.note(room, text); } catch { /* no thread */ } },
    defaultRoom: () => roomForWorkspace(activeWs) || "A",
    shutdown: () => { frozen = true; setTimeout(quit, 50); },
    ensureCmd: `${JSON.stringify(process.execPath)} ${JSON.stringify(new URL("../bin/hyprpi", import.meta.url).pathname)} ensure`,
    quietMs: Number(process.env.HYPRPI_RESTARTQ_QUIET_MS) || 20000,
    watchMs: Number(process.env.HYPRPI_RESTARTQ_WATCH_MS) || 15 * 60000,
  });
  const restartqTimer = setInterval(() => { try { restartq.tick(); } catch (e) { log("restart queue:", e.message); } }, Number(process.env.HYPRPI_RESTARTQ_TICK_MS) || 10000);
  Object.assign(methods, {
    "daemon.restartRequest": (p, conn) => {
      // The asking agent (its own connection, or the CLI run from its window: HYPRPI_AGENT_ID) isn't waited for.
      const me = agents.get(conn.agentId || String(p.agentId || "")) || null;
      return restartq.request({ by: String(p.by || (me ? displayName(me) : "Angus")), byId: me?.id || "", room: me?.room || p.room || "", reason: p.reason, ttlMin: p.ttlMin });
    },
    "daemon.restartStatus": () => restartq.status(),
    "daemon.restartCancel": (p, conn) => { const id = conn.agentId || String(p.agentId || ""); return restartq.cancel({ by: id ? displayName(agents.get(id) || { id }) : "Angus" }); },
  });

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
        const drop = () => { if (!a.conn && agents.get(a.id) === a) { recordActivity(a, "left", "left"); agents.delete(a.id); remember(a); pushAgents(); agentGone(a); } };
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

  // On the way out (SIGTERM / SIGINT / SIGHUP / hyprpi stop): save what is open, then freeze it,
  // so the windows the shutdown closes after this don't count as closed (restore-all, J8).
  const quit = () => { frozen = true; savePanelsNow("exit"); writeRequests(); thoughts.stopAll(); clearInterval(poll); clearInterval(tinkerTimer); clearInterval(careTimer); clearInterval(compactTimer); clearInterval(restartqTimer); clearInterval(beatTimer); beat(); saveRegistryNow(); stopEvents(); server.close(); try { fs.unlinkSync(SOCK); } catch {} process.exit(0); };
  process.on("SIGTERM", quit);
  process.on("SIGINT", quit);
  process.on("SIGHUP", quit);
}

function debounce(fn, ms) {
  let t = null;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}
function safeReaddir(d) { try { return fs.readdirSync(d); } catch { return []; } }
