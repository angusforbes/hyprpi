#!/usr/bin/env node
// J728, the daemon wiring: an isolated daemon (temp socket, state, config; no pi, no window) with a fixture orch.json that makes
// fake agent "hp-kid" a child of fake agent "hp-mom". The child connects with a session file (agent.hello session) and flips
// working → done. Its turn wrote only plain text, so the parent gets exactly ONE orch.report event marked auto with that text.
// A second child, whose turn called report_to_parent (a real orch.report), gets no auto duplicate. A third answered with
// talk_reply: none either.
//   node test/run.mjs test/orch-auto-report-daemon.mjs   (exit 0 = pass; only inside the test guard)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { requireSandbox } from "./guard/sandbox.mjs";
await requireSandbox(import.meta.url);

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
let fails = 0; const ok = (n, c, x = "") => { if (!c) fails++; console.log(`${c ? "ok  " : "FAIL"} ${n}${x && !c ? ": " + x : ""}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const S = fs.mkdtempSync(path.join(os.tmpdir(), "j728d-")), cfg = path.join(S, "cfg"), sock = path.join(S, "d.sock");
fs.mkdirSync(path.join(cfg, "hyprpi"), { recursive: true });
fs.writeFileSync(path.join(cfg, "hyprpi", "config.json"), JSON.stringify({ roomToThoughts: false, pi: "/bin/cat", worldSize: 10, cwd: S, turnLines: false, topics: false }));
fs.writeFileSync(path.join(cfg, "hyprpi", "hyprpi.jsonc"), JSON.stringify({ auth: { enabled: false }, upkeep: { refresh: { enabled: false, rssMB: 0 }, autoReload: { enabled: false } } }));
const kid = (id, name) => ({ id, name, parent: "hp-mom", parentName: "Mom", room: "A", prompt: "play", model: "m", thinking: "", budget: { tokens: 0, minutes: 0 }, used: { tokens: 0 }, startedAt: Date.now() - 60000, status: "running", reports: [], escalations: 0, depth: 1 });
fs.writeFileSync(path.join(S, "orch.json"), JSON.stringify({ children: { "hp-kid": kid("hp-kid", "Kid"), "hp-rep": kid("hp-rep", "Rep"), "hp-ans": kid("hp-ans", "Ans"), "hp-fast": kid("hp-fast", "Fast") } }));
const T0 = Date.now() - 60000; // the turn happened before its end (real sessions are stamped as they go)
const iso = (k) => new Date(T0 + k * 1000).toISOString();
const sess = (name, says) => {
  const f = path.join(S, name + ".jsonl");
  const lines = [{ type: "session", id: name, timestamp: iso(0) }, { type: "message", timestamp: iso(1), message: { role: "user", content: [{ type: "text", text: "[hyprpi · Mom spawned you] play" }] } },
    ...says.map((m, i) => ({ type: "message", timestamp: iso(2 + i), message: { role: "assistant", content: m.tool ? [{ type: "toolCall", name: m.tool, arguments: m.args || {} }] : [{ type: "text", text: m.text }] } }))];
  fs.writeFileSync(f, lines.map((l) => JSON.stringify(l)).join("\n") + "\n"); return f;
};
const env = { ...process.env, HYPRPI_SOCKET: sock, HYPRPI_STATE: S, XDG_CONFIG_HOME: cfg, HYPRLAND_INSTANCE_SIGNATURE: "j728-bogus", HYPRPI_NO_ENSURE: "1", HYPRPI_UPKEEP_MS: "3600000" };
delete env.HYPRPI_AGENT_ID; delete env.HYPRPI_WORKSPACE;
const d = spawn(process.execPath, [path.join(ROOT, "bin/hyprpi"), "daemon"], { env, stdio: ["ignore", fs.openSync(path.join(S, "d.log"), "a"), fs.openSync(path.join(S, "d.log"), "a")] });
try {
  for (let i = 0; i < 50 && !fs.existsSync(sock); i++) await sleep(200);
  const { connect } = await import(path.join(ROOT, "lib/client.mjs"));
  const got = [];
  const mom = await connect({ path: sock, onEvent: (ev, data) => got.push({ ev, data }) });
  await mom.call("agent.hello", { agent_id: "hp-mom", pid: process.pid, name: "Mom", want_workspace: 1, cwd: S });
  const turn = async (id, name, says, during) => {
    const c = await connect({ path: sock, onEvent: () => {} });
    await c.call("agent.hello", { agent_id: id, pid: process.pid, name, want_workspace: 2, cwd: S, session: sess(name, says) });
    await c.call("agent.update", { status: "working" });
    if (during) await during(c);
    await c.call("agent.update", { status: "done" });
    return c;
  };
  const reportsFor = (id) => got.filter((e) => e.ev === "orch.report" && e.data?.child === id);
  const kidC = await turn("hp-kid", "Kid", [{ text: "GUESS: Iris, cinema, ? SHARE: K2" }]);
  const repC = await turn("hp-rep", "Rep", [{ tool: "report_to_parent", args: { text: "GUESS: ?, bakery, scarf" } }, { text: "Reported." }], (c) => c.call("orch.report", { text: "GUESS: ?, bakery, scarf" }));
  const ansC = await turn("hp-ans", "Ans", [{ tool: "talk_reply", args: { request_id: "x", text: "GUESS: Nina" } }, { text: "Ready." }]);
  await sleep(2500);
  const k = reportsFor("hp-kid"), r = reportsFor("hp-rep"), a = reportsFor("hp-ans");
  ok("a plain-text turn: exactly one auto report to the parent, with the child's text", k.length === 1 && /auto: its turn ended without report_to_parent/.test(k[0].data.text) && /GUESS: Iris, cinema/.test(k[0].data.text) && k[0].data.final === false, JSON.stringify(k));
  ok("a turn that reported: only its own report, no auto duplicate", r.length === 1 && !/auto:/.test(r[0].data.text), JSON.stringify(r));
  ok("a talk_reply turn: no auto report", a.length === 0, JSON.stringify(a));
  // the same child flips idle again (a status update with no new turn): still one
  await kidC.call("agent.update", { status: "working" }); await kidC.call("agent.update", { status: "idle" }); await sleep(2000);
  ok("a second status flip on the same turn: no duplicate", reportsFor("hp-kid").length === 1, JSON.stringify(reportsFor("hp-kid")));
  // the race: Fast's first turn ends, its second starts 100 ms later (before the 800 ms check) and ends after 1 s
  {
    const f = path.join(S, "Fast.jsonl"), now = Date.now();
    const L = (k, o) => JSON.stringify({ ...o, timestamp: new Date(now + k).toISOString() });
    fs.writeFileSync(f, [L(-5000, { type: "session", id: "Fast" }), L(-4000, { type: "message", message: { role: "user", content: [{ type: "text", text: "go" }] } }), L(-3000, { type: "message", message: { role: "assistant", content: [{ type: "text", text: "FIRST ANSWER" }] } })].join("\n") + "\n");
    const c = await connect({ path: sock, onEvent: () => {} });
    await c.call("agent.hello", { agent_id: "hp-fast", pid: process.pid, name: "Fast", want_workspace: 2, cwd: S, session: f });
    await c.call("agent.update", { status: "working" }); await c.call("agent.update", { status: "done" });
    await sleep(100);
    fs.appendFileSync(f, [L(200, { type: "message", message: { role: "user", content: [{ type: "text", text: "next" }] } }), L(300, { type: "message", message: { role: "assistant", content: [{ type: "text", text: "SECOND ANSWER" }] } })].join("\n") + "\n");
    await c.call("agent.update", { status: "working" }); await sleep(1000); await c.call("agent.update", { status: "done" }); await sleep(2500);
    const fr = reportsFor("hp-fast").map((e) => e.data.text);
    ok("a quick next turn doesn't hide the first: FIRST then SECOND, one each", fr.length === 2 && /FIRST ANSWER/.test(fr[0]) && /SECOND ANSWER/.test(fr[1]), JSON.stringify(fr));
    c.close();
  }
  const log = fs.readFileSync(path.join(S, "d.log"), "utf8");
  ok("the daemon log says it forwarded Kid's text", /Kid ended a turn without report_to_parent: its last text went to its parent/.test(log));
  for (const c of [kidC, repC, ansC, mom]) c.close();
} finally { d.kill("SIGTERM"); await sleep(400); fs.rmSync(S, { recursive: true, force: true }); }
console.log(fails ? `orch-auto-report-daemon: ${fails} FAILED` : "orch-auto-report-daemon: all pass");
process.exit(fails ? 1 : 0);
