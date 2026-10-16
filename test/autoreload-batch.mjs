#!/usr/bin/env node
// J715 proof (Angus, mem3a: batch the automatic reloads, ~60 per agent per day before): an idle agent is auto-reloaded at most once
// per upkeep.autoReload.minHours after its window loaded its code, code changes in between come together in that one reload,
// and a batch is staggered (maxPerPass per upkeep pass); a busy agent is never reloaded.
//   node test/run.mjs test/autoreload-batch.mjs   (exit 0 = pass; only inside the test guard)
// An isolated daemon (temp socket, state, config and pi agent dir; upkeep pass every 300 ms; minHours 0.002 = 7.2 s so the test
// can wait it out) and fake agents that only talk the daemon's protocol (no pi, no window). The agent code version is moved by
// touching a watched file (autoReload.watch).
// 0. defaults: minHours 4, maxPerPass 3.
// 1. A, B, C idle on old code, D working: A, B, C each get ONE reload, at least one pass apart (maxPerPass 1); D gets none.
// 2. A reconnects on the new code (its window reloaded). The code changes twice within minHours: no reload yet; after minHours,
//    exactly one reload, carrying the LATEST code version.
// 3. a daemon restart doesn't reset the clock: codeAt is kept in upkeep.json.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { requireSandbox } from "./guard/sandbox.mjs";
await requireSandbox(import.meta.url);

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
let fails = 0; const ok = (n, c, x = "") => { if (!c) fails++; console.log(`${c ? "ok  " : "FAIL"} ${n}${x ? ": " + x : ""}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const S = fs.mkdtempSync(path.join(os.tmpdir(), "j715-")), cfg = path.join(S, "cfg"), sock = path.join(S, "d.sock"), agentDir = path.join(S, "pi-agent"), watched = path.join(S, "watched.txt");
fs.mkdirSync(path.join(cfg, "hyprpi"), { recursive: true }); fs.mkdirSync(path.join(agentDir, "skills"), { recursive: true }); fs.mkdirSync(path.join(agentDir, "extensions"));
fs.writeFileSync(watched, "v1");
fs.writeFileSync(path.join(cfg, "hyprpi", "config.json"), JSON.stringify({ roomToThoughts: false, pi: "/bin/cat", worldSize: 10, cwd: S }));
const policy = (ar) => fs.writeFileSync(path.join(cfg, "hyprpi", "hyprpi.jsonc"), JSON.stringify({ auth: { enabled: false }, upkeep: { refresh: { enabled: false, rssMB: 0 }, autoReload: { enabled: true, idleMinutes: 0, watch: [watched], ...ar } } }));
const env = { ...process.env, HYPRPI_SOCKET: sock, HYPRPI_STATE: S, XDG_CONFIG_HOME: cfg, PI_CODING_AGENT_DIR: agentDir, HYPRLAND_INSTANCE_SIGNATURE: "j715-bogus", HYPRPI_NO_ENSURE: "1", HYPRPI_UPKEEP_MS: "300" };
delete env.HYPRPI_AGENT_ID; delete env.HYPRPI_WORKSPACE;
let d = null;
const startDaemon = async () => { d = spawn(process.execPath, [path.join(ROOT, "bin/hyprpi"), "daemon"], { env, stdio: ["ignore", fs.openSync(path.join(S, "d.log"), "a"), "inherit"] }); for (let i = 0; i < 50 && !fs.existsSync(sock); i++) await sleep(200); await sleep(500); };
const stopDaemon = async () => { d.kill("SIGTERM"); for (let i = 0; i < 50 && d.exitCode === null && d.signalCode === null; i++) await sleep(100); try { fs.unlinkSync(sock); } catch { /* gone */ } };
try {
  process.env.XDG_CONFIG_HOME = cfg; process.env.HYPRPI_STATE = S;
  policy({});
  const { loadPolicy } = await import(path.join(ROOT, "lib/policy.mjs"));
  const AR0 = loadPolicy().upkeep.autoReload;
  ok("0 defaults: minHours 4, maxPerPass 3", AR0.minHours === 4 && AR0.maxPerPass === 3, JSON.stringify(AR0));
  policy({ minHours: 0.002, maxPerPass: 1 });
  await startDaemon();
  const { connect } = await import(path.join(ROOT, "lib/client.mjs"));
  const got = {}, conns = {};
  const hello = async (id, name, ws, code) => {
    got[id] ||= []; try { conns[id]?.close(); } catch { /* none */ }
    conns[id] = await connect({ path: sock, onEvent: (ev, data) => got[id].push({ ev, data, at: Date.now() }) });
    await conns[id].call("agent.hello", { agent_id: id, pid: process.pid, name, want_workspace: ws, cwd: S, code });
  };
  const reloads = (id) => (got[id] || []).filter((e) => e.ev === "reload");

  // 1. a batch, staggered; busy never
  await hello("hp-d", "Dee", 35, "old000000000"); await conns["hp-d"].call("agent.update", { status: "working" });
  for (const [id, n, ws] of [["hp-a", "Ay", 32], ["hp-b", "Bee", 33], ["hp-c", "Cee", 34]]) await hello(id, n, ws, "old000000000");
  for (let i = 0; i < 40 && !["hp-a", "hp-b", "hp-c"].every((id) => reloads(id).length); i++) await sleep(200);
  await sleep(1500);
  ok("1 A, B and C (idle, old code) each get one reload", ["hp-a", "hp-b", "hp-c"].every((id) => reloads(id).length === 1), ["hp-a", "hp-b", "hp-c"].map((id) => reloads(id).length).join());
  const ts = ["hp-a", "hp-b", "hp-c"].map((id) => reloads(id)[0]?.at || 0).sort((x, y) => x - y);
  ok("1 staggered: one per pass, >= 200 ms apart", ts[1] - ts[0] >= 200 && ts[2] - ts[1] >= 200, `${ts[1] - ts[0]} ms, ${ts[2] - ts[1]} ms`);
  ok("1 D (working) is never reloaded", reloads("hp-d").length === 0);
  const cur1 = reloads("hp-a")[0]?.data?.code || "";

  // 2. minHours: A loads the new code; two more code changes inside the window; one reload after it, with the latest code
  await hello("hp-a", "Ay", 32, cur1); got["hp-a"] = [];
  await sleep(1000); fs.writeFileSync(watched, "v2-longer"); await sleep(1000); fs.writeFileSync(watched, "v3-longer-still");
  await sleep(2500);
  ok("2 two code changes within minHours: no reload yet", reloads("hp-a").length === 0, String(reloads("hp-a").length));
  for (let i = 0; i < 60 && !reloads("hp-a").length; i++) await sleep(200);
  await sleep(1500);
  const { codeVersion } = await import(path.join(ROOT, "lib/codever.mjs"));
  process.env.PI_CODING_AGENT_DIR = agentDir;
  const latest = codeVersion("agent", [watched]);
  ok("2 after minHours: exactly one reload", reloads("hp-a").length === 1, String(reloads("hp-a").length));
  ok("2 …carrying the latest code (both changes together)", reloads("hp-a")[0]?.data?.code === latest && latest !== cur1, `${reloads("hp-a")[0]?.data?.code} vs ${latest}`);

  // 3. the clock survives a daemon restart: B loads the latest code now, the daemon restarts, the code changes: no reload within minHours
  await hello("hp-b", "Bee", 33, latest); await sleep(800);
  const upk = JSON.parse(fs.readFileSync(path.join(S, "upkeep.json"), "utf8"));
  ok("3 codeAt is kept in upkeep.json", upk.agents?.["hp-b"]?.code === latest && upk.agents["hp-b"].codeAt > 0, JSON.stringify(upk.agents?.["hp-b"]));
  for (const c of Object.values(conns)) { try { c.close(); } catch { /* gone */ } }
  await stopDaemon(); fs.writeFileSync(watched, "v4-after-restart"); await startDaemon();
  got["hp-b"] = []; await hello("hp-b", "Bee", 33, latest);
  await sleep(2500);
  ok("3 after a daemon restart, still no reload inside minHours", reloads("hp-b").length === 0, String(reloads("hp-b").length));
  for (let i = 0; i < 60 && !reloads("hp-b").length; i++) await sleep(200);
  ok("3 …and one once it has passed", reloads("hp-b").length === 1, String(reloads("hp-b").length));
  let stream = ""; try { stream = fs.readdirSync(path.join(S, "activity")).map((f) => fs.readFileSync(path.join(S, "activity", f), "utf8")).join(""); } catch { /* none */ }
  ok("the Stream line says it's batched", /reloaded Bee \(its window had older hyprpi\/pi code: [0-9a-f]+ → [0-9a-f]+; batched, at most every 0\.002 h\)/.test(stream));
} catch (e) {
  ok("no exception", false, e.stack);
} finally {
  try { d?.kill("SIGTERM"); } catch { /* gone */ }
  await sleep(300);
  if (fails) console.log("state:", S); else fs.rmSync(S, { recursive: true, force: true });
}
console.log(fails ? `${fails} FAILED` : "all ok");
process.exit(fails ? 1 : 0);
