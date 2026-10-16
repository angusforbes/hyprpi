#!/usr/bin/env node
// J722 (Angus nss7a: "a"): the agent side (pi-extension/index.ts) confirms the daemon's PROMPTS (prompt_id -> agent.delivered "p:<id>"). The extension runs with stub pi
// packages and a stub pi; the "daemon" is a stand-in socket server in a temp folder (never the live daemon, no windows).
//  P1 hello says prompt_acks: true
//  P2 a tracked prompt to an idle agent goes to pi once and is confirmed when its user message lands ("p:<id>")
//  P3 a re-send of it is only confirmed again, never run twice
//  P4 a tracked prompt to a busy agent is held, starts when the turn ends, and is confirmed when it lands; a re-send while held isn't doubled
//  P5 an /ignore line or a phone slash command (handled without a session message) is confirmed at once
//  P6 a prompt pi refused (no turn began in 5 s) is taken again when the daemon re-sends it
//  P8 a held prompt released to pi but not landed yet: a re-send isn't run twice
//  P7 an untracked prompt (an older daemon: no prompt_id) still works and sends no receipt
//   node test/run.mjs test/prompt-acks-ext.mjs   (exit 0 = pass)
import fs from "node:fs"; import os from "node:os"; import path from "node:path"; import net from "node:net";
import { requireSandbox } from "./guard/sandbox.mjs";
await requireSandbox(import.meta.url);
let fails = 0; const ok = (n, c, x = "") => { if (!c) fails++; console.log(`${c ? "ok  " : "FAIL"} ${n}${x && !c ? ": " + x : ""}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (f, ms = 5000) => { const end = Date.now() + ms; while (Date.now() < end) { const v = f(); if (v) return v; await sleep(25); } return null; };
const T = fs.mkdtempSync(path.join(os.tmpdir(), "j722e-"));
process.env.HOME = path.join(T, "home"); fs.mkdirSync(process.env.HOME);
process.env.XDG_CONFIG_HOME = path.join(T, "cfg"); process.env.XDG_STATE_HOME = path.join(T, "state"); process.env.XDG_RUNTIME_DIR = path.join(T, "run");
fs.mkdirSync(process.env.XDG_RUNTIME_DIR);
const SOCK = path.join(T, "d.sock");
process.env.HYPRPI_SOCKET = SOCK; process.env.HYPRPI_NO_ENSURE = "1"; process.env.HYPRPI_AGENT_ID = "hp-j722ext";
delete process.env.HYPRPI_WORKSPACE; delete process.env.HYPRLAND_INSTANCE_SIGNATURE;

// ---- the stand-in daemon: answers hello and everything else; records calls; pushes events; `answers` scripts method results
const calls = [], answers = {}; let client = null;
const server = net.createServer((s) => {
  client = s; let buf = "";
  s.on("data", (d) => { buf += d; let i; while ((i = buf.indexOf("\n")) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); if (!l.trim()) continue;
    const m = JSON.parse(l); calls.push(m);
    const r = m.method === "agent.hello" ? { agent_id: "hp-j722ext", room: "A", name: "Ext" } : answers[m.method] ? answers[m.method](m.params) : { ok: true };
    s.write(JSON.stringify({ id: m.id, result: r }) + "\n"); } });
  s.on("error", () => {});
});
await new Promise((r) => server.listen(SOCK, r));
const push = (event, data) => client.write(JSON.stringify({ event, data }) + "\n");
const acks = () => calls.filter((c) => c.method === "agent.delivered").map((c) => c.params.id);

// ---- stub pi packages + a stub pi that behaves like pi 1.0.2: sendMessage puts a custom message in the session (message_end)
const STUB = "data:text/javascript," + encodeURIComponent("export class UserMessageComponent{}; export const getMarkdownTheme=()=>({}); export const VERSION='1.0.2'; export class InteractiveMode{}; export class Box{}; export class Text{}; export class Container{}; export const truncateToWidth=(s)=>s; export const Type=new Proxy({}, {get:()=>()=>({})}); export default {};");
const { register } = await import("node:module");
register("data:text/javascript," + encodeURIComponent(`export async function resolve(s, c, n) { if (s === "@earendil-works/pi-coding-agent" || s === "@earendil-works/pi-tui" || s === "typebox") return { url: ${JSON.stringify(STUB)}, shortCircuit: true }; return n(s, c); }`));
const handlers = {}, tools = {}, sent = [], userSent = [];
let idleNow = true, refuse = false, landDelay = 10;
const emit = async (ev, e = {}) => { for (const h of handlers[ev] || []) { try { await h(e, ctx); } catch { /* a handler's own trouble */ } } };
const ctx = { mode: "rpc", isIdle: () => idleNow, cwd: T, model: { id: "stub" }, ui: { notify: () => {}, setStatus: () => {}, setFooter: () => {}, setTitle: () => {} }, sessionManager: { getSessionFile: () => "" }, abort: () => {} };
const pi = new Proxy({}, { get: (_, k) => {
  if (k === "on") return (ev, h) => { (handlers[ev] ||= []).push(h); };
  if (k === "registerTool") return (t) => { tools[t.name] = t; };
  if (k === "events") return { on: () => {}, emit: () => {} };
  if (k === "sendMessage") return (m, o) => { // a turn-starting message runs a short turn (agent_start … agent_settled); others just land
    sent.push({ m, o });
    const turn = o?.triggerTurn && !o?.deliverAs && idleNow;
    if (turn) idleNow = false;
    setTimeout(async () => { if (turn) await emit("agent_start", {}); await emit("message_end", { message: { role: "custom", ...m } }); if (turn) setTimeout(() => { idleNow = true; emit("agent_settled", {}); }, 40); }, landDelay);
  };
  if (k === "sendUserMessage") return (t) => { userSent.push(t); if (refuse) return; setTimeout(async () => { idleNow = false; await emit("agent_start", {}); await emit("message_end", { message: { role: "user", content: [{ type: "text", text: t }] } }); setTimeout(() => { idleNow = true; emit("agent_settled", {}); }, 40); }, 60); }; // pi starts the turn a moment later; `refuse`: pi refuses it (no turn)
  if (k === "getThinkingLevel" || k === "getSessionName") return () => "";
  return () => {};
} });
const ext = await import("../pi-extension/index.ts");
ext.default(pi);
await emit("session_start", {});
ok("P1 hello says prompt_acks: true", !!(await waitFor(() => calls.find((c) => c.method === "agent.hello" && c.params.prompt_acks === true))));

try {
  // P2
  push("prompt", { text: "PROMPT-ONE", via: "room-tui", prompt_id: "x1" });
  await waitFor(() => acks().includes("p:x1"), 3000);
  ok("P2 the tracked prompt goes to pi once", userSent.filter((t) => /PROMPT-ONE/.test(t)).length === 1, JSON.stringify(userSent));
  ok("P2 … and is confirmed when its user message lands", acks().includes("p:x1"), JSON.stringify(acks()));
  // P3
  await waitFor(() => idleNow, 2000); await sleep(100);
  const n1 = acks().filter((a) => a === "p:x1").length;
  push("prompt", { text: "PROMPT-ONE", via: "room-tui", prompt_id: "x1" });
  await sleep(300);
  ok("P3 a re-send isn't run again", userSent.filter((t) => /PROMPT-ONE/.test(t)).length === 1 && !sent.some((s) => /PROMPT-ONE/.test(s.m.content)));
  ok("P3 … it's confirmed again", acks().filter((a) => a === "p:x1").length > n1);
  // P4 busy
  idleNow = false; await emit("agent_start", {});
  push("prompt", { text: "PROMPT-BUSY", via: "upkeep", prompt_id: "x2" });
  await sleep(150);
  push("prompt", { text: "PROMPT-BUSY", via: "upkeep", prompt_id: "x2" }); // re-sent while held
  await sleep(150);
  ok("P4 held while busy: not confirmed yet", !acks().includes("p:x2"));
  idleNow = true; await emit("agent_settled", {});
  await waitFor(() => acks().includes("p:x2"), 3000);
  ok("P4 it starts when the turn ends and is confirmed when it lands", acks().includes("p:x2") && sent.some((s) => /PROMPT-BUSY/.test(s.m.content) && s.m.details?.delivery_id === "p:x2"));
  ok("P4 the re-send while held wasn't doubled", sent.filter((s) => /PROMPT-BUSY/.test(s.m.content)).length === 1);
  // P5
  await waitFor(() => idleNow, 2000); await sleep(100);
  push("prompt", { text: "/ignore just a note", via: "phone", prompt_id: "x3" });
  await sleep(300);
  ok("P5 an /ignore line (no session message) is confirmed at once", acks().includes("p:x3"));
  // P6 pi refuses
  await waitFor(() => idleNow, 2000); await sleep(100);
  refuse = true; userSent.length = 0;
  push("prompt", { text: "PROMPT-REFUSED", via: "room-tui", prompt_id: "x4" });
  await sleep(300);
  ok("P6 handed to pi, not confirmed", userSent.length === 1 && !acks().includes("p:x4"));
  await sleep(5200); refuse = false;
  push("prompt", { text: "PROMPT-REFUSED", via: "room-tui", prompt_id: "x4" }); // the daemon re-sends it (it was never confirmed)
  await waitFor(() => acks().includes("p:x4"), 3000);
  ok("P6 after no turn began, the re-send is taken again and confirmed", userSent.filter((t) => /PROMPT-REFUSED/.test(t)).length + sent.filter((s) => /PROMPT-REFUSED/.test(s.m.content)).length >= 2 && acks().includes("p:x4"), JSON.stringify({ userSent, acks: acks() }));
  // P8 (NssAnswersCheck) a held prompt that was just handed to pi (released, not landed yet) isn't run again by a re-send
  await waitFor(() => idleNow, 2000); await sleep(100);
  idleNow = false; await emit("agent_start", {});
  push("prompt", { text: "PROMPT-INFLIGHT", via: "upkeep", prompt_id: "x5" });
  await sleep(150);
  landDelay = 800; idleNow = true; await emit("agent_settled", {}); // released now; lands 800 ms later
  await sleep(100);
  push("prompt", { text: "PROMPT-INFLIGHT", via: "upkeep", prompt_id: "x5" }); // the daemon re-sends it meanwhile
  await sleep(1500); landDelay = 10;
  ok("P8 a re-send while it's handed to pi but not landed isn't run twice", sent.filter((s) => /PROMPT-INFLIGHT/.test(s.m.content)).length === 1 && acks().includes("p:x5"), String(sent.filter((s) => /PROMPT-INFLIGHT/.test(s.m.content)).length));
  // P7 untracked
  await waitFor(() => idleNow, 2000); await sleep(100);
  const before = acks().length;
  push("prompt", { text: "PROMPT-OLD-DAEMON", via: "room-tui" });
  await waitFor(() => userSent.some((t) => /PROMPT-OLD-DAEMON/.test(t)), 2000); await sleep(300);
  ok("P7 an untracked prompt still runs and sends no p: receipt", userSent.some((t) => /PROMPT-OLD-DAEMON/.test(t)) && !acks().slice(before).some((a) => a.startsWith("p:")));
} finally {
  try { client?.destroy(); } catch { /* gone */ }
  server.close(); await emit("session_shutdown", {});
  fs.rmSync(T, { recursive: true, force: true });
}
console.log(fails ? `prompt-acks-ext: ${fails} FAILED` : "prompt-acks-ext: all pass");
process.exit(fails ? 1 : 0);
