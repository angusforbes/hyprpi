#!/usr/bin/env node
// J698 proof (Angus, mem4: pi-subagents off by default; "the project agent could decide to start the task agent with the
// pi-subagent extension"): an agent can be STARTED with extra pi extensions by name, and keeps them on every relaunch.
//   node test/run.mjs test/orch-extras.mjs   (exit 0 = pass; only inside the test guard)
// A) lib/agent-extras.mjs: names are checked (unknown name / missing folder refused), remembered per agent, turned into -e args;
//    a folder that vanished later is reported as missing, never dropped silently.
// B) an isolated daemon (temp socket + state + config; orchestration.extras.subagents = a temp folder) and fake agents:
//    1. spawn_agent (orch.spawn) subagents: true -> the child's extras are remembered, its welcome says it has the Agent tool,
//       the 🌱 note and the result say "with subagents"; without it -> nothing remembered.
//    2. `hyprpi new --id CHILD` (what every relaunch runs) starts pi with -e <the folder>; a plain agent's has no extra -e.
//    3. /restart (agent.restart -> restartReady): the daemon's own relaunch of the child carries -e <the folder>.
//    4. an upkeep refresh (upkeep.ready, fresh session) carries it too.
//    5. open_agent (thoughts.open) subagents: true -> remembered, and its `hyprpi new` has -e.
//    6. `hyprpi new --extra bogus` is refused, and so is a configured name whose folder is gone; nothing is remembered for them.
//    6b. a remembered extra whose folder vanished: the relaunch starts without it and says so (stderr, a note to the agent, a ⚠ to Thoughts).
//    6c. --extra on a remote world's workspace is refused, not dropped.
// Every `hyprpi new` here only logs its pi argv (HYPRPI_NEW_ARGV_LOG, isolated hyprpi only): no window or pi ever starts.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { requireSandbox } from "./guard/sandbox.mjs";
await requireSandbox(import.meta.url); // it ends processes (its own children only)

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
let fails = 0; const ok = (n, c, x = "") => { if (!c) fails++; console.log(`${c ? "ok  " : "FAIL"} ${n}${x ? ": " + x : ""}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const S = fs.mkdtempSync(path.join(os.tmpdir(), "j698-")), cfg = path.join(S, "cfg"), sock = path.join(S, "d.sock"), argvLog = path.join(S, "new-argv.jsonl");
const subDir = path.join(S, "fake-pi-subagents"), goneDir = path.join(S, "not-there");
fs.mkdirSync(subDir); fs.mkdirSync(path.join(cfg, "hyprpi"), { recursive: true }); fs.mkdirSync(path.join(S, "boards"));
fs.writeFileSync(path.join(cfg, "hyprpi", "config.json"), JSON.stringify({ roomToThoughts: false, pi: "/bin/cat", worldSize: 10, cwd: S }));
fs.writeFileSync(path.join(cfg, "hyprpi", "hyprpi.jsonc"), JSON.stringify({ auth: { enabled: false }, upkeep: { refresh: { enabled: false }, autoReload: { enabled: false } }, orchestration: { extras: { subagents: subDir, gone: goneDir } } }));
const env = { ...process.env, HYPRPI_SOCKET: sock, HYPRPI_STATE: S, XDG_CONFIG_HOME: cfg, HYPRLAND_INSTANCE_SIGNATURE: "j698-bogus", HYPRPI_NO_ENSURE: "1", HYPRPI_UPKEEP_MS: "3600000", HYPRPI_ORCH_LAUNCH: "/bin/true", HYPRPI_NEW_ARGV_LOG: argvLog };
delete env.HYPRPI_AGENT_ID; delete env.HYPRPI_WORKSPACE;
const kids = [];

// ---- A) the library, in this process (its own state and config)
process.env.HYPRPI_STATE = S; process.env.XDG_CONFIG_HOME = cfg;
const X = await import(path.join(ROOT, "lib/agent-extras.mjs"));
ok("A subagents is configured", X.checkExtras(["subagents", "SubAgents "]).join() === "subagents");
let err = ""; try { X.checkExtras(["bogus"]); } catch (e) { err = e.message; } ok("A an unknown name is refused", /no extra extension "bogus"/.test(err), err);
err = ""; try { X.checkExtras(["gone"]); } catch (e) { err = e.message; } ok("A a configured name whose folder is missing is refused", /isn't installed/.test(err), err);
X.setExtras("hp-unit", ["subagents"]);
ok("A remembered and turned into -e", JSON.stringify(X.extrasArgs("hp-unit").args) === JSON.stringify(["-e", subDir]));
X.setExtras("hp-unit2", ["gone"]);
ok("A a vanished folder is reported missing (not silently dropped)", X.extrasArgs("hp-unit2").missing.join() === "gone" && X.extrasArgs("hp-unit2").args.length === 0);
X.setExtras("hp-unit", []); X.setExtras("hp-unit2", []);
ok("A [] forgets it", X.getExtras("hp-unit").length === 0);
ok("A the policy default points at the installed pi-subagents", /@tintinweb\/pi-subagents$/.test(X.EXTRAS_DEFAULT.subagents));

// ---- B) the daemon
const d = spawn(process.execPath, [path.join(ROOT, "bin/hyprpi"), "daemon"], { env, stdio: ["ignore", fs.openSync(path.join(S, "d.log"), "w"), "inherit"] });
kids.push(d);
const newArgv = (id, extra = []) => { const r = spawnSync(process.execPath, [path.join(ROOT, "bin/hyprpi"), "new", "--id", id, "--cwd", S, "--no-focus", ...extra], { env: { ...env, HYPRPI_NEW_ARGV_LOG: "", HYPRPI_NEW_PRINT_ARGV: "1" }, encoding: "utf8", timeout: 30000 }); try { return { ...JSON.parse(r.stdout.trim().split("\n").pop()), code: r.status, err: r.stderr }; } catch { return { code: r.status, err: r.stderr + r.stdout }; } };
const logged = (id) => { try { return fs.readFileSync(argvLog, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((x) => x.id === id); } catch { return []; } };
const hasE = (argv) => { const i = (argv || []).indexOf(subDir); return i > 0 && argv[i - 1] === "-e"; };
try {
  for (let i = 0; i < 50 && !fs.existsSync(sock); i++) await sleep(200);
  const { connect } = await import(path.join(ROOT, "lib/client.mjs"));
  const got = {};
  const hello = async (id, name, ws, pid = process.pid, session = "") => { got[id] = []; const c = await connect({ path: sock, onEvent: (ev, data) => got[id].push({ ev, data }) }); await c.call("agent.hello", { agent_id: id, pid, name, want_workspace: ws, cwd: S, ...(session ? { session } : {}) }); return c; };
  const parent = await hello("hp-parent", "Boss", 32);

  // 1. spawn_agent
  const r1 = await parent.call("orch.spawn", { prompt: "read the big file in parallel; report_to_parent", name: "Reader", subagents: true });
  ok("1 spawn_agent subagents: true is accepted, result says so", (r1.extras || []).join() === "subagents", JSON.stringify(r1));
  ok("1 the child's extras are remembered", X.getExtras(r1.id).join() === "subagents");
  const r0 = await parent.call("orch.spawn", { prompt: "plain helper; report_to_parent", name: "Plain" });
  ok("1 a plain spawn remembers nothing", X.getExtras(r0.id).length === 0 && !(r0.extras || []).length);
  const sess = path.join(S, "reader.jsonl"); fs.writeFileSync(sess, '{"type":"session"}\n');
  const kid = spawn(process.execPath, ["-e", "setInterval(()=>{},1e6)"], { stdio: "ignore" }); kids.push(kid);
  let child = await hello(r1.id, "Reader", 33, kid.pid, sess);
  for (let i = 0; i < 50 && !got[r1.id].some((e) => e.ev === "prompt"); i++) await sleep(100);
  const welcome = got[r1.id].find((e) => e.ev === "prompt")?.data?.text || "";
  ok("1 its welcome says it has the in-process Agent tool", /started you WITH pi-subagents/.test(welcome) && /Agent tool/.test(welcome), welcome.slice(-300));

  // 2. hyprpi new --id (every relaunch)
  const n1 = newArgv(r1.id), n0 = newArgv(r0.id);
  ok("2 hyprpi new --id CHILD starts pi with -e <pi-subagents>", n1.code === 0 && hasE(n1.piArgv), JSON.stringify(n1).slice(0, 300));
  ok("2 a plain agent's pi has no extra -e", n0.code === 0 && !hasE(n0.piArgv) && n0.piArgv.filter((x) => x === "-e").length === 1, JSON.stringify(n0.piArgv));

  // 3. /restart
  const rs = await parent.call("agent.restart", { agent: "Reader", compact: false });
  ok("3 /restart is asked", !!rs.agent, JSON.stringify(rs));
  for (let i = 0; i < 30 && !got[r1.id].some((e) => e.ev === "restart"); i++) await sleep(100);
  await child.call("agent.restartReady", {});
  kid.kill("SIGTERM"); child.close();
  for (let i = 0; i < 100 && !logged(r1.id).length; i++) await sleep(200);
  ok("3 the daemon's relaunch after /restart carries -e <pi-subagents>", logged(r1.id).length === 1 && hasE(logged(r1.id)[0].piArgv), JSON.stringify(logged(r1.id)).slice(0, 300));
  ok("3 …and it resumes the same session", (logged(r1.id)[0]?.piArgv || []).includes(sess));

  // 4. an upkeep refresh (fresh session) of the same child
  // (no window ever comes up here, so the daemon waits its 60 s for one before the restart is over; a reconnect in between
  // is the relaunched agent coming back)
  const kid2 = spawn(process.execPath, ["-e", "setInterval(()=>{},1e6)"], { stdio: "ignore" }); kids.push(kid2);
  child = await hello(r1.id, "Reader", 33, kid2.pid, sess);
  const hf = path.join(S, "handoff-reader.md"); fs.writeFileSync(hf, "# handoff\nReader: nothing open; long enough to count as a note.\n");
  let up = {};
  for (let i = 0; i < 90; i++) { up = await child.call("upkeep.ready", { file: hf }).catch((e) => ({ error: e.message })); if (!up.already) break; await sleep(1000); }
  ok("4 upkeep.ready starts a refresh", up.refreshing === true, JSON.stringify(up));
  const seen = logged(r1.id).length;
  await child.call("agent.restartReady", {}).catch(() => {});
  kid2.kill("SIGTERM"); child.close();
  for (let i = 0; i < 100 && logged(r1.id).length <= seen; i++) await sleep(200);
  const l2 = logged(r1.id)[seen];
  ok("4 the refresh's relaunch carries -e <pi-subagents>", !!l2 && hasE(l2.piArgv), JSON.stringify(l2 || {}).slice(0, 300));
  ok("4 …on a fresh session (no --session)", !!l2 && !l2.piArgv.includes("--session"));

  // 5. open_agent (thoughts.open)
  const api = await connect({ path: sock, onEvent: () => {} });
  const op = await api.call("thoughts.open", { room: "D", angus: "x", goal: "read many sources in parallel", done_when: ["W1 done"], name: "Gatherer", subagents: true }).catch((e) => ({ error: e.message }));
  ok("5 open_agent subagents: true is accepted", !!op.agent && !op.error, JSON.stringify(op));
  const gid = (JSON.parse(fs.readFileSync(path.join(S, "agent-extras.json"), "utf8")) && Object.keys(JSON.parse(fs.readFileSync(path.join(S, "agent-extras.json"), "utf8"))).find((k) => k !== r1.id)) || "";
  ok("5 the opened agent's extras are remembered", !!gid && X.getExtras(gid).join() === "subagents", gid);
  for (let i = 0; i < 100 && !logged(gid).length; i++) await sleep(200);
  ok("5 its hyprpi new starts pi with -e <pi-subagents>", logged(gid).length === 1 && hasE(logged(gid)[0].piArgv), JSON.stringify(logged(gid)).slice(0, 300));

  // 6b. a remembered extra whose folder vanished: the relaunched agent starts without it, and it and the log are told
  fs.renameSync(subDir, subDir + ".moved");
  const nm = newArgv(r1.id);
  ok("6b a vanished extra: hyprpi new starts without it and says so on stderr", nm.code === 0 && !hasE(nm.piArgv) && /WITHOUT its extra extension\(s\) subagents/.test(nm.err), (nm.err || "").slice(0, 200));
  const kid3 = spawn(process.execPath, ["-e", "setInterval(()=>{},1e6)"], { stdio: "ignore" }); kids.push(kid3);
  await hello(r1.id, "Reader", 33, kid3.pid, sess);
  const warn = () => got[r1.id].find((e) => e.ev === "note" && /started WITHOUT its extra extension\(s\) subagents/.test(e.data?.text || ""));
  for (let i = 0; i < 40 && !warn(); i++) await sleep(100);
  ok("6b …and the agent itself gets a visible note (no in-process Agent tool)", !!warn() && /no in-process Agent tool/.test(warn().data.text), JSON.stringify(got[r1.id].map((e) => e.ev)));
  let thread = ""; for (let i = 0; i < 30 && !/Reader started WITHOUT/.test(thread); i++) { await sleep(100); try { thread = fs.readFileSync(path.join(S, "thoughts", "D.thread.jsonl"), "utf8"); } catch { /* not yet */ } }
  ok("6b …and its world's Thoughts gets the ⚠ alert", /Reader started WITHOUT its extra extension\(s\) subagents/.test(thread));
  fs.renameSync(subDir + ".moved", subDir);
  // 6c. refused where it can't be kept: a remote world's workspace (bound in cfg/hyprpi/remote/h.json)
  fs.mkdirSync(path.join(cfg, "hyprpi", "remote"), { recursive: true }); fs.writeFileSync(path.join(cfg, "hyprpi", "remote", "h.json"), "{}");
  const nr = spawnSync(process.execPath, [path.join(ROOT, "bin/hyprpi"), "new", "--workspace", "72", "--extra", "subagents", "--no-focus"], { env: { ...env, HYPRPI_NEW_ARGV_LOG: "", HYPRPI_NEW_PRINT_ARGV: "1" }, encoding: "utf8", timeout: 30000 });
  ok("6c --extra on a remote world's workspace is refused, not dropped", nr.status !== 0 && /--extra isn.t supported for a new agent on a remote world/.test(nr.stderr), nr.stderr.slice(0, 200));
  // 6. refusals
  const nb = newArgv("hp-bogus1", ["--extra", "bogus"]);
  ok("6 hyprpi new --extra bogus is refused", nb.code !== 0 && /no extra extension "bogus"/.test(nb.err), nb.err.slice(0, 200));
  const ng = newArgv("hp-gone1", ["--extra", "gone"]);
  ok("6 a configured extra whose folder is missing is refused at open", ng.code !== 0 && /isn't installed/.test(ng.err), ng.err.slice(0, 200));
  ok("6 nothing is remembered for refused opens", X.getExtras("hp-bogus1").length === 0 && X.getExtras("hp-gone1").length === 0);
} catch (e) {
  ok("no exception", false, e.stack);
} finally {
  for (const k of kids) { try { k.kill("SIGTERM"); } catch { /* gone */ } }
  await sleep(300);
  if (fails) console.log("state:", S); else fs.rmSync(S, { recursive: true, force: true });
}
console.log(fails ? `${fails} FAILED` : "all ok");
process.exit(fails ? 1 : 0);
