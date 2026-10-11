#!/usr/bin/env node
// J458 (PollReview LOW): G's gate (docker/world/g-gate.mjs) picks up an inbox item within ~1 s (DROPBOX_POLL_MS) and delivers it to
// the inner agent it names. Isolated: a throwaway "inner" hyprpi daemon (own socket and state, no Hyprland), a fake inner agent
// Alpha, the real gate process, temp drop-box and inbox folders. Three host messages written at random moments.
//   node test/gate-inbox-poll.mjs   (exit 0 = pass)
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0; const ok = (n, c, x = "") => { if (!c) fails++; console.log(`${c ? "ok  " : "FAIL"} ${n}${x ? ": " + x : ""}`); };
const S = fs.mkdtempSync(path.join(os.tmpdir(), "j458g-")), cfg = path.join(S, "cfg"), sock = path.join(S, "d.sock"), box = path.join(S, "box"), inbox = path.join(S, "inbox"), gstate = path.join(S, "gstate");
for (const d of [path.join(cfg, "hyprpi"), box, inbox, gstate]) fs.mkdirSync(d, { recursive: true });
fs.writeFileSync(path.join(cfg, "hyprpi", "config.json"), JSON.stringify({ roomToThoughts: false, pi: "/bin/cat", worldSize: 10 }));
fs.writeFileSync(path.join(cfg, "hyprpi", "hyprpi.jsonc"), JSON.stringify({ auth: { enabled: false }, upkeep: { refresh: { enabled: false }, autoReload: { enabled: false } } }));
const env = { ...process.env, HYPRPI_SOCKET: sock, HYPRPI_STATE: S, XDG_CONFIG_HOME: cfg, HYPRLAND_INSTANCE_SIGNATURE: "j458-bogus", HYPRPI_NO_ENSURE: "1", HYPRPI_UPKEEP_MS: "3600000" };
delete env.HYPRPI_AGENT_ID; delete env.HYPRPI_WORKSPACE;
const d = spawn(process.execPath, [path.join(ROOT, "bin/hyprpi"), "daemon"], { env, stdio: "ignore" });
let g = null, glog = "";
try {
  for (let i = 0; i < 50 && !fs.existsSync(sock); i++) await sleep(200);
  const { connect } = await import(path.join(ROOT, "lib/client.mjs"));
  const got = [];
  const alpha = await connect({ path: sock, onEvent: (ev, data) => got.push({ ev, data, at: Date.now() }) });
  await alpha.call("agent.hello", { agent_id: "hp-alpha", pid: process.pid, name: "Alpha", want_workspace: 62, cwd: S });
  g = spawn(process.execPath, [path.join(ROOT, "docker/world/g-gate.mjs")], { env: { ...env, HYPRPI_DROPBOX: box, HYPRPI_INBOX: inbox, HYPRPI_STATE: gstate, HYPRPI_GATE_WORKSPACE: "62" }, stdio: ["ignore", "pipe", "pipe"] });
  g.stdout.on("data", (b) => (glog += b)); g.stderr.on("data", (b) => (glog += b));
  await sleep(2500); // the gate joins the inner daemon
  let worst = 0;
  for (let i = 1; i <= 3; i++) {
    await sleep(Math.floor(Math.random() * 900) + 100);
    const word = `poll-${i}-${crypto.randomBytes(3).toString("hex")}`, name = `${Date.now()}-${crypto.randomBytes(4).toString("hex")}.json`;
    fs.writeFileSync(path.join(inbox, "." + name), JSON.stringify({ v: 1, type: "message", request_id: `r${i}`, from: "Lens", mode: "talk", text: `Alpha: ${word}` }));
    fs.renameSync(path.join(inbox, "." + name), path.join(inbox, name)); const t0 = Date.now();
    let hit = null; for (let k = 0; k < 60 && !hit; k++) { hit = got.find((e) => JSON.stringify(e.data || "").includes(word)); if (!hit) await sleep(50); }
    const ms = hit ? hit.at - t0 : -1; console.log(`  message ${i}: delivered to Alpha after ${ms} ms`);
    if (!hit) { ok(`message ${i} reached Alpha`, false, glog.slice(-400)); continue; }
    worst = Math.max(worst, ms);
  }
  ok("every inbox message reached the named inner agent within ~1 s", worst > 0 && worst <= 1400, `worst ${worst} ms`);
} finally {
  try { g?.kill("SIGTERM"); } catch { /* */ } d.kill("SIGTERM"); await sleep(500); fs.rmSync(S, { recursive: true, force: true });
}
console.log(fails ? `gate-inbox-poll: ${fails} FAILED` : "gate-inbox-poll: all pass");
process.exit(fails ? 1 : 0);
