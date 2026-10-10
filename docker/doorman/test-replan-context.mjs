#!/usr/bin/env node
// J395: J370's re-plan is unaffected by the Doorman having no memory: it is its own stateless research.mjs call, and it carries the original
// request, the previous searches and Angus's note. Isolated temp state, a fake Doorman check; no model, no sandbox.
//   node docker/doorman/test-replan-context.mjs
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
const out = JSON.parse(execFileSync(process.execPath, [path.join(HERE, "..", "research", "research.mjs"), "replan", "--rid", "q0123abcd"], { input: "use plainer words", encoding: "utf8", env: { ...process.env, HYPRPI_RESEARCH_STATE: RS, XDG_CONFIG_HOME: CFG, HYPRPI_RESEARCH_FAKE_DOORMAN: fake } }));
const p = JSON.parse(fs.readFileSync(got, "utf8"));
assert.equal(p.mode, "plan"); assert.equal(p.looking_for, "perovskite humidity stability"); assert.equal(p.owner_note, "use plainer words");
assert.deepEqual(p.previous, ["perovskite humidity", "perovskite damp heat"]); assert.equal(out.status, "planned"); assert.equal(out.revises, "q0123abcd");
fs.rmSync(T, { recursive: true, force: true });
console.log("PASS  J370 re-plan: its own call carries the original request, the previous searches and Angus's note, and the revision is planned (held)");
