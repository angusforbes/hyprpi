// node docker/doorman/test-review-provider.mjs  (J363). Throwaway state only: XDG_STATE_HOME and HYPRPI_RELAY_CONF point at a temp dir.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
const T = fs.mkdtempSync(path.join(os.tmpdir(), "j363-"));
process.env.XDG_STATE_HOME = path.join(T, "state"); process.env.HYPRPI_RELAY_CONF = path.join(T, "relay.json");
const ws = path.join(T, "ws"); fs.mkdirSync(path.join(ws, ".hyprpi-dropbox", "outbox"), { recursive: true });
fs.writeFileSync(process.env.HYPRPI_RELAY_CONF, JSON.stringify({ sandboxes: [{ name: "world-t", workspace: ws }, { name: "door-t", doorman_for: "world-t" }, { name: "other", workspace: ws }] }));
const P = path.join(T, "state", "hyprpi", "sbx-relay", "pending"); fs.mkdirSync(P, { recursive: true });
const put = (id, o) => fs.writeFileSync(path.join(P, id + ".json"), JSON.stringify({ id, at: new Date(Date.now() + Object.keys(o).length).toISOString(), ...o }));
const { default: createReview, RESEARCH_RE } = await import("./review-provider.mjs");
const r = createReview("door-t");
assert.equal(r.current(), null, "nothing held");
put("world-t--000001", { sandbox: "world-t", at: "2026-10-09T10:00:02Z", shown: ["Thoughts-A"], to: ["x"], mode: "talk", text: "hello there", rooms: ["G"] });
put("door-t--000002", { sandbox: "door-t", at: "2026-10-09T10:00:01Z", shown: ["Thoughts-A"], mode: "talk", draft: true, text: "Request drafted by Door", rooms: ["G"] });
put("other--000003", { sandbox: "other", at: "2026-10-09T09:00:00Z", shown: ["y"], mode: "talk", text: "not mine" });
put("world-t--000004", { sandbox: "world-t", at: "2026-10-09T10:00:03Z", shown: ["world-t (research searches)"], mode: "talk", text: "Searches planned", research: { plan: true, want: "w", searches: ["s one", "s two"] } });
let c = r.current();
assert.equal(c.id, "door-t--000002", "oldest of THIS Doorman's sandboxes first (the other sandbox's item is not shown)");
assert.deepEqual(c.choices, ["1", "2"], "a draft has no allow-similar");
assert.match(c.text, /drafted request\nfrom door-t/); assert.match(c.text, /Request drafted by Door/);
assert.equal(r.decide("world-t--000001", "1").ok, false, "only the item on screen (the oldest) can be decided");
assert.equal(r.decide("door-t--000002", "3").ok, false, "3 isn't offered for a draft");
const ap = r.decide("door-t--000002", "1");
assert.equal(ap.ok, false); assert.match(ap.text, /only Angus can approve|terminal|agent/i, "approve goes through the guarded host path, which refuses under an agent / without a terminal: " + ap.text);
const dn = r.decide("door-t--000002", "2"); // deny is open to anyone and only writes a decision file in the throwaway state
assert.equal(dn.ok, true, dn.text); assert.ok(fs.readdirSync(path.join(T, "state", "hyprpi", "sbx-relay", "decisions")).some((f) => /000002\.deny$/.test(f)), "the host decision file was written");
fs.rmSync(path.join(P, "door-t--000002.json"));
c = r.current(); assert.equal(c.id, "world-t--000001"); assert.deepEqual(c.choices, ["1", "2", "3"], "a plain talk offers allow-similar");
fs.rmSync(path.join(P, "world-t--000001.json"));
c = r.current(); assert.equal(c.id, "world-t--000004"); assert.match(c.text, /research plan/); assert.match(c.text, /- s one\n- s two/); assert.deepEqual(c.choices, ["1", "2"]);
// suggest: a research request from Angus goes to the sandbox's drop-box like the gateway's
assert.equal(r.suggest("hello doorman"), null); assert.equal(r.suggest("research"), null); assert.equal(r.suggest("1"), null);
const s1 = r.suggest("Research (deep): perovskite  encapsulation\tmethods"); assert.equal(s1.ok, true, s1.text);
const out = path.join(ws, ".hyprpi-dropbox", "outbox"), files = fs.readdirSync(out).filter((f) => f.endsWith(".json")); assert.equal(files.length, 1);
const req = JSON.parse(fs.readFileSync(path.join(out, files[0]), "utf8")); assert.deepEqual(req, { op: "research", looking_for: "perovskite encapsulation methods", depth: "deep", from: "Angus (window)" });
assert.equal(r.suggest("Research: " + "x".repeat(1100)).ok, false); assert.equal(r.suggest("Research:   ").ok, false);
assert.ok(RESEARCH_RE.test("research: x") && !RESEARCH_RE.test("re-research: x"));
console.log("review-provider: all pass");
// a symlinked drop-box directory must not be followed (the sandbox controls it)
fs.rmSync(path.join(ws, ".hyprpi-dropbox"), { recursive: true }); const elsewhere = path.join(T, "elsewhere"); fs.mkdirSync(elsewhere);
fs.mkdirSync(path.join(ws, ".hyprpi-dropbox")); fs.symlinkSync(elsewhere, path.join(ws, ".hyprpi-dropbox", "outbox"));
const bad = r.suggest("Research: sneaky"); assert.equal(bad.ok, false); assert.deepEqual(fs.readdirSync(elsewhere), [], "nothing written through the symlink");
fs.rmSync(path.join(ws, ".hyprpi-dropbox"), { recursive: true }); fs.mkdirSync(path.join(T, "real-db", "outbox"), { recursive: true }); fs.symlinkSync(path.join(T, "real-db"), path.join(ws, ".hyprpi-dropbox"));
assert.equal(r.suggest("Research: sneaky2").ok, false, "a symlinked parent is refused too");
console.log("review-provider: symlink cases pass");
