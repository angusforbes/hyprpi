// J452 (Angus: "This seems like a perennial problem we keep running into"): a watch on agents that show "working" but produce no
// output. The daemon's own view of the turn, never files: the agent's extension sends a pulse when tokens stream or a tool
// starts, ends or prints (agent.pulse), and says what it is on ("waiting on"). An agent "working" with no pulse for
// orchestration.stallAlertMinutes (default 10; 0 = off) gets ONE line to its world's Thoughts:
//   [hyprpi alert] ⚠ stalled: <agent> working N min with no output; waiting on: <what>
// at most once per stallAlertRepeatMinutes per agent (a stall that goes on is told again after that window; output resets the clock).
// Never to Angus directly (no toast, no sound): Thoughts decides whether it matters.
// Advisory, not proof (StallReview): "no output" also covers a model that is slow to its first token or reasons without streaming;
// at the 10-minute default that is rare, and the line says what the agent is on. Host worlds only: a sandboxed world's host thread
// refuses it (J267), so such an agent isn't alerted (sandbox pseudo-agents don't pulse anyway).
export function createStallWatch({ agents, policy, alert, now = () => Date.now(), name = (a) => a.name || a.id, log = () => {} }) {
  function check() {
    const O = policy().orchestration || {};
    const min = Number(O.stallAlertMinutes ?? 10), repeat = Math.max(1, Number(O.stallAlertRepeatMinutes ?? 30));
    if (!(min > 0)) return [];
    const t = now(), sent = [];
    for (const a of agents()) {
      if (!a || !a.conn || a.status !== "working" || !a.room || !a.pulsed) continue; // only agents whose extension sends pulses (an older one, or a sandbox pseudo-agent, can't be judged)
      const ref = Math.max(Number(a.lastOutput) || 0, Number(a.statusSince) || 0);
      if (!ref || t - ref < min * 60000) continue;
      if (a.stallAlert && t - a.stallAlert.at < repeat * 60000) continue;        // rate limit per agent: a stall that goes on is told again only after the repeat window
      const ms = t - ref, dur = ms < 90000 ? `${Math.round(ms / 1000)} s` : `${Math.round(ms / 60000)} min`;
      const text = `[hyprpi alert] ⚠ stalled: ${name(a)} working ${dur} with no output; waiting on: ${a.waitingOn || "unknown (no tool running: the model's reply)"}`;
      try { alert(a.room, text, a); a.stallAlert = { ref, at: t }; sent.push({ id: a.id, room: a.room, text }); } catch (e) { log("stall alert:", e.message); } // (StallReview: only a delivered alert uses up the repeat window)
    }
    return sent;
  }
  return { check };
}
