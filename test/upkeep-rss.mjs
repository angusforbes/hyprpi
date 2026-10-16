#!/usr/bin/env node
// J691 proof (Angus: "85MB x 20 agents is a lot of memory, lets do 1c"): upkeep also refreshes an idle agent whose
// pi process uses more memory (RSS) than upkeep.refresh.rssMB.
//   node test/run.mjs test/upkeep-rss.mjs   (exit 0 = pass; runs inside the test guard)
// An isolated daemon (temp socket + state, no Hyprland, Thoughts' pi = /bin/cat, upkeep pass every 300 ms) and three
// fake agents, each backed by a child process THIS test spawns with that agent's HYPRPI_AGENT_ID:
//   Big   - its child holds ~260 MB                       -> asked for a handoff once rssMB (150) is on
//   Small - its child is a plain idle node (~50 MB)        -> never asked
//   Liar  - says Big's child is its pid (wrong agent id)   -> never asked (the pid must really be the agent's)
// 1. rssMB 0 (off): nobody is asked, even Big.
// 2. rssMB 150: Big is asked (the reason names its MB and the setting), Small and Liar aren't; the world view and
//    thoughts.upkeep status show Big as due; the Stream's upkeep line says why.
// 3. Big writes its handoff and calls upkeep.ready, gets the restart, says agent.restartReady; its old "pi" exits and a
//    new one (a small child, same agent id) connects in a new "window" (a fake hyprctl lists it): the refresh completes
//    (the 🔄 note with RSS before -> after, lower), and the new session's first prompt is the handoff text naming the memory
//    reason. (The daemon's own `hyprpi new` is refused in an isolated daemon, J333, so no real window ever opens.)
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

const S = fs.mkdtempSync(path.join(os.tmpdir(), "j691-")), cfg = path.join(S, "cfg"), sock = path.join(S, "d.sock");
fs.mkdirSync(path.join(cfg, "hyprpi"), { recursive: true });
fs.writeFileSync(path.join(cfg, "hyprpi", "config.json"), JSON.stringify({ roomToThoughts: false, pi: "/bin/cat", worldSize: 10 }));
const policy = (rssMB) => fs.writeFileSync(path.join(cfg, "hyprpi", "hyprpi.jsonc"), JSON.stringify({ auth: { enabled: false }, upkeep: { refresh: { enabled: true, idleMinutes: 0, cooldownHours: 3, rssMB }, autoReload: { enabled: false } } }));
policy(0);

const kids = [];
const child = (id, holdMb) => {
  const env = { ...process.env, HYPRPI_AGENT_ID: id }; delete env.HYPRPI_WORKSPACE;
  const code = `const keep = []; for (let i = 0; i < ${holdMb}; i++) keep.push(Buffer.alloc(1 << 20, 1)); globalThis.k = keep; setInterval(() => {}, 1e6);`;
  const k = spawn(process.execPath, ["-e", code], { env, stdio: "ignore" }); kids.push(k); return k;
};
const big = child("hp-big", 260), small = child("hp-small", 0);

const fakeBin = path.join(S, "bin"), clientsFile = path.join(S, "clients.json"); fs.mkdirSync(fakeBin); fs.writeFileSync(clientsFile, "[]");
fs.writeFileSync(path.join(fakeBin, "hyprctl"), `#!/bin/sh\ncase "$*" in *clients*) cat "${clientsFile}";; *activewindow*|*activeworkspace*) echo '{}';; *) echo '[]';; esac\n`, { mode: 0o755 });
const env = { ...process.env, PATH: `${fakeBin}:${process.env.PATH}`, HYPRPI_SOCKET: sock, HYPRPI_STATE: S, XDG_CONFIG_HOME: cfg, HYPRLAND_INSTANCE_SIGNATURE: "j691-bogus", HYPRPI_NO_ENSURE: "1", HYPRPI_UPKEEP_MS: "300" };
delete env.HYPRPI_AGENT_ID; delete env.HYPRPI_WORKSPACE;
const d = spawn(process.execPath, [path.join(ROOT, "bin/hyprpi"), "daemon"], { env, stdio: ["ignore", fs.openSync(path.join(S, "d.log"), "w"), "inherit"] });
kids.push(d);
try {
  for (let i = 0; i < 50 && !fs.existsSync(sock); i++) await sleep(200);
  for (let i = 0; i < 50 && rssMb(big.pid) < 240; i++) await sleep(100);
  ok("setup: Big's child holds > 200 MB, Small's < 120 MB", rssMb(big.pid) > 200 && rssMb(small.pid) < 120, `${rssMb(big.pid)} / ${rssMb(small.pid)} MB`);
  const { connect } = await import(path.join(ROOT, "lib/client.mjs"));
  const api = await connect({ path: sock, onEvent: () => {} });
  const got = { "hp-big": [], "hp-small": [], "hp-liar": [] };
  const conns = {};
  const hello = async (id, name, pid, ws) => {
    conns[id] = await connect({ path: sock, onEvent: (ev, data) => got[id].push({ ev, data }) });
    await conns[id].call("agent.hello", { agent_id: id, pid, name, want_workspace: ws, cwd: S });
  };
  await hello("hp-big", "Big", big.pid, 32); await hello("hp-small", "Small", small.pid, 33); await hello("hp-liar", "Liar", big.pid, 34);
  const asks = (id) => got[id].filter((e) => e.ev === "prompt" && e.data?.via === "upkeep");

  // 1. off
  await sleep(2500);
  ok("1 rssMB 0: Big isn't asked", asks("hp-big").length === 0, JSON.stringify(asks("hp-big")).slice(0, 200));

  // 2. on
  policy(150);
  for (let i = 0; i < 40 && !asks("hp-big").length; i++) await sleep(200);
  const ask = asks("hp-big")[0]?.data?.text || "";
  ok("2 rssMB 150: Big is asked for a handoff", /handoff/.test(ask), ask.slice(0, 160));
  ok("2 the ask names its memory and the setting", /its pi uses \d+ MB of memory, over upkeep\.refresh\.rssMB 150/.test(ask), ask.slice(0, 200));
  await sleep(1500);
  ok("2 Big is asked once (it's waiting for the note)", asks("hp-big").length === 1, String(asks("hp-big").length));
  ok("2 Small (under the limit) isn't asked", asks("hp-small").length === 0);
  ok("2 Liar (pid isn't really its own) isn't asked", asks("hp-liar").length === 0);
  const list = await api.call("list", {}).catch(() => null), row = (id) => (list?.agents || []).find((a) => a.id === id);
  ok("2 list shows Big refresh_due, Small and Liar not", row("hp-big")?.refresh_due === true && row("hp-small")?.refresh_due === false && row("hp-liar")?.refresh_due === false, JSON.stringify([row("hp-big")?.refresh_due, row("hp-small")?.refresh_due, row("hp-liar")?.refresh_due]));
  const status = await api.call("thoughts.upkeep", { room: "D", action: "status" }).catch((e) => ({ text: "ERR " + e.message }));
  ok("2 thoughts.upkeep status shows Big due with its MB", /Big: [^\n]*due \(pi \d+ MB\)/.test(status?.text || ""), (status?.text || "").slice(0, 300));

  // 3. the refresh itself
  const file = ask.match(/to (\S+\.md):/)?.[1] || "";
  ok("3 the ask gives a handoff path", !!file, file);
  fs.writeFileSync(file, "# handoff\nI'm Big; nothing open; this note is long enough to count.\n");
  const r = await conns["hp-big"].call("upkeep.ready", { file }).catch((e) => ({ error: e.message }));
  ok("3 upkeep.ready starts the refresh", r?.refreshing === true, JSON.stringify(r));
  for (let i = 0; i < 20 && !got["hp-big"].some((e) => e.ev === "restart"); i++) await sleep(100);
  ok("3 Big gets the restart onto a fresh session", got["hp-big"].some((e) => e.ev === "restart"));
  const rr = await conns["hp-big"].call("agent.restartReady", {}).catch((e) => ({ error: e.message }));
  ok("3 agent.restartReady is accepted", rr?.ok === true, JSON.stringify(rr));
  const beforeMb = rssMb(big.pid);
  big.kill("SIGTERM"); conns["hp-big"].close?.(); // its old pi exits and its connection drops
  for (let i = 0; i < 40 && rssMb(big.pid); i++) await sleep(100);
  await sleep(1500); // the daemon sees the old connection gone and readies the welcome before the new window connects
  const fresh = child("hp-big", 0);
  for (let i = 0; i < 30 && !rssMb(fresh.pid); i++) await sleep(100);
  fs.writeFileSync(clientsFile, JSON.stringify([{ address: "0xf00d", pid: fresh.pid, class: "kitty", title: "Big", workspace: { id: 32, name: "32" }, mapped: true }]));
  got["hp-big"] = [];
  await hello("hp-big", "Big", fresh.pid, 32);
  const note = () => got["hp-big"].find((e) => e.ev === "note" && /refreshed on a fresh session/.test(e.data?.text || ""));
  for (let i = 0; i < 300 && !note(); i++) await sleep(100);
  const m = (note()?.data?.text || "").match(/RSS (\d+) \u2192 (\d+) MB/);
  ok("3 the refresh completes (the new window's 🔄 note)", !!note(), JSON.stringify(got["hp-big"].map((e) => e.ev)));
  ok("3 its RSS went down (old pi -> fresh pi)", !!m && Number(m[1]) > 150 && Number(m[2]) < Number(m[1]), `${note()?.data?.text || ""} (before kill: ${beforeMb} MB)`);
  const welcome = () => got["hp-big"].find((e) => e.ev === "prompt" && /You're on a FRESH session/.test(e.data?.text || ""));
  for (let i = 0; i < 60 && !welcome(); i++) await sleep(100);
  ok("3 the fresh session starts from its handoff, naming the memory reason", /your previous one \(its pi uses \d+ MB of memory, over upkeep\.refresh\.rssMB 150\) was refreshed/.test(welcome()?.data?.text || "") && /I'm Big; nothing open/.test(welcome()?.data?.text || ""), (welcome()?.data?.text || "").slice(0, 200));
  let stream = ""; try { stream = fs.readFileSync(path.join(S, "activity", "D.jsonl"), "utf8"); } catch { /* none */ }
  ok("3 the Stream's upkeep line names the memory reason", /asked Big for a handoff \(its pi uses \d+ MB of memory/.test(stream));
} catch (e) {
  ok("no exception", false, e.stack);
} finally {
  for (const k of kids) { try { k.kill("SIGTERM"); } catch { /* gone */ } }
  await sleep(300);
  if (fails) console.log("daemon log:", path.join(S, "d.log"));
  else fs.rmSync(S, { recursive: true, force: true });
}
console.log(fails ? `${fails} FAILED` : "all ok");
process.exit(fails ? 1 : 0);
