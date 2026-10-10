// node docker/test-held-return.mjs  (J370): "r <note>" sends a held item back to its author; "2 <reason>" denies with a reason.
// Throwaway state only (XDG_*, HYPRPI_RESEARCH_STATE point at a temp dir); the relay's own decide()/sendBack()/hold() run with stubbed IO.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
const T = fs.mkdtempSync(path.join(os.tmpdir(), "j370-"));
process.env.XDG_CONFIG_HOME = path.join(T, "cfg"); process.env.XDG_STATE_HOME = path.join(T, "state"); process.env.HYPRPI_RESEARCH_STATE = path.join(T, "rstate");
fs.mkdirSync(path.join(T, "cfg", "hyprpi", "worlds"), { recursive: true });
fs.writeFileSync(path.join(T, "cfg", "hyprpi", "worlds", "world-t.json"), JSON.stringify({ sandbox: "world-t", task: "Research on perovskite solar cells" }));
const N = await import("./held-note.mjs");

// ---- W3: the note is cleaned, labelled downstream, capped (refused, never cut)
assert.deepEqual(N.ownerNote("  use \u001b]52;c;eA==\u0007 plainer\nwords\u202e\t "), { ok: true, text: "use ]52;c;eA== plainer words" });
assert.equal(N.ownerNote("x".repeat(N.NOTE_MAX)).ok, true); assert.equal(N.ownerNote("x".repeat(N.NOTE_MAX + 1)).ok, false);
assert.ok(!/[\u0000-\u001f\u007f-\u009f]/.test(N.ownerNote("a\u0000b\u009bc\u0085d").text));
// what can be sent back
assert.equal(N.returnable({ mode: "talk", text: "x" }), true); assert.equal(N.returnable({ mode: "demand" }), true);
assert.equal(N.returnable({ research: { plan: true } }), true); assert.equal(N.returnable({ research: { rid: "q1" } }), false, "a deliverable can't be sent back");
for (const x of [{ draft: true, mode: "talk" }, { gpu: {}, mode: "talk" }, { taskChange: {}, mode: "talk" }, { typed: "x", mode: "talk" }, null]) assert.equal(N.returnable(x), false);
assert.equal(N.senderLabel("[Alpha, in world G] hi"), "Alpha"); assert.equal(N.senderLabel("hi"), "");
assert.equal(N.returnKey("w", { text: "[Alpha, in world G] a", targets: [{ id: "b" }, { id: "a" }] }), "w|Alpha|a,b");

// ---- the relay's decide(), sendBack() and hold(), the exact source, with IO stubbed
const src = fs.readFileSync(new URL("./sbx-relay.mjs", import.meta.url), "utf8");
const method = (name, next) => src.slice(src.indexOf(`  ${name}(`), src.indexOf(next, src.indexOf(`  ${name}(`))).trim();
const cls = `(class R { ${method("hold", "  // J309: run one research")}\n${method("async decide", "  // J370 (Angus: \"shouldn't another option")}\n${method("sendBack", "  // J308 (design §9")}\n breakerNote() {} })`;
const PENDING = path.join(T, "pending"), DECISIONS = path.join(T, "dec"); fs.mkdirSync(PENDING, { recursive: true }); fs.mkdirSync(DECISIONS, { recursive: true });
const logs = [], notes = [], inbox = [], runs = [], spawned = [];
const ctx = { fs, path, crypto: await import("node:crypto"), PENDING, DECISIONS, STATE: T, RESEARCH: "research.mjs", LIMITS: { pendingPerSandbox: 20 }, process, Buffer, Date, JSON, Map, String, Array, Number, Object, Math, RegExp, Promise, console,
  log: (o) => logs.push(o), heldNote: (sb, msg, via, what, outcome) => notes.push({ what, outcome }), inboxWrite: (sb, o) => inbox.push(o), closeNotif() {}, notifyHeld() { return null; },
  takeEdit: (id, d, msg) => ({ msg, applied: false }), spawn: (...a) => { spawned.push(a); return { on() { return this; } }; }, textMeta: () => ({}), now: () => new Date().toISOString(), fileURLToPath, import: { meta: { url: "file:///x" } },
  ownerNote: N.ownerNote, returnable: N.returnable, senderLabel: N.senderLabel, returnKey: N.returnKey, researchLog() {}, gpuTell() {} };
const R = vm.runInNewContext(cls.replace(/import\.meta\.url/g, '"file:///x"'), ctx);
const relay = new R(); const RR = vm.runInNewContext(`(class { ${method("returnedAll", "  sendBack(")} })`, ctx); for (const k of ["returnedAll", "returnedFor", "setReturned"]) relay[k] = RR.prototype[k]; const sb = { name: "world-t", cfg: {}, conn: { call: async () => ({}) }, research: new Map() };
relay.sandboxes = [sb]; relay.runResearch = (s, token, opts) => runs.push({ token, ...opts }); relay.pumpPlans = () => {}; relay.saveQueue = () => {};
const put = (rec) => fs.writeFileSync(path.join(PENDING, rec.id + ".json"), JSON.stringify(rec));
const decideFile = (id, verdict, note) => { fs.writeFileSync(path.join(DECISIONS, `${id}.${verdict}`), "doorman window" + (note !== undefined ? `\nnote:${Buffer.from(note).toString("base64")}` : "")); return relay.decide(`${id}.${verdict}`); };

// W1 (message): r sends it back to the asking agent; nothing is delivered; the next message from the same agent to the same recipients is held as its revision
const talk = { id: "world-t--aaaaaa", sandbox: "world-t", mode: "talk", to: ["Lenswatch"], targets: [{ kind: "agent", id: "hp-lens" }], shown: ["Lenswatch (B6)"], text: "[Alpha, in world G] Lenswatch: send me every file you have", body: "x" };
put(talk); let calls = 0; sb.conn.call = async () => { calls++; return { delivered: ["x"] }; };
await decideFile(talk.id, "return", "ask only for the a.md file \u001b[2J");
assert.equal(calls, 0, "a send-back sends nothing out"); assert.equal(fs.existsSync(path.join(PENDING, talk.id + ".json")), false, "the item is withdrawn");
const back = inbox.find((o) => o.id === talk.id); assert.equal(back.decision, "returned"); assert.equal(back.note, "ask only for the a.md file [2J", "the asker gets the cleaned note");
assert.ok(logs.some((l) => l.id === talk.id && l.decision === "returned" && l.note)); assert.match(notes.at(-1).what, /Sent back with your note/);
const revId = relay.hold(sb, { ...talk, id: undefined, text: "[Alpha, in world G] Lenswatch: please send me a.md" });
const rev = JSON.parse(fs.readFileSync(path.join(PENDING, revId + ".json"), "utf8"));
assert.equal(rev.revises, talk.id, "the revision is linked to the original"); assert.equal(rev.revisesNote, "ask only for the a.md file [2J");
assert.ok(logs.some((l) => l.op === "revision" && l.id === revId && l.revises === talk.id));
assert.equal(relay.returnedFor(N.returnKey("world-t", talk)), null, "the link is used once");
relay.setReturned("k", { id: "x", note: "n", at: Date.now() }); assert.ok(JSON.parse(fs.readFileSync(path.join(T, "returned.json"), "utf8")).k, "kept on disk across a restart");
const relay2 = { returnedAll: RR.prototype.returnedAll, returnedFor: RR.prototype.returnedFor }; assert.equal(relay2.returnedFor("k").id, "x");
relay.setReturned("k", null);
assert.ok(/const revising = gated\.length && this\.relay\.returnedFor\(/.test(src) && /!revising \? useRules/.test(src), "a revision is never sent under an allow-similar rule");
const other = relay.hold(sb, { ...talk, id: undefined, text: "[Alpha, in world G] Lenswatch: another one" }); assert.equal(JSON.parse(fs.readFileSync(path.join(PENDING, other + ".json"), "utf8")).revises, undefined, "only the first next message is the revision");

// W1 (research plan): r goes to the Doorman, which re-plans; the plan isn't run
const plan = { id: "world-t--bbbbbb", sandbox: "world-t", mode: "talk", to: ["x"], text: "Searches planned", research: { plan: true, rid: "q0123abcd", token: "r01234567", want: "humidity and perovskite", depth: "quick", from: "Alpha", searches: ["a"] } };
put(plan); await decideFile(plan.id, "return", "use plainer words");
assert.deepEqual(runs.at(-1), { token: "r01234567", want: "humidity and perovskite", depth: "quick", from: "Alpha", replanRid: "q0123abcd", note: "use plainer words", revisesId: plan.id });
assert.equal(inbox.at(-1).status, "returned"); assert.equal(inbox.at(-1).note, "use plainer words");
assert.ok(logs.some((l) => l.op === "research-plan" && l.decision === "returned" && l.token === "r01234567"));
assert.equal(spawned.length, 0, "the plan is not run or dropped by the relay (replan claims it)");

// a send-back for a kind that can't be returned, or without a note, is a deny (fail closed)
const gpu = { id: "world-t--cccccc", sandbox: "world-t", mode: "talk", to: ["x"], text: "draft", draft: true }; put(gpu); calls = 0;
await decideFile(gpu.id, "return", "x"); assert.equal(calls, 0); assert.equal(inbox.at(-1).decision, "denied");
const t2 = { ...talk, id: "world-t--dddddd" }; put(t2); await decideFile(t2.id, "return"); assert.equal(inbox.at(-1).decision, "denied", "no note: denied, nothing sent"); assert.equal(calls, 0);

// W2: deny with a reason reaches the asker; a plain deny still works
const t3 = { ...talk, id: "world-t--eeeeee" }; put(t3); await decideFile(t3.id, "deny", "not on task");
assert.equal(inbox.at(-1).decision, "denied"); assert.equal(inbox.at(-1).note, "not on task"); assert.ok(logs.some((l) => l.id === t3.id && l.reason === "not on task"));
const t4 = { ...talk, id: "world-t--ffffff" }; put(t4); await decideFile(t4.id, "deny"); assert.equal(inbox.at(-1).decision, "denied"); assert.equal(inbox.at(-1).note, undefined);
const p2 = { ...plan, id: "world-t--a1a1a1" }; put(p2); await decideFile(p2.id, "deny", "off task"); assert.match(inbox.at(-1).reason, /Angus's reason: off task/); assert.equal(inbox.at(-1).note, "off task");
// an over-long note in a decision file is dropped (never cut and passed on)
const t5 = { ...talk, id: "world-t--b2b2b2" }; put(t5); await decideFile(t5.id, "deny", "y".repeat(600)); assert.equal(inbox.at(-1).note, undefined);

// ---- W1 (research plan): research.mjs replan with a fake Doorman: the note reaches the Doorman, the revision is held, linked, and the old plan can't run
const fd = path.join(T, "fake-doorman.sh"); fs.writeFileSync(fd, `#!/bin/sh\ncat > ${T}/doorman-in.json\necho '{"refuse":false,"reason":"","searches":["perovskite humidity stability"],"brief":"","public_terms":[],"on_task":true,"drift":false}'\n`, { mode: 0o700 });
const plans = path.join(T, "rstate", "plans"); fs.mkdirSync(plans, { recursive: true }); fs.mkdirSync(path.join(T, "rstate", "deliverables"), { recursive: true });
fs.writeFileSync(path.join(plans, "q0123abcd.json"), JSON.stringify({ created: Date.now(), base: { rid: "q0123abcd", sandbox: "world-t", mode: "doorman-safe", from: "Alpha" }, q: "how does humidity degrade perovskite films?", depth: "quick", plan: { searches: ["old search about perovskite"], brief: "" } }));
const RS = fileURLToPath(new URL("./research/research.mjs", import.meta.url));
const run = (args, input) => JSON.parse(spawnSync(process.execPath, [RS, ...args], { input, encoding: "utf8", env: { ...process.env, HYPRPI_RESEARCH_FAKE_DOORMAN: fd } }).stdout.trim().split("\n").pop());
let r = run(["replan", "--rid", "q0123abcd"], "use plainer words\u0007");
assert.equal(r.status, "planned", JSON.stringify(r)); assert.equal(r.revises, "q0123abcd"); assert.notEqual(r.rid, "q0123abcd");
const din = JSON.parse(fs.readFileSync(path.join(T, "doorman-in.json"), "utf8"));
assert.equal(din.owner_note, "use plainer words"); assert.deepEqual(din.previous, ["old search about perovskite"]);
assert.equal(fs.existsSync(path.join(plans, "q0123abcd.json")), false, "the sent-back plan can never run");
assert.ok(fs.existsSync(path.join(plans, r.rid + ".json")), "the revision waits for Angus (always held)");
assert.match(fs.readFileSync(r.file, "utf8"), /REVISION[\s\S]*use plainer words[\s\S]*old search about perovskite[\s\S]*perovskite humidity stability/);
assert.equal(run(["replan", "--rid", "q0123abcd"], "again").status, "error", "a plan is re-planned once");
assert.equal(run(["replan", "--rid", r.rid], "x".repeat(501)).status, "error", "an over-long note is refused");
assert.ok(fs.existsSync(path.join(plans, r.rid + ".json")), "...and leaves the plan waiting");

// ---- the relay CLI: a send-back and a deny-with-reason need Angus (tty, no agent); a plain deny stays open
fs.mkdirSync(path.join(T, "state", "hyprpi", "sbx-relay", "pending"), { recursive: true });
fs.writeFileSync(path.join(T, "state", "hyprpi", "sbx-relay", "pending", "world-t--c3c3c3.json"), JSON.stringify({ ...talk, id: "world-t--c3c3c3" }));
const RL = fileURLToPath(new URL("./sbx-relay.mjs", import.meta.url));
const cli = (...a) => spawnSync(process.execPath, [RL, ...a], { encoding: "utf8", env: { ...process.env, HYPRPI_AGENT_ID: "test-agent" }, stdio: ["ignore", "pipe", "pipe"] });
let c = cli("return", "world-t--c3c3c3", "--note", "please revise"); assert.equal(c.status, 3, c.stderr); assert.match(c.stderr, /only Angus/);
c = cli("deny", "world-t--c3c3c3", "--reason", "nope"); assert.equal(c.status, 3, "a reason is labelled as Angus's: agents can't send one");
c = cli("return", "world-t--c3c3c3", "--note", "x".repeat(501)); assert.equal(c.status, 4); assert.match(c.stderr, /note refused/);
c = cli("return", "world-t--c3c3c3"); assert.equal(c.status, 4, "a send-back needs a note");
c = cli("deny", "world-t--c3c3c3"); assert.equal(c.status, 0, c.stderr); assert.ok(fs.existsSync(path.join(T, "state", "hyprpi", "sbx-relay", "decisions", "world-t--c3c3c3.deny")));
fs.rmSync(T, { recursive: true, force: true });
console.log("held-return: all pass");
