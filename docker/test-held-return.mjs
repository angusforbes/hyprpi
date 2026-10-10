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
const logs = [], notes = [], inbox = [], runs = [], spawned = [], dropCalls = [];
const ctx = { fs, path, crypto: await import("node:crypto"), PENDING, DECISIONS, STATE: T, RESEARCH: "research.mjs", LIMITS: { pendingPerSandbox: 20 }, process, Buffer, Date, JSON, Map, String, Array, Number, Object, Math, RegExp, Promise, console,
  log: (o) => logs.push(o), heldNote: (sb, msg, via, what, outcome) => notes.push({ what, outcome }), inboxWrite: (sb, o) => inbox.push(o), closeNotif() {}, notifyHeld() { return null; },
  takeEdit: (id, d, msg) => ({ msg, applied: false }), spawn: (...a) => { spawned.push(a); return { on() { return this; } }; }, textMeta: () => ({}), now: () => new Date().toISOString(), fileURLToPath, import: { meta: { url: "file:///x" } },
  ownerNote: N.ownerNote, holdReason: N.holdReason, returnable: N.returnable, senderLabel: N.senderLabel, returnKey: N.returnKey, researchLog() {}, researchDropPlan: (rid) => { dropCalls.push(rid); return true; }, gpuTell() {} };
const R = vm.runInNewContext(cls.replace(/import\.meta\.url/g, '"file:///x"'), ctx);
const relay = new R(); const RR = vm.runInNewContext(`(class { ${method("returnedAll", "  // J370 (ReturnReview)")}\n${method("replansAll", "  sendBack(")} })`, ctx); for (const k of ["returnedAll", "openOf", "returnedFor", "writeReturned", "openReturn", "closeReturn", "replansAll", "setReplan", "reconcileReplans"]) relay[k] = RR.prototype[k]; const sb = { name: "world-t", cfg: {}, conn: { call: async () => ({}) }, research: new Map() };
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
// J370b (red team): the open send-back is keyed on the SANDBOX and is not used up by the first revision
assert.equal(relay.returnedFor("world-t").open.length, 1, "still open after a revision was held (a decoy can't use it up)");
const other = relay.hold(sb, { ...talk, id: undefined, text: "[Beta\u034f, in world G] Thoughts-A: anything else" });
assert.equal(JSON.parse(fs.readFileSync(path.join(PENDING, other + ".json"), "utf8")).revises, talk.id, "any later message of that sandbox is shown as a possible revision, whatever its label or recipients");
const relay2 = { returnedAll: RR.prototype.returnedAll, openOf: RR.prototype.openOf, returnedFor: RR.prototype.returnedFor }; assert.equal(relay2.returnedFor("world-t").open[0].id, talk.id, "kept on disk across a restart");
// Angus deciding a revision closes the send-back it revises; then rules resume
put({ id: revId, ...rev }); await decideFile(revId, "deny");
assert.equal(relay.returnedFor("world-t"), null, "closed once Angus decided its revision");
// it expires after 24 h (longer than any rule), never after 1 h
relay.openReturn("world-t", { id: "world-t--old111", note: "", at: Date.now() - 2 * 3600e3 }); assert.ok(relay.returnedFor("world-t"), "still open after 2 h");
relay.closeReturn("world-t", "world-t--old111"); relay.openReturn("world-t", { id: "world-t--old222", note: "", at: Date.now() - 25 * 3600e3 }); assert.equal(relay.returnedFor("world-t"), null, "gone after 24 h");
// fail closed: an unreadable / corrupt returned.json pauses rules for an hour (every sandbox answers), and a later write or a restart doesn't lift it
fs.writeFileSync(path.join(T, "returned.json"), "{corrupt");
const mk = () => { const o = {}; for (const k of ["returnedAll", "openOf", "returnedFor", "writeReturned", "openReturn", "closeReturn"]) o[k] = RR.prototype[k]; return o; };
const r1 = mk(); assert.equal(r1.returnedFor("alpha").broken, true, "corrupt state: no rule may auto-send");
r1.openReturn("beta", { id: "b", note: "n", at: Date.now() }); assert.equal(r1.returnedFor("alpha").broken, true, "...an unrelated write keeps the quarantine");
const r2 = mk(); assert.equal(r2.returnedFor("alpha").broken, true, "and it survives a restart"); assert.equal(r2.returnedFor("beta").open[0].id, "b");
fs.writeFileSync(path.join(T, "returned.json"), JSON.stringify({ _quarantine: Date.now() - 1 })); assert.equal(mk().returnedFor("alpha"), null, "after the hour: rules work again");
fs.rmSync(path.join(T, "returned.json")); fs.mkdirSync(path.join(T, "returned.json"));
const r4 = mk(); r4.openReturn("k2", { id: "y", note: "n", at: Date.now() }); assert.equal(r4.writeBroken, true); assert.equal(r4.returnedFor("k2").open[0].id, "y"); assert.ok(r4.returnedFor("other"));
fs.rmSync(path.join(T, "returned.json"), { recursive: true }); r4.quarantine = 0; r4.returnedMem = {}; r4.closeReturn("k2", "y"); r4.writeReturned({}); assert.equal(r4.writeBroken, false); assert.equal(r4.returnedFor("other"), null);
assert.ok(/const revising = gated\.length && this\.relay\.returnedFor\(this\.name\)/.test(src) && /!revising \? useRules/.test(src), "no rule sends from a sandbox with an open send-back");
// a corrupt replans.json is kept aside and logged, never silently empty
fs.writeFileSync(path.join(T, "replans.json"), "{bad"); assert.equal(Object.keys(relay.replansAll()).length, 0); assert.ok(fs.readdirSync(T).some((f) => f.startsWith("replans.json.corrupt-"))); assert.ok(logs.some((l) => /replans\.json was unreadable/.test(l.error || "")));

// W1 (research plan): r goes to the Doorman, which re-plans; the plan isn't run
const plan = { id: "world-t--bbbbbb", sandbox: "world-t", mode: "talk", to: ["x"], text: "Searches planned", research: { plan: true, rid: "q0123abcd", token: "r01234567", want: "humidity and perovskite", depth: "quick", from: "Alpha", searches: ["a"] } };
put(plan); await decideFile(plan.id, "return", "use plainer words");
assert.deepEqual(runs.at(-1), { token: "r01234567", want: "humidity and perovskite", depth: "quick", from: "Alpha", replanRid: "q0123abcd", note: "use plainer words", revisesId: plan.id });
assert.equal(inbox.at(-1).status, "returned"); assert.equal(inbox.at(-1).note, "use plainer words");
assert.ok(logs.some((l) => l.op === "research-plan" && l.decision === "returned" && l.token === "r01234567"));
assert.equal(spawned.length, 0, "the plan is not run or dropped by the relay (replan claims it)");
assert.equal(relay.replansAll()["r01234567"].id, plan.id, "the rewrite in flight is kept on disk");
relay.reconcileReplans(); // as at a relay start: the rewrite was cut off
assert.equal(inbox.at(-1).status, "error"); assert.match(inbox.at(-1).reason, /relay restarted while the Doorman was rewriting/);
assert.ok(logs.some((l) => l.token === "r01234567" && l.status === "error" && l.end)); assert.deepEqual(relay.replansAll(), {}, "reconciled once");

// a send-back for a kind that can't be returned, or without a note, is a deny (fail closed)
const gpu = { id: "world-t--cccccc", sandbox: "world-t", mode: "talk", to: ["x"], text: "draft", draft: true }; put(gpu); calls = 0;
await decideFile(gpu.id, "return", "x"); assert.equal(calls, 0); assert.equal(inbox.at(-1).decision, "denied");
// J386: a bare r (no note) sends it back with the hold's own reason, verbatim and labelled
const t2 = { ...talk, id: "world-t--dddddd" }; put(t2); await decideFile(t2.id, "return");
assert.equal(inbox.at(-1).decision, "returned", "a bare r sends it back"); assert.equal(calls, 0, "nothing sent");
assert.equal(inbox.at(-1).note, ""); assert.match(inbox.at(-1).reason, /^held because \(relay\): a message from the sandbox to Lenswatch waits for Angus's approval/);
// a bare r on a research plan held as an exception goes back to the ASKER with the Doorman's reason verbatim; the plan is dropped, no re-plan
const ex = { id: "world-t--e1e1e1", sandbox: "world-t", mode: "talk", to: ["x"], text: "Searches planned", research: { plan: true, rid: "q1111aaaa", token: "r11111111", want: "w", depth: "quick", from: "Alpha", searches: ["a"], exception: "unrelated to this sandbox's task: it asks about \u001b[31mfootball\u202e" } };
const runsBefore = runs.length; spawned.length = 0; put(ex); await decideFile(ex.id, "return");
assert.equal(inbox.at(-1).status, "returned-asker"); assert.equal(runs.length, runsBefore, "no re-plan");
assert.equal(inbox.at(-1).reason, "held because (Doorman): unrelated to this sandbox's task: it asks about [31mfootball", "verbatim, labelled, cleaned");
assert.ok(dropCalls.includes("q1111aaaa"), "the plan is dropped synchronously");
// r <note> on a plan still re-plans via the Doorman, and carries the reason too
const ex2 = { ...ex, id: "world-t--e2e2e2", research: { ...ex.research, rid: "q2222bbbb", token: "r22222222" } }; put(ex2); await decideFile(ex2.id, "return", "keep it on perovskites");
assert.equal(inbox.at(-1).status, "returned"); assert.equal(runs.at(-1).replanRid, "q2222bbbb"); assert.match(inbox.at(-1).reason, /^held because \(Doorman\)/);
// no recorded reason: says so
assert.equal(N.holdReason({ research: { plan: true } }), "held for review; no reason recorded");
assert.equal(N.holdReason({ research: { plan: true, mode: "doorman-strict" } }).startsWith("held because (host): strict mode"), true);
assert.ok(N.holdReason({ research: { plan: true, exception: "x".repeat(2000) } }).length <= N.REASON_MAX, "capped");
assert.match(N.holdReason({ research: { plan: true, exception: "no task set for this sandbox" } }), /^held because \(host\)/);

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
c = cli("return", "world-t--c3c3c3"); assert.equal(c.status, 3, "a bare send-back is allowed but still needs Angus (terminal, no agent)");
c = cli("deny", "world-t--c3c3c3"); assert.equal(c.status, 0, c.stderr); assert.ok(fs.existsSync(path.join(T, "state", "hyprpi", "sbx-relay", "decisions", "world-t--c3c3c3.deny")));
// J378: only a Doorman and its own sandbox are open peers; any other relay sandbox pair is gated
const G = { name: "world-g", doormanFor: null }, D = { name: "doorman-g", doormanFor: "world-g" }, P = { name: "sbxprobe", doormanFor: null }, D2 = { name: "doorman-x", doormanFor: "world-x" };
assert.equal(N.openPeer(G, D), true); assert.equal(N.openPeer(D, G), true, "G and its Doorman talk at once (both ways)");
assert.equal(N.openPeer(G, P), false); assert.equal(N.openPeer(P, G), false, "another relay sandbox (another world, a probe): gated");
assert.equal(N.openPeer(G, D2), false); assert.equal(N.openPeer(G, G), false); assert.equal(N.openPeer(null, G), false);
assert.ok(/s\.conn && pairOk\(s\) && openPeer\(this, s\)\)/.test(src), "the relay's open set is limited by openPeer");
fs.rmSync(T, { recursive: true, force: true });
console.log("held-return: all pass");
