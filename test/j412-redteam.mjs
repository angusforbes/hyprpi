#!/usr/bin/env node
// J412 red team (Paperwright) #7: an automatic approval is never reported as the owner's: the bridge job's history and view, the host
// runner's prompt, and the GPU report in the sandbox's inbox all say "approved automatically (mode <m>)".   node test/j412-redteam.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { newJob, view } from "../docker/bridge/core.mjs";
import { plan } from "../docker/bridge/runner.mjs";

const T = fs.mkdtempSync(path.join(os.tmpdir(), "j412-rt-"));
let n = 0; const ok = (m) => { n++; console.log(`PASS  ${m}`); };

// bridge job + view + runner prompt
const auto = newJob({ id: "doorman-t--b00001", auto: "yolo", sandbox: "world-t", asker: "Alpha", action: "list the fixture folder" });
assert.equal(auto.history[0].by, "relay"); assert.match(auto.history[0].ev, /^approved automatically \(mode yolo\), not reviewed by the owner/);
assert.doesNotMatch(JSON.stringify(auto.history), /approved by the owner/); assert.equal(view(auto).auto, "yolo");
const owner = newJob({ id: "doorman-t--b00002", sandbox: "world-t", asker: "Alpha", action: "x" });
assert.equal(owner.history[0].by, "owner"); assert.equal(view(owner).auto, undefined);
ok("a bridge job approved by the dial: history 'approved automatically (mode yolo)' by relay, and the view carries auto; an owner's stays 'by the owner'");
const pa = plan(view(auto), { mcpConfig: path.join(T, "mcp.json"), cwd: T }).prompt, po = plan(view(owner), { mcpConfig: path.join(T, "mcp.json"), cwd: T }).prompt;
assert.match(pa, /approved automatically \(mode yolo\); the owner did not review it/); assert.doesNotMatch(pa, /the owner approved it|owner's approved text/);
assert.match(po, /The owner approved the text/);
ok("the host runner's prompt says the text was approved automatically, not by the owner");

// GPU report: deliverGpu verbatim, IO stubbed
const src = fs.readFileSync(new URL("../docker/sbx-relay.mjs", import.meta.url), "utf8");
const i = src.indexOf("  deliverGpu(sb, g, res"), body = src.slice(i, src.indexOf("\n  }\n", i) + 4);
const files = new Map(), inbox = path.join(T, "inbox"); fs.mkdirSync(path.join(T, "g", "out"), { recursive: true });
const ctx = { path, os, fs, Date, JSON, String, Array, Number, Math, Object,
  pinDirs: () => ({ inbox }), listNames: () => [], createFile: (d, name, data) => files.set(name, String(data)), fdPath: (d, x) => path.join(d, x),
  gpuPlain: (s) => String(s), LIMITS: { gpuKeepMs: 1 }, inboxWrite() {} };
const R = vm.runInNewContext(`(class R { ${body} })`, ctx), r = new R();
const g = { lease: "g00000001", job: "tiny", seconds: 10, vramMib: 256, dir: path.join(T, "g") }, res = { status: "done", outputs: [], log: "" };
r.deliverGpu({ cfg: { inbox } }, g, res, "yolo"); const mdA = files.get("gpu-g00000001.md");
assert.match(mdA, /GPU lease approved automatically \(mode yolo\), not reviewed by Angus/); assert.match(mdA, /- approved: automatically \(mode yolo\), not by Angus/); assert.doesNotMatch(mdA, /approved by Angus/);
files.clear(); r.deliverGpu({ cfg: { inbox } }, g, res); const mdO = files.get("gpu-g00000001.md");
assert.match(mdO, /GPU lease approved by Angus/); assert.match(mdO, /- approved: by Angus/);
ok("the GPU report in the inbox says 'approved automatically (mode yolo), not by Angus' for an auto lease; 'by Angus' otherwise");
// and runGpu passes the mode from the relay's own decision ("auto (<mode>)") to deliverGpu
assert.match(src, /this\.deliverGpu\(served, g, res, \/\^auto \\\(\(\\w\+\)\\\)\/\.exec\(via \|\| ""\)\?\.\[1\] \|\| ""\)/);
ok("runGpu hands the auto mode (from via 'auto (<mode>)') to the report");
fs.rmSync(T, { recursive: true, force: true });
console.log(`j412-redteam: all ${n} pass`);
