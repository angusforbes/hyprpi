// node test/bridge-wait.mjs  (J431): wait_for_job, the blocking wait a long-running host agent uses instead of being nudged. Isolated: a
// temporary state and config folder, the relay's bridge side in this process, the MCP server and the CLI as separate processes.
// Checks: it returns on a new waiting job in scope (not one out of scope, not one still being scoped), on an answer to the agent's own
// question, and on its timeout; the registration's heartbeat goes on while it waits; it adds no power (config, decisions and pending are
// byte-identical; the job records change only through the agent's own claim/ask/report).
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawn, execFile } from "node:child_process";
const base = fs.mkdtempSync(path.join(os.tmpdir(), "j431-")), st = path.join(base, "state"), cfg = path.join(base, "cfg"), cache = path.join(base, "cache");
fs.mkdirSync(path.join(cfg, "hyprpi", "worlds"), { recursive: true });
fs.writeFileSync(path.join(cfg, "hyprpi", "worlds", "world-t.json"), JSON.stringify({ sandbox: "world-t", access: "safe" }));
fs.writeFileSync(path.join(cfg, "hyprpi", "sbx-relay.json"), JSON.stringify({ sandboxes: [{ name: "doorman-t", doorman_for: "world-t", host_agents: "bridge" }] }));
process.env.DOORMAN_STATE = st; process.env.XDG_CACHE_HOME = cache; process.env.XDG_CONFIG_HOME = cfg;
const { startBridge } = await import("../docker/bridge/relay-bridge.mjs");
const { newJob } = await import("../docker/bridge/core.mjs");
const CLI = new URL("../docker/bridge/doorman-bridge", import.meta.url).pathname;
const REQ = path.join(st, "requests"); fs.mkdirSync(REQ, { recursive: true, mode: 0o700 });
const jobRecord = (id, patch) => { const f = path.join(REQ, `${id}.json`); let cur = {}; try { cur = JSON.parse(fs.readFileSync(f, "utf8")); } catch { /* */ }
  fs.writeFileSync(f + ".tmp", JSON.stringify({ ...cur, ...patch, history: [...(cur.history || []), ...(patch.history || [])].slice(-50) }), { mode: 0o600 }); fs.renameSync(f + ".tmp", f); };
const held = [];
const bridge = startBridge({ stateDir: st, log() {}, jobRecord, tellOutcome() {}, holdQuestion: (rec, n, text) => { const hid = `doorman-t--${crypto.randomBytes(3).toString("hex")}`; held.push({ hid, rec: rec.id, n, text }); return hid; } });
const mk = (id, sandbox = "world-t", extra = {}) => { const j = newJob({ id, sandbox, asker: "Alpha", action: "Approved: write hello.txt", tools: ["Write"], folders: [] }); jobRecord(id, { ...j, ...extra }); };
const DEC = path.join(st, "decisions"), PEND = path.join(st, "pending"); fs.mkdirSync(DEC, { recursive: true }); fs.mkdirSync(PEND, { recursive: true });
const snap = () => { const h = crypto.createHash("sha256"); for (const d of [cfg, DEC, PEND]) { const walk = (x) => { for (const e of fs.readdirSync(x, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) { const p = path.join(x, e.name); h.update(p); if (e.isDirectory()) walk(p); else h.update(fs.readFileSync(p)); } }; walk(d); } return h.digest("hex"); };
const before = snap();
const ok = (m) => console.log("ok " + m);
const env = { ...process.env, DOORMAN_STATE: st, XDG_CACHE_HOME: cache, XDG_CONFIG_HOME: cfg };

// the MCP server, registered automatically for world-t only, heartbeat every 1 s
const mcp = spawn(CLI, ["mcp"], { env: { ...env, DOORMAN_BRIDGE_AGENT: "Waiter", DOORMAN_BRIDGE_SCOPE: "world-t", DOORMAN_BRIDGE_HB_MS: "1000" } });
let mout = ""; mcp.stdout.on("data", (d) => (mout += d));
let nid = 100; const pendingRpc = new Map();
mcp.stdout.on("data", () => { for (const l of mout.split("\n")) { try { const m = JSON.parse(l); if (pendingRpc.has(m.id)) { pendingRpc.get(m.id)(m); pendingRpc.delete(m.id); } } catch { /* partial */ } } });
const rpc = (method, params) => new Promise((res) => { const id = nid++; pendingRpc.set(id, res); mcp.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n"); });
const tool = async (name, args = {}) => { const m = await rpc("tools/call", { name, arguments: args }); return JSON.parse(m.result.content[0].text); };
const init = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } });
assert.match(init.result.instructions, /wait_for_job/, "the instructions tell the agent to wait");
const tl = (await rpc("tools/list", {})).result.tools; assert.ok(tl.some((t) => t.name === "wait_for_job")); assert.equal(tl.length, 14);
const pr = (await rpc("prompts/get", { name: "check" })).result.messages[0].content.text; assert.match(pr, /wait_for_job[\s\S]*again/);
for (let t = 0; t < 50 && !fs.existsSync(path.join(st, "bridge", "agents.json")); t++) await new Promise((r) => setTimeout(r, 100));
const lastBeat = () => Object.values(JSON.parse(fs.readFileSync(path.join(st, "bridge", "agents.json"), "utf8")).agents).find((a) => a.name === "Waiter")?.last;
ok("MCP: wait_for_job is listed (14 tools), the instructions and the check prompt loop on it");

// 1. timeout: nothing waiting -> "none" after timeout_s; the heartbeat goes on meanwhile
let t0 = Date.now(), b0 = lastBeat(); let r = await tool("wait_for_job", { timeout_s: 4 });
assert.equal(r.event, "none"); assert.ok(Date.now() - t0 >= 3800 && Date.now() - t0 < 8000, `waited ${Date.now() - t0} ms`);
assert.ok(Date.parse(lastBeat()) > Date.parse(b0), "heartbeats went on while it waited");
ok("timeout: event none after timeout_s, and the registration kept heartbeating meanwhile");

// 2. a job approved while it waits wakes it at once; one out of scope or still being scoped doesn't
let w = tool("wait_for_job", { timeout_s: 30 }); t0 = Date.now();
await new Promise((res) => setTimeout(res, 1500)); mk("doorman-u--b00001", "world-u"); mk("doorman-t--b00002", "world-t", { state: "scoping" });
await new Promise((res) => setTimeout(res, 2000)); mk("doorman-t--b00003");
r = await w; assert.equal(r.event, "job"); assert.equal(r.job.id, "doorman-t--b00003", "out of scope and still-scoping jobs don't wake it");
assert.ok(Date.now() - t0 < 6500, "woken within about a second of the job");
ok("a new waiting job in scope wakes it at once; another sandbox's job and a job still being scoped don't");

// 3. claim, ask; the owner's answer wakes it with event answer (once)
assert.equal((await tool("claim_job", { id: "doorman-t--b00003" })).ok, true);
assert.equal((await tool("ask_owner", { id: "doorman-t--b00003", question: "Which folder?" })).ok, true);
w = tool("wait_for_job", { timeout_s: 30 });
await new Promise((res) => setTimeout(res, 1500)); assert.equal(bridge.answer("doorman-t--b00003", 1, "the home folder", held.at(-1).hid), true);
r = await w; assert.equal(r.event, "answer"); assert.equal(r.job.id, "doorman-t--b00003"); assert.equal(r.job.questions[0].answer, "the home folder");
r = await tool("wait_for_job", { timeout_s: 2 }); assert.equal(r.event, "none", "an answer is handed over once");
assert.equal((await tool("report_job", { id: "doorman-t--b00003", state: "done", summary: "wrote it" })).ok, true);
ok("an answer to its own question wakes it (event answer, once); then report");

// 4. first claim wins: a job another agent claims first -> claim_job fails cleanly, waiting again finds nothing
mk("doorman-t--b00004"); r = await tool("wait_for_job", { timeout_s: 5 }); assert.equal(r.job.id, "doorman-t--b00004");
const other = await new Promise((res) => execFile(CLI, ["--json", "register", "Runner", "--harness", "test"], { env }, (e, o) => res(JSON.parse(o))));
const oc = await new Promise((res) => execFile(CLI, ["--json", "claim", "doorman-t--b00004", "--by", "Runner", "--agent-token", other.agent_token], { env }, (e, o) => res(JSON.parse(o))));
assert.equal(oc.ok, true); assert.equal((await tool("claim_job", { id: "doorman-t--b00004" })).ok, false, "the second claim fails");
r = await tool("wait_for_job", { timeout_s: 2 }); assert.equal(r.event, "none");
ok("first claim wins: the other agent's claim stands, ours fails, the wait finds nothing more");

// 4b. (WaitReview HIGH 1) a wait doesn't hold up a request sent in the same chunk after it
{ const t = Date.now(); const ids = [nid++, nid++]; const got = {};
  const done = new Promise((res) => { const f = () => { for (const l of mout.split("\n")) { try { const m = JSON.parse(l); if (ids.includes(m.id) && !got[m.id]) got[m.id] = Date.now() - t; } catch { /* */ } } if (got[ids[1]] && got[ids[0]]) res(); else setTimeout(f, 50); }; f(); });
  mcp.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: ids[0], method: "tools/call", params: { name: "wait_for_job", arguments: { timeout_s: 3 } } }) + "\n" + JSON.stringify({ jsonrpc: "2.0", id: ids[1], method: "ping" }) + "\n");
  await done; assert.ok(got[ids[1]] < 1000, `ping answered in ${got[ids[1]]} ms, not after the wait`); assert.ok(got[ids[0]] >= 2800); }
ok("a wait doesn't block a request sent after it in the same chunk");
// 4c. (WaitReview HIGH 2) an answer on a job whose claim this session LOST (lapsed, now another agent's) doesn't wake it
{ mk("doorman-t--b00006"); assert.equal((await tool("claim_job", { id: "doorman-t--b00006" })).ok, true);
  jobRecord("doorman-t--b00006", { state: "waiting", claim: null }); // the lease lapsed (as the relay's sweep does)
  const oc2 = await new Promise((res) => execFile(CLI, ["--json", "claim", "doorman-t--b00006", "--by", "Runner", "--agent-token", other.agent_token], { env }, (e, o) => res(JSON.parse(o)))); assert.equal(oc2.ok, true);
  const oa = await new Promise((res) => execFile(CLI, ["--json", "ask", "doorman-t--b00006", "--by", "Runner", "--token", oc2.token, "Runner's question"], { env }, (e, o) => res(JSON.parse(o)))); assert.equal(oa.ok, true);
  assert.equal(bridge.answer("doorman-t--b00006", 1, "for the runner", held.at(-1).hid), true);
  r = await tool("wait_for_job", { timeout_s: 2 }); assert.equal(r.event, "none", "another agent's answer on a job we lost doesn't wake us"); }
ok("an answer on a job whose claim this session lost (now another agent's) doesn't wake it");
// 4d. (WaitReview MEDIUM 3) a claim refused for a reason other than a lost race: told to stop, and that job isn't offered again
{ mk("doorman-t--b00007"); r = await tool("wait_for_job", { timeout_s: 3 }); assert.equal(r.job.id, "doorman-t--b00007");
  const regs = JSON.parse(fs.readFileSync(path.join(st, "bridge", "agents.json"), "utf8")); for (const k of Object.keys(regs.agents)) if (regs.agents[k].name === "Waiter") delete regs.agents[k];
  fs.writeFileSync(path.join(st, "bridge", "agents.json"), JSON.stringify(regs)); // the registration expired
  const c7 = await tool("claim_job", { id: "doorman-t--b00007" }); assert.equal(c7.ok, false); assert.match(c7.text, /not a lost race: stop and tell the user/);
  r = await tool("wait_for_job", { timeout_s: 2 }); assert.equal(r.event, "none", "the job that failed that way isn't offered again (no tight loop)");
  fs.unlinkSync(path.join(REQ, "doorman-t--b00007.json")); }
ok("a claim refused for another reason: told to stop; the job isn't offered again");
// 5. the CLI: wait --scope/--timeout, the same events
let c = await new Promise((res) => execFile(CLI, ["--json", "wait", "--timeout", "2", "--scope", "world-t"], { env }, (e, o) => res({ code: e ? e.code : 0, j: JSON.parse(o) })));
assert.equal(c.code, 0); assert.equal(c.j.event, "none");
setTimeout(() => mk("doorman-t--b00005"), 1000);
c = await new Promise((res) => execFile(CLI, ["--json", "wait", "--timeout", "20", "--scope", "world-t"], { env }, (e, o) => res({ code: e ? e.code : 0, j: JSON.parse(o) })));
assert.equal(c.j.event, "job"); assert.equal(c.j.job.id, "doorman-t--b00005");
c = await new Promise((res) => execFile(CLI, ["--json", "wait", "--timeout", "2", "--mine", "doorman-t--b00003"], { env }, (e, o) => res(JSON.parse(o)))); assert.equal(c.event, "answer");
c = await new Promise((res) => execFile(CLI, ["--json", "wait", "--timeout", "2", "--scope", "world-x", "--mine", "doorman-t--b00003", "--seen", "doorman-t--b00003#1"], { env }, (e, o) => res(JSON.parse(o)))); assert.equal(c.event, "none", "--seen: an answer already had");
for (const bad of [["--timeout"], ["--timeout", "abc"], ["--mine"], ["--agent-token"]]) { const x = await new Promise((res) => execFile(CLI, ["wait", ...bad], { env }, (e) => res(e ? e.code : 0))); assert.equal(x, 2, bad.join(" ")); }
ok("CLI: doorman-bridge wait returns none on timeout and the job when one is approved; --seen; malformed options exit 2");

// 6. no new powers; a per-job (bound) server has no wait_for_job
assert.equal(snap(), before, "config, decisions and pending are byte-identical");
const m2 = spawn(CLI, ["mcp"], { env: { ...env, DOORMAN_BRIDGE_AGENT: "run-a", DOORMAN_BRIDGE_JOB: "doorman-t--b00005" } }); let o2 = ""; m2.stdout.on("data", (d) => (o2 += d));
m2.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) + "\n" + JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "wait_for_job", arguments: {} } }) + "\n");
for (let t = 0; t < 50 && (o2.match(/"id":/g) || []).length < 2; t++) await new Promise((res) => setTimeout(res, 100)); m2.stdin.end();
const o2m = o2.trim().split("\n").map((l) => JSON.parse(l));
assert.ok(!o2m[0].result.tools.some((t) => t.name === "wait_for_job")); assert.match(o2m[1].result.content[0].text, /isn't available in a run for one job/);
ok("no new powers: config, decisions and pending byte-identical; a per-job run has no wait_for_job");
mcp.stdin.end(); bridge.stop?.(); fs.rmSync(base, { recursive: true, force: true });
console.log("bridge-wait: all pass"); process.exit(0);
