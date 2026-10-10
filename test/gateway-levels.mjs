// node test/gateway-levels.mjs  (J380 v3: `doorman config`, the host's levels file, and the card; a made-up config only)
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
const base = fs.mkdtempSync(path.join(os.homedir(), ".cache", "j380c-")), cfgHome = path.join(base, "cfg"), cfg = path.join(cfgHome, "hyprpi");
process.env.XDG_CONFIG_HOME = cfgHome; process.env.XDG_STATE_HOME = path.join(base, "state");
fs.mkdirSync(path.join(cfg, "worlds"), { recursive: true });
const wf = path.join(cfg, "worlds", "world-t.json"), write = (w) => fs.writeFileSync(wf, JSON.stringify({ sandbox: "world-t", ...w }));
fs.writeFileSync(path.join(cfg, "sbx-relay.json"), JSON.stringify({ sandboxes: [{ name: "world-t" }, { name: "doorman-t", doorman_for: "world-t", host_agents: false }] }));
const L = await import("../docker/research/levels.mjs"), A = await import("../docker/research/gateway-admin.mjs"), M = await import("../docker/research/mode.mjs"), C = await import("../docker/doorman/ctl.mjs");
const P = C.paths(), ok = (m) => console.log("ok " + m);
const owner = () => "", agent = () => "an agent is an ancestor of this process";
// 1. no file = everything as before; a broken file = the strictest, with the error
write({ gateway: { mode: "yolo" } });
assert.deepEqual(L.loadLevels(cfg).levels.modes, ["strict", "safe", "open", "yolo"]); assert.equal(M.modeForSandbox(cfg, "world-t").mode, "yolo");
fs.writeFileSync(L.levelsFile(cfg), "{ nope"); let r = L.loadLevels(cfg); assert.deepEqual(r.levels.modes, ["strict"]); assert.match(r.error, /strictest/); assert.equal(M.modeForSandbox(cfg, "world-t").mode, "strict", "a broken levels file fails closed");
fs.writeFileSync(L.levelsFile(cfg), JSON.stringify({ modes: ["strict", "safe"], bogus: 1 })); assert.match(L.loadLevels(cfg).error, /unknown key/);
fs.rmSync(L.levelsFile(cfg)); ok("levels: no file = as before; a broken or unknown-key file fails closed to the strictest");
// 2. the owner sets the levels (terminal only); a world outside them is clamped; settings outside are refused
let c = C.configCommand(["levels", "set", "modes", "strict,safe", "phone_decisions", "off", "runner_harnesses", "claude", "max_share_level", "safe"], P, { guard: agent }); assert.equal(c.code, 3, "an agent can't change the host's levels");
c = C.configCommand(["levels", "set", "modes", "strict,safe", "phone_decisions", "off", "runner_harnesses", "claude", "max_share_level", "safe"], P, { guard: owner }); assert.equal(c.code, 0, c.text); assert.match(c.text, /modes a world may use: strict, safe/);
assert.equal(C.configCommand(["levels", "set", "modes", "chaos"], P, { guard: owner }).code, 2); assert.equal(C.configCommand(["levels"], P).code, 0);
assert.equal(M.modeForSandbox(cfg, "world-t").mode, "safe", "a hand-edited yolo world is clamped to the strictest allowed mode"); assert.match(M.modeForSandbox(cfg, "world-t").note, /isn't allowed by the host's levels/);
write({ gateway: { mode: "safe", phone_decisions: true } }); assert.equal(M.phoneDecisionsFor(cfg, "world-t"), false, "phone decisions are off when the host forbids them, whatever the world says");
ok("levels: set only from a terminal, validated; a world outside them is clamped (mode) or off (phone decisions)");
// 3. doorman config: see, get, set (terminal only), refused outside the levels, both for the admin command and a proposal
c = C.configCommand([], P); assert.equal(c.code, 0); assert.match(c.text, /Settings for world-t/); assert.match(c.text, /mode\s+safe\s+strict \| safe/); assert.match(c.text, /OUTSIDE the levels[\s\S]*phone/);
assert.equal(C.configCommand(["get", "mode"], P).text, "safe"); assert.equal(C.configCommand(["get", "world-t", "mode"], P).text, "safe");
assert.equal(C.configCommand(["set", "world-t", "mode", "strict"], P, { guard: agent }).code, 3, "an agent can't set");
c = C.configCommand(["set", "mode", "strict"], P, { guard: owner }); assert.equal(c.code, 0, c.text); assert.equal(JSON.parse(fs.readFileSync(wf, "utf8")).gateway.mode, "strict");
c = C.configCommand(["set", "mode", "yolo"], P, { guard: owner }); assert.equal(c.code, 2); assert.match(c.text, /refused: mode yolo isn't allowed on this host \(allowed: strict, safe\)/); assert.equal(JSON.parse(fs.readFileSync(wf, "utf8")).gateway.mode, "strict", "nothing written");
c = C.configCommand(["set", "phone_decisions", "true"], P, { guard: owner }); assert.equal(c.code, 2); assert.match(c.text, /phone aren't allowed/);
c = C.configCommand(["set", "runner.harness", "codex"], P, { guard: owner }); assert.equal(c.code, 2); assert.match(c.text, /runner harness codex isn't allowed/);
c = C.configCommand(["set", "runner.harness=claude", "report_model=azure/x/y"], P, { guard: owner }); assert.equal(c.code, 0, c.text); const g = JSON.parse(fs.readFileSync(wf, "utf8")).gateway; assert.equal(g.runner.harness, "claude"); assert.equal(g.report_model, "azure/x/y");
const pr = A.proposeChange({ cfgDir: cfg, PENDING: path.join(base, "pending"), sandbox: "world-t", changes: { mode: "yolo" } }); assert.equal(pr.ok, false); assert.match(pr.text, /isn't allowed on this host/, "a proposal outside the levels is refused, not held"); assert.equal(fs.existsSync(path.join(base, "pending")), false);
assert.throws(() => A.applyChanges(cfg, "world-t", { mode: "yolo" }), /isn't allowed/, "even a held proposal applied later is re-checked");
ok("config: get/set work from the owner's terminal only; a value or proposal outside the levels is refused and nothing is written");
// 4. edit: an editor that leaves the file outside the levels is undone
const before = fs.readFileSync(wf, "utf8");
c = C.configCommand(["edit", "world-t"], P, { guard: owner, run: (_, a) => { const w = JSON.parse(fs.readFileSync(a.at(-1), "utf8")); w.gateway.mode = "yolo"; fs.writeFileSync(a.at(-1), JSON.stringify(w)); return { status: 0 }; } });
assert.equal(c.code, 2); assert.equal(fs.readFileSync(wf, "utf8"), before, "put back as it was"); assert.match(c.text, /not kept/);
c = C.configCommand(["edit", "world-t"], P, { guard: owner, run: (_, a) => { fs.appendFileSync(a.at(-1), "{ bad"); return { status: 0 }; } }); assert.equal(c.code, 2); assert.equal(fs.readFileSync(wf, "utf8"), before);
c = C.configCommand(["edit", "world-t"], P, { guard: owner, run: (_, a) => { const w = JSON.parse(fs.readFileSync(a.at(-1), "utf8")); w.gateway.mode = "strict"; w.note = "x"; fs.writeFileSync(a.at(-1), JSON.stringify(w)); return { status: 0 }; } }); assert.equal(c.code, 0, c.text);
assert.equal(C.configCommand(["edit"], P, { guard: agent }).code, 3);
ok("config edit: a result outside the levels or not JSON is undone; a valid edit is kept; an agent can't edit");
// 5. status/doctor show it; host-agent-config prints the line
const sys = { active: () => "active", enabled: () => "enabled", failed: () => [], sbx: () => ({ "world-t": "running", "doorman-t": "running" }), window: () => true };
write({ gateway: { mode: "safe", phone_decisions: true } });
const s = C.renderStatus(C.gather("world-t", sys, P)); assert.match(s, /levels\s+.*outside the host's levels.*phone/i); assert.ok(C.doctor("world-t", sys, P).issues.some((i) => /levels/.test(i.what) && /phone/.test(i.why)));
assert.match(C.hostAgentConfig(P), /claude mcp add doorman-bridge .* mcp/); assert.match(C.hostAgentConfig(P), /\[mcp_servers\.doorman-bridge\]/);
ok("status and doctor flag a world outside the levels; host-agent-config prints the connect lines");
// 6. the sandbox's card shows the current settings and the range (the card is built from the same source)
const SH = new URL("../docker/world/shares.mjs", import.meta.url).pathname, bin = path.join(base, "bin"); fs.mkdirSync(bin); fs.writeFileSync(path.join(bin, "sbx"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
write({ workspace: path.join(base, "ws"), gateway: { mode: "safe" } }); fs.mkdirSync(path.join(base, "ws"));
execFileSync(process.execPath, [SH, "card", "world-t"], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }, encoding: "utf8" });
const card = fs.readFileSync(path.join(process.env.XDG_STATE_HOME, "hyprpi", "sandboxes", "world-t", "card", "host-card.md"), "utf8");
assert.match(card, /## Settings the host has set for you/); assert.match(card, /Mode now: safe \(the host allows: strict, safe\)/); assert.match(card, /Share level now: .* \(at most safe\)/); assert.match(card, /refused, not held/);
ok("the card shows the current settings and the allowed range, read from the same source");
fs.rmSync(base, { recursive: true, force: true }); console.log("gateway-levels: all pass");
