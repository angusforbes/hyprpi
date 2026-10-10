// node test/modellist.mjs  (J397: the scoped model list as the only list: matching rules, Kimi refused by the list alone, routing models audited)
import assert from "node:assert/strict";
import { allowedBy, notAllowed, auditPolicy, readList } from "../lib/modellist.mjs";
import { loadPolicy } from "../lib/policy.mjs";
const ok = (m) => console.log("ok " + m);
const L = ["anthropic/*", "openai-codex/*", "nv-inference/**", "nvidia/openai/gpt-oss-20b"];
assert.equal(allowedBy("anthropic/claude-opus-5-5", L), "anthropic/*"); assert.equal(allowedBy("anthropic/claude-opus-5-5:high", L), "anthropic/*", "thinking suffix ignored");
assert.equal(allowedBy("Anthropic/Claude-Opus-5-5", L), "anthropic/*", "case-insensitive");
assert.equal(allowedBy("nv-inference/a/b/c", L), "nv-inference/**", "** crosses slashes"); assert.equal(allowedBy("anthropic/a/b", L), "", "* stays in one segment");
assert.equal(allowedBy("nvidia/openai/gpt-oss-20b", L), "nvidia/openai/gpt-oss-20b"); assert.equal(allowedBy("nvidia/openai/gpt-oss-120b", L), "", "exact entries are exact");
assert.equal(allowedBy("claude-opus-5-5", L), "anthropic/*", "a bare id matches through a listed provider");
assert.equal(allowedBy("openrouter/foo/bar", L), ""); assert.equal(allowedBy("", L), ""); assert.equal(allowedBy("anything/at-all", []), "*", "no list = all models (pi's rule)");
ok("matching rules: exact, globs (* / **), case, thinking suffix, bare ids, empty list");
// Kimi is refused by the list alone, with the real host list
const real = readList(); assert.ok(real.length > 0, "the host has a list");
for (const k of ["nvidia/moonshotai/kimi-k3", "nvidia/moonshotai/kimi-k2.6", "openrouter/~moonshotai/kimi-latest", "openrouter/moonshotai/kimi-k2"]) assert.equal(allowedBy(k, real), "", k + " is not on the host list");
assert.equal(loadPolicy().modelDeny, undefined, "hyprpi.jsonc has no modelDeny any more");
assert.match(notAllowed("nvidia/moonshotai/kimi-k3", "anthropic/claude-sonnet-5-5"), /not on the host's scoped model list.*Use anthropic\/claude-sonnet-5-5 instead/);
ok("Kimi (all four) is refused by the host list alone; no modelDeny");
// every routing / thoughts model is on the list
assert.deepEqual(auditPolicy(loadPolicy(), real), [], "every model hyprpi.jsonc names is on the list");
assert.deepEqual(auditPolicy({ routing: { ladder: ["anthropic/x:low", "openrouter/y/z:high"], kinds: { a: "nvidia/q/w" } }, thoughts: { model: "foo/bar" } }, L).map((b) => b.where), ["routing.ladder[1]", "routing.kinds.a", "thoughts.model"], "the audit finds the ones that aren't");
ok("the audit: every model in the live hyprpi.jsonc is on the list, and it finds unlisted ones in a made-up policy");
console.log("modellist: all pass");
