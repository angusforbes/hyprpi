#!/usr/bin/env node
// J412 (spec 2.3.5): the suggested plan on a "2": its own stateless research.mjs call ("suggest"), carrying the original request, the previous
// searches and the reason (+ Angus's text); it passes the host checks, writes nothing (the plan file is untouched, no new plan), sends nothing.
// Isolated temp state, a fake Doorman check; no model, no sandbox.   node docker/doorman/test-suggest-plan.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url)), T = fs.mkdtempSync(path.join(os.tmpdir(), "doorman-replan-"));
const RS = path.join(T, "research"), CFG = path.join(T, "cfg"); fs.mkdirSync(path.join(RS, "plans"), { recursive: true }); fs.mkdirSync(path.join(CFG, "hyprpi", "worlds"), { recursive: true });
fs.writeFileSync(path.join(RS, "plans", "q0123abcd.json"), JSON.stringify({ created: Date.now(), base: { sandbox: "world-t", rid: "q0123abcd", from: "Alpha" }, q: "perovskite humidity stability", depth: "quick", plan: { searches: ["perovskite humidity", "perovskite damp heat"] } }));
const fake = path.join(T, "fake-doorman.sh"), got = path.join(T, "payload.json");
fs.writeFileSync(fake, `#!/bin/sh\ncat > ${got}\necho '{"refuse":false,"searches":["perovskite moisture degradation"],"on_task":true,"drift":false}'\n`, { mode: 0o755 });
const out = JSON.parse(execFileSync(process.execPath, [path.join(HERE, "..", "research", "research.mjs"), "suggest", "--rid", "q0123abcd"], { input: "held because (Doorman): off task · Angus: use plainer words", encoding: "utf8", env: { ...process.env, HYPRPI_RESEARCH_STATE: RS, XDG_CONFIG_HOME: CFG, HYPRPI_RESEARCH_FAKE_DOORMAN: fake } }));
const p = JSON.parse(fs.readFileSync(got, "utf8"));
assert.equal(p.mode, "plan"); assert.equal(p.looking_for, "perovskite humidity stability"); assert.equal(p.owner_note, "held because (Doorman): off task · Angus: use plainer words");
assert.deepEqual(p.previous, ["perovskite humidity", "perovskite damp heat"]); assert.deepEqual(out, { ok: true, searches: ["perovskite moisture degradation"], brief: "" });
assert.deepEqual(fs.readdirSync(path.join(RS, "plans")), ["q0123abcd.json"], "writes nothing: no new plan, the old one untouched (the relay drops it)");
// a suggestion that fails the host's checks (a key-shaped string) or is off task is not offered
fs.writeFileSync(fake, `#!/bin/sh\ncat > ${got}\necho '{"refuse":false,"searches":["perovskite sk-abcdefghijklmnopqrstuvwxyz0123"],"on_task":true,"drift":false}'\n`, { mode: 0o755 });
const bad = JSON.parse(execFileSync(process.execPath, [path.join(HERE, "..", "research", "research.mjs"), "suggest", "--rid", "q0123abcd"], { input: "x", encoding: "utf8", env: { ...process.env, HYPRPI_RESEARCH_STATE: RS, XDG_CONFIG_HOME: CFG, HYPRPI_RESEARCH_FAKE_DOORMAN: fake } }).trim().split("\n").pop());
assert.equal(bad.ok, false);
fs.writeFileSync(path.join(CFG, "hyprpi", "worlds", "world-t.json"), JSON.stringify({ sandbox: "world-t", task: "Perovskite solar cells" })); // with a task, a suggestion must be on it
fs.writeFileSync(fake, `#!/bin/sh\ncat > ${got}\necho '{"refuse":false,"searches":["sea otter behaviour"],"on_task":false,"drift":false}'\n`, { mode: 0o755 });
const off = JSON.parse(execFileSync(process.execPath, [path.join(HERE, "..", "research", "research.mjs"), "suggest", "--rid", "q0123abcd"], { input: "x", encoding: "utf8", env: { ...process.env, HYPRPI_RESEARCH_STATE: RS, XDG_CONFIG_HOME: CFG, HYPRPI_RESEARCH_FAKE_DOORMAN: fake } }).trim().split("\n").pop());
assert.equal(off.ok, false); assert.match(off.reason, /task/);
fs.rmSync(T, { recursive: true, force: true });
console.log("PASS  J412 suggested plan: the stateless call carries the request, previous searches and the reason/text; checked; on task; writes nothing");
