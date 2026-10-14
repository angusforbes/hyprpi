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
//
// J586 (Angus "27a", after Songsmith and Backbeat "stalled" at 01:28 on 2026-10-14: the laptop had hibernated for 9 min, no tool lost):
// the watch knows about system sleep. A sleep clock compares the wall clock (Date.now, which runs on through suspend / hibernate)
// with the monotonic clock (performance.now = CLOCK_MONOTONIC, which stops while the machine sleeps); a gap of more than
// SLEEP_MIN_MS between two samples is a sleep, from (last wall + monotonic elapsed) to the sample that saw it. That also catches a
// hibernate that hung and resumed without sleeping properly (01:28 -> 01:37), since the CPU was stopped all the same. Sleep is never
// stall time: an agent's stall clock starts again at the last wake inside its quiet spell, so a real stall after the wake is still
// flagged, timed from the wake, and its alert says how long the laptop slept during the call. (A forward NTP jump of > 20 s reads as a
// sleep too: harmless, it only restarts the clock.)
export const SLEEP_MIN_MS = 20000;
export function createSleepClock({ wall = () => Date.now(), mono = () => performance.now(), minMs = SLEEP_MIN_MS, keepMs = 24 * 3600000 } = {}) {
  let lw = wall(), lm = mono();
  const sleeps = [];
  function sample() {
    const w = wall(), m = mono(), gap = (w - lw) - (m - lm);
    if (gap > minMs) sleeps.push({ start: lw + (m - lm), end: w, ms: gap });
    lw = w; lm = m;
    while (sleeps.length && sleeps[0].end < w - keepMs) sleeps.shift();
    return sleeps;
  }
  // the sleeps that overlap [from, to] (ms of each clipped to the span)
  function within(from, to) { return sleeps.filter((x) => x.end > from && x.start < to).map((x) => ({ ...x, ms: Math.min(x.end, to) - Math.max(x.start, from) })); }
  return { sample, within, sleeps: () => sleeps.slice() };
}
const fmtMs = (ms) => ms < 90000 ? `${Math.round(ms / 1000)} s` : `${Math.round(ms / 60000)} min`;

// sleep: a createSleepClock; default: a real one when the clock is real (the daemon passes no now, so it gets one), none when a test fakes `now` only
export function createStallWatch({ agents, policy, alert, now, sleep, name = (a) => a.name || a.id, log = () => {} }) {
  if (sleep === undefined) sleep = now ? null : createSleepClock();
  if (!now) now = () => Date.now();
  function check() {
    const O = policy().orchestration || {};
    const min = Number(O.stallAlertMinutes ?? 10), repeat = Math.max(1, Number(O.stallAlertRepeatMinutes ?? 30));
    if (sleep) sleep.sample();
    if (!(min > 0)) return [];
    const t = now(), sent = [];
    for (const a of agents()) {
      if (!a || !a.conn || a.status !== "working" || !a.room || !a.pulsed) continue; // only agents whose extension sends pulses (an older one, or a sandbox pseudo-agent, can't be judged)
      const quiet = Math.max(Number(a.lastOutput) || 0, Number(a.statusSince) || 0);
      if (!quiet) continue;
      const slept = sleep ? sleep.within(quiet, t) : [];                         // J586: sleeps during this quiet spell
      const ref = slept.length ? Math.max(quiet, slept[slept.length - 1].end) : quiet; // the stall clock starts again at the last wake
      if (t - ref < min * 60000) continue;
      if (a.stallAlert && t - a.stallAlert.at < repeat * 60000) continue;        // rate limit per agent: a stall that goes on is told again only after the repeat window
      const dur = fmtMs(t - ref), sleptMs = slept.reduce((n, x) => n + x.ms, 0);
      const since = slept.length ? ` since the laptop woke (it slept ${fmtMs(sleptMs)} during this call)` : "";
      const text = `[hyprpi alert] ⚠ stalled: ${name(a)} working ${dur}${since} with no output; waiting on: ${a.waitingOn || "unknown (no tool running: the model's reply)"}`;
      try { alert(a.room, text, a); a.stallAlert = { ref, at: t }; sent.push({ id: a.id, room: a.room, text }); } catch (e) { log("stall alert:", e.message); } // (StallReview: only a delivered alert uses up the repeat window)
    }
    return sent;
  }
  return { check };
}
