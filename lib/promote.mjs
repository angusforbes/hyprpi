// J622 (Angus: "a task agent can be promoted to become a project agent"): an agent Angus opened just to talk (no name, no
// project) whose work has become project-level is flagged to its world's Thoughts, which can promote it (a name, an icon, a
// project, the owner role; lib/daemon.mjs "thoughts.promote", the promote_agent tool). The watch only PROPOSES: it never
// creates a project itself.
//
// "Project-level" here: an unnamed agent that is in no project, is not a Thoughts / spawned helper / twin, and has worked
// at least `turns` turns or `minutes` minutes of active time (counted by onTurnEnd from the daemon's turn ends).
// At most one alert per agent per `everyHours` (default 24).
export const PROMOTE_DEFAULTS = { turns: 6, minutes: 30, everyHours: 24 };

export function createPromoteWatch({ agents, inProject, isHelper = () => false, alert, now = () => Date.now(), opts = {}, log = () => {} }) {
  const O = { ...PROMOTE_DEFAULTS }; for (const [k, v] of Object.entries(opts || {})) if (Number(v) > 0) O[k] = Number(v); // (PromoteCheck F1)
  const work = new Map(); // id -> { turns, ms, alerted }
  const get = (id) => { let w = work.get(id); if (!w) work.set(id, (w = { turns: 0, ms: 0, alerted: 0 })); return w; };
  const candidate = (a) => !!a && !!a.conn && !a.name && !!a.room && !a.twinOf && !isHelper(a) && !inProject(a.id);
  // the daemon calls this at each end of a turn (working -> anything else), with how long that turn was
  function onTurnEnd(a, ms = 0) {
    if (!a?.id) return;
    const w = get(a.id); w.turns++; w.ms += Math.max(0, Number(ms) || 0);
  }
  function check() {
    const t = now(), sent = [];
    for (const a of agents()) {
      if (!candidate(a)) continue;
      const w = work.get(a.id);
      if (!w || (w.turns < O.turns && w.ms < O.minutes * 60000)) continue;
      if (w.alerted && t - w.alerted < O.everyHours * 3600e3) continue;
      const mins = Math.round(w.ms / 60000), name = `pi·${String(a.id).slice(-4)}`;
      const text = `[board care] ${name} has no name and no project, but it has worked ${w.turns} turns (${mins} min active)` +
        `${a.cwd ? ` in ${String(a.cwd).replace(/^\/home\/[^/]+/, "~")}` : ""}${a.topic ? ` on "${String(a.topic).slice(0, 80)}"` : ""}: its work may be project-level. ` +
        `Ask it (ask_agent) what it's working on; if it's a project, promote it with promote_agent (a name and icon, a new or existing project, it becomes the owner). ` +
        "Its session and context are kept. If it's a one-off, leave it. Don't ask Angus.";
      try { alert(a.room, text, a); w.alerted = t; sent.push({ id: a.id, room: a.room, text }); } catch (e) { log("promote alert:", e.message); }
    }
    return sent;
  }
  const forget = (id) => work.delete(id);
  return { onTurnEnd, check, forget, state: (id) => work.get(id) };
}
