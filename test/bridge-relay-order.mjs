// node test/bridge-relay-order.mjs  (J371 BridgeReview HIGH, J412): in the relay's decide(), a host agent's question is decided only by an
// answer ("1 text": approve WITH a note) or a decline (2): a bare approve or an allow-similar on it decides nothing, and that guard runs
// before the pending item is consumed; the host-job branch comes before anything that executes (the typed, task-change, GPU and research
// branches treat any non-deny as an approval).
import assert from "node:assert/strict";
import fs from "node:fs";
const src = fs.readFileSync(new URL("../docker/sbx-relay.mjs", import.meta.url), "utf8");
const body = src.slice(src.indexOf("  async decide(file) {"), src.indexOf("\n  }\n", src.indexOf("  async decide(file) {")));
const at = (re) => { const m = re.exec(body); assert.ok(m, `missing ${re}`); return m.index; };
const guard = at(/if \(msg\.hostJob && verdict !== "deny" && \(!note \|\| verdict !== "approve"\)\) \{ log\(\{[^\n]*\}\); return; \}/), consume = at(/fs\.unlinkSync\(pf\)/), hj = at(/if \(msg\.hostJob\) \{/);
assert.ok(guard < consume, "the question guard runs before the pending item is consumed");
for (const re of [/if \(msg\.taskChange\)/, /if \(msg\.typed\)/, /if \(msg\.gpu\)/, /if \(msg\.research\)/, /verdict\.startsWith\("allow-"\)/]) assert.ok(hj < at(re), `host-job branch before ${re}`);
assert.match(body, /\(approve\|deny\|allow-\\d\{1,5\}\)/, "only approve, deny and allow-<minutes> (J412: no answer / return / today)");
assert.ok(!/takeEdit|verdict === "answer"|verdict === "return"/.test(body));
console.log("bridge-relay-order: all pass");
