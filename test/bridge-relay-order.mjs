// node test/bridge-relay-order.mjs  (J371, BridgeReview HIGH: in the relay's decide(), an "answer" verdict on an item
// that isn't a host agent's question must decide nothing, and the host-job branch must come before anything that
// executes: the typed, task-change, GPU and research branches treat any non-deny as an approval)
import assert from "node:assert/strict";
import fs from "node:fs";
const src = fs.readFileSync(new URL("../docker/sbx-relay.mjs", import.meta.url), "utf8");
const body = src.slice(src.indexOf("  async decide(file) {"), src.indexOf("\n  }\n", src.indexOf("  async decide(file) {")));
const at = (re) => { const m = re.exec(body); assert.ok(m, `missing ${re}`); return m.index; };
const guard = at(/if \(verdict === "answer" && !msg\.hostJob\) \{ log\(\{[^\n]*\}\); return; \}/), consume = at(/fs\.unlinkSync\(pf\)/), hj = at(/if \(msg\.hostJob\) \{/);
assert.ok(guard < consume, "the answer guard runs before the pending item is consumed");
for (const re of [/if \(msg\.taskChange\)/, /if \(msg\.typed\)/, /if \(msg\.gpu\)/, /if \(msg\.research\)/, /takeEdit\(/, /verdict\.startsWith\("allow-"\)/]) assert.ok(hj < at(re), `host-job branch before ${re}`);
assert.match(body, /\(approve\|deny\|(?:return\|)?answer\|/);
console.log("bridge-relay-order: all pass");
