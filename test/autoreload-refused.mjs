#!/usr/bin/env node
// J715 (ReloadCheck, no-silent-success): an auto-reload ask that can't be sent is never reported as done, and its world's Thoughts
// gets ONE ⚠ alert per code version, not one per pass. The isolated daemon's sendAgent refuses "reload" (HYPRPI_TEST_DROP_RELOAD,
// honoured only in an isolated daemon).
//   node test/run.mjs test/autoreload-refused.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { requireSandbox } from "./guard/sandbox.mjs";
await requireSandbox(import.meta.url);
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
let fails = 0; const ok = (n, c, x = "") => { if (!c) fails++; console.log(`${c ? "ok  " : "FAIL"} ${n}${x ? ": " + x : ""}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const S = fs.mkdtempSync(path.join(os.tmpdir(), "j715r-")), cfg = path.join(S, "cfg"), sock = path.join(S, "d.sock"), agentDir = path.join(S, "pi-agent"), watched = path.join(S, "watched.txt");
fs.mkdirSync(path.join(cfg, "hyprpi"), { recursive: true }); fs.mkdirSync(path.join(agentDir, "skills"), { recursive: true }); fs.mkdirSync(path.join(agentDir, "extensions")); fs.writeFileSync(watched, "v1");
fs.writeFileSync(path.join(cfg, "hyprpi", "config.json"), JSON.stringify({ roomToThoughts: false, pi: "/bin/cat", worldSize: 10, cwd: S }));
fs.writeFileSync(path.join(cfg, "hyprpi", "hyprpi.jsonc"), JSON.stringify({ auth: { enabled: false }, upkeep: { refresh: { enabled: false, rssMB: 0 }, autoReload: { enabled: true, idleMinutes: 0, watch: [watched], minHours: 0, maxPerPass: 3 } } }));
const env = { ...process.env, HYPRPI_SOCKET: sock, HYPRPI_STATE: S, XDG_CONFIG_HOME: cfg, PI_CODING_AGENT_DIR: agentDir, HYPRLAND_INSTANCE_SIGNATURE: "j715r-bogus", HYPRPI_NO_ENSURE: "1", HYPRPI_UPKEEP_MS: "300", HYPRPI_TEST_DROP_RELOAD: "1" };
delete env.HYPRPI_AGENT_ID; delete env.HYPRPI_WORKSPACE;
const d = spawn(process.execPath, [path.join(ROOT, "bin/hyprpi"), "daemon"], { env, stdio: ["ignore", fs.openSync(path.join(S, "d.log"), "w"), "inherit"] });
try {
  for (let i = 0; i < 50 && !fs.existsSync(sock); i++) await sleep(200);
  const { connect } = await import(path.join(ROOT, "lib/client.mjs"));
  const got = [];
  const c = await connect({ path: sock, onEvent: (ev, data) => got.push({ ev, data }) });
  await c.call("agent.hello", { agent_id: "hp-refuse", pid: process.pid, name: "Refused", want_workspace: 32, cwd: S, code: "old000000000" });
  await sleep(3000); // ~10 passes
  const thread = () => { try { return fs.readFileSync(path.join(S, "thoughts", "D.thread.jsonl"), "utf8"); } catch { return ""; } };
  const n = (thread().match(/couldn't ask Refused to reload/g) || []).length;
  ok("the refused ask reaches Thoughts as ONE ⚠ alert over ~10 passes", n === 1, String(n));
  ok("no reload event reached the agent", !got.some((e) => e.ev === "reload"));
  let stream = ""; try { stream = fs.readdirSync(path.join(S, "activity")).map((f) => fs.readFileSync(path.join(S, "activity", f), "utf8")).join(""); } catch { /* none */ }
  ok("nothing claims it was asked or reloaded", !/asked Refused to reload|Refused reloaded onto/.test(stream + fs.readFileSync(path.join(S, "d.log"), "utf8")));
  fs.writeFileSync(watched, "v2-newer"); await sleep(2000);
  const n2 = (thread().match(/couldn't ask Refused to reload/g) || []).length;
  ok("a newer code version gets its own one alert", n2 === 2, String(n2));
} catch (e) { ok("no exception", false, e.stack); }
finally { try { d.kill("SIGTERM"); } catch { /* gone */ } await sleep(300); if (fails) console.log("state:", S); else fs.rmSync(S, { recursive: true, force: true }); }
console.log(fails ? `${fails} FAILED` : "all ok");
process.exit(fails ? 1 : 0);
