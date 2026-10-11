#!/usr/bin/env node
// J454 proof (Angus "1 y"; Knock's J451 items 1–9): per-job records for the job scoreboard.
//   node test/jobstats.mjs   (exit 0 = pass)
// An isolated daemon (temp socket + state, no Hyprland, Thoughts' pi = /bin/cat, orch launcher = /bin/true)
// and a fake agent (agent.hello with a model and thinking). One job goes through: briefed (with coupling) →
// started → working / idle (active time) → tokens (agent.usage) → messages (talk, ask_agent, talk_reply) →
// a model switch (set_model, answered by the fake agent) → a spawned child (its job field) → done (report) →
// a failed check with a cause → revise_work with a cause → done → verified. Then: calls without the new
// fields still work, and bad values are refused.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
let fails = 0; const ok = (n, c, x = "") => { if (!c) fails++; console.log(`${c ? "ok  " : "FAIL"} ${n}${x ? ": " + x : ""}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const S = fs.mkdtempSync(path.join(os.tmpdir(), "j454-")), cfg = path.join(S, "cfg"), sock = path.join(S, "d.sock");
fs.mkdirSync(path.join(cfg, "hyprpi"), { recursive: true });
fs.writeFileSync(path.join(cfg, "hyprpi", "config.json"), JSON.stringify({ roomToThoughts: false, pi: "/bin/cat", worldSize: 10 }));
fs.writeFileSync(path.join(cfg, "hyprpi", "hyprpi.jsonc"), JSON.stringify({ auth: { enabled: false }, upkeep: { refresh: { enabled: false }, autoReload: { enabled: false } } }));
const env = { ...process.env, HYPRPI_SOCKET: sock, HYPRPI_STATE: S, XDG_CONFIG_HOME: cfg, HYPRLAND_INSTANCE_SIGNATURE: "j454-bogus", HYPRPI_NO_ENSURE: "1", HYPRPI_UPKEEP_MS: "3600000", HYPRPI_ORCH_LAUNCH: "/bin/true" };
delete env.HYPRPI_AGENT_ID; delete env.HYPRPI_WORKSPACE;
const d = spawn(process.execPath, [path.join(ROOT, "bin/hyprpi"), "daemon"], { env, stdio: ["ignore", fs.openSync(path.join(S, "d.log"), "w"), fs.openSync(path.join(S, "d.err"), "w")] });
try {
  for (let i = 0; i < 50 && !fs.existsSync(sock); i++) await sleep(200);
  const { connect } = await import(path.join(ROOT, "lib/client.mjs"));
  const api = await connect({ path: sock, onEvent: () => {} });
  const got = [];
  let agent;
  agent = await connect({ path: sock, onEvent: (ev, data) => {
    got.push({ ev, data });
    if (ev === "set_model") agent.call("agent.modelResult", { token: data.token, ok: true, model: data.model || "anthropic/claude-opus-5-5", thinking: data.thinking || "high" }).catch(() => {});
  } });
  await agent.call("agent.hello", { agent_id: "hp-atlas", pid: process.pid, name: "Atlas", want_workspace: 32, cwd: S, model: "claude-sonnet-5-5", thinking: "medium" });
  const other = await connect({ path: sock, onEvent: () => {} });
  await other.call("agent.hello", { agent_id: "hp-bolt", pid: process.pid, name: "Bolt", want_workspace: 33, cwd: S, model: "claude-haiku-4-5", thinking: "low" });
  const brief = () => JSON.parse(fs.readFileSync(path.join(S, "briefs.json"), "utf8")).briefs;
  const err = async (f) => { try { await f(); return ""; } catch (e) { return e.message; } };
  const rid = () => (JSON.stringify(got).match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g) || []).pop();

  // briefed (with coupling)
  ok("bad coupling refused", /coupling:/.test(await err(() => api.call("thoughts.work", { room: "D", agent: "Atlas", goal: "g", angus: "x", done_when: ["W1 a"], coupling: "lots" }))));
  got.length = 0;
  const w = await api.call("thoughts.work", { room: "D", agent: "Atlas", goal: "build the thing", angus: "do it", done_when: ["W1 it works", "W2 checked"], coupling: "independent" });
  const J = w.job; await sleep(300); const req1 = rid();
  let b = brief()[J];
  ok("(6) coupling recorded from the brief", b.coupling?.value === "independent" && b.coupling.by === "Thoughts-D", JSON.stringify(b.coupling));
  ok("(1) model + thinking when briefed", b.stats.models[0].event === "briefed" && b.stats.models[0].model === "claude-sonnet-5-5" && b.stats.models[0].thinking === "medium", JSON.stringify(b.stats.models[0]));
  // working 600 ms, idle, working 400 ms
  // the daemon times the spells by when it receives each update, so compare with what it saw: the idle gap
  // (≥ 300 ms between spell 1's end and spell 2's start) must not count
  const act = () => brief()[J].stats.active_ms, t0 = Date.now();
  await agent.call("agent.update", { status: "working" }); await sleep(600); await agent.call("agent.update", { status: "idle" }); const a1 = act(), t1 = Date.now(); await sleep(300);
  const t2 = Date.now(); await agent.call("agent.update", { status: "working" }); await sleep(400); await agent.call("agent.update", { status: "done" }); const a2 = act(), t3 = Date.now();
  ok("(4) the first spell counts its working time", a1 >= 600 && a1 <= t1 - t0, `${a1} ms of ${t1 - t0}`);
  ok("(4) the idle gap doesn't count", a2 >= 1000 && a2 <= (t3 - t0) - (t2 - t1) + 50, `${a2} ms; whole span ${t3 - t0}, idle ${t2 - t1}`);
  // tokens
  await agent.call("agent.usage", { tokens: 1200 }); await agent.call("agent.usage", { tokens: 800 });
  await other.call("agent.usage", { tokens: 5000 }); // Bolt has no running job: counts nowhere
  ok("(3) tokens per job", brief()[J].stats.tokens === 2000, String(brief()[J].stats.tokens));
  // messages: Atlas → Bolt (talk), Thoughts → Atlas (ask_agent), Atlas ↩ (talk_reply)
  await agent.call("talk", { to: ["Bolt"], text: "hello Bolt, 23 bytes!!" });
  got.length = 0; await api.call("thoughts.ask", { room: "D", agent: "Atlas", question: "how is it going?" }); await sleep(300);
  await agent.call("talk.reply", { request_id: rid(), text: "fine" });
  const m = brief()[J].stats.msgs;
  ok("(8) messages per job: talk, ask_agent, talk_reply", m.n === 3 && m.bytes === Buffer.byteLength("hello Bolt, 23 bytes!!") + Buffer.byteLength("how is it going?") + 4, JSON.stringify(m));
  // set_model (Thoughts, answered by the fake agent) → escalated event
  await api.call("thoughts.setModel", { room: "D", agent: "Atlas", thinking: "high", reason: "escalated (J130)" }) /* thinking only: no model test-call (pi is /bin/cat here); the fake agent answers with opus */.catch((e) => console.log("   setModel:", e.message));
  b = brief()[J];
  ok("(1) model after an escalation", b.stats.models.some((x) => x.event === "escalated" && /opus/.test(x.model) && x.thinking === "high"), JSON.stringify(b.stats.models.map((x) => x.event + ":" + x.model)));
  await agent.call("agent.update", { model: "claude-opus-5-5" }); // the agent's own model_select right after: not a second entry
  ok("(1) the agent's echo of that switch isn't recorded twice", brief()[J].stats.models.filter((x) => /opus/.test(x.model)).length === 1);
  // a spawned child carries the job
  const sp = await agent.call("orch.spawn", { prompt: "check one part", complexity: "simple" }).catch((e) => ({ error: e.message }));
  const orch = JSON.parse(fs.readFileSync(path.join(S, "orch.json"), "utf8") || "{}");
  const kid = Object.values(orch.children || {})[0];
  ok("(2) spawn_agent records the job its child helps (parentJob), and leaves child.job alone (no report check, no escalation)", kid?.parentJob === J && !kid?.job, sp.error ? `spawn: ${sp.error}` : JSON.stringify({ job: kid?.job, parentJob: kid?.parentJob }));
  // the helper's tokens count for the job it helps
  const helper = await connect({ path: sock, onEvent: () => {} });
  await helper.call("agent.hello", { agent_id: kid.id, pid: process.pid, name: "Helper", want_workspace: 34, cwd: S, model: "claude-haiku-4-5", thinking: "low" });
  await helper.call("agent.usage", { tokens: 700 });
  ok("(3) a helper's tokens count for the job it helps (helper_tokens)", brief()[J].stats.helper_tokens === 700 && brief()[J].stats.tokens === 2000, JSON.stringify({ t: brief()[J].stats.tokens, h: brief()[J].stats.helper_tokens }));
  await helper.call("orch.report", { text: "half of it, nine bytes", final: false });
  ok("(8) report_to_parent counts as a message for the job", brief()[J].stats.msgs.n === 4, JSON.stringify(brief()[J].stats.msgs));
  // report → done
  await agent.call("talk.reply", { request_id: req1, text: "changed: x\nproof: W1 → works · W2 → checked by Bolt\nundo: revert\nsurprises: none\nopen: none" });
  b = brief()[J];
  ok("(1) thinking at done is the switched one (high)", b.stats.models.at(-1).thinking === "high", JSON.stringify(b.stats.models.at(-1)));
  ok("done: model, elapsed and waiting recorded", b.state === "done" && b.stats.models.at(-1).event === "done" && b.stats.elapsed_ms > 0 && b.stats.waiting_ms === b.stats.elapsed_ms - b.stats.active_ms, JSON.stringify({ e: b.stats.elapsed_ms, a: b.stats.active_ms, w: b.stats.waiting_ms }));
  // a failed check with a cause, then a revise with a cause
  ok("bad cause refused", /cause:/.test(await err(() => api.call("thoughts.verify", { room: "D", job: J, by: "Bolt", failed: true, cause: "bad luck" }))));
  await api.call("thoughts.verify", { room: "D", job: J, by: "Bolt", failed: true, cause: "spec", note: "W1 wasn't what Angus meant" });
  b = brief()[J];
  ok("(9) the checker's FAIL recorded directly, with its cause (7)", b.stats.verdicts.at(-1).verdict === "fail" && b.stats.verdicts.at(-1).by === "Bolt" && b.stats.verdicts.at(-1).cause === "spec");
  ok("(7) the reopening recorded with its cause", b.stats.reopens.at(-1).cause === "spec" && b.state === "running" && b.stats.models.some((x) => x.event === "reopened"));
  await api.call("thoughts.revise", { room: "D", job: J, goal: "build the thing, as Angus meant it", reason: "the spec was unclear", cause: "spec", coupling: "sequential" }).catch((e) => console.log("   revise:", e.message));
  b = brief()[J];
  ok("(7) revise_work records its cause; coupling can be corrected", b.stats.reopens.at(-1).reason === "the spec was unclear" && b.stats.reopens.at(-1).cause === "spec" && b.coupling.value === "sequential" && b.stats.models.some((x) => x.event === "revised"));
  // done again (v2), then verified
  got.length = 0; await sleep(300);
  await api.call("thoughts.close", { room: "D", job: J, state: "done", report: "proof: W1 → works now · W2 → checked" });
  await api.call("thoughts.verify", { room: "D", job: J, by: "Bolt", note: "all good" });
  b = brief()[J];
  ok("(9) the checker's PASS recorded directly", b.state === "verified" && b.stats.verdicts.at(-1).verdict === "pass" && b.stats.verdicts.length === 2);
  // W2: old-style calls still work
  const w2 = await api.call("thoughts.work", { room: "D", agent: "Bolt", goal: "a plain job", angus: "x", done_when: ["W1 ok"] });
  const b2 = brief()[w2.job];
  ok("W2 give_work without the new fields works (no coupling)", b2 && !b2.coupling && b2.stats.models[0].event === "briefed");
  const other2 = await connect({ path: sock, onEvent: () => {} });
  await other2.call("agent.hello", { agent_id: "hp-bolt", pid: process.pid, name: "Bolt", want_workspace: 33, cwd: S, model: "claude-haiku-4-5", thinking: "low" });
  ok("(1) an agent saying hello with a running job records 'started' (an opened agent's first hello)", brief()[w2.job].stats.models.some((x) => x.event === "started" && x.model === "claude-haiku-4-5"));
  await api.call("thoughts.close", { room: "D", job: w2.job, state: "done", report: "proof: W1 → ok" });
  ok("W2 verify_work without cause works", (await api.call("thoughts.verify", { room: "D", job: w2.job, by: "Atlas" })).state === "verified");
  // a job created while its agent is mid-turn isn't charged the time before it existed; tokens split between two jobs
  await agent.call("agent.update", { status: "working" }); await sleep(500);
  const w3 = await api.call("thoughts.work", { room: "D", agent: "Atlas", goal: "mid-turn job", angus: "x", done_when: ["W1 ok"], urgent: true });
  const w4 = await api.call("thoughts.work", { room: "D", agent: "Atlas", goal: "second job", angus: "x", done_when: ["W1 ok"], urgent: true });
  await sleep(150); await agent.call("agent.usage", { tokens: 1000 });
  await api.call("thoughts.close", { room: "D", job: w3.job, state: "done", report: "proof: W1 → ok" });
  const b3 = brief()[w3.job], b4 = brief()[w4.job];
  ok("(4) a job created mid-turn: active ≤ elapsed", b3.stats.active_ms <= b3.stats.elapsed_ms && b3.stats.active_ms < 450, JSON.stringify({ a: b3.stats.active_ms, e: b3.stats.elapsed_ms }));
  ok("(3) two running jobs share the agent's tokens (sum kept)", b3.stats.tokens + b4.stats.tokens === 1000 && b3.stats.tokens === 500, `${b3.stats.tokens} + ${b4.stats.tokens}`);
  await agent.call("agent.update", { status: "idle" });
  await agent.call("agent.usage", { tokens: 300 });
  ok("(3) tokens after a job is done don't count for it", brief()[w3.job].stats.tokens === 500 && brief()[w4.job].stats.tokens === 800);
  const w6 = await api.call("thoughts.work", { room: "D", agent: "Atlas", goal: "sixth", angus: "x", done_when: ["W1 ok"], urgent: true });
  const t4 = brief()[w4.job].stats.tokens; await agent.call("agent.usage", { tokens: 123 });
  ok("(3) an odd count splits in whole tokens, the sum kept (123 → 62 + 61)", (brief()[w4.job].stats.tokens - t4) + (brief()[w6.job].stats.tokens || 0) === 123, `${brief()[w4.job].stats.tokens - t4} + ${brief()[w6.job].stats.tokens}`);
  await api.call("thoughts.close", { room: "D", job: w6.job, state: "obsolete", reason: "test" });
  // an ordinary reply (agent to agent) counts as a message
  const gotB = []; const bolt = await connect({ path: sock, onEvent: (ev, data) => gotB.push({ ev, data }) });
  await bolt.call("agent.hello", { agent_id: "hp-bolt", pid: process.pid, name: "Bolt", want_workspace: 33, cwd: S, model: "claude-haiku-4-5", thinking: "low" });
  const n0 = brief()[w4.job].stats.msgs.n;
  await agent.call("talk", { to: ["Bolt"], text: "quick question?", mode: "demand" }).catch((e) => console.log("   demand:", e.message));
  await sleep(300); const bid = (JSON.stringify(gotB).match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g) || []).pop();
  if (bid) await bolt.call("talk.reply", { request_id: bid, text: "an answer" }).catch((e) => console.log("   reply:", e.message));
  ok("(8) an ordinary agent-to-agent demand and its reply both count", brief()[w4.job].stats.msgs.n === n0 + 2, `${n0} → ${brief()[w4.job].stats.msgs.n}`);
  // StatsCheck round 2: started on the first working spell; thinking-only change; resync idle; the closing report counts; caps
  got.length = 0;
  const w5 = await api.call("thoughts.work", { room: "D", agent: "Atlas", goal: "fifth", angus: "x", done_when: ["W1 ok"], urgent: true }); await sleep(300); const r5 = rid();
  await api.call("thoughts.cancel", { room: "D", agent: "Atlas", reason: "test: clear the queue" }).catch(() => {});
  await agent.call("agent.update", { status: "working" });
  ok("(1) 'started' on the agent's first working spell on the job", brief()[w5.job].stats.models.some((x) => x.event === "started"));
  await agent.call("agent.update", { thinking: "xhigh" });
  ok("(1) the agent's own thinking change is recorded", brief()[w5.job].stats.models.some((x) => x.event === "thinking" && x.thinking === "xhigh"));
  await sleep(200); await agent.call("agent.update", { status: "idle", resync: true }); const aR = brief()[w5.job].stats.active_ms; await sleep(300);
  ok("(4) a resync to idle ends the working spell (the idle time after it doesn't count)", aR >= 150 && brief()[w5.job].stats.active_ms === aR, `${aR} → ${brief()[w5.job].stats.active_ms}`);
  const m5 = brief()[w5.job].stats.msgs.n;
  await agent.call("talk.reply", { request_id: r5, text: "proof: W1 → ok, closing it" }).catch((e) => console.log("   r5:", e.message));
  ok("(8) the report that closes the job counts as its message", brief()[w5.job].state === "done" && brief()[w5.job].stats.msgs.n === m5 + 1, `${brief()[w5.job].state} ${m5} → ${brief()[w5.job].stats.msgs.n}`);
  for (let i = 0; i < 25; i++) await agent.call("agent.update", { thinking: i % 2 ? "low" : "high" });
  const ms4 = brief()[w4.job].stats.models;
  ok("caps: model events stop at 20 (oldest dropped)", ms4.length === 20 && ms4.at(-1).event === "thinking", String(ms4.length));
  ok("lists stay capped", JSON.stringify(brief()).length < 20000, `${JSON.stringify(brief()).length} bytes`);
  api.close?.(); agent.close?.(); other.close?.();
} catch (e) { fails++; console.log("FAIL", e.stack); }
finally { d.kill(); }
console.log(fails ? `${fails} FAILED (state ${S})` : "all passed"); process.exit(fails ? 1 : 0);
