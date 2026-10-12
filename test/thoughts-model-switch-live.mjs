#!/usr/bin/env node
// J492 W3, live (runs real models, a few cents): an isolated daemon (temp socket + state + config, no Hyprland) whose
// Thoughts-A runs real pi. Thoughts is asked for the first line of its world tool on model A; config.json's
// thoughtsModel is changed to model B; Thoughts is restarted (thoughts.restart, as upkeep / a reload does) and asked
// again: the first line must now name model B, and the old session must sit in thoughts/archive/ with a handoff.
//   node test/thoughts-model-switch-live.mjs [modelA] [modelB]   (exit 0 = pass)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const A = process.argv[2] || "anthropic/claude-haiku-4-5", B = process.argv[3] || "anthropic/claude-sonnet-4-6";
let fails = 0; const ok = (n, c, x = "") => { if (!c) fails++; console.log(`${c ? "ok  " : "FAIL"} ${n}${x ? ": " + x : ""}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const S = fs.mkdtempSync(path.join(os.tmpdir(), "j492-live-")), cfgDir = path.join(S, "cfg"), sock = path.join(S, "d.sock");
fs.mkdirSync(path.join(cfgDir, "hyprpi"), { recursive: true });
const CONF = path.join(cfgDir, "hyprpi", "config.json");
const writeConf = (m) => fs.writeFileSync(CONF, JSON.stringify({ roomToThoughts: false, worldSize: 10, thoughtsModel: m }));
writeConf(A);
fs.writeFileSync(path.join(cfgDir, "hyprpi", "hyprpi.jsonc"), JSON.stringify({ upkeep: { refresh: { enabled: false }, autoReload: { enabled: false } } }));
const env = { ...process.env, HYPRPI_SOCKET: sock, HYPRPI_STATE: S, XDG_CONFIG_HOME: cfgDir, HYPRLAND_INSTANCE_SIGNATURE: "j492-bogus", HYPRPI_NO_ENSURE: "1", HYPRPI_UPKEEP_MS: "3600000", HYPRPI_TEST: "1" };
delete env.HYPRPI_AGENT_ID; delete env.HYPRPI_WORKSPACE;
// pi's own config (auth, models) stays the real one: only hyprpi's is scratch
const d = spawn(process.execPath, [path.join(ROOT, "bin/hyprpi"), "daemon"], { env, stdio: ["ignore", fs.openSync(path.join(S, "d.log"), "w"), "inherit"] });
const ask = "Call your world tool once and reply with ONLY its first line, verbatim.";
try {
  for (let i = 0; i < 50 && !fs.existsSync(sock); i++) await sleep(200);
  const { connect } = await import(path.join(ROOT, "lib/client.mjs"));
  const api = await connect({ path: sock, onEvent: () => {} });
  const agent = await connect({ path: sock, onEvent: () => {} }); // a world is "known" once it has an agent
  await agent.call("agent.hello", { agent_id: "hp-j492", pid: process.pid, name: "Probe", want_workspace: 2, cwd: S });
  const answer = async (since) => {
    for (let i = 0; i < 240; i++) {
      await sleep(1000);
      const g = await api.call("thoughts.get", { room: "A", limit: 50 });
      const t = g.entries.filter((e) => e.role === "thoughts" && e.ts > since).at(-1);
      if (t && !g.busy) return t.text;
    }
    return "";
  };
  let t0 = Date.now(); await api.call("thoughts.send", { room: "A", text: ask });
  const a1 = await answer(t0); console.log("model A answer:", a1);
  ok(`W3 first line names ${A}`, a1.includes(A.split("/").pop()));
  writeConf(B);
  await api.call("thoughts.restart", { room: "A" }); await sleep(4000);
  t0 = Date.now(); await api.call("thoughts.send", { room: "A", text: ask });
  const a2 = await answer(t0); console.log("model B answer:", a2);
  ok(`W3 after the config change the first line names ${B}`, a2.includes(B.split("/").pop()) && !a2.includes(A.split("/").pop()));
  const arch = path.join(S, "thoughts", "archive");
  const dirs = fs.existsSync(arch) ? fs.readdirSync(arch) : [];
  ok("W2 old session archived with a handoff", dirs.some((f) => f.endsWith(".md")) && dirs.some((f) => fs.statSync(path.join(arch, f)).isDirectory() && fs.readdirSync(path.join(arch, f)).some((x) => x.endsWith(".jsonl"))), dirs.join(", "));
  const g = await api.call("thoughts.get", { room: "A", limit: 50 });
  console.log("thread notes:", g.entries.filter((e) => e.role === "note").map((e) => e.text).join(" | "));
  api.close?.();
} finally { d.kill(); }
console.log(fails ? `${fails} FAILED (state ${S})` : `all passed (state ${S})`);
process.exit(fails ? 1 : 0);
