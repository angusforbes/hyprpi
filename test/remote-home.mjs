#!/usr/bin/env node
// J543 (Angus: the remote daemon "turns Thoughts-A (any letter other than H) into a local fake world; it should route those to the
// laptop or refuse them, and refuse open_agent outside H"). An isolated daemon whose state is <tmp>/.hyprpi-h/state, i.e. what
// omnistation/remote.sh runs on world H's machine (no Hyprland, pi = /bin/cat). It serves world H only:
//   1. its rooms are H only (a stray rooms/A.jsonl doesn't make a world-A tab) and its current world is H, not A
//   2. talk / demand to Thoughts-A is refused with why (skipped), no Thoughts-A thread or room-A file is made; an unknown agent's
//      reason says agents of other worlds are on the laptop
//   3. thoughts.ask to Thoughts-A, thoughts.send / room.post / board.get for A, relayAsk for A: refused with why
//   4. open_agent (thoughts.open) and spawn_agent (orch.spawn) for world A are refused; `hyprpi new` on A's workspace is refused
//   5. world H itself still works: talk to Thoughts-H is delivered
//   6. open_agent / spawn_agent inside world H start the agent through ~/.hyprpi-h/remote.sh start (a stub here) and the list
//      marks it "opened", which the laptop's world-status.mjs turns into its window
//   8. bonk / ding / request / chime of its agents are kept as notices in the list; the laptop plays each new one once
//   7. started with an agent's identity in its env (an agent's own ensure), the daemon passes none of it to the pi it runs
//   node test/remote-home.mjs   (exit 0 = pass)
import fs from "node:fs"; import os from "node:os"; import path from "node:path"; import { spawn, spawnSync } from "node:child_process";
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
let fails = 0; const ok = (n, c, x = "") => { if (!c) fails++; console.log(`${c ? "ok  " : "FAIL"} ${n}${x ? ": " + x : ""}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const { connect } = await import(path.join(ROOT, "lib/client.mjs"));
const { remoteHome } = await import(path.join(ROOT, "lib/remote-world.mjs"));
ok("0 remoteHome: from the state path, the env, and off elsewhere",
  remoteHome({ HYPRPI_STATE: "/home/u/.hyprpi-h/state" }) === "H" && remoteHome({ HYPRPI_STATE: "/home/u/.hyprpi-i/state/" }) === "I"
  && remoteHome({ HYPRPI_STATE: "/home/u/.local/state/hyprpi" }) === "" && remoteHome({}) === "" && remoteHome({ HYPRPI_REMOTE_HOME: "c" }) === "C"
  && remoteHome({ HYPRPI_STATE: "/x/.hyprpi-h/state", HYPRPI_REMOTE_HOME: "-" }) === "" && remoteHome({ HYPRPI_STATE: "/x/.hyprpi-h/state", HYPRPI_SANDBOX_WORLD: "G" }) === "");
{ // J543: which remote agents the laptop's world-status opens a window for (omnistation/auto-open.mjs)
  const { pickAutoOpens } = await import(path.join(ROOT, "omnistation/auto-open.mjs"));
  const now = 1e12, raw = [{ id: "h-farside", workspace: 74, opened: { at: now - 5000, by: "Thoughts-H" } }, { id: "h-omni-alpha", workspace: 71 }, { id: "h-old", opened: { at: now - 3600e3 } }, { id: "h-win", opened: { at: now } }, { id: "h-done", opened: { at: now } }, { id: "h-far", workspace: 5, opened: { at: now } }];
  const ag = [{ id: "h-farside", launch: "farside" }, { id: "h-omni-alpha", launch: "omni-alpha" }, { id: "h-old", launch: "old" }, { id: "h-win", launch: "win", address: "0x1" }, { id: "h-done", launch: "done" }, { id: "h-far", launch: "far" }];
  const got = pickAutoOpens(raw, ag, { "h-done": now - 1000 }, now, 71, 80);
  ok("0 auto-open: the workspace it was opened for when it has none", pickAutoOpens([{ id: "h-x", opened: { at: now, ws: 76 } }], [{ id: "h-x", launch: "x" }], {}, now, 71, 80)[0]?.ws === 76);
  ok("0 auto-open: only daemon-opened, recent, windowless, not yet opened; its workspace (or the world's first)", JSON.stringify(got) === JSON.stringify([{ id: "h-farside", launch: "farside", ws: 74 }, { id: "h-far", launch: "far", ws: 71 }]), JSON.stringify(got));
}
{ // J543: on a remote machine a routed model is that machine's own name for it (its enabledModels); the laptop: unchanged
  const { localModel, routeModel } = await import(path.join(ROOT, "lib/routing.mjs"));
  const L = ["nv-inference/azure/anthropic/claude-opus-5-5", "nv-inference/azure/anthropic/claude-sonnet-5-5", "nv-inference/azure/anthropic/claude-haiku-5-5", "nv-inference/openai/openai/gpt-6.1-sol"];
  ok("0 localModel: same id, else same family; unknown and listed ones unchanged", localModel("anthropic/claude-sonnet-5-5", L) === L[1] && localModel("anthropic/claude-haiku-4-5", L) === L[2] && localModel("openai-codex/gpt-6.1-sol", L) === L[3] && localModel("acme/x-1", L) === "acme/x-1" && localModel(L[0], L) === L[0]);
  const P = { routing: { default: "ordinary", ladder: ["anthropic/claude-sonnet-5-5:medium"], kinds: { ordinary: 0 } } };
  const was = process.env.HYPRPI_REMOTE_HOME; process.env.HYPRPI_REMOTE_HOME = "-";
  ok("0 routeModel off a remote machine: as configured", routeModel({ complexity: "ordinary" }, P).model === "anthropic/claude-sonnet-5-5");
  // the hub has no enabledModels: its providers' models (~/.pi/agent/models.json) are the list; every kind gets one of them
  const PD = fs.mkdtempSync(path.join(os.tmpdir(), "j543pi-")), wasDir = process.env.PI_CODING_AGENT_DIR;
  fs.writeFileSync(path.join(PD, "settings.json"), JSON.stringify({ defaultProvider: "nv-inference" }));
  fs.writeFileSync(path.join(PD, "models.json"), JSON.stringify({ providers: { "nv-inference": { models: L.map((x) => ({ id: x.replace(/^nv-inference\//, "") })) } } }));
  process.env.PI_CODING_AGENT_DIR = PD; process.env.HYPRPI_REMOTE_HOME = "I";
  const P2 = { routing: { default: "ordinary", ladder: ["anthropic/claude-haiku-4-5:low", "anthropic/claude-sonnet-5-5:medium", "anthropic/claude-opus-5-5:high"], kinds: { simple: 0, ordinary: 1, hard: 2, review: "openai-codex/gpt-6.1-sol:high" } } };
  const got = ["simple", "ordinary", "hard", "review"].map((k) => routeModel({ complexity: k }, P2).model);
  ok("0 on a remote machine every kind routes to a model it has (simple haiku, ordinary sonnet, hard opus, review gpt-6.1-sol)", JSON.stringify(got) === JSON.stringify([L[2], L[1], L[0], L[3]]), JSON.stringify(got));
  const { nextStep } = await import(path.join(ROOT, "lib/routing.mjs"));
  const up = nextStep(L[2], "low", P2), top = nextStep(L[0], "high", P2);
  ok("0 escalation on a remote machine: its haiku-5-5 (simple) steps up to its sonnet-5-5; its opus is the top", up?.model === L[1] && up.step === 1 && top === null, JSON.stringify([up, top]));
  if (wasDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = wasDir;
  fs.rmSync(PD, { recursive: true, force: true });
  if (was === undefined) delete process.env.HYPRPI_REMOTE_HOME; else process.env.HYPRPI_REMOTE_HOME = was;
}
const T = fs.mkdtempSync(path.join(os.tmpdir(), "j543-")), ROOTH = path.join(T, ".hyprpi-h"), S = path.join(ROOTH, "state"), cfg = path.join(T, "cfg"), sock = path.join(T, "d.sock");
fs.mkdirSync(path.join(S, "rooms"), { recursive: true }); fs.mkdirSync(path.join(cfg, "hyprpi"), { recursive: true });
fs.writeFileSync(path.join(ROOTH, "ws"), "71\n");
fs.writeFileSync(path.join(S, "rooms", "A.jsonl"), ""); // a stray file from the old fake world A
// pi: a stand-in that notes the agent identity it was given (J543: the daemon an agent's ensure started had omni-alpha's) and is cat
const PI = path.join(T, "pi"); fs.writeFileSync(PI, `#!/bin/sh\necho "pi $1 RPC=\${HYPRPI_REMOTE_RPC:-} NAME=\${HYPRPI_NAME:-} ID=\${HYPRPI_AGENT_ID:-}" >> ${JSON.stringify(path.join(T, "pi.log"))}\n[ "$1" = --version ] && exit 0\nexec cat\n`, { mode: 0o755 });
fs.writeFileSync(path.join(cfg, "hyprpi", "config.json"), JSON.stringify({ roomToThoughts: false, pi: PI, worldSize: 10 }));
fs.writeFileSync(path.join(cfg, "hyprpi", "hyprpi.jsonc"), JSON.stringify({ auth: { enabled: false }, upkeep: { refresh: { enabled: false }, autoReload: { enabled: false } } }));
const env = { ...process.env, HYPRPI_SOCKET: sock, HYPRPI_STATE: S, XDG_CONFIG_HOME: cfg, HYPRPI_NO_ENSURE: "1", HYPRPI_UPKEEP_MS: "3600000", HYPRPI_NOTIFY_TEST: "1" };
for (const k of ["HYPRPI_AGENT_ID", "HYPRPI_WORKSPACE", "HYPRLAND_INSTANCE_SIGNATURE", "WAYLAND_DISPLAY", "HYPRPI_REMOTE_HOME", "HYPRPI_SANDBOX_WORLD"]) delete env[k];
Object.assign(env, { HYPRPI_REMOTE_RPC: "1", HYPRPI_NAME: "omni-alpha", HYPRPI_AGENT_ID: "h-omni-alpha", HYPRPI_REMOTE_WORLD: "H" }); // as when omni-alpha's own ensure starts it
const d = spawn(process.execPath, [path.join(ROOT, "bin/hyprpi"), "daemon"], { env, stdio: ["ignore", fs.openSync(path.join(T, "d.log"), "w"), fs.openSync(path.join(T, "d.err"), "w")] });
for (let i = 0; i < 50 && !fs.existsSync(sock); i++) await sleep(200);
try {
  const api = await connect({ path: sock, onEvent: () => {} });
  const err = async (f) => { try { await f(); return ""; } catch (e) { return e.message; } };
  const away = /world A isn't on this machine/;
  // 1
  const lst = await api.call("list", {});
  ok("1 rooms: world H only (the stray A file is ignored)", JSON.stringify((lst.rooms || []).map((r) => r.id)) === '["H"]', JSON.stringify((lst.rooms || []).map((r) => r.id)));
  const cur = await api.call("room.current", {});
  ok("1 the current world is H (workspace 71), not A", cur.room === "H" && cur.workspace === 71, JSON.stringify(cur));
  // 2
  const agent = await connect({ path: sock, onEvent: () => {} });
  await agent.call("agent.hello", { agent_id: "h-omni-alpha", pid: process.pid, name: "omni-alpha", want_workspace: 71, cwd: T });
  const t = await agent.call("talk", { to: ["Thoughts-A"], text: "please open Farside", mode: "demand" });
  ok("2 talk to Thoughts-A: nothing delivered, skipped with why", !(t.delivered || []).length && (t.skipped || []).some((s) => s.name === "Thoughts-A" && away.test(s.reason) && /laptop/.test(s.reason)), JSON.stringify(t));
  const t2 = await agent.call("talk", { to: ["Linkpath"], text: "hi", mode: "talk" });
  ok("2 an agent that isn't here: its reason says other worlds' agents are on the laptop", (t2.skipped || []).some((s) => /laptop/.test(s.reason)), JSON.stringify(t2));
  ok("2 no fake world A was made (no thoughts/A thread, no Thoughts-A)", !fs.existsSync(path.join(S, "thoughts", "A.thread.jsonl")) && !(((await api.call("list", {})).thoughts) || []).some((x) => x.room === "A"));
  // 3
  ok("3 thoughts.ask from Thoughts-H to Thoughts-A is refused", away.test(await err(() => api.call("thoughts.ask", { room: "H", agent: "Thoughts-A", question: "x" }))));
  ok("3 thoughts.send to A is refused", away.test(await err(() => api.call("thoughts.send", { room: "A", text: "hi" }))));
  ok("3 a human room post to A is refused", away.test(await err(() => api.call("room.post", { room: "A", text: "hi" }))));
  ok("3 board.get for A is refused", away.test(await err(() => api.call("board.get", { room: "A" }))));
  { const e = await err(() => api.call("thoughts.relayAsk", { room: "A", from: "x", text: "hi" })); ok("3 relayAsk for A is refused", /isn't on this machine/.test(e), e); }
  // 4
  { const e = await err(() => api.call("thoughts.open", { room: "A", task: "fix it", name: "Farside" })); ok("4 open_agent for world A is refused", away.test(e), e); }
  { const e = await err(() => api.call("orch.spawn", { thoughts: "A", prompt: "help" })); ok("4 spawn_agent for world A (as Thoughts-A) is refused", away.test(e), e); }
  ok("4 nothing pending to open", !fs.existsSync(path.join(S, "pending-opens.json")) || !/Farside/.test(fs.readFileSync(path.join(S, "pending-opens.json"), "utf8")));
  { const n = spawnSync(process.execPath, [path.join(ROOT, "bin/hyprpi"), "new", "--workspace", "2"], { env: { ...env, PATH: process.env.PATH }, encoding: "utf8", timeout: 15000 });
    ok("4 hyprpi new on world A's workspace is refused", n.status !== 0 && /isn't on this machine/.test(n.stderr + n.stdout), (n.stderr + n.stdout).slice(-200)); }
  { const e = await err(() => api.call("agent.move", { agent: "h-omni-alpha", to: "A" })); ok("4 moving an agent to world A is refused", away.test(e), e); }
  // 5
  const t3 = await agent.call("talk", { to: ["Thoughts-H"], text: "status?", mode: "talk" });
  ok("5 talk to Thoughts-H (this machine's own) is delivered", (t3.delivered || []).includes("Thoughts-H"), JSON.stringify(t3));
  // 6 J543 parity: open_agent / spawn_agent INSIDE world H start the agent the remote.sh way (no Hyprland here), and the list marks it
  { const e = await err(() => api.call("thoughts.open", { room: "H", task: "fix it", angus: "fix it", name: "Nohere" }));
    ok("6 without remote.sh here: open_agent says so", /remote\.sh is missing/.test(e), e); }
  fs.writeFileSync(path.join(ROOTH, "remote.sh"), `#!/usr/bin/env bash\n{ echo "ARGS $*"; env | grep '^HYPRPI_START_\\|^HYPRPI_AGENT_ID=' | sort; echo; } >> ${JSON.stringify(path.join(T, "starts.log"))}\n`, { mode: 0o755 });
  fs.mkdirSync(path.join(ROOTH, "sessions", "taken"), { recursive: true });
  const o = await api.call("thoughts.open", { room: "H", task: "fix the parity gaps", angus: "fix the parity gaps", name: "Farside", icon: "🔭", model: "", thinking: "high", cwd: T });
  ok("6 open_agent in world H answers with the agent", o.agent === "Farside" && /^H/.test(o.workspace), JSON.stringify(o));
  const o2 = await api.call("thoughts.open", { room: "H", task: "x", angus: "x", name: "Taken" });
  const o3 = await api.call("orch.spawn", { thoughts: "H", prompt: "help with X", name: "Helper" });
  for (let i = 0; i < 30 && (fs.existsSync(path.join(T, "starts.log")) ? fs.readFileSync(path.join(T, "starts.log"), "utf8").split("ARGS").length : 0) < 4; i++) await sleep(200);
  const log = fs.existsSync(path.join(T, "starts.log")) ? fs.readFileSync(path.join(T, "starts.log"), "utf8") : "";
  ok("6 remote.sh start farside with its name, icon, folder, thinking and workspace", /ARGS start farside\n/.test(log) && /HYPRPI_START_DISPLAY=Farside/.test(log) && /HYPRPI_START_ICON=🔭/.test(log) && log.includes(`HYPRPI_START_CWD=${T}`) && /HYPRPI_START_THINKING=high/.test(log) && /HYPRPI_START_NEW=1/.test(log) && /HYPRPI_START_WS=7[2-9]/.test(log) && !/HYPRPI_AGENT_ID=/.test(log), log.slice(0, 600));
  ok("6 a slug that is taken (a session folder) gets a new one", /ARGS start taken-2\n/.test(log) && o2.agent === "Taken", log.match(/ARGS start taken\S*/)?.[0]);
  ok("6 spawn_agent as Thoughts-H starts one too", /ARGS start helper\n/.test(log) && o3.name === "Helper", JSON.stringify(o3));
  const fa = await connect({ path: sock, onEvent: () => {} });
  await fa.call("agent.hello", { agent_id: "h-farside", pid: process.pid, name: "Farside", want_workspace: 72, cwd: T });
  const fl = ((await api.call("list", {})).agents || []).find((x) => x.id === "h-farside");
  ok("6 the list marks it opened here (the laptop opens its window)", fl?.opened?.by === "Thoughts-H" && fl.opened.at > 0, JSON.stringify(fl?.opened || null));
  ok("6 omni-alpha (not opened by the daemon) isn't marked", !((await api.call("list", {})).agents || []).find((x) => x.id === "h-omni-alpha")?.opened);
  fa.close?.();
  { // a finished turn makes the daemon label the agent's topic with a one-shot `pi -p` (the call that stole omni-alpha's socket)
    const sess = path.join(T, "omni.jsonl"); fs.writeFileSync(sess, JSON.stringify({ type: "message", message: { role: "user", content: "fix the parity of remote worlds" } }) + "\n");
    await agent.call("agent.update", { session: sess, status: "working" }).catch(() => {});
    await agent.call("agent.update", { session: sess, status: "done" }).catch(() => {});
    for (let i = 0; i < 40 && !/pi -p/.test(fs.existsSync(path.join(T, "pi.log")) ? fs.readFileSync(path.join(T, "pi.log"), "utf8") : ""); i++) await sleep(200); }
  { // 8 J543 parity: bonk / ding / chime / request of this machine's agents are kept as notices for the laptop
    await agent.call("agent.update", { status: "working" }).catch(() => {});
    await agent.call("agent.update", { status: "blocked", quiet: true, note: "please look at the A100 run" });
    await agent.call("agent.update", { status: "working" }); await agent.call("agent.update", { status: "blocked", quiet: true, decision: "ship it now or wait?" });
    await agent.call("agent.update", { status: "working" }); await agent.call("agent.update", { status: "blocked" });
    await agent.call("agent.update", { status: "working" }); await agent.call("agent.update", { status: "done" });
    const ns = (await api.call("list", {})).notices || [];
    const kinds = ns.filter((n) => n.id === "h-omni-alpha").map((n) => `${n.kind}:${n.text}`);
    ok("8 notices: bonk with its text, ding with the question, request, chime", ["bonk:please look at the A100 run", "ding:ship it now or wait?", "request:", "chime:"].every((k) => kinds.includes(k)), JSON.stringify(kinds));
    const { pickNotices } = await import(path.join(ROOT, "omnistation/auto-open.mjs"));
    const st = {}, now = Date.now();
    ok("8 laptop: a first look plays nothing old", pickNotices(ns, st, now).length === 0);
    const fresh = [...ns, { ts: now + 10, kind: "ding", id: "h-omni-alpha", name: "omni\x1b[31m-alpha", text: "a\nb" }, { ts: now + 11, kind: "rm -rf", id: "x" }];
    const p1 = pickNotices(fresh, st, now + 20), p2 = pickNotices(fresh, st, now + 30);
    { const st2 = {}, t0 = Date.now(); pickNotices([], st2, t0); const bl = Array.from({ length: 8 }, (_, i) => ({ ts: t0 + 1000 + i * 10000, kind: "bonk", id: `h-a${i}`, text: `b${i}` }));
      const got2 = [...pickNotices(bl, st2, t0 + 80000), ...pickNotices(bl, st2, t0 + 86000), ...pickNotices(bl, st2, t0 + 92000)].map((n) => n.id);
      ok("8 laptop: a backlog after an outage is all played, 4 at a time, none lost or twice", JSON.stringify(got2) === JSON.stringify(bl.map((n) => n.id)), JSON.stringify(got2)); }
    ok("8 laptop: a new one plays once, cleaned (no control characters), unknown kinds dropped", p1.length === 1 && p1[0].kind === "ding" && p1[0].id === "h-omni-alpha" && !/[\x00-\x1f]/.test(p1[0].name + p1[0].text) && p2.length === 0, JSON.stringify([p1, p2]));
  }
  { // 9 J543: a helper its parent closes (close_agent) is a "closed" notice, so the laptop closes its window as a local close does
    const hc = await connect({ path: sock, onEvent: () => {} });
    await hc.call("agent.hello", { agent_id: "h-helper", pid: 999999, name: "Helper", want_workspace: 73, cwd: T });
    await api.call("orch.close", { thoughts: "H", id: "h-helper", reason: "test" }).catch((e) => console.log("close:", e.message));
    hc.close?.(); let got = null;
    for (let i = 0; i < 50 && !got; i++) { await sleep(250); got = ((await api.call("list", {})).notices || []).find((n) => n.kind === "closed" && n.id === "h-helper"); }
    ok("9 a closed helper is a 'closed' notice for the laptop", !!got, JSON.stringify(got));
    const { pickNotices } = await import(path.join(ROOT, "omnistation/auto-open.mjs")); const st = {}; pickNotices([], st, Date.now());
    ok("9 … which the laptop's world-status takes (kind closed)", pickNotices([got || {}], st, Date.now())[0]?.kind === "closed"); }
  { const pl = fs.existsSync(path.join(T, "pi.log")) ? fs.readFileSync(path.join(T, "pi.log"), "utf8") : "";
    ok("7 started with an agent's env, the daemon's own pi calls (a topic label's pi -p too) carry no agent identity", /pi -p/.test(pl) && !/RPC=1|NAME=omni|ID=h-/.test(pl), pl.slice(0, 300)); }
  api.close?.(); agent.close?.();
} finally {
  d.kill(); await sleep(300);
  if (fails) { try { console.log(fs.readFileSync(path.join(T, "d.err"), "utf8").slice(-1500)); } catch { /* none */ } }
  fs.rmSync(T, { recursive: true, force: true });
}
console.log(fails ? `FAIL (${fails})` : "PASS"); process.exit(fails ? 1 : 0);
