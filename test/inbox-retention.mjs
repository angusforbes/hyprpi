// node test/inbox-retention.mjs  (J459: per-kind inbox retention; pure, temp folders)
import assert from "node:assert/strict"; import fs from "node:fs"; import os from "node:os"; import path from "node:path";
import { retentionFor, sweepInbox, RETENTION_KEYS } from "../docker/inbox-retention.mjs";
import { validateChanges } from "../docker/research/gateway-admin.mjs";
const T = fs.mkdtempSync(path.join(os.tmpdir(), "j459-")), CFG = path.join(T, "cfg"); fs.mkdirSync(path.join(CFG, "worlds"), { recursive: true });
const W = (g) => fs.writeFileSync(path.join(CFG, "worlds", "world-t.json"), JSON.stringify({ sandbox: "world-t", gateway: g }));
const H = 3600e3, D = 24 * H;
W({}); assert.deepEqual(retentionFor(CFG, "world-t"), { messagesMs: 24 * H, reportsMs: 7 * D, gpuMs: 7 * D, maxFiles: 300 }, "defaults: 24 h, 7 days, 7 days, 300");
W({ inbox_messages_hours: "48", inbox_reports_days: 14, inbox_gpu_days: "3", inbox_max_files: "50" });
assert.deepEqual(retentionFor(CFG, "world-t"), { messagesMs: 48 * H, reportsMs: 14 * D, gpuMs: 3 * D, maxFiles: 50 });
W({ inbox_messages_hours: "0", inbox_reports_days: "999", inbox_gpu_days: "x", inbox_max_files: "-1" });
assert.deepEqual(retentionFor(CFG, "world-t"), { messagesMs: 24 * H, reportsMs: 7 * D, gpuMs: 7 * D, maxFiles: 300 }, "out of range / junk → the defaults");
// Angus only: a proposal (not admin) is refused for every retention key; admin sets them within range
for (const k of Object.keys(RETENTION_KEYS)) { assert.match(validateChanges({ [k]: "30" }).errors[0], /can only be set by Angus/, k); }
assert.equal(validateChanges({ inbox_reports_days: "30" }, { admin: true }).ok, true);
assert.equal(validateChanges({ inbox_reports_days: "91" }, { admin: true }).ok, false);
// the sweep: each kind by its own setting; nothing else touched
const now = Date.parse("2026-10-11T12:00:00Z"), msg = (agoMs, i) => `${String(now - agoMs).padStart(13, "0")}-${String(i).padStart(8, "0").replace(/\d/g, (c) => "0123456789abcdef"[c])}.json`;
const files = { [msg(30 * H, 1)]: 0, [msg(2 * H, 2)]: 0, "research-old1.md": now - 8 * D, "research-new1.md": now - 2 * D, "gpu-g0000abcd.md": now - 4 * D, "gpu-g0000abcd-out.txt": now - 4 * D, "gpu-g1111abcd.md": now - 1 * D, "notes.txt": now - 400 * D, "research-x.txt": now - 400 * D };
const removed = [], io = { mtimeMs: (n) => files[n], unlink: (n) => { removed.push(n); delete files[n]; } };
const ret = { messagesMs: 24 * H, reportsMs: 7 * D, gpuMs: 3 * D, maxFiles: 300 };
const gone = sweepInbox(Object.keys(files), io, ret, { now });
assert.deepEqual(gone.sort(), [msg(30 * H, 1), "gpu-g0000abcd-out.txt", "gpu-g0000abcd.md", "research-old1.md"].sort(), "old message, old report, old GPU result (both files)");
assert.ok(["notes.txt", "research-x.txt", "research-new1.md", "gpu-g1111abcd.md", msg(2 * H, 2)].every((n) => n in files), "everything else stays");
// the cap: the oldest message items beyond maxFiles go first (room for one about to be written)
const many = Array.from({ length: 25 }, (_, i) => msg((25 - i) * 60e3, i + 10)), f2 = Object.fromEntries(many.map((n) => [n, 0])), r2 = [];
sweepInbox(many, { mtimeMs: () => now, unlink: (n) => r2.push(n) }, { ...ret, maxFiles: 20 }, { now, room: 1 });
assert.deepEqual(r2, many.slice(0, 6), "25 items, cap 20, room 1 → the 6 oldest go"); void f2;
fs.rmSync(T, { recursive: true, force: true });
console.log("inbox-retention: all pass");
