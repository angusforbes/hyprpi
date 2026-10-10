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
assert.deepEqual(c.choices, ["1", "2"], "a draft has no allow-similar, can't be edited or sent back");
assert.match(c.text, /drafted request\nfrom door-t/); assert.match(c.text, /Request drafted by Door/);
assert.equal(r.decide("world-t--000001", "1").ok, false, "only the item on screen (the oldest) can be decided");
assert.equal(r.decide("door-t--000002", "3").ok, false, "3 isn't offered for a draft");
const ap = r.decide("door-t--000002", "1");
assert.equal(ap.ok, false); assert.match(ap.text, /only Angus can approve|terminal|agent/i, "approve goes through the guarded host path, which refuses under an agent / without a terminal: " + ap.text);
const dn = r.decide("door-t--000002", "2"); // deny is open to anyone and only writes a decision file in the throwaway state
assert.equal(dn.ok, true, dn.text); assert.ok(fs.readdirSync(path.join(T, "state", "hyprpi", "sbx-relay", "decisions")).some((f) => /000002\.deny$/.test(f)), "the host decision file was written");
fs.rmSync(path.join(P, "door-t--000002.json"));
c = r.current(); assert.equal(c.id, "world-t--000001"); assert.deepEqual(c.choices, ["1", "2", "3", "e", "r"], "a plain talk offers allow-similar, edit and send-back (J370)"); assert.equal(c.reason, true, "a deny can carry a reason");
fs.rmSync(path.join(P, "world-t--000001.json"));
c = r.current(); assert.equal(c.id, "world-t--000004"); assert.match(c.text, /research plan/); assert.match(c.text, /- s one\n- s two/); assert.deepEqual(c.choices, ["1", "2", "e", "r"]);
// J370: r needs a note; r and a deny WITH a reason go through the guarded host path (refused under an agent); a note only rides with r or 2
{ const b = r.decide("world-t--000004", "r"); assert.equal(b.ok, false); assert.match(b.text, /only Angus/, "J386: a bare r is allowed, through the guarded path"); } assert.equal(r.decide("world-t--000004", "1", undefined, "note").ok, false, "approve carries no note");
const rb = r.decide("world-t--000004", "r", undefined, "use plainer words"); assert.equal(rb.ok, false); assert.match(rb.text, /only Angus/, rb.text);
const dr = r.decide("world-t--000004", "2", undefined, "not on task"); assert.equal(dr.ok, false); assert.match(dr.text, /only Angus/, dr.text);
// J365: nothing typed in the window starts anything: no suggest hook, no research drop-box writer
assert.match(r.current().title, /Searches the Doorman wants to run|wants to send a message|drafted a request/, "J388: a plain-words title for the panel");
assert.equal(r.suggest, undefined, "the provider has no suggest()");
assert.ok(!/outbox|RESEARCH_RE|writeInto/.test(fs.readFileSync(new URL("./review-provider.mjs", import.meta.url), "utf8")), "no code path writes a request into the sandbox's drop-box");
// edit(): the editable text of the item on screen
const e = r.edit("world-t--000004"); assert.equal(e.text, "s one\ns two"); assert.match(e.hint, /re-checks/);
assert.equal(r.edit("world-t--000001"), null, "not the item on screen");
assert.equal(r.decide("world-t--000004", "e").ok, false, "'e' is not a decision");
assert.equal(r.decide("world-t--000004", "2", "x").ok, false, "an edit only goes with approve");
console.log("review-provider: all pass");
