// node test/rules-cap.mjs (J412, Paperwright #2): rules made before the 8-hour cap are cut to it when loaded
import fs from "node:fs"; import os from "node:os"; import path from "node:path"; import assert from "node:assert/strict";
import { loadRules } from "../lib/sbx-rules.mjs";
const T = fs.mkdtempSync(path.join(os.tmpdir(), "clamp-")), now = Date.now(), h = 3600e3;
fs.writeFileSync(path.join(T, "rules.json"), JSON.stringify([
  { n: 1, sandbox: "w", recipient: "a", recipientKind: "agent", kind: "talk", created: now - 9 * h, until: now + 10 * h },
  { n: 2, sandbox: "w", recipient: "b", recipientKind: "agent", kind: "talk", created: now - 1 * h, until: now + 20 * h },
  { n: 3, sandbox: "w", recipient: "c", recipientKind: "agent", kind: "talk", until: now + h },
  { n: 4, sandbox: "w", recipient: "Thoughts-A", recipientKind: "thoughts", kind: "talk", created: now - 9 * h, until: now + h }]));
const l = loadRules(T, now); assert.deepEqual(l.map((r) => r.n), [2, 4]); assert.equal(l[0].until, now + 7 * h); console.log("rules-cap: all pass (a pre-J412 rule over 8 h is cut to 8 h from when it was made; one with no start is dropped; Thoughts rules unchanged)");
