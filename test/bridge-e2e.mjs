// node test/bridge-e2e.mjs  (J371: the Doorman bridge end to end, isolated: a temporary state and config folder, the
// relay's bridge side in this process with recorders for outcome routing and held questions, the CLI and the MCP
// server as separate processes like any harness would run them)
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawn, execFile } from "node:child_process";
const base = fs.mkdtempSync(path.join(os.tmpdir(), "j371-")), st = path.join(base, "state"), cfg = path.join(base, "cfg"), cache = path.join(base, "cache");
fs.mkdirSync(path.join(cfg, "hyprpi", "worlds"), { recursive: true });
fs.writeFileSync(path.join(cfg, "hyprpi", "worlds", "world-t.json"), JSON.stringify({ sandbox: "world-t", access: "safe", projects: ["alpha"] }));
fs.writeFileSync(path.join(cfg, "hyprpi", "sbx-relay.json"), JSON.stringify({ sandboxes: [{ name: "doorman-t", doorman_for: "world-t", host_agents: "bridge" }] }));
process.env.DOORMAN_STATE = st; process.env.XDG_CACHE_HOME = cache; process.env.XDG_CONFIG_HOME = cfg;
const { startBridge } = await import("../docker/bridge/relay-bridge.mjs");
const { newJob } = await import("../docker/bridge/core.mjs");
const CLI = new URL("../docker/bridge/doorman-bridge", import.meta.url).pathname;
const REQ = path.join(st, "requests"); fs.mkdirSync(REQ, { recursive: true, mode: 0o700 });
const jobRecord = (id, patch) => { // the relay's own write (J368 jobRecord: history appended, the rest merged)
  const f = path.join(REQ, `${id}.json`); let cur = {}; try { cur = JSON.parse(fs.readFileSync(f, "utf8")); } catch { /* */ }
  const history = [...(cur.history || []), ...(patch.history || [])].slice(-50);
  fs.writeFileSync(f + ".tmp", JSON.stringify({ ...cur, ...patch, history }), { mode: 0o600 }); fs.renameSync(f + ".tmp", f);
};
const told = [], held = [], logs = []; let failHold = false;
const bridge = startBridge({ stateDir: st, log: (o) => logs.push(o), jobRecord, tellOutcome: (s, a, t) => told.push({ s, a, t }), holdQuestion: (rec, n, text) => { if (failHold) throw new Error("too many held"); const hid = `doorman-t--${crypto.randomBytes(3).toString("hex")}`; held.push({ hid, rec: rec.id, n, text }); return hid; } });
const env = { ...process.env, DOORMAN_STATE: st, XDG_CACHE_HOME: cache, XDG_CONFIG_HOME: cfg,
  DOORMAN_SETTINGS_CMD: JSON.stringify(["sh", "-c", 'echo "{\\"sandbox\\":\\"$0\\",\\"gateway\\":{\\"level\\":\\"safe\\"}}"']),
  DOORMAN_PROPOSE_CMD: JSON.stringify(["sh", "-c", 'echo "{\\"ok\\":true,\\"id\\":\\"doorman-t--feed01\\",\\"text\\":\\"held for the owner\\"}"']) };
const cli = (...a) => new Promise((res) => execFile(CLI, ["--json", ...a], { env, timeout: 30000 }, (e, out, err) => { let j = null; try { j = JSON.parse(out); } catch { /* */ } res({ code: e ? e.code : 0, j, out, err }); }));
const ok = (m) => console.log("ok " + m);
const mk = (id, extra = {}) => { const j = newJob({ id, sandbox: "world-t", asker: "Alpha", action: "Request drafted by Doorman-T (the Doorman of world-t) for Alpha.\nWhy: test\nTried: nothing\nAction asked for: open cube-art", timeLimitS: 3600, ...extra }); jobRecord(id, j); return j; };
// a snapshot of everything the bridge must never write: config, decisions, pending
const snap = () => { const h = crypto.createHash("sha256"); const walk = (d) => { let es = []; try { es = fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)); } catch { return; } for (const e of es) { const p = path.join(d, e.name); h.update(p); if (e.isDirectory()) walk(p); else h.update(fs.readFileSync(p)); } }; walk(cfg); walk(path.join(st, "decisions")); walk(path.join(st, "pending")); return h.digest("hex"); };
const before = snap();

mk("doorman-t--a00001");
// 1. list / show: only the approved text, the job waiting
let r = await cli("list"); assert.equal(r.code, 0); assert.equal(r.j.length, 1); assert.equal(r.j[0].state, "waiting");
r = await cli("show", "doorman-t--a00001"); assert.match(r.j.approved.action, /Action asked for: open cube-art/);
ok("list and show: the approved job");
// 2. claims are atomic: 10 simultaneous claimers, exactly one wins
const claims = await Promise.all(Array.from({ length: 10 }, (_, i) => cli("claim", "doorman-t--a00001", "--by", `agent-${i}`)));
const winners = claims.filter((c) => c.code === 0 && c.j?.ok);
assert.equal(winners.length, 1, `exactly one claim wins (${winners.length})`); assert.ok(claims.filter((c) => c.code === 1).every((c) => /claimed by agent-/.test(c.j.text)));
const winner = winners[0].j; const who = JSON.parse(fs.readFileSync(path.join(REQ, "doorman-t--a00001.json"), "utf8")).claim.by;
ok(`10 simultaneous claims: exactly one (${who})`);
// 3. ask: a held item for the owner, the job waits; the answer comes back through the relay's decision
r = await cli("ask", "doorman-t--a00001", "--by", who, "Which profile should open it?");
assert.equal(r.code, 0, r.out + r.err); assert.equal(held.length, 1); assert.equal(held[0].n, 1); assert.match(held[0].text, /Which profile/);
assert.equal((await cli("show", "doorman-t--a00001")).j.state, "asked");
assert.equal(JSON.parse(fs.readFileSync(path.join(REQ, "doorman-t--a00001.json"), "utf8")).questions[0].held_id, held[0].hid, "the job links the held item");
assert.equal(bridge.answer("doorman-t--a00001", 1, "forged", "doorman-t--000000"), false, "another held item can't answer it");
assert.equal(bridge.answer("doorman-t--a00001", 1, "G's own profile", held[0].hid), true);
r = await cli("show", "doorman-t--a00001"); assert.equal(r.j.state, "claimed"); assert.equal(r.j.questions[0].answer, "G's own profile");
ok("ask: a held item, the job waits; the owner's answer comes back in show");
// 3b. a question that can't be held is undone (the job doesn't hang in "asked")
{ mk("doorman-t--a00009"); const c = await cli("claim", "doorman-t--a00009", "--by", "x"); assert.equal(c.code, 0); failHold = true;
  const q = await cli("ask", "doorman-t--a00009", "--by", "x", "q?"); failHold = false; assert.equal(q.code, 1); assert.match(q.j.text, /couldn't be put to the owner/);
  const rr = JSON.parse(fs.readFileSync(path.join(REQ, "doorman-t--a00009.json"), "utf8")); assert.equal(rr.state, "claimed"); assert.equal(rr.questions.length, 0);
  ok("a question that can't be held is undone and refused"); }
// 4. report: through the outcome routing (asker + coordinator) and the log; final
r = await cli("report", "doorman-t--a00001", "done", "--by", who, "--summary", "Opened it in G's profile.", "--ran", "g_open_url.py --agent file:///x");
assert.equal(r.code, 0, r.out + r.err); assert.equal(told.length, 1); assert.equal(told[0].a, "Alpha"); assert.match(told[0].t, /ended done: Opened it/);
assert.ok(logs.some((l) => l.op === "host_job" && l.state === "done" && l.ran[0].startsWith("g_open_url")));
assert.equal((await cli("claim", "doorman-t--a00001", "--by", "late")).code, 1, "done is final");
ok("report: routed to the asker and its coordinator, logged with what ran; final");
// 5. leases: a claimer that disappears loses the job; past the time limit → no_report, routed
mk("doorman-t--a00002"); r = await cli("claim", "doorman-t--a00002", "--by", "crasher", "--lease", "60"); assert.equal(r.code, 0);
const rec2 = JSON.parse(fs.readFileSync(path.join(REQ, "doorman-t--a00002.json"), "utf8"));
jobRecord("doorman-t--a00002", { claim: { ...rec2.claim, until: new Date(Date.now() - 1000).toISOString() } }); // the lease ran out
r = await cli("list"); assert.ok(r.j.some((j) => j.id === "doorman-t--a00002"), "back in the list");
r = await cli("claim", "doorman-t--a00002", "--by", "second"); assert.equal(r.code, 0);
mk("doorman-t--a00003", { timeLimitS: 60 }); await cli("claim", "doorman-t--a00003", "--by", "slow");
const rec3 = JSON.parse(fs.readFileSync(path.join(REQ, "doorman-t--a00003.json"), "utf8"));
jobRecord("doorman-t--a00003", { claimed_at: new Date(Date.now() - 120000).toISOString(), claim: { ...rec3.claim, until: new Date(Date.now() - 1000).toISOString() } });
bridge.sweepAll(); assert.equal(JSON.parse(fs.readFileSync(path.join(REQ, "doorman-t--a00003.json"), "utf8")).state, "no_report"); assert.ok(told.some((t) => /no report/.test(t.t)));
ok("an expired lease returns the job; past the time limit it ends no_report and is routed");
// 6. the bridge can't approve, deny, edit, create jobs or change settings; settings are read, proposals only proposed
for (const bad of [["approve", "doorman-t--a00002"], ["deny", "doorman-t--a00002"], ["edit", "doorman-t--a00002"], ["create", "x"], ["set", "world-t", "level=open"]]) assert.equal((await cli(...bad)).code, 2, `no ${bad[0]} command`);
const raw = path.join(st, "bridge", "in", `${crypto.randomBytes(12).toString("hex")}.json`);
for (const op of ["approve", "deny", "edit", "create", "set"]) { fs.writeFileSync(raw, JSON.stringify({ op, id: "doorman-t--a00002", by: "x" })); await bridge.scan(); }
assert.equal(JSON.parse(fs.readFileSync(path.join(REQ, "doorman-t--a00002.json"), "utf8")).state, "claimed", "a raw request for another operation changes nothing");
r = await cli("settings", "world-t"); assert.equal(r.code, 0); assert.equal(r.j.settings.gateway.level, "safe");
r = await cli("propose", "world-t", "level=open"); assert.equal(r.code, 0); assert.match(r.j.text, /held for the owner/);
// 7. the MCP server: initialize, tools/list, and every tool called once
const mcp = spawn(CLI, ["mcp"], { env: { ...env, DOORMAN_BRIDGE_AGENT: "mcp-test" } }); let mout = ""; mcp.stdout.on("data", (d) => (mout += d));
const rpc = (m) => mcp.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...m }) + "\n");
mcp.stdin.write("null\n[]\n42\n{\"jsonrpc\":\"2.0\",\"id\":7}\n"); // (BridgeReview: odd valid JSON must not crash it)
rpc({ id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } }); rpc({ method: "notifications/initialized" }); rpc({ id: 2, method: "tools/list" });
mk("doorman-t--a00004");
const calls = [["list_jobs", {}], ["show_job", { id: "doorman-t--a00004" }], ["claim_job", { id: "doorman-t--a00004" }], ["renew_job", { id: "doorman-t--a00004" }], ["ask_owner", { id: "doorman-t--a00004", question: "ok?" }],
  ["read_settings", { sandbox: "world-t" }], ["propose_settings", { sandbox: "world-t", changes: { level: "open" } }], ["release_job", { id: "doorman-t--a00004" }], ["report_job", { id: "doorman-t--a00004", state: "done", summary: "x" }]];
calls.forEach(([name, args], i) => rpc({ id: 10 + i, method: "tools/call", params: { name, arguments: args } }));
for (let t = 0; t < 200 && (mout.match(/"id":1\d/g) || []).length < calls.length; t++) await new Promise((res) => setTimeout(res, 100));
mcp.stdin.end();
const msgs = mout.trim().split("\n").map((l) => JSON.parse(l)), byId = Object.fromEntries(msgs.map((m) => [m.id, m]));
assert.equal(byId[1].result.serverInfo.name, "doorman-bridge"); assert.equal(byId[7].error.code, -32600, "an invalid request gets an error, the server stays up"); assert.equal(byId[2].result.tools.length, 9);
assert.ok(!byId[2].result.tools.some((x) => /approve|deny|edit|create|set_|write/.test(x.name)), "no tool can decide or write");
const res = (i) => JSON.parse(byId[10 + i].result.content[0].text);
assert.equal(res(0).jobs.length, 1); assert.equal(res(2).ok, true); assert.equal(res(3).ok, true); assert.equal(res(4).ok, true); assert.equal(res(5).ok, true); assert.equal(res(6).ok, true);
assert.equal(res(7).ok, true); assert.equal(JSON.parse(fs.readFileSync(path.join(REQ, "doorman-t--a00004.json"), "utf8")).state, "asked", "released with an open question: stays asked, unclaimed");
assert.equal(res(8).ok, false, "no report without a claim");
ok("MCP: initialize, 9 tools (none decides or writes), every tool callable");
// 7b. (BridgeReview) parallel token saves don't race: 24 processes, 24 tokens kept
{ const { saveToken, tokens } = await import("../docker/bridge/client.mjs");
  await Promise.all(Array.from({ length: 24 }, (_, i) => new Promise((res) => execFile(process.execPath, ["--input-type=module", "-e", `import { saveToken } from ${JSON.stringify(new URL("../docker/bridge/client.mjs", import.meta.url).href)}; saveToken("doorman-t--b${String(i).padStart(5, "0")}", "t${i}")`], { env }, res))));
  const t = tokens(); assert.equal(Object.keys(t).filter((k) => k.startsWith("doorman-t--b")).length, 24); assert.equal(t["doorman-t--b00007"], "t7");
  const st2 = fs.statSync(path.join(cache, "doorman-bridge", "tokens", "doorman-t--b00007")); assert.equal(st2.mode & 0o777, 0o600); void saveToken;
  ok("24 parallel token saves: all kept, files 600"); }
// 7c. (J387, RunnerReview HIGH) a job-bound MCP server (a per-job run) can't touch another job, even with that job's token cached
{ mk("doorman-t--e00001"); mk("doorman-t--e00002");
  const ca = await cli("claim", "doorman-t--e00001", "--by", "run-a"), cb = await cli("claim", "doorman-t--e00002", "--by", "run-b"); assert.equal(ca.code, 0); assert.equal(cb.code, 0);
  const m2 = spawn(CLI, ["mcp"], { env: { ...env, DOORMAN_BRIDGE_AGENT: "run-a", DOORMAN_BRIDGE_JOB: "doorman-t--e00001" } }); let o2 = ""; m2.stdout.on("data", (d) => (o2 += d));
  const r2 = (m) => m2.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...m }) + "\n");
  r2({ id: 1, method: "initialize", params: {} }); r2({ id: 2, method: "tools/list" });
  r2({ id: 3, method: "tools/call", params: { name: "report_job", arguments: { id: "doorman-t--e00002", state: "done", summary: "not mine" } } });
  r2({ id: 4, method: "tools/call", params: { name: "list_jobs", arguments: { all: true } } });
  r2({ id: 5, method: "tools/call", params: { name: "release_job", arguments: { id: "doorman-t--e00001" } } });
  r2({ id: 6, method: "tools/call", params: { name: "read_settings", arguments: { sandbox: "world-t" } } });
  for (let t = 0; t < 100 && (o2.match(/"id":[3-6]/g) || []).length < 4; t++) await new Promise((res) => setTimeout(res, 100)); m2.stdin.end();
  const by2 = Object.fromEntries(o2.trim().split("\n").map((l) => JSON.parse(l)).map((m) => [m.id, m])), body = (i) => JSON.parse(by2[i].result.content[0].text);
  assert.deepEqual(by2[2].result.tools.map((x) => x.name).sort(), ["ask_owner", "list_jobs", "renew_job", "report_job", "show_job"]);
  assert.equal(body(3).ok, false); assert.match(body(3).text, /works job doorman-t--e00001 only/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(REQ, "doorman-t--e00002.json"), "utf8")).state, "claimed", "the other job is untouched");
  assert.deepEqual(body(4).jobs.map((j) => j.id), ["doorman-t--e00001"]); assert.equal(body(5).ok, false); assert.equal(body(6).ok, false);
  ok("a job-bound MCP server works its own job only (no cross-job report, list, release or settings)"); }
// 8. nothing the bridge did wrote config, a decision or a held item
assert.equal(snap(), before, "config, decisions/ and pending/ are byte-identical");
ok("no bridge command or MCP tool wrote config, decisions or held items");
bridge.stop(); fs.rmSync(base, { recursive: true, force: true });
console.log("bridge-e2e: all pass");
