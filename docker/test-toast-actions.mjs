// node docker/test-toast-actions.mjs  (J355)
import assert from "node:assert/strict";
import fs from "node:fs";
import { ACTION_KEYS, parseActionLine, toastMayDo } from "./toast-actions.mjs";
const line = (k) => `/org/freedesktop/Notifications: org.freedesktop.Notifications.ActionInvoked (uint32 7, '${k}:0123456789abcdef')`;
assert.deepEqual(Object.keys(ACTION_KEYS), ["deny", "review"]);
assert.deepEqual(parseActionLine(line("deny")), { n: 7, key: "deny", nonce: "0123456789abcdef" });
assert.equal(toastMayDo("deny"), true); assert.equal(toastMayDo("review"), true);
for (const k of ["approve", "allow", "allow-10", "constructor", "toString", "__proto__"]) assert.equal(toastMayDo(k), false, k);
assert.equal(parseActionLine(line("approve")).key, "approve"); // a stale or forged approve parses, and is then refused
assert.equal(parseActionLine("garbage"), null);
const relay = fs.readFileSync(new URL("./sbx-relay.mjs", import.meta.url), "utf8");
assert.ok(/import \{ ACTION_KEYS, parseActionLine, toastMayDo \} from "\.\/toast-actions\.mjs"/.test(relay), "the relay uses the one list");
assert.ok(/refused \(J355\)/.test(relay), "the relay logs refusals");
assert.ok(!/const ACTION_KEYS = \{ approve/.test(relay), "no Approve button in the relay");
console.log("toast-actions: all pass");
