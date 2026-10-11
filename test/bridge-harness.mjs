// node test/bridge-harness.mjs  (J425: the per-job runner's harness per world: claude-code / codex / pi adapters)
// Offline and isolated (temp state + config). Unit checks of the setting, what each adapter enforces (gaps), its argv; then a real
// `doorman-bridge run-job` per harness against the relay's bridge side in this process, with a STUB agent standing in for the harness:
// the stub finds the bridge MCP server exactly where that harness would (claude: --mcp-config file; codex: -c mcp_servers…; pi: the
// private agent dir's mcp.json), starts it, and reports the job through it. Proves the wiring (job-bound token, no token in argv or log).
// The real binaries: test/bridge-harness-live.mjs (manual, costs model calls).
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
const base = fs.mkdtempSync(path.join(os.tmpdir(), "j425-")), st = path.join(base, "state"), cfg = path.join(base, "cfg"), W = path.join(cfg, "hyprpi", "worlds");
fs.mkdirSync(W, { recursive: true });
const world = (sb, gateway) => fs.writeFileSync(path.join(W, `${sb}.json`), JSON.stringify({ sandbox: sb, ...(gateway ? { gateway } : {}) }));
// fake harness binaries on PATH (J425Review #2: the runner checks the command exists)
const BIN = path.join(base, "bin"); fs.mkdirSync(BIN); for (const b of ["claude", "codex", "pi", "pi2"]) fs.writeFileSync(path.join(BIN, b), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
const REALPATH = process.env.PATH; process.env.PATH = `${BIN}:${REALPATH}`;
process.env.DOORMAN_STATE = st; process.env.XDG_CONFIG_HOME = cfg; delete process.env.DOORMAN_RUNNER_CMD; delete process.env.DOORMAN_RUNNER_MODEL;
const H = await import("../docker/bridge/harness.mjs");
const { modeFor, empty } = await import("../docker/bridge/registry.mjs");
const { validateChanges } = await import("../docker/research/gateway-admin.mjs");
let n = 0; const ok = (m) => { n++; console.log("ok " + m); };

// 1. the setting
world("world-d"); world("world-c", { host_runner: "codex" }); world("world-p", { host_runner: { harness: "pi", command: [path.join(BIN, "pi2")], model: "nv-inference/x" } });
world("world-x", { host_runner: "aider" }); world("world-b", { host_runner: { harness: "pi", command: "pi -p" } }); world("world-m", { host_runner: { harness: "codex", model: "bad model!" } });
assert.deepEqual(H.runnerChoice("world-d"), { harness: "claude-code", command: ["claude"], model: "", source: "default" });
assert.equal(H.runnerChoice("world-c").harness, "codex"); assert.deepEqual(H.runnerChoice("world-c").command, ["codex"]);
assert.deepEqual(H.runnerChoice("world-p"), { harness: "pi", command: [path.join(BIN, "pi2")], model: "nv-inference/x", source: "world-p.json" });
assert.match(H.runnerChoice("world-x").error, /unknown host_runner harness "aider"/);
for (const m of [false, 0, null, "", "bad model!"]) { world("world-mm", { host_runner: { harness: "codex", model: m } }); assert.match(H.runnerChoice("world-mm").error, /model must be a model id/, `model ${JSON.stringify(m)} refused (Citecheck)`); } fs.unlinkSync(path.join(W, "world-mm.json")); assert.match(H.runnerChoice("world-b").error, /argv array/); assert.match(H.runnerChoice("world-m").error, /model id/);
assert.equal(H.runnerChoice("world-none").harness, "claude-code", "no worlds file: the default");
process.env.DOORMAN_RUNNER_CMD = JSON.stringify([path.join(BIN, "claude")]); assert.deepEqual(H.runnerChoice("world-d").command, [path.join(BIN, "claude")]); assert.deepEqual(H.runnerChoice("world-c").command, ["codex"], "DOORMAN_RUNNER_CMD is claude-code's only"); delete process.env.DOORMAN_RUNNER_CMD;
fs.writeFileSync(path.join(W, "zz.json"), JSON.stringify({ sandbox: "world-c" })); assert.match(H.runnerChoice("world-c").error, /ambiguous/); fs.unlinkSync(path.join(W, "zz.json"));
assert.equal(validateChanges({ host_runner: "pi" }).ok, false, "a sandbox can't propose host_runner"); assert.equal(validateChanges({ host_runner: "pi" }, { admin: true }).ok, true); assert.equal(validateChanges({ host_runner: "aider" }, { admin: true }).ok, false);
// (J425Review #2) not installed → unavailable; (#4) an unreadable worlds file that may be this sandbox's → unavailable, not the default
world("world-gone", { host_runner: { harness: "pi", command: ["/definitely/not-installed"] } }); assert.match(H.runnerChoice("world-gone").error, /isn't installed or runnable/);
process.env.PATH = REALPATH.split(":").filter((d) => !fs.existsSync(path.join(d, "codex"))).join(":"); world("world-nocodex", { host_runner: "codex" }); assert.match(H.runnerChoice("world-nocodex").error, /codex isn't installed/); process.env.PATH = `${BIN}:${REALPATH}`;
fs.writeFileSync(path.join(W, "world-bad.json"), '{"sandbox": "world-bad", "gateway": {"host_runner": "pi"'); assert.match(H.runnerChoice("world-bad").error, /world-bad\.json doesn't parse/);
fs.writeFileSync(path.join(W, "other-name.json"), '{"sandbox": "world-bad2", "gateway": '); assert.match(H.runnerChoice("world-bad2").error, /other-name\.json doesn't parse/);
assert.match(H.runnerChoice("world-d").error, /other-name\.json doesn't parse/, "a corrupt file can't be identified: it blocks every world (J425Recheck)");
fs.unlinkSync(path.join(W, "world-bad.json")); fs.unlinkSync(path.join(W, "other-name.json"));
// (J425Recheck #2) an unreadable file (its sandbox unknown) or worlds folder, a non-object file, a non-object gateway: all unavailable
if (process.getuid() !== 0) {
  fs.writeFileSync(path.join(W, "A.json"), JSON.stringify({ sandbox: "world-g", gateway: { host_runner: "pi" } })); fs.chmodSync(path.join(W, "A.json"), 0o000);
  assert.match(H.runnerChoice("world-g").error, /A\.json can't be read/); assert.match(H.runnerChoice("world-d").error, /A\.json can't be read/, "an unreadable file blocks every world (its sandbox is unknown)");
  fs.chmodSync(path.join(W, "A.json"), 0o600); fs.unlinkSync(path.join(W, "A.json"));
  fs.chmodSync(W, 0o000); assert.match(H.runnerChoice("world-d").error, /worlds folder can't be read/); fs.chmodSync(W, 0o755);
}
fs.writeFileSync(path.join(W, "world-null.json"), "null"); assert.match(H.runnerChoice("world-null").error, /isn't a JSON object/); fs.unlinkSync(path.join(W, "world-null.json"));
world("world-gs", "pi"); assert.match(H.runnerChoice("world-gs").error, /"gateway" isn't an object/); fs.unlinkSync(path.join(W, "world-gs.json"));
fs.writeFileSync(path.join(W, "A.json"), '{"sandbox":"world\\u002dg2","gateway":"pi"}'); assert.match(H.runnerChoice("world-g2").error, /A\.json: "gateway" isn't an object/, "judged by the decoded sandbox name, not the raw text"); fs.unlinkSync(path.join(W, "A.json"));
fs.writeFileSync(path.join(W, "A.json"), '{"sandbox":'); assert.match(H.runnerChoice("world-d").error, /A\.json doesn't parse/); fs.unlinkSync(path.join(W, "A.json"));
// (J425Recheck #3) the host's levels module: present but broken or incomplete → every runner refused; absent → not checked (this branch)
for (const [what, body, re] of [["throws", 'throw new Error("boom");', /doesn't load \(boom\)/], ["lacks exports", "export const x = 1;", /lacks loadLevels/],
  ["allows only claude-code", 'export const loadLevels = () => ({ levels: { runner_harnesses: ["claude-code"] } }); export const allowedHarness = (l, h) => l.runner_harnesses.includes(h);', null]]) {
  const T2 = fs.mkdtempSync(path.join(base, "lv-")); fs.mkdirSync(path.join(T2, "bridge")); fs.mkdirSync(path.join(T2, "research"));
  fs.copyFileSync(new URL("../docker/bridge/harness.mjs", import.meta.url), path.join(T2, "bridge", "harness.mjs")); fs.writeFileSync(path.join(T2, "research", "mode.mjs"), fs.readFileSync(new URL("../docker/research/mode.mjs", import.meta.url), "utf8").replace('from "./levels.mjs"', 'from "./levels-real.mjs"')); fs.copyFileSync(new URL("../docker/research/levels.mjs", import.meta.url), path.join(T2, "research", "levels-real.mjs")); // (J380 v3: mode.mjs itself reads the real levels module; the stub below is only what harness.mjs sees)
  fs.writeFileSync(path.join(T2, "research", "levels.mjs"), body);
  const H2 = await import(path.join(T2, "bridge", "harness.mjs"));
  if (re) assert.match(H2.runnerChoice("world-d").error, re, what);
  else { assert.equal(H2.runnerChoice("world-d").harness, "claude-code"); assert.match(H2.runnerChoice("world-c").error, /host's levels don't allow the codex runner/); }
}
ok("host_runner per world: default claude-code, a name or { harness, command, model }; invalid or ambiguous → error; Angus-only (not proposable)");

// 2. what each enforces
const F = path.join(base, "proj"); fs.mkdirSync(F);
assert.deepEqual(H.limitsOf("claude-code", ["Read", "Write"], [F]).gaps, []);
// (J425Review #1, HIGH) a granted Bash, even a scoped rule, runs outside Claude Code's file limits: folders advisory
for (const b of ["Bash", "Bash(git status)"]) assert.match(H.limitsOf("claude-code", ["Read", b], [F]).gaps[0], /folders aren't enforced for the shell/);
const cx = H.limitsOf("codex", ["Read", "Write", "Bash(git status)"], [F]);
assert.deepEqual(cx.granted, ["Read", "Write"]); assert.equal(cx.dropped[0].tool, "Bash(git status)"); assert.equal(cx.gaps.length, 2); assert.match(cx.gaps.join(" "), /reads aren't limited/);
assert.equal(H.limitsOf("codex", [], []).gaps.length, 2, "codex: always advisory (a shell, reads)");
assert.deepEqual(H.limitsOf("pi", [], []).gaps, [], "pi with only the bridge tools: nothing to escape with, enforced");
const pl = H.limitsOf("pi", ["Read", "WebFetch", "Write(./x)"], [F]); assert.deepEqual(pl.granted, ["Read"]); assert.deepEqual(pl.dropped.map((d) => d.tool), ["WebFetch", "Write(./x)"]); assert.match(pl.gaps[0], /folders aren't enforced/);
assert.match(H.limitsOf("claude-code", ["default", "Read"], []).dropped[0].why, /not a known tool/);
// J428 scopes: read-only and hidden paths
assert.deepEqual(H.limitsOf("claude-code", ["Read"], [F], { readOnly: [F], hidden: [F + "/secret"] }).gaps, [], "claude-code: deny rules hold them");
assert.match(H.limitsOf("codex", ["Read"], [F], { hidden: [F + "/secret"] }).gaps.join(" "), /hidden paths aren't hidden/);
assert.match(H.limitsOf("pi", ["Read"], [F], { readOnly: [F] }).gaps[0], /read-only folders and hidden paths included/);
ok("limits: claude-code enforces tools and folders; codex always advisory (reads, shell), writes/network enforced; pi enforces its tool list, folders advisory once a file/shell tool is granted; rule-scoped or unknown tools dropped, never widened");

// 3. the label the held item and card show, and the bridge mode
assert.match(H.runnerLabel("world-d").label, /: claude-code \(limits enforced\)$/); assert.match(H.runnerLabel("world-d", { tools: ["Bash"] }).label, /: claude-code \(limits advisory: folders aren't enforced for the shell/);
const lp = H.runnerLabel("world-p", { tools: ["Read"], folders: [F] }); assert.equal(lp.advisory, true); assert.match(lp.label, /: pi \(limits advisory: folders aren't enforced/);
assert.match(H.runnerLabel("world-c").label, /: codex \(limits advisory: reads aren't limited/);
assert.equal(H.runnerLabel("world-x").ok, false);
assert.deepEqual(modeFor(empty(), "world-p", { runnerOn: true, runnerLabel: lp.label }).agents, [lp.label]);
assert.equal(modeFor(empty(), "world-x", { runnerOn: true, runnerLabel: null }).mode, "agent-free", "an invalid host_runner isn't counted: refused at once");
assert.deepEqual(modeFor(empty(), "w", { runnerOn: true }).agents, ["the per-job runner (on demand)"], "callers without a label keep the old text");
const src = fs.readFileSync(new URL("../docker/sbx-relay.mjs", import.meta.url), "utf8");
assert.match(src, /If approved, a host agent takes it through the bridge: \$\{hm\.agents\.map\(\(x\) => \/\^the per-job runner\/\.test\(x\) \? jobRunner : x\)\.join\(" or "\)/, "the held item names the bridge's agents, the runner as it would run THIS job");
assert.match(src, /const jr = harnessLabel\(this\.doormanFor, \{ tools: sc\.tools, folders: sc\.folders\.map\(\(x\) => x\.path\), readOnly: [^\n]*hidden: sc\.hidden \|\| \[\] \}\);/, "judged with the draft's own tools, folders, read-only and hidden paths (J428)");
assert.match(src, /runnerLabel: \(sbName\) => \{[^\n]*\n[^\n]*harnessWorldLabel\(sbName, \{ extraTools: [^\n]*return r\.ok \? r\.label : null; \}/, "the relay hands the world's label (judged with a draft's default tools), or null, to the bridge");
fs.writeFileSync(path.join(cfg, "hyprpi", "sbx-relay.json"), JSON.stringify({ sandboxes: [{ name: "doorman-p", doorman_for: "world-p", bridge: { tools: ["Read", "Write"], folders: [F] } }] }));
const dw = H.describeWorlds(); assert.ok(dw.some((l) => /^WARNING world-p: pi \(limits advisory/.test(l))); assert.ok(dw.some((l) => /^ok +world-d: claude-code \(limits enforced; judged with a draft's default tools/.test(l))); assert.ok(dw.some((l) => /^ERROR +world-x/.test(l)));
// (Citecheck W2) world-level lines are judged with a draft's DEFAULT tools (J428), not the old bridge defaults: pi with none set is advisory
fs.writeFileSync(path.join(cfg, "hyprpi", "sbx-relay.json"), JSON.stringify({ sandboxes: [] }));
assert.match(H.worldLabel("world-p").label, /: pi \(limits advisory: folders aren't enforced/); assert.equal(H.worldLabel("world-p").advisory, true);
assert.ok(H.describeWorlds().some((l) => /^WARNING world-p: pi \(limits advisory/.test(l)), "no bridge defaults: still advisory (the default draft tools)");
assert.match(H.worldLabel("world-d").label, /: claude-code \(limits enforced; judged/); assert.match(H.worldLabel("world-d", { extraTools: ["Bash"] }).label, /claude-code \(limits advisory/);
// a corrupt (or non-object) worlds file shows as ERROR, never "(no worlds)"
{ const C = path.join(base, "cfg-corrupt"); fs.mkdirSync(path.join(C, "worlds"), { recursive: true }); fs.writeFileSync(path.join(C, "worlds", "world-z.json"), "{oops");
  assert.match(H.describeWorlds(C).join("\n"), /^ERROR +world-z\.json: can't be read or parsed/); fs.writeFileSync(path.join(C, "worlds", "world-z.json"), "[]"); assert.match(H.describeWorlds(C).join("\n"), /^ERROR +world-z\.json: isn't a JSON object/); }
ok("the held item / card / runner --install name the harness: 'limits enforced' or 'limits advisory: …' (WARNING), an invalid setting is ERROR and not counted");

// 4. argv per adapter (no token in argv)
const tmp = fs.mkdtempSync(path.join(base, "run-")), work = path.join(tmp, "work"); fs.mkdirSync(work);
const job = { id: "world-t--a00001", approved: { action: "x", tools: ["Read", "Write"], folders: [F], time_limit_s: 60 }, questions: [] };
const mcpEnv = { DOORMAN_STATE: st, DOORMAN_BRIDGE_TOKEN: "SECRET-TOKEN", DOORMAN_BRIDGE_JOB: job.id, DOORMAN_BRIDGE_AGENT: "runner:x" }, cli = "/opt/doorman-bridge";
const pc = H.adapterPlan(job, { tmp, work, cli, mcpEnv, choice: H.runnerChoice("world-d") });
assert.deepEqual(pc.argv.slice(0, 2), ["claude", "-p"]); for (const f of ["--strict-mcp-config", "--restricted", "--no-session-persistence"]) assert.ok(pc.argv.includes(f));
assert.equal(pc.argv[pc.argv.indexOf("--tools") + 1], "Read,Write"); assert.deepEqual(pc.argv.slice(pc.argv.indexOf("--add-dir"), pc.argv.indexOf("--add-dir") + 2), ["--add-dir", F]); assert.equal(pc.cwd, F);
const pcx = H.adapterPlan(job, { tmp: fs.mkdtempSync(path.join(base, "run-")), work, cli, mcpEnv, choice: H.runnerChoice("world-c") });
const a = pcx.argv.join(" ");
for (const f of ["exec", "--ephemeral", "--ignore-user-config", "--ignore-rules", "--disable apps", "-s workspace-write", "sandbox_workspace_write.network_access=false", "exclude_slash_tmp=true", 'approval_policy="never"']) assert.ok(a.includes(f), f);
assert.equal(pcx.argv.at(-1), "-", "prompt on stdin"); assert.equal(pcx.argv[pcx.argv.indexOf("-C") + 1], F);
assert.equal(H.adapterPlan({ ...job, approved: { ...job.approved, tools: ["Read"] } }, { tmp: fs.mkdtempSync(path.join(base, "run-")), work, cli, mcpEnv, choice: H.runnerChoice("world-c") }).argv.join(" ").includes("-s read-only"), true, "no writing tool: read-only");
const tp = fs.mkdtempSync(path.join(base, "run-")), pp = H.adapterPlan(job, { tmp: tp, work, cli, mcpEnv, choice: H.runnerChoice("world-p") });
assert.deepEqual(pp.argv.slice(0, 2), [path.join(BIN, "pi2"), "-p"]); assert.equal(pp.argv[pp.argv.indexOf("--tools") + 1], "mcp__doorman_bridge__list_jobs,mcp__doorman_bridge__show_job,mcp__doorman_bridge__renew_job,mcp__doorman_bridge__ask_owner,mcp__doorman_bridge__report_job,read,write");
assert.ok(pp.argv.includes("--no-session") && pp.argv.includes("--no-approve") && pp.argv.includes("--no-skills")); assert.deepEqual(pp.argv.slice(-2), ["--model", "nv-inference/x"]);
const pm = JSON.parse(fs.readFileSync(path.join(pp.env.PI_CODING_AGENT_DIR, "mcp.json"), "utf8")); assert.deepEqual(Object.keys(pm.mcpServers), ["doorman-bridge"], "the bridge is pi's only MCP server");
for (const p of [pc, pcx, pp]) assert.ok(!p.argv.join(" ").includes("SECRET-TOKEN"), "no token in argv");
const wr = path.join(tp, "bridge-mcp"); assert.equal(fs.statSync(wr).mode & 0o777, 0o700); assert.match(fs.readFileSync(wr, "utf8"), /DOORMAN_BRIDGE_TOKEN='SECRET-TOKEN'/);
ok("argv: claude-code as J387; codex: exec, ephemeral, no user config/rules/apps, sandbox read-only or workspace-write, network off, /tmp excluded; pi: private agent dir with only the bridge MCP, --tools allowlist; tokens only in a 0700 wrapper / 0600 config");

// 5. a real run-job per harness, with a stub agent
const { startBridge } = await import("../docker/bridge/relay-bridge.mjs");
const { newJob } = await import("../docker/bridge/core.mjs");
const REQ = path.join(st, "requests"); fs.mkdirSync(REQ, { recursive: true, mode: 0o700 });
const jobRecord = (id, patch) => { const f = path.join(REQ, `${id}.json`); let cur = {}; try { cur = JSON.parse(fs.readFileSync(f, "utf8")); } catch { /* */ } fs.writeFileSync(f + ".tmp", JSON.stringify({ ...cur, ...patch, history: [...(cur.history || []), ...(patch.history || [])] }), { mode: 0o600 }); fs.renameSync(f + ".tmp", f); };
const told = []; const bridge = startBridge({ stateDir: st, log: () => {}, jobRecord, tellOutcome: (s, a, t) => told.push(t), holdQuestion: () => null, sandboxes: () => [] });
const STUB = path.join(base, "stub-agent.mjs"), SEEN = path.join(base, "seen");
fs.writeFileSync(STUB, `#!/usr/bin/env node
import fs from "node:fs"; import { spawn } from "node:child_process";
const argv = process.argv.slice(2), harness = process.env.STUB_HARNESS; let prompt = ""; for await (const c of process.stdin) prompt += c;
let cmd, args = [], env = {};
if (harness === "claude-code") { const m = JSON.parse(fs.readFileSync(argv[argv.indexOf("--mcp-config") + 1], "utf8")).mcpServers["doorman-bridge"]; cmd = m.command; args = m.args; env = m.env; }
else if (harness === "codex") { const c = argv.find((x) => x.startsWith("mcp_servers.doorman-bridge=")); cmd = JSON.parse(/command=("[^"]+")/.exec(c)[1]); }
else { const m = JSON.parse(fs.readFileSync(process.env.PI_CODING_AGENT_DIR + "/mcp.json", "utf8")).mcpServers["doorman-bridge"]; cmd = m.command; }
const wtok = harness === "claude-code" ? env.DOORMAN_BRIDGE_TOKEN : /DOORMAN_BRIDGE_TOKEN='([^']+)'/.exec(fs.readFileSync(cmd, "utf8"))[1];
console.log("ENV-TOKEN=" + (process.env.DOORMAN_BRIDGE_TOKEN || "none") + " MCP-TOKEN=" + wtok); // printed, so the runner's log must redact it
fs.writeFileSync(${JSON.stringify(SEEN)} + "-" + harness, JSON.stringify({ argv, prompt, cwd: process.cwd(), envToken: process.env.DOORMAN_BRIDGE_TOKEN || "", mcpToken: wtok }));
const ch = spawn(cmd, args, { env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env }, stdio: ["pipe", "pipe", "inherit"] });
let buf = ""; const wait = (id) => new Promise((res) => { const on = (d) => { buf += d; let i; while ((i = buf.indexOf("\\n")) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); const m = JSON.parse(l); if (m.id === id) { ch.stdout.off("data", on); res(m); } } }; ch.stdout.on("data", on); });
const send = (id, method, params) => { ch.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\\n"); return wait(id); };
await send(1, "initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "stub", version: "1" } });
const job = /Its id is ([^;]+);/.exec(prompt)[1];
const r = await send(2, "tools/call", { name: "report_job", arguments: { id: job, state: "done", summary: "stub " + harness + " did it", ran: ["nothing"], changed: [] } });
fs.writeFileSync(${JSON.stringify(SEEN)} + "-" + harness + "-report", JSON.stringify(r)); ch.kill(); process.exit(0);
`, { mode: 0o755 });
const CLI = new URL("../docker/bridge/doorman-bridge", import.meta.url).pathname;
const runJob = (id, env) => new Promise((res) => execFile(CLI, ["--json", "run-job", id], { env: { ...process.env, DOORMAN_RUNNER_DIRECT: "1", ...env }, timeout: 60000 }, (e, out, err) => res({ e, out, err })));
for (const [h, sb] of [["claude-code", "world-sd"], ["codex", "world-sc"], ["pi", "world-sp"]]) {
  world(sb, { host_runner: { harness: h, command: [process.execPath, STUB] } });
  const id = `${sb}--${h === "pi" ? "f1" : h === "codex" ? "c0" : "c1"}a0de`;
  jobRecord(id, newJob({ id, sandbox: sb, asker: "Alpha", action: "do the stub thing", tools: ["Read"], folders: [F], timeLimitS: 120 }));
  const r = await runJob(id, { STUB_HARNESS: h }); await new Promise((x) => setTimeout(x, 300));
  const rec = JSON.parse(fs.readFileSync(path.join(REQ, `${id}.json`), "utf8"));
  assert.equal(rec.state, "done", `${h}: ${r.out} ${r.err} ${JSON.stringify(rec.outcome)}`); assert.match(rec.outcome.summary, new RegExp(`stub ${h} did it`));
  const seen = JSON.parse(fs.readFileSync(`${SEEN}-${h}`, "utf8")); assert.equal(seen.cwd, F); assert.match(seen.prompt, /do the stub thing/);
  if (h !== "claude-code") assert.match(seen.prompt, /keep to them yourself/, "advisory harness: the prompt says so"); else assert.doesNotMatch(seen.prompt, /keep to them yourself/);
  // (J425Review #3) the agent's own env has no token; the MCP server has the real one; the log (which holds the printed output) never does
  assert.equal(seen.envToken, "", `${h}: no token in the agent's env`); assert.match(seen.mcpToken, /^[0-9a-f]{16,}$/);
  const rlog = fs.readFileSync(path.join(st, "bridge", "runner.jsonl"), "utf8"); assert.ok(!rlog.includes(seen.mcpToken), `${h}: the actual token is in the runner log`); assert.match(rlog, /MCP-TOKEN=\[token\]/); assert.match(rlog, new RegExp(`"harness":"${h}"`));
}
ok("run-job per harness (stub agent): each adapter's MCP wiring reaches the job-bound bridge, the stub reports done, prompt on stdin, cwd = the job's folder, harness logged, token never in the log");
// an invalid setting: the waiting job is reported failed, nothing runs
world("world-sx", { host_runner: "aider" }); jobRecord("world-sx--e0a0de", newJob({ id: "world-sx--e0a0de", sandbox: "world-sx", asker: "Alpha", action: "x", timeLimitS: 60 }));
await runJob("world-sx--e0a0de", {}); const bad = JSON.parse(fs.readFileSync(path.join(REQ, "world-sx--e0a0de.json"), "utf8"));
assert.equal(bad.state, "failed"); assert.match(bad.outcome.summary, /host_runner can't be used \(unknown host_runner harness/);
ok("a waiting job in a world with an invalid host_runner is reported failed; no agent runs");
bridge.stop?.(); fs.rmSync(base, { recursive: true, force: true });
console.log(`bridge-harness: all ${n} pass`); process.exit(0);
