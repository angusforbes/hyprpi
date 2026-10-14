#!/usr/bin/env node
// J555 W7 (Angus 17b): a remote world's Thoughts and agents reach the LAPTOP's Thoughts (Thoughts-A) over the world's panel link.
// Two isolated daemons: the "machine" (state <tmp>/.hyprpi-h/state: world H's) and the "laptop" (world A); the link
// (omnistation/rlink.mjs → a stand-in ssh → rlink-remote.mjs) joins them. No network, no desktop.
//  1. with the link up, an agent's demand to Thoughts-A on the machine is delivered to the laptop's Thoughts-A; its answer
//     (answer_agent there) comes back to the agent as the reply
//  2. Thoughts-H's ask_agent to Thoughts-A: asked on the laptop (marked as from world H, owed an answer), answered, the answer in
//     Thoughts-H's thread
//  3. no fake world on the machine: no Thoughts-A thread or room A there
//  4. with the link gone, it is refused with the reason again (J543)
//   node test/link-relay.mjs   (exit 0 = pass)
import fs from "node:fs"; import os from "node:os"; import path from "node:path"; import { spawn } from "node:child_process";
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
let fails = 0; const ok = (n, c, x = "") => { if (!c) fails++; console.log(`${c ? "ok  " : "FAIL"} ${n}${x && !c ? ": " + x : ""}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (f, ms = 8000) => { const end = Date.now() + ms; while (Date.now() < end) { try { const v = await f(); if (v) return v; } catch { /* not yet */ } await sleep(100); } return null; };
const T = fs.mkdtempSync(path.join(os.tmpdir(), "j555r-")), F = (n) => path.join(T, n);
const { connect } = await import(path.join(ROOT, "lib/client.mjs"));
function daemon(tag, state) {
  const cfg = F(`cfg-${tag}`), sock = F(`${tag}.sock`);
  fs.mkdirSync(path.join(cfg, "hyprpi"), { recursive: true }); fs.mkdirSync(state, { recursive: true });
  fs.writeFileSync(path.join(cfg, "hyprpi", "config.json"), JSON.stringify({ roomToThoughts: false, pi: "/bin/cat", worldSize: 10 }));
  fs.writeFileSync(path.join(cfg, "hyprpi", "hyprpi.jsonc"), JSON.stringify({ auth: { enabled: false }, upkeep: { refresh: { enabled: false }, autoReload: { enabled: false } } }));
  const env = { ...process.env, HYPRPI_SOCKET: sock, HYPRPI_STATE: state, XDG_CONFIG_HOME: cfg, HYPRPI_NO_ENSURE: "1", HYPRPI_UPKEEP_MS: "3600000", HYPRPI_NOTIFY_TEST: "1" };
  for (const k of ["HYPRPI_AGENT_ID", "HYPRLAND_INSTANCE_SIGNATURE", "WAYLAND_DISPLAY", "HYPRPI_REMOTE_HOME", "HYPRPI_REMOTE_LINK"]) delete env[k];
  return { sock, state, d: spawn(process.execPath, [path.join(ROOT, "bin/hyprpi"), "daemon"], { env, stdio: "ignore" }) };
}
const rem = daemon("rem", path.join(T, ".hyprpi-h", "state")), lap = daemon("lap", F("lapstate"));
fs.mkdirSync(path.join(lap.state, "rooms"), { recursive: true }); fs.writeFileSync(path.join(lap.state, "rooms", "A.jsonl"), "");
const SSH = F("fakessh"), PIDS = F("remote.pids"), RD = F("remote"), RUN = F("run");
fs.mkdirSync(RD); fs.mkdirSync(RUN, { mode: 0o700 });
fs.writeFileSync(SSH, `#!/bin/sh\necho $$ >> ${PIDS}\nexec env HYPRPI_STATE=${rem.state} HYPRPI_SOCKET=${rem.sock} ${process.execPath} ${path.join(ROOT, "omnistation/rlink-remote.mjs")}\n`, { mode: 0o755 });
fs.writeFileSync(path.join(RD, "h.json"), JSON.stringify({ ssh: [SSH, "host"] }));
// the link runs as the laptop: its daemon socket is the laptop daemon's
fs.writeFileSync(F("echo-op.mjs"), "export async function handle(world, args) { return { world, echo: args }; }\n");
const lenv = { ...process.env, XDG_RUNTIME_DIR: RUN, HYPRPI_REMOTE_DIR: RD, HYPRPI_SOCKET: lap.sock, HYPRPI_LINK_LOG: F("link.log"), HYPRPI_LINK_PING_MS: "1000", HYPRPI_TEST: "1", HYPRPI_TEST_LINK_OP: `echo:${F("echo-op.mjs")}` };
delete lenv.HYPRPI_REMOTE_LINK; delete lenv.HYPRPI_AGENT_ID;
let link = null;
const lapRelay = () => { try { const r = JSON.parse(fs.readFileSync(path.join(lap.state, "requests.json"), "utf8")); const list = (Array.isArray(r) ? r : Object.entries(r.requests || r)).map(([id, v]) => ({ id, ...v })); return list.filter((x) => x.relay && x.thoughts === "A"); } catch { return []; } };
try {
  for (let i = 0; i < 60 && !(fs.existsSync(rem.sock) && fs.existsSync(lap.sock)); i++) await sleep(200);
  link = spawn(process.execPath, [path.join(ROOT, "omnistation/rlink.mjs"), "H"], { env: lenv, stdio: "ignore" });
  await waitFor(() => fs.readFileSync(F("link.log"), "utf8").includes(" up"), 8000); await sleep(1500); // attached
  const got = [];
  const ag = await connect({ path: rem.sock, onEvent: (ev, data) => got.push({ ev, data }) });
  await ag.call("agent.hello", { agent_id: "h-omni-alpha", pid: process.pid, name: "omni-alpha", want_workspace: 71, cwd: T });
  // 1
  const t = await ag.call("talk", { to: ["Thoughts-A"], text: "what is world A working on?", mode: "demand" });
  ok("1 with the link, a demand to Thoughts-A is delivered (to the laptop, via the link)", (t.delivered || []).some((x) => /Thoughts-A \(on the laptop, via the panel link\)/.test(x)), JSON.stringify(t));
  const req1 = await waitFor(() => lapRelay().find((x) => /what is world A working on/.test(x.text || "")), 10000);
  ok("1 … it arrives at the laptop's Thoughts-A as a relayed message", !!req1, JSON.stringify(lapRelay()).slice(0, 300));
  const lapc = await connect({ path: lap.sock });
  if (req1) await lapc.call("thoughts.answer", { room: "A", request_id: req1.id, text: "world A is polishing the bar" });
  const rep = await waitFor(() => got.find((g) => g.ev === "talk.reply" && /polishing the bar/.test(g.data?.text || "")), 12000);
  ok("1 … and Thoughts-A's answer comes back to the agent as its reply", !!rep, JSON.stringify(got.map((g) => g.ev)));
  // 2 Thoughts-H asks Thoughts-A
  const remc = await connect({ path: rem.sock });
  const a2 = await remc.call("thoughts.ask", { room: "H", agent: "Thoughts-A", question: "can I borrow an agent?" }).catch((e) => ({ err: e.message }));
  ok("2 Thoughts-H's ask_agent to Thoughts-A goes over the link", /Thoughts-A \(on the laptop, via the panel link\)/.test(a2.agent || ""), JSON.stringify(a2));
  const req2 = await waitFor(() => lapRelay().find((x) => /can I borrow an agent/.test(x.text || "")), 10000);
  ok("2 … asked on the laptop, marked as from world H's Thoughts (owed an answer)", !!req2 && req2.fromThoughts === "H", JSON.stringify(req2 || null).slice(0, 300));
  if (req2) await lapc.call("thoughts.answer", { room: "A", request_id: req2.id, text: "yes, take Linkpath" });
  const th = await waitFor(async () => ((await remc.call("thoughts.get", { room: "H" })).entries || []).find((e) => /take Linkpath/.test(e.text || "")), 12000);
  ok("2 … and the answer lands in Thoughts-H's thread on the machine", !!th, "");
  // 5 (Namesmith's J561) link.call: a process on the machine asks the laptop to run an allow-listed op
  const lc = await remc.call("link.call", { op: "echo", args: { path: "Notes/x.md", n: 1 } }).catch((e) => ({ err: e.message }));
  ok("5 link.call runs the laptop's op handler and returns its result", lc.result?.world === "H" && lc.result?.echo?.path === "Notes/x.md", JSON.stringify(lc));
  const lu = await remc.call("link.call", { op: "nosuch", args: {} }).catch((e) => ({ err: e.message }));
  ok("5 an op the laptop doesn't allow is refused", /no op nosuch/.test(lu.err || ""), JSON.stringify(lu));
  // 3
  ok("3 no fake world A on the machine (no Thoughts-A thread, no room A)", !fs.existsSync(path.join(rem.state, "thoughts", "A.thread.jsonl")) && !fs.existsSync(path.join(rem.state, "rooms", "A.jsonl")));
  // 4 the link gone: refused with the reason again
  link.kill(); link = null; for (const p of fs.readFileSync(PIDS, "utf8").split("\n").filter(Boolean)) { try { process.kill(Number(p), "SIGKILL"); } catch { /* gone */ } }
  await sleep(1500);
  const t4 = await ag.call("talk", { to: ["Thoughts-A"], text: "still there?", mode: "talk" });
  const ln = await ag.call("link.call", { op: "echo", args: {} }).catch((e) => ({ err: e.message }));
  ok("5 without the link, link.call says there is none", /no link to the laptop/.test(ln.err || ""), JSON.stringify(ln));
  ok("4 without the link: refused with the reason (never a local fake world)", !(t4.delivered || []).length && (t4.skipped || []).some((s) => /isn't on this machine/.test(s.reason)), JSON.stringify(t4));
  ag.close?.(); lapc.close?.(); remc.close?.();
} finally {
  try { link?.kill(); } catch { /* gone */ }
  try { for (const p of fs.readFileSync(PIDS, "utf8").split("\n").filter(Boolean)) { try { process.kill(Number(p), "SIGKILL"); } catch { /* gone */ } } } catch { /* none */ }
  rem.d.kill(); lap.d.kill(); await sleep(400);
  if (fails && process.env.KEEP) console.log("kept " + T); else fs.rmSync(T, { recursive: true, force: true });
}
console.log(fails ? `link-relay: ${fails} FAILED` : "link-relay: all pass"); process.exit(fails ? 1 : 0);
