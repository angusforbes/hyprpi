#!/usr/bin/env node
// J555 W2 (stage 2): a remote world's AGENTS panel running on the LAPTOP (omnistation/panel-link.sh H agents) against world H's daemon
// through the world's link (omnistation/rlink.mjs → a stand-in ssh → rlink-remote.mjs → an isolated daemon whose state is
// <tmp>/.hyprpi-h/state, so it is world H's machine: REMOTE_HOME H, its remote.sh a stand-in that records). No network, no desktop:
// the panel runs under `script`, test/lib-screen.mjs reads its screen; laptop-act is a stand-in that records what it was asked.
//  1. it lists world H's agents (from the remote daemon), once each: not again as "reported by H" rows from the laptop's
//     world-status file; no "⚠ host (not sandboxed)" mark from the laptop's sandbox configs (a guard: a remote daemon's live agents
//     have no workspace, so the mark can't come up today)
//  2. a click selects; Ctrl+click and ⏎ on an agent → laptop-act H focus NAME (on the laptop), nothing on the machine
//  3. ^W ^W ends the agent ON THE MACHINE (agent.endRemote → remote.sh stop NAME); ^K ^K kills its pi there (the daemon's kill, logged)
//  4. Ctrl+N → laptop-act H new · /new DIR → agent.startRemote (remote.sh start omni-xyz in DIR)
//  5. a project row (Ctrl+click) → board.open on the machine + laptop-act H panel board
//  6. ⏎ on a closed agent → agent.resume (remote.sh start NAME on its own session)
//  7. the link drops (ssh killed): the panel reconnects by itself and sees a new agent
//  8. a long outage (the ssh hangs 20 s, longer than a call's 15 s): the footer says "link to H down", and once it's back the panel
//     holds ONE connection and works (rlink doesn't listen while down, 8c079e3; the panel also closes a half-open connection itself)
//   node test/link-agents.mjs   (exit 0 = pass; KEEP=1 keeps the temp folder on failure)
import fs from "node:fs"; import os from "node:os"; import path from "node:path"; import net from "node:net"; import { spawn, spawnSync } from "node:child_process";
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const { Screen } = await import(path.join(ROOT, "test/lib-screen.mjs"));
let fails = 0; const ok = (n, c, x = "") => { if (!c) fails++; console.log(`${c ? "ok  " : "FAIL"} ${n}${x && !c ? ": " + x : ""}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (f, ms = 8000, step = 50) => { const end = Date.now() + ms; while (Date.now() < end) { try { if (await f()) return true; } catch { /* not yet */ } await sleep(step); } return false; };
const T = fs.mkdtempSync(path.join(os.tmpdir(), "j555a-")), RH = path.join(T, ".hyprpi-h"), S = path.join(RH, "state"), cfg = path.join(T, "cfg"), dsock = path.join(T, "d.sock");
const LH = path.join(T, "lh"), RUN = path.join(T, "run"), RD = path.join(T, "remote"), F = (n) => path.join(T, n);
for (const d of [S, path.join(cfg, "hyprpi"), LH, RUN, RD, path.join(LH, ".state/hyprpi/worlds/world-h"), path.join(LH, ".config/hyprpi/worlds")]) fs.mkdirSync(d, { recursive: true, mode: 0o700 });
fs.writeFileSync(path.join(cfg, "hyprpi", "config.json"), JSON.stringify({ roomToThoughts: false, pi: "/bin/cat", worldSize: 10 }));
fs.writeFileSync(path.join(cfg, "hyprpi", "hyprpi.jsonc"), JSON.stringify({ auth: { enabled: false }, upkeep: { refresh: { enabled: false }, autoReload: { enabled: false } } }));
// the machine: its remote.sh records what it's asked (start / stop, with the HYPRPI_START_ environment); new agents are omni-xyz
fs.writeFileSync(path.join(RH, "remote.sh"), `#!/usr/bin/env bash\n{ echo "ARGS $*"; env | grep '^HYPRPI_START_' | sort; echo; } >> ${JSON.stringify(F("starts.log"))}\n`, { mode: 0o755 });
fs.writeFileSync(path.join(RH, "prefix"), "omni-\n");
const denv = { ...process.env, HYPRPI_SOCKET: dsock, HYPRPI_STATE: S, XDG_CONFIG_HOME: cfg, HYPRPI_NO_ENSURE: "1", HYPRPI_UPKEEP_MS: "3600000", HYPRPI_NOTIFY_TEST: "1" };
for (const k of ["HYPRPI_AGENT_ID", "HYPRLAND_INSTANCE_SIGNATURE", "WAYLAND_DISPLAY", "HYPRPI_REMOTE_HOME", "HYPRPI_REMOTE_LINK"]) delete denv[k];
const dlog = fs.openSync(F("daemon.log"), "a");
const d = spawn(process.execPath, [path.join(ROOT, "bin/hyprpi"), "daemon"], { env: denv, stdio: ["ignore", "ignore", dlog] });
// the stand-in ssh: while HOLD exists it hangs (a slow network / login), then it is the machine's side of the link
const SSH = F("fakessh"), PIDS = F("remote.pids"), HOLD = F("hold");
fs.writeFileSync(SSH, `#!/bin/sh\necho $$ >> ${PIDS}\nwhile [ -e ${HOLD} ]; do sleep 0.2; done\nexec env HYPRPI_STATE=${S} HYPRPI_SOCKET=${dsock} ${process.execPath} ${path.join(ROOT, "omnistation/rlink-remote.mjs")}\n`, { mode: 0o755 });
fs.writeFileSync(path.join(RD, "h.json"), JSON.stringify({ ssh: [SSH, "host"] }));
fs.writeFileSync(F("act"), `#!/bin/sh\necho "$*" >> ${F("act.log")}\n`, { mode: 0o755 });
// the laptop: world-status's report of world H's agents (the same agents), and a sandbox config whose range covers H's workspaces
fs.writeFileSync(path.join(LH, ".state/hyprpi/worlds/world-h/agents.json"), JSON.stringify({ room: "H", at: Date.now() + 600e3, badge: "📡", agents: [{ name: "omni-alpha", status: "idle", ws: 71 }] }));
fs.writeFileSync(path.join(LH, ".config/hyprpi/worlds/world-x.json"), JSON.stringify({ workspaces: [71, 80] }));
const LENV = { ...process.env, HOME: LH, XDG_RUNTIME_DIR: RUN, XDG_STATE_HOME: path.join(LH, ".state"), XDG_CONFIG_HOME: path.join(LH, ".config"), HYPRPI_REMOTE_DIR: RD,
  HYPRPI_TEST: "1", HYPRPI_TEST_LAPTOP_ACT: F("act"), HYPRPI_LINK_LOG: F("link.log"), HYPRPI_LINK_PING_MS: "1000", TERM: "xterm-256color" };
for (const k of ["HYPRLAND_INSTANCE_SIGNATURE", "WAYLAND_DISPLAY", "DISPLAY", "HYPRPI_AGENT_ID", "HYPRPI_SOCKET", "HYPRPI_STATE", "HYPRPI_REMOTE_PANEL", "KITTY_WINDOW_ID"]) delete LENV[k];
const { connect } = await import(path.join(ROOT, "lib/client.mjs"));
const read = (n) => { try { return fs.readFileSync(F(n), "utf8"); } catch { return ""; } };
const acts = () => read("act.log").split("\n").filter(Boolean);
let panel = null, scr = null; const kids = [], conns = [];
const key = async (k, ms = 300) => { panel.stdin.write(k); await sleep(ms); };
const click = async (at, ctrl, ms = 800) => { const b = ctrl ? 16 : 0; panel.stdin.write(`\x1b[<${b};${at.x};${at.y}M`); await sleep(40); panel.stdin.write(`\x1b[<${b};${at.x};${at.y}m`); await sleep(ms); };
const daemon = async (m, p = {}) => { const c = await connect({ path: dsock }); try { return await c.call(m, p); } finally { c.close(); } };
const hello = async (id, pid, ws) => { const c = await connect({ path: dsock, onEvent: () => {} }); conns.push(c); await c.call("agent.hello", { agent_id: id, pid, name: id.slice(2), want_workspace: ws, cwd: T }); return c; };
const linkStatus = () => new Promise((res) => { const c = net.createConnection(path.join(RUN, "hyprpi", "link-h.ctl")); let b = ""; c.on("connect", () => c.write(JSON.stringify({ id: 1, method: "link.status", params: {} }) + "\n")); c.on("data", (x) => { b += x; if (b.includes("\n")) { c.destroy(); try { res(JSON.parse(b.split("\n")[0]).result); } catch { res(null); } } }); c.on("error", () => res(null)); setTimeout(() => { c.destroy(); res(null); }, 3000); });
const killRemoteSide = () => { const n = read("remote.pids").split("\n").filter(Boolean); try { process.kill(Number(n.at(-1)), "SIGKILL"); } catch { /* gone */ } return n.length; };
const footer = () => scr.rowText(scr.r - 1);
try {
  for (let i = 0; i < 50 && !fs.existsSync(dsock); i++) await sleep(200);
  // world H's agents: alpha (a stand-in), beta (a node carrying its own HYPRPI_AGENT_ID: ^K kills it there), oldie (closes: a closed agent)
  const beta = spawn(process.execPath, ["-e", "setTimeout(()=>{},120000)"], { env: { ...process.env, HYPRPI_AGENT_ID: "h-omni-beta" }, stdio: "ignore" }); kids.push(beta);
  const sess = path.join(RH, "sessions", "oldie", "s.jsonl"); fs.mkdirSync(path.dirname(sess), { recursive: true }); fs.writeFileSync(sess, "{}\n");
  const o = await hello("h-oldie", 999998, 74); await o.call("agent.update", { session: sess, status: "idle" }).catch(() => {}); o.close();
  const al = await hello("h-omni-alpha", process.pid, 71);
  await sleep(200); await hello("h-omni-beta", beta.pid, 72);
  await al.call("board.project", { action: "create", name: "linkproj", title: "a project on world H", icon: "🧪", room: "H" });
  scr = new Screen(140, 36);
  panel = spawn("script", ["-qfc", `stty cols 140 rows 36; exec ${path.join(ROOT, "omnistation/panel-link.sh")} H agents`, "/dev/null"], { env: LENV, stdio: ["pipe", "pipe", "ignore"] });
  panel.stdout.on("data", (b) => scr.feed(b.toString()));
  // 1
  ok("1 the laptop panel lists world H's agents (through the link)", await waitFor(() => scr.find("omni-alpha") && scr.find("omni-beta") && scr.find("@linkproj"), 15000), scr.dump().slice(0, 900));
  await sleep(500);
  ok("1 each agent once: no 'reported by H' rows from the laptop's world-status file", !/reported by|own agents/.test(scr.dump()), scr.dump());
  ok("1 no '⚠ host (not sandboxed)' mark from the laptop's sandbox configs", !scr.dump().includes("not sandboxed"), scr.dump());
  // 2 click selects (nothing on the laptop), Ctrl+click and ⏎ focus its laptop window
  let at = scr.find("omni-alpha"); await click({ x: at.x + 1, y: at.y }, false);
  ok("2 a click selects the agent (nothing asked of the laptop)", acts().length === 0, acts().join(" | "));
  await click({ x: at.x + 1, y: at.y }, true, 1200);
  ok("2 Ctrl+click → laptop-act H focus omni-alpha", acts().at(-1) === "H focus omni-alpha", acts().join(" | "));
  at = scr.find("omni-beta"); await click({ x: at.x + 1, y: at.y }, false); await key("\r", 1200);
  ok("2 ⏎ → laptop-act H focus omni-beta", acts().at(-1) === "H focus omni-beta", acts().join(" | "));
  // 3 ^W ^W on alpha: ended on the machine; ^K ^K on beta: its pi killed there by the daemon
  at = scr.find("omni-alpha"); await click({ x: at.x + 1, y: at.y }, false);
  await key("\x17", 150); await key("\x17", 1500);
  ok("3 ^W ^W → agent.endRemote: remote.sh stop omni-alpha on the machine", await waitFor(() => /ARGS stop omni-alpha\n/.test(read("starts.log")), 4000) && /omni-alpha ended from the agents panel \(close\)/.test(read("daemon.log")), read("starts.log") + read("daemon.log").slice(-400));
  at = scr.find("omni-beta"); await click({ x: at.x + 1, y: at.y }, false);
  await key("\x0b", 150); await key("\x0b", 1500);
  ok("3 ^K ^K → agent.endRemote kill: the daemon killed omni-beta's pi there", await waitFor(() => beta.signalCode === "SIGTERM", 4000) && /omni-beta ended from the agents panel \(kill\)/.test(read("daemon.log")), `${beta.signalCode} ${read("daemon.log").slice(-400)}`);
  // 4 Ctrl+N, /new DIR
  await key("\x0e", 1200);
  ok("4 Ctrl+N → laptop-act H new", acts().at(-1) === "H new", acts().join(" | "));
  await sleep(1500);
  const nd = path.join(T, "proj"); fs.mkdirSync(nd);
  await key(`/new ${nd}`, 200); await key("\r", 1500);
  ok("4 /new DIR → agent.startRemote: remote.sh start omni-xyz in DIR on the machine", await waitFor(() => read("starts.log").split("ARGS ").some((b) => /^start omni-[a-z]{3}\n/.test(b) && b.includes(`HYPRPI_START_CWD=${nd}`)), 4000), read("starts.log"));
  // 5 a project row
  const nAct = acts().length; at = scr.find("@linkproj"); await click({ x: at.x + 2, y: at.y }, true, 1200);
  const bo = await daemon("board.open", { room: "H" }).catch((e) => ({ err: e.message }));
  ok("5 Ctrl+click on @linkproj → board.open there + laptop-act H panel board", acts().slice(nAct).includes("H panel board") && !!bo.project, acts().join(" | ") + JSON.stringify(bo));
  // 6 ⏎ on the closed agent (^O shows closed ones)
  if (!scr.find("oldie")) await key("\x0f", 500);
  at = scr.find("oldie");
  if (at) { await click({ x: at.x + 1, y: at.y }, false); await key("\r", 1500); }
  ok("6 ⏎ on closed oldie → agent.resume: remote.sh start oldie on its own session", await waitFor(() => (read("starts.log").split("ARGS ").find((b) => b.startsWith("start oldie\n")) || "").includes(`HYPRPI_START_SESSION=${sess}`), 4000), (at ? "" : "oldie not shown\n" + scr.dump()) + read("starts.log"));
  // 7 the link drops: the panel reconnects and sees what happens there
  const n0 = killRemoteSide();
  ok("7 the link comes back by itself", await waitFor(() => read("remote.pids").split("\n").filter(Boolean).length > n0 && linkStatus().then((s) => s?.up), 10000), read("link.log").slice(-300));
  await sleep(2500); await hello("h-omni-gamma", process.pid, 73);
  ok("7 … and the panel lists a new agent there", await waitFor(() => scr.find("omni-gamma"), 8000), scr.dump().slice(0, 900));
  // 8 a long outage: the ssh hangs 20 s
  fs.writeFileSync(HOLD, ""); killRemoteSide();
  await sleep(5000);
  ok("8 while the link is down the footer says so", /link to H down/.test(footer()), footer());
  await sleep(15500); fs.rmSync(HOLD);
  ok("8 the link is back", await waitFor(() => linkStatus().then((s) => s?.up), 10000), read("link.log").slice(-300));
  await sleep(4000);
  const st = await linkStatus();
  ok("8 … the panel holds ONE connection through it (the half-open one was closed)", st?.panels === 1, JSON.stringify(st));
  ok("8 … and is online again", await waitFor(() => !/down|offline/.test(footer()), 5000), footer());
  at = scr.find("omni-gamma"); if (at) await click({ x: at.x + 1, y: at.y }, true, 1200);
  ok("8 … and works (Ctrl+click → focus)", acts().at(-1) === "H focus omni-gamma", acts().join(" | "));
} finally {
  if (panel) { try { panel.stdin.write("\x11"); } catch { /* gone */ } await sleep(500); try { panel.kill(); } catch { /* gone */ } }
  try { fs.rmSync(HOLD, { force: true }); } catch { /* none */ }
  // the link this test started (its socket's owner, by its runtime dir)
  try { spawnSync("sh", ["-c", `for p in $(ls /proc | grep -E '^[0-9]+$'); do tr '\\0' ' ' < /proc/$p/cmdline 2>/dev/null | grep -q "omnistation/rlink.mjs H" && tr '\\0' '\\n' < /proc/$p/environ 2>/dev/null | grep -qx "XDG_RUNTIME_DIR=${RUN}" && kill $p; done`]); } catch { /* none */ }
  for (const p of read("remote.pids").split("\n").filter(Boolean)) { try { process.kill(Number(p), "SIGKILL"); } catch { /* gone */ } }
  for (const c of conns) { try { c.close(); } catch { /* gone */ } }
  for (const k of kids) { try { k.kill("SIGKILL"); } catch { /* gone */ } }
  d.kill(); await sleep(400);
  if (fails && process.env.KEEP) console.log("kept " + T); else fs.rmSync(T, { recursive: true, force: true });
}
console.log(fails ? `link-agents: ${fails} FAILED` : "link-agents: all pass"); process.exit(fails ? 1 : 0);
