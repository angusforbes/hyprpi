// node test/g-status.mjs  (J401: what a sandboxed world reports about its agents is checked strictly before the host shows it)
import assert from "node:assert/strict";
import { validateStatus, modelShown, LIMITS } from "../docker/world/g-status.mjs";
const ok = (m) => console.log("ok " + m);
const good = { id: "hp-mv06u02vz4b", name: "Alpha", status: "done", model: "openai/openai/gpt-6-astra" };
let v = validateStatus({ agents: [good, { id: "g-outside", name: "Outside", status: "idle", model: "gateway" }], thoughts: "running" });
assert.deepEqual(v.agents, [{ id: "hp-mv06u02vz4b", name: "Alpha", status: "done", model: "gpt-6-astra" }, { id: "g-outside", name: "Outside", status: "idle", model: "gateway" }]);
assert.equal(v.thoughts, "running"); assert.equal(v.dropped, 0);
ok("a normal report passes (model shown by its last part)");
const bad = [
  { ...good, name: "Al\u001b[31mpha" }, { ...good, name: "Alpha\u202e" }, { ...good, name: "Alpha\nBeta" }, { ...good, name: "1Alpha" }, { ...good, name: "A".repeat(32) },
  { ...good, name: "Ⓐlpha" }, { ...good, name: "" }, { ...good, name: 7 }, { ...good, id: "../../x" }, { ...good, id: "ab" }, { ...good, id: "x".repeat(65) },
  { ...good, status: "approved" }, { ...good, status: "" }, { ...good, status: "WORKING" }, null, "Alpha", [good], { name: "Alpha", status: "done" },
];
v = validateStatus({ agents: bad });
assert.equal(v.agents.length, 0); assert.equal(v.dropped, bad.length);
ok(`hostile entries are dropped (${bad.length}: escapes, bidi, newline, digits first, too long, non-ASCII, empty, wrong types, bad ids, unknown statuses)`);
for (const m of ["../../etc", "a b", "x".repeat(130), "\u001b[31m", 42, "openai/../x", ""]) assert.equal(modelShown(m), "other", JSON.stringify(m));
assert.equal(modelShown("anthropic/claude-opus-5-5"), "opus-5-5"); assert.equal(modelShown("gateway"), "gateway");
ok("an odd model shows as \"other\", never its text");
v = validateStatus({ agents: Array.from({ length: 30 }, (_, i) => ({ ...good, id: "hp-agent-" + String(i).padStart(3, "0"), name: "A" + i })) });
assert.equal(v.agents.length, LIMITS.agents); assert.equal(v.dropped, 30 - LIMITS.agents);
ok(`too many agents: only the first ${LIMITS.agents} kept`);
v = validateStatus({ agents: [good, { ...good, name: "Beta" }] }); assert.equal(v.agents.length, 1); assert.equal(v.dropped, 1);
ok("a repeated id is dropped");
for (const x of [null, "x", 42, [good], { agents: [{ ...good, name: "x".repeat(9000) }] }]) { const r = validateStatus(x); assert.equal(r.agents.length, 0); }
assert.equal(validateStatus({ agents: [good], pad: "x".repeat(LIMITS.bytes) }).agents.length, 0, "an oversize report is dropped whole");
assert.equal(validateStatus({ agents: [good], thoughts: "taking over" }).thoughts, "", "an unknown Thoughts state is dropped");
ok("non-objects, oversize reports and unknown Thoughts states are dropped");
console.log("g-status: all pass");
