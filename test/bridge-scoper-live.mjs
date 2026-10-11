// node test/bridge-scoper-live.mjs  (J442, manual: one real Claude Code run, a few cents) - the read-only scoping run proposes the
// DEEPEST existing folder: a job writing a file in <home>/Documents/doorman-g-jobs proposes that folder, not <home>/Documents.
import assert from "node:assert/strict"; import fs from "node:fs"; import os from "node:os"; import path from "node:path"; import { spawnSync } from "node:child_process";
import { scopePlan, parseResult } from "../docker/bridge/scoper.mjs";
import { checkScope } from "../docker/bridge/scope.mjs";
const H = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "scoper-live-")));
for (const d of ["Documents/doorman-g-jobs", "Documents/taxes", "Documents/letters", "Work/other"]) fs.mkdirSync(path.join(H, d), { recursive: true });
fs.writeFileSync(path.join(H, "Documents/doorman-g-jobs/hello-from-g.md"), "x");
const job = { approved: { action_line: `Create the file ${H}/Documents/doorman-g-jobs/hello-from-g-2.md containing exactly "test"`, needs: "the doorman-g-jobs folder in the owner's Documents", folders: [] } };
const mcp = path.join(H, "..", path.basename(H) + "-mcp.json"); fs.writeFileSync(mcp, JSON.stringify({ mcpServers: {} }));
const { argv, prompt } = scopePlan(job, { home: H, mcpConfig: mcp, model: process.env.DOORMAN_RUNNER_MODEL || "claude-fable-5-1" });
const r = spawnSync(argv[0], argv.slice(1), { input: prompt, cwd: H, encoding: "utf8", timeout: 240000 });
const res = parseResult(r.stdout); console.log("proposal:", JSON.stringify(res));
assert.ok(res && res.folders.length >= 1, `no proposal: ${r.stdout.slice(-400)} ${r.stderr.slice(-300)}`);
assert.equal(res.folders[0].path, path.join(H, "Documents/doorman-g-jobs"), "the deepest existing folder, not Documents");
const c = checkScope({ folders: res.folders }, { home: H, shares: { mounts: [] } }); assert.ok(c.ok, c.text);
assert.equal(checkScope({ folders: [{ path: path.join(H, "Documents"), access: "write" }] }, { home: H, shares: { mounts: [] } }).ok, false, "and Documents itself for write would be refused");
fs.rmSync(H, { recursive: true, force: true }); fs.rmSync(mcp, { force: true });
console.log("bridge-scoper-live: pass");
