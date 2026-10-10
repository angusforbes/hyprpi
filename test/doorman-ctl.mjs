// node test/doorman-ctl.mjs  (J380 v2: `doorman status|doctor|install` on a made-up machine; nothing real is touched)
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
const T = fs.mkdtempSync(path.join(os.tmpdir(), "dctl-")), cfgHome = path.join(T, "config"), cfg = path.join(cfgHome, "hyprpi"), stHome = path.join(T, "state");
process.env.XDG_CONFIG_HOME = cfgHome; process.env.XDG_STATE_HOME = stHome; process.env.HOME = T;
const { gather, renderStatus, doctor, renderDoctor, plan, apply, paths } = await import("../docker/doorman/ctl.mjs");
const P = paths(), ok = (m) => console.log("ok " + m);
fs.mkdirSync(path.join(cfg, "worlds"), { recursive: true }); fs.mkdirSync(P.units, { recursive: true }); fs.mkdirSync(path.join(P.relayState, "pending"), { recursive: true }); fs.mkdirSync(path.join(P.relayState, "bridge"), { recursive: true });
for (const d of ["ws", "inbox", "box", "dinbox", "card"]) fs.mkdirSync(path.join(T, d));
fs.writeFileSync(path.join(T, "key"), "k");
fs.writeFileSync(P.relayConf, JSON.stringify({ sandboxes: [{ name: "demo", workspace: path.join(T, "ws"), inbox: path.join(T, "inbox") }, { name: "doorman-demo", doorman_for: "demo", visibility: "safe", workspace: path.join(T, "box"), inbox: path.join(T, "dinbox"), card: path.join(T, "card"), key_file: path.join(T, "key"), host_agents: "bridge" }] }));
fs.writeFileSync(path.join(cfg, "worlds", "demo.json"), JSON.stringify({ sandbox: "demo", gateway: { mode: "safe" } }));
const good = path.join(T, "good.mjs"); fs.writeFileSync(good, "");
fs.writeFileSync(path.join(P.units, "hyprpi-research-digest.service"), `[Service]\nExecStart=/usr/bin/node ${good} digest\n`);
const healthy = { active: () => "active", enabled: () => "enabled", failed: () => [], sbx: () => ({ demo: "running", "doorman-demo": "running" }), window: () => true, run: () => ({ status: 0, stdout: "", stderr: "" }) };
// healthy machine
let g = gather("demo", healthy, P); assert.equal(g.error, undefined); assert.ok(g.pieces.every((p) => p.state !== "fail"), JSON.stringify(g.pieces.filter((p) => p.state === "fail")));
assert.match(renderStatus(g), /Gateway for demo: mode safe, Doorman doorman-demo  \[all fine\]/); assert.match(renderStatus(g), /runner\s+doorman-bridge-runner\.path active/);
assert.deepEqual(doctor("demo", healthy, P).issues, [], "a healthy setup has nothing for doctor to find"); ok("healthy: status all fine, doctor finds nothing");
// a deliberately broken one: Doorman down, runner missing, stale unit path, failed unit, key gone, two worlds files
fs.writeFileSync(path.join(P.units, "hyprpi-research-daily.service"), "[Service]\nExecStart=/usr/bin/node /home/nobody/Work/hyprpi/docker/research/research.mjs digest --daily\n"); // the J375 bug: a path that moved
fs.rmSync(path.join(T, "key")); fs.writeFileSync(path.join(cfg, "worlds", "demo-old.json"), JSON.stringify({ sandbox: "demo" }));
const broken = { ...healthy, active: (u) => (/doorman-doorman-demo|bridge-runner/.test(u) ? "inactive" : "active"), failed: () => ["hyprpi-research-digest.service"], sbx: () => ({ demo: "running" }) };
g = gather("demo", broken, P); const bad = g.pieces.filter((p) => p.state === "fail").map((p) => p.name); assert.ok(bad.includes("doorman") && bad.includes("runner"), bad.join());
assert.match(renderStatus(g), /FAIL doorman/); assert.match(renderStatus(g), /Run: doorman doctor demo/);
const d = doctor("demo", broken, P), what = d.issues.map((i) => i.what + ": " + i.why).join("\n");
assert.match(what, /hyprpi-research-daily\.service: points at \/home\/nobody\/Work\/hyprpi\S*, which doesn't exist/, "the stale path is found");
assert.match(what, /doorman key: key_file .* missing/); assert.match(what, /hyprpi-research-digest\.service: the unit failed/); assert.match(what, /worlds config: demo-old\.json, demo\.json all name demo|worlds config: demo\.json, demo-old\.json all name demo/); assert.match(what, /doorman: doorman-demo is not running/);
assert.ok(d.issues.every((i) => i.fix), "every issue says how to fix it"); assert.match(renderDoctor(d), /fix: /);
ok("broken: doctor finds the dead Doorman, the missing runner, the stale path (the J375 bug), the failed unit, the missing key and the duplicate worlds file, each with a fix");
// install / start / stop plan the pieces' own commands, in order, and skip what already runs
const pi = plan("install", "demo", P).steps.map((s) => s.what); assert.deepEqual(pi, ["start the relay", "start the Doorman doorman-demo", "install the per-job runner (path unit)", "install the hourly and daily digest timers"]);
assert.deepEqual(plan("stop", "demo", P).steps.map((s) => s.what), ["stop the Doorman doorman-demo", "stop the per-job runner (path unit)", "stop the relay"]);
const ran = []; apply(plan("install", "demo", P), { ...healthy, active: (u) => (/sbx-relay/.test(u) ? "active" : "inactive"), run: (c, a) => { ran.push(path.basename(c) + " " + a.join(" ")); return { status: 0, stdout: "", stderr: "" }; } }, () => {});
assert.ok(!ran.some((r) => /sbx-relay\.mjs start/.test(r)), "the running relay isn't started again"); assert.ok(ran.some((r) => /doorman\.sh start doorman-demo/.test(r)) && ran.some((r) => /runner --install/.test(r)) && ran.some((r) => /digest-timer\.sh/.test(r)));
ok("install/start/stop: the right commands in order, a running piece is skipped");
assert.equal(apply(plan("install", "demo", P), { ...healthy, active: () => "inactive", run: () => ({ status: 1, stdout: "", stderr: "boom" }) }, () => {}), false, "a failed step makes apply report failure (the CLI exits 1)");
assert.equal(apply(plan("stop", "demo", P), { ...healthy, run: () => ({ status: 0, stdout: "", stderr: "" }) }, () => {}), true);
ok("a failed install step is reported as failure");
assert.match(plan("status", "nope", P).error || renderStatus(gather("nope", healthy, P)), /no sandbox "nope"/); ok("an unknown world is a clear error");
fs.rmSync(T, { recursive: true, force: true }); console.log("doorman-ctl: all pass");
