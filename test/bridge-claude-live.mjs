// node test/bridge-claude-live.mjs  (J407 W4, MANUAL: runs a real Claude Code session, so it costs a model call; not part of the suite)
// A real `claude -p` registers through the bridge MCP, takes a test job end to end, and its name shows as the one who will do
// the job (the mode the relay puts on a held item and the card). Isolated: temp state; the relay's bridge side runs in this process.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
const base = fs.mkdtempSync(path.join(os.tmpdir(), "j407-live-")), st = path.join(base, "state"), cfg = path.join(base, "cfg");
fs.mkdirSync(path.join(cfg, "hyprpi"), { recursive: true });
process.env.DOORMAN_STATE = st; process.env.XDG_CONFIG_HOME = cfg;
const { startBridge } = await import("../docker/bridge/relay-bridge.mjs");
const { newJob } = await import("../docker/bridge/core.mjs");
const REQ = path.join(st, "requests"); fs.mkdirSync(REQ, { recursive: true, mode: 0o700 });
const jobRecord = (id, patch) => { const f = path.join(REQ, `${id}.json`); let cur = {}; try { cur = JSON.parse(fs.readFileSync(f, "utf8")); } catch { /* */ } fs.writeFileSync(f, JSON.stringify({ ...cur, ...patch, history: [...(cur.history || []), ...(patch.history || [])] })); };
const told = [], modes = [];
const bridge = startBridge({ stateDir: st, log: () => {}, jobRecord, tellOutcome: (s, a, t) => told.push(t), holdQuestion: () => null, sandboxes: () => ["world-t"], onMode: (sb, m) => modes.push(m) });
const job = newJob({ id: "world-t--c1a0de", sandbox: "world-t", asker: "Alpha", action: "Reply with the word hello. Do nothing else.", actionLine: "reply hello", timeLimitS: 600 });
jobRecord(job.id, job);
const CLI = new URL("../docker/bridge/doorman-bridge", import.meta.url).pathname, mcp = path.join(base, "mcp.json");
fs.writeFileSync(mcp, JSON.stringify({ mcpServers: { "doorman-bridge": { command: CLI, args: ["mcp"], env: { DOORMAN_STATE: st } } } }));
const prompt = "You are a host agent testing the Doorman bridge. Using ONLY the doorman-bridge MCP tools: 1) register_agent with name \"ClaudeLive\" and harness \"claude-code\" and caps \"test run\"; 2) list_jobs; 3) claim_job the job you find; 4) do what its approved text says (it only asks you to reply hello: no other tools); 5) report_job with state done and summary \"said hello\". Then stop.";
const r = await new Promise((res) => {
  const ch = spawn("claude", ["-p", "--strict-mcp-config", "--mcp-config", mcp, "--allowedTools", "mcp__doorman-bridge__register_agent,mcp__doorman-bridge__list_jobs,mcp__doorman-bridge__claim_job,mcp__doorman-bridge__show_job,mcp__doorman-bridge__report_job", "--no-session-persistence", "--output-format", "text"], { cwd: base, stdio: ["pipe", "pipe", "pipe"] });
  let out = ""; ch.stdout.on("data", (d) => (out += d)); ch.stderr.on("data", (d) => (out += d)); ch.stdin.end(prompt);
  const t = setTimeout(() => ch.kill("SIGTERM"), 240000); ch.on("exit", (code) => { clearTimeout(t); res({ code, out }); });
});
await new Promise((x) => setTimeout(x, 1500));
const rec = JSON.parse(fs.readFileSync(path.join(REQ, `${job.id}.json`), "utf8"));
console.log("claude exit", r.code, "\n", r.out.slice(-600));
assert.ok(modes.some((m) => m.mode === "host agent available" && m.agents.includes("ClaudeLive (claude-code)")), `while it ran, the mode named it: ${JSON.stringify(modes)}`);
console.log(`ok the relay's mode named it while registered: "Will be done by: ${modes.find((m) => m.agents.length).agents.join(" or ")}"`);
assert.equal(rec.state, "done", `job state ${rec.state}`); assert.equal(rec.outcome.by, "ClaudeLive", "reported in its registered name");
assert.ok(rec.history.some((h) => /claimed by ClaudeLive/.test(h.ev)));
console.log(`ok job ${job.id}: claimed by ClaudeLive, reported done: "${rec.outcome.summary}"`);
assert.ok(told.some((t) => /ended done/.test(t))); console.log("ok the outcome went back to the asker");
bridge.expire(); assert.equal(bridge.mode("world-t").mode, "agent-free", "after the session ended it unregistered");
console.log("ok after the session ended: agent-free again (it unregistered on exit)");
bridge.stop(); fs.rmSync(base, { recursive: true, force: true });
console.log("bridge-claude-live: all pass");
