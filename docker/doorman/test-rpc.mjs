#!/usr/bin/env node
// J373 unit test for docker/doorman/doorman-rpc.mjs with a fake pi (a shell script speaking just enough RPC): a new session is asked
// for after each settled turn, and any failed, cancelled or unconfirmed reset ends the run NONZERO (so Restart=on-failure restarts it),
// even when the fake pi exits cleanly (0) on SIGTERM.   node docker/doorman/test-rpc.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const CTL = path.join(path.dirname(fileURLToPath(import.meta.url)), "doorman-rpc.mjs");
const T = fs.mkdtempSync(path.join(os.tmpdir(), "doorman-rpc-"));
const fake = (answer) => { const f = path.join(T, `fake-${answer}.sh`); fs.writeFileSync(f, `trap 'exit 0' TERM
echo '{"type":"agent_settled"}'
while read -r l; do echo "$l" >> ${T}/got-${answer}; id=$(printf '%s' "$l" | sed -n 's/.*"id":"\\([^"]*\\)".*/\\1/p')
  case ${answer} in ok) echo "{\\"type\\":\\"response\\",\\"command\\":\\"new_session\\",\\"id\\":\\"$id\\",\\"success\\":true,\\"data\\":{\\"cancelled\\":false}}"; exit 0;;
    cancel) echo "{\\"type\\":\\"response\\",\\"command\\":\\"new_session\\",\\"id\\":\\"$id\\",\\"success\\":true,\\"data\\":{\\"cancelled\\":true}}";;
    refuse) echo "{\\"type\\":\\"response\\",\\"command\\":\\"new_session\\",\\"id\\":\\"$id\\",\\"success\\":false}";;
    silent) : ;; esac
done
`); return `bash ${f}`; };
const run = (answer, ms = 25000) => spawnSync(process.execPath, [CTL], { env: { ...process.env, DOORMAN_PIRUN: fake(answer) }, encoding: "utf8", timeout: ms });
let r = run("ok"); assert.equal(r.status, 0); assert.match(fs.readFileSync(path.join(T, "got-ok"), "utf8"), /"type":"new_session"/); console.log("PASS  a settled turn asks for a new session; a confirmed one keeps the run going (the fake then ends cleanly: 0)");
for (const a of ["cancel", "refuse"]) { r = run(a); assert.equal(r.status, 1, a); assert.match(r.stderr, a === "cancel" ? /cancelled/ : /refused/); console.log(`PASS  a ${a === "cancel" ? "cancelled" : "refused"} new session ends the run with 1, though the fake pi exits 0 on SIGTERM`); }
r = run("silent"); assert.equal(r.status, 1); assert.match(r.stderr, /wasn't confirmed/); console.log("PASS  an unconfirmed new session (15 s) ends the run with 1");
fs.rmSync(T, { recursive: true, force: true });
console.log("all passed");
