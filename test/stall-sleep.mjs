#!/usr/bin/env node
// J586 proof, unit level (lib/stall.mjs): the stall watch knows about system sleep. Fake wall and monotonic clocks; no daemon, no
// agents, no processes. Replays 2026-10-14 01:28: Backbeat working on a bash call, the laptop hibernates 9 min 27 s, wakes.
//   W2: no "stalled" alert for sleep time (a call that spans a sleep, quiet for less than N awake minutes after the wake, isn't
//       flagged), and when a call that spans a sleep is flagged, the alert names the sleep length.
//   W3: a real stall after a wake is still flagged, timed from the wake (N min after the wake, not N min minus the sleep).
//   Also: the sleep clock itself (no sleep from load or slow ticks; a hung hibernate that resumed counts; clipping to the span).
//   node test/run.mjs test/stall-sleep.mjs   (exit 0 = pass)
import { createSleepClock, createStallWatch } from "../lib/stall.mjs";
let fails = 0; const ok = (n, c, x = "") => { if (!c) fails++; console.log(`${c ? "ok  " : "FAIL"} ${n}${x ? ": " + x : ""}`); };
const MIN = 60000;

// a machine: wall runs always, mono only while awake
function machine(t0 = Date.parse("2026-10-14T06:20:00Z")) {
  const m = { wall: t0, mono: 1000 };
  m.awake = (ms) => { m.wall += ms; m.mono += ms; };
  m.sleep = (ms) => { m.wall += ms; };
  return m;
}
const policy = () => ({ orchestration: { stallAlertMinutes: 10, stallAlertRepeatMinutes: 30 } });
function rig(extra = {}) {
  const M = machine(), alerts = [];
  const clock = createSleepClock({ wall: () => M.wall, mono: () => M.mono });
  const a = { id: "hp-bb", name: "Backbeat", conn: {}, status: "working", room: "E", pulsed: true, lastOutput: M.wall, statusSince: M.wall - MIN, waitingOn: "bash: cd ~/Work/music-lab-J584 && python3 - <<'EOF' …", ...extra };
  const w = createStallWatch({ agents: () => [a], policy, now: () => M.wall, sleep: clock, alert: (room, text) => alerts.push({ room, text, at: M.wall }) });
  // run for ms of awake time, checking every 30 s like the daemon
  const run = (ms) => { for (let i = 0; i < ms; i += 30000) { M.awake(30000); w.check(); } };
  return { M, a, w, clock, alerts, run };
}

// --- the sleep clock
{
  const M = machine(), c = createSleepClock({ wall: () => M.wall, mono: () => M.mono });
  M.awake(30000); c.sample(); M.awake(5 * MIN); c.sample(); // a slow tick (loaded machine, blocked loop): both clocks move
  ok("clock: no sleep from slow ticks or load", c.sleeps().length === 0);
  const before = M.wall;
  M.awake(10000); M.sleep(9 * MIN + 16000); M.awake(8000); c.sample(); // the hibernate that hung and resumed: CPU stopped all the same
  const s = c.sleeps();
  ok("clock: a 9 min 16 s hibernate is one sleep of that length", s.length === 1 && s[0].ms === 9 * MIN + 16000, JSON.stringify(s));
  ok("clock: … placed between its last sample and the sample that saw the wake (start + length = that sample)", s[0].start >= before && s[0].end === M.wall && s[0].end - s[0].start === s[0].ms);
  M.awake(1000); M.sleep(15000); c.sample();
  ok("clock: a gap under 20 s isn't a sleep", c.sleeps().length === 1);
  const w = c.within(s[0].start + MIN, s[0].end + MIN);
  ok("clock: within() clips a sleep to the span", w.length === 1 && w[0].ms === 8 * MIN + 16000, JSON.stringify(w));
}

// --- W2: the 01:28 replay. Bash call starts (last output), 3 min 20 s awake, 9 min 27 s asleep, wake; result 15 s later.
{
  const r = rig();
  r.run(3 * MIN + 20000);
  r.M.sleep(9 * MIN + 27000); r.w.check();             // first tick after the wake: wall says 12m47s quiet, but most of it slept
  ok("W2 no alert at the wake, though 12 min 47 s of wall time passed with no output", r.alerts.length === 0, JSON.stringify(r.alerts));
  r.run(9 * MIN);                                       // 9 more awake minutes, still quiet: under 10 min since the wake
  ok("W2 no alert for sleep time: still none 9 awake minutes after the wake (22 min of wall time)", r.alerts.length === 0, JSON.stringify(r.alerts));
  // same timeline without sleep awareness (the old watch) would have fired at the wake: show the contrast
  const M = machine(), old = [], a = { id: "x", name: "Backbeat", conn: {}, status: "working", room: "E", pulsed: true, lastOutput: M.wall, statusSince: M.wall };
  const w0 = createStallWatch({ agents: () => [a], policy, now: () => M.wall, sleep: null, alert: (room, text) => old.push(text) });
  M.awake(3 * MIN + 20000); M.sleep(9 * MIN + 27000); w0.check();
  ok("W2 (contrast) the watch without the sleep clock fires at the wake: the false alarm J586 removes", old.length === 1 && /working 13 min with no output/.test(old[0]), old[0]);
}

// --- W2 + W3: a real stall after the wake: flagged 10 min after the wake, and the text names the sleep
{
  const r = rig();
  r.run(5 * MIN);                                       // 5 quiet minutes before the sleep
  r.M.sleep(9 * MIN + 16000); r.w.check();
  const wake = r.M.wall;
  r.run(12 * MIN);
  const first = r.alerts[0];
  ok("W3 a real stall after the wake is still flagged", r.alerts.length === 1, JSON.stringify(r.alerts));
  ok("W3 … timed from the wake: fires 10 min after it (not 5, not 10 minus the sleep)", first && first.at - wake === 10 * MIN, first && `${(first.at - wake) / MIN} min after wake`);
  ok("W3 … and says 10 min since the wake", first && /working 10 min since the laptop woke/.test(first.text), first?.text);
  ok("W2 the alert names the sleep length (9 min)", first && /it slept 9 min during this call/.test(first.text), first?.text);
  ok("W2 … and still says what it waits on, to its own room", first && /waiting on: bash: cd ~\/Work\/music-lab-J584/.test(first.text) && first.room === "E");
}

// --- output after the wake resets the clock as before; no sleep in the quiet spell = the old text
{
  const r = rig();
  r.run(2 * MIN); r.M.sleep(20 * MIN); r.w.check();
  r.run(4 * MIN); r.a.lastOutput = r.M.wall;           // the tool prints after the wake
  r.run(10 * MIN);
  const t = r.alerts[0]?.text || "";
  ok("a stall that starts after output following the wake: old text, no sleep mention", r.alerts.length === 1 && /working 10 min with no output/.test(t) && !/slept/.test(t), t);
}
{
  const r = rig(); r.run(11 * MIN);
  ok("no sleep at all: fires at 10 min with the old text", r.alerts.length === 1 && /working 10 min with no output; waiting on/.test(r.alerts[0].text), r.alerts[0]?.text);
}
// two sleeps in one call: the clock starts at the last wake; the text sums both
{
  const r = rig();
  r.run(MIN); r.M.sleep(5 * MIN); r.w.check(); r.run(3 * MIN); r.M.sleep(7 * MIN); r.w.check();
  r.run(9 * MIN);
  ok("two sleeps: nothing within 10 awake min of the last wake", r.alerts.length === 0, JSON.stringify(r.alerts));
  r.run(MIN);
  ok("two sleeps: then fires, naming both (12 min)", r.alerts.length === 1 && /it slept 12 min during this call/.test(r.alerts[0].text), r.alerts[0]?.text);
}
console.log(fails ? `stall-sleep: ${fails} FAILED` : "stall-sleep: all pass");
process.exit(fails ? 1 : 0);
