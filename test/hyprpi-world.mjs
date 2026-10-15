// J625 v2 (Gatekeeper F1-F5): bin/hyprpi-world against fakes only, inside the test guard. Every outside command it can run is a
// fake on PATH that logs its call: sbx (a tripwire unless a test allows it), systemctl (read-only verbs answer from a state file;
// anything else is logged and changes that file), hyprctl (a fixture client list; dispatch logged), brev, ssh (an unreachable
// machine), plus HYPRPI_WORLD_HPBIN (a fake hyprpi: list from a fixture, every other command logged) and a fake sandboxd on a unix
// socket in the temp folder (states from a file). Config and state folders are temp (XDG_CONFIG_HOME / XDG_STATE_HOME). Nothing
// reaches the live daemon, windows, services or sandboxes.
import { requireSandbox } from "./guard/sandbox.mjs";
await requireSandbox(import.meta.url);
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("../bin/hyprpi-world", import.meta.url));
const T = fs.mkdtempSync(path.join(os.tmpdir(), "hyprpi-world-"));
const BIN = path.join(T, "bin"), CFG = path.join(T, "config"), STATE = path.join(T, "state"), LOG = path.join(T, "calls.log");
for (const d of [BIN, path.join(CFG, "hyprpi", "worlds"), path.join(CFG, "hyprpi", "remote"), path.join(STATE, "sandboxes/sandboxes/sandboxd")]) fs.mkdirSync(d, { recursive: true });
const w = (f, s, x) => { fs.writeFileSync(f, s); if (x) fs.chmodSync(f, 0o755); };
const SBSTATE = path.join(T, "sandboxes.json"), UNITS = path.join(T, "units.json"), CLIENTS = path.join(T, "clients.json"), LISTS = path.join(T, "lists");

// ---- fakes ----------------------------------------------------------------------------------------------------------------------
w(path.join(BIN, "sbx"), `#!/usr/bin/env bash
echo "sbx $*" >> ${LOG}
[[ "\${FAKE_SBX:-trip}" == trip ]] && { echo "TRIPWIRE: sbx called" >&2; exit 99; }
case "$1" in
  ls) echo "SANDBOX AGENT PROFILE STATUS"; jq -r 'to_entries[] | "\\(.key) shell p \\(.value)"' ${SBSTATE} ;;
  stop) t=$(mktemp); jq --arg s "$2" '.[$s] = "stopped"' ${SBSTATE} > $t && mv $t ${SBSTATE} ;;
  exec) [[ "\${@: -1}" == true ]] && { t=$(mktemp); jq --arg s "$2" '.[$s] = "running"' ${SBSTATE} > $t && mv $t ${SBSTATE}; }; echo "To restore (all): nothing" ;;
  *) exit 1 ;;
esac`, 1);
w(path.join(BIN, "systemctl"), `#!/usr/bin/env bash
[[ "$1" == --user ]] && shift
v="$1"; shift; q=0; [[ "$1" == --quiet ]] && { q=1; shift; }
case "$v" in
  is-enabled) [[ "\${FAKE_SYSTEMCTL:-}" == broken ]] && { echo "Failed to connect to bus" >&2; exit 1; }
    e=$(jq -r --arg u "$1" '.[$u].enabled // false' ${UNITS}); [[ $e == true ]] && echo enabled || echo disabled; [[ $e == true ]] ;;
  is-active) [[ "\${FAKE_SYSTEMCTL:-}" == broken ]] && { echo "Failed to connect to bus" >&2; exit 1; }
    a=$(jq -r --arg u "$1" '.[$u].active // false' ${UNITS}); (( q )) || { [[ $a == true ]] && echo active || echo inactive; }; [[ $a == true ]] ;;
  show) true ;;
  list-unit-files) [[ $(jq -r --arg u "$1" '.[$u].file // false' ${UNITS}) == true ]] && echo "$1 enabled enabled"; true ;;
  *) echo "systemctl $v $*" >> ${LOG}; now=0; [[ "$1" == --now ]] && { now=1; shift; }; t=$(mktemp)
     case "$v" in enable) jq --arg u "$1" '.[$u].enabled = true' ${UNITS} ;; disable) jq --arg u "$1" --argjson n $now '.[$u].enabled = false | if $n == 1 then .[$u].active = false else . end' ${UNITS} ;;
       start) jq --arg u "$1" '.[$u].active = true' ${UNITS} ;; stop) jq --arg u "$1" '.[$u].active = false' ${UNITS} ;; *) cat ${UNITS} ;; esac > $t && mv $t ${UNITS} ;;
esac`, 1);
w(path.join(BIN, "hyprctl"), `#!/usr/bin/env bash
if [[ "$1" == -j && "$2" == clients ]]; then cat ${CLIENTS}; exit 0; fi
echo "hyprctl $*" >> ${LOG}`, 1);
for (const c of ["brev", "tsh"]) w(path.join(BIN, c), `#!/usr/bin/env bash\necho "${c} $*" >> ${LOG}; exit 1`, 1);
const RWF = path.join(T, "fake-world"); w(RWF, `#!/usr/bin/env bash\necho "rworld $*" >> ${LOG}`, 1);
w(path.join(BIN, "ssh"), `#!/usr/bin/env bash\necho "ssh $*" >> ${LOG}; [[ -n "\${FAKE_SSH_OUT:-}" ]] && { cat "$FAKE_SSH_OUT"; exit 0; }; exit 255`, 1); // unreachable, or a canned answer
const HPF = path.join(T, "fake-hp.mjs"); // a fake hyprpi: "list --json" returns lists/<n>.json in turn (the last one repeats); the rest is logged
w(HPF, `import fs from "node:fs"; const a = process.argv.slice(2); fs.appendFileSync(${JSON.stringify(LOG)}, "hp " + a.join(" ") + "\\n");
if (a[0] === "list") { const c = ${JSON.stringify(path.join(T, "list-count"))}; let n = 0; try { n = Number(fs.readFileSync(c, "utf8")) || 0; } catch {}
  const files = fs.readdirSync(${JSON.stringify(LISTS)}).sort(); fs.writeFileSync(c, String(n + 1)); process.stdout.write(fs.readFileSync(${JSON.stringify(LISTS)} + "/" + files[Math.min(n, files.length - 1)])); }`);
fs.mkdirSync(LISTS);
// the fake sandboxd: /daemon/health 200; /sandbox/<name> -> its state from the file ("unknown" -> 500); anything else 404
const SOCK = path.join(STATE, "sandboxes/sandboxes/sandboxd/sandboxd.sock");
const srv = http.createServer((req, res) => {
  fs.appendFileSync(LOG, `sandboxd GET ${req.url}\n`);
  // sbx's daemon "stopped" through the fake systemctl: it no longer answers (curl sees no reply, as with a real stopped daemon)
  try { if (JSON.parse(fs.readFileSync(UNITS, "utf8"))["hyprpi-sandboxd.service"]?.active === false) return req.socket.destroy(); } catch { /* */ }
  if (req.url === "/daemon/health") { res.statusCode = HEALTH; return res.end("ok"); }
  const m = /^\/sandbox\/([\w.-]+)$/.exec(req.url || ""), st = m ? JSON.parse(fs.readFileSync(SBSTATE, "utf8"))[m[1]] : undefined;
  if (!m || st === undefined) { res.statusCode = 404; return res.end("{}"); }
  if (st === "unknown") { res.statusCode = 500; return res.end("{}"); }
  res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ name: m[1], status: st }));
});
let sandboxdUp = false, HEALTH = 200;
const startSandboxd = () => new Promise((r) => { if (sandboxdUp) return r(); srv.listen(SOCK, () => { sandboxdUp = true; r(); }); });
const stopSandboxd = () => new Promise((r) => { if (!sandboxdUp) return r(); srv.close(() => { sandboxdUp = false; try { fs.unlinkSync(SOCK); } catch {} r(); }); });

const agent = (id, room, extra = {}) => ({ id, name: id, display: id, icon: "", room, model: "m", workspace: null, cwd: "/tmp", session: "", ...extra });
function setup({ sandboxes = {}, units = {}, clients = [], lists = [{ agents: [agent("a1", "A")] }], files = {} }) {
  fs.writeFileSync(SBSTATE, JSON.stringify(sandboxes)); fs.writeFileSync(UNITS, JSON.stringify(units)); fs.writeFileSync(CLIENTS, JSON.stringify(clients));
  for (const f of fs.readdirSync(LISTS)) fs.unlinkSync(path.join(LISTS, f));
  lists.forEach((l, i) => fs.writeFileSync(path.join(LISTS, String(i).padStart(2, "0") + ".json"), JSON.stringify(l)));
  try { fs.unlinkSync(path.join(T, "list-count")); } catch {}
  for (const d of ["worlds", "remote"]) for (const f of fs.readdirSync(path.join(CFG, "hyprpi", d))) fs.unlinkSync(path.join(CFG, "hyprpi", d, f));
  for (const f of ["sbx-relay.json", "research.json"]) try { fs.unlinkSync(path.join(CFG, "hyprpi", f)); } catch {}
  for (const [f, v] of Object.entries(files)) fs.writeFileSync(path.join(CFG, "hyprpi", f), typeof v === "string" ? v : JSON.stringify(v));
  fs.rmSync(path.join(STATE, "hyprpi"), { recursive: true, force: true });
  fs.writeFileSync(LOG, "");
}
// async (not spawnSync): the fake sandboxd lives in this process's event loop and must answer while the script runs
function run(args, env = {}) {
  return new Promise((resolve) => {
    const p = spawn(SCRIPT, args, { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, PATH: `${BIN}:${process.env.PATH}`, XDG_CONFIG_HOME: CFG, XDG_STATE_HOME: STATE,
      HYPRPI_WORLD_HPBIN: HPF, HYPRPI_WORLD_REMOTE_BIN: RWF, HYPRPI_AGENT_ID: "", ...env } });
    let out = ""; p.stdout.on("data", (d) => (out += d)); p.stderr.on("data", (d) => (out += d)); p.stdin.end();
    const t = setTimeout(() => p.kill(), 120000); // (a process this test spawned, by its own handle)
    p.on("close", (code) => { clearTimeout(t); resolve({ code, out, calls: fs.readFileSync(LOG, "utf8") }); });
  });
}
const mutating = (calls) => calls.split("\n").filter((l) => /^(sbx |systemctl |hyprctl |brev |hp (send|stop|new))/.test(l));
let n = 0; const ok = (name) => console.log(`ok ${++n} - ${name}`);
const G = { sandbox: "world-q", workspaces: [61, 69], autostart: true };
const relay = { sandboxes: [{ name: "world-q" }, { name: "doorman-q", doorman_for: "world-q", display: "Doorman-Q" }] };
const gUnits = { "hyprpi-world-q-helper": { active: true }, "hyprpi-world-q-shares": { active: true }, "hyprpi-doorman-doorman-q": { active: true }, "hyprpi-sbx-relay": { active: true },
  "doorman-bridge-runner.path": { file: true, enabled: true, active: true }, "hyprpi-sandbox-restore.service": { file: true, enabled: true, active: false },
  "hyprpi-research-digest.timer": { file: true, enabled: true, active: true }, "hyprpi-research-daily.timer": { file: true, enabled: true, active: true },
  "hyprpi-sandboxd.service": { file: true, enabled: true, active: true } };

try {
  // F1: a dry run never calls sbx, even with sandboxd up and the world running (the old code ran a real `sbx ls` here)
  await startSandboxd();
  setup({ sandboxes: { "world-q": "running", "doorman-q": "running", "reader-g": "stopped" }, units: gUnits, files: { "worlds/world-q.json": G, "sbx-relay.json": relay } });
  let r = await run(["stop", "G", "--dry-run"]);
  assert.equal(r.code, 0, r.out);
  assert.doesNotMatch(r.calls, /^sbx /m, "a dry run called sbx:\n" + r.calls);
  assert.deepEqual(mutating(r.calls), [], "a dry run changed something:\n" + r.calls);
  assert.match(r.out, /would run: .*world\.sh stop world-q/); assert.match(r.out, /would run: sbx stop doorman-q/);
  assert.match(r.out, /a real run first checks `sbx ls`/);
  ok("F1: stop --dry-run with sandboxd up and the world running calls no sbx and changes nothing (sandbox states read from sandboxd's socket)");
  r = await run(["start", "G", "--dry-run"]); assert.equal(r.code, 0, r.out); assert.doesNotMatch(r.calls, /^sbx /m); assert.deepEqual(mutating(r.calls), []);
  ok("F1: start --dry-run calls no sbx either");

  // F2 + F3: a real stop of a (detached) sandboxed world whose sandbox state is UNKNOWN: sbx stop fails (tripwire), sbx ls fails ->
  // the shared pieces are left on, the sandbox counts as NOT off, exit 4
  setup({ sandboxes: { "world-q": "unknown" }, units: gUnits, files: { "worlds/world-q.json.off-T": G, "sbx-relay.json": { sandboxes: [{ name: "world-q" }] } } });
  r = await run(["stop", "G", "--yes"]);
  assert.equal(r.code, 4, r.out);
  assert.match(r.out, /NOT DONE: sandbox world-q is unknown/); assert.match(r.out, /left on: can't tell whether other sandboxes run/);
  assert.match(r.out, /NOT fully off/);
  assert.doesNotMatch(r.calls, /systemctl (disable|stop) (hyprpi-sandboxd|hyprpi-sbx-relay|doorman-bridge|hyprpi-research)/, r.calls);
  ok("F2/F3: an unknown sandbox state is NOT off (exit 4), and when sbx ls can't tell, the shared pieces stay on");

  // F3: another sandbox (not this world's) is running -> relay, sandboxd, runner, timers stay on; this world's own parts stop
  setup({ sandboxes: { "world-q": "running", "doorman-q": "running", "other-sb": "running" }, units: gUnits, files: { "worlds/world-q.json.off-T": G, "sbx-relay.json": relay } });
  r = await run(["stop", "G", "--yes"], { FAKE_SBX: "ok" });
  assert.match(r.out, /left on: other sandboxes are running \(other-sb \)/, r.out);
  assert.match(r.calls, /^sbx stop world-q$/m); assert.match(r.calls, /^sbx stop doorman-q$/m); assert.match(r.calls, /^systemctl stop hyprpi-doorman-doorman-q$/m);
  assert.doesNotMatch(r.calls, /systemctl (disable|stop).*(hyprpi-sandboxd|hyprpi-sbx-relay|doorman-bridge|hyprpi-research)/, r.calls);
  assert.equal(r.code, 0, r.out); assert.match(r.out, /=> world G is off/);
  ok("F3: with another sandbox running, the shared pieces stay on and only world G's own parts stop (exit 0, checked off)");

  // F4: the record holds each unit's state BEFORE the stop; a full stop (nothing else running) records and disables; start restores exactly
  setup({ sandboxes: { "world-q": "running", "doorman-q": "running", "reader-g": "stopped" }, units: gUnits, files: { "worlds/world-q.json.off-T": G, "sbx-relay.json": relay } });
  r = await run(["stop", "G", "--yes"], { FAKE_SBX: "ok" });
  assert.equal(r.code, 0, r.out);
  const rec = JSON.parse(fs.readFileSync(path.join(STATE, "hyprpi/world-off/G.json"), "utf8"));
  const u = Object.fromEntries(rec.units.map((x) => [x.unit, x]));
  assert.deepEqual([u["hyprpi-sandbox-restore.service"].enabled, u["hyprpi-sandbox-restore.service"].active], ["enabled", "inactive"]);
  assert.deepEqual([u["hyprpi-sandboxd.service"].enabled, u["hyprpi-sandboxd.service"].active], ["enabled", "active"]);
  assert.equal(rec.sandboxes.find((s) => s.name === "reader-g"), undefined, "reader-g was already stopped: the stop didn't change it, so it isn't recorded");
  assert.deepEqual(rec.sandboxes.find((s) => s.name === "world-q").state, "running");
  // a repeat stop keeps the first stop's "before"
  r = await run(["stop", "G", "--yes"], { FAKE_SBX: "ok" });
  const rec2 = JSON.parse(fs.readFileSync(path.join(STATE, "hyprpi/world-off/G.json"), "utf8"));
  assert.deepEqual(rec2.units, rec.units); assert.deepEqual(rec2.sandboxes, rec.sandboxes);
  r = await run(["start", "G", "--dry-run"]);
  assert.match(r.out, /would run: systemctl --user enable hyprpi-sandbox-restore\.service/);
  assert.doesNotMatch(r.out, /systemctl --user start hyprpi-sandbox-restore\.service/, "start would start a unit that was inactive before");
  assert.match(r.out, /would run: systemctl --user start hyprpi-sandboxd\.service/);
  assert.ok(r.out.indexOf("hyprpi-sandboxd.service") < r.out.indexOf("doorman-bridge-runner.path"), "sandboxd first");
  ok("F4: the record keeps each unit's enabled AND active state before the stop (kept across a repeat stop); start restores exactly that (restore unit enabled, not started)");

  // F4 (remote): start brings back only the agents this stop closed, never `recover` (every agent with a session there)
  await stopSandboxd();
  setup({ files: { "remote/i.json": { ssh: ["ssh", "nohost.invalid"] } } });
  fs.mkdirSync(path.join(STATE, "hyprpi/world-off"), { recursive: true });
  fs.writeFileSync(path.join(STATE, "hyprpi/world-off/I.json"), JSON.stringify({ version: 3, world: "I", kind: "remote", at: "t", units: [], sandboxes: [], moved_from: "", autostart_was: "", agents: [{ id: "i-hub-alpha", name: "hub-alpha" }], remote_daemon_was: "1" }));
  r = await run(["start", "I", "--dry-run"]);
  assert.match(r.out, /would run: .*fake-world I start hub-alpha/); assert.match(r.out, /would run: .*fake-world I open hub-alpha/);
  assert.doesNotMatch(r.out, /recover/);
  ok("F4: remote start reopens only the recorded agents (world I start/open hub-alpha), not recover");

  // F2: a remote world whose machine can't be reached: the remote part is skipped and the result is NOT off (exit 4)
  setup({ files: { "remote/i.json": { ssh: ["ssh", "nohost.invalid"] } } });
  r = await run(["stop", "I", "--yes"]);
  assert.equal(r.code, 4, r.out); assert.match(r.out, /NOT DONE: the machine can't be checked/); assert.match(r.out, /NOT fully off/);
  assert.deepEqual(mutating(r.calls), [], r.calls);
  ok("F2: an unreachable remote machine gives NOT fully off and exit 4 (nothing changed)");

  // F5: another room changes while it runs -> NOT fully off / check, exit 4 (a local world with nothing to stop)
  setup({ lists: [{ agents: [agent("a1", "A")] }, { agents: [agent("a1", "A")] }, { agents: [agent("a1", "A")] }, { agents: [agent("a1", "A"), agent("a2", "C")] }] });
  r = await run(["stop", "B", "--yes"]);
  assert.equal(r.code, 4, r.out); assert.match(r.out, /NOT DONE: the other rooms changed while this ran/); assert.match(r.out, /> C a2 a2/);
  assert.deepEqual(mutating(r.calls), [], r.calls);
  ok("F5: a change in another room during the run makes the result NOT fully off / check (exit 4)");
  setup({});
  r = await run(["stop", "B", "--yes"]); assert.equal(r.code, 0, r.out); assert.match(r.out, /=> world B is off/);
  ok("the same stop with nothing changing elsewhere: off, exit 0");

  // F2 (start): start checks too and only says "started" when the world is back; an agent that doesn't come back -> exit 4
  const recB = { version: 3, world: "B", kind: "local", at: "t", units: [], sandboxes: [], moved_from: "", autostart_was: "", agents: [agent("b1", "B", { name: "b1" })], remote_daemon_was: "" };
  setup({ lists: [{ agents: [agent("a1", "A")] }] }); fs.mkdirSync(path.join(STATE, "hyprpi/world-off"), { recursive: true });
  fs.writeFileSync(path.join(STATE, "hyprpi/world-off/B.json"), JSON.stringify(recB));
  r = await run(["start", "B", "--yes"]);
  assert.equal(r.code, 4, r.out); assert.match(r.out, /NOT BACK: agents not back: b1/); assert.doesNotMatch(r.out, /=> world B started/); assert.match(r.calls, /^hp new --id b1 --no-focus/m);
  setup({ lists: [{ agents: [agent("a1", "A")] }, { agents: [agent("a1", "A"), agent("b1", "B")] }] });
  fs.mkdirSync(path.join(STATE, "hyprpi/world-off"), { recursive: true }); fs.writeFileSync(path.join(STATE, "hyprpi/world-off/B.json"), JSON.stringify(recB));
  r = await run(["start", "B", "--yes"]);
  assert.match(r.out, /ok: its agents are back/); assert.match(r.out, /NOT BACK: the other rooms changed|=> world B started/);
  ok("F2: start verifies (an agent that doesn't come back: NOT fully back, exit 4; back: ok)");

  // G3c: a successful start retires the record (<X>.json.done-*), so a later stop records the fresh state
  {
    const dir = path.join(STATE, "hyprpi/world-off");
    assert.equal(fs.existsSync(path.join(dir, "B.json")), false, "the record wasn't retired after a successful start");
    assert.ok(fs.readdirSync(dir).some((f) => f.startsWith("B.json.done-")));
    const cnt = path.join(T, "list-count"); fs.writeFileSync(cnt, "0"); for (const f of fs.readdirSync(LISTS)) fs.unlinkSync(path.join(LISTS, f));
    fs.writeFileSync(path.join(LISTS, "00.json"), JSON.stringify({ agents: [agent("a1", "A")] }));
    r = await run(["stop", "B", "--yes"]); assert.equal(r.code, 0, r.out);
    const fresh = JSON.parse(fs.readFileSync(path.join(dir, "B.json"), "utf8"));
    assert.deepEqual(fresh.agents, []); assert.equal(fresh.first_stop, undefined, "a fresh stop merged with a retired record");
  }
  ok("G3: a successful start retires the record; the next stop records afresh");

  // G1 + G2: sandboxd's health check fails (it answers 500): every sandbox state is UNKNOWN (not stopped), the result is NOT off,
  // and the shared pieces stay on
  await startSandboxd(); HEALTH = 500;
  setup({ sandboxes: { "world-q": "running" }, units: gUnits, files: { "worlds/world-q.json.off-T": G, "sbx-relay.json": { sandboxes: [{ name: "world-q" }] } } });
  r = await run(["stop", "G", "--yes"], { FAKE_SBX: "ok" });
  HEALTH = 200;
  assert.equal(r.code, 4, r.out); assert.match(r.out, /NOT DONE: sandbox world-q is unknown/);
  assert.match(r.out, /left on: can't tell whether other sandboxes run \(sbx's daemon: unknown/);
  assert.doesNotMatch(r.calls, /systemctl (disable|stop).*(hyprpi-sandboxd|hyprpi-sbx-relay|doorman-bridge|hyprpi-research)/, r.calls);
  ok("G1/G2: a failing sandboxd health check reads as unknown: NOT off (exit 4) and the shared pieces stay on");

  // G1: systemctl not answering (bus errors): every unit is UNKNOWN, never "inactive": NOT off, exit 4
  await stopSandboxd();
  setup({ units: gUnits, files: { "worlds/world-q.json.off-T": G, "sbx-relay.json": { sandboxes: [{ name: "world-q" }] } } });
  r = await run(["stop", "G", "--yes"], { FAKE_SYSTEMCTL: "broken" });
  assert.equal(r.code, 4, r.out); assert.match(r.out, /NOT DONE: hyprpi-world-q-helper is unknown/); assert.match(r.out, /NOT DONE: hyprpi-sandboxd\.service is unknown/);
  ok("G1: systemctl errors read as unknown, not inactive: NOT off (exit 4)");

  // G1: a start without a record of a remote world checks on the machine too: unreachable -> NOT BACK, exit 4
  setup({ files: { "remote/i.json": { ssh: ["ssh", "nohost.invalid"] } } });
  r = await run(["start", "I", "--yes"]);
  assert.equal(r.code, 4, r.out); assert.match(r.calls, /^rworld I recover$/m); assert.match(r.out, /NOT BACK: the machine or world I's daemon there doesn't answer/);
  ok("G1: a recordless remote start (recover) is verified on the machine; unreachable gives NOT BACK (exit 4)");

  // G3: start restarts sandboxes recorded as running, restores the remote daemon, and never stops or disables anything
  setup({ units: gUnits, files: { "worlds/world-q.json.off-T": G, "sbx-relay.json": relay } });
  fs.mkdirSync(path.join(STATE, "hyprpi/world-off"), { recursive: true });
  fs.writeFileSync(path.join(STATE, "hyprpi/world-off/G.json"), JSON.stringify({ version: 3, world: "G", kind: "sandboxed", at: "t", units: [{ unit: "hyprpi-sandboxd.service", enabled: "enabled", active: "active", file: true }],
    sandboxes: [{ name: "world-q", state: "running" }, { name: "doorman-q", state: "running" }], moved_from: "", autostart_was: "", agents: [], remote_daemon_was: "" }));
  r = await run(["start", "G", "--dry-run"]);
  assert.match(r.out, /would run: sbx exec doorman-q true/); assert.match(r.out, /would run: .*restore\.sh world-q/);
  assert.doesNotMatch(r.out, /systemctl --user (stop|disable)/); assert.doesNotMatch(r.calls, /^sbx /m);
  setup({ files: { "remote/i.json": { ssh: ["ssh", "nohost.invalid"] } } });
  fs.mkdirSync(path.join(STATE, "hyprpi/world-off"), { recursive: true });
  fs.writeFileSync(path.join(STATE, "hyprpi/world-off/I.json"), JSON.stringify({ version: 3, world: "I", kind: "remote", at: "t", units: [], sandboxes: [], moved_from: "", autostart_was: "", agents: [], remote_daemon_was: "1" }));
  r = await run(["start", "I", "--dry-run"]); assert.match(r.out, /would run there: hyprpi ensure/);
  ok("G3: start restarts the sandboxes recorded as running (sbx exec NAME true), restores the remote daemon, never stops or disables");

  // G3: the record holds only what the stop changed (a unit already off, a sandbox already stopped: not recorded)
  await startSandboxd();
  const offBefore = { ...gUnits, "hyprpi-sandbox-restore.service": { file: true, enabled: false, active: false }, "hyprpi-research-daily.timer": { file: true, enabled: false, active: false } };
  setup({ sandboxes: { "world-q": "running", "doorman-q": "stopped", "reader-g": "stopped" }, units: offBefore, files: { "worlds/world-q.json.off-T": G, "sbx-relay.json": relay } });
  r = await run(["stop", "G", "--yes"], { FAKE_SBX: "ok" }); assert.equal(r.code, 0, r.out);
  { const rec3 = JSON.parse(fs.readFileSync(path.join(STATE, "hyprpi/world-off/G.json"), "utf8")), names = rec3.units.map((x) => x.unit);
    assert.ok(!names.includes("hyprpi-sandbox-restore.service") && !names.includes("hyprpi-research-daily.timer"), names.join(" "));
    assert.ok(names.includes("hyprpi-sandboxd.service") && names.includes("hyprpi-research-digest.timer"));
    assert.deepEqual(rec3.sandboxes.map((x) => x.name), ["world-q"]); }
  ok("G3: the record holds only what this stop changed");

  // G4: no kill / pkill on the stop or start path, including what start calls (restore.sh, world.sh, doorman.sh start, sbx-daemon.sh,
  // remote.sh start); comments don't count
  {
    const R = fileURLToPath(new URL("..", import.meta.url));
    const code = (f) => fs.readFileSync(path.join(R, f), "utf8").split("\n").map((l, i) => [i + 1, l]).filter(([, l]) => !/^\s*#/.test(l));
    const killy = /(^|[\s;|&(])(pkill|killall|kill)(\s|$)/;
    for (const f of ["bin/hyprpi-world", "docker/world/restore.sh", "docker/world/world.sh", "docker/sbx-daemon.sh"]) {
      const hits = code(f).filter(([, l]) => killy.test(l.replace(/#.*$/, "")));
      assert.deepEqual(hits, [], `${f} kills: ${JSON.stringify(hits)}`);
    }
    const branch = (f, name) => { const t = fs.readFileSync(path.join(R, f), "utf8"), i = t.indexOf(`\n${name})`), j = t.indexOf(";;\n", i); assert.ok(i >= 0 && j > i, `no ${name}) branch in ${f}`); return t.slice(i, j); };
    for (const [f, b] of [["docker/doorman/doorman.sh", "start"], ["omnistation/remote.sh", "  start"]]) {
      const body = branch(f, b).split("\n").filter((l) => !/^\s*#/.test(l)).map((l) => l.replace(/#.*$/, "")).join("\n");
      assert.ok(body.length > 200, `couldn't find ${f}'s ${b} branch`); assert.doesNotMatch(body, killy, `${f} ${b} kills`);
    }
  }
  ok("G4: no kill / pkill in hyprpi-world, restore.sh, world.sh, sbx-daemon.sh, doorman.sh start or remote.sh start");

  // G5: a record for another world / kind is refused (exit 2); names from config are checked and escaped in window patterns
  setup({ files: { "worlds/world-q.json.off-T": G, "sbx-relay.json": relay } });
  fs.mkdirSync(path.join(STATE, "hyprpi/world-off"), { recursive: true });
  fs.writeFileSync(path.join(STATE, "hyprpi/world-off/G.json"), JSON.stringify({ version: 3, world: "H", kind: "remote", at: "t", units: [], sandboxes: [], moved_from: "", autostart_was: "", agents: [], remote_daemon_was: "" }));
  r = await run(["start", "G", "--yes"]); assert.equal(r.code, 2, r.out); assert.match(r.out, /is for world H \(remote\), but world G is sandboxed/); assert.deepEqual(mutating(r.calls), []);
  setup({ sandboxes: { "world-q": "stopped" }, files: { "worlds/world-q.json.off-T": G, "sbx-relay.json": { sandboxes: [{ name: "world-q" }, { name: "doorman.q", doorman_for: "world-q" }, { name: "x;y", doorman_for: "world-q" }] } },
    clients: [{ address: "0x1", class: "hyprpi-doorman-doorman.q", title: "d" }, { address: "0x2", class: "hyprpi-doorman-doormanXq", title: "not ours" }] });
  r = await run(["stop", "G", "--dry-run"]);
  assert.match(r.out, /would close window 0x1 /); assert.doesNotMatch(r.out, /window 0x2 /); assert.match(r.out, /skipping a Doorman entry with an unexpected name: x;y/);
  ok("G5: a record for another world is refused; config names are validated and escaped (doorman.q doesn't match doormanXq)");

  // R1: a reachable machine whose daemon doesn't give a valid list but still has a session / socket / process: its state is UNKNOWN,
  // it isn't reported stopped, and the result is NOT off (exit 4); a provably stopped daemon (none of them) is off (exit 0)
  await stopSandboxd();
  const SSHOUT = path.join(T, "ssh-out");
  setup({ files: { "remote/i.json": { ssh: ["ssh", "fakehost"] } } });
  fs.writeFileSync(SSHOUT, "TMUX 0 1 1 1\nnot json\n");
  r = await run(["stop", "I", "--yes"], { FAKE_SSH_OUT: SSHOUT });
  assert.equal(r.code, 4, r.out); assert.match(r.out, /daemon unknown/); assert.match(r.out, /can't stop it: it doesn't answer \(unknown\)/);
  assert.match(r.out, /NOT DONE: its daemon's state can't be read \(no valid list, but daemon session 1, socket 1, daemon processes 1\)/);
  assert.doesNotMatch(r.out, /ok: its daemon is stopped/); assert.doesNotMatch(r.out, /=> world I is off/);
  fs.writeFileSync(SSHOUT, "TMUX 0 0 0 0\n");
  r = await run(["stop", "I", "--yes"], { FAKE_SSH_OUT: SSHOUT });
  assert.equal(r.code, 0, r.out); assert.match(r.out, /ok: its daemon is stopped \(no session, socket or process of world I there\)/); assert.match(r.out, /=> world I is off/);
  ok("R1: the remote daemon state is used: an unreadable list with a daemon session / socket / process there is unknown (exit 4); provably stopped is off");

  // R2: start of a sandboxed world whose main sandbox ran but whose Doorman was stopped before the stop, through the REAL restore.sh
  // (a copy, with fake callees): the Doorman stays stopped. Without a record the same restore starts it (the behaviour being guarded).
  {
    const HH = path.join(T, "h"), mk = (f, body) => { fs.mkdirSync(path.dirname(path.join(HH, f)), { recursive: true }); w(path.join(HH, f), body, 1); };
    fs.mkdirSync(path.join(HH, "docker/world"), { recursive: true });
    fs.copyFileSync(fileURLToPath(new URL("../docker/world/restore.sh", import.meta.url)), path.join(HH, "docker/world/restore.sh")); fs.chmodSync(path.join(HH, "docker/world/restore.sh"), 0o755);
    mk("bin/hyprpi", "#!/usr/bin/env bash\nexit 0");
    mk("docker/sbx-daemon.sh", "#!/usr/bin/env bash\necho own unit");
    mk("docker/world/g-env.sh", "true");
    const setU = (u, k, v) => `t=$(mktemp); jq --arg u ${u} '.[$u].${k} = ${v}' ${UNITS} > $t && mv $t ${UNITS}`;
    mk("docker/world/world.sh", `#!/usr/bin/env bash\necho "world.sh $*" >> ${LOG}\n[[ "$1" == start ]] && { t=$(mktemp); jq '.["world-q"] = "running"' ${SBSTATE} > $t && mv $t ${SBSTATE}; ${setU("hyprpi-world-q-helper", "active", "true")}; ${setU("hyprpi-world-q-shares", "active", "true")}; ${setU("hyprpi-sbx-relay", "active", "true")}; }; true`);
    mk("docker/doorman/doorman.sh", `#!/usr/bin/env bash\necho "doorman.sh $*" >> ${LOG}\n[[ "$1" == start ]] && { t=$(mktemp); jq --arg d "$2" '.[$d] = "running"' ${SBSTATE} > $t && mv $t ${SBSTATE}; ${setU('"hyprpi-doorman-$2"', "active", "true")}; }; true`);
    const env = { FAKE_SBX: "ok", HYPRPI_WORLD_RESTORE_BIN: path.join(HH, "docker/world/restore.sh"), HYPRPI_WORLD_DOORMAN_BIN: path.join(HH, "docker/doorman/doorman.sh"), HYPRPI_RESTORE_CHECK_SECS: "0" };
    const units0 = { "hyprpi-sandboxd.service": { file: true, enabled: true, active: true } };
    const recG = (doormanRan) => ({ version: 3, world: "G", kind: "sandboxed", at: "t",
      units: [{ unit: "hyprpi-world-q-helper", enabled: "disabled", active: "active", file: false }, ...(doormanRan ? [{ unit: "hyprpi-doorman-doorman-q", enabled: "disabled", active: "active", file: false }] : [])],
      sandboxes: [{ name: "world-q", state: "running" }, ...(doormanRan ? [{ name: "doorman-q", state: "running" }] : [])], moved_from: "", autostart_was: "", agents: [], remote_daemon_was: "" });
    const prep = (rec) => { setup({ sandboxes: { "world-q": "stopped", "doorman-q": "stopped" }, units: units0, files: { "worlds/world-q.json.off-T": G, "sbx-relay.json": relay } });
      if (rec) { fs.mkdirSync(path.join(STATE, "hyprpi/world-off"), { recursive: true }); fs.writeFileSync(path.join(STATE, "hyprpi/world-off/G.json"), JSON.stringify(rec)); } };
    await startSandboxd();
    prep(recG(false)); r = await run(["start", "G", "--yes"], env);
    assert.match(r.calls, /^world\.sh start world-q$/m, "restore.sh didn't run world.sh start:\n" + r.out);
    assert.doesNotMatch(r.calls, /^doorman\.sh start/m, "the undo started a Doorman that was stopped before the stop:\n" + r.calls);
    assert.match(r.out, /Doorman doorman-q: wasn't running before the stop, left stopped/); assert.match(r.out, /ok: Doorman doorman-q stopped, as before the stop/);
    assert.equal(JSON.parse(fs.readFileSync(SBSTATE, "utf8"))["doorman-q"], "stopped");
    assert.equal(r.code, 0, r.out);
    prep(recG(true)); r = await run(["start", "G", "--yes"], env);
    assert.match(r.calls, /^doorman\.sh start doorman-q$/m); assert.equal(r.code, 0, r.out);
    prep(null); r = await run(["start", "G", "--yes"], env);
    assert.match(r.calls, /^doorman\.sh start doorman-q$/m, "without the flag, restore.sh itself starts the Doorman (what R2 guards against)");
  }
  ok("R2: through the real restore.sh, start keeps a Doorman that was stopped before the stop stopped (and starts one that ran)");

  // J632 (Warden): a remote stop that couldn't read the machine records an unknown state (agents [], remote_daemon_was ""); the start
  // after it must verify on the machine: still unreachable -> NOT BACK, exit 4, no "started", the record kept. A recorded "0"
  // (provably stopped before) needs no check.
  await stopSandboxd();
  setup({ files: { "remote/i.json": { ssh: ["ssh", "nohost.invalid"] } } });
  r = await run(["stop", "I", "--yes"]); assert.equal(r.code, 4, r.out);
  { const recU = JSON.parse(fs.readFileSync(path.join(STATE, "hyprpi/world-off/I.json"), "utf8")); assert.deepEqual([recU.agents, recU.remote_daemon_was], [[], ""]); }
  r = await run(["start", "I", "--yes"]);
  assert.equal(r.code, 4, r.out); assert.match(r.out, /state before the stop is unknown/); assert.match(r.out, /NOT BACK: the machine or world I's daemon there doesn't answer/);
  assert.doesNotMatch(r.out, /=> world I started/); assert.ok(fs.existsSync(path.join(STATE, "hyprpi/world-off/I.json")), "the record was retired after an unverified start");
  fs.writeFileSync(path.join(STATE, "hyprpi/world-off/I.json"), JSON.stringify({ version: 3, world: "I", kind: "remote", at: "t", units: [], sandboxes: [], moved_from: "", autostart_was: "", agents: [], remote_daemon_was: "0" }));
  r = await run(["start", "I", "--yes"]); assert.equal(r.code, 0, r.out); assert.match(r.out, /nothing ran on the machine before the stop/);
  ok("J632: an unknown remote state at stop, then start: verified on the machine, unreachable -> exit 4, record kept, no 'started' (a recorded 0 needs no check)");

  // no terminal and no --yes: refused before anything
  setup({}); r = await run(["stop", "B"]); assert.equal(r.code, 3, r.out); assert.deepEqual(mutating(r.calls), []);
  ok("a real run without a terminal or --yes is refused (exit 3)");
  console.log(`# ${n} passed`);
} finally {
  await stopSandboxd();
  fs.rmSync(T, { recursive: true, force: true });
}
