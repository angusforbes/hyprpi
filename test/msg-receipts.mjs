#!/usr/bin/env node
// J663 (no silent success, Angus's 38a): agent messaging in the daemon says only what the other side confirmed, and nothing an agent
// sent is lost without its sender hearing so. An isolated daemon (own socket, state, config; no Hyprland, no real agents); fake agents
// connect as the extension does (acks + reply_acks); Thoughts-A is a stand-in RPC pi that takes prompts, REFUSES one ("REFUSE-ME"),
// never takes one ("HANG-ME") and dies on one ("DIE-NOW"). Short waits: talkUndeliveredMs 2 s, the sweep every 0.4 s.
//  R1 an answer (talk_reply) is "sent", kept until the asker's window confirms it (re:<request>:<replier>): the asker that never confirms
//     gets it again on reconnect and its replier a [hyprpi delivery note] after the wait; once confirmed, no more re-sends
//  R2 the asker is disconnected when the answer comes: sent false, kept; it arrives when the asker reconnects
//  R3 an asker with an older window (no reply_acks), disconnected: not kept (the tool then says NOT delivered)
//  R4 the asker has closed: gone, not delivered
//  T1 answer_agent to a disconnected agent: Thoughts is told it's kept; it arrives on reconnect
//  T2 Thoughts' pi refuses an agent's demand: the agent gets "(not delivered: … refused …)" as the answer; a ✗ note in the thread
//  T3 Thoughts' pi refuses an agent's talk_reply to Thoughts' question: the replier gets a [hyprpi delivery note]
//  T4 Thoughts never takes one message and dies on the next: both senders are told; an earlier message it took is not reported
//  W1 a welcome (first prompt) whose window is gone when it is due is kept and given at the next hello
//   node test/run.mjs test/msg-receipts.mjs   (exit 0 = pass)
import fs from "node:fs"; import os from "node:os"; import path from "node:path"; import { spawn, spawnSync } from "node:child_process";
import { requireSandbox } from "./guard/sandbox.mjs";
await requireSandbox(import.meta.url);
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
let fails = 0; const ok = (n, c, x = "") => { if (!c) fails++; console.log(`${c ? "ok  " : "FAIL"} ${n}${x && !c ? ": " + x : ""}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (f, ms = 8000) => { const end = Date.now() + ms; while (Date.now() < end) { try { const v = await f(); if (v) return v; } catch { /* not yet */ } await sleep(100); } return null; };
const T = fs.mkdtempSync(path.join(os.tmpdir(), "j663m-")), F = (n) => path.join(T, n);
const S = F("state"), cfg = F("cfg"), sock = F("d.sock"), LOG = F("pi.log");
fs.mkdirSync(S, { recursive: true }); fs.mkdirSync(path.join(cfg, "hyprpi"), { recursive: true });
// the stand-in Thoughts pi (RPC): a prompt is answered (response with its id), then taken (message_start user) when it starts a turn;
// a turn lasts 150 ms; while busy, prompts queue. REFUSE-ME: response success:false. HANG-ME: accepted, never taken. DIE-NOW: exits.
fs.writeFileSync(F("fake-pi.mjs"), `import fs from "node:fs";
const log = (o) => fs.appendFileSync(${JSON.stringify(LOG)}, JSON.stringify(o) + "\\n");
const out = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
let busy = false, hung = false; const queue = [];
const turn = (m) => { busy = true; log({ turn: m }); out({ type: "agent_start" }); out({ type: "message_start", message: { role: "user", content: [{ type: "text", text: m }] } });
  if (m.includes("HANG-ME")) return;
  setTimeout(() => { out({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "ok" }], stopReason: "stop" } }); out({ type: "agent_end" }); busy = false; out({ type: "agent_settled" }); if (queue.length) turn(queue.shift()); }, 150); };
let buf = "";
process.stdin.on("data", (d) => { buf += d; let i; while ((i = buf.indexOf("\\n")) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); if (!l.trim()) continue;
  let c; try { c = JSON.parse(l); } catch { continue; }
  if (c.type === "prompt") {
    if (String(c.message).includes("DIE-NOW")) { log({ died: true }); process.exit(3); }
    if (String(c.message).includes("REFUSE-ME")) { log({ refused: c.message }); out({ type: "response", id: c.id, command: "prompt", success: false, error: "model unavailable" }); continue; }
    if (c.id) out({ type: "response", id: c.id, command: "prompt", success: true });
    if (String(c.message).includes("HANG-ME")) { hung = true; log({ hung: c.message }); out({ type: "agent_start" }); busy = true; continue; } // accepted, never in the conversation
    if (busy) { queue.push(c.message); log({ queued: c.message }); } else turn(c.message);
  } else if (c.id) out({ type: "response", id: c.id, command: c.type, success: true, data: {} });
} });
process.stdin.on("end", () => process.exit(0));
`);
fs.writeFileSync(F("pi"), `#!/bin/sh\nexec ${process.execPath} ${F("fake-pi.mjs")} "$@"\n`, { mode: 0o755 });
fs.writeFileSync(path.join(cfg, "hyprpi", "config.json"), JSON.stringify({ roomToThoughts: false, pi: F("pi"), worldSize: 10, talkUndeliveredMs: 2000 }));
fs.writeFileSync(path.join(cfg, "hyprpi", "hyprpi.jsonc"), JSON.stringify({ auth: { enabled: false }, upkeep: { refresh: { enabled: false }, autoReload: { enabled: false } } }));
const env = { ...process.env, HYPRPI_SOCKET: sock, HYPRPI_STATE: S, XDG_CONFIG_HOME: cfg, XDG_STATE_HOME: F("xdg-state"), XDG_RUNTIME_DIR: F("run"), HYPRPI_NO_ENSURE: "1", HYPRPI_UPKEEP_MS: "3600000", HYPRPI_NOTIFY_TEST: "1", HYPRPI_MODELCHECK: "0", HYPRPI_UNDELIVERED_SWEEP_MS: "400" };
fs.mkdirSync(F("run"), { recursive: true });
for (const k of ["HYPRPI_AGENT_ID", "HYPRLAND_INSTANCE_SIGNATURE", "WAYLAND_DISPLAY", "HYPRPI_REMOTE_HOME", "HYPRPI_REMOTE_LINK", "HYPRPI_WORKSPACE"]) delete env[k];
// W1: a pending welcome (as open_agent / a /move / an upkeep refresh leave one) for an agent that hasn't said hello yet
fs.writeFileSync(path.join(S, "pending-opens.json"), JSON.stringify({ "hp-welcome1": { ts: Date.now(), welcome: "WELCOME-BRIEF: your job is J1" } }));
const d = spawn(process.execPath, [path.join(ROOT, "bin/hyprpi"), "daemon"], { env, stdio: ["ignore", "ignore", fs.openSync(F("d.err"), "a")] });
const { connect } = await import(path.join(ROOT, "lib/client.mjs"));
const pilog = () => { try { return fs.readFileSync(LOG, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
// a dead pid (a process this test started and that has ended): an agent "closed" with it is dropped at once on disconnect
const deadPid = spawnSync("true").pid;
// A fake agent window. Talks are confirmed (agent.delivered) as they arrive; answers only when told (autoAck / ackReply).
async function agent(id, name, { replyAcks = true, autoAck = false, pid = process.pid, ws = 3 } = {}) {
  const ag = { id, got: [], c: null, autoAck };
  const onEvent = (ev, data) => {
    ag.got.push({ ev, data });
    if (ev === "talk") ag.c?.call("agent.delivered", { id: data.request_id }).catch(() => {});
    if (ev === "talk.reply" && ag.autoAck) ag.c?.call("agent.delivered", { id: `re:${data.request_id}:${data.from.id}` }).catch(() => {});
  };
  ag.connect = async () => { ag.c = await connect({ path: sock, onEvent }); await ag.c.call("agent.hello", { agent_id: id, pid, name, want_workspace: ws, cwd: T, acks: true, ...(replyAcks ? { reply_acks: true } : {}) }); };
  ag.drop = () => { ag.c.close(); };
  ag.replies = (rid) => ag.got.filter((g) => g.ev === "talk.reply" && (!rid || g.data.request_id === rid));
  ag.talks = (re) => ag.got.filter((g) => g.ev === "talk" && re.test(g.data.text || ""));
  await ag.connect();
  return ag;
}
const talk = (ag, to, text, mode = "talk") => ag.c.call("talk", { to: [to], text, mode });
try {
  for (let i = 0; i < 60 && !fs.existsSync(sock); i++) await sleep(200);
  const api = await connect({ path: sock });

  // ---- R1: confirmed only by the asker's window; re-sent until then; the replier hears after the wait
  const a1 = await agent("hp-asker1", "Asker1"), r1 = await agent("hp-rep1", "Rep1");
  const t1 = await talk(a1, "Rep1", "what's the status?");
  const got1 = await waitFor(() => r1.talks(/what's the status/)[0]);
  const rr1 = await r1.c.call("talk.reply", { request_id: got1?.data?.request_id, text: "ANSWER-1" });
  ok("R1 talk_reply: sent (handed to the window), kept until confirmed", rr1.sent === true && rr1.kept === true && rr1.to === "Asker1", JSON.stringify(rr1));
  ok("R1 … the asker's window got it", !!(await waitFor(() => a1.replies(t1.request_id).length === 1)));
  a1.drop(); await sleep(300); await a1.connect(); // its window reloads without having confirmed (it never landed)
  ok("R1 not confirmed: re-sent when the asker reconnects", !!(await waitFor(() => a1.replies(t1.request_id).length >= 2, 5000)), String(a1.replies(t1.request_id).length));
  const note1 = await waitFor(() => r1.talks(/\[hyprpi delivery note\] your reply to Asker1/)[0], 5000);
  ok("R1 not confirmed after the wait: the replier gets a delivery note saying so", !!note1 && /hasn't landed/.test(note1.data.text) && /re-sent when Asker1 finishes or reconnects/.test(note1.data.text), note1?.data?.text);
  await a1.c.call("agent.delivered", { id: `re:${t1.request_id}:hp-rep1` }); // it lands (late)
  const n1 = a1.replies(t1.request_id).length;
  a1.drop(); await sleep(300); await a1.connect(); await sleep(3000);
  ok("R1 confirmed (late): no more re-sends", a1.replies(t1.request_id).length === n1, `${n1} -> ${a1.replies(t1.request_id).length}`);
  ok("R1 … and the delivery note came once", r1.talks(/your reply to Asker1/).length === 1);

  // ---- R2: the asker is disconnected when the answer comes; it gets it when it's back
  const a2 = await agent("hp-asker2", "Asker2", { autoAck: true }), r2 = await agent("hp-rep2", "Rep2");
  const t2 = await talk(a2, "Rep2", "Q2");
  const got2 = await waitFor(() => r2.talks(/Q2/)[0]);
  a2.drop(); await sleep(300);
  const rr2 = await r2.c.call("talk.reply", { request_id: got2.data.request_id, text: "ANSWER-2" });
  ok("R2 asker not connected: not sent, kept (no 'delivered')", rr2.sent === false && rr2.kept === true && rr2.delivered === false, JSON.stringify(rr2));
  await a2.connect();
  ok("R2 … handed over when the asker reconnects", !!(await waitFor(() => a2.replies(t2.request_id).some((g) => g.data.text === "ANSWER-2"), 5000)));
  await sleep(2600);
  ok("R2 confirmed by the asker: no delivery note to the replier", r2.talks(/your reply to Asker2/).length === 0);

  // ---- R3: an older asker window (no reply_acks), disconnected: not kept
  const a3 = await agent("hp-asker3", "Asker3", { replyAcks: false }), r3 = await agent("hp-rep3", "Rep3");
  await talk(a3, "Rep3", "Q3"); const got3 = await waitFor(() => r3.talks(/Q3/)[0]);
  a3.drop(); await sleep(300);
  const rr3 = await r3.c.call("talk.reply", { request_id: got3.data.request_id, text: "ANSWER-3" });
  ok("R3 older asker, not connected: not sent, not kept", rr3.sent === false && rr3.kept === false && !rr3.delivered, JSON.stringify(rr3));
  await a3.connect();

  // ---- R4: the asker has closed
  const a4 = await agent("hp-asker4", "Asker4", { pid: deadPid }), r4 = await agent("hp-rep4", "Rep4");
  await talk(a4, "Rep4", "Q4"); const got4 = await waitFor(() => r4.talks(/Q4/)[0]);
  a4.drop(); await sleep(800); // a dead pid: dropped (closed) at once
  const rr4 = await r4.c.call("talk.reply", { request_id: got4.data.request_id, text: "ANSWER-4" });
  ok("R4 asker closed: gone, not delivered", rr4.gone === true && rr4.delivered === false && rr4.to === "Asker4", JSON.stringify(rr4));

  // ---- T1: answer_agent to a disconnected agent
  const a5 = await agent("hp-asker5", "Asker5", { autoAck: true });
  const t5 = await talk(a5, "Thoughts-A", "T1 question for Thoughts");
  ok("T1 setup: Thoughts-A took the message (in its conversation)", !!(await waitFor(() => pilog().some((x) => /T1 question for Thoughts/.test(x.turn || "")), 8000)));
  a5.drop(); await sleep(300);
  const ta5 = await api.call("thoughts.answer", { room: "A", request_id: t5.request_id, text: "T1-ANSWER" });
  ok("T1 answer_agent to a disconnected agent: not sent, kept (Thoughts is told)", ta5.sent === false && ta5.kept === true && ta5.agent === "Asker5", JSON.stringify(ta5));
  await a5.connect();
  ok("T1 … handed over when it reconnects", !!(await waitFor(() => a5.replies(t5.request_id).some((g) => g.data.text === "T1-ANSWER"), 5000)));

  // ---- T2: Thoughts' pi refuses an agent's demand -> the agent hears it as the answer
  const a6 = await agent("hp-asker6", "Asker6", { autoAck: true });
  const t6 = await talk(a6, "Thoughts-A", "REFUSE-ME please answer", "demand");
  const f6 = await waitFor(() => a6.replies(t6.request_id)[0], 6000);
  ok("T2 refused by Thoughts' pi: the asker gets '(not delivered: … refused …)' as its answer", !!f6 && /^\(not delivered: Thoughts-A didn't take your message: Thoughts-A refused it: model unavailable/.test(f6.data.text) && f6.data.from.id === "thoughts:A", f6?.data?.text);
  const th = (await api.call("thoughts.get", { room: "A" })).entries || [];
  ok("T2 … and a ✗ note in Thoughts' thread", th.some((e) => e.role === "note" && /didn't take Asker6's message: model unavailable/.test(e.text || "")), JSON.stringify(th.filter((e) => e.role === "note").map((e) => e.text)));
  const ta6 = await api.call("thoughts.answer", { room: "A", request_id: t6.request_id, text: "late" }).catch((e) => ({ error: e.message }));
  ok("T2 … the request counts as answered (by the failure), so nothing else claims it", /already answered/.test(ta6.error || ""), JSON.stringify(ta6));

  // ---- T3: Thoughts' pi refuses an agent's talk_reply to Thoughts' own question
  const r7 = await agent("hp-rep7", "Rep7");
  await api.call("thoughts.ask", { room: "A", agent: "Rep7", question: "T3 question from Thoughts" });
  const q7 = await waitFor(() => r7.talks(/T3 question from Thoughts/)[0]);
  const rr7 = await r7.c.call("talk.reply", { request_id: q7.data.request_id, text: "REFUSE-ME T3 answer" });
  ok("T3 talk_reply to Thoughts: given to its thread (no unqualified 'delivered' claim needed: thoughts flag)", rr7.thoughts === true && rr7.to === "Thoughts-A", JSON.stringify(rr7));
  const n7 = await waitFor(() => r7.talks(/\[hyprpi delivery note\] Thoughts-A didn't take your reply/)[0], 6000);
  ok("T3 … refused: the replier gets a delivery note (send it again)", !!n7 && /Send it again with talk_reply/.test(n7.data.text), n7?.data?.text);

  // ---- T4: one message never taken, the next kills Thoughts: both senders told; the earlier taken one (T1) is not
  const a8 = await agent("hp-asker8", "Asker8", { autoAck: true }), a9 = await agent("hp-asker9", "Asker9", { autoAck: true });
  const t8 = await talk(a8, "Thoughts-A", "HANG-ME forever");
  ok("T4 setup: the stand-in accepted HANG-ME (and never takes it)", !!(await waitFor(() => pilog().some((x) => /HANG-ME/.test(x.hung || "")), 6000)));
  const t9 = await talk(a9, "Thoughts-A", "DIE-NOW");
  const f8 = await waitFor(() => a8.replies(t8.request_id)[0], 6000), f9 = await waitFor(() => a9.replies(t9.request_id)[0], 6000);
  ok("T4 never taken, then Thoughts stopped: its sender is told", !!f8 && /^\(not delivered: Thoughts-A didn't take your message: Thoughts-A stopped/.test(f8.data.text), f8?.data?.text);
  ok("T4 the message it died on: its sender is told too", !!f9 && /stopped/.test(f9.data.text), f9?.data?.text);
  await sleep(500);
  ok("T4 the message it HAD taken (T1) is not reported lost", !a5.replies(t5.request_id).some((g) => /not delivered/.test(g.data.text)));
  const th4 = (await api.call("thoughts.get", { room: "A" })).entries || [];
  ok("T4 … and the thread says so", th4.some((e) => e.role === "note" && /stopped before taking 2 agents' messages; their senders were told/.test(e.text || "")), JSON.stringify(th4.filter((e) => e.role === "note").map((e) => e.text)));

  // ---- W1: a welcome whose window is gone when it is due (3 s after hello) is kept for the next hello
  const w1 = await agent("hp-welcome1", "Welcomed", { pid: process.pid });
  w1.drop(); // gone within the 3 s
  await sleep(3600);
  ok("W1 setup: the welcome didn't reach the dropped window", !w1.got.some((g) => g.ev === "prompt"));
  await w1.connect();
  const wp = await waitFor(() => w1.got.find((g) => g.ev === "prompt" && /WELCOME-BRIEF/.test(g.data.text || "")), 6000);
  ok("W1 the welcome is kept and given at the next hello", !!wp);
} finally {
  d.kill("SIGTERM"); await sleep(400);
  if (!fails) fs.rmSync(T, { recursive: true, force: true }); else console.log(`kept ${T}`);
}
console.log(fails ? `msg-receipts: ${fails} FAILED` : "msg-receipts: all pass");
process.exit(fails ? 1 : 0);
