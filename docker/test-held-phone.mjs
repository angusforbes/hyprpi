// node docker/test-held-phone.mjs  (J434): deciding a sandboxed world's held items from the phone app.
//  A) lib/held.mjs phoneDecision: off by default (gateway.phone_decisions), the shown item only (digest), the 2 s rule, the J412 keys, the gateway / mode
//     change refused, a decision file "phone" + note + digest when it passes.
//  B) the relay's decide() (its exact source, IO stubbed, as test-held-keys.mjs): a "phone" decision goes through only with the setting on and the digest
//     of what is pending now; off, a changed item, or a gateway change: nothing decided, it stays held. Other routes are untouched.
//  C) the phone server (remote-control/server.mjs, a throwaway instance on its own port and temp state): GET /api/held shows the item in full;
//     POST /api/held/decide from a process on this machine (uid ≠ 0, as an agent's curl) is refused 403.
// Throwaway state only (XDG_* point at a temp dir).
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
const T = fs.mkdtempSync(path.join(os.tmpdir(), "j434-"));
process.env.XDG_CONFIG_HOME = path.join(T, "cfg"); process.env.XDG_STATE_HOME = path.join(T, "state"); process.env.HYPRPI_RESEARCH_STATE = path.join(T, "rstate");
delete process.env.HYPRPI_SANDBOX_WORLD; delete process.env.HYPRPI_G_WORLD;
const CFG = path.join(T, "cfg", "hyprpi"); fs.mkdirSync(path.join(CFG, "worlds"), { recursive: true });
const world = (on) => fs.writeFileSync(path.join(CFG, "worlds", "world-t.json"), JSON.stringify({ sandbox: "world-t", workspaces: [61, 62], gateway: { mode: "safe", ...(on === undefined ? {} : { phone_decisions: on }) } }));
fs.writeFileSync(path.join(CFG, "sbx-relay.json"), JSON.stringify({ sandboxes: [{ name: "world-t" }, { name: "doorman-t", doorman_for: "world-t" }] }));
const RS = path.join(T, "state", "hyprpi", "sbx-relay"), PENDING = path.join(RS, "pending"), DECISIONS = path.join(RS, "decisions");
fs.mkdirSync(PENDING, { recursive: true }); fs.mkdirSync(DECISIONS, { recursive: true });
const H = await import("../lib/held.mjs"), M = await import("./research/mode.mjs"), N = await import("./held-note.mjs");
const ok = (m) => console.log("ok " + m);
const put = (rec) => fs.writeFileSync(path.join(PENDING, rec.id + ".json"), JSON.stringify(rec));
const talk = (id, at, extra = {}) => ({ id, at, sandbox: "world-t", mode: "talk", to: ["Lens"], targets: [{ kind: "agent", id: "hp-lens" }], shown: ["Lens (B6)"], rooms: ["B"], text: "[Alpha, in world G] Lens: hello", body: "BODY", ...extra });
const names = ["world-t", "doorman-t"];
const cur = () => H.heldForSandboxes(names)[0];
const decFiles = () => fs.readdirSync(DECISIONS).filter((f) => !f.startsWith("."));
const clearDec = () => { for (const f of fs.readdirSync(DECISIONS)) fs.unlinkSync(path.join(DECISIONS, f)); };

// ---- A) phoneDecision
world(undefined);
assert.equal(M.phoneDecisionsFor(CFG, "world-t"), false, "default off"); world(false); assert.equal(M.phoneDecisionsFor(CFG, "world-t"), false); world(true); assert.equal(M.phoneDecisionsFor(CFG, "world-t"), true);
put(talk("world-t--a00001", "2026-10-10T10:00:00Z"));
let h = cur(), dg = H.heldDigest(h), old = Date.now() - 5000;
assert.match(H.phoneDecision({ sandboxes: names, id: h.id, digest: dg, raw: "1", shownAt: old, enabled: false }).text, /phone decisions are off/);
assert.match(H.phoneDecision({ sandboxes: names, id: h.id, digest: "0".repeat(64), raw: "1", shownAt: old, enabled: true }).text, /changed since it was shown/);
assert.match(H.phoneDecision({ sandboxes: names, id: h.id, digest: dg, raw: "1", shownAt: Date.now() - 500, enabled: true }).text, /2 s/);
assert.match(H.phoneDecision({ sandboxes: names, id: "world-t--ffffff", digest: dg, raw: "1", shownAt: old, enabled: true }).text, /no longer the one waiting/);
assert.match(H.phoneDecision({ sandboxes: names, id: h.id, digest: dg, raw: "yes", shownAt: old, enabled: true }).text, /type 1/);
assert.equal(H.phoneDecision({ sandboxes: names, id: h.id, digest: dg, raw: "1+ 2h", shownAt: old, enabled: true }).confirm, true, "1+ for a time other than 1 h asks to confirm");
assert.equal(decFiles().length, 0, "nothing written by refusals");
let r = H.phoneDecision({ sandboxes: names, id: h.id, digest: dg, raw: "1 thanks, go ahead", shownAt: old, enabled: true });
assert.equal(r.ok, true); assert.deepEqual(decFiles(), ["world-t--a00001.approve"]);
const body = fs.readFileSync(path.join(DECISIONS, "world-t--a00001.approve"), "utf8").split("\n");
assert.equal(body[0], "phone"); assert.equal(Buffer.from(body[1].slice(5), "base64").toString(), "thanks, go ahead"); assert.equal(body[2], "digest:" + dg);
clearDec(); fs.unlinkSync(path.join(PENDING, "world-t--a00001.json"));
// a plain 1+ for 1 h, and the gateway change refused
put(talk("world-t--a00002", "2026-10-10T10:01:00Z")); h = cur(); dg = H.heldDigest(h);
r = H.phoneDecision({ sandboxes: names, id: h.id, digest: dg, raw: "1+", shownAt: old, enabled: true }); assert.equal(r.ok, true); assert.deepEqual(decFiles(), ["world-t--a00002.allow-60"]);
clearDec(); fs.unlinkSync(path.join(PENDING, "world-t--a00002.json"));
put({ id: "world-t--a00003", at: "2026-10-10T10:02:00Z", sandbox: "world-t", rooms: ["B"], gatewayChange: { sandbox: "world-t", changes: { mode: "yolo" } }, text: "Change world-t's gateway: mode safe -> yolo" });
h = cur(); dg = H.heldDigest(h); assert.match(h.kind, /^gateway setting/);
assert.match(H.phoneDecision({ sandboxes: names, id: h.id, digest: dg, raw: "1", shownAt: old, enabled: true }).text, /laptop only/);
assert.equal(decFiles().length, 0);
fs.unlinkSync(path.join(PENDING, "world-t--a00003.json"));
ok("A: phoneDecision: off by default, digest, 2 s, keys, 1+ confirm, gateway change refused, file = phone + note + digest");

// ---- B) the relay's decide() for a "phone" decision
const src = fs.readFileSync(new URL("./sbx-relay.mjs", import.meta.url), "utf8");
const cut = (from, to) => { const i = src.indexOf(from); assert.ok(i > 0, from); const j = src.indexOf(to, i + from.length); assert.ok(j > i, to); return src.slice(i, j).trim(); };
const helpers = cut("export const said", "// J412: a Doorman entry runs").replace(/^export /gm, "");
const cls = `${helpers}\n(class R { ${cut("  hold(sb, msg) {", "  // J309: run one research")}\n${cut("  askerText(msg, id,", "  // J412 (spec 2.3): every \"2\"")}\n${cut("  returnedAll() {", "  // J308 (design §9")}\n breakerNote() {} kindOfMsg() { return null; } agentFree() { return false; } jobRecord() { return true; } typedCtx() { return {}; } saveQueue() {} pumpPlans() {} deliverResearch() { return "research-q1.md"; } })`;
const logs = [], inbox = [], calls = [];
const clean = (s) => String(s ?? "").replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]|\p{Cf}/gu, "").trim();
const ctx = { fs, path, crypto: await import("node:crypto"), PENDING, DECISIONS, STATE: RS, CONFIG: path.join(CFG, "sbx-relay.json"), RESEARCH: "research.mjs", LIMITS: { pendingPerSandbox: 20, researchRunning: 2 }, process, Buffer, Date, JSON, Map, Set, String, Array, Number, Object, Math, RegExp, Promise, console, setTimeout, clearTimeout,
  log: (o) => logs.push(o), heldNote() {}, inboxWrite: (sb, o) => inbox.push({ sb: sb.name, ...o }), closeNotif() {}, notifyHeld() { return null; }, clean,
  spawn: () => { throw new Error("no spawn in tests"); }, textMeta: () => ({}), now: () => new Date().toISOString(), fileURLToPath, REQ_TYPES: {}, reqRun: async () => ({ ok: true, outcome: "sent" }),
  ownerNote: N.ownerNote, holdReason: N.holdReason, linkable: N.linkable, returnKey: N.returnKey, researchLog() {}, researchDropPlan: () => true,
  REVIEW_CMD: ["node", "relay", "review"], routeHeld: undefined, addRules: (st, o) => [{ n: 1, recipient: "x", until: Date.now() + o.dur.ms }], ALLOW_MAX_MS: 8 * 3600e3, watchReply() {}, researchConf: () => ({ mode: "safe" }), newHostJob: () => ({ history: [] }),
  heldDigestFor: H.heldDigestFor, PHONE_REFUSED_KINDS: H.PHONE_REFUSED_KINDS, phoneDecisionsFor: M.phoneDecisionsFor };
const R = vm.runInNewContext(cls.replace(/import\.meta\.url/g, '"file:///x"'), ctx);
const relay = new R();
const sb = { name: "world-t", cfg: {}, conn: { call: async (op, a) => { calls.push(a); return { delivered: ["Lens"], request_id: "rq1" }; } }, research: new Map() };
relay.sandboxes = [sb, { name: "doorman-t", doormanFor: "world-t", cfg: {}, conn: sb.conn }]; relay.draftAnswers = new Map(); relay.bridge = { answer: () => true, mode: () => ({ mode: "", agents: [] }) };
const phoneFile = (id, verdict, digest, note) => { fs.writeFileSync(path.join(DECISIONS, `${id}.${verdict}`), "phone" + (note ? `\nnote:${Buffer.from(note).toString("base64")}` : "") + (digest ? `\ndigest:${digest}` : "")); return relay.decide(`${id}.${verdict}`); };
const held = (id) => fs.existsSync(path.join(PENDING, id + ".json"));
// off: stays held
world(false); put(talk("world-t--b00001", "2026-10-10T11:00:00Z"));
await phoneFile("world-t--b00001", "approve", H.heldDigestFor("world-t--b00001", "world-t"));
assert.ok(held("world-t--b00001"), "off: stays held"); assert.match(logs.at(-1).error, /phone decisions are off/);
// on, wrong digest / no digest: stays held
world(true);
await phoneFile("world-t--b00001", "approve", "f".repeat(64)); assert.ok(held("world-t--b00001")); assert.match(logs.at(-1).error, /digest/);
await phoneFile("world-t--b00001", "approve", ""); assert.ok(held("world-t--b00001"));
// on, the item changed after it was shown (its text): the old digest no longer counts
const shown = H.heldDigestFor("world-t--b00001", "world-t");
put(talk("world-t--b00001", "2026-10-10T11:00:00Z", { text: "[Alpha, in world G] Lens: hello, and also this" }));
await phoneFile("world-t--b00001", "approve", shown); assert.ok(held("world-t--b00001"), "changed item: stays held");
// on, right digest: decided, logged via phone, the recipient gets exactly the approved text
await phoneFile("world-t--b00001", "approve", H.heldDigestFor("world-t--b00001", "world-t"), "ok from the phone");
assert.ok(!held("world-t--b00001"), "decided"); assert.equal(calls.at(-1).text, "BODY");
assert.ok(logs.some((o) => o.op === "decision_via" && o.via === "phone" && o.id === "world-t--b00001"), "logged via phone");
assert.equal(inbox.filter((o) => o.id === "world-t--b00001").at(-1).decision, "approved");
// a gateway (mode) change from the phone: stays held even with the setting on and the right digest
put({ id: "world-t--b00002", at: "2026-10-10T11:01:00Z", sandbox: "world-t", rooms: ["B"], gatewayChange: { sandbox: "world-t", changes: { mode: "yolo" } }, text: "Change world-t's gateway: mode safe -> yolo" });
await phoneFile("world-t--b00002", "approve", H.heldDigestFor("world-t--b00002", "world-t")); assert.ok(held("world-t--b00002")); assert.match(logs.at(-1).error, /laptop only/);
fs.unlinkSync(path.join(PENDING, "world-t--b00002.json"));
// a non-proposable setting: no agent can propose phone_decisions
const GA = await import("./research/gateway-admin.mjs");
assert.equal(GA.validateChanges({ phone_decisions: "true" }).ok, false); assert.equal(GA.validateChanges({ phone_decisions: "true" }, { admin: true }).ok, true);
ok("B: relay: phone decision only with the setting on and the shown digest; changed item, wrong / no digest, gateway change: stays held; phone_decisions isn't proposable");

// ---- C) the phone server: shows the item; refuses a decision from a local process (uid ≠ 0)
put(talk("world-t--c00001", "2026-10-10T12:00:00Z"));
const PORT = 18000 + Math.floor(Math.random() * 1000);
const srv = spawn(process.execPath, [fileURLToPath(new URL("../remote-control/server.mjs", import.meta.url))], { env: { ...process.env, HYPRPI_REMOTE_PORT: String(PORT), HYPRPI_SOCKET: path.join(T, "none.sock") }, stdio: ["ignore", "pipe", "pipe"] });
try {
  let up = false; for (let i = 0; i < 50 && !up; i++) { await new Promise((r) => setTimeout(r, 200)); try { await fetch(`http://127.0.0.1:${PORT}/api/held?world=G`); up = true; } catch { /* not yet */ } }
  // world-t's workspaces 61.. = world G
  const g = await (await fetch(`http://127.0.0.1:${PORT}/api/held?world=G`)).json();
  assert.ok(g.item && g.item.id === "world-t--c00001" && /Lens: hello/.test(g.item.text) && g.phoneDecisions === true, JSON.stringify(g).slice(0, 200));
  await new Promise((r) => setTimeout(r, 2200));
  const d = await fetch(`http://127.0.0.1:${PORT}/api/held/decide`, { method: "POST", headers: { "content-type": "application/json", origin: `http://127.0.0.1:${PORT}` }, body: JSON.stringify({ world: "G", id: g.item.id, digest: g.digest, choice: "1" }) });
  assert.equal(d.status, 403, "a local process (uid " + process.getuid() + ") can't decide"); assert.ok(held("world-t--c00001")); assert.equal(decFiles().length, 0);
  world(false);
  const g2 = await (await fetch(`http://127.0.0.1:${PORT}/api/held?world=G`)).json(); assert.equal(g2.phoneDecisions, false); assert.equal(g2.item.phone, false, "off: read-only");
  ok("C: phone server shows the held item in full; a decision from this machine (an agent's curl) is refused 403; off = read-only");
} finally { srv.kill("SIGTERM"); }
fs.rmSync(T, { recursive: true, force: true });
console.log("PASS");
