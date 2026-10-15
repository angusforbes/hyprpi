#!/usr/bin/env node
// J622 (Angus: "a task agent can be promoted to become a project agent").
//   A) lib/promote.mjs (pure, fake clock): an unnamed, project-less agent with sustained work is proposed to its world's
//      Thoughts once a day; named agents, project members, helpers, twins, idle-only agents aren't.
//   B) an isolated daemon (own socket/state/config, no Hyprland; Thoughts is a stub that logs what it gets), fake agents:
//      W2 an unnamed agent with no project that works 3 turns (limit lowered by env) -> ONE "[board care] … no name and no
//         project" line to Thoughts of its world; a named one and a project member doing the same -> none; not repeated.
//      W3 thoughts.promote: the agent gets a name and icon, a new project with it as member and owner, its running loose job
//         moves along, it is told in its window, and its connection/session is the same one (no restart). Attaching to an
//         existing project and reopening an archived one work too; bad input is refused.
//   node test/run.mjs test/promote-agent.mjs   (exit 0 = pass)
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { requireSandbox } from "./guard/sandbox.mjs";
import { createPromoteWatch } from "../lib/promote.mjs";
await requireSandbox(import.meta.url);
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0; const ok = (n, c, x = "") => { if (!c) fails++; console.log(`${c ? "ok  " : "FAIL"} ${n}${x ? ": " + x : ""}`); };

// ---- A) pure
{
  let t = 1e12; const sent = [];
  const A = [
    { id: "hp-anon1", conn: {}, room: "D", cwd: "/home/u/Work/vibezAI" },        // unnamed, no project: the case
    { id: "hp-named", conn: {}, room: "D", name: "Atlas" },                       // named
    { id: "hp-member", conn: {}, room: "D" },                                     // unnamed but in a project
    { id: "hp-child", conn: {}, room: "D" },                                      // a spawned helper
    { id: "hp-twin", conn: {}, room: "D", twinOf: "hp-named" },                   // a twin
    { id: "hp-quiet", conn: {}, room: "D" },                                      // unnamed, barely worked
    { id: "hp-gone", room: "D" },                                                 // closed
  ];
  const w = createPromoteWatch({ agents: () => A, inProject: (id) => id === "hp-member", isHelper: (a) => a.id === "hp-child", now: () => t, alert: (room, text, a) => sent.push({ room, text, id: a.id }) });
  for (const a of A) for (let i = 0; i < 6; i++) w.onTurnEnd(a, 60000);
  w.onTurnEnd({ id: "hp-quiet2" }, 1);
  A.find((a) => a.id === "hp-quiet") && (w.state("hp-quiet").turns = 2, w.state("hp-quiet").ms = 2 * 60000);
  w.check();
  ok("A only the unnamed, project-less, non-helper agent with sustained work is proposed", JSON.stringify(sent.map((s) => s.id)) === '["hp-anon1"]', JSON.stringify(sent.map((s) => s.id)));
  ok("A the line names it, its turns and minutes, where it works, and the promote_agent tool; Thoughts decides", /pi·non1 has no name and no project, but it has worked 6 turns \(6 min active\) in ~\/Work\/vibezAI/.test(sent[0]?.text) && /promote_agent/.test(sent[0]?.text) && /Don't ask Angus/.test(sent[0]?.text), sent[0]?.text);
  ok("A to its own world", sent[0]?.room === "D");
  t += 3600e3; w.check();
  ok("A not again within a day", sent.length === 1);
  t += 24 * 3600e3; w.check();
  ok("A again after a day if still unpromoted", sent.length === 2);
  w.forget("hp-anon1"); t += 25 * 3600e3; w.check();
  ok("A forget (after a promotion) clears its work count", sent.length === 2);
  // (PromoteCheck F1) undefined / 0 overrides keep the defaults: one short turn is not enough
  const C = [{ id: "hp-one", conn: {}, room: "D" }], s3 = [];
  const w3 = createPromoteWatch({ agents: () => C, inProject: () => false, now: () => t, opts: { turns: undefined, minutes: 0 }, alert: (room, text) => s3.push(text) });
  w3.onTurnEnd(C[0], 1000); w3.check();
  ok("A undefined / 0 overrides keep the defaults (6 turns, 30 min): one short turn proposes nothing", s3.length === 0);
  // minutes alone are enough
  const B = [{ id: "hp-long", conn: {}, room: "E" }], s2 = [];
  const w2 = createPromoteWatch({ agents: () => B, inProject: () => false, now: () => t, alert: (room, text) => s2.push(text) });
  w2.onTurnEnd(B[0], 31 * 60000); w2.check();
  ok("A one 31-minute turn is enough (minutes threshold)", s2.length === 1);
}

// ---- B) daemon
const S = fs.mkdtempSync(path.join(os.tmpdir(), "j622-")), cfg = path.join(S, "cfg"), sock = path.join(S, "d.sock"), tlog = path.join(S, "stub-pi-log");
fs.mkdirSync(path.join(cfg, "hyprpi"), { recursive: true }); fs.mkdirSync(tlog); fs.mkdirSync(path.join(S, "boards"));
const stub = path.join(S, "pi-stub");
fs.writeFileSync(stub, `#!/bin/sh\nexec cat >> ${tlog}/$$.log\n`, { mode: 0o755 });
fs.writeFileSync(path.join(cfg, "hyprpi", "config.json"), JSON.stringify({ roomToThoughts: false, pi: stub, worldSize: 10 }));
fs.writeFileSync(path.join(cfg, "hyprpi", "hyprpi.jsonc"), JSON.stringify({ auth: { enabled: false }, upkeep: { refresh: { enabled: false }, autoReload: { enabled: false } } }));
const now = Date.now();
fs.writeFileSync(path.join(S, "boards", "D.json"), JSON.stringify({ room: "D", projects: [
  { id: "p-wk", name: "workshop", title: "odds", icon: "🔧", status: "active", members: ["hp-anon"], writer: "", created: now, updated: now, by: "x", where: null, next_step: null, seq: { D: 0, N: 1, H: 0 }, items: [{ h: "N1", sec: "next", text: "⟦J1 v1 · running⟧ build the B key", by: { id: "", name: "Thoughts-D" }, ts: now, updated: now }] },
  { id: "p-mem", name: "memberproj", title: "x", icon: "📦", status: "active", members: ["hp-member"], writer: "hp-member", created: now, updated: now, by: "x", where: null, next_step: null, seq: { D: 0, N: 0, H: 0 }, items: [] },
  { id: "p-old", name: "oldproj", title: "an old one", icon: "🗄", status: "archived", members: [], writer: "", created: now, updated: now, by: "x", where: null, next_step: null, seq: { D: 0, N: 0, H: 0 }, items: [] },
] }));
fs.writeFileSync(path.join(S, "briefs.json"), JSON.stringify({ next: 5, briefs: { J1: { id: "J1", version: 1, state: "running", created: now, updated: now, project: "p-wk", projectName: "workshop", item: "N1", agent: "hp-anon", agent_name: "pi·anon", from: "Thoughts-D", room: "D", fields: { goal: "build the B key", angus: "x", done_when: ["W1 a"] }, history: [{ version: 1, state: "running", ts: now, fields: { goal: "build the B key" } }] } } }));
const env = { ...process.env, HYPRPI_SOCKET: sock, HYPRPI_STATE: S, XDG_CONFIG_HOME: cfg, HYPRLAND_INSTANCE_SIGNATURE: "j622-bogus", HYPRPI_NO_ENSURE: "1", HYPRPI_UPKEEP_MS: "3600000",
  HYPRPI_PROMOTE_TURNS: "3", HYPRPI_PROMOTE_MINUTES: "999", HYPRPI_PROMOTE_CHECK_MS: "500" };
delete env.HYPRPI_AGENT_ID; delete env.HYPRPI_WORKSPACE;
const d = spawn(process.execPath, [path.join(ROOT, "bin/hyprpi"), "daemon"], { env, stdio: ["ignore", "pipe", "pipe"] }); const dl = fs.openSync(path.join(S, "d.log"), "w"); d.stdout.on("data", (b) => fs.writeSync(dl, b)); d.stderr.on("data", (b) => fs.writeSync(dl, b));
try {
  for (let i = 0; i < 50 && !fs.existsSync(sock); i++) await sleep(200);
  const { connect } = await import(path.join(ROOT, "lib/client.mjs"));
  const got = {};
  const fake = async (id, name, ws) => { got[id] = []; const c = await connect({ path: sock, onEvent: (ev, data) => got[id].push({ ev, data }) }); await c.call("agent.hello", { agent_id: id, pid: process.pid, ...(name ? { name } : {}), want_workspace: ws, cwd: path.join(S, "vibezAI") }); return c; };
  const anon = await fake("hp-anon", "", 32), named = await fake("hp-named", "Atlas", 33), member = await fake("hp-member", "", 34);
  const api = await connect({ path: sock, onEvent: () => {} });
  const turns = async (c, n) => { for (let i = 0; i < n; i++) { await c.call("agent.update", { status: "working" }); await sleep(60); await c.call("agent.update", { status: "idle" }); await sleep(60); } };
  await turns(anon, 3); await turns(named, 3); await turns(member, 3);
  await sleep(2500);
  const tl = () => fs.readdirSync(tlog).map((f) => fs.readFileSync(path.join(tlog, f), "utf8")).join("\n");
  const cares = () => (tl().match(/\[board care\] pi·[a-z0-9]{4} has no name and no project/g) || []);
  ok("B W2 the unnamed agent in only @workshop is proposed to Thoughts-D", /\[board care\] pi·anon has no name and no project, but it has worked 3 turns/.test(tl()), tl().slice(-400));
  ok("B W2 … the named agent and the project member are not", !/pi·amed|Atlas has no name|pi·mber has no name/.test(tl()));
  await turns(anon, 3); await sleep(2000);
  ok("B W2 … once (not again within the day, though it keeps working)", cares().length === 1, String(cares().length));

  // W3 promote
  const err = async (f) => { try { await f(); return ""; } catch (e) { return e.message; } };
  ok("B W3 a name is needed", /name/.test(await err(() => api.call("thoughts.promote", { room: "D", agent: "pi·anon", project: "vibez" }))));
  ok("B W3 a project is needed", /project/.test(await err(() => api.call("thoughts.promote", { room: "D", agent: "pi·anon", name: "Vibe" }))));
  ok("B W3 another world's Thoughts can't promote it", /world/.test(await err(() => api.call("thoughts.promote", { room: "E", agent: "pi·anon", name: "Vibe", project: "vibez" }))));
  ok("B W3 a name that's a project is refused", /project/.test(await err(() => api.call("thoughts.promote", { room: "D", agent: "pi·anon", name: "memberproj", project: "vibez" }))));
  ok("B W3 a taken name is refused", /taken/.test(await err(() => api.call("thoughts.promote", { room: "D", agent: "pi·anon", name: "Atlas", project: "vibez" }))));
  // (PromoteCheck F2) a refusal leaves the agent unchanged
  const before = await anon.call("whoami", {});
  ok("B W3 a one-letter project is refused …", /project name/.test(await err(() => api.call("thoughts.promote", { room: "D", agent: "pi·anon", name: "Vibe", project: "v" }))));
  ok("B W3 … a bad project icon is refused …", /icon/.test(await err(() => api.call("thoughts.promote", { room: "D", agent: "pi·anon", name: "Vibe", project: "vibez", project_icon: "abc" }))));
  ok("B W3 … a name over 60 characters is refused …", /1-60/.test(await err(() => api.call("thoughts.promote", { room: "D", agent: "pi·anon", name: "L".repeat(63), project: "longproj" }))));
  const after = await anon.call("whoami", {}), b0 = await api.call("board.get", { room: "D" });
  ok("B W3 … and none of them renamed the agent or made a project", after.name === before.name && !after.name && !b0.projects.some((x) => ["v", "vibez"].includes(x.name)), JSON.stringify({ name: after.name }));
  got["hp-anon"].length = 0;
  const r = await api.call("thoughts.promote", { room: "D", agent: "pi·anon", name: "Vibe", icon: "🎹", project: "vibez", title: "vibezAI: music toy" });
  await sleep(400);
  const who = await anon.call("whoami", {});
  const board = await api.call("board.get", { room: "D" }), pr = board.projects.find((x) => x.name === "vibez");
  ok("B W3 promoted: name and icon set", r.agent === "Vibe" && r.icon === "🎹" && who.name === "Vibe" && who.icon === "🎹", JSON.stringify({ r, who }));
  ok("B W3 a new project, with it as member and owner (writer)", pr && pr.members.includes("hp-anon") && pr.writer === "hp-anon" && pr.status === "active" && r.made === "created", JSON.stringify(pr && { m: pr.members, w: pr.writer, s: pr.status }));
  ok("B W3 its running loose job moved to the project", JSON.stringify(r.moved) === '["J1"]' && (await api.call("thoughts.briefs", { id: "J1" })).project === "vibez", JSON.stringify(r.moved));
  const msgs = got["hp-anon"].filter((g) => g.ev === "prompt").map((g) => g.data.text).join("\n");
  ok("B W3 it is told in its window: who it is now, the project it owns, carry on", /promoted you: you are now 🎹 Vibe, the owner \(writer\) of @vibez/.test(msgs) && /carry on where you were/.test(msgs) && /rename_self once with name "Vibe"/.test(msgs), msgs.slice(0, 300));
  ok("J644 W2 the promotion message points the new project agent at the handbook", /read the project agent handbook in full once \(~\/Obsidian\/Notes\/Project agent handbook\.md\)/.test(msgs), (msgs.match(/You are now a project agent[^.]*\./) || [""])[0]);
  ok("B W3 no restart: the same connection still answers and the daemon sent it no restart or reload", (await anon.call("whoami", {})).name === "Vibe" && !got["hp-anon"].some((g) => g.ev === "restart" || g.ev === "reload"));
  // attach to an existing project, reopen an archived one
  const r2 = await api.call("thoughts.promote", { room: "D", agent: "pi·mber", name: "Keeper", project: "memberproj" });
  const pm = (await api.call("board.get", { room: "D" })).projects.find((x) => x.name === "memberproj");
  ok("B W3 attach to an existing project: it becomes its owner", r2.made === "joined" && pm.writer === "hp-member");
  const r3 = await api.call("thoughts.promote", { room: "D", agent: "Atlas", name: "Atlas2", project: "oldproj" });
  const po = (await api.call("board.get", { room: "D" })).projects.find((x) => x.name === "oldproj");
  ok("B W3 an archived project is reopened, with it as member and owner", r3.made === "reopened" && po.status === "active" && po.members.includes("hp-named") && po.writer === "hp-named", JSON.stringify(r3));
  // ---- J638 (Angus: "the agent is the same name as the project"): agent Flow owns @flow
  const flowA = await fake("hp-flowa", "", 35);
  ok("J638 W1 a name equal to ANOTHER project is still refused", /is a project on the board/.test(await err(() => api.call("thoughts.promote", { room: "D", agent: "pi·lowa", name: "Vibez", project: "flow" }))));
  ok("J638 W1 … and the agent is unchanged", !(await flowA.call("whoami", {})).name);
  const rf = await api.call("thoughts.promote", { room: "D", agent: "pi·lowa", name: "Flow", icon: "🌊", project: "flow", title: "the project-agent pilot" });
  const pf = (await api.call("board.get", { room: "D" })).projects.find((x) => x.name === "flow");
  ok("J638 W1 promoting to name Flow owning a new @flow succeeds", rf.agent === "Flow" && rf.made === "created" && pf?.writer === "hp-flowa" && (await flowA.call("whoami", {})).name === "Flow", JSON.stringify(rf));
  ok("J638 W1 Flow can re-assert its own name (rename_self → agent.update), the project's name", !(await err(() => flowA.call("agent.update", { name: "Flow" }))));
  ok("J638 W1 another agent can't take the name Flow, nor the name of a project it doesn't own", /taken|is a project on the board/.test(await err(() => named.call("agent.update", { name: "Flow" }))) && /is a project on the board/.test(await err(() => named.call("agent.update", { name: "vibez" }))));
  ok("J638 W1 a project can't be renamed to an agent's name (a second @flow can't be created)", /already a project|agent's name/.test(await err(() => api.call("board.project", { action: "create", room: "D", name: "flow" }))));
  // an existing project of that name, owned by someone else, taken over by promotion
  const flowB = await fake("hp-flowb", "", 36);
  const rk = await api.call("thoughts.promote", { room: "D", agent: "pi·lowb", name: "Memberproj", project: "memberproj" });
  ok("J638 W1 promoting to the name of an EXISTING project it is made owner of works too", rk.agent === "Memberproj" && rk.made === "joined" && (await api.call("board.get", { room: "D" })).projects.find((x) => x.name === "memberproj").writer === "hp-flowb", JSON.stringify(rk));
  // (SameNameCheck) an emoji-led name: the emoji is the icon, the rest the name; checked before anything changes
  const flowC = await fake("hp-flowc", "", 37);
  ok("J638 W1 '🌊 Vibez' (an emoji, then another project's name) is refused up front", /is a project on the board/.test(await err(() => api.call("thoughts.promote", { room: "D", agent: "pi·lowc", name: "🌊 Vibez", project: "ripple" }))) && !(await api.call("board.get", { room: "D" })).projects.some((x) => x.name === "ripple"));
  const rc = await api.call("thoughts.promote", { room: "D", agent: "pi·lowc", name: "🌀 Ripple", project: "ripple" });
  const wc = await flowC.call("whoami", {});
  ok("J638 W1 '🌀 Ripple' owning @ripple: name Ripple, icon 🌀", wc.name === "Ripple" && wc.icon === "🌀" && rc.made === "created", JSON.stringify(wc));
  flowC.close?.();
  // W2: routing
  got["hp-flowa"].length = 0;
  const ask = await api.call("thoughts.ask", { room: "D", agent: "Flow", question: "how is the pilot going?" }); await sleep(300);
  ok("J638 W2 ask_agent to 'Flow' reaches the agent", got["hp-flowa"].some((g) => /how is the pilot going/.test(JSON.stringify(g.data))), JSON.stringify(ask));
  got["hp-flowa"].length = 0;
  const req = await api.call("board.request", { room: "D", project: "flow", text: "status please", where: "room", via: "room-tui" }); await sleep(300);
  ok("J638 W2 an @flow room message reaches Flow, the project's owner", got["hp-flowa"].some((g) => g.ev === "prompt" && /Angus → @flow/.test(g.data.text) && /status please/.test(g.data.text)) && /Flow/.test(JSON.stringify(req)), JSON.stringify(req).slice(0, 200));
  got["hp-flowa"].length = 0;
  await api.call("agent.prompt", { agent: "Flow", text: "direct hello", via: "room-tui" }); await sleep(300);
  ok("J638 W2 an @Flow agent message (agent.prompt by name) reaches Flow", got["hp-flowa"].some((g) => g.ev === "prompt" && /direct hello/.test(g.data.text)));
  flowA.close?.(); flowB.close?.();
  api.close?.(); anon.close?.(); named.close?.(); member.close?.();
} catch (e) { fails++; console.log("FAIL", e.stack); }
finally { d.kill(); }
console.log(fails ? `promote-agent: ${fails} FAILED (state ${S})` : "promote-agent: all pass"); process.exit(fails ? 1 : 0);
