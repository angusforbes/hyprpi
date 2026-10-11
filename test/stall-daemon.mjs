#!/usr/bin/env node
// J452 W3 proof, daemon level: an isolated hyprpi daemon (own socket, state and config; no Hyprland, no real agents) with a
// short stall limit (orchestration.stallAlertMinutes 0.05 = 3 s, check every 0.5 s). Fake agents connect as the extension does:
//   Quiet (world D): working, one pulse, then nothing          -> ONE "[hyprpi alert] ⚠ stalled" line to Thoughts-D, naming
//                                                                what it waits on; not repeated within the repeat window
//   Streamer (world D): working, a pulse every second (tokens) -> none
//   Builder (world E): working on a long bash that prints      -> none
//   Old (world D): working, never pulses (older extension)     -> none
// Thoughts is a stub (config "pi" = a script that logs what it is sent), so the test sees exactly what reached which world.
//   node test/stall-daemon.mjs   (exit 0 = pass)
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0; const ok = (n, c, x = "") => { if (!c) fails++; console.log(`${c ? "ok  " : "FAIL"} ${n}${x ? ": " + x : ""}`); };
const S = fs.mkdtempSync(path.join(os.tmpdir(), "j452d-")), cfg = path.join(S, "cfg"), sock = path.join(S, "d.sock"), tlog = path.join(S, "stub-pi-log");
fs.mkdirSync(path.join(cfg, "hyprpi"), { recursive: true }); fs.mkdirSync(tlog);
const stub = path.join(S, "pi-stub"); // a Thoughts process: logs every prompt it gets, per process (each world starts its own)
fs.writeFileSync(stub, `#!/bin/sh\nexec cat >> ${tlog}/$$.log\n`, { mode: 0o755 });
fs.writeFileSync(path.join(cfg, "hyprpi", "config.json"), JSON.stringify({ roomToThoughts: false, pi: stub, worldSize: 10 }));
fs.writeFileSync(path.join(cfg, "hyprpi", "hyprpi.jsonc"), JSON.stringify({ auth: { enabled: false }, upkeep: { refresh: { enabled: false }, autoReload: { enabled: false } }, orchestration: { stallAlertMinutes: 0.05, stallAlertRepeatMinutes: 0.5 } }));
const env = { ...process.env, HYPRPI_SOCKET: sock, HYPRPI_STATE: S, XDG_CONFIG_HOME: cfg, HYPRLAND_INSTANCE_SIGNATURE: "j452-bogus", HYPRPI_NO_ENSURE: "1", HYPRPI_UPKEEP_MS: "3600000", HYPRPI_STALL_CHECK_MS: "500" };
delete env.HYPRPI_AGENT_ID; delete env.HYPRPI_WORKSPACE;
const d = spawn(process.execPath, [path.join(ROOT, "bin/hyprpi"), "daemon"], { env, stdio: ["ignore", "pipe", "pipe"] }); const dl = fs.openSync(path.join(S, "d.log"), "w"); d.stdout.on("data", (b) => fs.writeSync(dl, b)); d.stderr.on("data", (b) => fs.writeSync(dl, b));
const timers = [];
try {
  for (let i = 0; i < 50 && !fs.existsSync(sock); i++) await sleep(200);
  const { connect } = await import(path.join(ROOT, "lib/client.mjs"));
  const fake = async (id, name, ws) => { const c = await connect({ path: sock, onEvent: () => {} }); await c.call("agent.hello", { agent_id: id, pid: process.pid, name, want_workspace: ws, cwd: S }); return c; };
  const quiet = await fake("hp-quiet", "Quiet", 32), streamer = await fake("hp-stream", "Streamer", 33), builder = await fake("hp-build", "Builder", 42), old = await fake("hp-old", "Old", 34);
  for (const c of [quiet, streamer, builder, old]) await c.call("agent.update", { status: "working" });
  await quiet.call("agent.pulse", { waiting: "wait_report (PageReview449)" });
  await builder.call("agent.pulse", { waiting: "bash: npm test" });
  timers.push(setInterval(() => streamer.call("agent.pulse", { waiting: "the model (its reply)" }).catch(() => {}), 1000)); // tokens streaming
  timers.push(setInterval(() => builder.call("agent.pulse", { waiting: "bash: npm test" }).catch(() => {}), 1000));          // the tool prints
  await sleep(9000); // 3 s limit + checks every 0.5 s; repeat window 30 s
  const dlog = fs.readFileSync(path.join(S, "d.log"), "utf8"), alerts = dlog.split("\n").filter((l) => /stall alert/.test(l));
  const got = fs.readdirSync(tlog).map((f) => fs.readFileSync(path.join(tlog, f), "utf8")).join("\n");
  ok("the stalled agent gets an alert", alerts.some((l) => /stall alert D: \[hyprpi alert\] ⚠ stalled: Quiet working \d+ (s|min) with no output; waiting on: wait_report \(PageReview449\)/.test(l)), alerts.join(" | "));
  ok("… it reached Thoughts-D (the stub got the prompt)", /⚠ stalled: Quiet working/.test(got) && /message from agent hyprpi/.test(got), got.slice(0, 300));
  ok("… only once in the repeat window (rate-limited)", alerts.filter((l) => /Quiet/.test(l)).length === 1, String(alerts.length));
  ok("… and only to its own world (D), never E", alerts.every((l) => /stall alert D:/.test(l)));
  ok("no alert for the agent streaming output", !alerts.some((l) => /Streamer/.test(l)));
  ok("no alert for the long tool call that prints", !alerts.some((l) => /Builder/.test(l)));
  ok("no alert for an agent that never sent a pulse (older extension)", !alerts.some((l) => /Old/.test(l)));
  // output again ends the stall: Quiet pulses, goes on; no new alert within the limit
  await quiet.call("agent.pulse", { waiting: "the model (its reply)" }); await sleep(2000);
  ok("output again: no new alert within the limit", fs.readFileSync(path.join(S, "d.log"), "utf8").split("\n").filter((l) => /stall alert.*Quiet/.test(l)).length === 1);
} finally {
  for (const t of timers) clearInterval(t);
  d.kill("SIGTERM"); await sleep(500);
  fs.rmSync(S, { recursive: true, force: true });
}
console.log(fails ? `stall-daemon: ${fails} FAILED` : "stall-daemon: all pass");
process.exit(fails ? 1 : 0);
