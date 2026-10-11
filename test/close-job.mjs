#!/usr/bin/env node
// J440 proof (Angus: "should Pocket add a way to close stale jobs with their evidence? (recommended)" yes).
//   node test/close-job.mjs   (exit 0 = pass)
// A) lib/briefs.mjs reportSections (pure): "=== J257 … ===", "## J398", "J400:" headers; mentions don't count.
// B) an isolated daemon (temp socket + state, no Hyprland, Thoughts' pi = /bin/cat so no model runs), a fixture
//    board + briefs and a fake agent (agent.hello):
//    1. close_job (thoughts.close) done: needs a report answering every W line; the card line shows done; the
//       history keeps v1 and gains a note; verify_work by the same agent is refused, by another works.
//    2. close_job obsolete: needs a reason; can't then be verified; a closed job can't be closed again.
//    3. a reply with three "=== Jn ===" sections: each of the agent's running jobs becomes done; another
//       agent's job in it isn't counted; one missing a W line stays running, and the lead says why.
//    4. the same as a plain talk message to Thoughts-Z.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { reportSections } from "../lib/briefs.mjs";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
let fails = 0; const ok = (n, c, x = "") => { if (!c) fails++; console.log(`${c ? "ok  " : "FAIL"} ${n}${x ? ": " + x : ""}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = Date.now();

// ---- A) pure
const ids = (t) => reportSections(t).sections.map((s) => s.id).join(" ");
ok("A === headers", ids("intro\n=== J233 v1: x ===\nW1 → a\n=== J257 v1 ===\nW1 → b") === "J233 J257");
ok("A ## and J400: headers", ids("## J398\nW1 → a\nJ400: plain\nW1 → b") === "J398 J400");
ok("A a mention mid-line is no header", ids("See J12 for context.\nIt follows J9's fix.") === "");
ok("A a header inside a code fence doesn't count", ids("example:\n```text\n=== J9 v1 ===\nW1 → x\n```\n=== J10 ===\nW1 → y") === "J10");
ok("A withoutFences drops code blocks", (await import("../lib/briefs.mjs")).withoutFences("a\n```\nW1 → x\n```\nb").includes("W1") === false);
ok("A a nested fence (```` around ```) hides the inner header", ids("````markdown\n```text\n=== J16 v2 ===\nW1 → PASS\n```\n````\n=== J17 ===") === "J17");
ok("A withoutFences keeps text after a nested block", (await import("../lib/briefs.mjs")).withoutFences("````\n```\nW1 → x\n```\n````\nafter").trim() === "after");
ok("A the header's version is read", reportSections("=== J13 v1 ===\nW1 → x").sections[0].version === 1);
ok("A each section holds only its own text", reportSections("=== J1 ===\nW1 → one\n=== J2 ===\nW1 → two").sections[0].text.includes("two") === false);

// ---- B) daemon
const S = fs.mkdtempSync(path.join(os.tmpdir(), "j440-")), cfg = path.join(S, "cfg"), sock = path.join(S, "d.sock");
fs.mkdirSync(path.join(S, "boards")); fs.mkdirSync(path.join(cfg, "hyprpi"), { recursive: true });
fs.writeFileSync(path.join(cfg, "hyprpi", "config.json"), JSON.stringify({ roomToThoughts: false, pi: "/bin/cat", worldSize: 10 }));
fs.writeFileSync(path.join(cfg, "hyprpi", "hyprpi.jsonc"), JSON.stringify({ auth: { enabled: false }, upkeep: { refresh: { enabled: false }, autoReload: { enabled: false } } }));
const items = ["N1", "N2", "N3", "N4", "N5", "N6", "N7", "N8"].map((h) => ({ h, sec: "next", text: `⟦${h}⟧`, by: { id: "", name: "Thoughts-D" }, ts: now, updated: now }));
fs.writeFileSync(path.join(S, "boards", "D.json"), JSON.stringify({ room: "D", projects: [{ id: "p-wk", name: "workshop", title: "odds", icon: "🔧", status: "active", members: ["hp-atlas"], writer: "hp-atlas", created: now, updated: now, by: "x", where: null, next_step: null, seq: { D: 0, N: 8, H: 0 }, items }] }));
const W2 = ["W1 the thing works", "W2 a second agent checked it"];
const brief = (id, item, agent, name, state = "running", dw = W2) => [id, { id, version: 1, state, created: now, updated: now, project: "p-wk", projectName: "workshop", item, agent, agent_name: name, from: "Thoughts-D", room: "D", fields: { goal: `goal of ${id}`, angus: "x", done_when: dw }, history: [{ version: 1, state, ts: now, fields: { goal: `goal of ${id}` } }] }];
fs.writeFileSync(path.join(S, "briefs.json"), JSON.stringify({ next: 20, briefs: Object.fromEntries([
  brief("J1", "N1", "hp-atlas", "Atlas"), brief("J2", "N2", "hp-atlas", "Atlas", "stopped"), brief("J3", "N3", "hp-atlas", "Atlas"),
  brief("J4", "N4", "hp-atlas", "Atlas"), brief("J5", "N5", "hp-atlas", "Atlas"), brief("J6", "N6", "hp-bolt", "Bolt"),
  brief("J7", "N7", "hp-atlas", "Atlas"), brief("J8", "N8", "hp-atlas", "Atlas"), brief("J9", "N8", "hp-atlas", "Atlas"), ["J10", { ...brief("J10", "N8", "hp-atlas", "Atlas")[1], version: 2 }], brief("J11", "N8", "hp-atlas", "Atlas"), ["J12", { ...brief("J12", "N8", "hp-atlas", "Atlas")[1], room: "E" }],
]) }));
const env = { ...process.env, HYPRPI_SOCKET: sock, HYPRPI_STATE: S, XDG_CONFIG_HOME: cfg, HYPRLAND_INSTANCE_SIGNATURE: "j440-bogus", HYPRPI_NO_ENSURE: "1", HYPRPI_UPKEEP_MS: "3600000" };
delete env.HYPRPI_AGENT_ID; delete env.HYPRPI_WORKSPACE;
const d = spawn(process.execPath, [path.join(ROOT, "bin/hyprpi"), "daemon"], { env, stdio: ["ignore", fs.openSync(path.join(S, "d.log"), "w"), "inherit"] });
try {
  for (let i = 0; i < 50 && !fs.existsSync(sock); i++) await sleep(200);
  const { connect } = await import(path.join(ROOT, "lib/client.mjs"));
  const api = await connect({ path: sock, onEvent: () => {} });
  const got = []; // what the fake agent receives
  const agent = await connect({ path: sock, onEvent: (ev, data) => got.push({ ev, data }) });
  await agent.call("agent.hello", { agent_id: "hp-atlas", pid: process.pid, name: "Atlas", want_workspace: 32, cwd: S });
  const job = async (id) => (await api.call("thoughts.briefs", { id }));
  const line = async (h) => (await api.call("board.get", { room: "D" })).projects[0].items.find((x) => x.h === h)?.text || "";
  const err = async (f) => { try { await f(); return ""; } catch (e) { return e.message; } };
  const goodReport = "changed: x\nproof: W1 → works (test log) · W2 → checked by Sweep: PASS\nundo: revert\nsurprises: none\nopen: none";

  // 1. close as done
  ok("B1 done without a report is refused", /report/.test(await err(() => api.call("thoughts.close", { room: "D", job: "J1", state: "done" }))));
  ok("B1 done with a report missing W2 is refused", /W2/.test(await err(() => api.call("thoughts.close", { room: "D", job: "J1", state: "done", report: "proof: W1 → works" }))));
  const r1 = await api.call("thoughts.close", { room: "D", job: "J1", state: "done", report: goodReport, evidence: "/tmp/j429/J1.log; Sweep PASS" });
  const j1 = await job("J1");
  ok("B1 closed as done", r1.state === "done" && j1.state === "done", JSON.stringify(r1));
  ok("B1 the report and evidence are kept", /W2 → checked by Sweep/.test(j1.report) && /evidence: \/tmp\/j429\/J1.log/.test(j1.report));
  ok("B1 the card line shows done", /⟦J1 v1 · done⟧/.test(await line("N1")), await line("N1"));
  ok("B1 the history keeps v1 and notes the close", j1.version === 1 && j1.history.some((h) => /closed by Thoughts-D/.test(h.note || "")));
  ok("B1 not verified by the close itself", j1.state !== "verified");
  ok("B1 verify_work by the agent that did it is refused", /can't verify/.test(await err(() => api.call("thoughts.verify", { room: "D", job: "J1", by: "Atlas" }))));
  ok("B1 verify_work by a second agent works", (await api.call("thoughts.verify", { room: "D", job: "J1", by: "Sweep" })).state === "verified");
  ok("B1 a stopped job can be closed too", (await api.call("thoughts.close", { room: "D", job: "J2", state: "done", report: goodReport, by: "Pocket" })).state === "done");
  ok("B1 by names who closed it", (await job("J2")).history.some((h) => /closed by Pocket \(for Thoughts-D\)/.test(h.note || "")));
  // 2. obsolete
  ok("B2 obsolete without a reason is refused", /reason/.test(await err(() => api.call("thoughts.close", { room: "D", job: "J3", state: "obsolete" }))));
  await api.call("thoughts.close", { room: "D", job: "J3", state: "obsolete", reason: "J27 replaced the orange pin colour" });
  const j3 = await job("J3");
  ok("B2 closed as obsolete with its reason", j3.state === "obsolete" && j3.history.some((h) => /J27 replaced/.test(h.note || "")));
  ok("B2 the card line shows obsolete", /⟦J3 v1 · obsolete⟧/.test(await line("N3")), await line("N3"));
  ok("B2 an obsolete job can't be verified", /only a done job/.test(await err(() => api.call("thoughts.verify", { room: "D", job: "J3", by: "Sweep" }))));
  ok("B2 a closed job can't be closed again", /only a running or stopped/.test(await err(() => api.call("thoughts.close", { room: "D", job: "J3", state: "done", report: goodReport }))));
  ok("B2 a bad state is refused", /done or obsolete/.test(await err(() => api.call("thoughts.close", { room: "D", job: "J4", state: "verified", report: goodReport }))));

  // 3. one reply with several reports: Thoughts asks Atlas, Atlas answers with sections
  got.length = 0;
  await api.call("thoughts.ask", { room: "D", agent: "Atlas", question: "please send your reports" });
  await sleep(500);
  const ask = JSON.stringify(got).match(/request_id[^"]*"[^"]*"([0-9a-f-]{36})/) || JSON.stringify(got).match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/);
  ok("B3 the fake agent got Thoughts' question", !!ask, JSON.stringify(got).slice(0, 200));
  const reply = `Reports.\n\n=== J4 v1: four ===\n${goodReport}\n\n=== J5 v1: five ===\nchanged: y\nproof: W1 → fine · W2 → Sweep PASS\n\n=== J6 v1: not mine ===\nproof: W1 → a · W2 → b\n\n=== J7 v1: half ===\nproof: W1 → fine\n`;
  await agent.call("talk.reply", { request_id: ask[1], text: reply });
  await sleep(300);
  ok("B3 J4 done from its section", (await job("J4")).state === "done");
  ok("B3 J5 done from its section", (await job("J5")).state === "done" && /=== J5/.test((await job("J5")).report) && !/=== J4/.test((await job("J5")).report));
  ok("B3 J6 (Bolt's) not counted", (await job("J6")).state === "running");
  ok("B3 J7 (W2 missing) stays running", (await job("J7")).state === "running");
  const th = fs.readFileSync(path.join(S, "thoughts", "D.thread.jsonl"), "utf8");
  ok("B3 Thoughts is told about each", /J4 v1: done ✓/.test(th) && /J5 v1: done ✓/.test(th) && /J6: not counted/.test(th) && /J7 v1: NOT done: its section doesn't answer W2/.test(th));
  // 4. the same as a plain talk message to Thoughts-D
  await agent.call("talk", { to: ["Thoughts-D"], text: `=== J7 v1: half, now whole ===\nproof: W1 → fine · W2 → Sweep PASS\n\n=== J8 v1: eight ===\nproof: W1 → ok · W2 → ok` });
  await sleep(300);
  ok("B4 J7 and J8 done from a plain talk message", (await job("J7")).state === "done" && (await job("J8")).state === "done");
  await agent.call("talk", { to: ["Thoughts-D"], text: "just a note: W1 → fine · W2 → fine (no section header)" });
  await sleep(300);
  ok("B4 a plain message without sections changes nothing (J9 stays running)", (await job("J9")).state === "running");
  // 5. CloseCheck's cases (J440 review)
  const reqId = async (f) => { got.length = 0; await f(); await sleep(500); return (JSON.stringify(got).match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/) || [])[1]; };
  const q2 = await reqId(() => api.call("thoughts.ask", { room: "D", agent: "Atlas", question: "reports?" }));
  await agent.call("talk.reply", { request_id: q2, text: `=== J10 v1 ===\nproof: W1 → a · W2 → b\n\n=== J11 v1: example only ===\nThis is only a code sample, NOT a report:\n\`\`\`text\n=== J9 v1 ===\nW1 → first PASS · W2 → second PASS\n\`\`\`\n` });
  await sleep(300);
  ok("B5 a section on an old version (J10 v1, now v2) isn't counted", (await job("J10")).state === "running");
  ok("B5 a header inside a code fence isn't counted (J9)", (await job("J9")).state === "running");
  ok("B5 W lines only inside a code fence don't count (J11 still running)", (await job("J11")).state === "running");
  const w = await api.call("thoughts.work", { room: "D", agent: "Atlas", goal: "a new job", angus: "do it", done_when: ["W1 first", "W2 second"] });
  const newJob = w.job || w.id; await sleep(300);
  const q3 = (JSON.stringify(got).match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/) || [])[1];
  await agent.call("talk.reply", { request_id: q3, text: `${newJob} unfinished, still needs all checks.\n\n=== J11 v1 ===\nproof: W1 → first PASS · W2 → second PASS` });
  await sleep(300);
  ok("B5 another job's section counts for it (J11 done)", (await job("J11")).state === "done");
  ok(`B5 the request's own job (${newJob}) doesn't borrow J11's proof`, (await job(newJob)).state === "running", (await job(newJob)).state);
  // 6. CloseCheck round 2
  ok("B6 a report over 8000 characters is refused, not cut", /8000/.test(await err(() => api.call("thoughts.close", { room: "D", job: "J9", state: "done", report: "x".repeat(8100) + "\nW1 → PASS · W2 → PASS", evidence: "e" }))) && (await job("J9")).state === "running");
  await api.call("thoughts.close", { room: "D", job: "J9", state: "obsolete", reason: "test" });
  await api.call("thoughts.revise", { room: "D", job: "J9", goal: "reopened", reason: "test reopen" }).catch((e) => console.log("   revise:", e.message));
  const j9 = JSON.parse(fs.readFileSync(path.join(S, "briefs.json"), "utf8")).briefs.J9;
  ok("B6 reopening an obsolete job clears its obsolete reason", j9.state === "running" && !("obsolete_reason" in j9) && j9.version === 2, `${j9.state} v${j9.version} ${j9.obsolete_reason || ""}`);
  await agent.call("talk", { to: ["Thoughts-D"], text: "=== J12 v1 ===\nproof: W1 → a · W2 → b" });
  await sleep(300);
  ok("B6 a section sent to Thoughts-D doesn't close a world-E job", (await job("J12")).state === "running");
  // 7. round 3: a single own section on an old version
  const w2 = await api.call("thoughts.work", { room: "D", agent: "Atlas", goal: "versioned", angus: "x", done_when: ["W1 a", "W2 b"] }); await sleep(300);
  const vj = w2.job || w2.id;
  await api.call("thoughts.revise", { room: "D", job: vj, goal: "versioned v2", reason: "t" }).catch(() => {});
  const q4 = await reqId(() => api.call("thoughts.ask", { room: "D", agent: "Atlas", question: "report?" }));
  await agent.call("talk.reply", { request_id: q4, text: `=== ${vj} v1 ===\nproof: W1 → a · W2 → b` }); await sleep(300);
  ok(`B7 a lone section on v1 doesn't close ${vj} v2`, (await job(vj)).state === "running" && (await job(vj)).version === 2, `${(await job(vj)).state} v${(await job(vj)).version}`);
  api.close?.(); agent.close?.();
} catch (e) { fails++; console.log("FAIL", e.stack); }
finally { d.kill(); }
console.log(fails ? `${fails} FAILED (state ${S})` : "all passed"); process.exit(fails ? 1 : 0);
