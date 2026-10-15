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
  *) exit 1 ;;
esac`, 1);
w(path.join(BIN, "systemctl"), `#!/usr/bin/env bash
[[ "$1" == --user ]] && shift
v="$1"; shift; q=0; [[ "$1" == --quiet ]] && { q=1; shift; }
case "$v" in
  is-enabled) e=$(jq -r --arg u "$1" '.[$u].enabled // false' ${UNITS}); [[ $e == true ]] && echo enabled || echo disabled; [[ $e == true ]] ;;
  is-active) a=$(jq -r --arg u "$1" '.[$u].active // false' ${UNITS}); (( q )) || { [[ $a == true ]] && echo active || echo inactive; }; [[ $a == true ]] ;;
  list-unit-files) [[ $(jq -r --arg u "$1" '.[$u].file // false' ${UNITS}) == true ]] && echo "$1 enabled enabled"; true ;;
  *) echo "systemctl $v $*" >> ${LOG}; now=0; [[ "$1" == --now ]] && { now=1; shift; }; t=$(mktemp)
     case "$v" in enable) jq --arg u "$1" '.[$u].enabled = true' ${UNITS} ;; disable) jq --arg u "$1" --argjson n $now '.[$u].enabled = false | if $n == 1 then .[$u].active = false else . end' ${UNITS} ;;
       start) jq --arg u "$1" '.[$u].active = true' ${UNITS} ;; stop) jq --arg u "$1" '.[$u].active = false' ${UNITS} ;; *) cat ${UNITS} ;; esac > $t && mv $t ${UNITS} ;;
esac`, 1);
w(path.join(BIN, "hyprctl"), `#!/usr/bin/env bash
if [[ "$1" == -j && "$2" == clients ]]; then cat ${CLIENTS}; exit 0; fi
echo "hyprctl $*" >> ${LOG}`, 1);
for (const c of ["brev", "tsh"]) w(path.join(BIN, c), `#!/usr/bin/env bash\necho "${c} $*" >> ${LOG}; exit 1`, 1);
w(path.join(BIN, "ssh"), `#!/usr/bin/env bash\necho "ssh $*" >> ${LOG}; exit 255`, 1); // an unreachable machine
const HPF = path.join(T, "fake-hp.mjs"); // a fake hyprpi: "list --json" returns lists/<n>.json in turn (the last one repeats); the rest is logged
w(HPF, `import fs from "node:fs"; const a = process.argv.slice(2); fs.appendFileSync(${JSON.stringify(LOG)}, "hp " + a.join(" ") + "\\n");
if (a[0] === "list") { const c = ${JSON.stringify(path.join(T, "list-count"))}; let n = 0; try { n = Number(fs.readFileSync(c, "utf8")) || 0; } catch {}
  const files = fs.readdirSync(${JSON.stringify(LISTS)}).sort(); fs.writeFileSync(c, String(n + 1)); process.stdout.write(fs.readFileSync(${JSON.stringify(LISTS)} + "/" + files[Math.min(n, files.length - 1)])); }`);
fs.mkdirSync(LISTS);
// the fake sandboxd: /daemon/health 200; /sandbox/<name> -> its state from the file ("unknown" -> 500); anything else 404
const SOCK = path.join(STATE, "sandboxes/sandboxes/sandboxd/sandboxd.sock");
const srv = http.createServer((req, res) => {
  fs.appendFileSync(LOG, `sandboxd GET ${req.url}\n`);
  if (req.url === "/daemon/health") return res.end("ok");
  const m = /^\/sandbox\/([\w.-]+)$/.exec(req.url || ""), st = m ? JSON.parse(fs.readFileSync(SBSTATE, "utf8"))[m[1]] : undefined;
  if (!m || st === undefined) { res.statusCode = 404; return res.end("{}"); }
  if (st === "unknown") { res.statusCode = 500; return res.end("{}"); }
  res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ name: m[1], status: st }));
});
let sandboxdUp = false;
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
      HYPRPI_WORLD_HPBIN: HPF, HYPRPI_AGENT_ID: "", ...env } });
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
  assert.deepEqual([u["hyprpi-sandbox-restore.service"].enabled, u["hyprpi-sandbox-restore.service"].active], [true, false]);
  assert.deepEqual([u["hyprpi-sandboxd.service"].enabled, u["hyprpi-sandboxd.service"].active], [true, true]);
  assert.deepEqual(rec.sandboxes.find((s) => s.name === "reader-g").state, "stopped");
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
  fs.writeFileSync(path.join(STATE, "hyprpi/world-off/I.json"), JSON.stringify({ version: 2, world: "I", kind: "remote", at: "t", units: [], sandboxes: [], moved_from: "", autostart_was: "", agents: [{ id: "i-hub-alpha", name: "hub-alpha" }], remote_daemon_was: "1" }));
  r = await run(["start", "I", "--dry-run"]);
  assert.match(r.out, /would run: .*omnistation\/world I start hub-alpha/); assert.match(r.out, /would run: .*omnistation\/world I open hub-alpha/);
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
  const recB = { version: 2, world: "B", kind: "local", at: "t", units: [], sandboxes: [], moved_from: "", autostart_was: "", agents: [agent("b1", "B", { name: "b1" })], remote_daemon_was: "" };
  setup({ lists: [{ agents: [agent("a1", "A")] }] }); fs.mkdirSync(path.join(STATE, "hyprpi/world-off"), { recursive: true });
  fs.writeFileSync(path.join(STATE, "hyprpi/world-off/B.json"), JSON.stringify(recB));
  r = await run(["start", "B", "--yes"]);
  assert.equal(r.code, 4, r.out); assert.match(r.out, /NOT BACK: agents not back: b1/); assert.doesNotMatch(r.out, /=> world B started/); assert.match(r.calls, /^hp new --id b1 --no-focus/m);
  setup({ lists: [{ agents: [agent("a1", "A")] }, { agents: [agent("a1", "A"), agent("b1", "B")] }] });
  fs.mkdirSync(path.join(STATE, "hyprpi/world-off"), { recursive: true }); fs.writeFileSync(path.join(STATE, "hyprpi/world-off/B.json"), JSON.stringify(recB));
  r = await run(["start", "B", "--yes"]);
  assert.match(r.out, /ok: its agents are back/); assert.match(r.out, /NOT BACK: the other rooms changed|=> world B started/);
  ok("F2: start verifies (an agent that doesn't come back: NOT fully back, exit 4; back: ok)");

  // no terminal and no --yes: refused before anything
  setup({}); r = await run(["stop", "B"]); assert.equal(r.code, 3, r.out); assert.deepEqual(mutating(r.calls), []);
  ok("a real run without a terminal or --yes is refused (exit 3)");
  console.log(`# ${n} passed`);
} finally {
  await stopSandboxd();
  fs.rmSync(T, { recursive: true, force: true });
}
