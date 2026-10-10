// J393 (Angus "5a"): the relay never launches apps. An approved "open a link or file for Angus" is HANDED to the world's
// existing link opener (docker/world/g_open_url.py --agent: the gate behind agent-opened links in G, J320/J335, with its own
// checks: shared folders only, https/file only, G's own Brave profile). The handoff goes through the user's systemd manager
// (a transient service), so the gate and any browser it starts are children of systemd in their own unit, never of the relay
// (and not bound by the relay unit's TasksMax/MemoryMax, which crashed G's Brave in J368). KillMode=process: when the gate
// exits, the browser it started keeps running.
//
//   handToOpener(url, world, opts) → Promise<{ ok, text }>   ok = the gate accepted and started (or reused) the world's browser
//   and the browser was running `settleMs` later; text says what was observed. No user bus → refused (never launched here).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const GATE = path.join(HERE, "..", "world", "g_open_url.py");

// The world's own Brave (the profile g_open_url.py --agent uses) is running?
export function worldBrowserAlive(world, stateRoot = process.env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state")) {
  const prof = path.join(stateRoot, "hyprpi", "worlds", world, "brave");
  const pids = String(spawnSync("pgrep", ["-f", "--", `user-data-dir=${prof}`], { encoding: "utf8" }).stdout || "").split("\n").filter(Boolean);
  return pids.some((pid) => { try { return fs.readFileSync(`/proc/${pid}/comm`, "utf8").trim() === "brave"; } catch { return false; } });
}

export async function handToOpener(url, world, { gate = GATE, settleMs = 5000, systemdRun = "systemd-run", checkBrowser = true, env = {} } = {}) {
  const unit = `hyprpi-open-${world}-${crypto.randomBytes(4).toString("hex")}`;
  const setenv = Object.entries(env).map(([k, v]) => `--setenv=${k}=${v}`);
  const r = spawnSync(systemdRun, ["--user", "--wait", "--pipe", "--collect", "--quiet", "--property=KillMode=process", `--unit=${unit}`, ...setenv, "python3", gate, "--agent", url, world], { encoding: "utf8", timeout: 30000 });
  const said = String(r.stderr || r.stdout || "").trim().split("\n").filter((l) => !/^Running as unit/.test(l)).join(" ").slice(-300);
  if (r.error || /Failed to (connect|start|create)/i.test(said)) return { ok: false, text: `couldn't hand it to the world's link opener (${r.error?.code || said || "systemd-run failed"}); nothing was opened` };
  if (r.status !== 0) return { ok: false, text: said.replace(/^g_open_url: refused: /, "") || "the link opener refused it" };
  if (!checkBrowser) return { ok: true, text: "handed to the world's link opener" };
  const t0 = Date.now();
  await new Promise((res) => setTimeout(res, settleMs));
  const secs = ((Date.now() - t0) / 1000).toFixed(0);
  return worldBrowserAlive(world) ? { ok: true, text: `the link opener accepted it; the world's browser was running ${secs} s later` }
    : { ok: false, text: `the link opener accepted it, but the world's browser wasn't running ${secs} s later (it may have crashed)` };
}
