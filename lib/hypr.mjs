// Thin Hyprland helpers: hyprctl JSON queries, Lua dispatches, socket2 events.
import { execFile } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { isolatedReason } from "./paths.mjs";

// J333: an isolated hyprpi process (test socket/state, HYPRPI_TEST; see paths.mjs isolatedReason) may
// READ Hyprland but never change it: every hyprctl call that isn't one of these queries is refused
// (resolves "" without running), so no window is placed, moved, focused, closed or opened.
const QUERIES = new Set(["clients", "activewindow", "activeworkspace", "workspaces", "monitors", "cursorpos", "layers",
  "devices", "version", "binds", "getoption", "submap", "instances", "splash", "globalshortcuts", "rollinglog",
  "configerrors", "systeminfo", "decorations", "animations", "layouts", "workspacerules", "getprop"]);
let warned = false;
export function hyprBlocked(env = process.env) {
  return isolatedReason(process.env) || (env !== process.env ? isolatedReason(env) : "");
}

export function hyprctl(args, { env = process.env, timeout = 5000 } = {}) {
  const verb = args.find((a) => !String(a).startsWith("-"));
  if (!QUERIES.has(verb)) {
    const why = hyprBlocked(env);
    if (why) {
      if (!warned) { warned = true; process.stderr.write(`hyprpi: hypr actions disabled (isolated daemon: ${why}); HYPRPI_ALLOW_HYPR=1 allows them\n`); }
      return Promise.resolve("");
    }
  }
  return new Promise((resolve, reject) => {
    execFile("hyprctl", args, { env, timeout, maxBuffer: 8 << 20 }, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr?.trim() || err.message));
      else resolve(stdout);
    });
  });
}

export async function hyprJson(what, opts) {
  const out = await hyprctl(["-j", what], opts);
  return JSON.parse(out);
}

export const clients = (opts) => hyprJson("clients", opts);
export const activeWorkspace = (opts) => hyprJson("activeworkspace", opts);
export const activeWindow = (opts) => hyprJson("activewindow", opts);

const q = (s) => JSON.stringify(String(s));

// Hyprland 0.56+ with Lua config: dispatch takes Lua.
export const dispatch = (lua, opts) => hyprctl(["dispatch", lua], opts);
export const focusWindow = (address, opts) => dispatch(`hl.dsp.focus({ window = ${q("address:" + address)} })`, opts);
export const moveWindow = (address, workspace, opts) =>
  dispatch(`hl.dsp.window.move({ window = ${q("address:" + address)}, workspace = ${q(workspace)}, follow = false })`, opts);
export const cursorPos = (opts) => hyprJson("cursorpos", opts);
export const moveCursor = (x, y, opts) => dispatch(`hl.dsp.cursor.move({ x = ${Math.round(x)}, y = ${Math.round(y)} })`, opts);
// Out of fullscreen AND maximized (fullscreen_state 0/0 sets it, where fullscreen() toggles).
export const unfullscreen = (address, opts) =>
  dispatch(`hl.dsp.window.fullscreen_state({ internal = 0, client = 0, window = ${q("address:" + address)} })`, opts);
// Calling a panel means you want to see it (Angus): drop the given windows and any other
// fullscreen / maximized window on workspace `ws` back into the normal layout. -> addresses changed.
export async function clearFullscreen(ws, addresses = [], opts) {
  const list = await clients(opts).catch(() => []);
  const hit = list.filter((c) => (c.fullscreen || c.fullscreenClient) && (addresses.includes(c.address) || c.workspace?.id === ws));
  for (const c of hit) await unfullscreen(c.address, opts).catch(() => {});
  return hit.map((c) => c.address);
}
export const closeWindow = (address, opts) => dispatch(`hl.dsp.window.close({ window = ${q("address:" + address)} })`, opts);

// Parent pid from /proc, for mapping a pi process to its terminal window.
export function ppid(pid) {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    const rest = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    return Number(rest[1]);
  } catch { return 0; }
}

export function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; }
}

// Walk up from pid until a pid owns a window. Returns the client or null.
export function windowForPid(pid, clientList) {
  const byPid = new Map(clientList.map((c) => [c.pid, c]));
  for (let p = pid, hops = 0; p > 1 && hops < 12; p = ppid(p), hops++) {
    if (byPid.has(p)) return byPid.get(p);
  }
  return null;
}

// Child pids of pid (children of every thread), from /proc.
export function childPids(pid) {
  const out = [];
  let tasks = [];
  try { tasks = fs.readdirSync(`/proc/${pid}/task`); } catch { return out; }
  for (const t of tasks) {
    try {
      for (const c of fs.readFileSync(`/proc/${pid}/task/${t}/children`, "utf8").trim().split(/\s+/)) if (c) out.push(Number(c));
    } catch { /* thread gone */ }
  }
  return out;
}

// Does this process carry HYPRPI_AGENT_ID=<id> in its environment?
export function pidHasAgentId(pid, id) {
  if (!pid || pid <= 1 || !id) return false;
  try { return fs.readFileSync(`/proc/${pid}/environ`, "utf8").split("\0").includes("HYPRPI_AGENT_ID=" + id); } catch { return false; }
}

// Fallback when windowForPid finds nothing: Pi inside a container reports a pid from its own
// namespace, and its host process hangs off containerd-shim, not the terminal. Search DOWN from
// each agent window (its process and a few levels of descendants) for a process whose environment
// carries HYPRPI_AGENT_ID=<id> (the launcher exports it to the `docker` client).
// Returns { client, pid } (pid = the deepest match, e.g. the docker client) or null.
export function windowForAgentId(id, clientList, { cls = "hyprpi.agent", depth = 4 } = {}) {
  // A sandboxed hyprpi world (J262): its host-side helper names each window's agent directly (the agent's
  // processes live in the sandbox, out of reach of /proc here). Real Hyprland never sets this field.
  for (const c of clientList) if (c.class === cls && c.hyprpiAgent && c.hyprpiAgent === id) return { client: c, pid: 0 };
  for (const c of clientList) {
    if (c.class !== cls || !c.pid) continue;
    let hit = 0, level = [c.pid];
    for (let d = 0; d <= depth && level.length; d++) {
      for (const p of level) if (pidHasAgentId(p, id)) hit = p;
      level = level.flatMap(childPids);
    }
    if (hit) return { client: c, pid: hit };
  }
  return null;
}

// Subscribe to Hyprland's event socket; calls onEvent(name, data). Reconnects.
export function subscribe(onEvent, env = process.env) {
  const his = env.HYPRLAND_INSTANCE_SIGNATURE;
  const dir = path.join(env.XDG_RUNTIME_DIR || "/tmp", "hypr", his || "");
  const sock = path.join(dir, ".socket2.sock");
  let stopped = false, conn = null;
  const connect = () => {
    if (stopped) return;
    conn = net.createConnection(sock);
    let buf = "";
    conn.on("data", (d) => {
      buf += d.toString();
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        const j = line.indexOf(">>");
        if (j > 0) onEvent(line.slice(0, j), line.slice(j + 2));
      }
    });
    conn.on("error", () => {});
    conn.on("close", () => { if (!stopped) setTimeout(connect, 2000); });
  };
  connect();
  return () => { stopped = true; conn?.destroy(); };
}
