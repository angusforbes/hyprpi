#!/usr/bin/env node
// J708 proof (Angus, mem1a + mem2b: "mem1a yes. mem2b 500MB"): an idle agent whose pi uses more memory (RSS) than
// upkeep.refresh.rssMB (default 500) is RESTARTED ON ITS SAME SESSION: no handoff turn, full context kept, once per cooldown.
//   node test/run.mjs test/upkeep-rss.mjs   (exit 0 = pass; runs only inside the test guard)
// An isolated daemon (temp socket + state + config, no Hyprland, upkeep pass every 300 ms) and fake agents, each backed by a
// child process THIS test spawns with that agent's HYPRPI_AGENT_ID (Big's and the others' hold ~260 MB):
//   Big    idle, over the limit                        -> restarted on its session (W1)
//   Small  idle, ~50 MB                                 -> never
//   Liar   says Big's child is its pid (foreign pid)    -> never
//   Busy   over the limit but working                   -> never
//   Paused over the limit, in upkeep.paused             -> never
//   Boxed  over the limit, in a container               -> never (its pid isn't a local agent's to judge)
// 0. the default limit is 500. 1. rssMB 0 (off): nobody. 2. rssMB 150: only Big gets a restart (compact: false), no handoff prompt;
// 3. restartReady -> the daemon relaunches it with --session <its same file> (HYPRPI_NEW_ARGV_LOG: isolated hyprpi only, no window)
//    -> the new pi connects -> its 🔄 note says "restarted on its same session for memory" with RSS before -> after (lower);
// 4. Big grows again at once: no second restart within the cooldown (one per cooldownHours).
// 6. a memory restart whose relaunch never comes back: a ⚠ alert to its world's Thoughts (not only the log).
// 5. an agent whose world is bound to a remote machine (cfg/hyprpi/remote/d.json): never restarted from here.
// Only processes this test spawned are signalled, by their own pid.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { requireSandbox } from "./guard/sandbox.mjs";
await requireSandbox(import.meta.url); // it ends processes (its own children only): only inside the test guard

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
let fails = 0; const ok = (n, c, x = "") => { if (!c) fails++; console.log(`${c ? "ok  " : "FAIL"} ${n}${x ? ": " + x : ""}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rssMb = (pid) => { try { return Math.round(Number(fs.readFileSync(`/proc/${pid}/status`, "utf8").match(/VmRSS:\s+(\d+)/)[1]) / 1024); } catch { return 0; } };

const S = fs.mkdtempSync(path.join(os.tmpdir(), "j708-")), cfg = path.join(S, "cfg"), sock = path.join(S, "d.sock"), argvLog = path.join(S, "new-argv.jsonl");
fs.mkdirSync(path.join(cfg, "hyprpi"), { recursive: true });
fs.writeFileSync(path.join(cfg, "hyprpi", "config.json"), JSON.stringify({ roomToThoughts: false, pi: "/bin/cat", worldSize: 10, cwd: S }));
const policy = (rssMB) => fs.writeFileSync(path.join(cfg, "hyprpi", "hyprpi.jsonc"), JSON.stringify({ auth: { enabled: false }, upkeep: { refresh: { enabled: true, idleMinutes: 0, cooldownHours: 3, ...(rssMB === undefined ? {} : { rssMB }) }, autoReload: { enabled: false }, paused: ["Paused"] } }));
policy(undefined);

const kids = [];
const child = (id, holdMb) => {
  const env = { ...process.env, HYPRPI_AGENT_ID: id }; delete env.HYPRPI_WORKSPACE;
  const code = `const keep = []; for (let i = 0; i < ${holdMb}; i++) keep.push(Buffer.alloc(1 << 20, 1)); globalThis.k = keep; setInterval(() => {}, 1e6);`;
  const k = spawn(process.execPath, ["-e", code], { env, stdio: "ignore" }); kids.push(k); return k;
};
const P = { big: child("hp-big", 260), small: child("hp-small", 0), busy: child("hp-busy", 260), paused: child("hp-paused", 260), boxed: child("hp-boxed", 260) };
const fakeBin = path.join(S, "bin"), clientsFile = path.join(S, "clients.json"); fs.mkdirSync(fakeBin); fs.writeFileSync(clientsFile, "[]");
fs.writeFileSync(path.join(fakeBin, "hyprctl"), `#!/bin/sh\ncase "$*" in *clients*) cat "${clientsFile}";; *activewindow*|*activeworkspace*) echo '{}';; *) echo '[]';; esac\n`, { mode: 0o755 });
const env = { ...process.env, PATH: `${fakeBin}:${process.env.PATH}`, HYPRPI_SOCKET: sock, HYPRPI_STATE: S, XDG_CONFIG_HOME: cfg, HYPRLAND_INSTANCE_SIGNATURE: "j708-bogus", HYPRPI_NO_ENSURE: "1", HYPRPI_UPKEEP_MS: "300", HYPRPI_NEW_ARGV_LOG: argvLog };
delete env.HYPRPI_AGENT_ID; delete env.HYPRPI_WORKSPACE;
const d = spawn(process.execPath, [path.join(ROOT, "bin/hyprpi"), "daemon"], { env, stdio: ["ignore", fs.openSync(path.join(S, "d.log"), "w"), "inherit"] });
kids.push(d);
try {
  // 0. the default
  process.env.XDG_CONFIG_HOME = cfg; process.env.HYPRPI_STATE = S;
  const { loadUpkeep } = await import(path.join(ROOT, "lib/upkeep.mjs"));
  ok("0 upkeep.refresh.rssMB defaults to 500 (Angus mem2b)", loadUpkeep().refresh.rssMB === 500, String(loadUpkeep().refresh.rssMB));
  policy(0);
  for (let i = 0; i < 50 && !fs.existsSync(sock); i++) await sleep(200);
  for (let i = 0; i < 50 && Object.values(P).some((k, j) => j !== 1 && rssMb(k.pid) < 240); i++) await sleep(100);
  ok("setup: the big children hold > 200 MB, Small's < 120 MB", rssMb(P.big.pid) > 200 && rssMb(P.busy.pid) > 200 && rssMb(P.small.pid) < 120, `${rssMb(P.big.pid)} / ${rssMb(P.small.pid)} MB`);
  const { connect } = await import(path.join(ROOT, "lib/client.mjs"));
  const got = {}, conns = {}, sess = {};
  const hello = async (id, name, pid, ws, extra = {}) => {
    got[id] = []; sess[id] ||= path.join(S, `${id}.jsonl`); if (!fs.existsSync(sess[id])) fs.writeFileSync(sess[id], '{"type":"session"}\n');
    conns[id] = await connect({ path: sock, onEvent: (ev, data) => got[id].push({ ev, data }) });
    await conns[id].call("agent.hello", { agent_id: id, pid, name, want_workspace: ws, cwd: S, session: sess[id], ...extra });
  };
  await hello("hp-big", "Big", P.big.pid, 32); await hello("hp-small", "Small", P.small.pid, 33); await hello("hp-liar", "Liar", P.big.pid, 34);
  await hello("hp-busy", "Busy", P.busy.pid, 35); await hello("hp-paused", "Paused", P.paused.pid, 36); await hello("hp-boxed", "Boxed", P.boxed.pid, 37, { container: "docker:test" });
  await conns["hp-busy"].call("agent.update", { status: "working" });
  const restartsOf = (id) => got[id].filter((e) => e.ev === "restart");
  const asksOf = (id) => got[id].filter((e) => e.ev === "prompt" && e.data?.via === "upkeep");

  // 1. off
  await sleep(2000);
  ok("1 rssMB 0: Big isn't restarted", restartsOf("hp-big").length === 0);

  // 2. on
  policy(150);
  for (let i = 0; i < 40 && !restartsOf("hp-big").length; i++) await sleep(200);
  await sleep(1500);
  ok("2 rssMB 150: Big gets a restart", restartsOf("hp-big").length === 1, String(restartsOf("hp-big").length));
  ok("2 …without compacting (context kept)", restartsOf("hp-big")[0]?.data?.compact === false, JSON.stringify(restartsOf("hp-big")[0]?.data));
  ok("2 …and no handoff prompt", asksOf("hp-big").length === 0);
  for (const [id, why] of [["hp-small", "under the limit"], ["hp-liar", "a foreign pid"], ["hp-busy", "working"], ["hp-paused", "paused"], ["hp-boxed", "in a container"]])
    ok(`2 ${id.slice(3)} (${why}) is never restarted or asked`, restartsOf(id).length === 0 && asksOf(id).length === 0);
  let stream = ""; try { stream = fs.readFileSync(path.join(S, "activity", "D.jsonl"), "utf8"); } catch { /* none */ }
  ok("2 the Stream's upkeep line says why", /restarting Big on its same session: its pi uses \d+ MB of memory, over upkeep\.refresh\.rssMB 150 \(context kept, no handoff\)/.test(stream));

  // 3. the restart itself
  const rr = await conns["hp-big"].call("agent.restartReady", {}).catch((e) => ({ error: e.message }));
  ok("3 agent.restartReady is accepted", rr?.ok === true, JSON.stringify(rr));
  const beforeMb = rssMb(P.big.pid);
  P.big.kill("SIGTERM"); conns["hp-big"].close();
  const logged = () => { try { return fs.readFileSync(argvLog, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((x) => x.id === "hp-big"); } catch { return []; } };
  for (let i = 0; i < 100 && !logged().length; i++) await sleep(200);
  const argv = logged()[0]?.piArgv || [];
  ok("3 the daemon relaunches it on its SAME session (--session <its file>)", argv[argv.indexOf("--session") + 1] === sess["hp-big"], JSON.stringify(argv));
  const fresh = child("hp-big", 0);
  for (let i = 0; i < 30 && !rssMb(fresh.pid); i++) await sleep(100);
  fs.writeFileSync(clientsFile, JSON.stringify([{ address: "0xf00d", pid: fresh.pid, class: "kitty", title: "Big", workspace: { id: 32, name: "32" }, mapped: true }]));
  await hello("hp-big", "Big", fresh.pid, 32);
  const note = () => got["hp-big"].find((e) => e.ev === "note" && /restarted on its same session for memory/.test(e.data?.text || ""));
  for (let i = 0; i < 300 && !note(); i++) await sleep(100);
  const m = (note()?.data?.text || "").match(/RSS (\d+) \u2192 (\d+) MB/);
  ok("3 the restart completes: 🔄 note 'restarted on its same session for memory'", !!note(), JSON.stringify(got["hp-big"].map((e) => e.ev)));
  ok("3 RSS before -> after, lower", !!m && Number(m[1]) > 150 && Number(m[2]) < Number(m[1]), `${note()?.data?.text || ""} (before kill: ${beforeMb} MB)`);
  ok("3 no fresh-session welcome (it's not a refresh)", !got["hp-big"].some((e) => e.ev === "prompt" && /FRESH session/.test(e.data?.text || "")));

  // 4. one per cooldown: it grows again at once
  await sleep(3500); // the restart entry clears 3 s after the relaunch
  conns["hp-big"].close(); fresh.kill("SIGTERM");
  const regrown = child("hp-big", 260);
  for (let i = 0; i < 50 && rssMb(regrown.pid) < 240; i++) await sleep(100);
  await hello("hp-big", "Big", regrown.pid, 32);
  await sleep(3000);
  ok("4 over the limit again within the cooldown: no second restart", !restartsOf("hp-big").length, `${rssMb(regrown.pid)} MB, ${restartsOf("hp-big").length} restart(s)`);
  const st = await (await connect({ path: sock, onEvent: () => {} })).call("thoughts.upkeep", { room: "D", action: "status" }).catch((e) => ({ text: "ERR " + e.message }));
  ok("4 Thoughts' upkeep status still shows it over the limit", /Big: [^\n]*due \(pi \d+ MB\)/.test(st?.text || ""), (st?.text || "").slice(0, 300));
  // 6. a memory restart whose relaunch never comes back: its world's Thoughts is told (no silent success)
  const lost = child("hp-lost", 260); for (let i = 0; i < 50 && rssMb(lost.pid) < 240; i++) await sleep(100);
  await hello("hp-lost", "Lost", lost.pid, 39);
  for (let i = 0; i < 40 && !restartsOf("hp-lost").length; i++) await sleep(200);
  ok("6 Lost (over the limit) gets its memory restart", restartsOf("hp-lost").length === 1);
  await conns["hp-lost"].call("agent.restartReady", {}).catch(() => {});
  lost.kill("SIGTERM"); conns["hp-lost"].close(); // its pi ends; no new window ever comes
  let thread = ""; for (let i = 0; i < 90 && !/Lost's memory restart/.test(thread); i++) { await sleep(1000); try { thread = fs.readFileSync(path.join(S, "thoughts", "D.thread.jsonl"), "utf8"); } catch { /* none yet */ } }
  ok("6 the failed relaunch reaches Thoughts as a ⚠ upkeep alert", /Lost's memory restart \(asked by upkeep \(Thoughts-D, memory\)\) failed: the new window didn't come up in 60 s/.test(thread), thread.split("\n").filter((l) => /Lost/.test(l)).join(" | ").slice(0, 300));
  // 5. a remote world's agent (its room bound to a remote machine): never restarted from here
  policy(0);
  const far = child("hp-far", 260); for (let i = 0; i < 50 && rssMb(far.pid) < 240; i++) await sleep(100);
  await hello("hp-far", "Far", far.pid, 38);
  fs.mkdirSync(path.join(cfg, "hyprpi", "remote"), { recursive: true }); fs.writeFileSync(path.join(cfg, "hyprpi", "remote", "d.json"), "{}");
  await sleep(6000); // remote-world bindings are re-read every 5 s
  policy(150); await sleep(3000);
  const farRow = ((await (await connect({ path: sock, onEvent: () => {} })).call("list", {})).agents || []).find((a) => a.id === "hp-far");
  ok("5 Far is in world D, now bound to a remote machine", farRow?.room === "D", JSON.stringify(farRow?.room));
  ok("5 a remote world's agent over the limit is never restarted", restartsOf("hp-far").length === 0 && asksOf("hp-far").length === 0);
} catch (e) {
  ok("no exception", false, e.stack);
} finally {
  for (const k of kids) { try { k.kill("SIGTERM"); } catch { /* gone */ } }
  await sleep(300);
  if (fails) console.log("state:", S); else fs.rmSync(S, { recursive: true, force: true });
}
console.log(fails ? `${fails} FAILED` : "all ok");
process.exit(fails ? 1 : 0);
