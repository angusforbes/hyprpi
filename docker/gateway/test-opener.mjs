#!/usr/bin/env node
// J393: the relay's handoff to the world's link opener (docker/gateway/opener.mjs) never puts the gate or a browser in the
// caller's process tree. Uses the REAL user systemd manager with a STUB gate (it starts a long-lived stand-in "browser",
// a sleeping python, and exits), so nothing visible opens. Skips if there is no user bus. Run: node docker/gateway/test-opener.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { handToOpener } from "./opener.mjs";

if (spawnSync("systemctl", ["--user", "is-system-running"], { encoding: "utf8" }).error) { console.log("skip: no user systemd"); process.exit(0); }
const T = fs.mkdtempSync(path.join(os.tmpdir(), "opener-test-"));
const mark = `j393-${process.pid}`;
const gate = path.join(T, "gate.py");
fs.writeFileSync(gate, `import subprocess, sys
url = sys.argv[2]
if "refuse" in url:
    print("g_open_url: refused: not a link this gate opens", file=sys.stderr); sys.exit(1)
subprocess.Popen(["python3", "-c", "import time; time.sleep(300)", "${mark}"], start_new_session=True, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
sys.exit(0)
`);
const descendants = (pid) => { const out = []; const walk = (p) => { for (const c of String(spawnSync("pgrep", ["-P", String(p)], { encoding: "utf8" }).stdout).split("\n").filter(Boolean)) { out.push(c); walk(c); } }; walk(pid); return out.map((p) => { try { return fs.readFileSync(`/proc/${p}/cmdline`, "utf8").replace(/\0/g, " "); } catch { return ""; } }); };
let n = 0; const t = async (name, fn) => { await fn(); n++; console.log("ok", n, name); };

await t("accepted: the stand-in browser runs, but NOT in this process's tree, and the result says accepted", async () => {
  const r = await handToOpener("https://example.org/", "world-j393", { gate, checkBrowser: false });
  assert.ok(r.ok, r.text);
  const mine = descendants(process.pid);
  assert.ok(!mine.some((c) => c.includes("gate.py") || c.includes(mark)), JSON.stringify(mine));
  const pids = String(spawnSync("pgrep", ["-f", mark], { encoding: "utf8" }).stdout).split("\n").filter(Boolean);
  assert.ok(pids.length >= 1, "the stand-in browser should be running (KillMode=process kept it after the gate exited)");
  const cg = fs.readFileSync(`/proc/${pids[0]}/cgroup`, "utf8");
  assert.match(cg, /hyprpi-open-world-j393-[0-9a-f]{8}\.service/, cg);
  for (const p of pids) spawnSync("kill", [p]);
});
await t("refused: the opener's refusal comes back as a failure with its reason", async () => {
  const r = await handToOpener("https://example.org/refuse", "world-j393", { gate, checkBrowser: false });
  assert.equal(r.ok, false); assert.match(r.text, /not a link this gate opens/);
});
await t("browser check: no world browser running → reported as not running (never 'opened')", async () => {
  const r = await handToOpener("https://example.org/", "world-j393-nobrowser", { gate, settleMs: 200 });
  assert.equal(r.ok, false); assert.match(r.text, /wasn't running/);
  for (const p of String(spawnSync("pgrep", ["-f", mark], { encoding: "utf8" }).stdout).split("\n").filter(Boolean)) spawnSync("kill", [p]);
});
await t("no systemd-run → refused, and nothing is launched here", async () => {
  const r = await handToOpener("https://example.org/", "world-j393", { gate, systemdRun: "/nonexistent/systemd-run", checkBrowser: false });
  assert.equal(r.ok, false); assert.match(r.text, /couldn't hand it/);
  assert.equal(String(spawnSync("pgrep", ["-f", mark], { encoding: "utf8" }).stdout).trim(), "");
});
fs.rmSync(T, { recursive: true, force: true });
console.log(`all ${n} passed`);
