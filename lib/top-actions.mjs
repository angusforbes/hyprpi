// J564 (Angus: "a version of hyprpi top to also be a TUI so i can navigate it and kill highlighted agents"): the actions behind
// `hyprpi top`'s keys. Nothing here runs without the TUI's explicit confirm; nothing ever matches processes by name: every
// signal goes to a pid that was in the confirmed row AND still has the same start time (a reused pid is never touched).
import fs from "node:fs";
import * as hypr from "./hypr.mjs";

// /proc/<pid>/stat start time (clock ticks since boot), or null when the process is gone or unreadable.
export function startTicks(pid, procRoot = "/proc") {
  try {
    const t = fs.readFileSync(`${procRoot}/${pid}/stat`, "latin1"), rest = t.slice(t.lastIndexOf(")") + 2).split(" ");
    const v = Number(rest[19]); return Number.isFinite(v) ? v : null;
  } catch { return null; }
}

const n = (x) => (typeof x === "number" && Number.isFinite(x) ? x : 0);
// What closing this row means, and what to warn about. -> { ok, kind, label, warnings[], why? }
export function closePlan(a) {
  if (!a) return { ok: false, why: "no row selected" };
  const label = `${a.name || a.id}${a.world ? ` (world ${a.world === "Unattributed" ? "-" : a.world})` : ""}`;
  if (a.world === "Unattributed" || String(a.id).startsWith("unattributed:")) {
    const pids = Object.keys(a.pidStarts || {}).length;
    if (!pids) return { ok: false, label, why: "its processes are already gone" };
    return { ok: true, kind: "tree", label: `${a.tool || "pi"} ${a.name || a.id}${a.cwd ? ` in ${a.cwd}` : ""}`, warnings: [`${pids} process${pids === 1 ? "" : "es"} get SIGTERM (exact pids)`] };
  }
  if (a.kind === "thoughts") return { ok: false, label, why: `${a.name} is a world's Thoughts agent: the daemon runs it; top doesn't close it (it restarts on the next message anyway)` };
  if (a.kind === "sandbox") return { ok: false, label, why: `${a.name} is a sandboxed world's process (world ${a.world}): close it from that world (docker/world/world.sh), not from top` };
  if (a.remote) return { ok: false, label, why: `${a.name} runs on world ${a.world}'s remote machine: top can't close it; use omnistation/world ${a.world} stop NAME there` };
  if (a.kind !== "agent") return { ok: false, label, why: `can't close a ${a.kind || "?"} row` };
  const c = a.priorityDetails?.components || {}, warnings = [];
  const jobs = n(c.jobs?.value), projects = n(c.projects?.value), helpers = (a.registeredHelpers || []).length || n(a.helpers);
  if (jobs) warnings.push(`${jobs} running brief${jobs === 1 ? "" : "s"}`);
  if (projects) warnings.push(`owns ${projects} project${projects === 1 ? "" : "s"}`);
  if (helpers) warnings.push(`${helpers} live helper${helpers === 1 ? "" : "s"}`);
  if (a.status === "working") warnings.push("it's working right now");
  return { ok: true, kind: "agent", label, warnings };
}

// The confirmed target: exact (pid, start time) pairs taken from the row at the moment of the confirm.
export function targetOf(a) {
  return { id: a.id, kind: a.kind, name: a.name, rootPids: (a.rootPids || []).map(Number), pidStarts: { ...(a.pidStarts || {}) } };
}

// SIGTERM (or SIGKILL) to exactly the confirmed pids that still have their confirmed start time. -> { signalled: [pids], skipped }
export function endTree(target, signal = "SIGTERM", { procRoot = "/proc", kill = process.kill.bind(process) } = {}) {
  const signalled = [], skipped = [];
  for (const [p, st] of Object.entries(target.pidStarts || {})) {
    const pid = Number(p);
    if (!Number.isInteger(pid) || pid <= 1 || pid === process.pid) { skipped.push(pid); continue; }
    if (startTicks(pid, procRoot) !== Number(st)) { skipped.push(pid); continue; } // gone, or the pid now belongs to another process
    try { kill(pid, signal); signalled.push(pid); } catch { skipped.push(pid); }
  }
  return { signalled, skipped };
}
export const aliveOf = (target, procRoot = "/proc") => Object.entries(target.pidStarts || {}).filter(([p, st]) => startTicks(Number(p), procRoot) === Number(st)).map(([p]) => Number(p));

// Close a hyprpi agent the way a person would: its window closed (Hyprland), so the daemon records a deliberate close; with no
// window, SIGTERM to its own pi (exact pid + start time). Then wait until the daemon no longer lists it. -> { ok, how, why? }
export async function closeAgent(target, { request, timeoutMs = 20000, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), clients = hypr.clients, closeWindow = hypr.closeWindow } = {}) {
  const listed = async () => ((await request("list", {}).catch(() => null))?.agents || []).some((x) => x.id === target.id);
  if (!(await listed())) return { ok: true, how: "already gone" };
  const root = target.rootPids.find((p) => target.pidStarts[p] != null && startTicks(p) === Number(target.pidStarts[p]));
  if (!root) return { ok: false, why: "its process isn't the one you confirmed any more (gone or reused); nothing done" };
  let how = "";
  const win = hypr.hyprBlocked() ? null : hypr.windowForPid(root, await clients().catch(() => []));
  if (win?.address) { await closeWindow(win.address); how = `closed its window ${win.address}`; }
  else { try { process.kill(root, "SIGTERM"); how = `SIGTERM to its pi (pid ${root})`; } catch (e) { return { ok: false, why: `couldn't signal pid ${root}: ${e.code || e.message}` }; } }
  for (const t = Date.now(); Date.now() - t < timeoutMs;) { await sleep(500); if (!(await listed())) return { ok: true, how }; }
  return { ok: false, how, why: `still listed by the daemon after ${Math.round(timeoutMs / 1000)} s` };
}

// Enter: the row's window. A hyprpi agent through the daemon (it knows remote and sandboxed worlds too); another CLI through
// its terminal's window. -> { ok, why? }
export async function focusRow(a, { request, clients = hypr.clients, focusWindow = hypr.focusWindow } = {}) {
  if (!a) return { ok: false, why: "no row" };
  if (a.kind === "agent" || a.kind === "thoughts") {
    if (a.kind === "thoughts") return { ok: false, why: "a Thoughts agent has no window of its own (its panel is the search panel)" };
    try { await request("agent.focus", { agent: a.id }); return { ok: true }; } catch (e) { return { ok: false, why: e.message }; }
  }
  if (hypr.hyprBlocked()) return { ok: false, why: "hypr actions disabled here" };
  const list = await clients().catch(() => []);
  for (const p of [a.terminalPid, a.rootPid, ...(a.rootPids || [])].filter(Boolean)) {
    const w = hypr.windowForPid(Number(p), list);
    if (w?.address) { await focusWindow(w.address); return { ok: true }; }
  }
  return { ok: false, why: "no window found for it (a tmux or headless session?)" };
}
