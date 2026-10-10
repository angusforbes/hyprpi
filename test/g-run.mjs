// node test/g-run.mjs  (J362: a closed G window ends its program; never two pi on one agent). Runs g-run on the
// host with a temporary HOME (its launch dir, host.env and inbox), no sandbox, no Hyprland.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
const G_RUN = new URL("../docker/world/bin/g-run", import.meta.url).pathname;
const home = fs.mkdtempSync(path.join(os.tmpdir(), "j362-")), inbox = path.join(home, "inbox"), launch = path.join(home, ".hyprpi-g", "launch");
fs.mkdirSync(inbox); fs.mkdirSync(launch, { recursive: true });
fs.writeFileSync(path.join(home, ".hyprpi-g", "host.env"), `G_HOST_HYPRPI=/x\nG_HYPR_INBOX=${inbox}\nG_MSG_INBOX=/y\n`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const tok = (n) => n.toString(16).padStart(24, "0");
function run(t, argv, env = {}) {
  fs.writeFileSync(path.join(launch, `${t}.json`), JSON.stringify({ argv, cwd: home, env: { PATH: process.env.PATH, ...env } }));
  const e = { ...process.env, HOME: home }; delete e.HYPRPI_G_IN;   // as `sbx exec -it … g-run` starts it: no g-env.sh
  const p = spawn(process.execPath, [G_RUN, t], { env: e, stdio: ["ignore", "pipe", "pipe"] });
  p.out = ""; p.stdout.on("data", (d) => (p.out += d)); p.stderr.on("data", (d) => (p.out += d));
  p.done = new Promise((r) => p.on("exit", (code) => r(code)));
  return p;
}
// 1. W2: HYPRPI_G_IN unset (the bug): g-run finds the inbox in host.env, and closed-<token> ends it and its child
{
  const t = tok(1), p = run(t, ["sleep", "60"]);
  await sleep(800);
  const kid = Number(fs.readFileSync(`/proc/${p.pid}/task/${p.pid}/children`, "utf8").trim().split(/\s+/)[0]);
  assert.ok(kid && alive(kid), "the program runs");
  fs.writeFileSync(path.join(inbox, `closed-${t}`), "");
  const t0 = Date.now(), code = await Promise.race([p.done, sleep(9000).then(() => "timeout")]);
  assert.notEqual(code, "timeout", "g-run ended after its window closed");
  await sleep(300);
  assert.ok(!alive(kid), "and its program (pi) is gone");
  console.log(`ok 1 closed window ends g-run and its program in ${((Date.now() - t0) / 1000).toFixed(1)} s (inbox from host.env)`);
}
// 2. the launch's own env wins over host.env (the inner daemon's HYPRPI_G_IN)
{
  const other = path.join(home, "inbox2"); fs.mkdirSync(other);
  const t = tok(2), p = run(t, ["sleep", "60"], { HYPRPI_G_IN: other });
  await sleep(800); fs.writeFileSync(path.join(other, `closed-${t}`), "");
  assert.notEqual(await Promise.race([p.done, sleep(9000).then(() => "timeout")]), "timeout");
  console.log("ok 2 inbox from the launch's environment");
}
// 3. W3: a pi for the same agent already running → no second one
{
  const fake = spawn("bash", ["-c", "exec -a pi sleep 60"], { env: { ...process.env, HYPRPI_AGENT_ID: "hp-j362test" }, stdio: "ignore" });
  await sleep(300);
  const t = tok(3), p = run(t, ["bash", "-c", "echo STARTED; sleep 60"], { HYPRPI_AGENT_ID: "hp-j362test" });
  const code = await Promise.race([p.done, sleep(5000).then(() => "timeout")]);
  assert.equal(code, 3, "refused with exit 3");
  assert.match(p.out, /already running in this sandbox \(pid \d+/);
  assert.ok(!/STARTED/.test(p.out), "the second program never started");
  // a different agent starts fine
  const t2 = tok(4), q = run(t2, ["bash", "-c", "echo STARTED; sleep 60"], { HYPRPI_AGENT_ID: "hp-otheragent" });
  await sleep(800); assert.match(q.out, /STARTED/); q.kill("SIGTERM");
  fake.kill("SIGKILL");
  console.log("ok 3 a second pi on a running agent is refused; another agent starts");
}
// 4. (GrunReview) two g-runs for the same agent started at the same moment: exactly one program starts, every time
{
  let dup = 0;
  for (let i = 0; i < 12; i++) {
    const a = run(tok(100 + 2 * i), ["bash", "-c", "echo STARTED; sleep 60"], { HYPRPI_AGENT_ID: "hp-race" + i });
    const b = run(tok(101 + 2 * i), ["bash", "-c", "echo STARTED; sleep 60"], { HYPRPI_AGENT_ID: "hp-race" + i });
    await sleep(900);
    const started = [a, b].filter((p) => /STARTED/.test(p.out)).length;
    if (started !== 1) dup++;
    for (const p of [a, b]) p.kill("SIGTERM");
    await Promise.race([Promise.all([a.done, b.done]), sleep(3000)]);
  }
  assert.equal(dup, 0, `exactly one of two simultaneous launches starts (${dup}/12 wrong)`);
  console.log("ok 4 simultaneous launches for one agent: exactly one starts (12/12)");
}
// 5. the lock is the kernel's: a lock file left behind (any content) doesn't block, and a g-run killed with SIGKILL
//    (no exit handler runs) releases it at once
{
  const lock = path.join(home, ".hyprpi-g", "run", "agent-hp-stale.lock");
  fs.mkdirSync(path.dirname(lock), { recursive: true }); fs.writeFileSync(lock, "999999");
  const p = run(tok(200), ["bash", "-c", "echo STARTED; sleep 60"], { HYPRPI_AGENT_ID: "hp-stale" });
  await sleep(900); assert.match(p.out, /STARTED/, "a leftover lock file doesn't block");
  const kid = Number(fs.readFileSync(`/proc/${p.pid}/task/${p.pid}/children`, "utf8").trim().split(/\s+/).find((x) => /STARTED|sleep/.test(fs.readFileSync(`/proc/${x}/cmdline`, "utf8"))) || 0);
  p.kill("SIGKILL"); await Promise.race([p.done, sleep(3000)]);
  try { if (kid) process.kill(kid, "SIGKILL"); } catch { /* */ }
  await sleep(300);
  const q = run(tok(201), ["bash", "-c", "echo STARTED; sleep 60"], { HYPRPI_AGENT_ID: "hp-stale" });
  await sleep(900); assert.match(q.out, /STARTED/, "after its holder was SIGKILLed, the next launch starts");
  q.kill("SIGTERM"); await Promise.race([q.done, sleep(3000)]);
  console.log("ok 5 a leftover lock file doesn't block; a SIGKILLed holder releases the lock");
}
// 6. while one holds it, a later launch for the same agent is refused even with no pi visible yet
{
  const a = run(tok(300), ["bash", "-c", "echo STARTED; sleep 60"], { HYPRPI_AGENT_ID: "hp-held" });
  await sleep(700);
  const b = run(tok(301), ["bash", "-c", "echo STARTED; sleep 60"], { HYPRPI_AGENT_ID: "hp-held" });
  assert.equal(await Promise.race([b.done, sleep(5000).then(() => "timeout")]), 3);
  assert.match(b.out, /already running in this sandbox \(its window's g-run\)/);
  a.kill("SIGTERM"); await Promise.race([a.done, sleep(3000)]);
  console.log("ok 6 a held lock refuses the next launch (no pi needed)");
}
fs.rmSync(home, { recursive: true, force: true });
console.log("g-run: all pass");
