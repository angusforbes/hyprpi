#!/usr/bin/env node
// J648 (Angus: "why do you keep hanging?"): on world H, Thoughts-H asked omni-alpha (ask_agent); omni-alpha's talk_reply arrived
// while Thoughts-H was busy (queued in pi as a follow-up) and showed "Reply delivered"; then a stop (Esc / ⏹ in the Thoughts panel)
// cleared pi's queue, the reply with it, and Thoughts-H waited for it forever. An isolated daemon of a REMOTE world (state
// <tmp>/.hyprpi-h/state, as on the box) with a stand-in RPC pi for Thoughts that stays busy until aborted and answers clear_queue:
//  1. a local agent's talk_reply to Thoughts-H is delivered locally (thread + the pi), reported delivered, never sent to the link
//  2. a stop while the reply waits in pi's queue: the reply is given to Thoughts again once the stop has settled
//  3. Angus's own queued typing is still dropped by a stop (as before); an agent-to-agent reply on the box is delivered locally
//   node test/run.mjs thoughts-stop-keeps-replies   (exit 0 = pass)
import fs from "node:fs"; import os from "node:os"; import path from "node:path"; import { spawn } from "node:child_process";
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
let fails = 0; const ok = (n, c, x = "") => { if (!c) fails++; console.log(`${c ? "ok  " : "FAIL"} ${n}${x && !c ? ": " + x : ""}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (f, ms = 8000) => { const end = Date.now() + ms; while (Date.now() < end) { try { const v = await f(); if (v) return v; } catch { /* not yet */ } await sleep(100); } return null; };
const T = fs.mkdtempSync(path.join(os.tmpdir(), "j648-")), F = (n) => path.join(T, n);
const S = path.join(T, ".hyprpi-h", "state"), cfg = F("cfg"), sock = F("d.sock"), LOG = F("pi.log");
fs.mkdirSync(S, { recursive: true }); fs.mkdirSync(path.join(cfg, "hyprpi"), { recursive: true });
// the stand-in pi (RPC): a prompt starts a turn that runs until aborted; while busy, prompts queue (followUp); clear_queue returns
// and empties the queue; abort ends the turn (agent_end, agent_settled); when a turn ends with a queue, the next one starts
fs.writeFileSync(F("fake-pi.mjs"), `import fs from "node:fs";
const log = (o) => fs.appendFileSync(${JSON.stringify(LOG)}, JSON.stringify(o) + "\\n");
const out = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
let busy = false; const queue = [];
const startTurn = (m) => { busy = true; log({ turn: m }); out({ type: "agent_start" }); };
let buf = "";
process.stdin.on("data", (d) => { buf += d; let i; while ((i = buf.indexOf("\\n")) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); if (!l.trim()) continue;
  let c; try { c = JSON.parse(l); } catch { continue; }
  if (c.type === "prompt") { if (busy) { queue.push(c.message); log({ queued: c.message }); } else startTurn(c.message); if (c.id) out({ type: "response", id: c.id, command: "prompt", success: true }); }
  else if (c.type === "clear_queue") { const q = queue.splice(0); log({ cleared: q }); out({ type: "response", id: c.id, command: "clear_queue", success: true, data: { steering: [], followUp: q } }); }
  else if (c.type === "abort") { busy = false; out({ type: "agent_end" }); setTimeout(() => { out({ type: "agent_settled" }); if (queue.length) startTurn(queue.shift()); }, 200); }
  else if (c.id) out({ type: "response", id: c.id, command: c.type, success: true, data: {} });
} });
process.stdin.on("end", () => process.exit(0));
`);
fs.writeFileSync(F("pi"), `#!/bin/sh\nexec ${process.execPath} ${F("fake-pi.mjs")} "$@"\n`, { mode: 0o755 });
fs.writeFileSync(path.join(cfg, "hyprpi", "config.json"), JSON.stringify({ roomToThoughts: false, pi: F("pi"), worldSize: 10 }));
fs.writeFileSync(path.join(cfg, "hyprpi", "hyprpi.jsonc"), JSON.stringify({ auth: { enabled: false }, upkeep: { refresh: { enabled: false }, autoReload: { enabled: false } } }));
const env = { ...process.env, HYPRPI_SOCKET: sock, HYPRPI_STATE: S, XDG_CONFIG_HOME: cfg, HYPRPI_NO_ENSURE: "1", HYPRPI_UPKEEP_MS: "3600000", HYPRPI_NOTIFY_TEST: "1", HYPRPI_MODELCHECK: "0" };
for (const k of ["HYPRPI_AGENT_ID", "HYPRLAND_INSTANCE_SIGNATURE", "WAYLAND_DISPLAY", "HYPRPI_REMOTE_HOME", "HYPRPI_REMOTE_LINK"]) delete env[k];
const d = spawn(process.execPath, [path.join(ROOT, "bin/hyprpi"), "daemon"], { env, stdio: ["ignore", "ignore", fs.openSync(F("d.err"), "a")] });
const { connect } = await import(path.join(ROOT, "lib/client.mjs"));
const pilog = () => { try { return fs.readFileSync(LOG, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
const thread = async (c) => ((await c.call("thoughts.get", { room: "H" })).entries || []);
try {
  for (let i = 0; i < 60 && !fs.existsSync(sock); i++) await sleep(200);
  const api = await connect({ path: sock });
  const got = []; const ag = await connect({ path: sock, onEvent: (ev, data) => got.push({ ev, data }) });
  await ag.call("agent.hello", { agent_id: "h-omni-alpha", pid: process.pid, name: "omni-alpha", want_workspace: 71, cwd: T });
  await ag.call("agent.update", { status: "idle" }).catch(() => {});
  // Angus asks Thoughts-H something: its turn starts and stays busy
  await api.call("thoughts.send", { room: "H", text: "where did we get the token from?" });
  ok("setup: Thoughts-H's turn is running", !!(await waitFor(() => pilog().some((x) => /where did we get the token/.test(x.turn || "")), 8000)));
  // Thoughts-H asks omni-alpha (ask_agent); omni-alpha answers with talk_reply while Thoughts-H is still busy
  const ask = await api.call("thoughts.ask", { room: "H", agent: "omni-alpha", question: "send the Slack comparison" });
  const m = await waitFor(() => got.find((g) => g.ev === "talk" && /send the Slack comparison/.test(g.data?.text || "")), 8000);
  ok("setup: the ask reached omni-alpha (on the box)", !!m && /omni-alpha/.test(ask.agent || ""), JSON.stringify(ask));
  const r = await ag.call("talk.reply", { request_id: m?.data?.request_id, text: "SLACK COMPARISON: the full answer" });
  ok("1 the reply is reported delivered, locally (not over a link)", r.delivered === true && !r.via, JSON.stringify(r));
  ok("1 … it is in Thoughts-H's thread and queued in its pi (it was busy)", (await thread(api)).some((e) => e.role === "reply" && /SLACK COMPARISON/.test(e.text || "")) && !!(await waitFor(() => pilog().some((x) => /SLACK COMPARISON/.test(x.queued || "")), 5000)));
  // Angus queues a message of his own too, then presses stop (⏹ / Esc in the Thoughts panel)
  await api.call("thoughts.send", { room: "H", text: "hi" });
  await waitFor(() => pilog().some((x) => x.queued === "hi" || /\bhi\b/.test(x.queued || "")), 3000);
  await api.call("thoughts.interrupt", { room: "H" });
  ok("2 the stop cleared pi's queue (with the reply in it)", !!(await waitFor(() => pilog().some((x) => Array.isArray(x.cleared) && x.cleared.some((c) => /SLACK COMPARISON/.test(c))), 5000)));
  const again = await waitFor(() => pilog().filter((x) => /\[reply from omni-alpha\][\s\S]*SLACK COMPARISON/.test(x.turn || "")).length >= 1, 8000);
  ok("2 once the stop has settled, the reply is given to Thoughts-H again (never lost)", !!again, JSON.stringify(pilog().slice(-6)));
  ok("3 Angus's own queued 'hi' is not re-sent by the stop (as before)", !pilog().some((x) => x.turn === "hi"));
  // an agent-to-agent demand on the box: delivered locally
  const g2 = []; const b = await connect({ path: sock, onEvent: (ev, data) => g2.push({ ev, data }) });
  await b.call("agent.hello", { agent_id: "h-mailwise", pid: process.pid, name: "Mailwise", want_workspace: 72, cwd: T });
  const t = await b.call("talk", { to: ["omni-alpha"], text: "ping", mode: "demand" });
  const pm = await waitFor(() => got.find((g) => g.ev === "talk" && g.data?.text === "ping"), 5000);
  const r2 = pm ? await ag.call("talk.reply", { request_id: pm.data.request_id, text: "pong" }) : {};
  ok("3 an agent's talk_reply to another agent on the box arrives, reported delivered", r2.delivered === true && !!(await waitFor(() => g2.find((g) => g.ev === "talk.reply" && g.data?.text === "pong"), 5000)), JSON.stringify([t, r2]));
  api.close(); ag.close(); b.close();
} finally {
  d.kill(); await sleep(400);
  if (fails && process.env.KEEP) console.log("kept " + T); else fs.rmSync(T, { recursive: true, force: true });
}
console.log(fails ? `thoughts-stop-keeps-replies: ${fails} FAILED` : "thoughts-stop-keeps-replies: all pass"); process.exit(fails ? 1 : 0);
