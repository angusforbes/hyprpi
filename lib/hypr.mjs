// Thin Hyprland helpers: hyprctl JSON queries, Lua dispatches, socket2 events.
import { execFile } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";

export function hyprctl(args, { env = process.env, timeout = 5000 } = {}) {
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
