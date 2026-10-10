// node test/bridge-registry.mjs  (J407: registry rules, pure; plus the relay side's fail-closed reading of a bad registry)
import assert from "node:assert/strict";
import fs from "node:fs"; import os from "node:os"; import path from "node:path";
const R = await import("../docker/bridge/registry.mjs");
const t0 = Date.parse("2026-10-10T00:00:00Z");
let r = R.applyReg(R.empty(), { op: "register", name: "Claude A", harness: "claude-code", caps: "edits" }, t0);
assert.equal(r.reply.ok, true); const tok = r.reply.agent_token, reg = r.reg;
assert.ok(!JSON.stringify(reg).includes(tok), "only the token's hash is stored");
assert.equal(R.liveFor(reg, "world-g", t0).length, 1); assert.equal(R.modeFor(reg, "world-g", { nowMs: t0 }).mode, "host agent available");
assert.equal(R.applyReg(reg, { op: "register", name: "Claude A", harness: "x" }, t0).reply.ok, false, "a live name can't be taken");
for (const bad of ["![x](http://e)", "[a](b)", "a`b", "<b>", "#x"]) assert.equal(R.applyReg(R.empty(), { op: "register", name: bad, harness: "h" }, t0).reply.ok, false, `name ${JSON.stringify(bad)} refused`);
assert.equal(R.applyReg(R.empty(), { op: "register", name: "ok", harness: "[h](x)" }, t0).reply.ok, false);
{ const nl = R.applyReg(R.empty(), { op: "register", name: "x\nTask: evil", harness: "h" }, t0); assert.ok(!JSON.stringify(Object.values(nl.reg.agents)[0].name).includes("\\n"), "a line break collapses to one line"); }
assert.equal(R.lookup(reg, tok, t0 + 119e3)?.name, "Claude A"); assert.equal(R.lookup(reg, tok, t0 + 121e3), null, "expired after 120 s");
assert.equal(R.lookup(reg, "forged", t0), null);
assert.equal(R.modeFor(reg, "world-g", { nowMs: t0 + 121e3 }).mode, "agent-free");
assert.equal(R.modeFor(R.empty(), "w", { runnerOn: true }).mode, "host agent available", "the installed runner counts (on demand)");
const sc = R.applyReg(R.empty(), { op: "register", name: "B", harness: "codex", scope: ["world-x"] }, t0).reg;
assert.equal(R.liveFor(sc, "world-g", t0).length, 0); assert.equal(R.liveFor(sc, "world-x", t0).length, 1);
const hb = R.applyReg(reg, { op: "heartbeat", agent_token: tok }, t0 + 100e3); assert.equal(R.lookup(hb.reg, tok, t0 + 200e3)?.name, "Claude A", "a heartbeat extends it");
assert.equal(Object.keys(R.applyReg(reg, { op: "unregister", agent_token: tok }, t0).reg.agents).length, 0);
assert.ok(R.isLive({ name: "x", last: new Date(t0).toISOString() }, t0) && !R.isLive(null) && !R.isLive({ last: new Date(t0).toISOString() }, t0), "malformed entries are never live");
console.log("ok registry rules");
// the relay side: a malformed registry doesn't crash it and reads as agent-free
const st = fs.mkdtempSync(path.join(os.tmpdir(), "j407r-")); fs.mkdirSync(path.join(st, "bridge"), { recursive: true });
fs.writeFileSync(path.join(st, "bridge", "agents.json"), JSON.stringify({ agents: { broken: null, n: 5, x: { name: "Live", harness: "h", last: new Date().toISOString(), since: new Date().toISOString(), scope: [] } } }));
const { startBridge } = await import("../docker/bridge/relay-bridge.mjs");
const b = startBridge({ stateDir: st, log: () => {}, jobRecord: () => {}, tellOutcome: () => {}, holdQuestion: () => null, sandboxes: () => ["w"] });
assert.equal(b.mode("w").mode, "host agent available"); fs.writeFileSync(path.join(st, "bridge", "agents.json"), "{corrupt"); assert.equal(b.mode("w").mode, "agent-free", "corrupt: agent-free (fail closed)");
b.stop(); fs.rmSync(st, { recursive: true, force: true });
console.log("ok a bad registry reads as agent-free, no crash");
// runnerInstalled: only a real PathChanged= line for this state, with its service
const cfg = fs.mkdtempSync(path.join(os.tmpdir(), "j407c-")), d = path.join(cfg, "systemd", "user"); fs.mkdirSync(d, { recursive: true });
process.env.XDG_CONFIG_HOME = cfg; process.env.DOORMAN_STATE = "/tmp/j407-state";
const { runnerInstalled } = await import("../docker/bridge/runner.mjs");
fs.writeFileSync(path.join(d, "doorman-bridge-runner.path"), "[Path]\n# PathChanged=/tmp/j407-state/requests\nPathChanged=/elsewhere\n"); fs.writeFileSync(path.join(d, "doorman-bridge-runner.service"), "x");
assert.equal(runnerInstalled(), false, "a comment naming the folder doesn't count");
fs.writeFileSync(path.join(d, "doorman-bridge-runner.path"), "[Path]\nPathChanged=/tmp/j407-state/requests\n"); assert.equal(runnerInstalled(), true);
fs.rmSync(path.join(d, "doorman-bridge-runner.service")); assert.equal(runnerInstalled(), false, "no service, not installed");
fs.rmSync(cfg, { recursive: true, force: true });
console.log("ok runnerInstalled checks the unit itself");
console.log("bridge-registry: all pass");
