#!/usr/bin/env node
// J663 (no silent success, Angus's 38a): the agent side (pi-extension/index.ts) of agent messaging. The extension runs with stub pi
// packages and a stub pi; the "daemon" is a stand-in socket server in a temp folder (never the live daemon, no windows).
//  E1 two answers to ONE request (a talk to two agents, both reply): both reach the session, each confirmed with its own receipt
//     ("re:<request>:<replier>"); the second used to be taken for a re-send of the first and dropped without a trace
//  E2 demand: a re-sent answer isn't counted twice; the answers in the result are confirmed; a wait that ends without every
//     answer says a later answer still comes (the request stays open 12 h)
//  E3 talk_reply says only what is true: "sent … not confirmed", "kept … when it reconnects", "NOT delivered" when the asker has
//     closed or can't take it; never "Reply delivered."
//  E4 Angus's prompt (room panel) to an idle agent, twice in the same moment: the second is held for the next turn, not handed to
//     pi while the first is still starting (pi refused it then and it was gone)
//   node test/run.mjs test/msg-ext-replies.mjs   (exit 0 = pass)
import fs from "node:fs"; import os from "node:os"; import path from "node:path"; import net from "node:net";
import { requireSandbox } from "./guard/sandbox.mjs";
await requireSandbox(import.meta.url);
let fails = 0; const ok = (n, c, x = "") => { if (!c) fails++; console.log(`${c ? "ok  " : "FAIL"} ${n}${x && !c ? ": " + x : ""}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (f, ms = 5000) => { const end = Date.now() + ms; while (Date.now() < end) { const v = f(); if (v) return v; await sleep(25); } return null; };
const T = fs.mkdtempSync(path.join(os.tmpdir(), "j663e-"));
process.env.HOME = path.join(T, "home"); fs.mkdirSync(process.env.HOME);
process.env.XDG_CONFIG_HOME = path.join(T, "cfg"); process.env.XDG_STATE_HOME = path.join(T, "state"); process.env.XDG_RUNTIME_DIR = path.join(T, "run");
fs.mkdirSync(process.env.XDG_RUNTIME_DIR);
const SOCK = path.join(T, "d.sock");
process.env.HYPRPI_SOCKET = SOCK; process.env.HYPRPI_NO_ENSURE = "1"; process.env.HYPRPI_AGENT_ID = "hp-j663ext";
delete process.env.HYPRPI_WORKSPACE; delete process.env.HYPRLAND_INSTANCE_SIGNATURE;

// ---- the stand-in daemon: answers hello and everything else; records calls; pushes events; `answers` scripts method results
const calls = [], answers = {}; let client = null;
const server = net.createServer((s) => {
  client = s; let buf = "";
  s.on("data", (d) => { buf += d; let i; while ((i = buf.indexOf("\n")) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); if (!l.trim()) continue;
    const m = JSON.parse(l); calls.push(m);
    const r = m.method === "agent.hello" ? { agent_id: "hp-j663ext", room: "A", name: "Ext" } : answers[m.method] ? answers[m.method](m.params) : { ok: true };
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
let idleNow = true;
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
    setTimeout(async () => { if (turn) await emit("agent_start", {}); await emit("message_end", { message: { role: "custom", ...m } }); if (turn) setTimeout(() => { idleNow = true; emit("agent_settled", {}); }, 40); }, 10);
  };
  if (k === "sendUserMessage") return (t) => { userSent.push(t); setTimeout(() => { idleNow = false; emit("agent_start", {}); }, 60); }; // pi starts the turn a moment later
  if (k === "getThinkingLevel" || k === "getSessionName") return () => "";
  return () => {};
} });
const ext = await import("../pi-extension/index.ts");
ext.default(pi);
await emit("session_start", {});
ok("setup: the extension connected and said hello with reply receipts", !!(await waitFor(() => calls.find((c) => c.method === "agent.hello" && c.params.reply_acks === true))));

try {
  // ---- E1: two answers to one request
  push("talk.reply", { request_id: "rq1", mode: "talk", from: { id: "hp-a", name: "Alpha" }, text: "ALPHA-ANSWER", remaining: 1 });
  await sleep(120);
  push("talk.reply", { request_id: "rq1", mode: "talk", from: { id: "hp-b", name: "Beta" }, text: "BETA-ANSWER", remaining: 0 });
  await sleep(300);
  const got = sent.filter((s) => s.m.customType === "hyprpi-talk-reply").map((s) => s.m.content);
  ok("E1 the first answer reaches the session", got.some((c) => /ALPHA-ANSWER/.test(c)));
  ok("E1 the SECOND answer to the same request reaches it too (it was dropped)", got.some((c) => /BETA-ANSWER/.test(c)), JSON.stringify(got));
  ok("E1 each is confirmed with its own receipt", acks().includes("re:rq1:hp-a") && acks().includes("re:rq1:hp-b"), JSON.stringify(acks()));
  push("talk.reply", { request_id: "rq1", mode: "talk", from: { id: "hp-a", name: "Alpha" }, text: "ALPHA-ANSWER", remaining: 1 }); // the daemon re-sends one
  await sleep(200);
  ok("E1 a re-send of an answer that landed is confirmed again, not shown twice", sent.filter((s) => /ALPHA-ANSWER/.test(s.m.content)).length === 1 && acks().filter((a) => a === "re:rq1:hp-a").length >= 2);

  // ---- E2: demand
  answers.talk = (p) => ({ request_id: p.mode === "demand" ? (p.timeout_seconds === 1 ? "dq2" : "dq1") : "tq", delivered: ["Alpha", "Beta"], skipped: [] });
  const dem = tools.demand.execute("t1", { recipients: ["Alpha", "Beta"], message: "Q?" }, undefined);
  await sleep(100);
  push("talk.reply", { request_id: "dq1", mode: "demand", from: { id: "hp-a", name: "Alpha" }, text: "A1", remaining: 1 });
  push("talk.reply", { request_id: "dq1", mode: "demand", from: { id: "hp-a", name: "Alpha" }, text: "A1", remaining: 1 }); // re-sent (e.g. after a reconnect)
  await sleep(100);
  push("talk.reply", { request_id: "dq1", mode: "demand", from: { id: "hp-b", name: "Beta" }, text: "B1", remaining: 0 });
  const dr = await dem; const dt = dr.content.map((c) => c.text).join("");
  ok("E2 a re-sent answer isn't counted twice (2/2, Beta's answer waited for)", /^2\/2 answered/.test(dt) && (dt.match(/--- Alpha ---/g) || []).length === 1 && /--- Beta ---\nB1/.test(dt), dt);
  await sleep(100);
  ok("E2 the answers in the result are confirmed", acks().includes("re:dq1:hp-a") && acks().includes("re:dq1:hp-b"));
  const beforeReplay = sent.length;
  push("talk.reply", { request_id: "dq1", mode: "demand", from: { id: "hp-a", name: "Alpha" }, text: "A1", remaining: 1 });
  await sleep(200);
  ok("C completed demand receipt replay is not injected a second time", sent.length === beforeReplay, JSON.stringify(sent.slice(beforeReplay)));
  const dem2 = tools.demand.execute("t2", { recipients: ["Alpha", "Beta"], message: "Q2?", timeout_seconds: 1 }, undefined);
  await sleep(100); push("talk.reply", { request_id: "dq2", mode: "demand", from: { id: "hp-a", name: "Alpha" }, text: "A2", remaining: 1 });
  const dt2 = (await dem2).content.map((c) => c.text).join("");
  ok("E2 a wait that ends without every answer says a later answer still comes", /^1\/2 answered \(no answer: Beta; the request stays open 12 h, so a later answer still reaches you/.test(dt2), dt2);

  // ---- E3: talk_reply wording
  const say = async (r) => { answers["talk.reply"] = () => r; const x = await tools.talk_reply.execute("t", { request_id: "x", text: "hi" }); return x.content.map((c) => c.text).join(""); };
  const w1 = await say({ delivered: true, sent: true, kept: true, to: "Alpha" });
  ok("E3 sent: 'Reply sent to Alpha (handed to its window, not confirmed yet; re-sent …)'", /^Reply sent to Alpha \(handed to its window, not confirmed yet; it is re-sent until its window confirms/.test(w1), w1);
  const w2 = await say({ delivered: false, sent: false, kept: true, to: "Alpha" });
  ok("E3 asker not connected, kept: says it is kept and handed over on reconnect", /^Alpha isn't connected: your reply is kept and handed over when it reconnects/.test(w2), w2);
  const w3 = await say({ delivered: false, sent: false, kept: false, gone: true, to: "Alpha" });
  ok("E3 asker closed: NOT delivered", /^NOT delivered: Alpha has closed/.test(w3), w3);
  const w4 = await say({ delivered: false, sent: false, kept: false, to: "Alpha" });
  ok("E3 asker can't take a late reply: NOT delivered", /^Reply NOT delivered: Alpha isn't connected/.test(w4), w4);
  const legacyOk = await say({ delivered: true });
  ok("C old daemon successful reply is qualified, not claimed confirmed", /not confirmed/.test(legacyOk));
  const legacyFail = await say({ delivered: false });
  ok("C old daemon failure is visible", /NOT delivered/.test(legacyFail));
  const w5 = await say({ delivered: true, thoughts: true, to: "Thoughts-A" });
  ok("E3 to Thoughts: given to its thread, a refusal comes back as a note", /^Reply given to Thoughts-A \(it is in Thoughts-A's thread; if its model can't take it you get a \[hyprpi delivery note\]\)/.test(w5), w5);
  ok("E3 never the unqualified 'Reply delivered.'", ![w1, w2, w3, w4, w5].some((t) => /Reply delivered/.test(t)));

  // ---- E4: two prompts to an idle agent in the same moment
  await waitFor(() => idleNow, 3000); await sleep(200); // the turns above have settled
  userSent.length = 0; const nSent = sent.length;
  push("prompt", { text: "FIRST-PROMPT", via: "room-tui" });
  push("prompt", { text: "SECOND-PROMPT", via: "room-tui" });
  await sleep(300);
  ok("E4 the first prompt starts the turn", userSent.length >= 1 && /FIRST-PROMPT/.test(userSent[0]), JSON.stringify(userSent));
  ok("E4 the second is NOT handed to pi while the first is starting (pi refused it and it was lost)", userSent.length === 1, JSON.stringify(userSent));
  ok("E4 … it is held, not sent yet", !sent.slice(nSent).some((s) => /SECOND-PROMPT/.test(s.m.content)));
  idleNow = true; await emit("agent_settled", {}); // the first turn ends
  ok("E4 … and starts the next turn when the first has ended", !!(await waitFor(() => sent.slice(nSent).some((s) => /SECOND-PROMPT/.test(s.m.content) && s.o?.triggerTurn), 3000)));
} finally {
  try { client?.destroy(); } catch { /* gone */ }
  server.close(); await emit("session_shutdown", {});
  fs.rmSync(T, { recursive: true, force: true });
}
console.log(fails ? `msg-ext-replies: ${fails} FAILED` : "msg-ext-replies: all pass");
process.exit(fails ? 1 : 0);
