// sandbox-gate.mjs: no host agent opens on a sandboxed world's workspace (J403 v2, Angus: "looks like agents created
// via SUPER+A in world G are still not sandboxed agents").
//
// Every way of opening a pi agent ends in `hyprpi new` (SUPER+A, the agents panel's ^N, `hyprpi new` typed in a
// terminal, the daemon's open_agent / tinker "new" / resume / restore, twins). bin/hyprpi's cmdNew asks gate() once it
// knows the target workspace:
//   - not a sandboxed world's workspace → null (open on the host as before);
//   - a plain new agent there → it opens INSIDE the sandbox: `sbx exec <sandbox> … hyprpi new --workspace N` (the inner
//     daemon asks world-helper for the window, so it is a hyprpi.<letter>-agent window with a 🐳 title), with a toast;
//   - a host agent's resume (--id), a twin of a host agent (--twin-of) or --beside a host agent there → refused with a
//     toast: they ARE host agents (their session and context live on the host) and can't move into the sandbox.
// Inside a sandbox (HYPRPI_SANDBOX_WORLD set) the gate is off: that `hyprpi new` is already the inner one.
import fs from "node:fs";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HOME = process.env.HOME || "";
const CFG = path.join(process.env.XDG_CONFIG_HOME || path.join(HOME, ".config"), "hyprpi", "worlds");
const H = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// The sandboxed world whose workspace range holds ws: { world, sandbox, letter, lo, hi } or null.
export function sandboxedWorldFor(ws, dir = CFG) {
  if (!Number.isInteger(ws) || ws <= 0) return null;
  let names = [];
  try { names = fs.readdirSync(dir).filter((f) => /^[a-z0-9-]{1,32}\.json$/.test(f)); } catch { return null; }
  for (const f of names) {
    try {
      const c = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
      const [lo, hi] = Array.isArray(c.workspaces) ? c.workspaces : [];
      if (!Number.isInteger(lo) || !Number.isInteger(hi) || ws < lo || ws > hi) continue;
      const world = f.slice(0, -5), sandbox = typeof c.sandbox === "string" && /^[a-z0-9-]{1,32}$/.test(c.sandbox) ? c.sandbox : world;
      return { world, sandbox, letter: world.replace(/^world-/, "").slice(0, 1).toUpperCase(), lo, hi };
    } catch { /* a broken config is no sandbox */ }
  }
  return null;
}

function toast(title, body, urgency = "normal") {
  try { spawn("notify-send", ["-a", "hyprpi", "-u", urgency, title, body], { stdio: "ignore", detached: true }).unref(); } catch { /* no notifier */ }
}

// opts: { workspace, wantId, twinOf, beside, dryRun } → null (not gated) or { action: "sandbox"|"refuse", text, argv? }
export function gate({ workspace, wantId = "", twinOf = "", beside = "", noFocus = false, silent = false, env = process.env, dir = CFG } = {}) {
  if (env.HYPRPI_SANDBOX_WORLD) return null;               // already inside a sandbox
  const w = sandboxedWorldFor(Number(workspace), dir);
  if (!w) return null;
  if (wantId || twinOf || beside) {
    const what = wantId ? `host agent ${wantId}` : twinOf ? `a twin of host agent ${twinOf}` : `an agent beside ${beside}`;
    return { action: "refuse", world: w, text: `Not opened: ${what} would sit on world ${w.letter}'s workspace ${workspace}, which is sandboxed. Host agents stay in host worlds; open a new agent there with SUPER+A to get a sandboxed one.` };
  }
  const inner = `. ${H}/docker/world/g-env.sh; cd "$G_WORLD_DIR" 2>/dev/null; exec hyprpi new --workspace ${Number(workspace)}${silent ? " --silent" : ""}${noFocus || silent ? " --no-focus" : ""}`; // the caller's focus choice holds inside too (J403Test)
  return { action: "sandbox", world: w, argv: ["exec", w.sandbox, "sh", "-c", inner],
    text: `Opening a 🐳 sandboxed agent in world ${w.letter} (workspace ${workspace}). It runs inside the ${w.sandbox} sandbox.` };
}

// Carry a gate() decision out; returns the exit code for cmdNew.
export function carryOut(g) {
  if (g.action === "refuse") { toast(`World ${g.world.letter}: no host agent here`, g.text, "normal"); console.error(`hyprpi new: ${g.text}`); return 3; }
  toast(`World ${g.world.letter}: sandboxed agent`, g.text, "low");
  try { execFileSync(path.join(H, "docker", "sbx-daemon.sh"), ["ensure"], { stdio: "ignore", timeout: 45000 }); } catch { /* sbx starts it itself */ }
  try {
    const running = execFileSync("sbx", ["ls"], { encoding: "utf8", timeout: 20000 }).split("\n").some((l) => { const f = l.trim().split(/\s+/); return f[0] === g.world.sandbox && f[3] === "running"; });
    if (!running) {
      const t = `World ${g.world.letter}'s sandbox (${g.world.sandbox}) isn't running, so no agent was opened. Start it with: ${H}/docker/world/world.sh start ${g.world.world}`;
      toast(`World ${g.world.letter}: not running`, t, "normal"); console.error(`hyprpi new: ${t}`); return 3;
    }
    execFileSync("sbx", g.argv, { stdio: ["ignore", "ignore", "pipe"], timeout: 60000 });
    console.error(`hyprpi new: ${g.text}`);
    return 0;
  } catch (e) {
    const t = `The sandboxed agent didn't open: ${String(e.stderr || e.message || e).trim().split("\n").pop().slice(0, 200)}`;
    toast(`World ${g.world.letter}: no agent opened`, t, "normal"); console.error(`hyprpi new: ${t}`); return 3;
  }
}
