#!/usr/bin/env node
// J722 (Angus nss7a: "a"): the daemon side of acked prompts. An isolated daemon (temp socket, state, config; no Hyprland; Thoughts'
// pi = /bin/cat) and fake agent windows that speak the protocol.
//   D1 agent.prompt (Angus's from a panel) to a window with prompt_acks: the prompt carries a prompt_id and is kept in
//      prompts-out.json until agent.delivered "p:<id>"
//   D2 not confirmed: re-sent with the same prompt_id when the agent reconnects and when it finishes a run
//   D3 confirmed: gone from prompts-out.json, no more re-sends
//   D4 never confirmed: after talkUndeliveredMs ONE ⚠ alert in its world's Thoughts thread (not one per sweep)
//   D5 a welcome (spawn_agent's first prompt) and an upkeep ask are tracked the same way
//   D6 a window without prompt_acks (an older extension) gets plain prompts, nothing kept
//   D4b an unconfirmed prompt to an idle, connected agent is re-sent by itself (every 2 min live)
//   D8 one unconfirmed for 7 days is dropped with a log line and a ⚠ alert (never silently)
//   D7 kept across a daemon restart
//   node test/run.mjs test/prompt-acks-daemon.mjs   (exit 0 = pass)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { requireSandbox } from "./guard/sandbox.mjs";
await requireSandbox(import.meta.url);
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
let fails = 0; const ok = (n, c, x = "") => { if (!c) fails++; console.log(`${c ? "ok  " : "FAIL"} ${n}${x ? ": " + x : ""}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const S = fs.mkdtempSync(path.join(os.tmpdir(), "j722d-")), cfg = path.join(S, "cfg"), sock = path.join(S, "d.sock");
fs.mkdirSync(path.join(cfg, "hyprpi"), { recursive: true });
fs.writeFileSync(path.join(cfg, "hyprpi", "config.json"), JSON.stringify({ roomToThoughts: false, pi: "/bin/cat", worldSize: 10, cwd: S, talkUndeliveredMs: 4000 }));
fs.writeFileSync(path.join(cfg, "hyprpi", "hyprpi.jsonc"), JSON.stringify({ auth: { enabled: false }, upkeep: { refresh: { enabled: false, rssMB: 0 }, autoReload: { enabled: false } } }));
const env = { ...process.env, HYPRPI_SOCKET: sock, HYPRPI_STATE: S, XDG_CONFIG_HOME: cfg, HYPRLAND_INSTANCE_SIGNATURE: "j722d-bogus", HYPRPI_NO_ENSURE: "1", HYPRPI_UPKEEP_MS: "3600000", HYPRPI_UNDELIVERED_SWEEP_MS: "500", HYPRPI_ORCH_LAUNCH: "/bin/true", HYPRPI_PROMPT_RESEND_MS: "3000" };
delete env.HYPRPI_AGENT_ID; delete env.HYPRPI_WORKSPACE;
let d = null;
const start = async () => { d = spawn(process.execPath, [path.join(ROOT, "bin/hyprpi"), "daemon"], { env, stdio: ["ignore", fs.openSync(path.join(S, "d.log"), "a"), "inherit"] }); for (let i = 0; i < 50 && !fs.existsSync(sock); i++) await sleep(200); await sleep(300); };
const stop = async () => { d.kill("SIGTERM"); for (let i = 0; i < 50 && d.exitCode === null && d.signalCode === null; i++) await sleep(100); try { fs.unlinkSync(sock); } catch { /* gone */ } };
const out = () => { try { return JSON.parse(fs.readFileSync(path.join(S, "prompts-out.json"), "utf8")); } catch { return {}; } };
const thread = () => { try { return fs.readFileSync(path.join(S, "thoughts", "D.thread.jsonl"), "utf8"); } catch { return ""; } };
try {
  await start();
  const { connect } = await import(path.join(ROOT, "lib/client.mjs"));
  const got = {}, conns = {};
  const hello = async (id, name, ws, acks = true) => { got[id] ||= []; if (conns[id]) { try { conns[id].close(); } catch { /* none */ } await sleep(400); } conns[id] = await connect({ path: sock, onEvent: (ev, data) => got[id].push({ ev, data }) }); await conns[id].call("agent.hello", { agent_id: id, pid: process.pid, name, want_workspace: ws, cwd: S, ...(acks ? { prompt_acks: true, acks: true, reply_acks: true } : {}) }); };
  const prompts = (id, re) => got[id].filter((e) => e.ev === "prompt" && (!re || re.test(e.data?.text || "")));
  const api = await connect({ path: sock, onEvent: () => {} });
  await hello("hp-new", "Newer", 32); await hello("hp-old", "Older", 33, false);

  // D1
  await api.call("agent.prompt", { agent: "Newer", text: "PANEL-PROMPT", via: "room-tui" });
  await sleep(200);
  const p1 = prompts("hp-new", /PANEL-PROMPT/)[0]?.data;
  ok("D1 the prompt carries a prompt_id", !!p1?.prompt_id, JSON.stringify(p1));
  ok("D1 it's kept until confirmed", !!out()[p1?.prompt_id] && out()[p1.prompt_id].aid === "hp-new");
  // D2 reconnect + finished run
  await hello("hp-new", "Newer", 32);
  for (let i = 0; i < 80 && prompts("hp-new", /PANEL-PROMPT/).filter((e) => e.data.prompt_id === p1.prompt_id).length < 2; i++) await sleep(250); // (an isolated daemon's hello can take seconds: its hyprctl look-ups time out)
  ok("D2 re-sent with the same prompt_id on reconnect", prompts("hp-new", /PANEL-PROMPT/).filter((e) => e.data.prompt_id === p1.prompt_id).length >= 2, JSON.stringify(got["hp-new"].map((e) => [e.ev, e.data?.prompt_id?.slice(0, 6)])) + " out " + JSON.stringify(out()));
  const n2 = prompts("hp-new", /PANEL-PROMPT/).length;
  await conns["hp-new"].call("agent.update", { status: "working" }); await conns["hp-new"].call("agent.update", { status: "idle" });
  for (let i = 0; i < 60 && prompts("hp-new", /PANEL-PROMPT/).length <= n2; i++) await sleep(250);
  ok("D2 … and when it finishes a run", prompts("hp-new", /PANEL-PROMPT/).length > n2);
  // D3
  await conns["hp-new"].call("agent.delivered", { id: `p:${p1.prompt_id}` }); await sleep(200);
  ok("D3 confirmed: gone from prompts-out.json", !out()[p1.prompt_id]);
  const n3 = prompts("hp-new", /PANEL-PROMPT/).length;
  await hello("hp-new", "Newer", 32); await sleep(12000); // past the reconnect re-send, however slow the hello
  ok("D3 … and not re-sent any more", prompts("hp-new", /PANEL-PROMPT/).length === n3);
  // D4 never confirmed
  await api.call("agent.prompt", { agent: "Newer", text: "NEVER-CONFIRMED", via: "room-tui" });
  for (let i = 0; i < 80 && !/NEVER-CONFIRMED/.test(thread()); i++) await sleep(250);
  await sleep(2000); // several more sweeps
  const alerts = (thread().match(/prompt to Newer hasn.t landed in its session[^\n]*NEVER-CONFIRMED/g) || []).length;
  ok("D4 one ⚠ alert in Thoughts-D's thread, not one per sweep", alerts === 1, `${alerts}: ${thread().slice(-600)} | out: ${JSON.stringify(Object.values(out()).map((x) => [x.aid, x.told, x.data?.text?.slice(0, 20)]))}`);
  // D4b (NssAnswersCheck B2) an unconfirmed prompt to a connected, idle agent is re-sent by itself (no reconnect, no run)
  const nNever = prompts("hp-new", /NEVER-CONFIRMED/).length;
  for (let i = 0; i < 40 && prompts("hp-new", /NEVER-CONFIRMED/).length <= nNever; i++) await sleep(250);
  ok("D4b re-sent by itself while unconfirmed (HYPRPI_PROMPT_RESEND_MS 3 s here; 2 min live)", prompts("hp-new", /NEVER-CONFIRMED/).length > nNever);
  // D5 welcome + upkeep ask
  const parent = await connect({ path: sock, onEvent: () => {} });
  await parent.call("agent.hello", { agent_id: "hp-par", pid: process.pid, name: "Parent", want_workspace: 34, cwd: S });
  const sp = await parent.call("orch.spawn", { prompt: "WELCOME-BRIEF: do x; report_to_parent", name: "Kid" });
  await hello(sp.id, "Kid", 35);
  for (let i = 0; i < 40 && !prompts(sp.id, /WELCOME-BRIEF/).length; i++) await sleep(150);
  const w = prompts(sp.id, /WELCOME-BRIEF/)[0]?.data;
  ok("D5 a spawn_agent welcome is tracked (prompt_id, kept)", !!w?.prompt_id && !!out()[w.prompt_id], JSON.stringify(w || {}).slice(0, 200));
  const up = await api.call("thoughts.upkeep", { room: "D", action: "now", agent: "Kid" }).catch((e) => ({ error: e.message }));
  await sleep(300);
  const u = prompts(sp.id, /hyprpi upkeep/)[0]?.data;
  ok("D5 an upkeep ask is tracked too", !!u?.prompt_id && !!out()[u.prompt_id], JSON.stringify(up).slice(0, 200));
  // D6 older window
  await api.call("agent.prompt", { agent: "Older", text: "OLD-WINDOW", via: "room-tui" }); await sleep(200);
  const o = prompts("hp-old", /OLD-WINDOW/)[0]?.data;
  ok("D6 a window without prompt_acks gets a plain prompt, nothing kept", !!o && !o.prompt_id && !Object.values(out()).some((x) => x.aid === "hp-old"));
  // D8 (NssAnswersCheck B3) one never confirmed for 7 days is dropped WITH a log line and a ⚠ alert, not silently
  for (const c of [...Object.values(conns), api, parent]) { try { c.close(); } catch { /* gone */ } }
  await stop();
  const o8 = out(); o8["old-8d"] = { aid: "hp-new", data: { text: "EIGHT-DAYS-OLD", via: "room-tui", prompt_id: "old-8d" }, firstAt: Date.now() - 8 * 864e5, sentAt: Date.now() - 8 * 864e5, told: true };
  fs.writeFileSync(path.join(S, "prompts-out.json"), JSON.stringify(o8));
  await start();
  for (let i = 0; i < 40 && !/EIGHT-DAYS-OLD/.test(thread()); i++) await sleep(250);
  ok("D8 a 7-day-old unconfirmed prompt is dropped with a ⚠ alert", !out()["old-8d"] && /never confirmed in 7 days and is dropped: \\"EIGHT-DAYS-OLD/.test(thread()));
  // D7 restart
  const keep = Object.keys(out()).length;
  await stop(); await start();
  ok("D7 unconfirmed prompts survive a daemon restart", keep > 0 && Object.keys(out()).length === keep, `${keep} -> ${Object.keys(out()).length}`);
  got[sp.id] = []; await hello(sp.id, "Kid", 35);
  for (let i = 0; i < 80 && !prompts(sp.id, /WELCOME-BRIEF/).some((e) => e.data.prompt_id === w.prompt_id); i++) await sleep(250);
  ok("D7 … and are re-sent when the agent reconnects", prompts(sp.id, /WELCOME-BRIEF/).some((e) => e.data.prompt_id === w.prompt_id));
} catch (e) { ok("no exception", false, e.stack); }
finally { try { d?.kill("SIGTERM"); } catch { /* gone */ } await sleep(300); if (fails) console.log("state:", S); else fs.rmSync(S, { recursive: true, force: true }); }
console.log(fails ? `prompt-acks-daemon: ${fails} FAILED` : "prompt-acks-daemon: all pass");
process.exit(fails ? 1 : 0);
