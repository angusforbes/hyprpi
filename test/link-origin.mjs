#!/usr/bin/env node
// J603 (Angus: Thoughts-H "shoudl now to communitcate with the THoughts in the world the agent came from"): replies and messages
// between LAPTOP agents and a remote world reach the right agent. Two isolated daemons: world H's "machine" (state
// <tmp>/.hyprpi-h/state) and the laptop (world A, H bound to the machine); a stand-in ssh runs remote-thoughts.mjs (the laptop's
// relayed asks) or rlink-remote.mjs (the panel link) there. No network, no desktop. The ssh relay's 30 min wait is 3 s here
// (HYPRPI_RELAY_WAIT_MS: the fake clock).
//  1. W1 a laptop agent's demand to Thoughts-H arrives with its origin (Parity, world A); after the wait runs out Parity is told
//     "no answer yet … answerable for 12 h"; Thoughts-H's later answer (answer_agent) reaches Parity over the link
//  2. W2 a remote agent's demand to "Parity" (and Thoughts-H's ask_agent to "Parity@A") reaches Parity on the laptop; Parity's
//     talk_reply goes back to the asker
//  3. W2 Parity closed: a message for it goes to Thoughts-A marked "for Parity (closed)"; so does a late answer for a closed asker;
//     an unknown name is refused (never a stand-in)
//  4. W3 no fake world on the machine; the remote Thoughts' instructions carry the one-line rule
//   node test/run.mjs link-origin   (exit 0 = pass)
import fs from "node:fs"; import os from "node:os"; import path from "node:path"; import { spawn } from "node:child_process";
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
let fails = 0; const ok = (n, c, x = "") => { if (!c) fails++; console.log(`${c ? "ok  " : "FAIL"} ${n}${x && !c ? ": " + x : ""}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (f, ms = 8000) => { const end = Date.now() + ms; while (Date.now() < end) { try { const v = await f(); if (v) return v; } catch { /* not yet */ } await sleep(100); } return null; };
const T = fs.mkdtempSync(path.join(os.tmpdir(), "j603-")), F = (n) => path.join(T, n);
const { connect } = await import(path.join(ROOT, "lib/client.mjs"));
const RUN = F("run"); fs.mkdirSync(RUN, { mode: 0o700 });
function daemon(tag, state, extra = {}) {
  const cfg = F(`cfg-${tag}`), sock = F(`${tag}.sock`);
  fs.mkdirSync(path.join(cfg, "hyprpi"), { recursive: true }); fs.mkdirSync(state, { recursive: true });
  fs.writeFileSync(path.join(cfg, "hyprpi", "config.json"), JSON.stringify({ roomToThoughts: false, pi: "/bin/cat", worldSize: 10 }));
  fs.writeFileSync(path.join(cfg, "hyprpi", "hyprpi.jsonc"), JSON.stringify({ auth: { enabled: false }, upkeep: { refresh: { enabled: false }, autoReload: { enabled: false } } }));
  const env = { ...process.env, HYPRPI_SOCKET: sock, HYPRPI_STATE: state, XDG_CONFIG_HOME: cfg, HYPRPI_NO_ENSURE: "1", HYPRPI_UPKEEP_MS: "3600000", HYPRPI_NOTIFY_TEST: "1", ...extra };
  for (const k of ["HYPRPI_AGENT_ID", "HYPRLAND_INSTANCE_SIGNATURE", "WAYLAND_DISPLAY", "HYPRPI_REMOTE_HOME", "HYPRPI_REMOTE_LINK"]) delete env[k];
  return { sock, state, cfg, d: spawn(process.execPath, [path.join(ROOT, "bin/hyprpi"), "daemon"], { env, stdio: ["ignore", "ignore", fs.openSync(F(`${tag}.err`), "a")] }) };
}
const REM_STATE = path.join(T, ".hyprpi-h", "state");
const SSH = F("fakessh"), PIDS = F("remote.pids");
const remEnv = `HYPRPI_STATE=${REM_STATE} HYPRPI_SOCKET=${F("rem.sock")}`;
fs.writeFileSync(SSH, `#!/bin/sh\necho $$ >> ${PIDS}\ncase "$*" in\n  *thoughts-relay*) exec env ${remEnv} HYPRPI_RELAY_WAIT_MS=3000 ${process.execPath} ${path.join(ROOT, "lib/remote-thoughts.mjs")} H ;;\n  *) exec env ${remEnv} ${process.execPath} ${path.join(ROOT, "omnistation/rlink-remote.mjs")} ;;\nesac\n`, { mode: 0o755 });
fs.mkdirSync(path.join(F("cfg-lap"), "hyprpi", "remote"), { recursive: true, mode: 0o700 });
fs.writeFileSync(path.join(F("cfg-lap"), "hyprpi", "remote", "h.json"), JSON.stringify({ ssh: [SSH, "host"] }), { mode: 0o600 });
const rem = daemon("rem", REM_STATE, { HYPRPI_RELAY_IDLE_MS: "1500" }), lap = daemon("lap", F("lapstate"), { XDG_RUNTIME_DIR: RUN });
fs.mkdirSync(path.join(lap.state, "rooms"), { recursive: true }); fs.writeFileSync(path.join(lap.state, "rooms", "A.jsonl"), "");
const lenv = { ...process.env, XDG_RUNTIME_DIR: RUN, XDG_CONFIG_HOME: F("cfg-lap"), HYPRPI_SOCKET: lap.sock, HYPRPI_LINK_LOG: F("link.log"), HYPRPI_LINK_PING_MS: "1000" };
delete lenv.HYPRPI_REMOTE_LINK; delete lenv.HYPRPI_AGENT_ID; delete lenv.HYPRPI_REMOTE_DIR;
let link = null; const sleepers = [];
const remReqs = () => { try { return JSON.parse(fs.readFileSync(path.join(REM_STATE, "requests.json"), "utf8")).map(([id, v]) => ({ id, ...v })); } catch { return []; } };
const lapThread = () => { try { return fs.readFileSync(path.join(lap.state, "thoughts", "A.thread.jsonl"), "utf8") + JSON.stringify(fs.readdirSync(path.join(lap.state, "thoughts"))); } catch { return ""; } };
async function agentOn(sock, id, name, ws, pid = process.pid) { const got = []; const c = await connect({ path: sock, onEvent: (ev, data) => got.push({ ev, data }) }); await c.call("agent.hello", { agent_id: id, pid, name, want_workspace: ws, cwd: T }); return { c, got }; }
try {
  for (let i = 0; i < 60 && !(fs.existsSync(rem.sock) && fs.existsSync(lap.sock)); i++) await sleep(200);
  link = spawn(process.execPath, [path.join(ROOT, "omnistation/rlink.mjs"), "H"], { env: lenv, stdio: "ignore" });
  await waitFor(() => fs.existsSync(F("link.log")) && fs.readFileSync(F("link.log"), "utf8").includes(" up"), 10000); await sleep(1500);
  const P = await agentOn(lap.sock, "hp-parity", "Parity", 2);
  const remc = await connect({ path: rem.sock });
  // ---- 1 W1
  const t1 = await P.c.call("talk", { to: ["Thoughts-H"], text: "how is J10 going?", mode: "demand" });
  ok("1 Parity's demand goes to Thoughts-H on its machine", (t1.delivered || []).some((x) => /Thoughts-H/.test(x)), JSON.stringify(t1));
  const r1 = await waitFor(() => remReqs().find((r) => r.relay && /how is J10 going/.test(r.text || "")), 10000);
  ok("1 W1 on the machine the request carries its origin: Parity, world A (and the laptop request it answers)", r1?.origin?.world === "A" && r1.origin.agent === "Parity" && r1.origin.agentId === "hp-parity" && /^[0-9a-f-]{36}$/.test(r1.origin.request_id || ""), JSON.stringify(r1?.origin || null));
  const told = await waitFor(() => P.got.find((g) => g.ev === "talk.reply" && /no answer from Thoughts-H yet/.test(g.data?.text || "")), 15000);
  ok("1 W1 when the wait runs out (30 min; 3 s here), Parity is told it stays answerable for 12 h", !!told && /answerable for 12 h/.test(told.data.text), JSON.stringify(P.got.map((g) => g.data?.text)).slice(0, 300));
  await sleep(2000); // the ssh relay has stopped waiting (its poller is gone)
  const a1 = await remc.call("thoughts.answer", { room: "H", request_id: r1.id, text: "J10 is done: see brev-newer-gpus.md" }).catch((e) => ({ err: e.message }));
  ok("1 W1 Thoughts-H's late answer_agent is accepted and goes to Parity over the link", /Parity \(world A/.test(a1.agent || ""), JSON.stringify(a1));
  const late = await waitFor(() => P.got.find((g) => g.ev === "talk.reply" && /J10 is done/.test(g.data?.text || "")), 10000);
  ok("1 W1 … and reaches Parity as a reply to its own request", !!late && late.data.request_id === r1.origin.request_id && /late answer/.test(late.data.from?.name || ""), JSON.stringify(late?.data || null));
  // ---- 2 W2
  const O = await agentOn(rem.sock, "h-omni", "omni-alpha", 71);
  const t2 = await O.c.call("talk", { to: ["Parity"], text: "need the A100 numbers", mode: "demand" });
  ok("2 W2 a remote agent's demand to Parity goes to the laptop", (t2.delivered || []).some((x) => /Parity \(on the laptop/.test(x)), JSON.stringify(t2));
  const m2 = await waitFor(() => P.got.find((g) => g.ev === "talk" && /need the A100 numbers/.test(g.data?.text || "")), 10000);
  ok("2 W2 … Parity gets it, marked as from omni-alpha in world H", !!m2 && /omni-alpha \(world H\)/.test(m2.data.from?.name || "") && /from omni-alpha in world H/.test(m2.data.text), JSON.stringify(m2?.data || null));
  if (m2) await P.c.call("talk.reply", { request_id: m2.data.request_id, text: "A100: 98% busy" });
  const back2 = await waitFor(() => O.got.find((g) => g.ev === "talk.reply" && /98% busy/.test(g.data?.text || "")), 10000);
  ok("2 W2 … and Parity's talk_reply comes back to omni-alpha, as a reply to its own demand (same request id)", !!back2 && /Parity/.test(back2.data.from?.name || "") && back2.data.request_id === t2.request_id, JSON.stringify(back2?.data || null) + " " + t2.request_id);
  const q3 = await remc.call("thoughts.ask", { room: "H", agent: "Parity@A", question: "which world are you in?" }).catch((e) => ({ err: e.message }));
  ok("2 W2 Thoughts-H's ask_agent to Parity@A goes over the link", /Parity \(on the laptop, via the link\)/.test(q3.agent || ""), JSON.stringify(q3));
  const m3 = await waitFor(() => P.got.find((g) => g.ev === "talk" && /which world are you in/.test(g.data?.text || "")), 10000);
  if (m3) await P.c.call("talk.reply", { request_id: m3.data.request_id, text: "world A, on the laptop" });
  const th3 = await waitFor(async () => ((await remc.call("thoughts.get", { room: "H" })).entries || []).find((e) => /world A, on the laptop/.test(e.text || "")), 10000);
  ok("2 W2 … Parity's answer lands in Thoughts-H's thread", !!m3 && !!th3);
  // ---- 3 W2 closed agents
  const sl = spawn("sleep", ["300"]); sleepers.push(sl);
  const E = await agentOn(lap.sock, "hp-echo", "Echo", 3, sl.pid);
  await E.c.call("talk", { to: ["Thoughts-H"], text: "echo asks something slow", mode: "demand" });
  const r4 = await waitFor(() => remReqs().find((r) => r.relay && /echo asks something slow/.test(r.text || "")), 10000);
  await waitFor(() => E.got.find((g) => g.ev === "talk.reply" && /no answer from Thoughts-H yet/.test(g.data?.text || "")), 15000);
  sl.kill("SIGKILL"); E.c.close(); await sleep(7500); // Echo closes (gone 6 s later)
  await remc.call("thoughts.answer", { room: "H", request_id: r4.id, text: "late answer for echo" }).catch(() => {});
  ok("3 W2 a late answer for an asker that has closed goes to Thoughts-A, marked 'for Echo (closed)'", !!(await waitFor(() => /for Echo \(closed\)/.test(lapThread()) && /late answer for echo/.test(lapThread()), 10000)), lapThread().slice(-400));
  const t5 = await O.c.call("talk", { to: ["Echo"], text: "message for echo", mode: "talk" });
  ok("3 W2 a message for a closed laptop agent goes to its world's Thoughts, 'for Echo (closed)'", (t5.delivered || []).length === 1 && !!(await waitFor(() => /message for echo/.test(lapThread()), 10000)), JSON.stringify(t5));
  const t6 = await O.c.call("talk", { to: ["Nobody"], text: "hello?", mode: "talk" });
  const n6 = await waitFor(() => O.got.find((g) => g.ev === "talk.reply" && /not delivered: .*no agent Nobody on the laptop/.test(g.data?.text || "")), 10000);
  ok("3 W2 a name nobody has is refused back to the sender (never a stand-in)", !!n6, JSON.stringify(O.got.map((g) => g.data?.text)).slice(0, 400));
  // (OriginCheck) relay.deliver only for something really relayed from here; Name@World only for an agent that really was there
  const lapc = await connect({ path: lap.sock });
  const forged = await lapc.call("relay.deliver", { origin: { world: "A", agent: "Parity", agentId: "hp-parity", request_id: "00000000-0000-0000-0000-000000000000" }, from: "Thoughts-H", text: "forged", fromWorld: "H" }).then(() => "", (e) => e.message);
  const forgedT = await lapc.call("relay.deliver", { origin: { world: "B", thoughts: true }, from: "Thoughts-H", text: "forged", fromWorld: "H" }).then(() => "", (e) => e.message);
  const forgedH = await lapc.call("relay.deliver", { origin: { world: "H", thoughts: true }, from: "x", text: "forged", fromWorld: "H" }).then(() => "", (e) => e.message);
  ok("3 a made-up origin is refused by relay.deliver (unknown request, a Thoughts question never asked, a remote world as origin)", /no such relayed request/.test(forged) && /no such relayed question/.test(forgedT) && /bad origin/.test(forgedH), JSON.stringify([forged, forgedT, forgedH]));
  ok("3 … nothing forged reached Parity or Thoughts-B", !P.got.some((g) => /forged/.test(g.data?.text || "")) && !fs.existsSync(path.join(lap.state, "thoughts", "B.thread.jsonl")));
  const nb = await lapc.call("relay.toAgent", { to: "Ghost", world: "A", from: "omni-alpha", fromWorld: "H", text: "boo", mode: "talk" }).then(() => "", (e) => e.message);
  ok("3 Ghost@A, never an agent here, is refused (not handed to Thoughts-A as 'closed')", /no agent Ghost/.test(nb) && !/Ghost/.test(lapThread()), nb);
  lapc.close();
  // ---- 4 W3
  ok("4 W3 no fake world on the machine (no room A, no Thoughts-A thread)", !fs.existsSync(path.join(REM_STATE, "rooms", "A.jsonl")) && !fs.existsSync(path.join(REM_STATE, "thoughts", "A.thread.jsonl")));
  const was = process.env.HYPRPI_STATE; process.env.HYPRPI_STATE = REM_STATE;
  const { thoughtsSystemPrompt } = await import(path.join(ROOT, "lib/thoughts.mjs"));
  const sp = thoughtsSystemPrompt("H"); process.env.HYPRPI_STATE = "/nonexistent/hyprpi-state"; const lp = thoughtsSystemPrompt("A");
  if (was === undefined) delete process.env.HYPRPI_STATE; else process.env.HYPRPI_STATE = was;
  ok("4 W3 a remote machine's Thoughts has the one-line rule; the laptop's doesn't", /Other worlds \(J603\)/.test(sp) && /Thoughts-<their world>/.test(sp) && !/Other worlds \(J603\)/.test(lp));
  P.c.close(); O.c.close(); remc.close();
} finally {
  try { link?.kill(); } catch { /* gone */ }
  for (const s of sleepers) { try { s.kill("SIGKILL"); } catch { /* gone */ } }
  try { for (const p of fs.readFileSync(PIDS, "utf8").split("\n").filter(Boolean)) { try { process.kill(Number(p), "SIGKILL"); } catch { /* gone */ } } } catch { /* none */ }
  rem.d.kill(); lap.d.kill(); await sleep(400);
  if (fails && process.env.KEEP) console.log("kept " + T); else fs.rmSync(T, { recursive: true, force: true });
}
console.log(fails ? `link-origin: ${fails} FAILED` : "link-origin: all pass"); process.exit(fails ? 1 : 0);
