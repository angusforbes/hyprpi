#!/usr/bin/env node
// J647 (Angus: "why are we giving time/token budgets to our task agents? you can stop them whenever you want … it just creates
// noise and extra decisions for me … make sure this never ever happens again"). Replaces J381's test/budget-floor.mjs.
//   W1 a) the daemon: a spawn gets no caps, whatever budget the spawner passes or the policy holds (an isolated daemon, its own
//         config with the OLD J130/J381 budgets and floor, HYPRPI_ORCH_LAUNCH=/bin/true so no agent starts);
//      b) a child reporting a cap from an older extension (orch.budgetHit) is ignored: still running, no ⛽ note to Thoughts,
//         no escalation; orch.me hands it no caps (an older spawn's caps are lifted on hello);
//      c) the agent side (pi-extension/orch.ts): no cap check, no tool blocking, no extend_budget tool; spawn_agent has no
//         budget parameter and drops a stray one; Thoughts has no extend_budget either.
//   W3 no budget wording an agent could offer Angus: tool descriptions and guideline text in pi-extension/*.ts, lib/orch.mjs's
//      welcome and notices.
//   node test/run.mjs test/no-budgets.mjs   (exit 0 = pass)
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { requireSandbox } from "./guard/sandbox.mjs";
await requireSandbox(import.meta.url);
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0; const ok = (n, c, x = "") => { if (!c) fails++; console.log(`${c ? "ok  " : "FAIL"} ${n}${x ? ": " + x : ""}`); };

const T = fs.mkdtempSync(path.join(os.tmpdir(), "j647-")), sock = path.join(T, "d.sock"), state = path.join(T, "state"), cfg = path.join(T, "cfg"), tlog = path.join(T, "tlog");
fs.mkdirSync(state); fs.mkdirSync(path.join(cfg, "hyprpi"), { recursive: true }); fs.mkdirSync(tlog);
const stub = path.join(T, "pi-stub"); fs.writeFileSync(stub, `#!/bin/sh\nexec cat >> ${tlog}/$$.log\n`, { mode: 0o755 });
fs.writeFileSync(path.join(cfg, "hyprpi", "config.json"), JSON.stringify({ roomToThoughts: false, pi: stub, worldSize: 10 }));
// the OLD budgets and floor, as J130 / J381 left them: they must be ignored
fs.writeFileSync(path.join(cfg, "hyprpi", "hyprpi.jsonc"), JSON.stringify({ auth: { enabled: false }, upkeep: { refresh: { enabled: false }, autoReload: { enabled: false } },
  budgets: { tokens: 4000000, minutes: 480, floor: { tokens: 1000000, minutes: 120 }, floorByKind: { hard: { tokens: 1500000, minutes: 180 } } }, routing: { escalate: { onBudget: true, onFailedCheck: true } } }));
const env = { ...process.env, HYPRPI_SOCKET: sock, HYPRPI_STATE: state, XDG_CONFIG_HOME: cfg, HYPRPI_TEST: "1", HYPRPI_ORCH_LAUNCH: "/bin/true", HYPRLAND_INSTANCE_SIGNATURE: "j647-bogus", HYPRPI_NO_ENSURE: "1" };
for (const k of ["HYPRPI_AGENT_ID", "HYPRPI_ALLOW_HYPR", "HYPRPI_WORKSPACE"]) delete env[k];
const fd = fs.openSync(path.join(T, "daemon.log"), "w");
const d = spawn(process.execPath, [path.join(ROOT, "bin/hyprpi"), "daemon"], { env, stdio: ["ignore", fd, fd] });
try {
  for (let i = 0; i < 100 && !fs.existsSync(sock); i++) await sleep(100);
  const { connect } = await import(path.join(ROOT, "lib/client.mjs"));
  const c = await connect({ path: sock });
  const sp = (extra) => c.call("orch.spawn", { thoughts: "D", prompt: "test", name: "Nob" + Math.random().toString(36).slice(2, 6), ...extra });
  const none = { tokens: 0, minutes: 0 };
  const r1 = await sp({ budget: { tokens: 150000, minutes: 25 } }), r2 = await sp({}), r3 = await sp({ complexity: "hard", budget: { tokens: 5000000, minutes: 600 } });
  ok("W1a a spawner's small budget is ignored: no caps", JSON.stringify(r1.budget) === JSON.stringify(none), JSON.stringify(r1.budget));
  ok("W1a no budget given + the old policy budgets/floor: no caps", JSON.stringify(r2.budget) === JSON.stringify(none), JSON.stringify(r2.budget));
  ok("W1a a big budget is ignored too: no caps", JSON.stringify(r3.budget) === JSON.stringify(none), JSON.stringify(r3.budget));
  // the child itself, as an older extension would talk: hello, then a cap hit
  const kev = []; const kid = await connect({ path: sock, onEvent: (ev, data) => kev.push({ ev, data }) });
  await kid.call("agent.hello", { agent_id: r1.id, pid: process.pid, name: r1.name, want_workspace: 32, cwd: T });
  await sleep(2500);
  const lifts = () => kev.filter((e) => e.ev === "orch.budget" && e.data?.budget?.tokens === 0 && e.data?.budget?.minutes === 0 && e.data?.resumed === true);
  ok("W1b on (re)connect the child is sent 'no caps' (orch.budget 0/0, resumed): an older extension's cached caps are lifted", lifts().length >= 1, JSON.stringify(kev.map((e) => e.ev)));
  const me = await kid.call("orch.me", {});
  ok("W1b orch.me gives the child no caps", JSON.stringify(me?.budget) === JSON.stringify(none) && me?.status === "running", JSON.stringify(me));
  const n0 = lifts().length;
  const hit = await kid.call("orch.budgetHit", { what: "time budget (25 min)" }); await sleep(800);
  ok("W1b … and again when an older extension reports a cap, so a self-stopped one unblocks", lifts().length > n0);
  const all = (await c.call("orch.all", {})).children, mine = all.find((x) => x.id === r1.id);
  ok("W1b an older extension's cap hit is ignored: the child stays running", hit.ignored === true && mine.status === "running" && !/budget/.test(mine.state || ""), JSON.stringify({ hit, status: mine.status, state: mine.state }));
  const tl = fs.readdirSync(tlog).map((f) => fs.readFileSync(path.join(tlog, f), "utf8")).join("\n") + fs.readFileSync(path.join(T, "daemon.log"), "utf8");
  ok("W1b … no ⛽ note to Thoughts, no escalation, no 'waits for extend_budget'", !/⛽|extend_budget|hit its|⤴/.test(tl), (tl.match(/.{0,60}(⛽|extend_budget|hit its).{0,60}/) || [""])[0]);
  // a child stopped under an older daemon ("budget" status in orch.json) resumes when it says hello
  const welcome = fs.readFileSync(path.join(state, "orch.json"), "utf8");
  ok("W3 the child's welcome text has no budget wording", !/budget|a cap|at a cap/i.test(JSON.parse(welcome).children[r1.id]?.prompt || "") && !/Budget:/.test(welcome), "");
  kid.close(); c.close();
} catch (e) { fails++; console.log("FAIL", e.stack); }
finally { d.kill("SIGTERM"); await sleep(400); try { d.kill("SIGKILL"); } catch { /* gone */ } }

// W1c / W3: the agent side and the instructions
const orchTs = fs.readFileSync(path.join(ROOT, "pi-extension/orch.ts"), "utf8"), thTs = fs.readFileSync(path.join(ROOT, "pi-extension/thoughts.ts"), "utf8");
ok("W1c orch.ts: no cap check, no tool blocking, no budget steer", !/checkCap|budget reached|block: true, reason: "budget|orch\.budgetHit/.test(orchTs));
ok("W1c no extend_budget tool for agents or Thoughts", !/name: "extend_budget"/.test(orchTs) && !/name: "extend_budget"/.test(thTs));
ok("W1c spawn_agent (agents and Thoughts) has no budget parameter, and drops a stray one", !/budget: Type\./.test(orchTs) && !/budget: Type\./.test(thTs) && /budget: _ignored/.test(orchTs) && /budget: _ignored/.test(thTs));
const said = (src) => [...src.matchAll(/(?:description|promptSnippet|label): "((?:[^"\\]|\\.)*)"|"([^"\n]{40,})",?\n/g)].map((m) => m[1] || m[2] || "").join("\n");
const words = said(orchTs) + said(thTs) + said(fs.readFileSync(path.join(ROOT, "pi-extension/index.ts"), "utf8"));
const offending = words.split("\n").filter((l) => /budget/i.test(l) && !/no time or token (budget|limit)|never ask Angus about a helper's budget|no budgets/i.test(l));
ok("W3 no tool description or guideline offers or explains budgets (only 'there are none')", offending.length === 0, offending.join(" | ").slice(0, 300));
console.log(fails ? `no-budgets: ${fails} FAILED (state ${T})` : "no-budgets: all pass"); process.exit(fails ? 1 : 0);
