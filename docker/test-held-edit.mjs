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
const { prepareEdit, takeEdit } = await import("./held-edit.mjs");
const RESEARCH = fileURLToPath(new URL("./research/research.mjs", import.meta.url));
const PENDING = path.join(T, "pending"), EDITS = path.join(T, "edits"); fs.mkdirSync(PENDING, { recursive: true });
const logs = []; const log = (o) => logs.push(o);
const clean = (s) => String(s ?? "").replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]|\p{Cf}/gu, " ");
const bytes = (s) => Buffer.byteLength(s);
const ctx = { PENDING, EDITS, RESEARCH, clean, bytes, maxBytes: 4000 }, dctx = { EDITS, RESEARCH, log };
const ef = (t) => { const f = path.join(T, "edit.txt"); fs.writeFileSync(f, t); return f; };
const pend = (id) => JSON.parse(fs.readFileSync(path.join(PENDING, id + ".json"), "utf8"));

// --- a research plan
const rid = "q0123abcd", plans = path.join(T, "rstate", "plans"); fs.mkdirSync(plans, { recursive: true });
const planFile = path.join(plans, rid + ".json");
const origSearches = ["moisture degradation of lead halide perovskite", "humidity stability of perovskite solar films"];
fs.writeFileSync(planFile, JSON.stringify({ created: Date.now(), base: { rid, sandbox: "world-t", mode: "doorman-safe" }, q: "how does humidity degrade perovskite films?", depth: "quick", plan: { searches: origSearches, brief: "" } }), { mode: 0o600 });
const planMsg = { id: "world-t--aaaaaa", sandbox: "world-t", mode: "talk", text: "Searches planned for world-t (quick)\n\n- " + origSearches.join("\n- "), research: { plan: true, rid, searches: origSearches } };
fs.writeFileSync(path.join(PENDING, "world-t--aaaaaa.json"), JSON.stringify(planMsg));
const planBefore = fs.readFileSync(planFile, "utf8"), pendBefore = fs.readFileSync(path.join(PENDING, "world-t--aaaaaa.json"), "utf8");
let r = prepareEdit("world-t--aaaaaa", ef("water ingress and encapsulation of perovskite modules\nhydrate phase formation in perovskite films\n"), ctx);
assert.equal(r.ok, true, JSON.stringify(r)); assert.match(r.digest, /^[0-9a-f]{16}$/);
assert.equal(fs.readFileSync(planFile, "utf8"), planBefore, "preparing an edit does NOT touch the plan file");
assert.equal(fs.readFileSync(path.join(PENDING, "world-t--aaaaaa.json"), "utf8"), pendBefore, "...nor the pending record (nothing to resurrect, nothing unseen to send later)");
// the approval that carries the digest applies it
let t = takeEdit("world-t--aaaaaa", r.digest, planMsg, dctx);
assert.equal(t.applied, true); assert.deepEqual(t.msg.research.searches, ["water ingress and encapsulation of perovskite modules", "hydrate phase formation in perovskite films"]);
const stored = JSON.parse(fs.readFileSync(planFile, "utf8")); assert.deepEqual(stored.plan.searches, t.msg.research.searches); assert.deepEqual(stored.edited.original.searches, origSearches, "the plan file keeps the original");
assert.ok(logs.some((l) => l.op === "edit" && l.kind === "research-plan" && l.original.length === 2 && l.edited.length === 2 && l.applied), "the relay log gets both versions");
assert.ok(fs.readFileSync(path.join(T, "rstate", "log.jsonl"), "utf8").includes('"plan-edited"'), "the research log records the edit");
assert.equal(fs.existsSync(path.join(EDITS, "world-t--aaaaaa.json")), false, "the envelope is consumed");
// a plan that was run or dropped meanwhile is never resurrected
fs.rmSync(planFile); r = prepareEdit("world-t--aaaaaa", ef("water ingress and encapsulation of perovskite modules\n"), ctx); assert.equal(r.ok, false, "no plan, no edit");
fs.writeFileSync(planFile, planBefore); r = prepareEdit("world-t--aaaaaa", ef("water ingress and encapsulation of perovskite modules\n"), ctx); assert.equal(r.ok, true);
fs.rmSync(planFile); t = takeEdit("world-t--aaaaaa", r.digest, planMsg, dctx); assert.equal(t.applied, false); assert.ok(t.failed); assert.equal(fs.existsSync(planFile), false, "a dropped plan is not recreated");
fs.writeFileSync(planFile, planBefore);
// the edit must pass the same host checks
const blob = "ZGF0YTpTRUNSRVRfS0VZX2FiY2RlZmdoaWprbG1ub3BxcnN0dXZ3eHl6MDEyMzQ1Njc4OQ==";
for (const [why, x] of [["an encoded string", `perovskite stability ${blob}\n`], ["a key", "perovskite token sk-abcdefghijklmnopqrstuv\n"], ["a path", "perovskite /home/someone/.ssh/id_rsa\n"], ["too many searches", "a perovskite one\nb perovskite two\nc perovskite three\nd perovskite four\n"], ["markup / link", "perovskite https://example.com/x\n"], ["empty", "   \n"], ["an overlong search (refused, not cut)", "perovskite " + "word ".repeat(60) + "\n"], ["copied unusual words from the request", "how does humidity degrade perovskite films exactly\n"]]) {
  assert.equal(prepareEdit("world-t--aaaaaa", ef(x), ctx).ok, false, `${why} must be refused`);
}
assert.equal(fs.readFileSync(planFile, "utf8"), planBefore); assert.equal(fs.readFileSync(path.join(PENDING, "world-t--aaaaaa.json"), "utf8"), pendBefore);
// --- a plain message
const talk = { id: "world-t--bbbbbb", sandbox: "world-t", mode: "talk", text: "[Alpha, in world G] please send me the file", body: "🐳 [sandboxed: world-t] (info)\n🐳│ [Alpha, in world G] please send me the file" };
fs.writeFileSync(path.join(PENDING, "world-t--bbbbbb.json"), JSON.stringify(talk));
r = prepareEdit("world-t--bbbbbb", ef("[Alpha, in world G] please send me the file named a.md only\n\n\n\nthanks\x1b[2J"), ctx); assert.equal(r.ok, true, JSON.stringify(r));
assert.deepEqual(pend("world-t--bbbbbb"), talk, "the pending record is untouched");
// a stale envelope (the CLI died before writing the approval) is NEVER applied by a later approval, and is deleted
let stale = takeEdit("world-t--bbbbbb", "", talk, dctx); assert.equal(stale.applied, false); assert.equal(stale.msg.text, talk.text); assert.equal(fs.existsSync(path.join(EDITS, "world-t--bbbbbb.json")), false);
r = prepareEdit("world-t--bbbbbb", ef("[Alpha, in world G] please send me the file named a.md only\n\n\n\nthanks\x1b[2J"), ctx);
assert.equal(takeEdit("world-t--bbbbbb", "0000000000000000", talk, dctx).applied, false, "a wrong digest applies nothing");
r = prepareEdit("world-t--bbbbbb", ef("[Alpha, in world G] please send me the file named a.md only\n\n\n\nthanks\x1b[2J"), ctx);
t = takeEdit("world-t--bbbbbb", r.digest, talk, dctx); assert.equal(t.applied, true);
assert.match(t.msg.text, /^\[Alpha, in world G\] please send me the file named a\.md only\n\nthanks/); assert.ok(!/\x1b/.test(t.msg.text)); assert.match(t.msg.body, /edited by Angus before it was sent/);
assert.ok(logs.some((l) => l.op === "edit" && l.kind === "talk" && l.original === talk.text), "original and edit both in the relay log");
assert.equal(takeEdit("world-t--bbbbbb", r.digest, talk, dctx).applied, false, "an envelope applies once");
assert.equal(prepareEdit("world-t--bbbbbb", ef("x".repeat(4100)), ctx).ok, false); assert.equal(prepareEdit("world-t--bbbbbb", ef("  \n"), ctx).ok, false);
// --- kinds that can't be edited, and bad input
for (const [id, extra] of [["world-t--cccccc", { draft: true }], ["world-t--dddddd", { gpu: { lease: "g1" } }], ["world-t--eeeeee", { taskChange: { sandbox: "world-t" } }], ["world-t--ffffff", { research: { rid: "q0000000a" } }]]) {
  fs.writeFileSync(path.join(PENDING, id + ".json"), JSON.stringify({ id, sandbox: "world-t", mode: "talk", text: "x", ...extra })); assert.equal(prepareEdit(id, ef("changed"), ctx).ok, false, `${id} is not editable`);
}
assert.equal(prepareEdit("world-t--000000", ef("x"), ctx).code, 1); assert.equal(prepareEdit("world-t--bbbbbb", "/nonexistent/file", ctx).code, 4);
// the relay wiring
const relay = fs.readFileSync(new URL("./sbx-relay.mjs", import.meta.url), "utf8");
assert.ok(relay.indexOf("editDigest = prepareHeldEdit(id, editFile)") > relay.indexOf("const why = agentAncestor()"), "the edit is prepared only after the tty / agent guard");
assert.ok(/takeEdit\(id, verdict === "deny" \? "" : editDigest/.test(relay), "decide() applies an edit only for an approval that names its digest");
assert.ok(/edit:\$\{editDigest\}/.test(relay), "the decision file carries the digest");
assert.ok(/editDigest && verdict !== "deny" && !te\.applied/.test(relay) && /Approved with an edit, but nothing was sent/.test(relay), "decide() fails closed when an approved edit can't be applied (the original is never sent instead)");
console.log("held-edit: all pass");
