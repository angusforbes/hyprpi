#!/usr/bin/env node
// J412 part 3 (spec 1.5): the dial decides per request kind. The relay's exact source (hold, holdAuto, kindOfMsg, policy, refusalFor, and the
// mode re-check at the top of decide) runs with IO stubbed, in temp state, for every mode x kind:
//   held    → a pending record, no decision file, Angus is shown it (notifyHeld)
//   auto    → a pending record plus the relay's own decision "auto (<mode>)"; decide() logs ONE {op:auto, kind, reviewed:false, auto, via}
//   refused → hold() throws the one-line reason; nothing is written
// plus: yolo never auto-applies a change of the sandbox's own mode key; an auto that no longer applies at decision time is held instead; an
// approval of a kind the mode now refuses is turned into a denial.   node test/j412-policy.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { kindAction, MODES } from "../docker/research/mode.mjs";

const T = fs.mkdtempSync(path.join(os.tmpdir(), "j412-policy-"));
const src = fs.readFileSync(new URL("../docker/sbx-relay.mjs", import.meta.url), "utf8");
const between = (a, b) => { const i = src.indexOf(a); assert.ok(i >= 0, a); return src.slice(i, src.indexOf(b, i + a.length)).trim(); };
const PENDING = path.join(T, "pending"), DECISIONS = path.join(T, "dec");
const logs = [], shown = [];
const MODE = { now: "safe" };
const ctx = { fs, path, PENDING, DECISIONS, STATE: T, LIMITS: { pendingPerSandbox: 50 }, process, Buffer, Date, JSON, Map, Set, String, Array, Number, Object, Math, RegExp, Promise, console, Error,
  crypto: await import("node:crypto"), kindAction, researchConf: () => ({ mode: MODE.now }), now: () => new Date().toISOString(),
  log: (o) => logs.push(o), notifyHeld: (sb, msg) => { shown.push(msg); return null; }, REVIEW_CMD: ["node", "relay", "review"], textMeta: () => ({}),
  returnable: () => false, returnKey: () => "", fileURLToPath: (u) => String(u) };
// The methods under test, verbatim; hold()'s tail (toast, room note) is reached only for held items and is stubbed through notifyHeld/conn.
const body = between("  // J412 (spec 1.5): which request kind", "  // J309: run one research request");
const decideHead = between("    // J412: the dial at decision time.", "    // (re-review J368 #7)");
const R = vm.runInNewContext(`(class R {
  constructor() { this.sandboxes = []; }
  returnedFor() { return null; }
  ${body}
  // the part of decide() that applies the dial (verbatim), wrapped: returns { verdict, note, held } for an id and a decision file
  async dialCheck(id, verdict, via) { const pf = path.join(PENDING, id + ".json"); let note = "", byDial = false, autoMode = ""; const msg = JSON.parse(fs.readFileSync(pf, "utf8"));
    ${decideHead}
    return { verdict, note, msg, byDial }; }
})`, ctx);
const relay = new R();
const world = { name: "world-t", cfg: {}, relay }, door = { name: "doorman-t", doormanFor: "world-t", cfg: {}, relay, conn: { call: async () => ({}) } };
relay.sandboxes = [world, door];

// one held message per kind, as the ops build them
const MSG = {
  note: { typed: { type: "note_to_owner", for: "Alpha", sandbox: "world-t", params: { text: "x" } }, draft: true, mode: "talk", text: "n", shown: ["x"], to: ["x"] },
  message: { mode: "talk", to: ["hp-x"], targets: [{ kind: "agent", id: "hp-x" }], shown: ["X"], text: "hi", body: "hi" },
  share_project: { typed: { type: "share_project", for: "Alpha", sandbox: "world-t", params: {} }, draft: true, mode: "talk", text: "s", shown: ["x"], to: ["x"] },
  task_change: { taskChange: { sandbox: "world-t", task: "t", before: "" }, draft: true, mode: "talk", text: "t", shown: ["x"], to: ["x"] },
  send_file: { typed: { type: "send_file", for: "Alpha", sandbox: "world-t", params: {} }, draft: true, mode: "talk", text: "f", shown: ["x"], to: ["x"] },
  allow_host: { typed: { type: "allow_host", for: "Alpha", sandbox: "world-t", params: { host: "example.org" } }, draft: true, mode: "talk", text: "a", shown: ["x"], to: ["x"] },
  gpu: { gpu: { lease: "g1", dir: "/nonexistent" }, draft: true, mode: "talk", text: "g", shown: ["x"], to: ["x"] },
  draft: { draft: true, draftFor: "Alpha", draftAction: "x", mode: "talk", text: "d", shown: ["x"], to: ["the host-agent bridge"], targets: [] },
  gateway: { gatewayChange: { sandbox: "world-t", changes: { model: "x" } }, mode: "talk", text: "gw", shown: ["x"], to: ["x"] },
};
const SPEC = { // spec 1.5, as written there (strict / safe / open / yolo)
  note: ["held", "auto", "auto", "auto"], message: ["held", "held", "held", "auto"], share_project: ["held", "held", "auto", "auto"],
  task_change: ["held", "held", "held", "auto"], send_file: ["held", "held", "held", "auto"], allow_host: ["refused", "held", "held", "auto"],
  gpu: ["refused", "held", "held", "auto"], draft: ["refused", "held", "held", "auto"], gateway: ["held", "held", "held", "auto"],
};
const clear = () => { for (const d of [PENDING, DECISIONS]) fs.rmSync(d, { recursive: true, force: true }); };
let n = 0;
for (const [i, mode] of MODES.entries()) for (const [kind, msg] of Object.entries(MSG)) {
  clear(); MODE.now = mode; logs.length = 0; shown.length = 0;
  const want = SPEC[kind][i], sb = kind === "message" ? world : door;
  let got, id;
  try { id = relay.hold(sb, structuredClone(msg)); got = fs.existsSync(path.join(DECISIONS, `${id}.approve`)) ? "auto" : "held"; } catch (e) { got = "refused"; assert.match(e.message, /refused at once and not held/); }
  assert.equal(got, want, `${mode} ${kind}`);
  if (got === "held") { assert.ok(fs.existsSync(path.join(PENDING, id + ".json"))); assert.equal(shown.length, 1, "Angus is shown it"); }
  if (got === "refused") assert.ok(!fs.existsSync(PENDING) || !fs.readdirSync(PENDING).length, "nothing written for a refusal");
  if (got === "auto") {
    assert.equal(fs.readFileSync(path.join(DECISIONS, `${id}.approve`), "utf8").trim(), `auto (${mode})`); assert.equal(shown.length, 0, "no toast or review for auto");
    const r = await relay.dialCheck(id, "approve", `auto (${mode})`);
    assert.equal(r.verdict, "approve");
    const al = logs.filter((l) => l.op === "auto"); assert.equal(al.length, 1); assert.deepEqual({ ...al[0], id: "" }, { sb: sb.name, op: "auto", kind, reviewed: false, auto: mode, via: `auto (${mode})`, id: "" });
  }
  n++;
}
console.log(`PASS  every mode x kind of spec 1.5 (${n} cells): held / auto / refused as written, auto logged once reviewed:false`);

// yolo: a gateway change touching the sandbox's own mode key is held, never auto
clear(); MODE.now = "yolo"; shown.length = 0;
{ const id = relay.hold(door, { ...MSG.gateway, gatewayChange: { sandbox: "world-t", changes: { mode: "open" } } }); assert.ok(!fs.existsSync(path.join(DECISIONS, `${id}.approve`))); assert.equal(shown.length, 1); }
// and an "auto" decision that reaches decide() for a mode-key change (e.g. written by the propose CLI before a fix) is not applied: it stays held
clear(); fs.mkdirSync(PENDING, { recursive: true });
fs.writeFileSync(path.join(PENDING, "doorman-t--m00001.json"), JSON.stringify({ id: "doorman-t--m00001", sandbox: "doorman-t", ...MSG.gateway, gatewayChange: { sandbox: "world-t", changes: { mode: "open" } }, auto: { mode: "yolo", kind: "gateway" } }));
shown.length = 0; logs.length = 0;
{ const r = await relay.dialCheck("doorman-t--m00001", "approve", "auto (yolo)"); assert.equal(r, undefined, "decide returns early: nothing applied"); assert.equal(shown.length, 1, "shown to Angus as held"); assert.ok(!logs.some((l) => l.op === "auto")); }
console.log("PASS  yolo: a change of the sandbox's own mode key is always held (at hold time and at decision time)");

// an auto made in yolo that is decided after the mode went back to safe: held for Angus instead
clear(); MODE.now = "yolo"; const idA = relay.hold(door, structuredClone(MSG.send_file)); MODE.now = "safe"; shown.length = 0; logs.length = 0;
{ const r = await relay.dialCheck(idA, "approve", "auto (yolo)"); assert.equal(r, undefined); assert.equal(shown.length, 1); assert.equal(JSON.parse(fs.readFileSync(path.join(PENDING, idA + ".json"), "utf8")).auto, undefined, "no longer marked auto"); }
// an approval of a kind the mode now refuses becomes a denial with the dial's reason
clear(); MODE.now = "safe"; const idB = relay.hold(door, structuredClone(MSG.allow_host)); MODE.now = "strict";
{ const r = await relay.dialCheck(idB, "approve", "terminal"); assert.equal(r.verdict, "deny"); assert.equal(r.byDial, true, "labelled as the dial's denial"); assert.match(r.note, /mode strict doesn't allow allowing web hosts/); }
// a forged "auto" decision for an item that wasn't auto is ignored
clear(); MODE.now = "safe"; const idC = relay.hold(door, structuredClone(MSG.send_file));
{ const r = await relay.dialCheck(idC, "approve", "auto (safe)"); assert.equal(r, undefined); assert.ok(fs.existsSync(path.join(PENDING, idC + ".json")), "still held"); }
// HostReview412 #2 (Doorview's repro): an auto send_file made in yolo, the mode switched to open before decide: the fallback hold goes through
// the normal routing (review_in / review_room → rooms [H], reviewIn), not the op's rooms [A]
clear(); door.cfg = { review_in: "doorman-t", review_room: "H", doorman_for: "world-t" }; MODE.now = "yolo";
const idD = relay.hold(door, { ...structuredClone(MSG.send_file), rooms: ["A"] }); assert.ok(fs.existsSync(path.join(DECISIONS, `${idD}.approve`)), "auto in yolo");
MODE.now = "open"; shown.length = 0;
{ const r = await relay.dialCheck(idD, "approve", "auto (yolo)"); assert.equal(r, undefined); const rec = JSON.parse(fs.readFileSync(path.join(PENDING, idD + ".json"), "utf8"));
  assert.deepEqual(rec.rooms, ["H"]); assert.equal(rec.reviewIn, "doorman-t"); assert.equal(rec.auto, undefined); assert.equal(shown.length, 1); assert.equal(shown[0].reviewIn, "doorman-t", "the toast is routed too"); }
door.cfg = {};
console.log("PASS  decision-time re-check: a stale auto is held, a now-refused kind is denied with the dial's reason, a forged auto is ignored");
// J412 red team #5 (LOW): the strict refusal of a draft at the op carries the shared UNSUPPORTED guidance (source check: the op needs a live bridge)
{ const line = src.split("\n").find((l) => l.includes('this.relay.policy(this, "draft") === "refused"')); assert.ok(line && line.includes("${UNSUPPORTED}"), "strict draft refusal includes UNSUPPORTED"); }
console.log("PASS  a strict draft refusal carries the shared UNSUPPORTED guidance");
fs.rmSync(T, { recursive: true, force: true });
console.log("j412-policy: all pass");
