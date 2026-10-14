#!/usr/bin/env node
// test-guard: net (a real pi talks to its model)
// J452 W3, manual (makes two small model calls): the REAL pi with this checkout's hyprpi extension, against an isolated daemon
// (stall limit 8 s, above a model's first-token delay; checks every 0.5 s, pulses every 0.5 s). Agent Sleeper runs `sleep 20` (a tool with no output): it must be
// reported stalled, waiting on "bash: sleep 9". Agent Printer runs a 20-second loop that prints every second: never reported.
//   node test/stall-real-pi.mjs   (exit 0 = pass)
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0; const ok = (n, c, x = "") => { if (!c) fails++; console.log(`${c ? "ok  " : "FAIL"} ${n}${x ? ": " + x : ""}`); };
const S = fs.mkdtempSync(path.join(os.tmpdir(), "j452p-")), cfg = path.join(S, "cfg"), sock = path.join(S, "d.sock");
fs.mkdirSync(path.join(cfg, "hyprpi"), { recursive: true });
const stub = path.join(S, "pi-stub"); fs.writeFileSync(stub, `#!/bin/sh\nexec cat > /dev/null\n`, { mode: 0o755 });
fs.writeFileSync(path.join(cfg, "hyprpi", "config.json"), JSON.stringify({ roomToThoughts: false, pi: stub, worldSize: 10 }));
fs.writeFileSync(path.join(cfg, "hyprpi", "hyprpi.jsonc"), JSON.stringify({ auth: { enabled: false }, upkeep: { refresh: { enabled: false }, autoReload: { enabled: false } }, orchestration: { stallAlertMinutes: 0.1333, stallAlertRepeatMinutes: 5 } }));
const base = { ...process.env, HYPRPI_SOCKET: sock, HYPRPI_STATE: S, HYPRLAND_INSTANCE_SIGNATURE: "j452-bogus", HYPRPI_NO_ENSURE: "1", HYPRPI_UPKEEP_MS: "3600000" };
delete base.HYPRPI_AGENT_ID; delete base.HYPRPI_WORKSPACE;
const d = spawn(process.execPath, [path.join(ROOT, "bin/hyprpi"), "daemon"], { env: { ...base, XDG_CONFIG_HOME: cfg, HYPRPI_STALL_CHECK_MS: "500" }, stdio: ["ignore", "pipe", "pipe"] });
let dlog = ""; d.stdout.on("data", (b) => (dlog += b)); d.stderr.on("data", (b) => (dlog += b));
const run = (id, prompt) => new Promise((res) => { const p = spawn("pi", ["--no-extensions", "-e", path.join(ROOT, "pi-extension/index.ts"), "-p", prompt], { cwd: S, env: { ...base, HYPRPI_AGENT_ID: id, HYPRPI_PULSE_MS: "500" }, stdio: ["ignore", "pipe", "pipe"] }); let o = ""; p.stdout.on("data", (b) => (o += b)); p.stderr.on("data", (b) => (o += b)); const k = setTimeout(() => p.kill(), 150000); p.on("close", (c) => { clearTimeout(k); res({ c, o }); }); });
try {
  for (let i = 0; i < 50 && !fs.existsSync(sock); i++) await sleep(200);
  const [a, b] = await Promise.all([run("hp-sleeper", "Use the bash tool to run exactly: sleep 20 ; then reply with the single word done."), run("hp-printer", "Use the bash tool to run exactly: for i in $(seq 1 20); do echo line $i; sleep 1; done ; then reply with the single word done.")]);
  const alerts = dlog.split("\n").filter((l) => /stall alert/.test(l));
  ok("both pi runs finished", a.c === 0 && b.c === 0, `${a.c} ${b.c} ${a.o.slice(-200)} ${b.o.slice(-200)}`);
  ok("the real extension's pulses reached the daemon (the agents registered and were judged)", /hello|registered|hp-sleeper|Sleeper/i.test(dlog) || alerts.length > 0, dlog.slice(0, 300));
  ok("Sleeper (a tool with no output) is reported stalled, waiting on its bash command", alerts.some((l) => /waiting on: bash: sleep 20/.test(l)), alerts.join(" | "));
  ok("Printer (a tool that prints every second) is never reported while its tool runs", !alerts.some((l) => /waiting on: bash: for i/.test(l)), alerts.join(" | "));
} finally { d.kill("SIGTERM"); await sleep(500); fs.rmSync(S, { recursive: true, force: true }); }
console.log(fails ? `stall-real-pi: ${fails} FAILED` : "stall-real-pi: all pass");
process.exit(fails ? 1 : 0);
