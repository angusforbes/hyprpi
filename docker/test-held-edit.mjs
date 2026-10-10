// node docker/test-held-edit.mjs  (J365): approve with modifications. Throwaway state only (XDG_*, HYPRPI_RESEARCH_STATE point at a temp dir).
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
const T = fs.mkdtempSync(path.join(os.tmpdir(), "j365-"));
process.env.XDG_CONFIG_HOME = path.join(T, "cfg"); process.env.XDG_STATE_HOME = path.join(T, "state"); process.env.HYPRPI_RESEARCH_STATE = path.join(T, "rstate");
fs.mkdirSync(path.join(T, "cfg", "hyprpi", "worlds"), { recursive: true });
fs.writeFileSync(path.join(T, "cfg", "hyprpi", "worlds", "world-t.json"), JSON.stringify({ sandbox: "world-t", task: "Research on perovskite solar cells" }));
const { applyHeldEdit } = await import("./held-edit.mjs");
const RESEARCH = fileURLToPath(new URL("./research/research.mjs", import.meta.url));
const PENDING = path.join(T, "pending"); fs.mkdirSync(PENDING, { recursive: true });
const logs = []; const log = (o) => logs.push(o);
const clean = (s) => String(s ?? "").replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]|\p{Cf}/gu, " ");
const bytes = (s) => Buffer.byteLength(s);
const ctx = { PENDING, RESEARCH, clean, bytes, maxBytes: 4000, log };
const ef = (t) => { const f = path.join(T, "edit.txt"); fs.writeFileSync(f, t); return f; };
const rec = (id) => JSON.parse(fs.readFileSync(path.join(PENDING, id + ".json"), "utf8"));

// --- a research plan
const rid = "q0123abcd", plans = path.join(T, "rstate", "plans"); fs.mkdirSync(plans, { recursive: true });
const planFile = path.join(plans, rid + ".json");
fs.writeFileSync(planFile, JSON.stringify({ created: Date.now(), base: { rid, sandbox: "world-t", mode: "doorman-safe" }, q: "how does humidity degrade perovskite films?", depth: "quick", plan: { searches: ["moisture degradation of lead halide perovskite", "humidity stability of perovskite solar films"], brief: "" } }), { mode: 0o600 });
fs.writeFileSync(path.join(PENDING, "world-t--aaaaaa.json"), JSON.stringify({ id: "world-t--aaaaaa", sandbox: "world-t", mode: "talk", text: "Searches planned for world-t (quick): how does humidity degrade perovskite films?\n\n- moisture degradation of lead halide perovskite\n- humidity stability of perovskite solar films", research: { plan: true, rid, searches: ["moisture degradation of lead halide perovskite", "humidity stability of perovskite solar films"] } }));
let r = applyHeldEdit("world-t--aaaaaa", ef("water ingress and encapsulation of perovskite modules\nhydrate phase formation in perovskite films\n"), ctx);
assert.equal(r.ok, true, JSON.stringify(r));
let p = rec("world-t--aaaaaa"); assert.deepEqual(p.research.searches, ["water ingress and encapsulation of perovskite modules", "hydrate phase formation in perovskite films"]);
assert.match(p.text, /- water ingress and encapsulation of perovskite modules\n- hydrate phase formation/); assert.doesNotMatch(p.text, /moisture degradation of lead halide/);
assert.deepEqual(p.edited.original, ["moisture degradation of lead halide perovskite", "humidity stability of perovskite solar films"]);
const stored = JSON.parse(fs.readFileSync(planFile, "utf8")); assert.deepEqual(stored.plan.searches, p.research.searches); assert.ok(stored.edited.original.searches, "the plan file keeps the original");
assert.ok(logs.some((l) => l.op === "edit" && l.kind === "research-plan" && l.original.length === 2 && l.edited.length === 2), "the relay log gets both versions");
assert.ok(fs.readFileSync(path.join(T, "rstate", "log.jsonl"), "utf8").includes('"plan-edited"'), "the research log records the edit");
// the edit must pass the same host checks
const before = JSON.stringify(rec("world-t--aaaaaa")), blob = "ZGF0YTpTRUNSRVRfS0VZX2FiY2RlZmdoaWprbG1ub3BxcnN0dXZ3eHl6MDEyMzQ1Njc4OQ==";
for (const [why, t] of [["an encoded string", `perovskite stability ${blob}\n`], ["a key", "perovskite token sk-abcdefghijklmnopqrstuv\n"], ["a path", "perovskite /home/someone/.ssh/id_rsa\n"], ["too many searches", "a perovskite one\nb perovskite two\nc perovskite three\nd perovskite four\n"], ["markup / link", "perovskite https://example.com/x\n"], ["empty", "   \n"], ["copied unusual words from the request", "how does humidity degrade perovskite films exactly\n"]]) {
  const x = applyHeldEdit("world-t--aaaaaa", ef(t), ctx); assert.equal(x.ok, false, `${why} must be refused`);
}
assert.equal(JSON.stringify(rec("world-t--aaaaaa")), before, "a refused edit changes nothing");
// --- a plain message
fs.writeFileSync(path.join(PENDING, "world-t--bbbbbb.json"), JSON.stringify({ id: "world-t--bbbbbb", sandbox: "world-t", mode: "talk", text: "[Alpha, in world G] please send me the file", body: "🐳 [sandboxed: world-t] (info)\n🐳│ [Alpha, in world G] please send me the file" }));
r = applyHeldEdit("world-t--bbbbbb", ef("[Alpha, in world G] please send me the file named a.md only\n\n\n\nthanks"), ctx); assert.equal(r.ok, true, JSON.stringify(r));
p = rec("world-t--bbbbbb"); assert.equal(p.edit.text, "[Alpha, in world G] please send me the file named a.md only\n\nthanks"); assert.equal(p.edit.original, "[Alpha, in world G] please send me the file");
assert.equal(p.text, "[Alpha, in world G] please send me the file", "the original text stays in the record");
r = applyHeldEdit("world-t--bbbbbb", ef("second edit\x1b[2J"), ctx); assert.equal(r.ok, true); p = rec("world-t--bbbbbb"); assert.equal(p.edit.original, "[Alpha, in world G] please send me the file", "the ORIGINAL survives a second edit"); assert.ok(!/\x1b/.test(p.edit.text));
assert.equal(applyHeldEdit("world-t--bbbbbb", ef("x".repeat(4100)), ctx).ok, false); assert.equal(applyHeldEdit("world-t--bbbbbb", ef("  \n"), ctx).ok, false);
// --- kinds that can't be edited, and bad input
for (const [id, extra] of [["world-t--cccccc", { draft: true }], ["world-t--dddddd", { gpu: { lease: "g1" } }], ["world-t--eeeeee", { taskChange: { sandbox: "world-t" } }], ["world-t--ffffff", { research: { rid: "q0000000a" } }]]) {
  fs.writeFileSync(path.join(PENDING, id + ".json"), JSON.stringify({ id, sandbox: "world-t", mode: "talk", text: "x", ...extra })); assert.equal(applyHeldEdit(id, ef("changed"), ctx).ok, false, `${id} is not editable`);
}
assert.equal(applyHeldEdit("world-t--000000", ef("x"), ctx).code, 1); assert.equal(applyHeldEdit("world-t--bbbbbb", "/nonexistent/file", ctx).code, 4);
// the relay uses it only after the tty guard and applies the edited text on approve
const relay = fs.readFileSync(new URL("./sbx-relay.mjs", import.meta.url), "utf8");
assert.ok(/if \(editFile\) \{ if \(verdict !== "approve"\)[\s\S]{0,120}applyEdit\(id, editFile\)/.test(relay) && relay.lastIndexOf("applyEdit(id, editFile)") > relay.indexOf("const why = agentAncestor()"), "the edit is applied after the guard");
assert.ok(/msg\.edit && typeof msg\.edit\.text === "string" && verdict !== "deny"[\s\S]{0,400}edited by Angus before it was sent/.test(relay), "an approved talk sends the edited text");
console.log("held-edit: all pass");
