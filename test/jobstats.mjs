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
  ok("(2) spawn_agent fills the child's job from its parent's running job", kid?.job === J, sp.error ? `spawn: ${sp.error}` : JSON.stringify({ job: kid?.job }));
  // report → done
  await agent.call("talk.reply", { request_id: req1, text: "changed: x\nproof: W1 → works · W2 → checked by Bolt\nundo: revert\nsurprises: none\nopen: none" });
  b = brief()[J];
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
  ok("lists stay capped", JSON.stringify(brief()).length < 20000, `${JSON.stringify(brief()).length} bytes`);
  api.close?.(); agent.close?.(); other.close?.();
} catch (e) { fails++; console.log("FAIL", e.stack); }
finally { d.kill(); }
console.log(fails ? `${fails} FAILED (state ${S})` : "all passed"); process.exit(fails ? 1 : 0);
