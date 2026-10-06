// J126 (Angus: "i am worried about the deadlock we had between blink and summoner … how do we avoid
// things like that"): the daemon restarts ITSELF once everyone is idle, so no agent ever polls for
// "all idle" (two pollers counted each other as busy and neither restarted, 10/5 23:4x).
//
// - request({by, reason, ttlMin}) files the restart and returns at once; one pending restart, later
//   requests merge into it (reasons list; it expires at the latest expiry). Requesters don't count as
//   busy: their turn ends, they don't wait.
// - tick() (every 10 s): when no live agent is working (requesters excluded), no Thoughts is busy and no
//   J87 agent restart / J116 fresh session is in progress, for quietMs in a row → restart: a detached
//   shell waits for this daemon's pid to exit and runs `hyprpi ensure`; then the normal shutdown.
// - An expired request is dropped with a note. The watchdog: anything waiting for idle longer than
//   watchMs (the pending restart, a J87 agent restart queued while it works) → one line to the world's
//   Thoughts, once per wait, naming who it waits on.
// STATE/restart-request.json keeps a pending request across a daemon crash; a daemon that starts clears
// it (a restart happened) and logs who asked for it.
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

export function createRestartQueue({ stateDir, log = () => {}, liveAgents, thoughtsBusy, agentRestartsPending,
  note = () => {}, defaultRoom = () => "A", shutdown, ensureCmd, now = Date.now, quietMs = 20000, watchMs = 15 * 60000, defaultTtlMin = () => 120 }) {
  // J125 v2: quietMs / watchMs may be functions (read from ~/.config/hyprpi/hyprpi.jsonc "restarts" each time).
  const qMs = () => Number(typeof quietMs === "function" ? quietMs() : quietMs) || 20000;
  const wMs = () => Number(typeof watchMs === "function" ? watchMs() : watchMs) || 15 * 60000;
  const FILE = path.join(stateDir, "restart-request.json");
  let pending = null; // { reasons: [{by, byId, reason, at}], since, expires, warned }
  let quietSince = 0, restarting = false;
  const ago = (ms) => ms < 90000 ? `${Math.round(ms / 1000)} s` : `${Math.round(ms / 60000)} min`;
  const room0 = () => pending?.reasons.find((r) => r.room)?.room || defaultRoom();
  const warnedWaits = new Map(); // key -> since (one note per wait)

  { // A daemon that starts has restarted: a leftover request is fulfilled.
    try {
      const old = JSON.parse(fs.readFileSync(FILE, "utf8"));
      if (old?.reasons?.length) log(`restart queue: started after the restart asked by ${old.reasons.map((r) => `${r.by} (${r.reason})`).join(", ")}`);
    } catch { /* none */ }
    try { fs.unlinkSync(FILE); } catch { /* none */ }
  }
  const save = () => {
    try { if (pending) fs.writeFileSync(FILE, JSON.stringify(pending)); else fs.unlinkSync(FILE); } catch { /* best effort */ }
  };
  const view = () => pending && { reasons: pending.reasons, since: pending.since, expires: pending.expires, waiting_on: busyList(), restarting };

  function busyList() {
    const ids = new Set(pending ? pending.reasons.map((r) => r.byId).filter(Boolean) : []);
    const out = [];
    for (const a of liveAgents()) if (a.status === "working" && !ids.has(a.id)) out.push(a.name);
    for (const t of thoughtsBusy()) out.push(t);
    for (const r of agentRestartsPending()) out.push(`${r.name} (agent restart)`);
    return out;
  }

  return {
    request({ by = "?", byId = "", room = "", reason = "", ttlMin } = {}) {
      const t = now(), ttl = Math.max(1, Math.min(24 * 60, Number(ttlMin) || Number(defaultTtlMin()) || 120)) * 60000;
      if (!pending) { pending = { reasons: [], since: t, expires: 0 }; quietSince = 0; }
      pending.reasons.push({ by: String(by), byId: String(byId), room: String(room || ""), reason: String(reason || "").slice(0, 200), at: t });
      pending.expires = Math.max(pending.expires, t + ttl);
      save();
      log(`restart queue: ${by} asked for a daemon restart (${reason || "no reason"}); ${pending.reasons.length} request(s), waiting on: ${busyList().join(", ") || "nobody"}`);
      return { queued: true, merged: pending.reasons.length > 1, ...view() };
    },
    cancel({ by = "?" } = {}) {
      const had = !!pending; if (pending) log(`restart queue: cancelled by ${by}`);
      pending = null; save(); return { cancelled: had };
    },
    status: () => ({ pending: view() }),
    tick() {
      const t = now();
      // Watchdog for J87 agent restarts that wait for their agent to stop working.
      for (const r of agentRestartsPending()) if (r.waiting && r.at && t - r.at > wMs()) {
        const key = `agent:${r.id}:${r.at}`;
        if (!warnedWaits.has(key)) { warnedWaits.set(key, t); note(r.room || defaultRoom(), `⏳ ${r.name}'s restart (asked by ${r.by}) has waited ${ago(t - r.at)} for it to finish its turn`); }
      }
      if (!pending || restarting) return;
      if (t > pending.expires) {
        const who = pending.reasons.map((r) => r.by).join(", ");
        const on = busyList().join(", ");
        log(`restart queue: the restart asked by ${who} expired, still waiting on ${on || "nobody"}`);
        note(room0(), `⌛ the daemon restart asked by ${who} expired after waiting for ${on || "nobody"}; ask again if it's still needed`);
        pending = null; save(); return;
      }
      const busy = busyList();
      if (t - pending.since > wMs() && !pending.warned) {
        pending.warned = true; save();
        note(room0(), `⏳ the daemon restart asked by ${pending.reasons.map((r) => r.by).join(", ")} has waited ${ago(t - pending.since)} for: ${busy.join(", ") || "a quiet moment"}`);
      }
      if (busy.length) { quietSince = 0; return; }
      if (!quietSince) { quietSince = t; return; }
      if (t - quietSince < qMs()) return;
      restarting = true;
      log(`restart queue: everyone idle for ${Math.round((t - quietSince) / 1000)} s; restarting the daemon for ${pending.reasons.map((r) => `${r.by} (${r.reason})`).join(", ")}`);
      save();
      try {
        const cmd = `while kill -0 ${process.pid} 2>/dev/null; do sleep 0.2; done; exec ${ensureCmd}`;
        spawn("sh", ["-c", cmd], { detached: true, stdio: "ignore", env: { ...process.env, HYPRPI_FROM_DAEMON: "" } }).unref();
      } catch (e) { log(`restart queue: couldn't arrange the restart: ${e.message}`); restarting = false; return; }
      shutdown();
    },
  };
}
